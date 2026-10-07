import { getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import { createReadStream, watch, type FSWatcher } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { EffortLevel, Item, PermissionMode, ThreadInfo, Turn } from '../protocol/index.ts';
import { EffortLevel as EffortLevelSchema, PermissionMode as PermissionModeSchema } from '../protocol/common.ts';
import type { NotificationBody, NotificationName } from '../protocol/notifications.ts';
import { isWakeup, Itemizer, type Emission } from './itemizer.ts';
import type { Subscriber } from './LiveThread.ts';
import { replayGap, seqOrigin } from './seq.ts';
import { sessionDirSync, workflowAgentLocator } from './workflows.ts';

const MAX_BUFFERED_EVENTS = 2000;
/** Appends arrive in bursts as a message is written; one read per burst is enough. */
const COALESCE_MS = 150;

/** What `ClientSession` needs of a thread to attach a client to it. `LiveThread` satisfies it too. */
export interface WatchableThread {
  readonly id: string;
  threadInfo(): ThreadInfo;
  subscribe(sub: Subscriber, afterSeq?: number): { replayed: number; gap: boolean };
  unsubscribe(sub: Subscriber): void;
  readonly subscriberCount: number;
}

/**
 * A session another client owns (the desktop app, a terminal), followed by watching its
 * transcript on disk. Read-only, so it stays `notLoaded`. Appends are read from the last ingested
 * message on, since a long session's transcript reaches tens of megabytes.
 */
export class FollowedThread implements WatchableThread {
  readonly id: string;
  private readonly cwd: string;
  private readonly itemizer = new Itemizer(Date.now, true);
  private readonly subscribers = new Set<Subscriber>();
  private readonly buffer: { seq: number; method: string; params: unknown }[] = [];
  private seq: number;
  private ingested = 0;
  private watcher?: FSWatcher;
  private path?: string;
  /** The owning client's model, effort and permission mode, for the attached client's controls. */
  private settings: SessionSettings = {};
  /** How far into the file `settings` has been read. */
  private settingsOffset = 0;
  private pending?: ReturnType<typeof setTimeout>;
  private reading = false;
  private again = false;
  private readonly queued = new TranscriptExtras();

  constructor(id: string, cwd: string, seqAfter?: number) {
    this.id = id;
    this.cwd = cwd;
    this.seq = seqOrigin(seqAfter);
    this.itemizer.locateWorkflowAgent = workflowAgentLocator(() => sessionDirSync(id));
  }

  /** Reads what is already on disk without emitting: the snapshot `thread/read` hands back. */
  async start(): Promise<void> {
    this.path = await transcriptPath(this.id);
    // The file first: a notification it holds is read with the message it follows.
    if (this.path) await this.queued.readFile(this.path);
    const msgs = await getSessionMessages(this.id, { dir: this.cwd, includeSystemMessages: true });
    ingestHistory(this.itemizer, msgs, this.queued);
    this.ingested = msgs.length;
    await this.readSettings();
    await this.watchFile();
  }

  private async watchFile(): Promise<void> {
    const path = this.path;
    if (!path) return; // Nothing to watch; the snapshot still stands.
    try {
      this.watcher = watch(path, () => this.schedule());
    } catch {
      // A transcript that cannot be watched is not fatal — the client keeps the snapshot.
    }
  }

  private schedule(): void {
    if (this.pending) return;
    this.pending = setTimeout(() => {
      this.pending = undefined;
      void this.refresh();
    }, COALESCE_MS);
  }

  /** Ingests whatever has been appended since the last read and emits it to subscribers. */
  private async refresh(): Promise<void> {
    if (this.reading) {
      this.again = true;
      return;
    }
    this.reading = true;
    try {
      if (this.path) await this.queued.readFile(this.path);
      const msgs = await getSessionMessages(this.id, {
        dir: this.cwd,
        offset: this.ingested,
        includeSystemMessages: true,
      });
      this.ingested += msgs.length;
      this.emitAll(ingestHistory(this.itemizer, msgs, this.queued));
      if (msgs.length && (await this.updateSettings())) this.emit('thread/updated', { thread: this.threadInfo() });
    } catch {
      // The file may be mid-write or gone; the next change re-reads from the same offset.
    } finally {
      this.reading = false;
      if (this.again) {
        this.again = false;
        this.schedule();
      }
    }
  }

  private emitAll(out: Emission[]): void {
    for (const e of out) this.emit(e.method, e.body as never);
  }

  private emit<N extends NotificationName>(method: N, body: NotificationBody<N>): void {
    const params = { threadId: this.id, seq: ++this.seq, ...body } as Record<string, unknown>;
    this.buffer.push({ seq: this.seq, method, params });
    if (this.buffer.length > MAX_BUFFERED_EVENTS) this.buffer.splice(0, this.buffer.length - MAX_BUFFERED_EVENTS);
    for (const s of this.subscribers) s.notify(method, params);
  }

  threadInfo(): ThreadInfo {
    return { threadId: this.id, status: 'notLoaded', cwd: this.cwd, lastSeq: this.seq, ...this.settings };
  }

  /**
   * Settings from the raw file's tail: getSessionMessages keeps each message's model but drops
   * the `effort` beside it and the `permissionMode` on user turns.
   */
  private async readSettings(): Promise<void> {
    if (!this.path) return;
    const read = await recordedSettings(this.path);
    this.settings = read.settings;
    this.settingsOffset = read.end;
  }

  /** Folds in lines appended since the last read. Returns whether the settings changed. */
  private async updateSettings(): Promise<boolean> {
    if (!this.path) return false;
    const before = JSON.stringify(this.settings);
    const { size } = await stat(this.path);
    if (size < this.settingsOffset) {
      await this.readSettings(); // rewritten, not appended
    } else {
      const added = await readFrom(this.path, this.settingsOffset);
      this.settingsOffset = added.end;
      const newer = settingsFrom(added.lines);
      const next = { ...this.settings };
      if (newer.model) {
        next.model = newer.model;
        if (newer.effort) next.effort = newer.effort;
        else delete next.effort;
      }
      if (newer.permissionMode) next.permissionMode = newer.permissionMode;
      this.settings = next;
    }
    return JSON.stringify(this.settings) !== before;
  }

  history(): { items: Item[]; turns: Turn[]; seq: number } {
    return { ...this.itemizer.snapshot(), seq: this.seq };
  }

  subscribe(sub: Subscriber, afterSeq?: number): { replayed: number; gap: boolean } {
    let replayed = 0;
    let gap = false;
    if (afterSeq !== undefined) {
      gap = replayGap(afterSeq, this.buffer[0]?.seq, this.seq);
      for (const e of this.buffer) {
        if (e.seq > afterSeq) {
          sub.notify(e.method, e.params);
          replayed++;
        }
      }
    }
    this.subscribers.add(sub);
    return { replayed, gap };
  }

  unsubscribe(sub: Subscriber): void {
    this.subscribers.delete(sub);
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }

  close(): void {
    if (this.pending) clearTimeout(this.pending);
    this.pending = undefined;
    this.watcher?.close();
    this.watcher = undefined;
    this.subscribers.clear();
  }
}

/**
 * Where Claude Code keeps a session's transcript. The project folder name is the CLI's own
 * flattening of the cwd, so the id is looked for rather than the path derived.
 */
export async function transcriptPath(threadId: string): Promise<string | undefined> {
  const root = join(homedir(), '.claude', 'projects');
  let dirs;
  try {
    dirs = await readdir(root, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const candidate = join(root, dir.name, `${threadId}.jsonl`);
    if (await stat(candidate).then(() => true, () => false)) return candidate;
  }
  return undefined;
}

/**
 * The cwd a transcript records. The SDK looks for it only near the top of the file, which a first
 * message carrying images can push past, leaving the session without one.
 */
export async function transcriptCwd(threadId: string): Promise<string | undefined> {
  const path = await transcriptPath(threadId);
  return path ? recordedCwd(path) : undefined;
}

/** The first `cwd` a transcript's lines carry, read a line at a time until it turns up. */
export async function recordedCwd(path: string): Promise<string | undefined> {
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.includes('"cwd"')) continue;
      try {
        const cwd = JSON.parse(line).cwd;
        if (typeof cwd === 'string' && cwd) return cwd;
      } catch {
        // a line still being written
      }
    }
  } catch {
    // unreadable: no cwd
  } finally {
    lines.close();
  }
  return undefined;
}

