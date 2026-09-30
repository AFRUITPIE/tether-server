import { getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import { createReadStream, watch, type FSWatcher } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import type { EffortLevel, Item, PermissionMode, ThreadInfo, Turn } from '../protocol/index.ts';
import { EffortLevel as EffortLevelSchema, PermissionMode as PermissionModeSchema } from '../protocol/common.ts';
import type { NotificationBody, NotificationName } from '../protocol/notifications.ts';
import { boundariesIn, ingestAll, markCompaction, sessionFile, storedHistory } from './history.ts';
import { Itemizer, type Emission, type Page } from './itemizer.ts';
import type { Subscriber } from './LiveThread.ts';
import { replayGap, seqOrigin } from './seq.ts';

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
 * transcript on disk. Read-only, so it stays `notLoaded`. Its whole history is read once; after
 * that only the SDK's current chain is, and what it holds that hasn't been seen yet is appended.
 */
export class FollowedThread implements WatchableThread {
  readonly id: string;
  private readonly cwd: string;
  private readonly itemizer = new Itemizer(Date.now, true);
  private readonly subscribers = new Set<Subscriber>();
  private readonly buffer: { seq: number; method: string; params: unknown }[] = [];
  private seq: number;
  /** The messages ingested, by uuid: a new compaction's chain repeats the ones it kept. */
  private readonly seen = new Set<string>();
  /** Compaction boundaries in the file, to mark the ones the SDK's chain brings. */
  private boundaries = new Map<string, Record<string, unknown>>();
  private started?: Promise<void>;
  private closed = false;
  private watcher?: FSWatcher;
  private path?: string;
  /** The owning client's model, effort and permission mode, for the attached client's controls. */
  private settings: SessionSettings = {};
  /** How far into the file has been read for `settings` and `boundaries`. */
  private settingsOffset = 0;
  private pending?: ReturnType<typeof setTimeout>;
  private reading = false;
  private again = false;

  constructor(id: string, cwd: string, seqAfter?: number) {
    this.id = id;
    this.cwd = cwd;
    this.seq = seqOrigin(seqAfter);
  }

  /** Reads what is already on disk without emitting: the snapshot `thread/read` hands back. Once. */
  start(): Promise<void> {
    return (this.started ??= this.load());
  }

  private async load(): Promise<void> {
    const history = await storedHistory(this.id, this.cwd);
    await ingestAll(history.messages, (m) => {
      this.seen.add(m.uuid);
      this.itemizer.ingest(m as never);
    });
    if (history.boundaries) this.boundaries = new Map(history.boundaries);
    this.path = history.path ?? (await sessionFile(this.id, this.cwd));
    await this.readSettings();
    // Lines written since the history's read are looked through again, for compactions (the
    // settings come out the same).
    if (history.end !== undefined) this.settingsOffset = Math.min(this.settingsOffset, history.end);
    await this.watchFile();
  }

  private async watchFile(): Promise<void> {
    const path = this.path;
    if (!path || this.closed) return; // Nothing to watch (or no one to tell); the snapshot still stands.
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
      const msgs = await getSessionMessages(this.id, { dir: this.cwd, includeSystemMessages: true });
      const fresh = msgs.filter((m) => !this.seen.has(m.uuid));
      // After the SDK's read, so every line it saw has been looked through.
      const changed = await this.readAppended();
      for (const m of fresh) {
        this.seen.add(m.uuid);
        this.emitAll(this.itemizer.ingest(markCompaction(m, this.boundaries) as never));
      }
      if (changed) this.emit('thread/updated', { thread: this.threadInfo() });
    } catch {
      // The file may be mid-write or gone; the next change reads it again.
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

  /**
   * Folds in lines appended since the last read: settings, and compactions for `markCompaction`.
   * Returns whether the settings changed.
   */
  private async readAppended(): Promise<boolean> {
    if (!this.path) return false;
    const before = JSON.stringify(this.settings);
    const { size } = await stat(this.path);
    if (size < this.settingsOffset) {
      await this.readSettings(); // rewritten, not appended
    } else {
      const added = await readFrom(this.path, this.settingsOffset);
      this.settingsOffset = added.end;
      boundariesIn(added.lines, this.boundaries);
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

  /** The snapshot `thread/read` hands back, a page of it when asked, and the seq it goes up to. */
  history(page?: Page): { items: Item[]; turns: Turn[]; hasMore: boolean; seq: number } {
    return { ...this.itemizer.snapshot(page), seq: this.seq };
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
    this.closed = true;
    if (this.pending) clearTimeout(this.pending);
    this.pending = undefined;
    this.watcher?.close();
    this.watcher = undefined;
    this.subscribers.clear();
  }
}

/**
 * The cwd a transcript records. The SDK looks for it only near the top of the file, which a first
 * message carrying images can push past, leaving the session without one.
 */
export async function transcriptCwd(threadId: string): Promise<string | undefined> {
  const path = await sessionFile(threadId);
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
  const path = await sessionFile(threadId);
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
