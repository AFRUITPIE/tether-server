import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { z } from 'zod';
import { ScheduledTask, type Params } from '../protocol/index.ts';
import { ErrorCodes, RpcError } from '../rpc/connection.ts';

/**
 * What the scheduler needs from the thread manager: a way to start a thread with a prompt, which
 * says (through `onUnanswered`) when the run was denied something for want of a person to ask.
 */
export interface ThreadStarter {
  startScheduled(task: ScheduledTask, onUnanswered: (threadId: string, message: string) => void): Promise<string>;
}

/**
 * The next time `task` is due strictly after `after`, in the host's local time; undefined for a
 * manual or disabled task. Pure, for testing.
 */
export function nextRun(task: Pick<ScheduledTask, 'cadence' | 'hour' | 'minute' | 'weekday' | 'enabled'>, after: Date): Date | undefined {
  if (!task.enabled || task.cadence === 'manual') return undefined;
  const d = new Date(after.getTime());
  d.setSeconds(0, 0);
  if (task.cadence === 'hourly') {
    d.setMinutes(task.minute);
    if (d <= after) d.setHours(d.getHours() + 1);
    return d;
  }
  d.setHours(task.hour, task.minute, 0, 0);
  for (let i = 0; i < 8; i++) {
    const weekday = d.getDay() + 1; // 1 = Sunday
    const dayOK =
      task.cadence === 'daily' ||
      (task.cadence === 'weekdays' && weekday >= 2 && weekday <= 6) ||
      (task.cadence === 'weekly' && weekday === (task.weekday ?? 2));
    if (dayOK && d > after) return d;
    d.setDate(d.getDate() + 1);
    d.setHours(task.hour, task.minute, 0, 0);
  }
  return undefined;
}

/**
 * The tasks in `schedules.json`, each checked against the protocol's `ScheduledTask` so one bad
 * entry (a hand edit, an older build) can't break `schedule/list`. An optional field that's wrong is
 * dropped, and a task that can't say whether it's enabled is disabled; one still unreadable, or a
 * second with the same id, is skipped. A task that can't come due loses any `nextRunAt`, and one
 * that can but has none gets one.
 */
export function loadTasks(raw: unknown, now: Date, log: (m: string) => void = () => {}): ScheduledTask[] {
  const entries = (raw as { tasks?: unknown } | undefined)?.tasks;
  if (!Array.isArray(entries)) return [];
  const shape = ScheduledTask.shape as Record<string, z.ZodType>;
  const tasks: ScheduledTask[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      log('skipped a scheduled task that isn’t an object');
      continue;
    }
    const repaired: Record<string, unknown> = { ...entry };
    if (typeof repaired.enabled !== 'boolean') repaired.enabled = false;
    for (const [key, field] of Object.entries(shape)) {
      if (repaired[key] !== undefined && !field.safeParse(repaired[key]).success && field.safeParse(undefined).success) delete repaired[key];
    }
    const parsed = ScheduledTask.safeParse(repaired);
    if (!parsed.success) {
      log(`skipped a scheduled task that can’t be read: ${parsed.error.issues.map((i) => i.path.join('.') || i.message).join(', ')}`);
      continue;
    }
    const task = parsed.data;
    if (tasks.some((t) => t.id === task.id)) {
      log(`skipped a second scheduled task with the id ${task.id}`);
      continue;
    }
    const next = nextRun(task, now);
    if (!next) delete task.nextRunAt;
    else if (task.nextRunAt === undefined) task.nextRunAt = next.getTime();
    tasks.push(task);
  }
  return tasks;
}

/**
 * Scheduled tasks, kept in one JSON file in the daemon's home and run from a one-minute timer. A
 * run missed while the machine slept happens once when it wakes, not once per missed slot.
 */
export class Scheduler {
  private tasks: ScheduledTask[] = [];
  private timer?: ReturnType<typeof setInterval>;
  /** Once stopped (the daemon draining or exiting), no task comes due here again. */
  private stopped = false;

