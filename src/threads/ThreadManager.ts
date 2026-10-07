import {
  deleteSession,
  forkSession,
  getSessionInfo,
  getSessionMessages,
  listSessions,
  query,
  renameSession,
  tagSession,
  type Query,
  type SDKControlInitializeResponse,
  type SDKSessionInfo,
  type SDKUserMessage,
  filterEscalatingDefaultMode,
} from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'node:crypto';
import { type ClaudeBinary, resolveClaude } from '../claude.ts';
import { PermissionMode, type Item, type Params, type Result, type ScheduledTask, type ThreadSummary, type Turn } from '../protocol/index.ts';
import type { Scheduler } from './Scheduler.ts';
import { ErrorCodes, RpcError } from '../rpc/connection.ts';
import { createWorktree, removeWorktree, worktreeName } from '../server/fsApi.ts';
import { Itemizer } from './itemizer.ts';
import { FollowedThread, ingestHistory, TranscriptExtras, transcriptCwd, transcriptSettings, type SessionSettings } from './FollowedThread.ts';
import { LiveThread, TETHER_VERSION, type LiveThreadOptions } from './LiveThread.ts';
import { PushQueue } from './pushQueue.ts';
import { isSafeId, readAgentItems, readRunJournal, readRunRecord, sessionDirSync, workflowAgentLocator } from './workflows.ts';
import type { WorkflowSnapshot } from '../protocol/index.ts';

const IDLE_EVICT_MS = Number(process.env.TETHER_IDLE_EVICT_MS ?? 30 * 60_000);
/** How long a scheduled run waits, with nobody watching, for a person to answer before it's denied. */
const SCHEDULED_REQUEST_TIMEOUT_MS = Number(process.env.TETHER_SCHEDULED_REQUEST_TIMEOUT_MS ?? 10 * 60_000);
const CATALOG_TTL_MS = 5 * 60_000;

type Catalog = { q: Query; input: PushQueue<SDKUserMessage>; init: Promise<SDKControlInitializeResponse>; lastUsed: number };

export class ThreadManager {
  readonly threads = new Map<string, LiveThread>();
  private starting = new Map<string, Promise<LiveThread>>();
  private catalogs = new Map<string, Catalog>();
  /** `defaults` changes a catalog session's model to ask about another, so it asks one at a time. */
  private asking = new WeakMap<Query, Promise<unknown>>();
  /** The model a catalog session started on, the host's own, to go back to after asking. */
  private hostModels = new WeakMap<Query, string>();
  private sweeper: ReturnType<typeof setInterval>;
  readonly startedAt = Date.now();
  /** Set by the daemon; invoked once a requested shutdown can proceed without killing work. */
  onDrainRequest?: () => void;
  private draining = false;
  /** Each thread's last seq from a stream that has ended, so the next one numbers above it. */
  private lastSeqs = new Map<string, number>();

  private retire(t: { id: string; threadInfo(): { lastSeq: number } }) {
    this.lastSeqs.set(t.id, Math.max(this.lastSeqs.get(t.id) ?? 0, t.threadInfo().lastSeq));
  }

  constructor(
    readonly claude: ClaudeBinary,
    private log: (msg: string) => void = () => {},
  ) {
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    this.sweeper.unref?.();
  }

  // ---------- live threads ----------

  get(threadId: string): LiveThread {
    const t = this.threads.get(threadId);
    if (!t || t.isExited) throw new RpcError(ErrorCodes.threadNotLoaded, `thread ${threadId} is not loaded`);
    return t;
  }

  loaded(threadId: string): LiveThread | undefined {
    const t = this.threads.get(threadId);
    return t && !t.isExited ? t : undefined;
  }

  // ---------- followed threads ----------

  /** Sessions another client owns, read from their transcripts on disk. */
  private followed = new Map<string, FollowedThread>();

  following(threadId: string): FollowedThread | undefined {
    return this.followed.get(threadId);
  }

