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
} from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'node:crypto';
import type { ClaudeBinary } from '../claude.ts';
import type { Item, Params, ThreadSummary, Turn } from '../protocol/index.ts';
import { ErrorCodes, RpcError } from '../rpc/connection.ts';
import { Itemizer } from './itemizer.ts';
import { FollowedThread } from './FollowedThread.ts';
import { LiveThread, TETHER_VERSION } from './LiveThread.ts';
import { PushQueue } from './pushQueue.ts';

const IDLE_EVICT_MS = Number(process.env.TETHER_IDLE_EVICT_MS ?? 30 * 60_000);
const CATALOG_TTL_MS = 5 * 60_000;

type Catalog = { q: Query; input: PushQueue<SDKUserMessage>; init: Promise<SDKControlInitializeResponse>; lastUsed: number };

export class ThreadManager {
  readonly threads = new Map<string, LiveThread>();
  private starting = new Map<string, Promise<LiveThread>>();
  private catalogs = new Map<string, Catalog>();
  private sweeper: ReturnType<typeof setInterval>;
  readonly startedAt = Date.now();
  /** Set by the daemon; invoked once a requested shutdown can proceed without killing work. */
  onDrainRequest?: () => void;
  private draining = false;

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
    const info = await getSessionInfo(threadId, cwd ? { dir: cwd } : undefined);
    const dir = cwd ?? info?.cwd;
    if (!dir) return undefined;
    const follower = new FollowedThread(threadId, dir);
    this.followed.set(threadId, follower);
    await follower.start();
    this.log(`following ${threadId} in ${dir}`);
    return follower;
  }

  /** Drops a follower once nothing is watching it, or once the thread is loaded here instead. */
  unfollow(threadId: string) {
    const f = this.followed.get(threadId);
    if (!f) return;
    f.close();
    this.followed.delete(threadId);
  }

  async start(p: Params<'thread/start'>, env: Record<string, string>): Promise<LiveThread> {
    const threadId = randomUUID();
    const t = new LiveThread({
      ...p,
      threadId,
      claude: this.claude,
      env: { ...env, ...(p.env ?? {}) },
      mode: 'new',
      onExit: (lt) => this.onExit(lt),
    });
    this.threads.set(threadId, t);
    try {
      await t.start();
    } catch (e) {
      this.threads.delete(threadId);
      t.close();
      throw e;
    }
    this.log(`thread ${threadId} started in ${p.cwd}`);
    return t;
  }

  /** Load a stored session into a live query (no-op if already loaded). */
  async resume(p: Params<'thread/resume'>, env: Record<string, string>): Promise<LiveThread> {
    // A live thread supersedes the follower; both would report the same items.
    this.unfollow(p.threadId);
    const existing = this.loaded(p.threadId);
    if (existing && !p.atMessageId) return existing;
    if (existing && p.atMessageId) {
      if (existing.status === 'running' || existing.hasPendingRequests)
        throw new RpcError(ErrorCodes.invalidRequest, 'cannot rewind a running thread; interrupt it first');
      existing.close();
      this.threads.delete(p.threadId);
    }
    const inflight = this.starting.get(p.threadId);
    if (inflight) return inflight;
    const promise = (async () => {
      const info = await getSessionInfo(p.threadId, p.cwd ? { dir: p.cwd } : undefined);
      if (!info) throw new RpcError(ErrorCodes.threadNotFound, `no session ${p.threadId}`);
      const cwd = p.cwd ?? info.cwd;
      if (!cwd) throw new RpcError(ErrorCodes.invalidParams, 'session has no recorded cwd; pass cwd');
      const t = new LiveThread({
        threadId: p.threadId,
        cwd,
        claude: this.claude,
        env: { ...env, ...(p.env ?? {}) },
        mode: 'resume',
        ...(p.atMessageId ? { resumeAt: p.atMessageId } : {}),
        ...(p.model ? { model: p.model } : {}),
        ...(p.effort ? { effort: p.effort } : {}),
        ...(p.permissionMode ? { permissionMode: p.permissionMode } : {}),
        title: info.customTitle ?? info.summary,
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
    t.close();
    this.threads.delete(threadId);
  }

  private onExit(t: LiveThread) {
    if (this.threads.get(t.id) === t) this.threads.delete(t.id);
    this.log(`thread ${t.id} exited`);
  }

  get busy(): boolean {
    for (const t of this.threads.values())
      if (!t.isExited && (t.status === 'running' || t.status === 'requiresAction' || t.status === 'starting' || t.hasPendingRequests))
        return true;
    return false;
  }

  /** Graceful shutdown for upgrades: never kills a running or waiting turn. */
  requestShutdown(): boolean {
    this.draining = true;
    if (this.busy) return false;
    setTimeout(() => this.onDrainRequest?.(), 50);
    return true;
  }

  /** Unload idle threads nobody is watching. Running or waiting threads are never evicted. */
  private sweep() {
    const now = Date.now();
    if (this.draining && !this.busy) this.onDrainRequest?.();
    for (const t of this.threads.values()) {
      if (t.status === 'idle' && !t.hasPendingRequests && t.subscriberCount === 0 && now - t.lastActivityAt > IDLE_EVICT_MS) {
        this.log(`evicting idle thread ${t.id}`);
        this.close(t.id);
      }
    }
    for (const [cwd, c] of this.catalogs) {
      if (now - c.lastUsed > CATALOG_TTL_MS) {
        c.input.end();
        c.q.close();
        this.catalogs.delete(cwd);
      }
    }
  }

  shutdown() {
    clearInterval(this.sweeper);
    for (const t of this.threads.values()) t.close();
    for (const c of this.catalogs.values()) c.q.close();
    this.threads.clear();
    this.catalogs.clear();
  }

  // ---------- catalog (models, commands, account) without starting a turn ----------

  async catalog(cwd: string | undefined, env: Record<string, string>): Promise<{ init: SDKControlInitializeResponse; q: Query }> {
    const dir = cwd ?? process.env.HOME ?? '/';
    for (const t of this.threads.values()) if (t.cwd === dir && t.init && !t.isExited) return { init: t.init, q: t.query };
    let c = this.catalogs.get(dir);
    if (!c) {
      const input = new PushQueue<SDKUserMessage>();
      const q = query({
        prompt: input,
        options: {
          pathToClaudeCodeExecutable: this.claude.path,
          cwd: dir,
          env: { ...process.env, ...env, CLAUDE_AGENT_SDK_CLIENT_APP: `tether/${TETHER_VERSION}` },
          settingSources: ['user', 'project', 'local'],
          persistSession: false,
        },
      });
      c = { q, input, init: q.initializationResult(), lastUsed: Date.now() };
      this.catalogs.set(dir, c);
      c.init.catch(() => this.catalogs.delete(dir));
      void (async () => {
        try {
          for await (const _ of q);
        } catch {}
        this.catalogs.delete(dir);
      })();
    }
    c.lastUsed = Date.now();
    return { init: await c.init, q: c.q };
  }

  // ---------- stored sessions ----------

  async list(p: Params<'thread/list'>): Promise<ThreadSummary[]> {
    const sessions = await listSessions({
      ...(p.cwd ? { dir: p.cwd } : {}),
      ...(p.limit ? { limit: p.limit } : {}),
      ...(p.offset ? { offset: p.offset } : {}),
      ...(p.includeWorktrees ? { includeWorktrees: true } : {}),
    });
    return sessions.map((s) => this.summary(s));
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
    };
  }

  async projects(limit?: number) {
    const sessions = await listSessions({ limit: 2000 });
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
    const info = await getSessionInfo(threadId, cwd ? { dir: cwd } : undefined);
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
    // Live itemizer only knows events since load; stored history covers everything before.
    // Snapshot and seq are taken together so replay after historySeq never duplicates. Where both
    // have an item the live one wins: the stored copy can predate its tool result.
    const liveSnap = live.history();
    const historySeq = live.threadInfo().lastSeq;
    const liveById = new Map(liveSnap.items.map((i) => [i.id, i]));
    const storedIds = new Set(stored.items.map((i) => i.id));
    const items = [
      ...stored.items.map((i) => liveById.get(i.id) ?? i),
      ...liveSnap.items.filter((i) => !storedIds.has(i.id)),
    ];
    const liveTurns = new Set(liveSnap.turns.map((t) => t.id));
    const turns = [...stored.turns.filter((t) => !liveTurns.has(t.id)), ...liveSnap.turns];
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

  private async readStored(threadId: string, cwd?: string) {
    const msgs = await getSessionMessages(threadId, { ...(cwd ? { dir: cwd } : {}), includeSystemMessages: true });
    const iz = new Itemizer(Date.now, true);
    for (const m of msgs) iz.ingest(m as any);
    iz.closeTurn('completed');
    return iz.snapshot();
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
