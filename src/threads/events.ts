import type { ThreadInfo } from '../protocol/index.ts';
import type { NotificationBody, NotificationName } from '../protocol/notifications.ts';

/** A connected client that has subscribed to a thread. */
export interface Subscriber {
  readonly id: string;
  notify(method: string, params: unknown): void;
  request(method: string, params: unknown, id: string): Promise<unknown>;
  cancelRequest(id: string): void;
}

/** What `ClientSession` needs of a thread to attach a client to it: a `LiveThread` or a `FollowedThread`. */
export interface WatchableThread {
  readonly id: string;
  threadInfo(): ThreadInfo;
  subscribe(sub: Subscriber, afterSeq?: number): { replayed: number; gap: boolean };
  unsubscribe(sub: Subscriber): void;
  readonly subscriberCount: number;
}

type BufferedEvent = { seq: number; method: string; params: Record<string, unknown> };

/**
 * One thread's event stream: its notifications numbered, sent to its subscribers, and the latest
 * `capacity` kept to replay to a client that comes back. Each stream starts numbering at
 * `seqOrigin`, above any earlier stream of the thread.
 */
export class EventStream {
  private seq: number;
  /** Oldest first; between `capacity` and a quarter more once full, trimmed a batch at a time. */
  private buffer: BufferedEvent[] = [];
  readonly subscribers = new Set<Subscriber>();

  constructor(
    readonly threadId: string,
    private readonly capacity: number,
    seqAfter?: number,
  ) {
    this.seq = seqOrigin(seqAfter);
  }

  get lastSeq(): number {
    return this.seq;
  }

  emit<N extends NotificationName>(method: N, body: NotificationBody<N>) {
    const params = { threadId: this.threadId, seq: ++this.seq, ...body } as Record<string, unknown>;
    this.buffer.push({ seq: this.seq, method, params });
    // Dropping the oldest event one at a time moved the whole buffer on every emit once full.
    if (this.buffer.length > this.capacity + (this.capacity >> 2)) this.buffer.splice(0, this.buffer.length - this.capacity);
    for (const s of this.subscribers) s.notify(method, params);
  }

  /** Attaches `sub`, first replaying what it missed after `afterSeq`; a gap if that can't be done. */
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
}

/**
 * Where a new event stream for a thread starts numbering. A thread gets a new stream whenever its
 * query restarts (process exit, resume, rewind, daemon restart) or it is followed from disk.
 * Starting each above any earlier stream's numbers means a client still holding an older seq sees
 * a gap and reloads, instead of discarding the new stream's events as ones it already applied.
 * Microseconds since the epoch stay well inside a double's exact integers.
 */
export function seqOrigin(after = 0): number {
  // `after` is the last seq an earlier stream of the same thread used, in case the clock stepped back.
  return Math.max(Date.now() * 1000, after + 1);
}

/**
 * Whether a client that has seen events up to `afterSeq` can be caught up from a buffer holding
 * `oldest`…`latest`. A seq older than the buffer, or newer than anything this stream emitted
 * (it came from another stream), cannot.
 */
export function replayGap(afterSeq: number, oldest: number | undefined, latest: number): boolean {
  if (afterSeq === latest) return false;
  if (afterSeq > latest) return true;
  return afterSeq + 1 < (oldest ?? latest + 1);
}
