import type { GoalNotice, Item, SessionCron, TaskState, ToolCallItem } from '../protocol/index.ts';

/**
 * A chat's scheduled jobs (/loop, CronCreate, ScheduleWakeup) and goals (/goal), as tasks. Worked
 * out from the chat's own items — the call that made a job, the wakeups it fired (`origin: wakeup`),
 * the call that deleted it, the goal notices — and, while this daemon runs the session, from what its
 * Stop hook last said will wake it (`sessionCrons`). Pure, so it's tested without a thread.
 */

type AnyObj = Record<string, any>;

export type ScheduleRun = {
  /** The call that made it, or `wakeup:<item id>` for a job known only by its firing. */
  id: string;
  /** The CLI's id for it, from CronCreate's answer; a wakeup's isn't said. */
  jobId?: string;
  prompt: string;
  fromLoop: boolean;
  /** A dynamic /loop's next wakeup (ScheduleWakeup), rather than a cron job. */
  isWakeup: boolean;
  recurring: boolean;
  cron?: string;
  humanSchedule?: string;
  nextFire?: number;
  durable: boolean;
  createdAt: number;
  firings: number[];
  wakeupIds: string[];
  /** When it was deleted, by the call's time. */
  deletedAt?: number;
  state: 'scheduled' | 'done' | 'deleted' | 'ended';
};

export type GoalRun = {
  /** The notice that set it. */
  id: string;
  condition: string;
  setAt: number;
  misses: number;
  lastReason?: string;
  /** The last check's verdict: met, or not yet (a failed check is neither). */
  lastMet?: boolean;
  iterations?: number;
  endedAt?: number;
  state: 'active' | 'met' | 'failed' | 'cleared';
};

/**
 * Whether the session's process is known to be running here, and what will wake it. `live`: this
 * daemon runs it, `crons` what its Stop hook last said (said at a turn's end, so a job made in the
 * running turn isn't on it yet); `ended`: its process has ended, and its session-only jobs with it;
 * `unknown`: not run here (another client may be running it), so nothing is assumed.
 */
export type Liveness = { kind: 'live'; crons?: SessionCron[]; turnRunning: boolean } | { kind: 'ended' } | { kind: 'unknown' };

export type ScheduledWork = { schedules: ScheduleRun[]; goals: GoalRun[]; loopWakeups: Set<string> };