/** The settings a session last ran with, as its transcript records them. */
export async function transcriptSettings(threadId: string): Promise<SessionSettings> {
  const path = await transcriptPath(threadId);
  return path ? (await recordedSettings(path)).settings : {};
}

/**
 * Settings from the file's tail, widened while they aren't all found: a long turn of tool output
 * (screenshots especially) can put the last prompt, and so the permission mode, megabytes back.
 */
export async function recordedSettings(path: string): Promise<{ settings: SessionSettings; end: number }> {
  let read = { settings: {} as SessionSettings, end: 0 };
  try {
    for (const bytes of [256 * 1024, 4 * 1024 * 1024, Infinity]) {
      const tail = await readTail(path, bytes);
      read = { settings: settingsFrom(tail.lines), end: tail.end };
      if (read.settings.model && read.settings.permissionMode) break;
    }
  } catch {
    // unreadable: nothing recorded
  }
  return read;
}

export type SessionSettings = { model?: string; effort?: EffortLevel; permissionMode?: PermissionMode };

const EFFORT: readonly string[] = EffortLevelSchema.options;
const PERMISSION: readonly string[] = PermissionModeSchema.options;

type Lines = { lines: string[]; end: number };

/** The last `bytes` of a file as whole lines; the first, likely cut mid-line, is dropped. */
async function readTail(path: string, bytes: number): Promise<Lines> {
  const { size } = await stat(path);
  const start = Math.max(0, size - bytes);
  const read = await readFrom(path, start);
  if (start > 0) read.lines.shift();
  return read;
}

