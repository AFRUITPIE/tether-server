import {
  createSdkMcpServer,
  query,
  tool,
  type Options,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
  type SDKControlInitializeResponse,
  type SDKMessage,
  type SDKUserMessage,
  getSessionInfo,
} from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ClaudeBinary } from '../claude.ts';
import type {
  EffortLevel,
  PermissionMode,
  ThinkingSetting,
  ThreadInfo,
  ThreadStatus,
  UserInput,
} from '../protocol/index.ts';
import type { NotificationBody, NotificationName } from '../protocol/notifications.ts';
import type { ServerRequestName, ServerRequestParams, ServerRequestResult } from '../protocol/serverRequests.ts';
import { ErrorCodes, RpcError } from '../rpc/connection.ts';
import { Itemizer, type Emission } from './itemizer.ts';
import { runResultReader, sessionDirSync, workflowAgentLocator, workflowCallLocator } from './workflows.ts';
import { PushQueue } from './pushQueue.ts';
import { replayGap, seqOrigin } from './seq.ts';
import pkg from '../../package.json' with { type: 'json' };

/** Set by `scripts/compile.ts`: the package version, or a `-dev.<time>` stamp for a local build. */
declare const TETHER_BUILD_VERSION: string | undefined;
export const TETHER_VERSION: string = typeof TETHER_BUILD_VERSION === 'string' ? TETHER_BUILD_VERSION : pkg.version;
/** The Agent SDK this build wraps. Reported, not encoded in TETHER_VERSION: the daemon replaces
 *  itself only when the running version differs, so that string has to move when Tether changes
 *  even if the SDK hasn't. */
export const AGENT_SDK_VERSION: string = pkg.dependencies['@anthropic-ai/claude-agent-sdk'];

/** A connected client that has subscribed to a thread. */
export interface Subscriber {
  readonly id: string;
  notify(method: string, params: unknown): void;
  request(method: string, params: unknown, id: string): Promise<unknown>;
  cancelRequest(id: string): void;
}

type BufferedEvent = { seq: number; method: string; params: Record<string, unknown> };

type PendingRequest = {
  requestId: string;
  method: ServerRequestName;
  params: Record<string, unknown>;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  sentTo: Set<Subscriber>;
  /** An unattended thread's deadline for an answer. */
  timer?: ReturnType<typeof setTimeout>;
};

/**
 * A thread no person started or is expected to be watching: a scheduled run. What it asks of a
 * person is denied once it has waited `requestTimeoutMs` with no client subscribed, rather than
 * holding the thread (and a daemon upgrade) forever. A client looking at it gets as long as it takes.
 */
export type Unattended = {
  requestTimeoutMs: number;
  /** Told why the run was held up: a request that went unanswered, or the daemon stopping. */
  onUnanswered: (message: string) => void;
};

/** What the session tools need from the thread manager. */
export interface SessionTools {
  list(): Promise<{ threadId: string; title?: string; cwd?: string; updatedAt?: number; status?: string }[]>;
  read(threadId: string, limit: number): Promise<string>;
}

export type LiveThreadOptions = {
  threadId: string;
  cwd: string;
  claude: ClaudeBinary;
  env: Record<string, string>;
  mode: 'new' | 'resume';
  resumeAt?: string;
  model?: string;
  fallbackModel?: string;
  effort?: EffortLevel;
  permissionMode?: PermissionMode;
  fastMode?: boolean;
  thinking?: ThinkingSetting;
  additionalDirectories?: string[];
  systemPromptAppend?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  mcpServers?: Record<string, unknown>;
  agent?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  betas?: string[];
  title?: string;
  /** Have Claude Code name the chat when it has no title (`thread/start`'s `generateTitle`). */
  generateTitle?: boolean;
  /** The last seq an earlier stream of this thread used; this one numbers above it. */
  seqAfter?: number;
  /** Called when the thread's query process has exited and it can be unloaded. */
  onExit?: (t: LiveThread) => void;
  /** Tools for the host's other sessions, when the client asked for them. */
  sessionTools?: SessionTools;
  /** Set for a scheduled run, which nobody is there to answer. */
  unattended?: Unattended;
  stderr?: (text: string) => void;
  /** The daemon's log. */
  log?: (msg: string) => void;
};

