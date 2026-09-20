import { getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import { watch, type FSWatcher } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Item, ThreadInfo, Turn } from '../protocol/index.ts';
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
 * A session this daemon does not own, followed by watching its transcript on disk.
 *
 * Claude Code writes every session to a JSONL file whether or not it was started here, so a
 * session running in another client — the desktop app, a terminal — can be read as it happens.
 * Only read: nothing here writes to the file or to the session, and the thread stays `notLoaded`
 * because the daemon genuinely has not loaded it.
 *
 * The file is appended to, so the follower keeps a count of the messages it has ingested and asks
 * only for the ones past it. Re-reading the whole file on every append is not an option: a long
 * session's transcript reaches tens of megabytes.
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
  private pending?: ReturnType<typeof setTimeout>;
  private reading = false;
  private again = false;

  constructor(id: string, cwd: string) {
    this.id = id;
    this.cwd = cwd;
  }

  /** Reads what is already on disk. Emits nothing: this is the snapshot `thread/read` hands back. */
  async start(): Promise<void> {
    const msgs = await getSessionMessages(this.id, { dir: this.cwd, includeSystemMessages: true });
    for (const m of msgs) this.itemizer.ingest(m as never);
    this.ingested = msgs.length;
    await this.watchFile();
  }

  private async watchFile(): Promise<void> {
    const path = await transcriptPath(this.id);
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
    // `notLoaded` is the truth: another client owns this session, and this daemon is only reading
    // its transcript. Clients use it to tell following apart from running here.
    return { threadId: this.id, status: 'notLoaded', cwd: this.cwd, lastSeq: this.seq };
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
 * Where Claude Code keeps a session's transcript. The project folder is the working directory with
 * its separators flattened, but the exact rule is the CLI's, so the id is looked for across the
 * project folders rather than derived from the path.
 */
async function transcriptPath(threadId: string): Promise<string | undefined> {
  const root = join(homedir(), '.claude', 'projects');
  const file = `${threadId}.jsonl`;
  try {
    for (const dir of await readdir(root, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const candidate = join(root, dir.name, file);
      try {
        const entries = await readdir(join(root, dir.name));
        if (entries.includes(file)) return candidate;
      } catch {
        // Unreadable project folder; keep looking.
      }
    }
  } catch {
    // No projects folder at all.
  }
  return undefined;
}
