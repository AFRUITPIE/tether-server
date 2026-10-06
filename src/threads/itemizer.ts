import type { Item, ToolCallItem, ToolKind, Turn, TurnResult, UserInput } from '../protocol/index.ts';
import type { NotificationBody, NotificationName } from '../protocol/notifications.ts';
import type { WorkflowSnapshot } from '../protocol/items.ts';
import {
  launchRunId,
  launchTaskId,
  mergeWorkflowProgress,
  notificationResult,
  scriptMeta,
  settleAgents,
  workflowCallName,
  workflowStatus,
} from './workflows.ts';

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
   * In history mode, whether the open turn's last reply ended it (a stop reason other than
   * `tool_use`): a transcript has no result messages, so this is how history knows a turn is over.
   */
  private replyEnded = false;
  /** In history mode, the message being read's time, and the last one read's. */
  private messageTime?: number;
  private lastMessageTime?: number;

  /**
   * Which workflow run an agent id belongs to, from the session's directory on disk: for a peer
   * message from an agent of a run this itemizer has no snapshot of (history, or a run whose agents
   * the CLI hasn't reported yet).
   */
  locateWorkflowAgent?: (agentId: string) => string | undefined;

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
    return { turnId: this.turn!.id, out };
  }

  ingest(msg: AnyMsg): Emission[] {
    if (!this.historyMode) return this.route(msg);
    const t = typeof msg.timestamp === 'string' ? Date.parse(msg.timestamp) : NaN;
    this.messageTime = Number.isFinite(t) ? t : undefined;
    try {
      return this.route(msg);
    } finally {
      if (this.messageTime !== undefined) this.lastMessageTime = this.messageTime;
      this.messageTime = undefined;
    }
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
          out.push({ method: 'item/updated', body: { item: structuredClone(t) } });
        }
        return out;
      }
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
        return this.notice(msg, 'localCommandOutput', msg.content ?? '');
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
        if (!this.worthANotice(msg)) return events;
        if (workflow)
          return [...events, ...this.workflowFinished({ taskId: msg.task_id, toolUseId: msg.tool_use_id, status: msg.status, summary: msg.summary }, 'event')];
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
        return [{ method: 'task/backgroundChanged', body: { tasks: msg.tasks ?? msg } }];
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

  private taskEvent(msg: AnyMsg): Emission[] {
    const taskId: string = msg.task_id;
    if (msg.subtype === 'task_started' && typeof msg.task_type === 'string') this.taskTypes.set(taskId, msg.task_type);
    const workflow = this.isWorkflowTask(taskId, msg.tool_use_id) || Array.isArray(msg.workflow_progress);
    const snapshot = workflow ? this.trackWorkflow(msg) : undefined;
    // What the CLI reports of a workflow is in the snapshot; the rest of the event goes as it came.
    // The started event's prompt is the whole script, already the Workflow call's input.
    let data = msg;
    if (workflow && ('workflow_progress' in msg || 'prompt' in msg)) {
      const { workflow_progress: _p, prompt: _s, ...rest } = msg;
      data = rest;
    }
    const description: string | undefined =
      msg.subtype === 'task_updated'
        ? msg.patch?.description
        : // A workflow's progress names its latest agent ("Verify: ls-1"): its activity, not a new name.
          workflow && msg.subtype === 'task_progress'
          ? undefined
          : msg.description;
    const error = msg.patch?.error ?? msg.error;
    return [
      {
        method: 'task/event',
        body: {
          event: msg.subtype.slice('task_'.length),
          taskId,
          ...(msg.tool_use_id ? { toolUseId: msg.tool_use_id } : {}),
          ...(description ? { description } : {}),
          ...(msg.status || msg.patch?.status ? { status: msg.status ?? msg.patch.status } : {}),
          ...(msg.summary ? { summary: msg.summary } : {}),
          ...(typeof error === 'string' && error ? { error } : typeof error?.message === 'string' ? { error: error.message } : {}),
          ...(snapshot ? { workflow: structuredClone(snapshot) } : {}),
          data,
        },
      },
    ];
  }

  /** Whether a task is a dynamic workflow: by its type, else by the call that started it. */
  private isWorkflowTask(taskId: string | undefined, toolUseId?: string): boolean {
    const type = taskId ? this.taskTypes.get(taskId) : undefined;
    if (type) return type === 'local_workflow';
    const callId = toolUseId ?? (taskId ? this.taskTools.get(taskId) : undefined);
    return !!callId && this.toolItems.get(callId)?.name === 'Workflow';
  }

  /**
   * A workflow's snapshot with what this event says merged in. Returned only for events worth
   * sending it on: its start, its finish, and progress that carried the agents (the CLI sends
   * them at most every few seconds, so the snapshot is held between).
   */
  private trackWorkflow(msg: AnyMsg): WorkflowSnapshot | undefined {
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
    let send = false;
    switch (msg.subtype) {
      case 'task_started':
        if (typeof msg.description === 'string' && msg.description) w.description = msg.description;
        w.status = 'running';
        send = true;
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
        send = true;
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
    if (Array.isArray(msg.workflow_progress)) {
      w = mergeWorkflowProgress(w, msg.workflow_progress);
      send = true;
    }
    if (msg.subtype === 'task_notification' && w.status === 'completed') w = settleAgents(w);
    if (!w.description && call?.input) {
      const d = scriptMeta((call.input as AnyMsg).script).description;
      if (d) w.description = d;
    }
    this.workflows.set(taskId, w);
    if (callId) for (const a of w.agents) if (a.agentId) this.workflowAgents.set(a.agentId, callId);
    return send ? w : undefined;
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
   * What a settled task says: its summary, unless that is the CLI's note to the model (an agent's
   * "report was delivered to you as a message"), which a reader shouldn't see.
   */
  private noticeText(taskId: string | undefined, status: string | undefined, summary: string | undefined): string {
    if (summary && !/delivered to you as a message/.test(summary)) return summary;
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
    if (!this.items.has(item.id)) this.order.push(item.id);
    this.items.set(item.id, item);
  }

  private addStarted(item: Item): Emission[] {
    this.upsert(item);
    return [{ method: 'item/started', body: { item: structuredClone(item) } }];
  }

  private addCompleted(item: Item): Emission[] {
    const isNew = !this.items.has(item.id);
    this.upsert(item);
    const out: Emission[] = [];
    if (isNew) out.push({ method: 'item/started', body: { item: structuredClone(item) } });
    out.push({ method: 'item/completed', body: { item: structuredClone(item) } });
    return out;
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
    const placed = this.turnFor(parent, msgId);
    const out: Emission[] = [...placed.out];
    const turnId = placed.turnId;
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
        out.push({ method: isNew ? 'item/started' : 'item/updated', body: { item: structuredClone(item) } });
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
    if (structured !== undefined) t.output = structured;
    if (isError) t.isError = true;
    // A background agent's launch names the task its report and notification will come from.
    const agentId = (structured as AnyMsg)?.agentId ?? /^agentId: (\w+)/m.exec(text)?.[1];
    if (t.kind === 'subagent' && typeof agentId === 'string') this.taskTools.set(agentId, t.id);
    if (t.name === 'Workflow' && !isError) this.noteWorkflowLaunch(t, structured, text);
    return this.addCompleted(t);
  }

  /** A Workflow call's launch names its task and run; history has only the text. */
  private noteWorkflowLaunch(t: ToolCallItem, structured: unknown, text: string) {
    const taskId = launchTaskId(structured, text);
    const runId = launchRunId(structured, text);
    const taskType = (structured as AnyMsg)?.taskType;
    if (runId) this.workflowRuns.set(runId, t.id);
    if (!taskId) return;
    this.taskTools.set(taskId, t.id);
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
      return out;
    }
    if (msg.uuid && this.echoUuids.has(msg.uuid)) return out;
    if (msg.isReplay) return out;
    let inputs = userContentToInputs(content);
    if (inputs.length === 0) return out;
    const id: string = msg.uuid ?? `user_${++this.fallbackCounter}`;
    const firstText = inputs[0]?.type === 'text' ? inputs[0].text : '';
    // Transcript conventions for CLI-generated user messages.
    const notification = parseTaskNotification(firstText);
    if (notification) {
      if (parent !== null) return out;
      if (this.isWorkflowTask(notification.taskId, notification.toolUseId))
        return this.workflowFinished(notification, 'message', id, msg.timestamp ? Date.parse(msg.timestamp) : undefined);
      if (!this.worthANotice({ tool_use_id: notification.toolUseId })) return out;
      return this.taskNotice(notification.taskId, notification.status, notification.summary, id);
    }
    if (firstText.startsWith('[Request interrupted')) {
      if (this.historyMode) this.interruptRequested = true;
      return this.notice({ uuid: id }, 'interrupted', firstText);
    }
    const stdout = /^<local-command-(stdout|stderr)>([\s\S]*)<\/local-command-\1>\s*$/.exec(firstText);
    if (stdout) return this.notice({ uuid: id }, 'localCommandOutput', stdout[2]!.trim(), stdout[1] === 'stderr' ? 'error' : undefined);
    const command = /<command-name>([^<]*)<\/command-name>[\s\S]*?(?:<command-args>([\s\S]*?)<\/command-args>)?/.exec(firstText);
    if (command) {
      const name = command[1]!.trim();
      inputs = [{ type: 'text', text: `${name.startsWith('/') ? name : '/' + name}${command[2]?.trim() ? ' ' + command[2].trim() : ''}` }];
    }
    let originKind: string | undefined = msg.origin?.kind;
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
      if (taskId) this.notifiedTasks.add(taskId);
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
   * message the CLI hands the model (live and history); the message, coming second, puts its
   * `<result>` in the same item.
   *
   * Where it goes is decided once, by one rule, live and in history: in the running turn if there
   * is one, else opening the turn that answers it. Live, the event usually comes first, while no
   * turn runs; mid-turn it leaves the placing to the message, which the CLI may hand over in that
   * turn or only after it, as history has it. A stopped workflow gets no message and no answering
   * turn, so its event says it at once, in the running turn or in none.
   */
  private workflowFinished(
    n: { taskId?: string; toolUseId?: string; status?: string; summary?: string; result?: string },
    source: 'event' | 'message',
    messageId?: string,
    writtenAt?: number,
  ): Emission[] {
    const id = n.taskId ? `workflow_${n.taskId}_finished` : (messageId ?? `workflow_${++this.fallbackCounter}_finished`);
    const status = workflowStatus(n.status);
    const w = n.taskId ? this.workflows.get(n.taskId) : undefined;
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
    if (source === 'event' && answered && this.turnRunning()) return [];
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
    // Anything still in flight did not finish.
    for (const t of this.cutShort(turn.id)) {
      t.status = 'interrupted';
      out.push(...this.addCompleted(t));
    }
    out.push({ method: 'turn/completed', body: { turn: structuredClone(turn) } });
    out.push({
      method: 'thread/tokenUsage/updated',
      body: { ...result.usage, totalCostUsd: result.totalCostUsd },
    });
    this.turn = null;
    this.interruptRequested = false;
    return out;
  }

  /** Close an open turn without a result (e.g. process died, or end of a transcript). */
  closeTurn(status: 'completed' | 'interrupted' | 'failed'): Emission[] {
    return this.abandonTurn(status);
  }

  /**
   * The CLI process has ended: nothing it was running will report again, including a background
   * subagent's tool calls in a turn that has already closed.
   */
  abandonAll(): Emission[] {
    const out = this.abandonTurn('interrupted');
    for (const t of this.toolItems.values()) {
      if (t.status !== 'running' && t.status !== 'pending') continue;
      t.status = 'interrupted';
      out.push(...this.addCompleted(t));
    }
    this.backgroundTaskIds.clear();
    return out;
  }

  abandonTurn(status: 'completed' | 'interrupted' | 'failed' = 'interrupted'): Emission[] {
    if (!this.turn) return [];
    const turn = this.turn;
    turn.status = status === 'completed' && this.interruptRequested ? 'interrupted' : status;
    turn.completedAt = this.endStamp();
    this.interruptRequested = false;
    const out: Emission[] = [];
    for (const t of this.cutShort(turn.id)) {
      t.status = 'interrupted';
      out.push(...this.addCompleted(t));
    }
    out.push({ method: 'turn/completed', body: { turn: structuredClone(turn) } });
    this.turn = null;
    return out;
  }

  snapshot(): { items: Item[]; turns: Turn[] } {
    return {
      items: this.order.map((id) => structuredClone(this.items.get(id)!)),
      turns: this.turns.map((t) => structuredClone(t)),
    };
  }
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