/**
 * Logs every raw `task_*` message: what the CLI reports of background tasks and workflows isn't
 * documented, and this is how to see it. `TETHER_DEBUG_TASKS=1` in the daemon's environment.
 */
const DEBUG_TASKS = !!process.env.TETHER_DEBUG_TASKS;
/** \`TETHER_DEBUG_MESSAGES=1\`: every SDK message but streamed deltas, for capturing what a feature sends. */
const DEBUG_MESSAGES = !!process.env.TETHER_DEBUG_MESSAGES;

const MAX_BUFFERED_EVENTS = 20_000;

/** The in-process MCP server the session tools are served from, and the tools it registers. */
const SESSION_TOOL_SERVER = 'tether';
const SESSION_TOOLS = { list: 'list_sessions', read: 'read_session', suggest: 'suggest_task' } as const;

/**
 * The session tools as the CLI names them. These, and only on a thread that has them, run without
 * asking: they read and suggest, never change anything. Any other `mcp__tether__…` tool, such as
 * one from a project's own MCP server called `tether`, is asked about like every other tool.
 */
export const SESSION_TOOL_NAMES: ReadonlySet<string> = new Set(
  Object.values(SESSION_TOOLS).map((name) => `mcp__${SESSION_TOOL_SERVER}__${name}`),
);

const SCOPE_DESTINATION = {
  session: 'session',
  project: 'projectSettings',
  local: 'localSettings',
  user: 'userSettings',
} as const;

export class LiveThread {
  readonly id: string;
  readonly cwd: string;
  status: ThreadStatus = 'starting';
  activity: 'requesting' | 'compacting' | null = null;
  lastActivityAt = Date.now();
  private titleCheck?: ReturnType<typeof setTimeout>;
  /** Whether to have Claude Code name the chat (`nameChat`), and whether it has been asked to while loaded. */
  private generateTitle: boolean;
  private titleAsked = false;
  init?: SDKControlInitializeResponse;

  private q!: Query;
  private input = new PushQueue<SDKUserMessage>();
  private itemizer = new Itemizer();
  private seq: number;
  private buffer: BufferedEvent[] = [];
  private subscribers = new Set<Subscriber>();
  private pending = new Map<string, PendingRequest>();
  private info: Omit<ThreadInfo, 'threadId' | 'status' | 'lastSeq' | 'cwd'> = {};
  private exited = false;
  /** Background tasks that count as work (not ambient watchers), as the CLI last reported them. */
  private backgroundTasks = new Set<string>();
  /** Whether the client asked for session tools on this thread; only then are they allowed. */
  private readonly sessionToolsEnabled: boolean;

  /** The `claude` this thread runs, for a catalog that could share it. */
  get claudePath(): string {
    return this.opts.claude.path;
  }

  constructor(private opts: LiveThreadOptions) {
    this.id = opts.threadId;
    this.cwd = opts.cwd;
    this.sessionToolsEnabled = !!opts.sessionTools;
    this.generateTitle = !!opts.generateTitle;
    this.seq = seqOrigin(opts.seqAfter);
    if (opts.model) this.info.model = opts.model;
    if (opts.effort) this.info.effort = opts.effort;
    if (opts.permissionMode) this.info.permissionMode = opts.permissionMode;
    if (opts.title) this.info.title = opts.title;
    // Found on disk only for an agent the CLI hasn't reported yet; the session's folder may not exist until then.
    this.itemizer.locateWorkflowAgent = workflowAgentLocator(() => sessionDirSync(this.id));
    this.itemizer.locateWorkflowCall = workflowCallLocator(() => sessionDirSync(this.id));
    this.itemizer.readRunResult = runResultReader(() => sessionDirSync(this.id));
  }

  /** A dynamic workflow this thread is running or ran while loaded, by its run id. */
  workflowByRun(runId: string) {
    return this.itemizer.workflowByRun(runId);
  }

  // ---------- lifecycle ----------

