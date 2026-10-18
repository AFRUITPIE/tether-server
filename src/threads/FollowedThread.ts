import { watch, type FSWatcher } from 'node:fs';
import type { Item, TaskState, ThreadInfo, Turn } from '../protocol/index.ts';
import type { NotificationBody, NotificationName } from '../protocol/notifications.ts';
import type { Emission, Itemizer } from './itemizer.ts';
import { EventStream, type Subscriber, type WatchableThread } from './events.ts';
import { ingestHistory, loadWorkflows, newerSettings, readTranscript, sessionDir, settingsOf, TranscriptTail, type SessionSettings, type TranscriptExtras } from './transcript.ts';

const MAX_BUFFERED_EVENTS = 2000;
/** Appends arrive in bursts as a message is written; one read per burst is enough. */
const COALESCE_MS = 150;
/** How often a running workflow's files are read again while someone watches. */
const WORKFLOW_POLL_MS = 5000;

/**
 * A session another client owns (the desktop app, a terminal), followed by watching its
 * transcript on disk. Read-only, so it stays `notLoaded`. The file is read whole once, then only
 * what is appended (`TranscriptTail`), since a long session's transcript reaches hundreds of
 * megabytes and is appended to many times a second while its owner streams.
 */
export class FollowedThread implements WatchableThread {
  readonly id: string;
  private readonly cwd: string;
  private itemizer!: Itemizer;
  private extras!: TranscriptExtras;
  private readonly tail: TranscriptTail;
  private readonly events: EventStream;
  private watcher?: FSWatcher;
  private path?: string;
  /** The owning client's model, effort and permission mode, for the attached client's controls. */
  private settings: SessionSettings = {};
  private pending?: ReturnType<typeof setTimeout>;
  private reading = false;
  private again = false;
  private workflowPoll?: ReturnType<typeof setInterval>;

  constructor(id: string, cwd: string, seqAfter?: number) {
    this.id = id;
    this.cwd = cwd;
    this.events = new EventStream(id, MAX_BUFFERED_EVENTS, seqAfter);
    this.tail = new TranscriptTail(id, cwd);
  }

  /** Reads what is already on disk without emitting: the snapshot `thread/read` hands back. */
  async start(): Promise<void> {
    const { itemizer, extras, history, path } = await readTranscript(this.id, this.cwd);
    this.itemizer = itemizer;
    this.extras = extras;
    this.path = path;
    // What `thread/read` hands back holds the tasks as they stand; what follows is what changes.
    itemizer.quiet = false;
    itemizer.markTasksSent();
    this.tail.begin(history);
    this.settings = settingsOf(history.records);
    this.watchFile();
  }

  /** The chat's tasks as its transcript and the session's workflow files say. */
  tasks(): TaskState[] {
    return this.itemizer.tasks();
  }

  /**
   * A workflow the session runs says how it's going only in its files (no task events reach a
   * transcript): read again every few seconds while someone watches and one hasn't settled.
   */
  private pollWorkflows() {
    if (this.workflowPoll) return;
    this.workflowPoll = setInterval(async () => {
      if (this.events.subscribers.size === 0 || this.itemizer.unsettledWorkflowRuns().length === 0) {
        clearInterval(this.workflowPoll);
        this.workflowPoll = undefined;
        return;
      }
      this.emitAll(await loadWorkflows(this.itemizer, sessionDir(this.id)));
    }, WORKFLOW_POLL_MS);
    this.workflowPoll.unref?.();
  }

  private watchFile() {
    if (!this.path) return; // Nothing to watch; the snapshot still stands.
    try {
      this.watcher = watch(this.path, () => this.schedule());
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
    if (!this.path) return;
    if (this.reading) {
      this.again = true;
      return;
    }
    this.reading = true;
    try {
      const { records, messages } = await this.tail.read(this.path);
      // The records first: a notification among them is read with the message it follows.
      this.extras.addRecords(records);
      this.emitAll(ingestHistory(this.itemizer, messages, this.extras));
      if (this.events.subscribers.size && this.itemizer.unsettledWorkflowRuns().length) this.pollWorkflows();
      const settings = newerSettings(this.settings, records);
      if (JSON.stringify(settings) !== JSON.stringify(this.settings)) {
        this.settings = settings;
        this.emit('thread/updated', { thread: this.threadInfo() });
      }
    } catch {
      // The file may be mid-write or gone; the next change reads on from the same place.
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
    this.events.emit(method, body);
  }

  threadInfo(): ThreadInfo {
    return { threadId: this.id, status: 'notLoaded', cwd: this.cwd, lastSeq: this.events.lastSeq, ...this.settings };
  }

  history(): { items: Item[]; turns: Turn[]; seq: number } {
    return { ...this.itemizer.snapshot(), seq: this.events.lastSeq };
  }

  subscribe(sub: Subscriber, afterSeq?: number): { replayed: number; gap: boolean } {
    const r = this.events.subscribe(sub, afterSeq);
    if (this.itemizer.unsettledWorkflowRuns().length) this.pollWorkflows();
    return r;
  }

  unsubscribe(sub: Subscriber): void {
    this.events.subscribers.delete(sub);
  }

  get subscriberCount(): number {
    return this.events.subscribers.size;
  }

  close(): void {
    clearInterval(this.workflowPoll);
    this.workflowPoll = undefined;
    if (this.pending) clearTimeout(this.pending);
    this.pending = undefined;
    this.watcher?.close();
    this.watcher = undefined;
    this.events.subscribers.clear();
  }
}
