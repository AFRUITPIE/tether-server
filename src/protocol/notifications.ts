import { z } from 'zod';
import { JsonValue, ThreadInfo, ThreadStatus, UserInput } from './common.ts';
import { Item, Turn } from './items.ts';

/** Every thread-scoped notification carries these. `seq` is monotonic per thread, for replay. */
const T = { threadId: z.string(), seq: z.number().int() };

export const Notifications = {
  'thread/started': z.object({ ...T, thread: ThreadInfo }),
  'thread/updated': z.object({ ...T, thread: ThreadInfo }),
  'thread/status/changed': z.object({
    ...T,
    status: ThreadStatus,
    /** Finer-grained activity from SDK `status` messages. */
    activity: z.enum(['requesting', 'compacting']).nullable().optional(),
  }),
  'thread/closed': z.object({ ...T, reason: z.string().optional() }),
  'thread/tokenUsage/updated': z.object({
    ...T,
    inputTokens: z.number(),
    outputTokens: z.number(),
    cacheReadInputTokens: z.number(),
    cacheCreationInputTokens: z.number(),
    totalCostUsd: z.number(),
  }),

  'turn/started': z.object({ ...T, turn: Turn }),
  'turn/completed': z.object({ ...T, turn: Turn }),

  'item/started': z.object({ ...T, item: Item }),
  'item/updated': z.object({ ...T, item: Item }),
  'item/completed': z.object({ ...T, item: Item }),
  'item/agentMessage/delta': z.object({ ...T, itemId: z.string(), delta: z.string() }),
  'item/reasoning/delta': z.object({ ...T, itemId: z.string(), delta: z.string() }),
  'item/toolCall/inputDelta': z.object({ ...T, itemId: z.string(), partialJson: z.string() }),
  'item/toolCall/progress': z.object({
    ...T,
    itemId: z.string(),
    elapsedSeconds: z.number(),
    taskId: z.string().optional(),
  }),

  'task/event': z.object({
    ...T,
    /** started | progress | updated | notification */
    event: z.string(),
    taskId: z.string(),
    toolUseId: z.string().optional(),
    description: z.string().optional(),
    status: z.string().optional(),
    summary: z.string().optional(),
    data: JsonValue,
  }),
  'task/backgroundChanged': z.object({ ...T, tasks: JsonValue }),

  'thread/queuedInput': z.object({ ...T, messageId: z.string(), content: z.array(UserInput) }),
  'thread/promptSuggestion': z.object({ ...T, suggestion: z.string() }),
  'thread/commandsChanged': z.object({ ...T }),

  'thread/apiRetry': z.object({
    ...T,
    attempt: z.number(),
    maxRetries: z.number(),
    retryDelayMs: z.number(),
    errorStatus: z.number().nullable(),
    error: z.string().optional(),
  }),
  'thread/rateLimit': z.object({ ...T, info: JsonValue }),
  'thread/authStatus': z.object({
    ...T,
    isAuthenticating: z.boolean(),
    output: z.array(z.string()),
    error: z.string().optional(),
  }),
  'thread/notification': z.object({ ...T, message: z.string(), priority: z.string().optional() }),
  'thread/hook': z.object({ ...T, event: z.string(), data: JsonValue }),
  /** Any SDK message Tether does not model. Forwarded verbatim so newer CLIs never break clients. */
  'thread/rawEvent': z.object({ ...T, sdkType: z.string(), sdkSubtype: z.string().optional(), message: JsonValue }),

  'serverRequest/resolved': z.object({
    ...T,
    requestId: z.string(),
    reason: z.enum(['answered', 'cancelled']),
  }),

  'thread/stderr': z.object({ ...T, text: z.string() }),
} as const;

export type NotificationName = keyof typeof Notifications;
export type NotificationParams<N extends NotificationName> = z.infer<(typeof Notifications)[N]>;
/** Params without the envelope fields the thread fills in. */
export type NotificationBody<N extends NotificationName> = Omit<NotificationParams<N>, 'threadId' | 'seq'>;
