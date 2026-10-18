import type { TaskKind, TaskPhase, TaskState, TaskStatus, TaskUsage, ToolCallItem } from '../protocol/index.ts';
import { launchRunId, scriptMeta, settleAgents, unframeAgentPrompt, type WorkflowAgent, type WorkflowSnapshot } from './workflows.ts';

/**
 * Typed task state: what the Tasks tab shows of each task, worked out here from what the CLI says
 * (task events, the calls that start tasks, workflow snapshots) so a client reads it as it is. The
 * itemizer keeps the facts; these are the pure parts.
 */

type AnyObj = Record<string, any>;

/** What a task's `output` keeps of an agent's report or a command's output. */
export const OUTPUT_CAP = 20_000;

/** What the CLI has said of one task, merged from its events (and, from history, its notification). */
export type TaskFacts = {
  taskId: string;
  toolUseId?: string;
  /** `task_type`: local_bash, local_agent, local_workflow, monitor, mcp_task, … */
  type?: string;
  description?: string;
  /** The CLI's latest status: pending | running | completed | failed | killed | stopped | paused. */
  status?: string;
  summary?: string;
  error?: string;
  usage?: TaskUsage;
  startedAt?: number;
  endedAt?: number;
  outputFile?: string;
  /** A `task_updated` patch's `is_backgrounded`. */
  backgrounded?: boolean;
  workflowName?: string;
};

/** A status as the CLI (or a workflow agent, or a notification) names it. */
export function taskStatusOf(cli: unknown): TaskStatus | undefined {
  switch (cli) {
    case 'pending':
    case 'queued':
    case 'waiting':
      return 'waiting';
    case 'running':
    case 'paused':
    case 'started':
    case 'progress':
      return 'running';
    case 'completed':
    case 'done':
      return 'done';
    case 'failed':
    case 'error':
      return 'failed';
    case 'killed':
    case 'stopped':
    case 'cancelled':
    case 'canceled':
    case 'interrupted':
      return 'stopped';
    default:
      return undefined;
  }
}

export const isTerminal = (s: TaskStatus | undefined) => s === 'done' || s === 'failed' || s === 'stopped';

export function kindOfTaskType(type: string | undefined): TaskKind | undefined {
  switch (type) {
    case undefined:
      return undefined;
    case 'local_workflow':
      return 'workflow';
    case 'local_agent':
    case 'remote_agent':
      return 'agent';
    case 'local_bash':
      return 'command';
    case 'monitor':
    case 'monitor_mcp':
      return 'monitor';
    case 'mcp_task':
      return 'mcpTool';
    default:
      return 'other';
  }
}

export function kindOfCall(call: ToolCallItem): TaskKind {
  if (call.name === 'Workflow') return 'workflow';
  switch (call.kind) {
    case 'subagent':
      return 'agent';
    case 'bash':
      return 'command';
    case 'monitor':
      return 'monitor';
    case 'mcp':
      return 'mcpTool';
    default:
      return 'other';
  }
}

/**
 * A call that is a task whether or not the CLI reports one for it: a subagent's, a workflow's, a
 * Monitor, a Bash sent to the background. History has no task events, only these calls.
 */
export function isTaskCall(call: ToolCallItem): boolean {
  if (call.kind === 'subagent' || call.kind === 'monitor' || call.name === 'Workflow') return true;
  return call.kind === 'bash' && (call.input as AnyObj)?.run_in_background === true;
}

/** A call that came back at once while what it started goes on (a background agent, a workflow, a monitor). */
export function launchedInBackground(call: ToolCallItem): boolean {
  if (call.status !== 'completed') return false;
  if (call.name === 'Workflow' || call.kind === 'monitor') return true;
  const o = call.output as AnyObj | undefined;
  if (o && typeof o === 'object' && (o.status === 'async_launched' || o.isAsync === true || typeof o.backgroundTaskId === 'string')) return true;
  if (call.kind === 'bash' && (call.input as AnyObj)?.run_in_background === true) return true;
  const text = call.outputText ?? '';
  if (call.kind === 'subagent' && (/^agentId: \w+/m.test(text) || /async agent launched/i.test(text))) return true;
  return /launched in (?:the )?background|running in (?:the )?background/i.test(text);
}

/** The task id a launch names: a background agent's `agentId`, a command's `ID: …`, a workflow's `Task ID`. */
export function launchedTaskId(call: ToolCallItem): string | undefined {
  const o = (call.output ?? {}) as AnyObj;
  for (const k of ['agentId', 'backgroundTaskId', 'taskId']) if (typeof o[k] === 'string' && o[k]) return o[k];
  const text = call.outputText ?? '';
  return /^agentId: (\w+)/m.exec(text)?.[1] ?? /running in background with ID: (\w+)/i.exec(text)?.[1] ?? /Task ID: ([A-Za-z0-9_-]+)/.exec(text)?.[1];
}

