import type { FileEdit, Item, SessionCron, TaskState, ToolCallItem, ToolKind, Turn, TurnResult, UserInput } from '../protocol/index.ts';
import { editOf, isEditCall, totalsOf, trimmedEditOutput } from './edits.ts';
import type { NotificationBody, NotificationName } from '../protocol/notifications.ts';
import type { GoalNotice } from '../protocol/items.ts';
import {
  launchRunId,
  launchTaskId,
  mergeWorkflowProgress,
  notificationResult,
  scriptMeta,
  settleAgents,
  workflowCallName,
  workflowStatus,
  type WorkflowSnapshot,
} from './workflows.ts';
import { concernsSchedules, scheduledTasks, scheduledWork, type Liveness } from './scheduled.ts';
import { isTaskCall, isTerminal, taskState, taskStatusOf, usageOf, workflowTasks, type TaskFacts } from './tasks.ts';

export type Emission = { [N in NotificationName]: { method: N; body: NotificationBody<N> } }[NotificationName];

type AnyMsg = Record<string, any>;

export function toolKind(name: string): ToolKind {
  if (name.startsWith('mcp__')) return 'mcp';
  switch (name) {
    case 'Bash':
      return 'bash';
    case 'Read':
      return 'fileRead';
    case 'Write':
      return 'fileWrite';
    case 'Edit':
    case 'MultiEdit':
      return 'fileEdit';
    case 'NotebookEdit':
      return 'notebookEdit';
    case 'Grep':
      return 'grep';
    case 'Glob':
      return 'glob';
    case 'WebFetch':
      return 'webFetch';
    case 'WebSearch':
      return 'webSearch';
    case 'Task':
    case 'Agent':
      return 'subagent';
    case 'TodoWrite':
      return 'todoWrite';
    case 'TaskCreate':
    case 'TaskUpdate':
    case 'TaskGet':
    case 'TaskList':
    case 'TaskStop':
      return 'task';
    case 'AskUserQuestion':
      return 'askUserQuestion';
    case 'ExitPlanMode':
      return 'exitPlanMode';
    case 'EnterPlanMode':
      return 'enterPlanMode';
    case 'Skill':
      return 'skill';
    case 'Monitor':
      return 'monitor';
    case 'CronCreate':
    case 'CronDelete':
    case 'CronList':
    case 'ScheduleWakeup':
      return 'schedule';
    case 'EnterWorktree':
    case 'ExitWorktree':
      return 'worktree';
    default:
      return 'other';
  }
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content))
    return content
      .map((b: AnyMsg) => (b?.type === 'text' ? b.text : b?.type === 'image' ? '[image]' : b?.type === 'document' ? '[document]' : ''))
      .filter(Boolean)
      .join('\n');
  return '';
}

export function userContentToInputs(content: unknown): UserInput[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [];
  const out: UserInput[] = [];
  for (const b of content as AnyMsg[]) {
    if (b?.type === 'text') out.push({ type: 'text', text: b.text });
    else if (b?.type === 'image' && b.source?.type === 'base64')
      out.push({ type: 'image', mediaType: b.source.media_type, data: b.source.data });
    else if (b?.type === 'document' && b.source?.media_type === 'application/pdf')
      // Named, not carried: a PDF's bytes would make every history read as large as the file.
      out.push({ type: 'document', mediaType: 'application/pdf', ...(b.title ? { name: b.title } : {}) });
  }
  return out;
}

type StreamBlock = { index: number; blockType: string; itemId: string; consumed: boolean };

/**
 * Pure SDKMessage → Tether item/turn reducer. Used for both live streams and
 * transcript history, so the client sees one shape regardless of source.
 */
export class Itemizer {
  readonly items = new Map<string, Item>();
  readonly order: string[] = [];
  readonly turns: Turn[] = [];
  private turn: Turn | null = null;
  private streams = new Map<string, StreamBlock[]>();
  private blockCounters = new Map<string, number>();
  private currentStreamMsgId = new Map<string | null, string>();
  private toolItems = new Map<string, ToolCallItem>();
  private echoUuids = new Set<string>();
  private denied = new Map<string, string>();
  private interruptRequested = false;
  private fallbackCounter = 0;
  /** Background tasks already reported, since a notification can arrive as an event and a message. */
  private notifiedTasks = new Set<string>();
  /** The CLI's current background task ids, and which tool call started each task. */
  private backgroundTaskIds = new Set<string>();
  private taskTools = new Map<string, string>();
  /** Each task's `task_type` (local_bash, local_agent, local_workflow, …), from its start. */
  private taskTypes = new Map<string, string>();
  /** Each dynamic workflow's phases and agents, merged from its progress events, by task id. */
  private workflows = new Map<string, WorkflowSnapshot>();
  /** Which Workflow call each workflow agent works for, from the snapshots' agents. */
  private workflowAgents = new Map<string, string>();
  /** Which Workflow call launched each run, from its launch's `Run ID`. */
  private workflowRuns = new Map<string, string>();
  /**
   * Tasks a subagent started (`owned_by_subagent` on their start), by task id, with the Workflow
   * call and agent that started each, as far as known: a workflow agent's own background command
   * belongs under that agent, never in the chat.
   */
  private ownedTasks = new Map<string, { workflowToolUseId?: string; workflowAgentId?: string }>();
  /**
   * In history mode, whether the open turn's last reply ended it (a stop reason other than
   * `tool_use`): a transcript has no result messages, so this is how history knows a turn is over.
   */
  private replyEnded = false;
  /**
   * Live, a workflow's finish whose event came while a turn ran, by item id: the CLI hands the
   * model its `<task-notification>` at the turn's next step (written as a `queued_command`
   * attachment after the tool result it follows), so it is said there, or after the turn if the
   * turn ends first.
   */
  private pendingFinishes = new Map<string, { taskId?: string; toolUseId?: string; status?: string; summary?: string }>();
  /** In history mode, the message being read's time, and the last one read's. */
  private messageTime?: number;
  private lastMessageTime?: number;
  /**
   * The /goal being worked toward, by its condition: from its set until it's met, failed or
   * cleared. While there is one, its Stop hook's feedback to the model isn't a message of the chat.
   */
  private activeGoal?: string;
  /** The last turn to end: a goal's check is written just after the reply that ends it. */
  private lastTurnId: string | null = null;

  // ---- tasks (see `tasks()`) ----
  /** What the CLI said of each task, by its task id, in the order each was first heard of. */
  private facts = new Map<string, TaskFacts>();
  /** The task each call started, the newest when more than one. */
  private factsByCall = new Map<string, TaskFacts>();
  /** The calls that are tasks of their own (`isTaskCall`), in order. */
  private taskCalls = new Set<string>();
  /** The items that tell of scheduled work (`concernsSchedules`), in order. */
  private scheduleItems = new Set<string>();
  /** Such items from before this itemizer's first, for a live thread that resumed a session. */
  private seedItems: Item[] = [];
  /** What the session's Stop hook last said will wake it; undefined when not run here. */
  private sessionCrons?: SessionCron[];
  /** The CLI process has ended: none of its tasks goes on. */
  private processEnded = false;
  /** Something a task's state is made from changed since the states were last sent. */
  private tasksDirty = false;
  /** Each turn's edits, by call id. */
  private editsByTurn = new Map<string, Map<string, FileEdit>>();
  /** The messages taken as skills' instructions, by message id, and whose. */
  private skillMessages = new Map<string, string>();
  /** The latest item of the chat (null) and of each subagent, for what follows it. */
  private lastItemOf = new Map<string | null, string>();
  /** Each task's state as last sent, as JSON. */
  private sentTasks = new Map<string, string>();
  /** Workflow agents' whole prompts, once read, by run and agent id; and when one was last looked for in vain. */
  private agentPrompts = new Map<string, string>();
  private agentPromptMisses = new Map<string, number>();

  /**
   * Which workflow run an agent id belongs to, from the session's directory on disk: for a peer
   * message from an agent of a run this itemizer has no snapshot of (history, or a run whose agents
   * the CLI hasn't reported yet).
   */
  locateWorkflowAgent?: (agentId: string) => string | undefined;

  /**
   * Which agent of these runs made the tool call `toolUseId`, from the agents' transcripts on disk:
   * for a task a workflow's agent started, whose call never reaches the stream.
   */
  locateWorkflowCall?: (toolUseId: string, runIds: string[]) => { runId: string; agentId: string } | undefined;

  /** A finished run's result as text, from its run record on disk (`workflows/<runId>.json`). */
  readRunResult?: (runId: string) => string | undefined;

  /** A workflow agent's whole prompt from its transcript on disk, for one whose preview was cut. */
  readAgentPrompt?: (runId: string, agentId: string) => string | undefined;

  /**
   * @param historyMode transcripts have no `result` messages, so a new real user prompt closes the open turn.
   */
  constructor(
    private now: () => number = Date.now,
    private historyMode = false,
  ) {}

  get currentTurn(): Turn | null {
    return this.turn;
  }

  /** Called when Tether itself sends a user message, so the echo from the CLI is not duplicated. */
  noteSentUserMessage(uuid: string) {
    this.echoUuids.add(uuid);
  }

  noteDenied(toolUseId: string, message: string) {
    this.denied.set(toolUseId, message);
  }

  noteInterruptRequested() {
    this.interruptRequested = true;
  }

  /** Start a turn for user input Tether sent (live mode). Returns emissions for turn + user item. */
  beginUserTurn(messageId: string, content: UserInput[], queued: boolean): { turnId: string; out: Emission[] } {
    const out: Emission[] = [];
    if (!this.turn) out.push(...this.startTurn(messageId));
    const item: Item = {
      type: 'userMessage',
      id: messageId,
      turnId: this.turn!.id,
      parentToolUseId: null,
      createdAt: this.stamp(),
      content,
      ...(queued ? { queued: true } : {}),
    };
    out.push(...this.addCompleted(item));
    return { turnId: this.turn!.id, out: this.withTasks(out) };
  }

