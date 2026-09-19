import { hostname, arch, platform, homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Methods, PROTOCOL_VERSION, type MethodName, type Params, type Result } from '../protocol/index.ts';
import { Connection, ErrorCodes, RpcError } from '../rpc/connection.ts';
import type { LiveThread, Subscriber } from '../threads/LiveThread.ts';
import { TETHER_VERSION } from '../threads/LiveThread.ts';
import type { ThreadManager } from '../threads/ThreadManager.ts';
import * as fsApi from './fsApi.ts';

type Handler<M extends MethodName> = (p: Params<M>) => Promise<Result<M>> | Result<M>;

/** One client connection: handshake state, env overrides, thread subscriptions. */
export class ClientSession implements Subscriber {
  readonly id = randomUUID();
  private initialized = false;
  private env: Record<string, string> = {};
  private optOut = new Set<string>();
  private experimental = false;
  private subscriptions = new Map<string, LiveThread>();

  constructor(
    private conn: Connection,
    private mgr: ThreadManager,
    private mode: 'stdio' | 'daemon',
    private log: (m: string) => void = () => {},
  ) {}

  start() {
    this.conn.start({
      onRequest: (method, params) => this.dispatch(method, params),
      onNotification: (method) => {
        if (method === 'initialized') return;
      },
      onClose: () => {
        for (const t of this.subscriptions.values()) t.unsubscribe(this);
        this.subscriptions.clear();
        this.log(`client ${this.id} disconnected`);
      },
    });
  }

  // Subscriber
  notify(method: string, params: unknown) {
    if (!this.optOut.has(method)) this.conn.notify(method, params);
  }
  request(method: string, params: unknown, id: string) {
    return this.conn.request(method, params, id);
  }
  cancelRequest(id: string) {
    this.conn.cancelRequest(id);
  }

  private subscribe(t: LiveThread, afterSeq?: number) {
    const prev = this.subscriptions.get(t.id);
    if (prev && prev !== t) prev.unsubscribe(this);
    this.subscriptions.set(t.id, t);
    return t.subscribe(this, afterSeq);
  }

  private async dispatch(method: string, raw: unknown): Promise<unknown> {
    const spec = (Methods as Record<string, { params: any }>)[method];
    if (!spec) throw new RpcError(ErrorCodes.methodNotFound, `unknown method ${method}`);
    if (method !== 'initialize' && !this.initialized) throw new RpcError(ErrorCodes.notInitialized, 'Not initialized');
    const parsed = spec.params.safeParse(raw ?? {});
    if (!parsed.success) throw new RpcError(ErrorCodes.invalidParams, parsed.error.message);
    const handler = (this.handlers as Record<string, (p: unknown) => unknown>)[method];
    if (!handler) throw new RpcError(ErrorCodes.methodNotFound, `method ${method} not implemented`);
    return handler(parsed.data);
  }

  private experimentalOnly() {
    if (!this.experimental) throw new RpcError(ErrorCodes.invalidRequest, 'requires experimentalApi capability');
  }