  async start(): Promise<void> {
    const o = this.opts;
    const options: Options = {
      pathToClaudeCodeExecutable: o.claude.path,
      cwd: o.cwd,
      env: { ...process.env, ...o.env, CLAUDE_AGENT_SDK_CLIENT_APP: `tether/${TETHER_VERSION}` },
      includePartialMessages: true,
      enableFileCheckpointing: true,
      promptSuggestions: true,
      settingSources: ['user', 'project', 'local'],
      systemPrompt: o.systemPromptAppend
        ? { type: 'preset', preset: 'claude_code', append: o.systemPromptAppend }
        : { type: 'preset', preset: 'claude_code' },
      thinking: o.thinking ? toSdkThinking(o.thinking) : { type: 'adaptive', display: 'summarized' },
      canUseTool: (toolName, input, ctx) => this.canUseTool(toolName, input, ctx),
      onElicitation: (req, ctx) => this.onElicitation(req, ctx.signal) as any,
      onUserDialog: (req, ctx) => this.onUserDialog(req, ctx.signal) as any,
      supportedDialogKinds: ['refusal_fallback_prompt'],
      perTaskStopAffordance: true,
      stderr: (data) => {
        o.stderr?.(data);
        this.emit('thread/stderr', { text: data });
      },
      ...(o.mode === 'new' ? { sessionId: o.threadId } : { resume: o.threadId }),
      ...(o.resumeAt ? { resumeSessionAt: o.resumeAt } : {}),
      ...(o.model ? { model: o.model } : {}),
      ...(o.fallbackModel ? { fallbackModel: o.fallbackModel } : {}),
      ...(o.effort ? { effort: o.effort } : {}),
      ...(o.permissionMode ? { permissionMode: o.permissionMode } : {}),
      ...(o.permissionMode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {}),
      ...(o.additionalDirectories?.length ? { additionalDirectories: o.additionalDirectories } : {}),
      ...(o.allowedTools ? { allowedTools: o.allowedTools } : {}),
      ...(o.disallowedTools ? { disallowedTools: o.disallowedTools } : {}),
      ...(o.mcpServers || o.sessionTools
        ? {
            mcpServers: {
              ...((o.mcpServers ?? {}) as Options['mcpServers']),
              ...(o.sessionTools ? { [SESSION_TOOL_SERVER]: this.sessionToolServer(o.sessionTools) } : {}),
            },
          }
        : {}),
      ...(o.agent ? { agent: o.agent } : {}),
      ...(o.maxTurns ? { maxTurns: o.maxTurns } : {}),
      ...(o.maxBudgetUsd ? { maxBudgetUsd: o.maxBudgetUsd } : {}),
      ...(o.betas ? { betas: o.betas as Options['betas'] } : {}),
      ...(o.title ? { title: o.title } : {}),
    };
    this.q = query({ prompt: this.input, options });
    void this.pump();
    try {
      this.init = await this.q.initializationResult();
    } catch (e) {
      this.setStatus('error');
      throw new RpcError(ErrorCodes.sdkError, `claude failed to start: ${(e as Error).message}`);
    }
    this.info.permissionMode = (this.init as any).current_permission_mode ?? this.info.permissionMode;
    this.info.fastModeState = (this.init as any).fast_mode_state;
    if ((this.init as any).fast_mode_disabled_reason)
      this.info.fastModeDisabledReason = (this.init as any).fast_mode_disabled_reason;
    this.info.outputStyle = this.init.output_style;
    if (o.fastMode !== undefined) await this.q.applyFlagSettings({ fastMode: o.fastMode });
    await this.readAppliedEffort();
    this.setStatus('idle');
  }

  get query(): Query {
    return this.q;
  }

  get isExited() {
    return this.exited;
  }

  get hasPendingRequests() {
    return this.pending.size > 0;
  }

  /** A background command or agent is still running, though the turn that started it has ended. */
  get hasBackgroundWork() {
    return this.backgroundTasks.size > 0;
  }

  /** How many background commands and agents are running. */
  get backgroundTaskCount() {
    return this.backgroundTasks.size;
  }

  /** An unattended thread waiting on a person, with no client subscribed to be that person. */
  get waitingUnattended() {
    return !!this.opts.unattended && this.pending.size > 0 && this.subscribers.size === 0;
  }

  /** Records on an unattended thread that it was stopped while it waited on a person. */
  abandonUnattended(why: string) {
    const p = this.pending.values().next().value;
    if (this.opts.unattended && p) this.opts.unattended.onUnanswered(`${why} while it waited for ${describeRequest(p)}.`);
  }

  close() {
    clearTimeout(this.titleCheck);
    this.input.end();
    try {
      this.q?.close();
    } catch {}
  }