/** Where a background command's output goes, from its launch's text. */
export function launchedOutputFile(call: ToolCallItem): string | undefined {
  return /Output is being written to: (\S+?)\.?(?:\s|$)/.exec(call.outputText ?? '')?.[1];
}

function callStatus(call: ToolCallItem): TaskStatus {
  switch (call.status) {
    case 'pending':
    case 'running':
      return 'running';
    case 'completed':
      return 'done';
    case 'failed':
    case 'denied':
      return 'failed';
    case 'interrupted':
      return 'stopped';
  }
}

export function clip(text: string | undefined, cap = OUTPUT_CAP): string | undefined {
  if (!text) return undefined;
  return text.length > cap ? `${text.slice(0, cap)}…` : text;
}

const firstLine = (text: string | undefined) => text?.split('\n').find((l) => l.trim())?.trim();

/** A workflow's status as a task's: paused goes on; a run only its stale journal tells of is waiting. */
export function workflowTaskStatus(status: string | undefined): TaskStatus | undefined {
  switch (status) {
    case undefined:
      return undefined;
    case 'unknown':
      return 'waiting';
    case 'stopped':
    case 'killed':
      return 'stopped';
    default:
      return taskStatusOf(status);
  }
}

const SETTLED = new Set(['completed', 'failed', 'stopped']);

/**
 * A workflow agent's status, from the CLI's own words: `skipped` (by the person) and `blocked` (by
 * the classifier) are stopped, `cached` done; "start" before it has a slot is waiting.
 */
export function agentStatus(a: WorkflowAgent): TaskStatus {
  if (a.skipped || a.blocked) return 'stopped';
  if (a.cached) return 'done';
  switch (a.state) {
    case 'done':
    case 'completed':
    case 'cached':
      return 'done';
    case 'skipped':
    case 'stopped':
    case 'killed':
    case 'cancelled':
    case 'canceled':
      return 'stopped';
    case 'error':
    case 'failed':
      return a.error === 'skipped by user' ? 'stopped' : 'failed';
    case 'queued':
    case 'waiting':
    case 'pending':
      return 'waiting';
    default:
      return a.state === 'start' && a.queuedAt !== undefined && a.startedAt === undefined ? 'waiting' : 'running';
  }
}

/** "phase 2", which is all the CLI says of a phase when it withholds the script. */
const isPlaceholder = (title: string | undefined) => !title || /^phase \d+$/i.test(title);

export type TaskBuildOptions = {
  /** The session's process has ended: nothing it ran goes on. */
  ended?: boolean;
  /** A workflow agent's whole prompt, when its preview was cut. */
  readPrompt?: (runId: string, agentId: string) => string | undefined;
};

/**
 * A workflow's task and its agents', from the workflow's task as its call and events say (`base`)
 * and its snapshot, live or read from disk. A settled run settles the agents it last heard of
 * (`settleAgents`); phases take the script's titles where the CLI withheld them.
 */