  ingest(msg: AnyMsg): Emission[] {
    if (!this.historyMode) return this.withTasks(this.route(msg));
    return this.withTasks(this.at(msg.timestamp, () => this.route(msg)));
  }

  /** Whether a /goal is being worked toward, so its checks are worth looking for. */
  get goalActive(): boolean {
    return this.activeGoal !== undefined;
  }

  /** Runs `f` as of `timestamp`, when the record says when it was written. */
  private at<T>(timestamp: unknown, f: () => T): T {
    const t = typeof timestamp === 'string' ? Date.parse(timestamp) : NaN;
    this.messageTime = Number.isFinite(t) ? t : undefined;
    try {
      return f();
    } finally {
      if (this.messageTime !== undefined && this.historyMode) this.lastMessageTime = this.messageTime;
      this.messageTime = undefined;
    }
  }

  /**
   * What only the raw transcript holds, which getSessionMessages drops and the SDK stream never
   * carries (`TranscriptExtras` reads it, in history after the message it follows, live as it is
   * written): a scheduled job's prompt (`wakeup`), a /goal's checks (`goal_status`) and its set
   * (the `local_command` record), and a workflow's mid-turn `<task-notification>` (`ingestQueued`).
   */
  ingestExtra(record: AnyMsg): Emission[] {
    return this.withTasks(this.extra(record));
  }

  private extra(record: AnyMsg): Emission[] {
    if (record.type === 'attachment') {
      const a = record.attachment;
      if (a?.type === 'queued_command') return this.ingestQueued(record);
      if (a?.type === 'goal_status') return this.at(record.timestamp, () => this.goalStatus(record.uuid, a));
      return [];
    }
    if (record.type === 'user' && typeof record.sourceToolUseID === 'string') return this.skillInstructions(record.sourceToolUseID, record);
    if (record.type === 'user' && isWakeup(record)) return this.at(record.timestamp, () => this.wakeup(record));
    if (record.type === 'system' && record.subtype === 'local_command') return this.at(record.timestamp, () => this.onSystem(record));
    return [];
  }

  /**
   * A `<task-notification>` the CLI queued mid-turn and handed the model at the turn's next step:
   * written to the transcript as an `attachment` (`queued_command`) after the message it followed,
   * which getSessionMessages drops, so history reads it from the file (`TranscriptExtras`).
   * Only a workflow's is read, for its finish to land where it did live.
   */
  ingestQueued(record: AnyMsg): Emission[] {
    const prompt = record.attachment?.prompt;
    const n = typeof prompt === 'string' ? parseTaskNotification(prompt) : undefined;
    if (!n || !this.isWorkflowTask(n.taskId, n.toolUseId)) return [];
    return this.ingest({
      type: 'user',
      uuid: record.uuid,
      ...(typeof record.timestamp === 'string' ? { timestamp: record.timestamp } : {}),
      message: { role: 'user', content: prompt },
      parent_tool_use_id: null,
    });
  }

  /**
   * When an item or turn happened: now, for a live stream; for history, the time its message was
   * written, since read time would date everything to the moment the transcript was opened.
   */
  private stamp(): number {
    return this.messageTime ?? this.now();
  }

  /** When a turn read from history ended: with the last message before whatever closes it. */
  private endStamp(): number {
    return this.historyMode ? (this.lastMessageTime ?? this.messageTime ?? this.now()) : this.now();
  }

  /** A dynamic workflow's snapshot by its run id, while this itemizer has one. */
  workflowByRun(runId: string): WorkflowSnapshot | undefined {
    for (const w of this.workflows.values()) if (w.runId === runId) return structuredClone(w);
    return undefined;
  }

  private route(msg: AnyMsg): Emission[] {
    switch (msg.type) {
      case 'stream_event':
        return this.onStreamEvent(msg);
      case 'assistant':
        return this.onAssistant(msg);
      case 'user':
        return this.onUser(msg);
      case 'result':
        return this.onResult(msg);
      case 'system':
        return this.onSystem(msg);
      case 'tool_progress': {
        const t = this.toolItems.get(msg.tool_use_id);
        if (t) t.elapsedSeconds = msg.elapsed_time_seconds;
        return [
          {
            method: 'item/toolCall/progress',
            body: {
              itemId: msg.tool_use_id,
              elapsedSeconds: msg.elapsed_time_seconds,
              ...(msg.task_id ? { taskId: msg.task_id } : {}),
            },
          },
        ];
      }
      case 'tool_use_summary': {
        const out: Emission[] = [];
        for (const id of msg.preceding_tool_use_ids ?? []) {
          const t = this.toolItems.get(id);
          if (!t) continue;
          t.summary = msg.summary;
          out.push(...this.itemEvent('item/updated', t));
        }
        return out;
      }
      case 'command_lifecycle':
        return this.onCommandLifecycle(msg);
      case 'prompt_suggestion':
        return [{ method: 'thread/promptSuggestion', body: { suggestion: msg.suggestion } }];
      case 'rate_limit_event':
        return [{ method: 'thread/rateLimit', body: { info: msg.rate_limit_info } }];
      case 'auth_status':
        return [
          {
            method: 'thread/authStatus',
            body: {
              isAuthenticating: !!msg.isAuthenticating,
              output: msg.output ?? [],
              ...(msg.error ? { error: msg.error } : {}),
            },
          },
        ];
      default:
        return [this.raw(msg)];
    }
  }

  private raw(msg: AnyMsg): Emission {
    return {
      method: 'thread/rawEvent',
      body: { sdkType: String(msg.type), ...(msg.subtype ? { sdkSubtype: String(msg.subtype) } : {}), message: msg },
    };
  }

  private notice(msg: AnyMsg, kind: string, text: string, level?: 'info' | 'warning' | 'error'): Emission[] {
    return this.addCompleted({
      type: 'notice',
      id: msg.uuid ?? `notice_${++this.fallbackCounter}`,
      turnId: this.turn?.id ?? null,
      parentToolUseId: null,
      createdAt: this.stamp(),
      kind,
      text,
      ...(level ? { level } : {}),
    });
  }

  private onSystem(msg: AnyMsg): Emission[] {
    switch (msg.subtype) {
      // Handled by LiveThread (thread metadata), not transcript content.
      case 'init':
      case 'status':
      case 'session_state_changed':
      case 'thinking_tokens':
        return [];
      case 'compact_boundary': {
        const md = msg.compact_metadata ?? {};
        return this.addCompleted({
          type: 'compaction',
          id: msg.uuid ?? `compact_${++this.fallbackCounter}`,
          turnId: this.turn?.id ?? null,
          parentToolUseId: null,
          createdAt: this.stamp(),
          ...(md.trigger ? { trigger: md.trigger } : {}),
          ...(md.pre_tokens !== undefined ? { preTokens: md.pre_tokens } : {}),
          ...(md.post_tokens !== undefined ? { postTokens: md.post_tokens } : {}),
        });
      }
      case 'local_command_output':
        return this.localCommand(msg, typeof msg.content === 'string' ? msg.content : '');
      // A local command's record, as the transcript keeps it: only a /goal's is the chat's (a
      // prompt's own output comes as a `<local-command-stdout>` message).
      case 'local_command': {
        const goal = msg.commandRun?.command === 'goal' && typeof msg.content === 'string' ? goalFromCommandOutput(msg.content) : undefined;
        return goal ? this.goalNotice(msg.uuid, goal) : [this.raw(msg)];
      }
      case 'informational':
        return this.notice(msg, 'informational', msg.content ?? '', msg.level === 'warning' ? 'warning' : 'info');
      case 'model_refusal_fallback':
        return this.notice(msg, 'modelFallback', msg.content ?? `Switched to ${msg.fallback_model}`, 'warning');
      case 'permission_denied': {
        if (msg.tool_use_id) this.denied.set(msg.tool_use_id, msg.message ?? 'denied');
        return [this.raw(msg)];
      }
      case 'api_retry':
        return [
          {
            method: 'thread/apiRetry',
            body: {
              attempt: msg.attempt,
              maxRetries: msg.max_retries,
              retryDelayMs: msg.retry_delay_ms,
              errorStatus: msg.error_status ?? null,
              ...(msg.error ? { error: String(msg.error) } : {}),
            },
          },
        ];
      case 'task_notification': {
        const workflow = this.isWorkflowTask(msg.task_id, msg.tool_use_id);
        const events = [...this.taskEvent(msg), ...this.settleTask(msg.tool_use_id, msg.status)];
        // A subagent's own task is the subagent's business: its call never reaches the chat.
        if (this.ownedTasks.has(msg.task_id) || !this.worthANotice(msg)) return events;
        if (workflow)
          return [...events, ...this.workflowFinished({ taskId: msg.task_id, toolUseId: msg.tool_use_id, status: msg.status, summary: msg.summary }, 'event')];
        if (reportFollows(msg.summary, msg.result)) return [...events, ...this.reportComing(msg.task_id)];
        return [...events, ...this.taskNotice(msg.task_id, msg.status, msg.summary, msg.uuid)];
      }
      case 'task_started':
      case 'task_progress':
      case 'task_updated': {
        if (msg.task_id && msg.tool_use_id) this.taskTools.set(msg.task_id, msg.tool_use_id);
        const events = this.taskEvent(msg);
        // A workflow stopped may say so only here: the CLI hands the model no message for it.
        const stopped = msg.subtype === 'task_updated' && workflowStatus(msg.patch?.status) === 'stopped';
        if (!stopped || !this.isWorkflowTask(msg.task_id, msg.tool_use_id)) return events;
        return [...events, ...this.workflowFinished({ taskId: msg.task_id, status: msg.patch.status }, 'event')];
      }
      case 'background_tasks_changed':
        if (Array.isArray(msg.tasks)) this.backgroundTaskIds = new Set(msg.tasks.map((t: AnyMsg) => String(t.task_id)));
        this.tasksDirty = true;
        return [];
      case 'commands_changed':
        return [{ method: 'thread/commandsChanged', body: {} }];
      case 'notification':
        return [{ method: 'thread/notification', body: { message: msg.text ?? '', priority: msg.priority } }];
      case 'hook_started':
      case 'hook_progress':
      case 'hook_response':
        return [{ method: 'thread/hook', body: { event: msg.subtype, data: msg } }];
      default:
        return [this.raw(msg)];
    }
  }

