import { describe, expect, test } from 'bun:test';
import type { GoalEvent, Item, SessionCron, ToolStatus } from '../src/protocol/index.ts';
import { samePrompt, scheduledTasks, scheduledWork, type Liveness } from '../src/threads/scheduled.ts';

/**
 * Scheduled jobs and goals, worked out from the chat's items as the itemizer makes them for a /loop
 * and a /goal (the loop-goal capture, Claude Code 2.1.291), and from what the session's Stop hook
 * says will wake it.
 */
const PROMPT = 'reply with the current time in one short line';
const CONDITION = 'notes.md in this directory has no spelling mistakes';

const base = (id: string, createdAt = 1) => ({ id, turnId: null, parentToolUseId: null, createdAt });
const user = (id: string, text: string, at = 1): Item => ({ ...base(id, at), type: 'userMessage', content: [{ type: 'text', text }] });
const wakeup = (id: string, text = PROMPT, at = 1): Item => ({
  ...base(id, at),
  type: 'userMessage',
  content: [{ type: 'text', text }],
  synthetic: true,
  origin: 'wakeup',
});
const call = (id: string, name: string, input: object, output: object | undefined, outputText = '', status: ToolStatus = 'completed'): Item => ({
  ...base(id),
  type: 'toolCall',
  name,
  kind: 'schedule',
  input,
  status,
  outputText,
  ...(output ? { output } : {}),
});
const cronCreate = (o: { id?: string; job?: string; recurring?: boolean; prompt?: string; status?: ToolStatus; withOutput?: boolean } = {}) => {
  const recurring = o.recurring ?? true;
  const job = o.job ?? '6db9ae9a';
  return call(
    o.id ?? 'create',
    'CronCreate',
    { cron: '*/1 * * * *', prompt: o.prompt ?? PROMPT, recurring },
    o.withOutput === false ? undefined : { id: job, humanSchedule: 'Every minute', recurring, durable: false },
    `Scheduled ${recurring ? 'recurring' : 'one-shot'} job ${job} (Every minute). Session-only.`,
    o.status,
  );
};
const cronDelete = (job = '6db9ae9a') => call(`delete-${job}`, 'CronDelete', { id: job }, { id: job }, `Cancelled job ${job}.`);
const wakeupCall = (id: string, o: { prompt?: string; next?: number; stop?: boolean } = {}) =>
  call(
    id,
    'ScheduleWakeup',
    o.stop ? { stop: true } : { delaySeconds: 270, reason: 'watching CI', prompt: o.prompt ?? '/loop check the deploy', noop: false },
    o.stop ? { scheduledFor: 0, stopped: true } : { scheduledFor: o.next ?? 5000, clampedDelaySeconds: 270 },
  );
const goal = (id: string, event: GoalEvent, o: { reason?: string; iterations?: number; at?: number } = {}): Item => ({
  ...base(id, o.at ?? 1),
  type: 'notice',
  kind: 'goal',
  text: '',
  goal: { condition: CONDITION, event, ...(o.reason ? { reason: o.reason } : {}), ...(o.iterations !== undefined ? { iterations: o.iterations } : {}) },
});

const cron: SessionCron = { id: '6db9ae9a', schedule: '*/1 * * * *', recurring: true, prompt: PROMPT };
const live = (crons: SessionCron[] | undefined, turnRunning = false): Liveness => ({ kind: 'live', ...(crons ? { crons } : {}), turnRunning });
const unknown: Liveness = { kind: 'unknown' };