export function workflowTasks(base: TaskState, snapshot: WorkflowSnapshot | undefined, script: unknown, opts: TaskBuildOptions = {}): TaskState[] {
  const meta = scriptMeta(script);
  const w = snapshot ? settleAgents(snapshot) : undefined;
  const fromSnapshot = workflowTaskStatus(w?.status);
  let status = base.status;
  // A settled snapshot is the run's last word; else a settled task; else what the snapshot says.
  if (w?.status && SETTLED.has(w.status)) status = fromSnapshot!;
  else if (!isTerminal(base.status) && fromSnapshot) status = fromSnapshot;
  if (opts.ended && (status === 'running' || status === 'waiting')) status = 'stopped';

  const runId = w?.runId ?? base.workflow?.runId;
  const metaTitle = (index: number, title: string | undefined) =>
    isPlaceholder(title) && index >= 1 && index <= meta.phases.length ? meta.phases[index - 1]!.title : title;

  const phases = new Map<number, string>();
  for (const p of w?.phases.length ? w.phases : meta.phases) phases.set(p.index, metaTitle(p.index, p.title) ?? '');
  for (const a of w?.agents ?? []) if (a.phaseIndex !== undefined && !phases.has(a.phaseIndex)) phases.set(a.phaseIndex, metaTitle(a.phaseIndex, a.phaseTitle) ?? '');

  const agents: TaskState[] = (w?.agents ?? []).map((a) => {
    let s = agentStatus(a);
    if ((opts.ended || status === 'stopped' || status === 'failed') && (s === 'running' || s === 'waiting')) s = 'stopped';
    // A run not known to be going or to have ended (a stale journal): nor are its agents.
    else if (status === 'waiting' && s === 'running') s = 'waiting';
    const phase = a.phaseIndex !== undefined ? phases.get(a.phaseIndex) || metaTitle(a.phaseIndex, a.phaseTitle) : a.phaseTitle;
    let prompt = a.promptPreview;
    if (prompt !== undefined) {
      const unframed = unframeAgentPrompt(prompt);
      if (typeof unframed === 'string') prompt = unframed;
      if (prompt.endsWith('…') && a.agentId && runId) prompt = opts.readPrompt?.(runId, a.agentId) ?? prompt;
    }
    const startedAt = a.startedAt ?? a.queuedAt;
    const usage: TaskUsage = {
      ...(a.durationMs !== undefined ? { durationMs: a.durationMs } : {}),
      ...(a.tokens !== undefined ? { totalTokens: a.tokens } : {}),
      ...(a.toolCalls !== undefined ? { toolUses: a.toolCalls } : {}),
    };
    const skippedByUser = a.skipped || a.error === 'skipped by user';
    return {
      id: `${base.id}/agent/${a.index}`,
      parentId: base.id,
      kind: 'workflowAgent',
      title: a.label,
      status: s,
      ...(startedAt !== undefined ? { startedAt } : {}),
      ...(isTerminal(s) && a.startedAt !== undefined && a.durationMs !== undefined ? { endedAt: a.startedAt + a.durationMs } : {}),
      ...(s === 'running' && a.lastToolSummary ? { summary: a.lastToolSummary } : {}),
      ...(a.error && !skippedByUser ? { error: a.error } : {}),
      ...(a.resultPreview ? { output: clip(a.resultPreview)! } : {}),
      ...(Object.keys(usage).length ? { usage } : {}),
      workflowAgent: {
        ...(runId ? { runId } : {}),
        index: a.index,
        ...(a.agentId ? { agentId: a.agentId } : {}),
        ...(phase ? { phase } : {}),
        ...(a.phaseIndex !== undefined ? { phaseIndex: a.phaseIndex } : {}),
        ...(prompt ? { prompt } : {}),
        ...(a.model ? { model: a.model } : {}),
        ...(a.lastToolName ? { lastToolName: a.lastToolName } : {}),
      },
    } satisfies TaskState;
  });

  const indexes = [...phases.keys()].sort((x, y) => x - y);
  const taskPhases: TaskPhase[] = indexes
    .map((index) => ({ index, title: phases.get(index) ?? '' }))
    .filter((p) => p.title || agents.some((a) => a.workflowAgent?.phaseIndex === p.index))
    .map((p) => ({ ...p, status: phaseStatus(p.index, agents, status) }));

  const usage: TaskUsage = {
    ...base.usage,
    ...(w?.durationMs !== undefined ? { durationMs: w.durationMs } : {}),
    ...(w?.totalTokens !== undefined ? { totalTokens: w.totalTokens } : {}),
    ...(w?.toolUses !== undefined ? { toolUses: w.toolUses } : {}),
  };
  const name = w?.name ?? base.workflow?.name ?? meta.name;
  const description = w?.description ?? base.workflow?.description ?? meta.description;
  const error = w?.error ?? base.error;
  const result = w?.result ?? base.workflow?.result;
  const workflow: TaskState = {
    ...base,
    title: name ?? base.title,
    status,
    ...(Object.keys(usage).length ? { usage } : {}),
    ...(error ? { error } : {}),
    workflow: {
      ...(runId ? { runId } : {}),
      ...(name ? { name } : {}),
      ...(description ? { description } : {}),
      phases: taskPhases,
      ...(status === 'running' && w?.activity ? { activity: w.activity } : {}),
      ...(result && status === 'done' ? { result } : {}),
    },
  };
  return [workflow, ...agents];
}

/** How a phase stands, from its agents, and for one with none, from the run and the phases after it. */
function phaseStatus(index: number, agents: TaskState[], run: TaskStatus): TaskStatus {
  const own = agents.filter((a) => a.workflowAgent?.phaseIndex === index).map((a) => a.status);
  if (!own.length) {
    if (run === 'done') return 'done';
    if (run === 'failed' || run === 'stopped') return 'stopped';
    const later = agents.some((a) => (a.workflowAgent?.phaseIndex ?? -Infinity) > index);
    return later ? 'done' : 'waiting';
  }
  if (own.includes('running')) return 'running';
  if (own.includes('waiting')) return own.some(isTerminal) ? 'running' : 'waiting';
  if (own.includes('failed')) return 'failed';
  if (own.every((s) => s === 'stopped')) return 'stopped';
  return 'done';
}

