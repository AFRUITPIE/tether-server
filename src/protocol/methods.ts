import { z } from 'zod';
import {
  AccountInfo,
  AgentInfo,
  EffortLevel,
  EnvOverrides,
  JsonValue,
  McpServerStatus,
  ModelInfo,
  PermissionMode,
  SlashCommand,
  ThinkingSetting,
  ThreadInfo,
  ThreadSummary,
  UserInput,
} from './common.ts';
import { Item, Turn } from './items.ts';

const Empty = z.object({});
const ThreadRef = z.object({ threadId: z.string() });

/** Client → server requests. Each entry: params and result schema. */
export const Methods = {
  initialize: {
    params: z.object({
      clientInfo: z.object({ name: z.string(), title: z.string().optional(), version: z.string() }),
      capabilities: z
        .object({
          experimentalApi: z.boolean().optional(),
          optOutNotificationMethods: z.array(z.string()).optional(),
        })
        .optional(),
      /** Env overrides applied to every thread this connection starts (e.g. AWS_PROFILE). */
      env: EnvOverrides.optional(),
    }),
    result: z.object({
      serverInfo: z.object({ name: z.string(), version: z.string() }),
      protocolVersion: z.number().int(),
      host: z.object({
        hostname: z.string(),
        platform: z.string(),
        arch: z.string(),
        home: z.string(),
        pid: z.number().int(),
        mode: z.enum(['stdio', 'daemon']),
      }),
      claude: z.object({ path: z.string(), version: z.string() }),
    }),
  },

  'host/info': {
    params: Empty,
    result: z.object({
      loadedThreads: z.number().int(),
      uptimeSeconds: z.number(),
      claude: z.object({ path: z.string(), version: z.string() }),
    }),
  },

  /** Ask the daemon to exit (used for upgrades). Accepted only when no thread is running or waiting on input; otherwise it exits once they settle. */
  'host/requestShutdown': {
    params: z.object({ reason: z.string().optional() }),
    result: z.object({ accepted: z.boolean() }),
  },

  'account/read': {
    params: z.object({ cwd: z.string().optional() }),
    result: z.object({ account: AccountInfo }),
  },

  'account/usage': {
    params: z.object({ cwd: z.string().optional() }),
    result: z.object({ usage: JsonValue }),
  },

  'model/list': {
    params: z.object({ cwd: z.string().optional() }),
    result: z.object({ models: z.array(ModelInfo) }),
  },

  'command/list': {
    params: z.object({ cwd: z.string().optional(), threadId: z.string().optional() }),
    result: z.object({ commands: z.array(SlashCommand) }),
  },

  'agent/list': {
    params: z.object({ cwd: z.string().optional(), threadId: z.string().optional() }),
    result: z.object({ agents: z.array(AgentInfo) }),
  },

  'outputStyle/list': {
    params: z.object({ cwd: z.string().optional() }),
    result: z.object({ current: z.string(), available: z.array(z.string()) }),
  },

  'project/list': {
    params: z.object({ limit: z.number().int().optional() }),
    result: z.object({
      projects: z.array(z.object({ cwd: z.string(), lastActivity: z.number(), threadCount: z.number().int() })),
    }),
  },

  'thread/list': {
    params: z.object({
      cwd: z.string().optional(),
      limit: z.number().int().optional(),
      offset: z.number().int().optional(),
      includeWorktrees: z.boolean().optional(),
    }),
    result: z.object({ threads: z.array(ThreadSummary) }),
  },

  'thread/start': {
    params: z.object({
      cwd: z.string(),
      model: z.string().optional(),
      fallbackModel: z.string().optional(),
      effort: EffortLevel.optional(),
      permissionMode: PermissionMode.optional(),
      fastMode: z.boolean().optional(),
      thinking: ThinkingSetting.optional(),
      additionalDirectories: z.array(z.string()).optional(),
      systemPromptAppend: z.string().optional(),
      allowedTools: z.array(z.string()).optional(),
      disallowedTools: z.array(z.string()).optional(),
      mcpServers: z.record(z.string(), JsonValue).optional(),
      agent: z.string().optional(),
      maxTurns: z.number().int().optional(),
      maxBudgetUsd: z.number().optional(),
      betas: z.array(z.string()).optional(),
      env: EnvOverrides.optional(),
      title: z.string().optional(),
      /** First user input, sent immediately after start. */
      input: z.array(UserInput).optional(),
    }),
    result: z.object({ thread: ThreadInfo }),
  },

  'thread/resume': {
    params: z.object({
      threadId: z.string(),
      cwd: z.string().optional(),
      /** Resume with history truncated after this message uuid (conversation rewind). */
      atMessageId: z.string().optional(),
      model: z.string().optional(),
      effort: EffortLevel.optional(),
      permissionMode: PermissionMode.optional(),
      env: EnvOverrides.optional(),
      /** Client already has events up to this seq; only newer events are replayed. */
      afterSeq: z.number().int().optional(),
      includeHistory: z.boolean().optional(),
      /** With `includeHistory`, only the most recent `limit` items, as `thread/read` pages them. */
      limit: z.number().int().positive().optional(),
    }),
    result: z.object({
      thread: ThreadInfo,
      items: z.array(Item).optional(),
      turns: z.array(Turn).optional(),
      /** Seq the history snapshot corresponds to; events after it are streamed. */
      historySeq: z.number().int().optional(),
      /** Whether older items exist before those returned. */
      hasMore: z.boolean().optional(),
    }),
  },

  'thread/fork': {
    params: z.object({ threadId: z.string(), atMessageId: z.string().optional(), title: z.string().optional() }),
    result: z.object({ threadId: z.string() }),
  },

  'thread/read': {
    params: z.object({
      threadId: z.string(),
      cwd: z.string().optional(),
      includeSubagents: z.boolean().optional(),
      /**
       * Return only the most recent `limit` items. Omit for the whole transcript. A session run
       * for days is tens of megabytes and tens of thousands of items; a client that only needs
       * the end of it should not be handed all of that.
       */
      limit: z.number().int().positive().optional(),
      /** Page backwards: the items immediately preceding this one. Use with `limit`. */
      before: z.string().optional(),
    }),
    result: z.object({
      items: z.array(Item),
      turns: z.array(Turn),
      summary: ThreadSummary.optional(),
      /** Present when the thread is loaded: the snapshot includes all events up to this seq. */
      historySeq: z.number().int().optional(),
      /** Whether older items exist before the first one returned. */
      hasMore: z.boolean().optional(),
    }),
  },

  'thread/subscribe': {
    params: z.object({ threadId: z.string(), afterSeq: z.number().int().optional() }),
    result: z.object({ thread: ThreadInfo, replayed: z.number().int(), gap: z.boolean() }),
  },
  'thread/unsubscribe': { params: ThreadRef, result: Empty },
  'thread/loaded': { params: Empty, result: z.object({ threads: z.array(ThreadInfo) }) },
  'thread/close': { params: ThreadRef, result: Empty },
  'thread/rename': { params: z.object({ threadId: z.string(), title: z.string() }), result: Empty },
  'thread/tag': { params: z.object({ threadId: z.string(), tag: z.string().nullable() }), result: Empty },
  'thread/delete': { params: ThreadRef, result: Empty },

  'thread/setModel': { params: z.object({ threadId: z.string(), model: z.string().nullable() }), result: Empty },
  'thread/setEffort': { params: z.object({ threadId: z.string(), effort: EffortLevel.nullable() }), result: Empty },
  'thread/setFastMode': { params: z.object({ threadId: z.string(), enabled: z.boolean() }), result: Empty },
  'thread/setThinking': { params: z.object({ threadId: z.string(), thinking: ThinkingSetting }), result: Empty },
  'thread/setPermissionMode': { params: z.object({ threadId: z.string(), mode: PermissionMode }), result: Empty },
  'thread/applySettings': {
    params: z.object({ threadId: z.string(), settings: z.record(z.string(), JsonValue) }),
    result: Empty,
  },

  'thread/contextUsage': {
    params: z.object({ threadId: z.string(), detail: z.enum(['summary', 'full']).optional() }),
    result: z.object({ usage: JsonValue }),
  },
  'thread/rewindFiles': {
    params: z.object({ threadId: z.string(), userMessageId: z.string(), dryRun: z.boolean().optional() }),
    result: z.object({ result: JsonValue }),
  },

  'turn/start': {
    params: z.object({
      threadId: z.string(),
      input: z.array(UserInput),
      /** If a turn is running: 'next' delivers at the next tool boundary, 'later' after the turn. */
      priority: z.enum(['now', 'next', 'later']).optional(),
    }),
    result: z.object({ turnId: z.string(), messageId: z.string(), queued: z.boolean() }),
  },
  'turn/interrupt': {
    params: z.object({ threadId: z.string(), cancelQueued: z.boolean().optional() }),
    result: z.object({ stillQueued: z.array(z.string()).optional() }),
  },

  'task/stop': { params: z.object({ threadId: z.string(), taskId: z.string() }), result: Empty },
  'task/background': {
    params: z.object({ threadId: z.string(), toolUseId: z.string().optional() }),
    result: z.object({ backgrounded: z.boolean() }),
  },

  'mcp/status': { params: ThreadRef, result: z.object({ servers: z.array(McpServerStatus) }) },
  'mcp/reconnect': { params: z.object({ threadId: z.string(), name: z.string() }), result: Empty },
  'mcp/toggle': { params: z.object({ threadId: z.string(), name: z.string(), enabled: z.boolean() }), result: Empty },
  'mcp/setServers': {
    params: z.object({ threadId: z.string(), servers: z.record(z.string(), JsonValue) }),
    result: z.object({ result: JsonValue }),
  },

  'plugins/reload': { params: ThreadRef, result: z.object({ result: JsonValue }) },
  'skills/reload': { params: ThreadRef, result: z.object({ result: JsonValue }) },
  'outputStyles/reload': { params: ThreadRef, result: z.object({ result: JsonValue }) },

  'settings/resolve': { params: z.object({ cwd: z.string() }), result: z.object({ settings: JsonValue }) },

  'fs/list': {
    params: z.object({ path: z.string(), showHidden: z.boolean().optional() }),
    result: z.object({
      entries: z.array(z.object({ name: z.string(), path: z.string(), isDirectory: z.boolean(), size: z.number() })),
    }),
  },
  'fs/read': {
    params: z.object({ path: z.string(), maxBytes: z.number().int().optional() }),
    result: z.object({ content: z.string(), encoding: z.enum(['utf-8', 'base64']), truncated: z.boolean() }),
  },
  'fs/search': {
    params: z.object({ cwd: z.string(), query: z.string(), limit: z.number().int().optional() }),
    result: z.object({ paths: z.array(z.string()) }),
  },
  'git/status': {
    params: z.object({ cwd: z.string() }),
    result: z.object({
      isRepo: z.boolean(),
      branch: z.string().optional(),
      files: z.array(z.object({ path: z.string(), status: z.string() })),
    }),
  },
  'git/diff': {
    params: z.object({ cwd: z.string(), path: z.string().optional(), staged: z.boolean().optional() }),
    result: z.object({ diff: z.string() }),
  },
} as const;

export type MethodName = keyof typeof Methods;
export type Params<M extends MethodName> = z.infer<(typeof Methods)[M]['params']>;
export type Result<M extends MethodName> = z.infer<(typeof Methods)[M]['result']>;
