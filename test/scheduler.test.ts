import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ScheduledTask } from '../src/protocol/index.ts';
import { nextRun, Scheduler } from '../src/threads/Scheduler.ts';

// Local time, as schedules are: Wednesday 16 September 2026, 09:30.
const wed = new Date(2026, 8, 16, 9, 30);
const task = (over: Partial<ScheduledTask>) =>
  ({ cadence: 'daily', hour: 10, minute: 0, enabled: true, ...over }) as ScheduledTask;

describe('next run', () => {
  test('daily: later today, or tomorrow once passed', () => {
    expect(nextRun(task({}), wed)).toEqual(new Date(2026, 8, 16, 10, 0));
    expect(nextRun(task({ hour: 9, minute: 0 }), wed)).toEqual(new Date(2026, 8, 17, 9, 0));
  });

  test('hourly: the next time the minute comes round', () => {
    expect(nextRun(task({ cadence: 'hourly', minute: 45 }), wed)).toEqual(new Date(2026, 8, 16, 9, 45));
    expect(nextRun(task({ cadence: 'hourly', minute: 15 }), wed)).toEqual(new Date(2026, 8, 16, 10, 15));
  });

  test('weekdays skip the weekend', () => {
    const friEvening = new Date(2026, 8, 18, 18, 0);
    expect(nextRun(task({ cadence: 'weekdays' }), friEvening)).toEqual(new Date(2026, 8, 21, 10, 0));
  });

  test('weekly: its day of the week', () => {
    // 1 is Sunday: the coming Sunday the 20th.
    expect(nextRun(task({ cadence: 'weekly', weekday: 1 }), wed)).toEqual(new Date(2026, 8, 20, 10, 0));
  });

  test('manual and disabled tasks never come due', () => {
    expect(nextRun(task({ cadence: 'manual' }), wed)).toBeUndefined();
    expect(nextRun(task({ enabled: false }), wed)).toBeUndefined();
  });
});

describe('scheduler', () => {
  const setup = (now: { value: Date }) => {
    const started: string[] = [];
    const path = join(mkdtempSync(join(tmpdir(), 'tether-sched-')), 'schedules.json');
    const starter = { startScheduled: async (t: ScheduledTask) => (started.push(t.name), `thread-${started.length}`) };
    return { started, path, make: () => new Scheduler(starter, path, () => {}, () => now.value) };
  };

  test('a due task runs once, even after missing several slots, and is kept on disk', async () => {
    const now = { value: wed };
    const { started, path, make } = setup(now);
    const s = make();
    const saved = s.save({ name: 'Standup notes', prompt: 'Summarize yesterday', cwd: '/tmp', cadence: 'hourly', hour: 0, minute: 45, enabled: true });
    expect(saved.nextRunAt).toBe(new Date(2026, 8, 16, 9, 45).getTime());

    now.value = new Date(2026, 8, 16, 13, 50); // slept through four runs
    await s.tick();
    await s.tick();
    expect(started).toEqual(['Standup notes']);

    const reloaded = make().list()[0]!;
    expect(reloaded.lastThreadId).toBe('thread-1');
    expect(reloaded.nextRunAt).toBe(new Date(2026, 8, 16, 14, 45).getTime());
    expect(path).toBeTruthy();
  });

  test('run starts a manual task now; delete forgets it', async () => {
    const now = { value: wed };
    const { started, make } = setup(now);
    const s = make();
    const t = s.save({ name: 'Audit', prompt: 'Check deps', cwd: '/tmp', cadence: 'manual', hour: 0, minute: 0, enabled: true });
    expect(t.nextRunAt).toBeUndefined();
    expect(await s.run(t.id)).toBe('thread-1');
    s.delete(t.id);
    expect(s.list()).toEqual([]);
    expect(started).toEqual(['Audit']);
  });

  test('a failed run records why', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'tether-sched-')), 'schedules.json');
    const s = new Scheduler({ startScheduled: async () => { throw new Error('no such folder'); } }, path, () => {}, () => wed);
    const t = s.save({ name: 'Broken', prompt: 'x', cwd: '/nope', cadence: 'manual', hour: 0, minute: 0, enabled: true });
    await expect(s.run(t.id)).rejects.toThrow('no such folder');
    expect(s.list()[0]!.lastError).toBe('no such folder');
  });
});