  private async pump() {
    try {
      for await (const msg of this.q) this.onMessage(msg);
    } catch (e) {
      this.emitAll(
        this.itemizer.ingest({
          type: 'assistant',
          error: 'process_error',
          message: { id: `err_${Date.now()}`, content: [{ type: 'text', text: (e as Error).message }] },
        }),
      );
    } finally {
      this.exited = true;
      // The CLI's background tasks die with it, and a new process starts with none.
      this.backgroundTasks.clear();
      this.emitAll(this.itemizer.abandonAll());
      this.emit('task/backgroundChanged', { tasks: [] });
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new RpcError(ErrorCodes.requestCancelled, 'thread closed'));
      }
      this.pending.clear();
      this.setStatus('closed');
      this.emit('thread/closed', {});
      this.opts.onExit?.(this);
    }
  }

  // ---------- SDK messages ----------

  private onMessage(msg: SDKMessage) {
    this.lastActivityAt = Date.now();
    const m = msg as any;
    if (DEBUG_TASKS && m.type === 'system' && typeof m.subtype === 'string' && m.subtype.startsWith('task_'))
      this.opts.log?.(`thread ${this.id} ${m.subtype}: ${JSON.stringify(m)}`);
    else if (DEBUG_MESSAGES && m.type !== 'stream_event')
      this.opts.log?.(`thread ${this.id} message ${m.type}${m.subtype ? '/' + m.subtype : ''}: ${JSON.stringify(m).slice(0, 4000)}`);
    if (m.type === 'system') {
      if (m.subtype === 'init') {
        Object.assign(this.info, {
          model: m.model,
          permissionMode: m.permissionMode,
          tools: m.tools,
          slashCommands: m.slash_commands,
          skills: m.skills,
          agents: m.agents,
          outputStyle: m.output_style,
          claudeCodeVersion: m.claude_code_version,
          mcpServers: (m.mcp_servers ?? []).map((s: any) => ({ name: s.name, status: s.status, source: s.source })),
          ...(m.fast_mode_state ? { fastModeState: m.fast_mode_state } : {}),
          ...(m.effort !== undefined ? { effort: m.effort } : {}),
          ...(m.capabilities ? { capabilities: m.capabilities } : {}),
        });
        this.emit('thread/updated', { thread: this.threadInfo() });
        return;
      }
      if (m.subtype === 'status') {
        this.activity = m.status ?? null;
        if (m.permissionMode && m.permissionMode !== this.info.permissionMode) {
          this.info.permissionMode = m.permissionMode;
          this.emit('thread/updated', { thread: this.threadInfo() });
        }
        this.emitStatus();
        return;
      }
      if (m.subtype === 'background_tasks_changed' && Array.isArray(m.tasks)) {
        // Replace, don't pair edges: this is the CLI's full current set.
        const before = this.backgroundTasks.size;
        this.backgroundTasks = new Set(m.tasks.filter((t: any) => !t.ambient).map((t: any) => String(t.task_id)));
        // Clients show a chat with background work as working, though its turn has ended.
        if (this.backgroundTasks.size !== before) this.emitStatus();
      }
      if (m.subtype === 'session_state_changed') {
        if (m.state === 'idle' && this.pending.size === 0 && !this.itemizer.currentTurn) this.setStatus('idle');
        else if (m.state === 'requires_action') this.setStatus('requiresAction');
        else if (m.state === 'running' && this.pending.size === 0) this.setStatus('running');
        return;
      }
    }
    const out = this.itemizer.ingest(m);
    if (out.some((e) => e.method === 'turn/started') && this.status !== 'requiresAction') this.setStatus('running');
    this.emitAll(out);
    if (m.type === 'result') {
      this.activity = null;
      if (this.pending.size === 0) this.setStatus('idle');
      this.lookForTitle();
      if (this.generateTitle) void this.nameChat();
    }
  }

  /**
   * Has Claude Code name the chat from its first prompt (`prompt`, for one that hasn't reached
   * its file yet) and keep the name in its file: once while loaded, as soon as there is a prompt.
   * Claude Code answers with the title the chat already has, if it has one, without asking a model.
   */
  async nameChat(prompt?: string) {
    if (this.titleAsked) return;
    this.generateTitle = true;
    prompt ||= (await getSessionInfo(this.id, { dir: this.cwd }).catch(() => undefined))?.firstPrompt;
    // A chat started without a prompt is named once a turn has given it one.
    if (!prompt || this.titleAsked) return;
    this.titleAsked = true;
    const title: string | null = await (this.q as any)
      .generateSessionTitle(prompt, { persist: true })
      .catch((e: Error) => {
        const text = `couldn't name the chat: ${e.message}\n`;
        this.opts.stderr?.(text);
        this.emit('thread/stderr', { text });
        return null;
      });
    if (title && title !== this.info.title) {
      clearTimeout(this.titleCheck);
      this.info.title = title;
      this.emit('thread/updated', { thread: this.threadInfo() });
    }
  }

  /**
   * Claude Code names a session a moment after a turn ends, by writing an `ai-title` into its
   * file, and tells no SDK client: so after each turn the title is looked for a few times, and
   * sent with `thread/updated` once it's new. Its first prompt, which the SDK falls back to,
   * isn't a title.
   */
  private lookForTitle(delays = [1000, 2500, 5000, 10000, 20000]) {
    clearTimeout(this.titleCheck);
    const [delay, ...rest] = delays;
    if (delay === undefined) return;
    this.titleCheck = setTimeout(async () => {
      const s = await getSessionInfo(this.id, { dir: this.cwd }).catch(() => undefined);
      const title = s?.customTitle ?? (s && s.summary !== s.firstPrompt ? s.summary : undefined);
      if (title && title !== this.info.title) {
        this.info.title = title;
        this.emit('thread/updated', { thread: this.threadInfo() });
      } else {
        this.lookForTitle(rest);
      }
    }, delay);
  }

  // ---------- events / replay ----------

  emit<N extends NotificationName>(method: N, body: NotificationBody<N>) {
    const params = { threadId: this.id, seq: ++this.seq, ...body } as Record<string, unknown>;
    this.buffer.push({ seq: this.seq, method, params });
    if (this.buffer.length > MAX_BUFFERED_EVENTS) this.buffer.splice(0, this.buffer.length - MAX_BUFFERED_EVENTS);
    for (const s of this.subscribers) s.notify(method, params);
  }

  private emitAll(out: Emission[]) {
    for (const e of out) this.emit(e.method, e.body as any);
  }

  private setStatus(status: ThreadStatus) {
    if (this.status === status) return;
    this.status = status;
    this.emitStatus();
  }

  private emitStatus() {
    this.emit('thread/status/changed', {
      status: this.status,
      activity: this.activity,
      backgroundTasks: this.backgroundTasks.size,
    });
  }

  threadInfo(): ThreadInfo {
    return { threadId: this.id, status: this.status, cwd: this.cwd, lastSeq: this.seq, ...this.info };
  }

  /** Attach a client. Replays buffered events after `afterSeq` and re-sends pending requests. */
  subscribe(sub: Subscriber, afterSeq?: number): { replayed: number; gap: boolean } {
    let replayed = 0;
    let gap = false;
    if (afterSeq !== undefined) {
      gap = replayGap(afterSeq, this.buffer[0]?.seq, this.seq);
      for (const e of this.buffer) {
        if (e.seq > afterSeq) {
          sub.notify(e.method, e.params);
          replayed++;
        }
      }
    }
    this.subscribers.add(sub);
    for (const p of this.pending.values()) this.sendPendingTo(p, sub);
    return { replayed, gap };
  }

  unsubscribe(sub: Subscriber) {
    this.subscribers.delete(sub);
  }

  get subscriberCount() {
    return this.subscribers.size;
  }

  history() {
    return this.itemizer.snapshot();
  }

  // ---------- input ----------

  send(content: UserInput[], priority?: 'now' | 'next' | 'later'): { turnId: string; messageId: string; queued: boolean } {
    if (this.exited) throw new RpcError(ErrorCodes.threadNotLoaded, 'thread process has exited; resume it first');
    const messageId = randomUUID();
    const queued = this.itemizer.currentTurn !== null;
    const { turnId, out } = this.itemizer.beginUserTurn(messageId, content, queued);
    this.itemizer.noteSentUserMessage(messageId);
    this.emitAll(out);
    if (!queued) this.setStatus('running');
    const msg: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content: toContentBlocks(content, this.cwd) },
      parent_tool_use_id: null,
      uuid: messageId as SDKUserMessage['uuid'],
      origin: { kind: 'human' } as any,
      ...(queued ? { priority: priority ?? 'next' } : {}),
    };
    this.input.push(msg);
    return { turnId, messageId, queued };
  }

  async interrupt(cancelQueued?: boolean) {
    this.itemizer.noteInterruptRequested();
    for (const p of [...this.pending.values()]) this.resolvePending(p, null, 'cancelled');
    const receipt: any = cancelQueued
      ? await (this.q as any).interrupt({ cancel_queued: true }).catch(() => this.q.interrupt())
      : await this.q.interrupt();
    return { stillQueued: receipt?.still_queued as string[] | undefined };
  }

  // ---------- settings ----------

  async setModel(model: string | null) {
    await this.q.setModel(model ?? undefined);
    this.info.model = model ?? undefined;
    // Each model has its own default effort.
    await this.readAppliedEffort();
    this.emit('thread/updated', { thread: this.threadInfo() });
  }

  async setEffort(effort: EffortLevel | null) {
    await this.q.applyFlagSettings({ effortLevel: effort });
    this.info.effort = effort;
    await this.readAppliedEffort();
    this.emit('thread/updated', { thread: this.threadInfo() });
  }

  /**
   * The effort Claude Code sends, chosen or its default for the model, as `appliedEffort`. Left
   * unknown on a Claude Code without get_settings.
   */
  private async readAppliedEffort() {
    try {
      const applied = (await (this.q as any).getSettings?.())?.applied;
      if (applied && 'effort' in applied) this.info.appliedEffort = applied.effort ?? null;
    } catch {}
  }

  async setFastMode(enabled: boolean) {
    await this.q.applyFlagSettings({ fastMode: enabled });
    this.info.fastModeState = enabled ? 'on' : 'off';
    this.emit('thread/updated', { thread: this.threadInfo() });
  }

  async setPermissionMode(mode: PermissionMode) {
    await this.q.setPermissionMode(mode);
    this.info.permissionMode = mode;
    this.emit('thread/updated', { thread: this.threadInfo() });
  }

  async setThinking(t: ThinkingSetting) {
    if (t.type === 'disabled') await this.q.setMaxThinkingTokens(0);
    else if (t.type === 'enabled') await this.q.setMaxThinkingTokens(t.budgetTokens ?? 16_000, 'summarized');
    else await this.q.setMaxThinkingTokens(null, 'summarized');
  }

  // ---------- server → client requests ----------

  private requestClients<N extends ServerRequestName>(
    method: N,
    body: Omit<ServerRequestParams<N>, 'threadId' | 'requestId'>,
    signal?: AbortSignal,
  ): Promise<ServerRequestResult<N> | null> {
    const requestId = `req_${randomUUID()}`;
    const params = { threadId: this.id, requestId, ...body } as Record<string, unknown>;
    return new Promise((resolve, reject) => {
      const p: PendingRequest = {
        requestId,
        method,
        params,
        resolve: resolve as (v: unknown) => void,
        reject,
        sentTo: new Set(),
      };
      this.pending.set(requestId, p);
      this.setStatus('requiresAction');
      signal?.addEventListener('abort', () => this.resolvePending(p, null, 'cancelled'), { once: true });
      if (this.opts.unattended) this.armDeadline(p, this.opts.unattended);
      for (const s of this.subscribers) this.sendPendingTo(p, s);
    });
  }

  /** Denies an unattended thread's request once it has waited its time with nobody subscribed. */
  private armDeadline(p: PendingRequest, u: Unattended) {
    p.timer = setTimeout(() => {
      if (!this.pending.has(p.requestId)) return;
      // Someone is looking at it: theirs to answer, however long they take.
      if (this.subscribers.size > 0) return this.armDeadline(p, u);
      u.onUnanswered(`No one answered its request for ${describeRequest(p)} within ${duration(u.requestTimeoutMs)}, so it was denied.`);
      const denial =
        p.method === 'permission/request'
          ? { decision: 'deny', message: 'No one was there to answer: this is a scheduled run nobody is watching.', interrupt: true }
          : null;
      this.resolvePending(p, denial, 'cancelled');
    }, u.requestTimeoutMs);
    p.timer.unref?.();
  }

  private sendPendingTo(p: PendingRequest, sub: Subscriber) {
    if (p.sentTo.has(sub)) return;
    p.sentTo.add(sub);
    sub.request(p.method, p.params, p.requestId).then(
      (result) => this.resolvePending(p, result, 'answered'),
      () => p.sentTo.delete(sub), // that client went away or was cancelled; others (or a future one) may answer
    );
  }

  private resolvePending(p: PendingRequest, result: unknown, reason: 'answered' | 'cancelled') {
    if (!this.pending.has(p.requestId)) return;
    this.pending.delete(p.requestId);
    clearTimeout(p.timer);
    for (const s of p.sentTo) s.cancelRequest(p.requestId);
    p.resolve(result);
    this.emit('serverRequest/resolved', { requestId: p.requestId, reason });
    if (this.pending.size === 0 && this.status === 'requiresAction')
      this.setStatus(this.itemizer.currentTurn ? 'running' : 'idle');
  }

  /** The session tools as an in-process MCP server named `tether`. */
  private sessionToolServer(tools: SessionTools) {
    const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
    return createSdkMcpServer({
      name: SESSION_TOOL_SERVER,
      instructions:
        "Tools for the user's other Claude Code chats on this machine. Read another chat only when it helps with this one. Use suggest_task for work that belongs in a chat of its own; the user decides whether to start it.",
      tools: [
        tool(SESSION_TOOLS.list, "List the user's other chats on this machine, most recent first: id, title, folder, status.", {}, async () =>
          text(JSON.stringify((await tools.list()).filter((s) => s.threadId !== this.id))),
        ),
        tool(
          SESSION_TOOLS.read,
          "Read another chat's recent messages, as text.",
          { sessionId: z.string(), limit: z.number().int().min(1).max(100).optional() },
          async (a) => text(await tools.read(a.sessionId, a.limit ?? 30)),
        ),
        tool(
          SESSION_TOOLS.suggest,
          'Suggest a separate task to the user. It appears as a button that starts it in a new chat with this prompt.',
          { title: z.string(), prompt: z.string(), cwd: z.string().optional() },
          async (a) => {
            this.emit('thread/taskSuggested', { title: a.title, prompt: a.prompt, ...(a.cwd ? { cwd: a.cwd } : {}) });
            return text('Suggested to the user.');
          },
        ),
      ],
    });
  }

  private async canUseTool(
    toolName: string,
    input: Record<string, unknown>,
    ctx: Parameters<NonNullable<Options['canUseTool']>>[2],
  ): Promise<PermissionResult> {
    if (this.sessionToolsEnabled && SESSION_TOOL_NAMES.has(toolName)) return { behavior: 'allow', updatedInput: input };
    const deny = (message: string, interrupt?: boolean): PermissionResult => {
      this.itemizer.noteDenied(ctx.toolUseID, message);
      return { behavior: 'deny', message, ...(interrupt ? { interrupt } : {}) };
    };

    if (toolName === 'AskUserQuestion') {
      const r = await this.requestClients(
        'question/request',
        { toolUseId: ctx.toolUseID, questions: ((input as any).questions ?? []) as any },
        ctx.signal,
      );
      if (!r || r.decision === 'decline') return deny(r?.message ?? 'The user declined to answer.');
      return { behavior: 'allow', updatedInput: { ...input, answers: r.answers } };
    }

    if (toolName === 'ExitPlanMode') {
      const plan = typeof (input as any).plan === 'string' ? (input as any).plan : '';
      const planFilePath = (input as any).planFilePath as string | undefined;
      const r = await this.requestClients(
        'plan/approve',
        { toolUseId: ctx.toolUseID, plan, ...(planFilePath ? { planFilePath } : {}) },
        ctx.signal,
      );
      if (!r) return deny('Plan approval was cancelled.', true);
      if (r.decision === 'reject')
        return deny(r.feedback ? `The user rejected the plan: ${r.feedback}` : 'The user rejected the plan.');
      const mode = r.permissionMode ?? 'default';
      this.info.permissionMode = mode;
      queueMicrotask(() => this.emit('thread/updated', { thread: this.threadInfo() }));
      return { behavior: 'allow', updatedInput: input, updatedPermissions: [{ type: 'setMode', mode, destination: 'session' }] };
    }

    const r = await this.requestClients(
      'permission/request',
      {
        toolUseId: ctx.toolUseID,
        toolName,
        input,
        ...(ctx.title ? { title: ctx.title } : {}),
        ...(ctx.displayName ? { displayName: ctx.displayName } : {}),
        ...(ctx.description ? { description: ctx.description } : {}),
        ...(ctx.decisionReason ? { decisionReason: ctx.decisionReason } : {}),
        ...(ctx.blockedPath ? { blockedPath: ctx.blockedPath } : {}),
        ...(ctx.suggestions?.length ? { suggestions: ctx.suggestions } : {}),
        ...(ctx.defaultToNo ? { defaultToNo: true } : {}),
        ...(ctx.suppressAlwaysAllowRule ? { suppressAlwaysAllowRule: true } : {}),
        ...(ctx.agentID ? { agentId: ctx.agentID } : {}),
        ...(ctx.mcpServer ? { mcpServer: ctx.mcpServer } : {}),
      },
      ctx.signal,
    );
    if (!r) return deny('Permission request was cancelled.', true);
    if (r.decision === 'deny') return deny(r.message || 'The user denied this action.', r.interrupt);
    const updatedInput = (r.updatedInput as Record<string, unknown> | undefined) ?? input;
    const scope = r.scope ?? 'once';
    if (scope === 'once' || ctx.suppressAlwaysAllowRule) return { behavior: 'allow', updatedInput };
    const destination = SCOPE_DESTINATION[scope];
    const suggestions: PermissionUpdate[] = ctx.suggestions?.length
      ? ctx.suggestions.map((s) => ({ ...s, destination }))
      : [{ type: 'addRules', rules: [{ toolName }], behavior: 'allow', destination }];
    return { behavior: 'allow', updatedInput, updatedPermissions: suggestions };
  }

  private async onElicitation(req: any, signal: AbortSignal) {
    const r = await this.requestClients(
      'elicitation/request',
      {
        serverName: req.serverName,
        message: req.message,
        ...(req.mode ? { mode: req.mode } : {}),
        ...(req.url ? { url: req.url } : {}),
        ...(req.requestedSchema ? { requestedSchema: req.requestedSchema } : {}),
      },
      signal,
    );
    return r ?? { action: 'cancel' };
  }

  private async onUserDialog(req: any, signal: AbortSignal) {
    const r = await this.requestClients(
      'dialog/request',
      { dialogKind: req.dialogKind, payload: req.payload, ...(req.toolUseID ? { toolUseId: req.toolUseID } : {}) },
      signal,
    );
    return r ?? { behavior: 'cancelled' };
  }
}