  /** Follow a session this daemon did not start. A thread loaded here emits its own events. */
  async follow(threadId: string, cwd?: string): Promise<FollowedThread | undefined> {
    if (this.loaded(threadId)) return undefined;
    const existing = this.followed.get(threadId);
    if (existing) return existing;
    const info = await sessionInfo(threadId, cwd);
    const dir = cwd ?? info?.cwd;
    if (!dir) return undefined;
    const follower = new FollowedThread(threadId, dir, this.lastSeqs.get(threadId));
    this.followed.set(threadId, follower);
    await follower.start();
    this.log(`following ${threadId} in ${dir}`);
    return follower;
  }

  /** Drops a follower once nothing is watching it, or once the thread is loaded here instead. */
  unfollow(threadId: string) {
    const f = this.followed.get(threadId);
    if (!f) return;
    this.retire(f);
    f.close();
    this.followed.delete(threadId);
  }

  /**
   * The environment the last client to connect with one asked threads to run with (say
   * AWS_PROFILE), for scheduled runs, which have no client of their own. Kept in memory only, as it
   * can hold credentials: a daemon starts when a client connects, and that client sends it.
   */
  private clientEnv: Record<string, string> = {};

  noteClientEnv(env: Record<string, string>) {
    this.clientEnv = { ...env };
  }

  async start(
    p: Params<'thread/start'>,
    env: Record<string, string>,
    extra: Pick<LiveThreadOptions, 'unattended'> = {},
  ): Promise<LiveThread> {
    const threadId = randomUUID();
    // Before the worktree, which a missing claude would otherwise leave behind.
    const claude = await this.runnable({ ...env, ...(p.env ?? {}) });
    // Asked for no permission mode, a thread a person starts starts as an interactive session
    // would: the SDK's own start is always `default`. A scheduled run keeps that.
    if (!p.permissionMode && !extra.unattended) {
      const d = await this.defaults(p.cwd, { ...env, ...(p.env ?? {}) }, p.model).catch(() => undefined);
      if (d) p = { ...p, permissionMode: d.permissionMode };
    }
    const worktree = p.worktree ? await createWorktree(p.cwd, worktreeName(threadId)) : undefined;
    const cwd = worktree?.cwd ?? p.cwd;
    const t = new LiveThread({
      ...p,
      cwd,
      sessionTools: p.sessionTools ? this.sessionTools : undefined,
      threadId,
      claude,
      env: { ...env, ...(p.env ?? {}) },
      mode: 'new',
      log: this.log,
      ...extra,
      onExit: (lt) => this.onExit(lt),
    });
    this.threads.set(threadId, t);
    try {
      await t.start();
    } catch (e) {
      this.threads.delete(threadId);
      t.close();
      // Made for this thread alone, a moment ago: nothing in it to keep.
      if (worktree)
        await removeWorktree(worktree.path, { force: true, discardCommits: true }).catch((err) =>
          this.log(`couldn't remove the worktree of a thread that failed to start: ${(err as Error).message}`),
        );
      throw e;
    }
    // Named while its first turn runs, as Claude Code names a chat it isn't told not to.
    if (p.generateTitle) void t.nameChat(p.input?.flatMap((i) => (i.type === 'text' ? [i.text] : [])).join('\n'));
    this.log(`thread ${threadId} started in ${cwd}`);
    return t;
  }

  /** The daemon's scheduled tasks; absent in `serve --stdio`, which would run them twice. */
  scheduler?: Scheduler;

  /**
   * A scheduled task's run: a new thread in its folder, sent its prompt, with the environment
   * clients last asked for. Nobody is there to answer it, so what it asks a person is denied after
   * a while, and `onUnanswered` told why.
   */
  async startScheduled(task: ScheduledTask, onUnanswered?: (threadId: string, message: string) => void): Promise<string> {
    const t: LiveThread = await this.start(
      { cwd: task.cwd, title: task.name, ...(task.model ? { model: task.model } : {}), ...(task.permissionMode ? { permissionMode: task.permissionMode } : {}) },
      this.clientEnv,
      { unattended: { requestTimeoutMs: SCHEDULED_REQUEST_TIMEOUT_MS, onUnanswered: (message) => onUnanswered?.(t.id, message) } },
    );
    t.send([{ type: 'text', text: task.prompt }]);
    return t.id;
  }