  constructor(
    private starter: ThreadStarter,
    private path: string,
    private log: (m: string) => void = () => {},
    private now: () => Date = () => new Date(),
  ) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      // No file yet, or unreadable: start empty.
    }
    this.tasks = loadTasks(raw, this.now(), (m) => this.log(`${path}: ${m}`));
  }

  start() {
    this.timer = setInterval(() => void this.tick(), 60_000);
    this.timer.unref?.();
    void this.tick();
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.persist();
  }

  list(): ScheduledTask[] {
    return this.tasks.map((t) => ({ ...t }));
  }

  /**
   * Creates a task, or replaces one: what the client sent is the whole task, so an optional field
   * it leaves out is cleared. Only what the server records about runs is kept.
   */
  save(p: Params<'schedule/save'>): ScheduledTask {
    const existing = p.id ? this.tasks.find((t) => t.id === p.id) : undefined;
    if (p.id && !existing) throw new RpcError(ErrorCodes.invalidParams, `no scheduled task ${p.id}`);
    if (p.enabled && !p.prompt.trim()) throw new RpcError(ErrorCodes.invalidParams, 'A scheduled task needs a prompt to run.');
    const { id: _id, ...fields } = p;
    const task: ScheduledTask = {
      ...fields,
      id: existing?.id ?? randomUUID(),
      ...(existing?.lastRunAt !== undefined ? { lastRunAt: existing.lastRunAt } : {}),
      ...(existing?.lastThreadId !== undefined ? { lastThreadId: existing.lastThreadId } : {}),
      ...(existing?.lastError !== undefined ? { lastError: existing.lastError } : {}),
    };
    const next = nextRun(task, this.now());
    if (next) task.nextRunAt = next.getTime();
    else delete task.nextRunAt;
    this.tasks = existing ? this.tasks.map((t) => (t.id === task.id ? task : t)) : [...this.tasks, task];
    this.persist();
    return { ...task };
  }

  delete(id: string) {
    this.tasks = this.tasks.filter((t) => t.id !== id);
    this.persist();
  }

  async run(id: string): Promise<string> {
    const task = this.tasks.find((t) => t.id === id);
    if (!task) throw new RpcError(ErrorCodes.invalidParams, `no scheduled task ${id}`);
    return this.fire(task);
  }

  private ticking = false;

  /**
   * Runs every task that's due. Tasks are looked up afresh after each run starts, since a save or
   * delete can land meanwhile; a tick still going when the next is due is left to finish.
   */
  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.now().getTime();
      for (const id of this.tasks.map((t) => t.id)) {
        if (this.stopped) return;
        const task = this.tasks.find((t) => t.id === id);
        if (task?.nextRunAt !== undefined && task.nextRunAt <= now) await this.fire(task).catch(() => {});
      }
    } finally {
      this.ticking = false;
    }
  }

  private async fire(task: ScheduledTask): Promise<string> {
    const now = this.now();
    task.lastRunAt = now.getTime();
    const next = nextRun(task, now);
    if (next) task.nextRunAt = next.getTime();
    else delete task.nextRunAt;
    // A save replaces the task while the run starts: what the run learns goes on the task as it is then.
    const current = () => this.tasks.find((t) => t.id === task.id);
    try {
      const threadId = await this.starter.startScheduled({ ...task }, (id, message) => this.noteUnanswered(task.id, id, message));
      const t = current();
      if (t) {
        t.lastThreadId = threadId;
        delete t.lastError;
      }
      this.log(`scheduled task "${task.name}" started thread ${threadId}`);
      return threadId;
    } catch (e) {
      const message = (e as Error).message;
      const t = current();
      if (t) t.lastError = message;
      this.log(`scheduled task "${task.name}" failed: ${message}`);
      throw e;
    } finally {
      this.persist();
    }
  }

  /** A run held up for want of a person to ask, unless a later run has been recorded since. */
  private noteUnanswered(taskId: string, threadId: string, message: string) {
    const task = this.tasks.find((t) => t.id === taskId);
    if (!task || (task.lastThreadId !== undefined && task.lastThreadId !== threadId)) return;
    task.lastError = message;
    this.log(`scheduled task "${task.name}": ${message}`);
    this.persist();
  }

  private persist() {
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify({ tasks: this.tasks }, null, 2), { mode: 0o600 });
      renameSync(tmp, this.path);
    } catch (e) {
      this.log(`couldn't save scheduled tasks: ${(e as Error).message}`);
    }
  }
}
