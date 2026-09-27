import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Params, ScheduledTask } from '../protocol/index.ts';
import { ErrorCodes, RpcError } from '../rpc/connection.ts';

/** What the scheduler needs from the thread manager: a way to start a thread with a prompt. */
export interface ThreadStarter {
  startScheduled(task: ScheduledTask): Promise<string>;
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
 * Scheduled tasks, kept in one JSON file in the daemon's home and run from a one-minute timer. A
 * run missed while the machine slept happens once when it wakes, not once per missed slot.
 */
export class Scheduler {
  private tasks: ScheduledTask[] = [];
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private starter: ThreadStarter,
    private path: string,
    private log: (m: string) => void = () => {},
    private now: () => Date = () => new Date(),
  ) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      if (Array.isArray(parsed?.tasks)) this.tasks = parsed.tasks;
    } catch {
      // No file yet, or unreadable: start empty.
    }
  }

  start() {
    this.timer = setInterval(() => void this.tick(), 60_000);
    this.timer.unref?.();
    void this.tick();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  list(): ScheduledTask[] {
    return this.tasks.map((t) => ({ ...t }));
  }

  save(p: Params<'schedule/save'>): ScheduledTask {
    const existing = p.id ? this.tasks.find((t) => t.id === p.id) : undefined;
    if (p.id && !existing) throw new RpcError(ErrorCodes.invalidParams, `no scheduled task ${p.id}`);
    const task: ScheduledTask = {
      ...(existing ?? {}),
      ...p,
      id: existing?.id ?? randomUUID(),
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

  /** Runs every task that's due. */
  async tick() {
    const now = this.now();
    for (const task of this.tasks) {
      if (task.nextRunAt !== undefined && task.nextRunAt <= now.getTime()) {
        await this.fire(task).catch(() => {});
      }
    }
  }

  private async fire(task: ScheduledTask): Promise<string> {
    const now = this.now();
    task.lastRunAt = now.getTime();
    const next = nextRun(task, now);
    if (next) task.nextRunAt = next.getTime();
    else delete task.nextRunAt;
    try {
      const threadId = await this.starter.startScheduled(task);
      task.lastThreadId = threadId;
      delete task.lastError;
      this.log(`scheduled task "${task.name}" started thread ${threadId}`);
      return threadId;
    } catch (e) {
      task.lastError = (e as Error).message;
      this.log(`scheduled task "${task.name}" failed: ${task.lastError}`);
      throw e;
    } finally {
      this.persist();
    }
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