  /**
   * What a task event says, kept as the task's facts (`tasks()` makes its state of them). A
   * workflow's progress goes into its snapshot; its progress's description names its latest agent,
   * which is the snapshot's activity, never the task's description.
   */
  private taskEvent(msg: AnyMsg): Emission[] {
    const taskId: string = msg.task_id;
    if (typeof taskId !== 'string' || !taskId) return [];
    if (msg.subtype === 'task_started' && typeof msg.task_type === 'string') this.taskTypes.set(taskId, msg.task_type);
    if (msg.subtype === 'task_started' && msg.owned_by_subagent === true && !this.ownedTasks.has(taskId)) this.ownedTasks.set(taskId, {});
    this.ownerOf(taskId, msg.tool_use_id ?? this.taskTools.get(taskId));
    const workflow = this.isWorkflowTask(taskId, msg.tool_use_id) || Array.isArray(msg.workflow_progress);
    if (workflow) this.trackWorkflow(msg);
    const f = this.factsOf(taskId, msg.tool_use_id);
    switch (msg.subtype) {
      case 'task_started':
        if (typeof msg.task_type === 'string') f.type = msg.task_type;
        if (typeof msg.description === 'string' && msg.description) f.description = msg.description;
        if (typeof msg.workflow_name === 'string' && msg.workflow_name) f.workflowName = msg.workflow_name;
        f.startedAt ??= this.stamp();
        if (!isTerminal(taskStatusOf(f.status))) f.status = 'running';
        break;
      case 'task_progress':
        if (typeof msg.summary === 'string' && msg.summary) f.summary = msg.summary;
        if (!f.status) f.status = 'running';
        break;
      case 'task_updated': {
        const patch = msg.patch ?? {};
        if (typeof patch.status === 'string') f.status = patch.status;
        if (typeof patch.description === 'string' && patch.description && !workflow) f.description = patch.description;
        if (typeof patch.is_backgrounded === 'boolean') f.backgrounded = patch.is_backgrounded;
        if (typeof patch.end_time === 'number') f.endedAt = patch.end_time;
        const error = failureOf(patch.error, undefined);
        if (error) f.error = error;
        break;
      }
      case 'task_notification': {
        if (typeof msg.status === 'string') f.status = msg.status;
        if (typeof msg.summary === 'string' && msg.summary) f.summary = msg.summary;
        if (typeof msg.output_file === 'string' && msg.output_file) f.outputFile = msg.output_file;
        f.endedAt ??= this.stamp();
        const error = failureOf(msg.error, msg.status === 'failed' ? msg.summary : undefined);
        if (error && msg.status === 'failed') f.error = error;
        break;
      }
    }
    const usage = usageOf(msg.usage);
    if (usage) f.usage = { ...f.usage, ...usage };
    this.tasksDirty = true;
    return [];
  }

  /** A task's facts, made the first time it's heard of, with the call that started it once known. */
  private factsOf(taskId: string, toolUseId?: string): TaskFacts {
    let f = this.facts.get(taskId);
    if (!f) this.facts.set(taskId, (f = { taskId }));
    const call = toolUseId ?? this.taskTools.get(taskId);
    if (call && !f.toolUseId) f.toolUseId = call;
    if (f.toolUseId) this.factsByCall.set(f.toolUseId, f);
    return f;
  }

  /** A `<task-notification>` message's facts: how a task ended, which is all history has of it. */
  private noteNotification(n: { taskId?: string; toolUseId?: string; status?: string; summary?: string; outputFile?: string }) {
    if (!n.taskId) return;
    const f = this.factsOf(n.taskId, n.toolUseId);
    // Live, the event said it first; the message the CLI hands the model after only fills in.
    const settled = isTerminal(taskStatusOf(f.status));
    if (n.status && !settled) f.status = n.status;
    if (n.summary && !(settled && f.summary)) f.summary = n.summary;
    if (n.outputFile) f.outputFile ??= n.outputFile;
    f.endedAt ??= this.stamp();
    if (n.status === 'failed') {
      const error = failureOf(undefined, n.summary);
      if (error) f.error = error;
    }
    this.tasksDirty = true;
  }

  /**
   * Who started a subagent's own task, worked out again on each of its events until known. A call
   * this itemizer has (a subagent's, streamed) already places the task under its subagent. Else
   * it is a workflow agent's: the agent whose transcript holds the call, among the running
   * workflows' (the call is written before the task starts, but may not be on disk yet), else the
   * workflow that is running, the latest if more than one.
   */
  private ownerOf(taskId: string, toolUseId: string | undefined): { workflowToolUseId?: string; workflowAgentId?: string } | undefined {
    const owner = this.ownedTasks.get(taskId);
    if (!owner || owner.workflowAgentId || (toolUseId && this.toolItems.has(toolUseId))) return owner;
    const running = [...this.workflows.entries()].filter(([, w]) => w.status === 'running');
    const runIds = running.flatMap(([, w]) => (w.runId ? [w.runId] : []));
    const found = toolUseId && runIds.length ? this.locateWorkflowCall?.(toolUseId, runIds) : undefined;
    const call = found ? this.workflowRuns.get(found.runId) : undefined;
    if (found && call) {
      owner.workflowToolUseId = call;
      owner.workflowAgentId = found.agentId;
    } else if (!owner.workflowToolUseId) {
      const latest = running.at(-1);
      const latestCall = latest ? this.taskTools.get(latest[0]) : undefined;
      if (latestCall) owner.workflowToolUseId = latestCall;
    }
    return owner;
  }

  /** Whether a task is a dynamic workflow: by its type, else by the call that started it. */
  private isWorkflowTask(taskId: string | undefined, toolUseId?: string): boolean {
    const type = taskId ? this.taskTypes.get(taskId) : undefined;
    if (type) return type === 'local_workflow';
    const callId = toolUseId ?? (taskId ? this.taskTools.get(taskId) : undefined);
    return !!callId && this.toolItems.get(callId)?.name === 'Workflow';
  }

  /**
   * A workflow's snapshot with what this event says merged in: the agents come on some progress
   * events only (at most every few seconds), so the snapshot is held between. A settled run
   * settles the agents it last heard of (`settleAgents`).
   */
  private trackWorkflow(msg: AnyMsg) {
    const taskId: string = msg.task_id;
    const callId: string | undefined = msg.tool_use_id ?? this.taskTools.get(taskId);
    const call = callId ? this.toolItems.get(callId) : undefined;
    let w: WorkflowSnapshot = this.workflows.get(taskId) ?? { phases: scriptMeta((call?.input as AnyMsg)?.script).phases, agents: [] };
    const runId = call ? launchRunId(call.output, call.outputText) : undefined;
    if (runId && !w.runId) w.runId = runId;
    if (!w.name) {
      const name = msg.workflow_name ?? workflowCallName(call?.input);
      if (typeof name === 'string' && name) w.name = name;
    }
    switch (msg.subtype) {
      case 'task_started':
        if (typeof msg.description === 'string' && msg.description) w.description = msg.description;
        w.status = 'running';
        break;
      case 'task_progress':
        if (typeof msg.description === 'string' && msg.description && msg.description !== w.description) w.activity = msg.description;
        break;
      case 'task_updated': {
        const status = workflowStatus(msg.patch?.status);
        if (status) w.status = status;
        break;
      }
      case 'task_notification':
        w.status = workflowStatus(msg.status) ?? 'completed';
        break;
    }
    const error = failureOf(msg.patch?.error ?? msg.error, msg.subtype === 'task_notification' && w.status === 'failed' ? msg.summary : undefined);
    if (error) w.error = error;
    const u = msg.usage;
    if (u && typeof u === 'object') {
      if (typeof u.total_tokens === 'number') w.totalTokens = u.total_tokens;
      if (typeof u.tool_uses === 'number') w.toolUses = u.tool_uses;
      if (typeof u.duration_ms === 'number') w.durationMs = u.duration_ms;
    }
    if (Array.isArray(msg.workflow_progress)) w = mergeWorkflowProgress(w, msg.workflow_progress);
    w = settleAgents(w);
    if (!w.description && call?.input) {
      const d = scriptMeta((call.input as AnyMsg).script).description;
      if (d) w.description = d;
    }
    this.workflows.set(taskId, w);
    if (callId) for (const a of w.agents) if (a.agentId) this.workflowAgents.set(a.agentId, callId);
    this.tasksDirty = true;
  }

  /**
   * A finished background task, as a line in the transcript. The CLI reports one both as an event
   * and as a `<task-notification>` message it hands the model; history has only the message.
   */
  private taskNotice(taskId: string | undefined, status: string | undefined, summary: string | undefined, id?: string): Emission[] {
    if (taskId) {
      if (this.notifiedTasks.has(taskId)) return [];
      this.notifiedTasks.add(taskId);
    }
    return this.addCompleted({
      type: 'notice',
      id: id ?? `task_${taskId ?? ++this.fallbackCounter}_notification`,
      turnId: this.turn?.id ?? null,
      parentToolUseId: null,
      createdAt: this.stamp(),
      kind: 'taskNotification',
      text: this.noticeText(taskId, status, summary),
      ...(status === 'failed' ? { level: 'warning' as const } : {}),
    });
  }

  /**
   * A background agent whose report the CLI hands back as a message of its own: that message is
   * its line, so the task gets no notice. The CLI says so before the message comes (the
   * notification's result or summary), so the notice can't wait to be dropped when it arrives.
   */
  private reportComing(taskId: string | undefined): Emission[] {
    if (taskId) this.notifiedTasks.add(taskId);
    return [];
  }