const textOf = (item: Item): string => (item.type === 'userMessage' ? item.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n') : '');

/**
 * Whether an item says anything about scheduled work: a schedule call of the chat's own, a wakeup,
 * a goal notice, or a /loop prompt (whose jobs are the loop's).
 */
export function concernsSchedules(item: Item): boolean {
  if (item.parentToolUseId !== null) return false;
  switch (item.type) {
    case 'toolCall':
      return item.kind === 'schedule';
    case 'userMessage':
      if (item.origin === 'wakeup') return true;
      return item.synthetic !== true && textOf(item).startsWith('/loop');
    case 'notice':
      return item.kind === 'goal';
    default:
      return false;
  }
}

/** The same prompt, allowing for the CLI's cut at 1000 characters ("… [+N chars]"). */
export function samePrompt(a: string, b: string): boolean {
  if (a === b) return true;
  const cut = (s: string) => {
    const m = /… \[\+\d+ chars\]$/.exec(s);
    return m ? s.slice(0, m.index) : undefined;
  };
  const ca = cut(a);
  if (ca !== undefined) return b.startsWith(ca);
  const cb = cut(b);
  if (cb !== undefined) return a.startsWith(cb);
  return false;
}

/** The jobs and goals the items tell of, in the order they were made. Only items `concernsSchedules` picks out matter. */
export function scheduledWork(items: Iterable<Item>, liveness: Liveness): ScheduledWork {
  const work: ScheduledWork = { schedules: [], goals: [], loopWakeups: new Set() };
  let loopPrompt = false;
  // A dynamic /loop that just fired: it goes on only if its turn schedules the next wakeup.
  let firing: number | undefined;
  const settleFiring = () => {
    if (firing !== undefined) {
      const run = work.schedules[firing]!;
      if (run.isWakeup && run.state === 'scheduled' && run.nextFire === undefined) run.state = 'done';
    }
    firing = undefined;
  };
  for (const item of items) {
    if (item.parentToolUseId !== null) continue;
    if (item.type === 'userMessage' && item.origin === 'wakeup') {
      settleFiring();
      const prompt = textOf(item);
      let i = findLast(work.schedules, (r) => r.state === 'scheduled' && samePrompt(r.prompt, prompt));
      if (i < 0) i = findLast(work.schedules, (r) => samePrompt(r.prompt, prompt));
      if (i < 0) {
        // A job made before the items held (another process's, or an older part of the file): known only by its firing.
        const fromLoop = prompt.startsWith('/loop');
        work.schedules.push({
          id: `wakeup:${item.id}`,
          prompt,
          fromLoop,
          isWakeup: false,
          recurring: true,
          durable: false,
          createdAt: item.createdAt,
          firings: [item.createdAt],
          wakeupIds: [item.id],
          state: 'scheduled',
        });
        if (fromLoop) work.loopWakeups.add(item.id);
        continue;
      }
      const run = work.schedules[i]!;
      run.firings.push(item.createdAt);
      run.wakeupIds.push(item.id);
      if (run.fromLoop) work.loopWakeups.add(item.id);
      if (run.isWakeup) {
        // Its wakeup is spent; the turn it starts schedules the next, or the loop ends.
        run.nextFire = undefined;
        firing = i;
      } else if (!run.recurring && run.state === 'scheduled') {
        run.state = 'done';
      }
      loopPrompt = false;
    } else if (item.type === 'userMessage') {
      if (item.synthetic === true) continue;
      settleFiring();
      loopPrompt = textOf(item).startsWith('/loop');
    } else if (item.type === 'toolCall' && item.kind === 'schedule') {
      if (item.status !== 'completed' || item.isError) continue;
      firing = applyCall(item, work, loopPrompt, firing);
    } else if (item.type === 'notice' && item.kind === 'goal' && item.goal) {
      applyGoal(item.goal, item.id, item.createdAt, work);
    }
  }
  // A firing turn still running may yet schedule the next wakeup.
  if (!(liveness.kind === 'live' && liveness.turnRunning)) settleFiring();
  settle(work, liveness);
  return work;
}

function findLast<T>(xs: T[], f: (x: T) => boolean): number {
  for (let i = xs.length - 1; i >= 0; i--) if (f(xs[i]!)) return i;
  return -1;
}

const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

function applyCall(call: ToolCallItem, work: ScheduledWork, loopPrompt: boolean, firing: number | undefined): number | undefined {
  const input = (call.input ?? {}) as AnyObj;
  const output = (call.output ?? {}) as AnyObj;
  switch (call.name) {
    case 'CronCreate': {
      const text = call.outputText ?? '';
      const recurring = typeof input.recurring === 'boolean' ? input.recurring : typeof output.recurring === 'boolean' ? output.recurring : !text.includes('one-shot');
      const cron = str(input.cron);
      let human = str(output.humanSchedule) ?? /job [0-9A-Za-z_-]+ \(([^)]+)\)/.exec(text)?.[1];
      if (human === cron) human = undefined;
      work.schedules.push({
        id: call.id,
        jobId: str(output.id) ?? /job ([0-9A-Za-z_-]+)/.exec(text)?.[1],
        prompt: str(input.prompt) ?? '',
        fromLoop: loopPrompt,
        isWakeup: false,
        recurring,
        ...(cron ? { cron } : {}),
        ...(human ? { humanSchedule: human } : {}),
        durable: typeof output.durable === 'boolean' ? output.durable : input.durable === true,
        createdAt: call.createdAt,
        firings: [],
        wakeupIds: [],
        state: 'scheduled',
      });
      return firing;
    }
    case 'CronDelete': {
      const id = str(input.id) ?? str(output.id);
      if (!id) return firing;
      for (const r of work.schedules)
        if (r.jobId === id && r.state === 'scheduled') {
          r.state = 'deleted';
          r.deletedAt = call.createdAt;
        }
      return firing;
    }
    case 'ScheduleWakeup': {
      if (input.stop === true || output.stopped === true) {
        for (const r of work.schedules)
          if (r.isWakeup && r.state === 'scheduled') {
            r.state = 'deleted';
            r.deletedAt = call.createdAt;
          }
        return undefined;
      }
      const prompt = str(input.prompt) ?? '';
      const next = typeof output.scheduledFor === 'number' ? output.scheduledFor : undefined;
      // Each wakeup replaces the last: one loop, its next wakeup moving on.
      const i = findLast(work.schedules, (r) => r.isWakeup && r.state === 'scheduled' && samePrompt(r.prompt, prompt));
      if (i >= 0) {
        const run = work.schedules[i]!;
        run.nextFire = next && next > 0 ? next : undefined;
        if (next === 0) run.state = 'done';
        return firing === i ? undefined : firing;
      }
      work.schedules.push({
        id: call.id,
        prompt,
        fromLoop: true,
        isWakeup: true,
        recurring: false,
        ...(next && next > 0 ? { nextFire: next } : {}),
        durable: false,
        createdAt: call.createdAt,
        firings: [],
        wakeupIds: [],
        // Aged out: the CLI scheduled nothing.
        state: next === 0 ? 'done' : 'scheduled',
      });
      return firing;
    }
    default:
      return firing;
  }
}