  /** Load a stored session into a live query (no-op if already loaded). */
  async resume(p: Params<'thread/resume'>, env: Record<string, string>): Promise<LiveThread> {
    // A live thread supersedes the follower; both would report the same items.
    this.unfollow(p.threadId);
    const existing = this.loaded(p.threadId);
    if (existing && !p.atMessageId) {
      if (p.generateTitle) void existing.nameChat();
      return existing;
    }
    if (existing && p.atMessageId) {
      if (existing.status === 'running' || existing.hasPendingRequests)
        throw new RpcError(ErrorCodes.invalidRequest, 'cannot rewind a running thread; interrupt it first');
      this.retire(existing);
      existing.close();
      this.threads.delete(p.threadId);
    }
    const inflight = this.starting.get(p.threadId);
    if (inflight) return inflight;
    const promise = (async () => {
      const info = await sessionInfo(p.threadId, p.cwd);
      if (!info) throw new RpcError(ErrorCodes.threadNotFound, `no session ${p.threadId}`);
      const cwd = p.cwd ?? info.cwd;
      if (!cwd) throw new RpcError(ErrorCodes.invalidParams, 'session has no recorded cwd; pass cwd');
      const settings = resumeSettings(p, p.model && p.effort && p.permissionMode ? {} : await transcriptSettings(p.threadId));
      const t = new LiveThread({
        threadId: p.threadId,
        cwd,
        claude: await this.runnable({ ...env, ...(p.env ?? {}) }),
        env: { ...env, ...(p.env ?? {}) },
        mode: 'resume',
        seqAfter: this.lastSeqs.get(p.threadId),
        ...(p.atMessageId ? { resumeAt: p.atMessageId } : {}),
        ...(p.sessionTools ? { sessionTools: this.sessionTools } : {}),
        ...(p.generateTitle ? { generateTitle: true } : {}),
        ...settings,
        title: info.customTitle ?? info.summary,
        log: this.log,
        onExit: (lt) => this.onExit(lt),
      });
      this.threads.set(p.threadId, t);
      try {
        await t.start();
      } catch (e) {
        this.threads.delete(p.threadId);
        t.close();
        throw e;
      }
      this.log(`thread ${p.threadId} resumed in ${cwd}`);
      if (p.generateTitle) void t.nameChat();
      return t;
    })();
    this.starting.set(p.threadId, promise);
    try {
      return await promise;
    } finally {
      this.starting.delete(p.threadId);
    }
  }

  close(threadId: string) {
    this.unfollow(threadId);
    const t = this.threads.get(threadId);
    if (!t) return;
    this.retire(t);
    t.close();
    this.threads.delete(threadId);
  }

  private onExit(t: LiveThread) {
    this.retire(t);
    if (this.threads.get(t.id) === t) this.threads.delete(t.id);
    this.log(`thread ${t.id} exited`);
  }

  get busy(): boolean {
    for (const t of this.threads.values()) {
      if (t.isExited) continue;
      // A scheduled run waiting on a person nobody's watching would only be denied in the end.
      if (t.waitingUnattended && !t.hasBackgroundWork) continue;
      if (t.status === 'running' || t.status === 'requiresAction' || t.status === 'starting' || t.hasPendingRequests || t.hasBackgroundWork)
        return true;
    }
    return false;
  }

  /**
   * Graceful shutdown for upgrades: never kills a running or waiting turn, though a scheduled run
   * waiting on nobody doesn't count. No scheduled task starts meanwhile; the next daemon runs what
   * came due.
   */
  requestShutdown(): boolean {
    this.draining = true;
    this.scheduler?.stop();
    if (this.busy) return false;
    setTimeout(() => this.onDrainRequest?.(), 50);
    return true;
  }

  /**
   * Unload idle threads nobody is watching. Running or waiting threads are never evicted, nor is one
   * whose background command or agent is still going: closing the query would kill it.
   */
  private sweep() {
    const now = Date.now();
    if (this.draining && !this.busy) this.onDrainRequest?.();
    for (const t of this.threads.values()) {
      if (
        t.status === 'idle' &&
        !t.hasPendingRequests &&
        !t.hasBackgroundWork &&
        t.subscriberCount === 0 &&
        now - t.lastActivityAt > IDLE_EVICT_MS
      ) {
        this.log(`evicting idle thread ${t.id}`);
        this.close(t.id);
      }
    }
    for (const [key, c] of this.catalogs) {
      if (now - c.lastUsed > CATALOG_TTL_MS) {
        c.input.end();
        c.q.close();
        this.catalogs.delete(key);
      }
    }
  }