  /**
   * What a settled task says: its summary (never the CLI's note that a report was delivered as a
   * message, which gets no notice), else the agent's own line.
   */
  private noticeText(taskId: string | undefined, status: string | undefined, summary: string | undefined): string {
    if (summary) return summary;
    const call = taskId ? this.toolItems.get(this.taskTools.get(taskId) ?? '') : undefined;
    const description = (call?.input as AnyMsg)?.description;
    const verb = status === 'failed' ? 'failed' : status === 'killed' || status === 'stopped' ? 'stopped' : 'finished';
    if (call?.kind === 'subagent' && typeof description === 'string') return `Agent "${description}" ${verb}`;
    return `Background task ${status ?? 'finished'}`;
  }

  /** A stopped or failed background agent leaves its own tool calls unfinished; close them. */
  private settleTask(toolUseId: string | undefined, status: string | undefined): Emission[] {
    if (!toolUseId) return [];
    const out: Emission[] = [];
    for (const t of this.toolItems.values()) {
      if ((t.status === 'running' || t.status === 'pending') && t.id !== toolUseId && this.descendsFrom(t, toolUseId)) {
        t.status = status === 'completed' ? 'completed' : 'interrupted';
        out.push(...this.addCompleted(t));
      }
    }
    return out;
  }

  /**
   * Only work that went on in the background gets a line of its own. A foreground command is a
   * task too, but its tool call is still open and reports the result itself; a subagent's own
   * background command reaches the transcript through the subagent.
   */
  private worthANotice(msg: AnyMsg): boolean {
    if (msg.skip_transcript || msg.ambient) return false;
    const call = msg.tool_use_id ? this.toolItems.get(msg.tool_use_id) : undefined;
    if (!call) return true;
    return !call.parentToolUseId && call.status !== 'running' && call.status !== 'pending';
  }

  private descendsFrom(t: ToolCallItem, ancestorId: string): boolean {
    for (let p = t.parentToolUseId; p; p = this.toolItems.get(p)?.parentToolUseId ?? null) if (p === ancestorId) return true;
    return false;
  }

  /**
   * Whether a tool call still running when its turn ends was cut short. One inside a subagent the
   * turn sent to the background was not: its launcher already returned, and it keeps working.
   */
  private endsWithTurn(t: ToolCallItem): boolean {
    for (let p = t.parentToolUseId; p; ) {
      if (this.isBackgrounded(p)) return false;
      const launcher = this.toolItems.get(p);
      if (!launcher) return true;
      p = launcher.parentToolUseId;
    }
    return true;
  }

  /** Whether the task a tool call started is in the CLI's background set (the two can arrive in either order). */
  private isBackgrounded(toolUseId: string): boolean {
    for (const id of this.backgroundTaskIds) if (this.taskTools.get(id) === toolUseId) return true;
    return false;
  }

  /** Tool calls a turn ending leaves unfinished. Collected first: closing a launcher changes its children's answer. */
  private cutShort(turnId: string): ToolCallItem[] {
    return [...this.toolItems.values()].filter(
      (t) => t.turnId === turnId && (t.status === 'running' || t.status === 'pending') && this.endsWithTurn(t),
    );
  }

  /**
   * The turn a message belongs to. A subagent's belongs to the turn that launched it — a background
   * one keeps writing after that turn has ended, and must not open a turn of its own.
   */
  private turnFor(parent: string | null, hintId: string): { out: Emission[]; turnId: string } {
    const launcher = parent ? this.toolItems.get(parent) : undefined;
    if (launcher?.turnId) return { out: [], turnId: launcher.turnId };
    const out = this.ensureTurn(hintId);
    return { out, turnId: this.turn!.id };
  }

  // ---- turns ----

  private startTurn(id: string): Emission[] {
    this.tasksDirty = true;
    this.interruptRequested = false;
    this.replyEnded = false;
    this.turn = { id, status: 'inProgress', startedAt: this.stamp() };
    this.turns.push(this.turn);
    return [{ method: 'turn/started', body: { turn: { ...this.turn } } }];
  }

  private ensureTurn(hintId: string): Emission[] {
    return this.turn ? [] : this.startTurn(`turn_${hintId}`);
  }

  // ---- items ----

  private upsert(item: Item) {
    if (!this.items.has(item.id)) {
      this.order.push(item.id);
      this.lastItemOf.set(item.parentToolUseId, item.id);
    }
    this.items.set(item.id, item);
    if (item.type === 'toolCall' && isTaskCall(item)) this.taskCalls.add(item.id);
    if (concernsSchedules(item)) this.scheduleItems.add(item.id);
    if (this.taskCalls.has(item.id) || this.scheduleItems.has(item.id) || this.factsByCall.has(item.id)) this.tasksDirty = true;
  }

  private addStarted(item: Item): Emission[] {
    this.upsert(item);
    return this.itemEvent('item/started', item);
  }

  private addCompleted(item: Item): Emission[] {
    const isNew = !this.items.has(item.id);
    this.upsert(item);
    if (this.quiet) return [];
    // One copy for both: an emission's body is never changed, and the item goes on changing.
    const copy = structuredClone(item);
    const completed: Emission = { method: 'item/completed', body: { item: copy } };
    return isNew ? [{ method: 'item/started', body: { item: copy } }, completed] : [completed];
  }

  /** An item's event, with a copy of it as it is now; none while `quiet`. */
  private itemEvent(method: 'item/started' | 'item/updated', item: Item): Emission[] {
    return this.quiet ? [] : [{ method, body: { item: structuredClone(item) } }];
  }

  /** A turn's event, likewise. */
  private turnEvent(method: 'turn/completed' | 'turn/updated', turn: Turn): Emission[] {
    return this.quiet ? [] : [{ method, body: { turn: structuredClone(turn) } }];
  }

  private nextBlockId(msgId: string): string {
    const n = this.blockCounters.get(msgId) ?? 0;
    this.blockCounters.set(msgId, n + 1);
    return `${msgId}:${n}`;
  }

  // ---- stream events (partial messages) ----

  private onStreamEvent(msg: AnyMsg): Emission[] {
    const ev = msg.event ?? {};
    const parent: string | null = msg.parent_tool_use_id ?? null;
    const out: Emission[] = [];
    switch (ev.type) {
      case 'message_start': {
        if (parent === null) out.push(...this.flushFinishes());
        const id = ev.message?.id ?? `msg_${++this.fallbackCounter}`;
        this.currentStreamMsgId.set(parent, id);
        if (!this.streams.has(id)) this.streams.set(id, []);
        break;
      }
      case 'content_block_start': {
        const msgId = this.currentStreamMsgId.get(parent);
        if (!msgId) break;
        const cb = ev.content_block ?? {};
        const placed = this.turnFor(parent, msgId);
        out.push(...placed.out);
        const turnId = placed.turnId;
        const createdAt = this.stamp();
        let item: Item | null = null;
        if (cb.type === 'text') {
          item = { type: 'agentMessage', id: this.nextBlockId(msgId), turnId, parentToolUseId: parent, createdAt, text: '' };
        } else if (cb.type === 'thinking' || cb.type === 'redacted_thinking') {
          item = { type: 'reasoning', id: this.nextBlockId(msgId), turnId, parentToolUseId: parent, createdAt, text: '' };
        } else if (cb.type === 'tool_use' || cb.type === 'server_tool_use' || cb.type === 'mcp_tool_use') {
          const t: ToolCallItem = {
            type: 'toolCall',
            id: cb.id,
            turnId,
            parentToolUseId: parent,
            createdAt,
            name: cb.name,
            kind: toolKind(cb.name),
            input: {},
            status: 'pending',
          };
          this.toolItems.set(cb.id, t);
          item = t;
        }
        if (item) {
          this.streams.get(msgId)!.push({ index: ev.index, blockType: cb.type, itemId: item.id, consumed: false });
          out.push(...this.addStarted(item));
        }
        break;
      }
      case 'content_block_delta': {
        const msgId = this.currentStreamMsgId.get(parent);
        const block = msgId && this.streams.get(msgId)?.find((b) => b.index === ev.index);
        if (!block) break;
        const item = this.items.get(block.itemId);
        const d = ev.delta ?? {};
        if (d.type === 'text_delta' && item?.type === 'agentMessage') {
          item.text += d.text;
          out.push({ method: 'item/agentMessage/delta', body: { itemId: item.id, delta: d.text } });
        } else if (d.type === 'thinking_delta' && item?.type === 'reasoning') {
          item.text += d.thinking;
          out.push({ method: 'item/reasoning/delta', body: { itemId: item.id, delta: d.thinking } });
        } else if (d.type === 'input_json_delta' && item?.type === 'toolCall') {
          out.push({ method: 'item/toolCall/inputDelta', body: { itemId: item.id, partialJson: d.partial_json } });
        }
        break;
      }
    }
    return out;
  }

  private claimStreamBlock(msgId: string, blockType: string, toolId?: string): string | undefined {
    const blocks = this.streams.get(msgId);
    if (!blocks) return;
    const b = blocks.find(
      (b) => !b.consumed && (toolId ? b.itemId === toolId : b.blockType === blockType || (blockType === 'thinking' && b.blockType === 'redacted_thinking')),
    );
    if (!b) return;
    b.consumed = true;
    return b.itemId;
  }

  // ---- complete assistant messages ----