/** What a request asks of a person, for an unattended run's record. */
function describeRequest(p: Pick<PendingRequest, 'method' | 'params'>): string {
  switch (p.method) {
    case 'permission/request':
      return `permission to use ${String(p.params.displayName ?? p.params.toolName)}`;
    case 'question/request':
      return 'an answer to a question';
    case 'plan/approve':
      return 'approval of its plan';
    case 'elicitation/request':
      return `input for ${String(p.params.serverName)}`;
    default:
      return 'a decision';
  }
}

function duration(ms: number): string {
  const unit = (n: number, what: string) => `${n} ${what}${n === 1 ? '' : 's'}`;
  return ms >= 60_000 ? unit(Math.round(ms / 60_000), 'minute') : unit(Math.max(1, Math.round(ms / 1000)), 'second');
}

function toSdkThinking(t: ThinkingSetting): Options['thinking'] {
  if (t.type === 'disabled') return { type: 'disabled' };
  if (t.type === 'enabled') return { type: 'enabled', budgetTokens: t.budgetTokens, display: 'summarized' };
  return { type: 'adaptive', display: 'summarized' };
}

/** Tether UserInput → Anthropic content blocks. fileRef becomes an @-mention, which Claude Code expands. */
function toContentBlocks(content: UserInput[], cwd: string): any[] {
  const blocks: any[] = [];
  let text = '';
  for (const c of content) {
    if (c.type === 'text') text += (text ? '\n' : '') + c.text;
    else if (c.type === 'fileRef') text += `${text && !text.endsWith(' ') ? ' ' : ''}@${c.path}`;
    else if (c.type === 'image') blocks.push({ type: 'image', source: { type: 'base64', media_type: c.mediaType, data: c.data } });
    else if (c.type === 'document' && c.data)
      blocks.push({ type: 'document', source: { type: 'base64', media_type: c.mediaType, data: c.data }, ...(c.name ? { title: c.name } : {}) });
  }
  if (text) blocks.unshift({ type: 'text', text });
  return blocks;
}