  shutdown() {
    for (const t of this.threads.values()) if (t.waitingUnattended) t.abandonUnattended('Tether stopped');
    this.scheduler?.stop();
    clearInterval(this.sweeper);
    for (const t of this.threads.values()) t.close();
    for (const c of this.catalogs.values()) c.q.close();
    this.threads.clear();
    this.catalogs.clear();
  }

  /**
   * `claude` for a client whose host sends `env` (Settings ▸ Hosts ▸ Environment): looked up again
   * only when that names it (`TETHER_CLAUDE_PATH`) or sets `PATH`, and otherwise the daemon's own.
   */
  claudeFor(env: Record<string, string>): Promise<ClaudeBinary> {
    // The daemon's own, unless it had none when it started: installed since, it's found now.
    if (!env.TETHER_CLAUDE_PATH && !env.PATH && this.claude.path) return Promise.resolve(this.claude);
    return resolveClaude({ ...process.env, ...env });
  }

  /** `claude` to run something with, or why there isn't one. */
  async runnable(env: Record<string, string>): Promise<ClaudeBinary> {
    const claude = await this.claudeFor(env);
    if (claude.path) return claude;
    throw new RpcError(
      ErrorCodes.sdkError,
      env.TETHER_CLAUDE_PATH
        ? `TETHER_CLAUDE_PATH (${env.TETHER_CLAUDE_PATH}) isn't an executable file on this host.`
        : "`claude` isn't on this host's PATH or its login shell's. Install Claude Code, or name it with TETHER_CLAUDE_PATH in the host's environment.",
    );
  }

  // ---------- catalog (models, commands, account) without starting a turn ----------

  /** `ownSession`: never a thread's session, for a question that changes the session it asks. */
  async catalog(
    cwd: string | undefined,
    env: Record<string, string>,
    opts: { ownSession?: boolean } = {},
  ): Promise<{ init: SDKControlInitializeResponse; q: Query }> {
    const dir = cwd ?? process.env.HOME ?? '/';
    const claude = await this.runnable(env);
    if (!opts.ownSession)
      for (const t of this.threads.values())
        if (t.cwd === dir && t.claudePath === claude.path && t.init && !t.isExited) return { init: t.init, q: t.query };
    // Per claude as well as directory: one client's host can name a different one.
    const key = `${dir}\0${claude.path}`;
    let c = this.catalogs.get(key);
    if (!c) {
      const input = new PushQueue<SDKUserMessage>();
      const q = query({
        prompt: input,
        options: {
          pathToClaudeCodeExecutable: claude.path,
          cwd: dir,
          env: { ...process.env, ...env, CLAUDE_AGENT_SDK_CLIENT_APP: `tether/${TETHER_VERSION}` },
          settingSources: ['user', 'project', 'local'],
          persistSession: false,
        },
      });
      c = { q, input, init: q.initializationResult(), lastUsed: Date.now() };
      this.catalogs.set(key, c);
      c.init.catch(() => this.catalogs.delete(key));
      void (async () => {
        try {
          for await (const _ of q);
        } catch {}
        this.catalogs.delete(key);
      })();
    }
    c.lastUsed = Date.now();
    return { init: await c.init, q: c.q };
  }

