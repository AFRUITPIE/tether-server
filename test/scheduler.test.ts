import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ScheduledTask } from '../src/protocol/index.ts';
import { LiveThread } from '../src/threads/LiveThread.ts';
import { nextRun, Scheduler } from '../src/threads/Scheduler.ts';
import { ThreadManager } from '../src/threads/ThreadManager.ts';

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

describe('unattended runs', () => {
  const claude = { path: '/usr/bin/false', version: '0' } as any;
  const unattendedThread = (timeoutMs: number) => {
    const told: string[] = [];
    const t = new LiveThread({
      threadId: 'scheduled-1',
      cwd: '/tmp',
      claude,
      env: {},
      mode: 'new',
      unattended: { requestTimeoutMs: timeoutMs, onUnanswered: (m) => told.push(m) },
    });
    const ask = (toolName = 'Bash') =>
      (t as any).canUseTool(toolName, { command: 'ls' }, { toolUseID: 'tu1', signal: new AbortController().signal });
    return { t, told, ask };
  };
  const silentClient = { id: 'c', notify() {}, request: () => new Promise(() => {}), cancelRequest() {} };

  test('a permission nobody is there to give is denied after a while, ending the turn, and said why', async () => {
    const { t, told, ask } = unattendedThread(20);
    const answer = ask();
    expect(t.waitingUnattended).toBe(true);
    const r = await answer;
    expect(r).toMatchObject({ behavior: 'deny', interrupt: true });
    expect(r.message).toContain('scheduled run');
    expect(told).toEqual(['No one answered its request for permission to use Bash within 1 second, so it was denied.']);
    expect(t.hasPendingRequests).toBe(false);
  });

  test('someone looking at the request gets as long as they take', async () => {
    const { t, told, ask } = unattendedThread(15);
    t.subscribe(silentClient);
    let settled = false;
    const answer = ask().then((r: any) => ((settled = true), r));
    await Bun.sleep(60);
    expect(settled).toBe(false);
    expect(t.waitingUnattended).toBe(false);
    t.unsubscribe(silentClient);
    expect((await answer).behavior).toBe('deny');
    expect(told).toHaveLength(1);
  });

  test('waiting on nobody does not hold up an upgrade; waiting on a person does', () => {
    const mgr = new ThreadManager(claude);
    const { t, ask } = unattendedThread(60_000);
    mgr.threads.set(t.id, t);
    void ask();
    expect(t.status).toBe('requiresAction');
    expect(mgr.busy).toBe(false);
    t.subscribe(silentClient);
    expect(mgr.busy).toBe(true);
    t.unsubscribe(silentClient);

    const attended = new LiveThread({ threadId: 'mine', cwd: '/tmp', claude, env: {}, mode: 'new' });
    mgr.threads.set(attended.id, attended);
    void (attended as any).canUseTool('Bash', {}, { toolUseID: 'tu2', signal: new AbortController().signal });
    expect(mgr.busy).toBe(true);
    mgr.shutdown();
  });

  test('a draining daemon starts no more scheduled runs, and saves them', async () => {
    const now = { value: wed };
    const path = join(mkdtempSync(join(tmpdir(), 'tether-sched-')), 'schedules.json');
    const started: string[] = [];
    const mgr = new ThreadManager(claude);
    const s = new Scheduler({ startScheduled: async (t) => (started.push(t.name), 'thread-1') }, path, () => {}, () => now.value);
    mgr.scheduler = s;
    s.save({ name: 'Hourly', prompt: 'x', cwd: '/tmp', cadence: 'hourly', hour: 0, minute: 45, enabled: true });
    expect(mgr.requestShutdown()).toBe(true);
    now.value = new Date(2026, 8, 16, 10, 0);
    await s.tick();
    expect(started).toEqual([]);
    // Still due, for the next daemon.
    expect(JSON.parse(readFileSync(path, 'utf8')).tasks[0].nextRunAt).toBe(new Date(2026, 8, 16, 9, 45).getTime());
    mgr.shutdown();
  });

  test('a scheduled run takes the environment the last client asked for, and is unattended', async () => {
    const mgr = new ThreadManager(claude);
    const calls: { env: Record<string, string>; unattended: boolean }[] = [];
    const fake = { id: 'thread-9', send() {} };
    mgr.start = (async (_p: unknown, env: Record<string, string>, extra: any) => (calls.push({ env, unattended: !!extra?.unattended }), fake)) as any;
    const run = { id: 't', name: 'n', prompt: 'p', cwd: '/tmp', cadence: 'manual', hour: 0, minute: 0, enabled: true } as ScheduledTask;
    await mgr.startScheduled(run);
    mgr.noteClientEnv({ AWS_PROFILE: 'work' });
    await mgr.startScheduled(run);
    expect(calls).toEqual([
      { env: {}, unattended: true },
      { env: { AWS_PROFILE: 'work' }, unattended: true },
    ]);
    mgr.shutdown();
  });

  test('a client that sends no environment (the upgrade check) leaves the last one in place', async () => {
    const { PassThrough } = await import('node:stream');
    const { Connection } = await import('../src/rpc/connection.ts');
    const { ClientSession } = await import('../src/server/session.ts');
    const mgr = new ThreadManager(claude);
    const initialize = async (params: object) => {
      const toServer = new PassThrough();
      const toClient = new PassThrough();
      new ClientSession(new Connection(toServer, toClient, 'server'), mgr, 'daemon').start();
      const client = new Connection(toClient, toServer, 'client');
      client.start({ onRequest: async () => ({}), onNotification: () => {}, onClose: () => {} });
      await client.request('initialize', { clientInfo: { name: 'test', version: '0' }, ...params }, 'c1');
    };
    await initialize({ env: { AWS_PROFILE: 'work' } });
    await initialize({});
    expect((mgr as any).clientEnv).toEqual({ AWS_PROFILE: 'work' });
    mgr.shutdown();
  });

  test('an unanswered run is recorded on its task, unless a later run has been since', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'tether-sched-')), 'schedules.json');
    const hooks: ((threadId: string, message: string) => void)[] = [];
    let n = 0;
    const s = new Scheduler(
      { startScheduled: async (_t, onUnanswered) => (hooks.push(onUnanswered), `thread-${++n}`) },
      path,
      () => {},
      () => wed,
    );
    const t = s.save({ name: 'Audit', prompt: 'x', cwd: '/tmp', cadence: 'manual', hour: 0, minute: 0, enabled: true });
    await s.run(t.id);
    hooks[0]!('thread-1', 'No one answered.');
    expect(s.list()[0]!.lastError).toBe('No one answered.');
    expect(JSON.parse(readFileSync(path, 'utf8')).tasks[0].lastError).toBe('No one answered.');
    await s.run(t.id);
    expect(s.list()[0]!.lastError).toBeUndefined();
    hooks[0]!('thread-1', 'Late news about the first run.');
    expect(s.list()[0]!.lastError).toBeUndefined();
  });
});