function applyGoal(goal: GoalNotice, id: string, at: number, work: ScheduledWork) {
  const active = findLast(work.goals, (g) => g.state === 'active');
  if (goal.event === 'set') {
    // A new goal replaces the one before.
    if (active >= 0) {
      work.goals[active]!.state = 'cleared';
      work.goals[active]!.endedAt = at;
    }
    work.goals.push({ id, condition: goal.condition, setAt: at, misses: 0, state: 'active' });
    return;
  }
  let i = active;
  // A check of a goal set before the items held still counts, as a goal of its own.
  if (i < 0) i = work.goals.push({ id, condition: goal.condition, setAt: at, misses: 0, state: 'active' }) - 1;
  const g = work.goals[i]!;
  if (goal.reason) g.lastReason = goal.reason;
  if (goal.iterations !== undefined) g.iterations = goal.iterations;
  switch (goal.event) {
    case 'notMet':
      g.misses++;
      g.lastMet = false;
      break;
    case 'met':
      g.state = 'met';
      g.lastMet = true;
      break;
    case 'failed':
      g.state = 'failed';
      g.lastMet = false;
      break;
    case 'cleared':
      g.state = 'cleared';
      break;
  }
  if (g.state !== 'active') g.endedAt = at;
}

/**
 * What the session says now: a job its Stop hook no longer lists has gone (once no turn is running,
 * since the list is said at a turn's end); one whose process has ended went with it.
 */
function settle(work: ScheduledWork, liveness: Liveness) {
  for (const run of work.schedules) {
    if (run.state !== 'scheduled') continue;
    if (liveness.kind === 'live' && liveness.crons && !liveness.turnRunning) {
      const listed = liveness.crons.some((c) => (run.jobId ? c.id === run.jobId : c.recurring === run.recurring && samePrompt(c.prompt, run.prompt)));
      if (!listed) run.state = run.recurring ? 'ended' : 'done';
    } else if (liveness.kind === 'ended' && !run.durable) {
      run.state = 'ended';
    }
  }
}

/** The tasks of the chat's schedules and goals. */
export function scheduledTasks(work: ScheduledWork): TaskState[] {
  const schedules = work.schedules.map((r): TaskState => {
    const status = r.state === 'scheduled' ? 'running' : r.state === 'done' ? 'done' : 'stopped';
    const ended = r.state === 'done' ? 'fired' : r.state === 'deleted' ? 'deleted' : r.state === 'ended' ? 'sessionEnded' : undefined;
    const endedAt = r.state === 'deleted' ? r.deletedAt : r.state === 'done' ? r.firings.at(-1) : undefined;
    const lastFiredAt = r.firings.at(-1);
    return {
      id: `schedule:${r.id}`,
      ...(r.id.startsWith('wakeup:') ? {} : { toolUseId: r.id }),
      kind: 'schedule',
      title: r.prompt.startsWith('<<autonomous-loop') || !r.prompt ? '/loop' : r.prompt,
      status,
      startedAt: r.createdAt,
      ...(endedAt !== undefined ? { endedAt } : {}),
      schedule: {
        ...(r.jobId ? { jobId: r.jobId } : {}),
        ...(r.cron ? { cron: r.cron } : {}),
        ...(r.humanSchedule ? { description: r.humanSchedule } : {}),
        prompt: r.prompt,
        recurring: r.recurring,
        durable: r.durable,
        wakeup: r.isWakeup,
        fromLoop: r.fromLoop,
        firedCount: r.firings.length,
        ...(lastFiredAt !== undefined ? { lastFiredAt } : {}),
        ...(r.nextFire !== undefined && r.state === 'scheduled' ? { nextFireAt: r.nextFire } : {}),
        ...(ended ? { ended } : {}),
      },
    };
  });
  const goals = work.goals.map((g): TaskState => {
    const status = g.state === 'active' ? 'running' : g.state === 'met' ? 'done' : g.state === 'failed' ? 'failed' : 'stopped';
    const checks = g.iterations ?? g.misses + (g.state === 'met' || g.state === 'failed' ? 1 : 0);
    return {
      id: `goal:${g.id}`,
      kind: 'goal',
      title: g.condition,
      status,
      startedAt: g.setAt,
      ...(g.endedAt !== undefined ? { endedAt: g.endedAt } : {}),
      ...(g.state === 'failed' && g.lastReason ? { error: g.lastReason } : {}),
      goal: {
        condition: g.condition,
        checks,
        ...(g.lastMet !== undefined ? { lastCheck: { met: g.lastMet, ...(g.lastReason ? { reason: g.lastReason } : {}) } } : {}),
      },
    };
  });
  return [...schedules, ...goals];
}