  /**
   * What a new thread in `cwd` starts with when nothing is chosen (`session/defaults`): the model
   * and the effort Claude Code would send it, as its own settings on the host decide, and the
   * permission mode an interactive session starts in. Asked of a catalog session, whose model is
   * set to `model` for the question and put back after; never a thread's session.
   */
  async defaults(cwd: string | undefined, env: Record<string, string>, model?: string): Promise<Result<'session/defaults'>> {
    const { q, init } = await this.catalog(cwd, env, { ownSession: true });
    const ask = async (): Promise<Result<'session/defaults'>> => {
      // An older Claude Code has no get_settings: nothing is known but the SDK's own start.
      const getSettings = (q as any).getSettings?.bind(q);
      if (!getSettings) return { effort: null, permissionMode: 'default' };
      let host = this.hostModels.get(q);
      if (host === undefined) {
        host = ((await getSettings()).applied?.model as string | undefined) ?? '';
        this.hostModels.set(q, host);
      }
      // Through the flag settings layer: setModel checks the model with a request to the provider.
      const other = !!model && model !== host;
      if (other) await q.applyFlagSettings({ model });
      try {
        const s = await getSettings();
        const applied = (s.applied ?? {}) as { model?: string; effort?: Result<'session/defaults'>['effort'] };
        const id = applied.model ?? model;
        const info = init.models.find((m) => m.value === model || m.value === id || (m as any).resolvedModel === id);
        return {
          ...(applied.model ? { model: applied.model } : {}),
          effort: applied.effort ?? null,
          permissionMode: startingPermissionMode(filterEscalatingDefaultMode(s), info),
        };
      } finally {
        if (other) await q.applyFlagSettings({ model: host || null });
      }
    };
    const next = (this.asking.get(q) ?? Promise.resolve()).then(ask, ask);
    this.asking.set(q, next.catch(() => {}));
    return next;
  }

  // ---------- stored sessions ----------

  async list(p: Params<'thread/list'>): Promise<ThreadSummary[]> {
    const sessions = await listSessions({
      ...(p.cwd ? { dir: p.cwd } : {}),
      ...(p.limit ? { limit: p.limit } : {}),
      ...(p.offset ? { offset: p.offset } : {}),
      ...(p.includeWorktrees ? { includeWorktrees: true } : {}),
    });
    return (await Promise.all(sessions.map(withCwd))).map((s) => this.summary(s));
  }

  summary(s: SDKSessionInfo): ThreadSummary {
    const live = this.loaded(s.sessionId);
    return {
      threadId: s.sessionId,
      title: s.customTitle ?? s.summary,
      ...(s.customTitle ? { customTitle: s.customTitle } : {}),
      ...(s.firstPrompt ? { firstPrompt: s.firstPrompt } : {}),
      ...(s.cwd ? { cwd: s.cwd } : {}),
      ...(s.gitBranch ? { gitBranch: s.gitBranch } : {}),
      ...(s.tag ? { tag: s.tag } : {}),
      ...(s.createdAt ? { createdAt: s.createdAt } : {}),
      updatedAt: s.lastModified,
      status: live ? live.status : 'notLoaded',
      ...(live ? { backgroundTasks: live.backgroundTaskCount } : {}),
    };
  }

  async projects(limit?: number) {
    const sessions = await Promise.all((await listSessions({ limit: 2000 })).map(withCwd));
    const byCwd = new Map<string, { cwd: string; lastActivity: number; threadCount: number }>();
    for (const s of sessions) {
      if (!s.cwd) continue;
      const p = byCwd.get(s.cwd) ?? { cwd: s.cwd, lastActivity: 0, threadCount: 0 };
      p.threadCount++;
      p.lastActivity = Math.max(p.lastActivity, s.lastModified);
      byCwd.set(s.cwd, p);
    }
    return [...byCwd.values()].sort((a, b) => b.lastActivity - a.lastActivity).slice(0, limit ?? 200);
  }

  /** Transcript → items. A live thread answers from its own itemizer so in-flight state is included. */
  async read(
    threadId: string,
    cwd?: string,
    page?: { limit?: number; before?: string },
  ): Promise<{ items: Item[]; turns: Turn[]; summary?: ThreadSummary; historySeq?: number; hasMore?: boolean }> {
    const info = await sessionInfo(threadId, cwd);
    const live = this.loaded(threadId);
    const summary = info ? this.summary(info) : undefined;
    if (!live) {
      // Follow on read, not subscribe: the seq handed back has to come from the follower that
      // will replay to the client after it.
      const follower = this.following(threadId) ?? (await this.follow(threadId, cwd));
      if (follower) {
        const snap = follower.history();
        return {
          ...pageOf(snap.items, page),
          turns: snap.turns,
          historySeq: snap.seq,
          ...(summary ? { summary } : {}),
        };
      }
      const storedOnly = await this.readStored(threadId, cwd);
      return { ...pageOf(storedOnly.items, page), turns: storedOnly.turns, ...(summary ? { summary } : {}) };
    }
    const stored = await this.storedBeforeLoad(live, cwd);
    // Snapshot and seq are taken together so replay after historySeq never duplicates.
    const liveSnap = live.history();
    const historySeq = live.threadInfo().lastSeq;
    const { items, turns } = mergeHistory(stored, liveSnap);
    return { ...pageOf(items, page), turns, historySeq, ...(summary ? { summary } : {}) };
  }