  private onAssistant(msg: AnyMsg): Emission[] {
    const m = msg.message ?? {};
    const msgId: string = m.id ?? msg.uuid ?? `msg_${++this.fallbackCounter}`;
    const parent: string | null = msg.parent_tool_use_id ?? null;
    const out: Emission[] = parent === null && !this.streams.has(msgId) ? this.flushFinishes() : [];
    const placed = this.turnFor(parent, msgId);
    out.push(...placed.out);
    const turnId = placed.turnId;
    // A local command's output, which the CLI sends as a reply of its own (`<synthetic>`): a /goal's
    // set or clear is the goal's line, not a reply.
    const command = msg.local_command_run?.command;
    if (parent === null && (command === 'goal' || (command === undefined && m.model === '<synthetic>'))) {
      const goal = goalFromCommandOutput(contentToText(m.content));
      if (goal) return [...out, ...this.goalNotice(msg.uuid ?? msgId, goal)];
    }
    if (this.historyMode && parent === null && typeof m.stop_reason === 'string') this.replyEnded = m.stop_reason !== 'tool_use';
    if (msg.error) {
      out.push(
        ...this.addCompleted({
          type: 'error',
          id: `${msgId}:error`,
          turnId,
          parentToolUseId: parent,
          createdAt: this.stamp(),
          message: contentToText(m.content) || String(msg.error),
          code: String(msg.error),
        }),
      );
      return out;
    }
    for (const block of (m.content ?? []) as AnyMsg[]) {
      if (block.type === 'text') {
        const id = this.claimStreamBlock(msgId, 'text') ?? this.nextBlockId(msgId);
        const prev = this.items.get(id);
        out.push(
          ...this.addCompleted({
            type: 'agentMessage',
            id,
            turnId: prev?.turnId ?? turnId,
            parentToolUseId: parent,
            createdAt: prev?.createdAt ?? this.stamp(),
            text: block.text ?? '',
            model: m.model,
          }),
        );
      } else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
        const id = this.claimStreamBlock(msgId, 'thinking') ?? this.nextBlockId(msgId);
        const prev = this.items.get(id);
        const text: string = block.thinking ?? '';
        out.push(
          ...this.addCompleted({
            type: 'reasoning',
            id,
            turnId: prev?.turnId ?? turnId,
            parentToolUseId: parent,
            createdAt: prev?.createdAt ?? this.stamp(),
            text,
            ...(text ? {} : { redacted: true }),
          }),
        );
      } else if (block.type === 'tool_use' || block.type === 'server_tool_use' || block.type === 'mcp_tool_use') {
        this.claimStreamBlock(msgId, block.type, block.id);
        const prev = this.toolItems.get(block.id);
        const name: string = block.name;
        const item: ToolCallItem = {
          type: 'toolCall',
          id: block.id,
          turnId: prev?.turnId ?? turnId,
          parentToolUseId: parent,
          createdAt: prev?.createdAt ?? this.stamp(),
          name,
          kind: toolKind(name),
          input: block.input ?? {},
          status: 'running',
          ...(name.startsWith('mcp__') ? { mcpServer: name.split('__')[1] } : {}),
        };
        this.toolItems.set(block.id, item);
        const isNew = !this.items.has(item.id);
        this.upsert(item);
        out.push(...this.itemEvent(isNew ? 'item/started' : 'item/updated', item));
      } else if (block.type === 'web_search_tool_result' || block.type === 'mcp_tool_result') {
        const t = this.toolItems.get(block.tool_use_id);
        if (t) out.push(...this.completeTool(t, contentToText(block.content), block.content, !!block.is_error));
      }
    }
    return out;
  }

  private completeTool(t: ToolCallItem, text: string, structured: unknown, isError: boolean): Emission[] {
    const deniedMsg = this.denied.get(t.id);
    t.status = deniedMsg !== undefined ? 'denied' : isError ? 'failed' : 'completed';
    t.outputText = text;
    if (isError) t.isError = true;
    const out: Emission[] = [];
    if (isEditCall(t)) {
      const edit = editOf(t, structured);
      if (edit) out.push(...this.noteEdit(t, edit));
      if (structured !== undefined) t.output = trimmedEditOutput(structured);
    } else if (structured !== undefined) t.output = structured;
    // A background agent's launch names the task its report and notification will come from.
    const agentId = t.kind === 'subagent' ? ((structured as AnyMsg)?.agentId ?? /^agentId: (\w+)/m.exec(text)?.[1]) : undefined;
    if (typeof agentId === 'string') {
      this.taskTools.set(agentId, t.id);
      this.linkTask(agentId, t.id);
    }
    if (t.name === 'Workflow' && !isError) this.noteWorkflowLaunch(t, structured, text);
    return [...this.addCompleted(t), ...out];
  }

  /**
   * An edit, counted in its turn's edits. A turn that has ended already (a background agent's edit
   * after it) is sent again with its totals.
   */
  private noteEdit(t: ToolCallItem, edit: FileEdit): Emission[] {
    t.edit = edit;
    if (!t.turnId) return [];
    let edits = this.editsByTurn.get(t.turnId);
    if (!edits) this.editsByTurn.set(t.turnId, (edits = new Map()));
    edits.set(t.id, edit);
    const turn = this.turns.find((x) => x.id === t.turnId);
    if (!turn || turn === this.turn || turn.status === 'inProgress') return [];
    turn.edits = totalsOf(edits.values());
    return this.turnEvent('turn/updated', turn);
  }

  /** A turn's edit totals, as it ends. */
  private settleEdits(turn: Turn) {
    const totals = totalsOf(this.editsByTurn.get(turn.id)?.values() ?? []);
    if (totals) turn.edits = totals;
  }

  /** A Workflow call's launch names its task and run; history has only the text. */
  private noteWorkflowLaunch(t: ToolCallItem, structured: unknown, text: string) {
    const taskId = launchTaskId(structured, text);
    const runId = launchRunId(structured, text);
    const taskType = (structured as AnyMsg)?.taskType;
    if (runId) this.workflowRuns.set(runId, t.id);
    if (!taskId) return;
    this.taskTools.set(taskId, t.id);
    this.linkTask(taskId, t.id);
    if (!this.taskTypes.has(taskId) && (taskType === 'local_workflow' || (!taskType && /launched in background/i.test(text))))
      this.taskTypes.set(taskId, 'local_workflow');
    const w = this.workflows.get(taskId);
    if (w && runId && !w.runId) w.runId = runId;
  }

  // ---- user messages (tool results, echoes, synthetic prompts) ----

  private onUser(msg: AnyMsg): Emission[] {
    const content = msg.message?.content;
    let parent: string | null = msg.parent_tool_use_id ?? null;
    const out: Emission[] = [];
    if (Array.isArray(content) && content.some((b: AnyMsg) => b?.type === 'tool_result')) {
      const results = content.filter((b: AnyMsg) => b?.type === 'tool_result');
      for (const r of results) {
        let t = this.toolItems.get(r.tool_use_id);
        if (!t) continue;
        const structured = results.length === 1 ? msg.tool_use_result : undefined;
        out.push(...this.completeTool(t, contentToText(r.content), structured, !!r.is_error));
      }
      if (parent === null) out.push(...this.flushFinishes());
      return out;
    }
    if (msg.uuid && this.echoUuids.has(msg.uuid)) return out;
    if (msg.isReplay) return out;
    if (parent === null && isWakeup(msg)) return this.wakeup(msg);
    let inputs = userContentToInputs(content);
    if (inputs.length === 0) return out;
    const id: string = msg.uuid ?? `user_${++this.fallbackCounter}`;
    const firstText = inputs[0]?.type === 'text' ? inputs[0].text : '';
    // A skill's instructions, which Claude Code puts in the conversation right after the Skill call:
    // the call's, never a message. The transcript names the call; the stream, by place alone.
    const skillCall = this.skillCallFor(msg, id, parent, firstText);
    if (skillCall) return this.skillInstructions(skillCall, msg);
    // A /goal's harness talking to the model (its Stop hook's feedback, its brief), never the chat's.
    if (parent === null && msg.origin?.kind !== 'human' && isGoalHarness(firstText, this.activeGoal !== undefined)) return out;
    // Transcript conventions for CLI-generated user messages.
    const notification = parseTaskNotification(firstText);
    if (notification) {
      if (parent !== null) return out;
      this.noteNotification(notification);
      if (this.isWorkflowTask(notification.taskId, notification.toolUseId))
        return this.workflowFinished(notification, 'message', id, msg.timestamp ? Date.parse(msg.timestamp) : undefined);
      if (!this.worthANotice({ tool_use_id: notification.toolUseId })) return out;
      if (reportFollows(notification.summary, notification.result)) return this.reportComing(notification.taskId);
      return this.taskNotice(notification.taskId, notification.status, notification.summary, id);
    }
    // Claude Code's note to the model before a command's output, never a message to show.
    if (/^\s*<local-command-caveat>/.test(firstText)) return out;
    if (firstText.startsWith('[Request interrupted')) {
      // Nothing more of the turn follows an interrupt: live, its result comes next and ends it.
      if (this.historyMode) {
        this.interruptRequested = true;
        this.replyEnded = true;
      }
      return this.notice({ uuid: id }, 'interrupted', firstText);
    }
    const stdout = /^<local-command-(stdout|stderr)>([\s\S]*)<\/local-command-\1>\s*$/.exec(firstText);
    // Without the terminal's styling ("Set workflows to \x1b[1mon\x1b[22m").
    if (stdout) return this.notice({ uuid: id }, 'localCommandOutput', stdout[2]!.replace(/\x1b\[[0-9;]*m/g, '').trim(), stdout[1] === 'stderr' ? 'error' : undefined);
    const command = slashCommand(firstText);
    if (command) inputs = [{ type: 'text', text: command }];
    // The summary Claude Code writes when it compacts the chat: its, not the person's.
    let originKind: string | undefined = msg.isCompactSummary === true ? 'compaction' : msg.origin?.kind;
    let originName: string | undefined = originKind === 'peer' && typeof msg.origin?.name === 'string' ? msg.origin.name : undefined;
    const handback = originKind === 'peer' && msg.origin?.handback ? subagentReport(firstText) : undefined;
    // A workflow's agent can message the session; that belongs under its workflow, not in the chat.
    const workflowCall = originKind === 'peer' && handback === undefined ? this.workflowCallOfAgent(msg.origin?.senderTaskId ?? msg.origin?.from) : undefined;
    if (workflowCall) parent = workflowCall;
    if (handback !== undefined) {
      const taskId: string | undefined = msg.origin?.senderTaskId ?? msg.origin?.from;
      const call = taskId ? this.toolItems.get(this.taskTools.get(taskId) ?? '') : undefined;
      const description = (call?.input as AnyMsg)?.description;
      originKind = 'subagent';
      originName = typeof description === 'string' ? description : undefined;
      inputs = [{ type: 'text', text: handback }];
      if (taskId) {
        this.notifiedTasks.add(taskId);
        // Its report is in: it has finished, whether or not its notification says so too.
        const f = this.factsOf(taskId);
        if (!isTerminal(taskStatusOf(f.status))) f.status = 'completed';
        if (!f.toolUseId && call) f.toolUseId = call.id;
        this.tasksDirty = true;
      }
    }
    const synthetic =
      parent !== null ||
      (originKind !== undefined
        ? originKind !== 'human'
        : !command && !!(msg.isSynthetic || msg.isMeta || /^\s*<[a-z-]+>/.test(firstText)));
    if (!synthetic && this.turn && this.historyMode) out.push(...this.closeTurn('completed'));
    let turnId: string;
    if (!synthetic && !this.turn) {
      out.push(...this.startTurn(id));
      turnId = this.turn!.id;
    } else {
      const placed = this.turnFor(parent, id);
      out.push(...placed.out);
      turnId = placed.turnId;
    }
    out.push(
      ...this.addCompleted({
        type: 'userMessage',
        id,
        turnId,
        parentToolUseId: parent,
        createdAt: msg.timestamp ? Date.parse(msg.timestamp) : this.stamp(),
        content: inputs,
        ...(synthetic ? { synthetic: true } : {}),
        ...(originKind && originKind !== 'human' ? { origin: originKind } : {}),
        ...(originName ? { originName } : {}),
        ...(originKind === 'peer' && typeof msg.origin?.fromSession === 'string' ? { originSession: msg.origin.fromSession } : {}),
      }),
    );
    return out;
  }

  /**
   * Live, a command the CLI took in that Tether didn't send: a scheduled job firing (its prompt is
   * never echoed). Its turn starts now, named for the command, as history names it from the
   * prompt's record; the prompt itself is said once read from the transcript (`ingestExtra`).
   */
  private onCommandLifecycle(msg: AnyMsg): Emission[] {
    const uuid = msg.command_uuid;
    if (msg.state !== 'started' || typeof uuid !== 'string' || this.echoUuids.has(uuid) || this.turn) return [];
    return this.startTurn(uuid);
  }

  /**
   * A scheduled job's prompt, as a quiet line opening the turn it starts (`origin: wakeup`). In
   * history it starts a turn as a prompt does; live its turn has started already, at the CLI's
   * command lifecycle, unless it was read too late, when it goes in the turn it ran in.
   */
  private wakeup(record: AnyMsg): Emission[] {
    const id: string = record.uuid;
    if (typeof id !== 'string' || this.items.has(id)) return [];
    const out: Emission[] = [];
    if (this.turn?.id !== id) {
      if (this.historyMode) {
        if (this.turn) out.push(...this.closeTurn('completed'));
        out.push(...this.startTurn(id));
      } else if (!this.turn && this.lastTurnId !== id) {
        return [];
      }
    }
    // A dynamic /loop's wakeup fires with the /loop input itself, which may come as the command.
    const raw = contentToText(record.message?.content).trim();
    const text = slashCommand(raw) ?? raw;
    const item: Item = {
      type: 'userMessage',
      id,
      turnId: this.turn?.id ?? this.lastTurnId,
      parentToolUseId: null,
      createdAt: this.stamp(),
      content: [{ type: 'text', text }],
      synthetic: true,
      origin: 'wakeup',
    };
    // From a loop: its job was a /loop's (found among the chat's jobs), or the CLI marks it a loop's.
    const loopRecord = record.promptSource === 'loop_wakeup' || /^\s*<<autonomous-loop/.test(raw);
    item.fromLoop = loopRecord || scheduledWork([...this.scheduleSource(), item], { kind: 'unknown' }).loopWakeups.has(id);
    out.push(...this.addCompleted(item));
    return out;
  }

  /** The items that tell of scheduled work, those from before this itemizer's first included. */
  private scheduleSource(): Item[] {
    const own = [...this.scheduleItems].map((id) => this.items.get(id)!);
    return [...this.seedItems.filter((i) => !this.items.has(i.id)), ...own];
  }

  /** The Skill call a user message is the instructions of, if it is. */
  private skillCallFor(msg: AnyMsg, id: string, parent: string | null, text: string): string | undefined {
    const named = typeof msg.sourceToolUseID === 'string' ? msg.sourceToolUseID : undefined;
    const known = this.skillMessages.get(id);
    if (known) return known;
    // By place, only a plain synthetic message: not another sender's, a notification, an interrupt or a command's output.
    const sender = msg.origin?.kind;
    const plain =
      (msg.isSynthetic === true || msg.isMeta === true) &&
      !['human', 'peer', 'task-notification', 'channel', 'subagent'].includes(sender) &&
      !/^\s*(<[a-z-]+>|\[Request interrupted)/.test(text);
    const candidate = named ?? (plain ? this.lastItemOf.get(parent) : undefined);
    const call = candidate ? this.toolItems.get(candidate) : undefined;
    if (!call || call.kind !== 'skill' || call.parentToolUseId !== parent) return undefined;
    if (!named && call.skillInstructions !== undefined) return undefined;
    return call.id;
  }

  /** A skill's instructions onto its call, as an update of the call. */
  private skillInstructions(callId: string, msg: AnyMsg): Emission[] {
    const call = this.toolItems.get(callId);
    if (!call || call.kind !== 'skill') return [];
    if (typeof msg.uuid === 'string') this.skillMessages.set(msg.uuid, callId);
    const text = contentToText(msg.message?.content).trim();
    if (!text || call.skillInstructions === text) return [];
    call.skillInstructions = text;
    return this.itemEvent('item/updated', call);
  }

  /** A local command's output: a /goal set or cleared is the goal's, anything else a plain notice. */
  private localCommand(msg: AnyMsg, content: string): Emission[] {
    const command = msg.commandRun?.command ?? msg.local_command_run?.command;
    const goal = command === undefined || command === 'goal' ? goalFromCommandOutput(content) : undefined;
    if (goal) return this.goalNotice(msg.uuid, goal);
    const stdout = /^<local-command-(stdout|stderr)>([\s\S]*)<\/local-command-\1>\s*$/.exec(content);
    if (stdout) return this.notice(msg, 'localCommandOutput', stdout[2]!.trim(), stdout[1] === 'stderr' ? 'error' : undefined);
    return this.notice(msg, 'localCommandOutput', content);
  }

  /** What a /goal's Stop hook found, from the CLI's `goal_status` (its set is the command's own output). */
  private goalStatus(id: unknown, a: AnyMsg): Emission[] {
    if (a.sentinel === true) return [];
    const condition = typeof a.condition === 'string' && a.condition ? a.condition : this.activeGoal;
    if (!condition) return [];
    const event: GoalNotice['event'] = a.met === true ? 'met' : a.failed === true ? 'failed' : a.cleared === true ? 'cleared' : 'notMet';
    return this.goalNotice(id, {
      condition,
      event,
      ...(typeof a.reason === 'string' && a.reason ? { reason: a.reason } : {}),
      ...(typeof a.iterations === 'number' ? { iterations: a.iterations } : {}),
      ...(typeof a.durationMs === 'number' ? { durationMs: a.durationMs } : {}),
    });
  }

  /**
   * A /goal's line in the chat: `kind: goal` with what happened. It goes in the running turn, or
   * the one just ended: a check is written after the reply it judged.
   */
  private goalNotice(id: unknown, goal: GoalNotice): Emission[] {
    this.activeGoal = goal.event === 'set' || goal.event === 'notMet' ? goal.condition : undefined;
    const itemId = typeof id === 'string' && id ? id : `goal_${++this.fallbackCounter}`;
    if (this.items.has(itemId)) return [];
    return this.addCompleted({
      type: 'notice',
      id: itemId,
      turnId: this.turn?.id ?? this.lastTurnId,
      parentToolUseId: null,
      createdAt: this.stamp(),
      kind: 'goal',
      text: goalText(goal),
      ...(goal.event === 'failed' ? { level: 'warning' as const } : {}),
      goal,
    });
  }

  /** The Workflow call an agent works for, by its agent id: from the snapshots, else from disk. */
  private workflowCallOfAgent(agentId: unknown): string | undefined {
    if (typeof agentId !== 'string' || !agentId) return undefined;
    const known = this.workflowAgents.get(agentId);
    if (known) return known;
    const runId = this.locateWorkflowAgent?.(agentId);
    return runId ? this.workflowRuns.get(runId) : undefined;
  }

  /**
   * Whether a turn is running: live, until its result; in history, until a reply ends it, since a
   * transcript has no results.
   */
  private turnRunning(): boolean {
    return this.turn !== null && !(this.historyMode && this.replyEnded);
  }

  /**
   * A workflow's finish: a message from the workflow, named for it, holding its result, or what
   * happened when it failed or was stopped. It is one item, `workflow_<taskId>_finished`, said by
   * whichever comes first of the `task_notification` event (live only) and the `<task-notification>`
   * message the CLI hands the model (history: the SDK stream doesn't carry it, as the slow-check
   * capture shows); the message, coming second, puts its `<result>` in the same item. Live, the
   * event takes the result from the run record (`readRunResult`), so both say the same.
   *
   * Where it goes is decided once, by one rule, live and in history: in the running turn if there
   * is one, else opening the turn that answers it. Live, the event usually comes first, while no
   * turn runs. Mid-turn, the CLI hands the model the message at the turn's next step, after the
   * next tool result (history has it there, as a `queued_command` attachment: `ingestQueued`), and
   * never as a message of that turn; so the event waits for that step (`flushFinishes`): the next
   * top-level tool result or reply, in the running turn, or, once the turn has ended without
   * one, opening the turn that answers it, where history's message goes. A stopped workflow gets
   * no message and no answering turn, so its event says it at once, in the running turn or in none.
   */
  private workflowFinished(
    n: { taskId?: string; toolUseId?: string; status?: string; summary?: string; result?: string },
    source: 'event' | 'message',
    messageId?: string,
    writtenAt?: number,
    flushing = false,
  ): Emission[] {
    const id = n.taskId ? `workflow_${n.taskId}_finished` : (messageId ?? `workflow_${++this.fallbackCounter}_finished`);
    const status = workflowStatus(n.status);
    const w = n.taskId ? this.workflows.get(n.taskId) : undefined;
    // Live, the CLI's message with the result never reaches the stream (it starts the turn that
    // answers it, unechoed): the event says it with the result its run record holds, as history does.
    if (source === 'event' && status === 'completed' && n.result === undefined && w?.runId && !this.items.has(id)) {
      const recorded = this.readRunResult?.(w.runId);
      if (recorded !== undefined) n = { ...n, result: recorded };
    }
    if (w && n.result && status === 'completed') w.result = notificationResult(n.result);
    if (w && !w.error && status === 'failed') {
      const error = failureOf(undefined, n.summary);
      if (error) w.error = error;
    }
    const text =
      n.result !== undefined && n.result !== ''
        ? notificationResult(n.result)
        : (n.summary ?? '').replace(/<recovery>[\s\S]*?<\/recovery>/g, '').trim() || `Workflow ${status ?? 'finished'}`;
    const existing = this.items.get(id);
    if (existing?.type === 'userMessage') {
      // Said already: the message's result replaces the event's summary; the item stays where it was.
      const prev = existing.content[0]?.type === 'text' ? existing.content[0].text : undefined;
      if (n.result === undefined || prev === text) return [];
      return this.addCompleted({ ...existing, content: [{ type: 'text', text }] });
    }
    const answered = status !== 'stopped';
    if (source === 'event' && answered && this.turnRunning() && !flushing) {
      this.pendingFinishes.set(id, { taskId: n.taskId, toolUseId: n.toolUseId, status: n.status, summary: n.summary });
      return [];
    }
    this.pendingFinishes.delete(id);
    const out: Emission[] = [];
    let turnId: string | null;
    if (this.turnRunning()) turnId = this.turn!.id;
    else {
      // History's last turn is still open after its reply has ended.
      if (this.turn) out.push(...this.closeTurn('completed'));
      if (answered) out.push(...this.startTurn(`turn_${id}`));
      turnId = this.turn?.id ?? null;
    }
    const callId = n.toolUseId ?? (n.taskId ? this.taskTools.get(n.taskId) : undefined);
    const call = callId ? this.toolItems.get(callId) : undefined;
    const name = w?.name ?? workflowCallName(call?.input);
    out.push(
      ...this.addCompleted({
        type: 'userMessage',
        id,
        turnId,
        parentToolUseId: null,
        createdAt: writtenAt ?? this.stamp(),
        content: [{ type: 'text', text }],
        synthetic: true,
        origin: 'workflow',
        ...(name ? { originName: name } : {}),
      }),
    );
    return out;
  }

  /** Says the workflow finishes whose events came mid-turn, at the turn's next step (see `workflowFinished`). */
  private flushFinishes(): Emission[] {
    if (this.pendingFinishes.size === 0) return [];
    const pending = [...this.pendingFinishes.values()];
    this.pendingFinishes.clear();
    return pending.flatMap((n) => this.workflowFinished(n, 'event', undefined, undefined, true));
  }

  // ---- result: end of turn ----

  private onResult(msg: AnyMsg): Emission[] {
    const out: Emission[] = [...this.ensureTurn(msg.uuid ?? 'result')];
    const turn = this.turn!;
    const u = msg.usage ?? {};
    const result: TurnResult = {
      subtype: msg.subtype,
      isError: !!msg.is_error,
      ...(typeof msg.result === 'string' ? { resultText: msg.result } : {}),
      stopReason: msg.stop_reason ?? null,
      ...(msg.terminal_reason ? { terminalReason: msg.terminal_reason } : {}),
      ...(Array.isArray(msg.errors) && msg.errors.length ? { errors: msg.errors } : {}),
      durationMs: msg.duration_ms ?? 0,
      durationApiMs: msg.duration_api_ms ?? 0,
      numTurns: msg.num_turns ?? 0,
      totalCostUsd: msg.total_cost_usd ?? 0,
      usage: {
        inputTokens: u.input_tokens ?? 0,
        outputTokens: u.output_tokens ?? 0,
        cacheReadInputTokens: u.cache_read_input_tokens ?? 0,
        cacheCreationInputTokens: u.cache_creation_input_tokens ?? 0,
      },
      modelUsage: Object.fromEntries(
        Object.entries((msg.modelUsage ?? {}) as Record<string, AnyMsg>).map(([k, v]) => [
          k,
          {
            inputTokens: v.inputTokens ?? 0,
            outputTokens: v.outputTokens ?? 0,
            cacheReadInputTokens: v.cacheReadInputTokens ?? 0,
            cacheCreationInputTokens: v.cacheCreationInputTokens ?? 0,
            costUsd: v.costUSD ?? 0,
            ...(v.contextWindow ? { contextWindow: v.contextWindow } : {}),
            ...(v.maxOutputTokens ? { maxOutputTokens: v.maxOutputTokens } : {}),
          },
        ]),
      ),
    };
    const interrupted = this.interruptRequested && msg.subtype !== 'success';
    turn.status = msg.subtype === 'success' && !msg.is_error ? 'completed' : interrupted ? 'interrupted' : 'failed';
    if (this.interruptRequested && msg.subtype === 'success') turn.status = 'interrupted';
    turn.completedAt = this.stamp();
    turn.result = result;
    this.settleEdits(turn);
    // Anything still in flight did not finish.
    for (const t of this.cutShort(turn.id)) {
      t.status = 'interrupted';
      out.push(...this.addCompleted(t));
    }
    out.push(...this.turnEvent('turn/completed', turn));
    out.push({
      method: 'thread/tokenUsage/updated',
      body: { ...result.usage, totalCostUsd: result.totalCostUsd },
    });
    this.lastTurnId = turn.id;
    this.turn = null;
    this.interruptRequested = false;
    this.tasksDirty = true;
    // A finish still waiting for a step of the turn comes after it, as the turn that answers it.
    out.push(...this.flushFinishes());
    return out;
  }

  /** Close an open turn without a result (e.g. process died, or end of a transcript). */
  closeTurn(status: 'completed' | 'interrupted' | 'failed'): Emission[] {
    return this.withTasks(this.abandonTurn(status));
  }

  /**
   * The CLI process has ended: nothing it was running will report again, including a background
   * subagent's tool calls in a turn that has already closed.
   */
  abandonAll(): Emission[] {
    this.processEnded = true;
    this.tasksDirty = true;
    const out = this.abandonTurn('interrupted');
    for (const t of this.toolItems.values()) {
      if (t.status !== 'running' && t.status !== 'pending') continue;
      t.status = 'interrupted';
      out.push(...this.addCompleted(t));
    }
    this.backgroundTaskIds.clear();
    return this.withTasks(out);
  }

  abandonTurn(status: 'completed' | 'interrupted' | 'failed' = 'interrupted'): Emission[] {
    if (!this.turn) return [];
    // The process may be gone: a finish waiting for the turn's next step goes in it now.
    const flushed = this.flushFinishes();
    const turn = this.turn;
    turn.status = status === 'completed' && this.interruptRequested ? 'interrupted' : status;
    turn.completedAt = this.endStamp();
    this.interruptRequested = false;
    const out: Emission[] = flushed;
    for (const t of this.cutShort(turn.id)) {
      t.status = 'interrupted';
      out.push(...this.addCompleted(t));
    }
    this.settleEdits(turn);
    out.push(...this.turnEvent('turn/completed', turn));
    this.lastTurnId = turn.id;
    this.turn = null;
    this.tasksDirty = true;
    return out;
  }

  // ---- tasks ----

  /**
   * Whether the itemizer makes no events: for one whose emissions nobody reads (a transcript read
   * once, a follower's first read). Items and turns are kept as ever, and `tasks()` still says how
   * tasks stand; what's skipped is copying each item into its events and working out what changed.
   */
  quiet = false;

  /**
   * Every task of the chat as it stands, in the order each was first heard of: the calls that
   * start tasks (`isTaskCall`), the tasks the CLI reports (by the call that started each, else its
   * task id), each workflow's agents after it, then the schedules and goals. A task a subagent
   * started goes under that subagent; a workflow agent's own task under that agent once known, else
   * its workflow, and nowhere (left out) when neither is known.
   */
  tasks(): TaskState[] {
    const ended = this.processEnded;
    const opts = { ended, readPrompt: (runId: string, agentId: string) => this.agentPrompt(runId, agentId) };
    const states = new Map<string, TaskState>();
    const put = (id: string, call: ToolCallItem | undefined, f: TaskFacts | undefined) => {
      const w = this.snapshotOf(id, f);
      states.set(
        id,
        taskState(id, call, f, {
          ended,
          live: !this.historyMode,
          inBackground: !!f && this.backgroundTaskIds.has(f.taskId),
          workflowName: w?.name ?? (call ? workflowCallName(call.input) : undefined),
        }),
      );
    };
    for (const id of this.taskCalls) put(id, this.toolItems.get(id), this.factsByCall.get(id));
    for (const f of this.facts.values()) {
      const callId = f.toolUseId;
      // A call's older task is its newer one's: the call is one task.
      if (callId && (states.has(callId) || this.factsByCall.get(callId) !== f)) continue;
      put(callId ?? `task:${f.taskId}`, callId ? this.toolItems.get(callId) : undefined, f);
    }
    const all: TaskState[] = [];
    for (const s of states.values()) {
      if (s.kind !== 'workflow') {
        all.push(s);
        continue;
      }
      const f = this.factsByCall.get(s.id) ?? (s.taskId ? this.facts.get(s.taskId) : undefined);
      const script = (this.toolItems.get(s.toolUseId ?? '')?.input as AnyMsg)?.script;
      all.push(...workflowTasks(s, this.snapshotOf(s.id, f), script, opts));
    }
    const byId = new Map(all.map((s) => [s.id, s]));
    const placed: TaskState[] = [];
    for (const s of all) {
      if (s.kind === 'workflowAgent') {
        placed.push(s);
        continue;
      }
      const call = s.toolUseId ? this.toolItems.get(s.toolUseId) : undefined;
      const parentCall = call?.parentToolUseId;
      if (parentCall && parentCall !== s.id && byId.has(parentCall)) s.parentId = parentCall;
      else if (!call && s.taskId && this.ownedTasks.has(s.taskId)) {
        // A workflow agent's own task: its call never reaches the stream.
        const owner = this.ownedTasks.get(s.taskId)!;
        const workflow = owner.workflowToolUseId ? byId.get(owner.workflowToolUseId) : undefined;
        if (!workflow) continue;
        const agent = owner.workflowAgentId
          ? all.find((a) => a.parentId === workflow.id && a.workflowAgent?.agentId === owner.workflowAgentId)
          : undefined;
        s.parentId = agent?.id ?? workflow.id;
      }
      placed.push(s);
    }
    placed.push(...scheduledTasks(scheduledWork(this.scheduleSource(), this.liveness())));
    return placed;
  }

  /** The tasks that changed since they were last sent, as `task/updated`, after `out`. */
  private withTasks(out: Emission[]): Emission[] {
    if (!this.tasksDirty || this.quiet) return out;
    this.tasksDirty = false;
    for (const task of this.tasks()) {
      const json = JSON.stringify(task);
      if (this.sentTasks.get(task.id) === json) continue;
      this.sentTasks.set(task.id, json);
      out.push({ method: 'task/updated', body: { task } });
    }
    return out;
  }

  /** Takes the tasks as they stand as sent: a client was handed them whole (a history read). */
  markTasksSent() {
    this.sentTasks = new Map(this.tasks().map((t) => [t.id, JSON.stringify(t)]));
    this.tasksDirty = false;
  }

  /** What the session's Stop hook says will wake it (live only): its schedules settle by it. */
  noteSessionCrons(crons: SessionCron[]): Emission[] {
    this.sessionCrons = crons;
    this.tasksDirty = true;
    return this.withTasks([]);
  }

  /**
   * The chat's items from before this itemizer's first, for a live thread resuming a session: its
   * schedules and goals are worked out from all of the chat, not only what this process said.
   */
  seed(items: Item[]): Emission[] {
    this.seedItems = items.filter(concernsSchedules);
    this.tasksDirty = true;
    return this.withTasks([]);
  }

  /** A workflow run's snapshot read from the session's files, for a run this itemizer has no live snapshot of. */
  applyWorkflowSnapshot(runId: string, snapshot: WorkflowSnapshot): Emission[] {
    const callId = this.workflowRuns.get(runId);
    let key = [...this.workflows.entries()].find(([, w]) => w.runId === runId)?.[0];
    if (!key) key = (callId ? [...this.taskTools.entries()].find(([, c]) => c === callId)?.[0] : undefined) ?? `run:${runId}`;
    this.workflows.set(key, { ...snapshot, runId });
    if (callId) for (const a of snapshot.agents) if (a.agentId) this.workflowAgents.set(a.agentId, callId);
    this.tasksDirty = true;
    return this.withTasks([]);
  }

  /** The workflow runs whose calls this itemizer has and that it hasn't seen settle in a snapshot. */
  unsettledWorkflowRuns(): string[] {
    return [...this.workflowRuns.keys()].filter((runId) => {
      const w = [...this.workflows.values()].find((x) => x.runId === runId);
      return !w || !(w.status === 'completed' || w.status === 'failed' || w.status === 'stopped');
    });
  }

  /** A workflow's snapshot, by its task, else by its call. */
  private snapshotOf(stateId: string, f: TaskFacts | undefined): WorkflowSnapshot | undefined {
    const byTask = f ? this.workflows.get(f.taskId) : undefined;
    if (byTask) return byTask;
    for (const [key, w] of this.workflows) {
      if (this.taskTools.get(key) === stateId) return w;
      if (key.startsWith('run:') && this.workflowRuns.get(key.slice(4)) === stateId) return w;
    }
    return undefined;
  }

  private liveness(): Liveness {
    if (this.processEnded) return { kind: 'ended' };
    if (this.historyMode) return { kind: 'unknown' };
    return { kind: 'live', ...(this.sessionCrons ? { crons: this.sessionCrons } : {}), turnRunning: this.turn !== null };
  }

  /** A workflow agent's whole prompt, read once found; looked for again at most every 5 seconds. */
  private agentPrompt(runId: string, agentId: string): string | undefined {
    const key = `${runId}/${agentId}`;
    const known = this.agentPrompts.get(key);
    if (known !== undefined) return known;
    const missed = this.agentPromptMisses.get(key);
    if (!this.readAgentPrompt || (missed !== undefined && this.now() - missed < 5000)) return undefined;
    const read = this.readAgentPrompt(runId, agentId);
    if (read === undefined) this.agentPromptMisses.set(key, this.now());
    else this.agentPrompts.set(key, read);
    return read;
  }

  /** A task's call, once known: its facts are the call's. */
  private linkTask(taskId: string, callId: string) {
    const f = this.facts.get(taskId);
    if (!f || f.toolUseId) return;
    f.toolUseId = callId;
    this.factsByCall.set(callId, f);
    this.tasksDirty = true;
  }

  /**
   * The items and turns in order, as they are: the itemizer goes on changing them (a streamed
   * reply grows in place), so what is handed to a client while it runs is copied first
   * (`ThreadManager.read` copies the page it returns).
   */
  snapshot(): { items: Item[]; turns: Turn[] } {
    return { items: this.order.map((id) => this.items.get(id)!), turns: this.turns };
  }
}

/** Whether a settled task's notification says its report was delivered as a message of its own. */
function reportFollows(summary: unknown, result: unknown): boolean {
  const note = /delivered to you as a message/;
  return (typeof summary === 'string' && note.test(summary)) || (typeof result === 'string' && note.test(result));
}

/**
 * A subagent's report from the CLI's hand-back message, which wraps it in a frame for the model:
 * the lines after "The report follows:", each indented two spaces, up to `</agent-message>`.
 */
export function subagentReport(text: string): string | undefined {
  const start = text.indexOf('The report follows:\n');
  if (start < 0) return undefined;
  const rest = text.slice(start + 'The report follows:\n'.length);
  const end = rest.lastIndexOf('\n</agent-message>');
  const body = end < 0 ? rest : rest.slice(0, end);
  return body.split('\n').map((l) => l.replace(/^ {2}/, '')).join('\n').trim();
}

/**
 * Why a workflow failed: the error the CLI reported, else what its summary says after "failed:"
 * (`Dynamic workflow "<description>" failed: <error>`).
 */
function failureOf(error: unknown, summary: string | undefined): string | undefined {
  if (typeof error === 'string' && error) return error;
  const message = (error as AnyMsg)?.message;
  if (typeof message === 'string' && message) return message;
  return summary ? /\bfailed: ([\s\S]+)$/.exec(summary)?.[1]?.trim() : undefined;
}

/**
 * The `<task-notification>` message the CLI hands the model when a background task settles:
 * `<task-id>`, `<status>` and `<summary>` are what a reader needs.
 */
export function parseTaskNotification(
  text: string,
): { taskId?: string; toolUseId?: string; status?: string; summary?: string; result?: string; outputFile?: string } | undefined {
  if (!/^\s*<task-notification>/.test(text)) return undefined;
  const tag = (name: string) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text)?.[1]?.trim();
  // A result can itself hold tags, so it runs to the last closing tag.
  const result = /<result>([\s\S]*)<\/result>/.exec(text)?.[1]?.trim();
  return {
    taskId: tag('task-id'),
    toolUseId: tag('tool-use-id'),
    status: tag('status'),
    summary: tag('summary'),
    ...(result !== undefined ? { result } : {}),
    ...(tag('output-file') ? { outputFile: tag('output-file') } : {}),
  };
}