describe('scheduled jobs', () => {
  test("the capture's /loop: made from a /loop prompt, fired twice, then deleted", () => {
    const items = [user('p', `/loop 1m ${PROMPT}`), cronCreate(), wakeup('w1', PROMPT, 60), wakeup('w2', PROMPT, 120)];
    let work = scheduledWork(items, live([cron]));
    expect(work.schedules).toHaveLength(1);
    const run = work.schedules[0]!;
    expect(run).toMatchObject({ jobId: '6db9ae9a', fromLoop: true, humanSchedule: 'Every minute', firings: [60, 120], state: 'scheduled' });
    expect([...work.loopWakeups]).toEqual(['w1', 'w2']);
    const [task] = scheduledTasks(work);
    expect(task).toMatchObject({ id: 'schedule:create', toolUseId: 'create', kind: 'schedule', status: 'running', startedAt: 1 });
    expect(task!.schedule).toMatchObject({ firedCount: 2, lastFiredAt: 120, fromLoop: true, description: 'Every minute' });

    work = scheduledWork([...items, user('s', 'stop the loop'), cronDelete()], live([]));
    expect(work.schedules.map((r) => r.state)).toEqual(['deleted']);
    expect(scheduledTasks(work)[0]).toMatchObject({ status: 'stopped', schedule: { ended: 'deleted' } });
  });

  test('a job CronCreate made outside a /loop fires with its prompt, and a one-shot is done once fired', () => {
    const items = [user('p', 'remind me at noon'), cronCreate({ recurring: false, prompt: 'check the oven' })];
    expect(scheduledWork(items, unknown).schedules[0]!.state).toBe('scheduled');
    const fired = scheduledWork([...items, wakeup('w', 'check the oven')], unknown);
    expect(fired.schedules[0]).toMatchObject({ state: 'done', fromLoop: false });
    expect(fired.loopWakeups.size).toBe(0);
    expect(scheduledTasks(fired)[0]).toMatchObject({ status: 'done', schedule: { ended: 'fired', firedCount: 1 } });
  });

  test('what the Stop hook lists says what still wakes the session, once no turn is running', () => {
    const items = [user('p', `/loop 1m ${PROMPT}`), cronCreate()];
    // Said at a turn's end, so a job made in the running turn isn't on it yet.
    expect(scheduledWork(items, live([], true)).schedules[0]!.state).toBe('scheduled');
    expect(scheduledWork(items, live([])).schedules[0]!.state).toBe('ended');
    expect(scheduledWork(items, live([cron])).schedules[0]!.state).toBe('scheduled');
    // Before the hook has said anything: the items alone decide.
    expect(scheduledWork(items, live(undefined)).schedules[0]!.state).toBe('scheduled');
    // Session-only, it goes with the session's process.
    const ended = scheduledWork(items, { kind: 'ended' });
    expect(ended.schedules[0]!.state).toBe('ended');
    expect(scheduledTasks(ended)[0]).toMatchObject({ status: 'stopped', schedule: { ended: 'sessionEnded' } });
  });

  test('a dynamic /loop is one job whose next wakeup moves on, until a firing schedules none or Claude stops it', () => {
    let items: Item[] = [user('p', '/loop check the deploy'), wakeupCall('c1', { next: 1000 })];
    let work = scheduledWork(items, unknown);
    expect(work.schedules).toHaveLength(1);
    expect(work.schedules[0]).toMatchObject({ isWakeup: true, fromLoop: true, nextFire: 1000 });
    expect(scheduledTasks(work)[0]!.schedule).toMatchObject({ wakeup: true, nextFireAt: 1000 });

    items = [...items, wakeup('w1', '/loop check the deploy', 1000), wakeupCall('c2', { next: 2000 })];
    work = scheduledWork(items, unknown);
    expect(work.schedules).toHaveLength(1);
    expect(work.schedules[0]).toMatchObject({ nextFire: 2000, state: 'scheduled' });
    expect([...work.loopWakeups]).toEqual(['w1']);

    // Fired, and its turn still running: it may yet schedule the next.
    const firing = [...items, wakeup('w2', '/loop check the deploy', 2000)];
    expect(scheduledWork(firing, live(undefined, true)).schedules[0]!.state).toBe('scheduled');
    expect(scheduledWork(firing, live(undefined, false)).schedules[0]!.state).toBe('done');

    const stopped = [...items, user('s', 'stop'), wakeupCall('c3', { stop: true })];
    expect(scheduledWork(stopped, unknown).schedules[0]!.state).toBe('deleted');
  });

  test('a call that failed or has not come back made no job; history has its id from the text', () => {
    expect(scheduledWork([cronCreate({ status: 'running' })], unknown).schedules).toEqual([]);
    expect(scheduledWork([cronCreate({ status: 'denied' })], unknown).schedules).toEqual([]);
    expect(scheduledWork([cronCreate({ withOutput: false })], unknown).schedules[0]!.jobId).toBe('6db9ae9a');
  });

  test('a firing with no job the items hold is a job of its own, a loop\'s if it fired a /loop', () => {
    const work = scheduledWork([wakeup('w', '/loop check')], unknown);
    expect(work.schedules[0]).toMatchObject({ id: 'wakeup:w', fromLoop: true, firings: [1] });
    expect([...work.loopWakeups]).toEqual(['w']);
    expect(scheduledTasks(work)[0]!.toolUseId).toBeUndefined();
  });

  test('a prompt the CLI cut at 1000 characters still matches its job', () => {
    expect(samePrompt('abc… [+12 chars]', 'abcdefghijklmno')).toBe(true);
    expect(samePrompt('abd… [+12 chars]', 'abcdefghijklmno')).toBe(false);
  });

  test("a subagent's calls are its own business", () => {
    const nested = { ...(cronCreate() as any), parentToolUseId: 'agent' };
    expect(scheduledWork([nested], unknown).schedules).toEqual([]);
  });
});

describe('goals', () => {
  test('set, checked and found not met yet (the last reason kept), then met', () => {
    let items = [user('p', `/goal ${CONDITION}`), goal('g', 'set')];
    expect(scheduledWork(items, unknown).goals.map((g) => g.state)).toEqual(['active']);
    expect(scheduledTasks(scheduledWork(items, unknown))[0]).toMatchObject({ id: 'goal:g', kind: 'goal', title: CONDITION, status: 'running', goal: { checks: 0 } });
    items = [...items, goal('c1', 'notMet', { reason: 'typo on line 2' }), goal('c2', 'notMet', { reason: 'typo on line 3' })];
    let [task] = scheduledTasks(scheduledWork(items, unknown));
    expect(task!.goal).toEqual({ condition: CONDITION, checks: 2, lastCheck: { met: false, reason: 'typo on line 3' } });
    items = [...items, goal('c3', 'met', { reason: 'fixed', at: 9 })];
    [task] = scheduledTasks(scheduledWork(items, unknown));
    expect(task).toMatchObject({ status: 'done', endedAt: 9, goal: { checks: 3, lastCheck: { met: true, reason: 'fixed' } } });
  });

  test('a new goal replaces one still active; one that can\'t be met failed', () => {
    expect(scheduledWork([goal('a', 'set'), goal('b', 'set')], unknown).goals.map((g) => g.state)).toEqual(['cleared', 'active']);
    const [task] = scheduledTasks(scheduledWork([goal('a', 'set'), goal('f', 'failed', { reason: 'no such file', iterations: 4 })], unknown));
    expect(task).toMatchObject({ status: 'failed', error: 'no such file', goal: { checks: 4 } });
  });

  test('a check of a goal set before the items held still counts, as a goal of its own', () => {
    const work = scheduledWork([goal('c', 'notMet', { reason: 'not yet' })], unknown);
    expect(work.goals).toHaveLength(1);
    expect(work.goals[0]).toMatchObject({ id: 'c', misses: 1, state: 'active' });
  });
});