  /**
   * A live thread's transcript as it was on disk when first read. Everything written since comes
   * from the thread itself, so this is parsed once rather than once per page.
   */
  private storedSnapshots = new WeakMap<LiveThread, Promise<{ items: Item[]; turns: Turn[] }>>();

  private storedBeforeLoad(live: LiveThread, cwd?: string) {
    let snap = this.storedSnapshots.get(live);
    if (!snap) {
      snap = this.readStored(live.id, cwd);
      this.storedSnapshots.set(live, snap);
      snap.catch(() => this.storedSnapshots.delete(live));
    }
    return snap;
  }

  /** For session tools: the host's sessions, and one's recent messages as text. */
  readonly sessionTools = {
    list: async () =>
      (await this.list({ limit: 30 })).map((s) => ({
        threadId: s.threadId,
        title: s.customTitle ?? s.title,
        ...(s.cwd ? { cwd: s.cwd } : {}),
        updatedAt: s.updatedAt,
        status: s.status,
      })),
    read: async (threadId: string, limit: number) => {
      const { items } = await this.readStored(threadId);
      const lines = items.flatMap((i) => {
        if (i.type === 'userMessage' && !i.synthetic)
          return [`User: ${i.content.map((c) => (c.type === 'text' ? c.text : '')).join(' ').trim()}`];
        if (i.type === 'agentMessage' && i.parentToolUseId === null && i.text) return [`Claude: ${i.text}`];
        return [];
      });
      return lines.slice(-limit).join('\n\n') || 'That chat has no messages yet.';
    },
  };

  private async readStored(threadId: string, cwd?: string) {
    const msgs = await getSessionMessages(threadId, { ...(cwd ? { dir: cwd } : {}), includeSystemMessages: true });
    const iz = new Itemizer(Date.now, true);
    iz.locateWorkflowAgent = workflowAgentLocator(() => sessionDirSync(threadId));
    const dir = sessionDirSync(threadId);
    const queued = new TranscriptExtras();
    if (dir) await queued.readFile(`${dir}.jsonl`);
    ingestHistory(iz, msgs, queued);
    iz.closeTurn('completed');
    return iz.snapshot();
  }

  // ---------- dynamic workflows ----------

  /**
   * A workflow run of the thread: the live thread's own snapshot while it has one (with the run
   * record's result or error once there is one), else the CLI's run record, else its journal,
   * whose status is unknown.
   */
  async readWorkflow(threadId: string, runId: string): Promise<WorkflowSnapshot | null> {
    if (!isSafeId(threadId) || !isSafeId(runId)) throw new RpcError(ErrorCodes.invalidParams, 'invalid thread or run id');
    const live = this.loaded(threadId)?.workflowByRun(runId);
    const dir = sessionDirSync(threadId);
    const record = dir ? await readRunRecord(dir, runId) : undefined;
    if (live)
      return {
        ...live,
        ...(record?.result && !live.result ? { result: record.result } : {}),
        ...(record?.error && !live.error ? { error: record.error } : {}),
      };
    if (record) return record;
    return (dir ? await readRunJournal(dir, runId) : undefined) ?? null;
  }

  async workflowAgentItems(threadId: string, runId: string, agentId: string): Promise<Item[]> {
    if (!isSafeId(threadId) || !isSafeId(runId) || !isSafeId(agentId))
      throw new RpcError(ErrorCodes.invalidParams, 'invalid thread, run or agent id');
    const dir = sessionDirSync(threadId);
    return dir ? readAgentItems(dir, runId, agentId) : [];
  }

