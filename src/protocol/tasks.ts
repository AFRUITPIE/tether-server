import { z } from 'zod';

/**
 * What a task is. `agent`: a subagent (an Agent/Task call, or a `local_agent` task); `command`: a
 * shell command run as a task (`local_bash`, a background Bash call); `monitor`; `mcpTool`: an MCP
 * call sent to the background; `workflow`: a dynamic workflow (the Workflow tool's run);
 * `workflowAgent`: one of a workflow's agents, which has no task of the CLI's; `schedule`: a job that
 * wakes the chat later (/loop, CronCreate, ScheduleWakeup); `goal`: a /goal; `other`: a task type
 * this server doesn't know, named in `taskType`.
 */
export const TaskKind = z
  .enum(['agent', 'command', 'monitor', 'mcpTool', 'workflow', 'workflowAgent', 'schedule', 'goal', 'other'])
  .meta({ id: 'TaskKind' });
export type TaskKind = z.infer<typeof TaskKind>;

/**
 * How a task stands. `waiting`: not started (queued for a slot), or, for a workflow found only by its
 * journal and not written to for a while, not known to be going or to have ended. A schedule is
 * `running` while it will fire again, `done` once it fired its last time, `stopped` once deleted or
 * gone with its session; a goal is `running` while active, `done` when met, `failed` when it can't be
 * met, `stopped` when cleared.
 */
export const TaskStatus = z.enum(['waiting', 'running', 'done', 'failed', 'stopped']).meta({ id: 'TaskStatus' });
export type TaskStatus = z.infer<typeof TaskStatus>;

export const TaskUsage = z
  .object({
    durationMs: z.number().optional(),
    totalTokens: z.number().optional(),
    toolUses: z.number().optional(),
  })
  .meta({ id: 'TaskUsage' });
export type TaskUsage = z.infer<typeof TaskUsage>;

/** One of a workflow's phases, in the script's order, and how its agents stand. */
export const TaskPhase = z
  .object({ index: z.number().int(), title: z.string(), status: TaskStatus })
  .meta({ id: 'TaskPhase' });
export type TaskPhase = z.infer<typeof TaskPhase>;

/** A dynamic workflow's own facts. Its agents are tasks of their own (`workflowAgent`), its children. */
export const WorkflowTaskInfo = z
  .object({
    runId: z.string().optional(),
    /** The script's `meta` name (else the named workflow, else the saved script's file name). */
    name: z.string().optional(),
    description: z.string().optional(),
    phases: z.array(TaskPhase),
    /** While it runs: its latest agent event, "Phase: label". */
    activity: z.string().optional(),
    /** Its return value as text (JSON indented), once it has completed. Why it failed is `error`. */
    result: z.string().optional(),
  })
  .meta({ id: 'WorkflowTaskInfo' });
export type WorkflowTaskInfo = z.infer<typeof WorkflowTaskInfo>;

/** One workflow agent's own facts. Its transcript is `workflow/agentItems` (the run's id and `agentId`). */
export const WorkflowAgentTaskInfo = z
  .object({
    runId: z.string().optional(),
    /** Its place in the run, from 1. */
    index: z.number().int(),
    /** The CLI's id for it, once it has started: what `workflow/agentItems` takes. */
    agentId: z.string().optional(),
    /** The phase it ran in, by title, with the script's own title for a withheld one ("phase 2"). */
    phase: z.string().optional(),
    phaseIndex: z.number().int().optional(),
    /**
     * What it was asked: the script's task, without the harness's framing. The CLI's preview, cut at
     * about 400 characters ("…") until the agent's transcript gives the whole of it.
     */
    prompt: z.string().optional(),
    model: z.string().optional(),
    lastToolName: z.string().optional(),
  })
  .meta({ id: 'WorkflowAgentTaskInfo' });
export type WorkflowAgentTaskInfo = z.infer<typeof WorkflowAgentTaskInfo>;