/** Complete lines from `start` on. `end` stops before a line still being written. */
async function readFrom(path: string, start: number): Promise<Lines> {
  const fh = await open(path, 'r');
  try {
    const { size } = await fh.stat();
    const buf = Buffer.alloc(Math.max(0, size - start));
    await fh.read(buf, 0, buf.length, start);
    const lastNewline = buf.lastIndexOf(0x0a);
    if (lastNewline < 0) return { lines: [], end: start };
    return { lines: buf.subarray(0, lastNewline).toString('utf8').split('\n'), end: start + lastNewline + 1 };
  } finally {
    await fh.close();
  }
}

/**
 * The latest model and effort (on assistant lines) and permission mode (on user lines). Values
 * the protocol has no case for are left out.
 */
function settingsFrom(lines: string[]): SessionSettings {
  const out: SessionSettings = {};
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    // Most lines are tool output; only these two kinds can carry a setting.
    if (!line || !(line.includes('"assistant"') || line.includes('"permissionMode"'))) continue;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.isSidechain) continue; // a subagent's turn, not the session's
    // An error the CLI wrote itself carries the model `<synthetic>`, not the one in use.
    if (!out.model && o.type === 'assistant' && typeof o.message?.model === 'string' && o.message.model !== '<synthetic>') {
      out.model = o.message.model;
      if (typeof o.effort === 'string' && EFFORT.includes(o.effort)) out.effort = o.effort as EffortLevel;
    }
    if (!out.permissionMode && o.type === 'user' && PERMISSION.includes(o.permissionMode)) {
      out.permissionMode = o.permissionMode as PermissionMode;
    }
    if (out.model && out.permissionMode) break;
  }
  return out;
}

/**
 * What only the raw transcript holds, read from the file: getSessionMessages drops attachments and
 * meta prompts, and keeps a system record without its content.
 *
 * - The `<task-notification>`s the CLI queued mid-turn: it writes each as an `attachment`
 *   (`queued_command`) after the message it followed (a tool result, or another attachment after
 *   one), so a workflow's finish lands in history where it did live.
 * - A scheduled job's prompt (a /loop, CronCreate or ScheduleWakeup firing): a meta `user` record
 *   with `turnOrigin: scheduled`, whose uuid is the CLI's command uuid.
 * - A /goal's checks (`goal_status` attachments, after the reply each judged) and its set (the
 *   `local_command` record, after the prompt).
 *
 * Each is held under the message it follows (the nearest record getSessionMessages keeps, through
 * dropped attachments and meta prompts), to be read right after that message (`ingestHistory`).
 * Live, `take()` hands over what was written since the last read, in file order.
 */
