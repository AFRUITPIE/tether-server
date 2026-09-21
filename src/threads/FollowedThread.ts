import { getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import { watch, type FSWatcher } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { EffortLevel, Item, PermissionMode, ThreadInfo, Turn } from '../protocol/index.ts';
import { EffortLevel as EffortLevelSchema, PermissionMode as PermissionModeSchema } from '../protocol/common.ts';
import type { NotificationBody, NotificationName } from '../protocol/notifications.ts';
import { Itemizer, type Emission } from './itemizer.ts';
import type { Subscriber } from './LiveThread.ts';

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
  private seq = 0;
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

  constructor(id: string, cwd: string) {
    this.id = id;
    this.cwd = cwd;
  }

  /** Reads what is already on disk without emitting: the snapshot `thread/read` hands back. */
  async start(): Promise<void> {
    const msgs = await getSessionMessages(this.id, { dir: this.cwd, includeSystemMessages: true });
    for (const m of msgs) this.itemizer.ingest(m as never);
    this.ingested = msgs.length;
    this.path = await transcriptPath(this.id);
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
      const msgs = await getSessionMessages(this.id, {
        dir: this.cwd,
        offset: this.ingested,
        includeSystemMessages: true,
      });
      if (msgs.length) {
        this.ingested += msgs.length;
        for (const m of msgs) this.emitAll(this.itemizer.ingest(m as never));
        if (await this.updateSettings()) this.emit('thread/updated', { thread: this.threadInfo() });
      }
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
    for (const bytes of [256 * 1024, 4 * 1024 * 1024]) {
      const tail = await readTail(this.path, bytes);
      this.settings = settingsFrom(tail.lines);
      this.settingsOffset = tail.end;
      if (this.settings.model && this.settings.permissionMode) break; // widen once if all tool output
    }
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
      const oldest = this.buffer[0]?.seq ?? this.seq + 1;
      gap = afterSeq + 1 < oldest && afterSeq < this.seq;
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
async function transcriptPath(threadId: string): Promise<string | undefined> {
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

type SessionSettings = { model?: string; effort?: EffortLevel; permissionMode?: PermissionMode };

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
    if (!line) continue;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.isSidechain) continue; // a subagent's turn, not the session's
    if (!out.model && o.type === 'assistant' && typeof o.message?.model === 'string') {
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