  async fork(threadId: string, atMessageId?: string, title?: string) {
    const r = await forkSession(threadId, { ...(atMessageId ? { upToMessageId: atMessageId } : {}), ...(title ? { title } : {}) });
    return r.sessionId;
  }

  rename(threadId: string, title: string) {
    return renameSession(threadId, title);
  }

  tag(threadId: string, tag: string | null) {
    return tagSession(threadId, tag);
  }

  async delete(threadId: string) {
    this.close(threadId);
    await deleteSession(threadId);
  }
}

type Snapshot = { items: Item[]; turns: Turn[] };

/**
 * A live thread's transcript: what was on disk when it loaded, then what it has done since. Where
 * both have an item the live one wins, since the stored copy can predate its tool result. A stored
 * turn no item belongs to any more is dropped: the transcript splits a message sent mid-turn into a
 * turn of its own, where the live thread (and so the item) keeps it in the turn it steered.
 */
export function mergeHistory(stored: Snapshot, live: Snapshot): Snapshot {
  const liveById = new Map(live.items.map((i) => [i.id, i]));
  const storedIds = new Set(stored.items.map((i) => i.id));
  const items = [...stored.items.map((i) => liveById.get(i.id) ?? i), ...live.items.filter((i) => !storedIds.has(i.id))];
  const used = new Set(items.map((i) => i.turnId));
  const liveTurns = new Set(live.turns.map((t) => t.id));
  const turns = [...stored.turns.filter((t) => !liveTurns.has(t.id) && used.has(t.id)), ...live.turns];
  return { items, turns };
}

/**
 * The requested window of a transcript, from the end. Pages are over items, not messages on
 * disk: itemizing a slice of messages alone would lose the turn each item belongs to.
 */
function pageOf(items: Item[], page?: { limit?: number; before?: string }): { items: Item[]; hasMore: boolean } {
  let end = items.length;
  if (page?.before) {
    const i = items.findIndex((x) => x.id === page.before);
    if (i >= 0) end = i;
  }
  const start = page?.limit ? Math.max(0, end - page.limit) : 0;
  return { items: items.slice(start, end), hasMore: start > 0 };
}

/** A session's info with its cwd, which the SDK can miss (see `transcriptCwd`). */
async function sessionInfo(threadId: string, cwd?: string): Promise<SDKSessionInfo | undefined> {
  const info = await getSessionInfo(threadId, cwd ? { dir: cwd } : undefined);
  return info && withCwd(info);
}

async function withCwd(s: SDKSessionInfo): Promise<SDKSessionInfo> {
  if (s.cwd) return s;
  const cwd = await transcriptCwd(s.sessionId);
  return cwd ? { ...s, cwd } : s;
}

/**
 * What a resumed session runs with: what the client asked for, else what it last ran with. The
 * CLI's own resume starts over at the default effort and permission mode. A recorded effort goes
 * with the recorded model, so it is dropped when the client picks another.
 */
export function resumeSettings(
  asked: { model?: string; effort?: SessionSettings['effort']; permissionMode?: SessionSettings['permissionMode'] },
  recorded: SessionSettings,
): SessionSettings {
  const model = asked.model ?? recorded.model;
  const effort = asked.effort ?? (model === recorded.model ? recorded.effort : undefined);
  const permissionMode = asked.permissionMode ?? recorded.permissionMode;
  return { ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(permissionMode ? { permissionMode } : {}) };
}

/**
 * The permission mode an interactive Claude Code session starts in: the settings'
 * `permissions.defaultMode` (after the CLI's trust filter, so a repo-committed escalating mode
 * doesn't count), else auto where the model supports it and no setting disables it, else default.
 */
export function startingPermissionMode(
  settings: { permissions?: { defaultMode?: string }; disableAutoMode?: string },
  model?: { supportsAutoMode?: boolean },
): PermissionMode {
  const mode = settings.permissions?.defaultMode;
  // The CLI's alias for default.
  if (mode === 'manual') return 'default';
  const known = PermissionMode.safeParse(mode);
  if (known.success) return known.data;
  if (settings.disableAutoMode === 'disable') return 'default';
  return model?.supportsAutoMode ? 'auto' : 'default';
}