export class TranscriptExtras {
  /** A dropped record's parent, to find the message a run of them follows. */
  private parentOf = new Map<string, string>();
  private waiting = new Map<string, Record<string, any>[]>();
  /** What was found and not yet taken, in file order, for a live reader. */
  private found: Record<string, any>[] = [];
  /** Messages already read, for a record written after its message was. */
  private read = new Set<string>();
  /** How far into the file has been read. */
  offset = 0;

  /** Reads what the file holds from `offset` on. */
  async readFile(path: string): Promise<void> {
    try {
      const { size } = await stat(path);
      if (size < this.offset) this.offset = 0; // rewritten, not appended
      const added = await readFrom(path, this.offset);
      this.offset = added.end;
      this.add(added.lines);
    } catch {
      // unreadable: nothing more
    }
  }

  /** Skips what the file holds now: a live reader wants only what is written from here on. */
  async skipTo(path: string): Promise<void> {
    try {
      this.offset = (await stat(path)).size;
    } catch {
      this.offset = 0;
    }
  }

  add(lines: string[]): void {
    for (const line of lines) {
      if (!line.includes('"attachment"') && !line.includes('"isMeta":true') && !line.includes('"local_command"')) continue;
      let o: any;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if (!o || o.isSidechain || typeof o.uuid !== 'string') continue;
      const dropped = o.type === 'attachment' || (o.type === 'user' && o.isMeta === true);
      if (dropped && typeof o.parentUuid === 'string') this.parentOf.set(o.uuid, o.parentUuid);
      if (!isExtra(o)) continue;
      delete o.rendered;
      this.found.push(o);
      if (typeof o.parentUuid !== 'string') continue;
      const anchor = this.anchor(o.parentUuid);
      this.waiting.set(anchor, [...(this.waiting.get(anchor) ?? []), o]);
    }
  }

  /** The message a run of dropped records follows. */
  private anchor(uuid: string): string {
    let at = uuid;
    for (let i = 0; i < 1000 && this.parentOf.has(at); i++) at = this.parentOf.get(at)!;
    return at;
  }

  /** The records that follow a message, once, as it is read. */
  after(uuid: unknown): Record<string, any>[] {
    if (typeof uuid !== 'string') return [];
    this.read.add(uuid);
    const found = this.waiting.get(uuid) ?? [];
    this.waiting.delete(uuid);
    return found;
  }

  /** Records written after the message they follow had already been read. */
  late(): Record<string, any>[] {
    const out: Record<string, any>[] = [];
    for (const [uuid, found] of this.waiting) {
      if (!this.read.has(uuid)) continue;
      out.push(...found);
      this.waiting.delete(uuid);
    }
    return out;
  }

  /** Live: every record found since the last take, in the order written. */
  take(): Record<string, any>[] {
    const out = this.found;
    this.found = [];
    this.waiting.clear();
    return out;
  }
}

/** A raw record the itemizer reads that getSessionMessages leaves out (see `TranscriptExtras`). */
function isExtra(o: any): boolean {
  if (o.type === 'attachment') {
    const a = o.attachment;
    if (a?.type === 'queued_command') return typeof a.prompt === 'string' && /^\s*<task-notification>/.test(a.prompt);
    return a?.type === 'goal_status' && a.sentinel !== true;
  }
  if (o.type === 'user') return o.isMeta === true && isWakeup(o);
  return o.type === 'system' && o.subtype === 'local_command' && o.commandRun?.command === 'goal';
}

/** History's messages into an itemizer, each followed by what the raw transcript wrote after it. */
export function ingestHistory(iz: Itemizer, msgs: readonly unknown[], extras?: TranscriptExtras): Emission[] {
  const out: Emission[] = [];
  if (extras) for (const r of extras.late()) out.push(...iz.ingestExtra(r));
  for (const m of msgs as Record<string, any>[]) {
    out.push(...iz.ingest(m));
    if (extras) for (const r of extras.after(m.uuid)) out.push(...iz.ingestExtra(r));
  }
  return out;
}