  private handlers: { [M in MethodName]?: Handler<M> } = {
    initialize: (p) => {
      if (this.initialized) throw new RpcError(ErrorCodes.alreadyInitialized, 'Already initialized');
      this.initialized = true;
      this.env = p.env ?? {};
      this.experimental = !!p.capabilities?.experimentalApi;
      for (const m of p.capabilities?.optOutNotificationMethods ?? []) this.optOut.add(m);
      this.log(`client ${this.id} initialized: ${p.clientInfo.name} ${p.clientInfo.version}`);
      return {
        serverInfo: { name: 'tether', version: TETHER_VERSION },
        protocolVersion: PROTOCOL_VERSION,
        host: { hostname: hostname(), platform: platform(), arch: arch(), home: homedir(), pid: process.pid, mode: this.mode },
        claude: this.mgr.claude,
      };
    },

    'host/info': () => ({
      loadedThreads: this.mgr.threads.size,
      uptimeSeconds: (Date.now() - this.mgr.startedAt) / 1000,
      claude: this.mgr.claude,
    }),

    'host/requestShutdown': (p) => {
      this.log(`shutdown requested: ${p.reason ?? 'no reason'}`);
      if (this.mode !== 'daemon') return { accepted: false };
      return { accepted: this.mgr.requestShutdown() };
    },

    'account/read': async (p) => {
      const { q } = await this.mgr.catalog(p.cwd, this.env);
      return { account: await q.accountInfo() };
    },

    'account/usage': async (p) => {
      this.experimentalOnly();
      const { q } = await this.mgr.catalog(p.cwd, this.env);
      return { usage: await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }) };
    },

    'model/list': async (p) => {
      const { init } = await this.mgr.catalog(p.cwd, this.env);
      return { models: init.models as any };
    },

    'command/list': async (p) => {
      const q = p.threadId ? this.mgr.get(p.threadId).query : (await this.mgr.catalog(p.cwd, this.env)).q;
      const [cmds, init] = await Promise.all([q.supportedCommands(), q.initializationResult()]);
      const terminal = new Set<string>(((init as any).terminal_slash_commands as string[] | undefined) ?? []);
      return {
        commands: cmds.map((c: any) => ({
          name: c.name,
          description: c.description ?? '',
          ...(c.argumentHint ? { argumentHint: c.argumentHint } : {}),
          ...(terminal.has(c.name) ? { terminalOnly: true } : {}),
        })),
      };
    },

    'agent/list': async (p) => {
      const q = p.threadId ? this.mgr.get(p.threadId).query : (await this.mgr.catalog(p.cwd, this.env)).q;
      const agents = await q.supportedAgents();
      return {
        agents: agents.map((a: any) => ({ name: a.name, description: a.description ?? '', ...(a.model ? { model: a.model } : {}) })),
      };
    },

    'outputStyle/list': async (p) => {
      const { init } = await this.mgr.catalog(p.cwd, this.env);
      const i = init as any;
      return { current: i.output_style ?? 'default', available: i.available_output_styles ?? [] };
    },

    'project/list': async (p) => ({ projects: await this.mgr.projects(p.limit) }),

    'thread/list': async (p) => ({ threads: await this.mgr.list(p) }),

    'thread/start': async (p) => {
      const t = await this.mgr.start(p, this.env);
      this.subscribe(t, 0);
      if (p.input?.length) t.send(p.input);
      return { thread: t.threadInfo() };
    },

    'thread/resume': async (p) => {
      const t = await this.mgr.resume(p, this.env);
      const history = p.includeHistory ? await this.mgr.read(t.id, t.cwd) : undefined;
      this.subscribe(t, p.afterSeq ?? t.threadInfo().lastSeq);
      return { thread: t.threadInfo(), ...(history ? { items: history.items, turns: history.turns } : {}) };
    },

    'thread/fork': async (p) => ({ threadId: await this.mgr.fork(p.threadId, p.atMessageId, p.title) }),

    'thread/read': async (p) => this.mgr.read(p.threadId, p.cwd),

    'thread/subscribe': (p) => {
      const t = this.mgr.get(p.threadId);
      const r = this.subscribe(t, p.afterSeq);
      return { thread: t.threadInfo(), ...r };
    },

    'thread/unsubscribe': (p) => {
      this.subscriptions.get(p.threadId)?.unsubscribe(this);
      this.subscriptions.delete(p.threadId);
      return {};
    },

    'thread/loaded': () => ({ threads: [...this.mgr.threads.values()].filter((t) => !t.isExited).map((t) => t.threadInfo()) }),

    'thread/close': (p) => {
      this.mgr.close(p.threadId);
      return {};
    },

    'thread/rename': async (p) => {
      await this.mgr.rename(p.threadId, p.title);
      return {};
    },
    'thread/tag': async (p) => {
      await this.mgr.tag(p.threadId, p.tag);
      return {};
    },
    'thread/delete': async (p) => {
      await this.mgr.delete(p.threadId);
      return {};
    },

    'thread/setModel': async (p) => (await this.mgr.get(p.threadId).setModel(p.model), {}),
    'thread/setEffort': async (p) => (await this.mgr.get(p.threadId).setEffort(p.effort), {}),
    'thread/setFastMode': async (p) => (await this.mgr.get(p.threadId).setFastMode(p.enabled), {}),
    'thread/setThinking': async (p) => (await this.mgr.get(p.threadId).setThinking(p.thinking), {}),
    'thread/setPermissionMode': async (p) => (await this.mgr.get(p.threadId).setPermissionMode(p.mode), {}),
    'thread/applySettings': async (p) => (await this.mgr.get(p.threadId).query.applyFlagSettings(p.settings as any), {}),

    'thread/contextUsage': async (p) => ({
      usage: await this.mgr.get(p.threadId).query.getContextUsage({ detail: p.detail ?? 'summary' }),
    }),
    'thread/rewindFiles': async (p) => ({
      result: await this.mgr.get(p.threadId).query.rewindFiles(p.userMessageId, { dryRun: p.dryRun ?? false }),
    }),

    'turn/start': async (p) => {
      let t = this.mgr.loaded(p.threadId);
      if (!t) {
        t = await this.mgr.resume({ threadId: p.threadId }, this.env);
        this.subscribe(t, t.threadInfo().lastSeq);
      } else if (!this.subscriptions.has(t.id)) this.subscribe(t, t.threadInfo().lastSeq);
      return t.send(p.input, p.priority);
    },

    'turn/interrupt': async (p) => {
      const r = await this.mgr.get(p.threadId).interrupt(p.cancelQueued);
      return r.stillQueued ? { stillQueued: r.stillQueued } : {};
    },

    'task/stop': async (p) => (await this.mgr.get(p.threadId).query.stopTask(p.taskId), {}),
    'task/background': async (p) => ({ backgrounded: await this.mgr.get(p.threadId).query.backgroundTasks(p.toolUseId) }),

    'mcp/status': async (p) => ({
      servers: (await this.mgr.get(p.threadId).query.mcpServerStatus()).map((s: any) => ({
        name: s.name,
        status: s.status,
        ...(s.source ? { source: s.source } : {}),
        ...(s.error ? { error: s.error } : {}),
        ...(Array.isArray(s.tools) ? { toolCount: s.tools.length } : {}),
      })),
    }),
    'mcp/reconnect': async (p) => (await this.mgr.get(p.threadId).query.reconnectMcpServer(p.name), {}),
    'mcp/toggle': async (p) => (await this.mgr.get(p.threadId).query.toggleMcpServer(p.name, p.enabled), {}),
    'mcp/setServers': async (p) => ({ result: await this.mgr.get(p.threadId).query.setMcpServers(p.servers as any) }),

    'plugins/reload': async (p) => ({ result: await this.mgr.get(p.threadId).query.reloadPlugins() }),
    'skills/reload': async (p) => ({ result: await this.mgr.get(p.threadId).query.reloadSkills() }),
    'outputStyles/reload': async (p) => ({ result: await this.mgr.get(p.threadId).query.reloadOutputStyles() }),

    'settings/resolve': async (p) => {
      const { resolveSettings } = await import('@anthropic-ai/claude-agent-sdk');
      return { settings: await resolveSettings({ cwd: p.cwd } as any) };
    },

    'fs/list': (p) => fsApi.list(p.path, p.showHidden),
    'fs/read': (p) => fsApi.read(p.path, p.maxBytes),
    'fs/search': (p) => fsApi.search(p.cwd, p.query, p.limit),
    'git/status': (p) => fsApi.gitStatus(p.cwd),
    'git/diff': (p) => fsApi.gitDiff(p.cwd, p.path, p.staged),
  };
}