/** A job that wakes the chat later: a CronCreate (a /loop with an interval makes one), or a dynamic /loop's ScheduleWakeup. */
export const ScheduleTaskInfo = z
  .object({
    /** The CLI's id for it, from CronCreate's answer (what CronDelete takes); a wakeup has none. */
    jobId: z.string().optional(),
    /** A cron expression, in the host's local time. */
    cron: z.string().optional(),
    /** How Claude Code says when it fires: "Every minute". */
    description: z.string().optional(),
    /** What it fires with. */
    prompt: z.string(),
    recurring: z.boolean(),
    /** Kept on disk by Claude Code, so it outlives the session's process. */
    durable: z.boolean(),
    /** A dynamic /loop's next wakeup (ScheduleWakeup) rather than a cron job. */
    wakeup: z.boolean(),
    /** Set up by /loop: made in a turn a /loop prompt started, or a dynamic /loop's wakeup. */
    fromLoop: z.boolean(),
    firedCount: z.number().int(),
    lastFiredAt: z.number().optional(),
    /** When it fires next, ms since epoch, when known (a wakeup says). */
    nextFireAt: z.number().optional(),
    /** Why it's over: it fired its last time, it was deleted, or its session's process ended. */
    ended: z.enum(['fired', 'deleted', 'sessionEnded']).optional(),
  })
  .meta({ id: 'ScheduleTaskInfo' });
export type ScheduleTaskInfo = z.infer<typeof ScheduleTaskInfo>;

/** A /goal Claude works toward until it's met: from its set, through its Stop hook's checks. */
export const GoalTaskInfo = z
  .object({
    condition: z.string(),
    /** Checks so far: those that found it not met yet, and the one that met it or found it impossible. */
    checks: z.number().int(),
    /** What the last check said, with the evaluator's reason. */
    lastCheck: z.object({ met: z.boolean(), reason: z.string().optional() }).optional(),
  })
  .meta({ id: 'GoalTaskInfo' });
export type GoalTaskInfo = z.infer<typeof GoalTaskInfo>;

/**
 * One of a chat's tasks, as it stands now: whole every time it is sent (`task/updated`, and the
 * `tasks` of `thread/read`, `thread/resume` and `thread/subscribe`), never a patch.
 */
export const TaskState = z
  .object({
    /**
     * Stable for the chat: the id of the tool call that started it (an Agent, Workflow, Bash or
     * Monitor call) where there is one, else `task:<CLI task id>`; a workflow's agents are
     * `<workflow id>/agent/<index>`, schedules `schedule:<call id>` and goals `goal:<notice id>`.
     */
    id: z.string(),
    /**
     * The task that started it, by id: the subagent or workflow whose call it is; a workflow agent's
     * workflow; a command a workflow agent ran, that agent (else its workflow). Absent at the top.
     */
    parentId: z.string().optional(),
    /** The tool call that started it, when there is one. */
    toolUseId: z.string().optional(),
    /** The CLI's task id: what `task/stop` and `task/background` take. Absent for a workflow agent, a schedule or a goal. */
    taskId: z.string().optional(),
    kind: TaskKind,
    /** The CLI's `task_type` (`local_bash`, `local_agent`, …), when it said. */
    taskType: z.string().optional(),
    title: z.string(),
    status: TaskStatus,
    startedAt: z.number().optional().describe('ms since epoch'),
    endedAt: z.number().optional().describe('ms since epoch'),
    /** Sent to the background: it goes on after the turn that started it. */
    backgrounded: z.boolean().optional(),
    /** Still holds up its turn and can be sent to the background (`task/background`): a command or an agent. */
    canBackground: z.boolean().optional(),
    /** What the CLI last said of it: its progress, or how it ended. */
    summary: z.string().optional(),
    /** Why it failed. */
    error: z.string().optional(),
    /** What it returned, when known: an agent's report, a command's output, a workflow agent's result (cut at 20,000 characters). */
    output: z.string().optional(),
    /** Where a background command writes its output, on the host. */
    outputFile: z.string().optional(),
    usage: TaskUsage.optional(),
    workflow: WorkflowTaskInfo.optional(),
    workflowAgent: WorkflowAgentTaskInfo.optional(),
    schedule: ScheduleTaskInfo.optional(),
    goal: GoalTaskInfo.optional(),
  })
  .meta({ id: 'TaskState' });
export type TaskState = z.infer<typeof TaskState>;
