import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TaskState } from '../protocol/index.ts';
import { isSafeId } from './workflows.ts';

/** How many chats' tasks are held in memory, beyond those not yet written; the rest are read again when asked for. */
const HELD = 32;

/**
 * Each chat's tasks as this daemon last saw them, kept in its home (`<TETHER_HOME>/tasks/<thread
 * id>.json`, beside `schedules.json`): the CLI's task events and a workflow's progress reach only
 * the live stream, never the transcript, so without this a reload, a restart or a later resume
 * would know no more of a task than its call. A thread's states are merged by id as they change and
 * written a second after the last change (and at once on `flush`); a file is checked entry by entry
 * when read, so a bad entry is skipped rather than losing the rest. Deleted with its chat.
 */
export class TaskStore {
  /** The chats read or kept lately, least recently used first: at most `HELD` not waiting to be written. */
  private cache = new Map<string, Map<string, TaskState>>();
  private dirty = new Set<string>();
  private timer?: ReturnType<typeof setTimeout>;

  constructor(
    readonly dir: string,
    private delayMs = 1000,
  ) {}

  /** The chat's tasks as kept, in the order each was first kept. */
  get(threadId: string): TaskState[] {
    return [...this.load(threadId).values()];
  }

  /** Keeps these states of the chat's tasks, replacing those of the same ids. */
  put(threadId: string, tasks: TaskState[]) {
    if (!tasks.length || !isSafeId(threadId)) return;
    const kept = this.load(threadId);
    for (const t of tasks) kept.set(t.id, t);
    this.dirty.add(threadId);
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.flush();
      }, this.delayMs);
      this.timer.unref?.();
    }
  }

  delete(threadId: string) {
    this.cache.delete(threadId);
    this.dirty.delete(threadId);
    if (isSafeId(threadId)) rmSync(this.file(threadId), { force: true });
  }

  /** Writes what changed since the last write. */
  flush() {
    clearTimeout(this.timer);
    this.timer = undefined;
    for (const threadId of this.dirty) {
      const kept = this.cache.get(threadId);
      if (!kept) continue;
      try {
        mkdirSync(this.dir, { recursive: true, mode: 0o700 });
        const tmp = `${this.file(threadId)}.tmp`;
        writeFileSync(tmp, JSON.stringify({ tasks: [...kept.values()] }), { mode: 0o600 });
        renameSync(tmp, this.file(threadId));
      } catch {
        // A full or read-only disk: the next change tries again.
        continue;
      }
      this.dirty.delete(threadId);
    }
  }

  private file(threadId: string) {
    return join(this.dir, `${threadId}.json`);
  }

  private load(threadId: string): Map<string, TaskState> {
    let kept = this.cache.get(threadId);
    if (kept) {
      this.cache.delete(threadId);
      this.cache.set(threadId, kept);
      return kept;
    }
    // Every chat opened would otherwise stay in memory for the daemon's life.
    for (const id of this.cache.keys()) {
      if (this.cache.size < HELD) break;
      if (!this.dirty.has(id)) this.cache.delete(id);
    }
    kept = new Map();
    if (isSafeId(threadId)) {
      try {
        const raw = JSON.parse(readFileSync(this.file(threadId), 'utf8'));
        for (const entry of Array.isArray(raw?.tasks) ? raw.tasks : []) {
          const t = TaskState.safeParse(entry);
          if (t.success) kept.set(t.data.id, t.data);
        }
      } catch {
        // none kept yet, or unreadable: nothing
      }
      this.cache.set(threadId, kept);
    }
    return kept;
  }
}
