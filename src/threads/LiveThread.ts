import {
  query,
  type Options,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
  type SDKControlInitializeResponse,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'node:crypto';
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
import { PushQueue } from './pushQueue.ts';

export const TETHER_VERSION = '0.1.0';

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
};

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
  /** Called when the thread's query process has exited and it can be unloaded. */
  onExit?: (t: LiveThread) => void;
  stderr?: (text: string) => void;
};

const MAX_BUFFERED_EVENTS = 20_000;

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
  init?: SDKControlInitializeResponse;

  private q!: Query;
  private input = new PushQueue<SDKUserMessage>();
  private itemizer = new Itemizer();
  private seq = 0;
  private buffer: BufferedEvent[] = [];
  private subscribers = new Set<Subscriber>();
  private pending = new Map<string, PendingRequest>();
  private info: Omit<ThreadInfo, 'threadId' | 'status' | 'lastSeq' | 'cwd'> = {};
  private exited = false;

  constructor(private opts: LiveThreadOptions) {
    this.id = opts.threadId;
    this.cwd = opts.cwd;
    if (opts.model) this.info.model = opts.model;
    if (opts.effort) this.info.effort = opts.effort;
    if (opts.permissionMode) this.info.permissionMode = opts.permissionMode;
    if (opts.title) this.info.title = opts.title;
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
      ...(o.mcpServers ? { mcpServers: o.mcpServers as Options['mcpServers'] } : {}),
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

  close() {
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
      this.emitAll(this.itemizer.abandonTurn('interrupted'));
      for (const p of this.pending.values()) p.reject(new RpcError(ErrorCodes.requestCancelled, 'thread closed'));
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
    }
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
    this.emit('thread/status/changed', { status: this.status, activity: this.activity });
  }

  threadInfo(): ThreadInfo {
    return { threadId: this.id, status: this.status, cwd: this.cwd, lastSeq: this.seq, ...this.info };
  }

  /** Attach a client. Replays buffered events after `afterSeq` and re-sends pending requests. */
  subscribe(sub: Subscriber, afterSeq?: number): { replayed: number; gap: boolean } {
    let replayed = 0;
    let gap = false;
    if (afterSeq !== undefined) {
      const oldest = this.buffer[0]?.seq ?? this.seq + 1;
      gap = afterSeq + 1 < oldest && afterSeq < this.seq;
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
    this.emit('thread/updated', { thread: this.threadInfo() });
  }

  async setEffort(effort: EffortLevel | null) {
    await this.q.applyFlagSettings({ effortLevel: effort });
    this.info.effort = effort;
    this.emit('thread/updated', { thread: this.threadInfo() });
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
      for (const s of this.subscribers) this.sendPendingTo(p, s);
    });
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
    for (const s of p.sentTo) s.cancelRequest(p.requestId);
    p.resolve(result);
    this.emit('serverRequest/resolved', { requestId: p.requestId, reason });
    if (this.pending.size === 0 && this.status === 'requiresAction')
      this.setStatus(this.itemizer.currentTurn ? 'running' : 'idle');
  }

  private async canUseTool(
    toolName: string,
    input: Record<string, unknown>,
    ctx: Parameters<NonNullable<Options['canUseTool']>>[2],
  ): Promise<PermissionResult> {
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
  }
  if (text) blocks.unshift({ type: 'text', text });
  return blocks;
}