/**
 * One task's state from its call and the CLI's facts, before its parent is known. Which says more:
 * a settled task says how it ended; one in the background set goes on though its call returned; a
 * foreground call that finished is finished; else the task's status, else the call's (a launch in
 * the background going on until told otherwise).
 */
export function taskState(id: string, call: ToolCallItem | undefined, f: TaskFacts | undefined, opts: TaskBuildOptions & { inBackground?: boolean; live?: boolean; workflowName?: string } = {}): TaskState {
  const kind = kindOfTaskType(f?.type) ?? (call ? kindOfCall(call) : 'other');
  const launched = call ? launchedInBackground(call) : false;
  const fromTask = taskStatusOf(f?.status);
  const fromCall = call ? callStatus(call) : undefined;
  let status: TaskStatus;
  if (isTerminal(fromTask)) status = fromTask!;
  else if (opts.inBackground || f?.backgrounded) status = 'running';
  else if (fromCall && fromCall !== 'running' && !launched) status = fromCall;
  else if (fromTask) status = fromTask;
  else status = launched ? 'running' : (fromCall ?? 'running');
  if (opts.ended && (status === 'running' || status === 'waiting')) status = 'stopped';
  const terminal = isTerminal(status);

  const input = (call?.input ?? {}) as AnyObj;
  const title =
    kind === 'workflow'
      ? (opts.workflowName ?? f?.workflowName ?? f?.description ?? 'Workflow')
      : (f?.description ??
        (typeof input.description === 'string' && input.description ? input.description : undefined) ??
        call?.summary ??
        (kind === 'command' && typeof input.command === 'string' ? input.command : undefined) ??
        f?.taskId ??
        (kind === 'agent' ? 'Agent' : 'Task'));
  const taskId = f?.taskId ?? (call ? launchedTaskId(call) : undefined);
  const type = f?.type;
  const backgrounded = !terminal && (!!opts.inBackground || !!f?.backgrounded || launched);
  const canBackground =
    !!opts.live &&
    status === 'running' &&
    !backgrounded &&
    call?.status === 'running' &&
    (type ? type === 'local_bash' || type === 'local_agent' : kind === 'agent' || kind === 'command');
  const error = f?.error ?? (status === 'failed' && call?.isError ? firstLine(call.outputText) : undefined);
  const output = call && call.status === 'completed' && !launched && kind !== 'workflow' ? clip(call.outputText) : undefined;
  const outputFile = f?.outputFile ?? (call && kind === 'command' ? launchedOutputFile(call) : undefined);
  const startedAt = f?.startedAt ?? call?.createdAt;
  const runId = kind === 'workflow' && call ? launchRunId(call.output, call.outputText) : undefined;
  return {
    id,
    ...(call ? { toolUseId: call.id } : f?.toolUseId ? { toolUseId: f.toolUseId } : {}),
    ...(taskId ? { taskId } : {}),
    kind,
    ...(type ? { taskType: type } : {}),
    title,
    status,
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(terminal && f?.endedAt !== undefined ? { endedAt: f.endedAt } : {}),
    ...(backgrounded ? { backgrounded: true } : {}),
    ...(canBackground ? { canBackground: true } : {}),
    ...(f?.summary ? { summary: f.summary } : {}),
    ...(error ? { error } : {}),
    ...(output ? { output } : {}),
    ...(outputFile ? { outputFile } : {}),
    ...(f?.usage && Object.keys(f.usage).length ? { usage: { ...f.usage } } : {}),
    ...(kind === 'workflow' ? { workflow: { ...(runId ? { runId } : {}), phases: [] } } : {}),
  };
}

/** The CLI's `usage` on a task event, as a task's. */
export function usageOf(u: unknown): TaskUsage | undefined {
  if (!u || typeof u !== 'object') return undefined;
  const o = u as AnyObj;
  const out: TaskUsage = {
    ...(typeof o.duration_ms === 'number' ? { durationMs: o.duration_ms } : {}),
    ...(typeof o.total_tokens === 'number' ? { totalTokens: o.total_tokens } : {}),
    ...(typeof o.tool_uses === 'number' ? { toolUses: o.tool_uses } : {}),
  };
  return Object.keys(out).length ? out : undefined;
}

/** A task list with each id once, the later of two winning, in the order each was first listed. */
export function mergeTasks(...lists: TaskState[][]): TaskState[] {
  const out = new Map<string, TaskState>();
  for (const list of lists) for (const t of list) out.set(t.id, t);
  return [...out.values()];
}