/**
 * A slash command as typed, from the tags the CLI writes it in. The args may come before or after
 * the name and message tags (a skill's /loop has the message first, a built-in /goal the name).
 */
function slashCommand(text: string): string | undefined {
  const name = /<command-name>([^<]*)<\/command-name>/.exec(text)?.[1]?.trim();
  if (name === undefined) return undefined;
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim();
  return `${name.startsWith('/') ? name : '/' + name}${args ? ' ' + args : ''}`;
}

/**
 * A scheduled job's prompt, as the transcript records it: `turnOrigin: scheduled`, or a wakeup's
 * `promptSource`, or the dynamic /loop's sentinel.
 */
export function isWakeup(record: AnyMsg): boolean {
  if (record.turnOrigin === 'scheduled') return true;
  if (record.promptSource === 'loop_wakeup' || record.promptSource === 'schedule_wakeup') return true;
  return !!record.isMeta && /^\s*<<autonomous-loop/.test(contentToText(record.message?.content));
}

/**
 * A /goal's set or clear, from the command's output ("Goal set: <condition>", "Goal cleared:
 * <condition>"), plain or in `<local-command-stdout>`.
 */
export function goalFromCommandOutput(text: string): Pick<GoalNotice, 'event' | 'condition'> | undefined {
  const plain = text.replace(/^\s*<local-command-stdout>([\s\S]*)<\/local-command-stdout>\s*$/, '$1').trim();
  const m = /^Goal (set|cleared): ([\s\S]+)$/.exec(plain);
  if (!m) return undefined;
  return { event: m[1] === 'set' ? 'set' : 'cleared', condition: m[2]!.trim() };
}

/**
 * What a /goal's harness says to the model: its brief when set ("A session-scoped Stop hook is now
 * active…"), and, while a goal is active, its Stop hook's feedback ("Stop hook feedback:").
 */
function isGoalHarness(text: string, goalActive: boolean): boolean {
  if (/^A session-scoped Stop hook is now active with condition:/.test(text)) return true;
  return goalActive && /^Stop hook feedback:/.test(text);
}

/** A goal notice's text, for a client that draws only `text`. */
function goalText(g: GoalNotice): string {
  switch (g.event) {
    case 'set':
      return `Goal set: ${g.condition}`;
    case 'met':
      return 'Goal met';
    case 'notMet':
      return 'Goal not met yet';
    case 'failed':
      return 'Goal can’t be met';
    case 'cleared':
      return 'Goal cleared';
  }
}
