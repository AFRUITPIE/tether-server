import { z } from 'zod';

/**
 * Bumped on a breaking change to a method, notification or payload. Additive changes (a new
 * notification, an optional field) don't bump it: unions already keep unknown variants.
 */
export const PROTOCOL_VERSION = 1;
/** The oldest client protocol this server still serves. */
export const MIN_CLIENT_PROTOCOL = 1;

export const JsonValue: z.ZodType<unknown> = z.unknown().meta({ id: 'JsonValue' });

export const PermissionMode = z
  .enum(['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto'])
  .meta({ id: 'PermissionMode' });
export type PermissionMode = z.infer<typeof PermissionMode>;

export const EffortLevel = z.enum(['low', 'medium', 'high', 'xhigh', 'max']).meta({ id: 'EffortLevel' });
export type EffortLevel = z.infer<typeof EffortLevel>;

export const ThinkingSetting = z
  .discriminatedUnion('type', [
    z.object({ type: z.literal('adaptive') }),
    z.object({ type: z.literal('enabled'), budgetTokens: z.number().int().optional() }),
    z.object({ type: z.literal('disabled') }),
  ])
  .meta({ id: 'ThinkingSetting' });
export type ThinkingSetting = z.infer<typeof ThinkingSetting>;

export const ThreadStatus = z
  .enum(['notLoaded', 'starting', 'idle', 'running', 'requiresAction', 'interrupted', 'closed', 'error'])
  .meta({ id: 'ThreadStatus' });
export type ThreadStatus = z.infer<typeof ThreadStatus>;

export const EnvOverrides = z.record(z.string(), z.string()).meta({ id: 'EnvOverrides' });

export const UserInput = z
  .discriminatedUnion('type', [
    z.object({ type: z.literal('text'), text: z.string() }),
    z.object({
      type: z.literal('image'),
      mediaType: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp']),
      data: z.string().describe('base64'),
    }),
    z.object({ type: z.literal('fileRef'), path: z.string() }),
  ])
  .meta({ id: 'UserInput' });
export type UserInput = z.infer<typeof UserInput>;

export const Usage = z
  .object({
    inputTokens: z.number(),
    outputTokens: z.number(),
    cacheReadInputTokens: z.number(),
    cacheCreationInputTokens: z.number(),
  })
  .meta({ id: 'Usage' });
export type Usage = z.infer<typeof Usage>;

export const ModelUsage = z
  .object({
    inputTokens: z.number(),
    outputTokens: z.number(),
    cacheReadInputTokens: z.number(),
    cacheCreationInputTokens: z.number(),
    costUsd: z.number(),
    contextWindow: z.number().optional(),
    maxOutputTokens: z.number().optional(),
  })
  .meta({ id: 'ModelUsage' });

export const ModelInfo = z
  .object({
    value: z.string(),
    resolvedModel: z.string().optional(),
    displayName: z.string(),
    description: z.string(),
    supportsEffort: z.boolean().optional(),
    supportedEffortLevels: z.array(EffortLevel).optional(),
    supportsAdaptiveThinking: z.boolean().optional(),
    supportsFastMode: z.boolean().optional(),
    supportsAutoMode: z.boolean().optional(),
  })
  .meta({ id: 'ModelInfo' });

export const AccountInfo = z
  .object({
    email: z.string().optional(),
    organization: z.string().optional(),
    subscriptionType: z.string().optional(),
    tokenSource: z.string().optional(),
    apiKeySource: z.string().optional(),
    apiProvider: z.string().optional().describe('firstParty | bedrock | vertex | foundry | gateway | …'),
  })
  .meta({ id: 'AccountInfo' });

export const SlashCommand = z
  .object({
    name: z.string(),
    description: z.string(),
    argumentHint: z.string().optional(),
    terminalOnly: z.boolean().optional(),
  })
  .meta({ id: 'SlashCommand' });

export const AgentInfo = z
  .object({ name: z.string(), description: z.string(), model: z.string().optional() })
  .meta({ id: 'AgentInfo' });

export const McpServerStatus = z
  .object({
    name: z.string(),
    status: z.string().describe('connected | failed | needs-auth | pending | disabled'),
    source: z.string().optional(),
    error: z.string().optional(),
    toolCount: z.number().optional(),
  })
  .meta({ id: 'McpServerStatus' });

export const ThreadSummary = z
  .object({
    threadId: z.string(),
    title: z.string(),
    customTitle: z.string().optional(),
    firstPrompt: z.string().optional(),
    cwd: z.string().optional(),
    gitBranch: z.string().optional(),
    tag: z.string().optional(),
    createdAt: z.number().optional(),
    updatedAt: z.number(),
    status: ThreadStatus,
  })
  .meta({ id: 'ThreadSummary' });
export type ThreadSummary = z.infer<typeof ThreadSummary>;

export const ThreadSettings = z
  .object({
    cwd: z.string(),
    model: z.string().optional(),
    effort: EffortLevel.optional(),
    permissionMode: PermissionMode.optional(),
    fastMode: z.boolean().optional(),
    thinking: ThinkingSetting.optional(),
    additionalDirectories: z.array(z.string()).optional(),
  })
  .meta({ id: 'ThreadSettings' });

export const ThreadInfo = z
  .object({
    threadId: z.string(),
    status: ThreadStatus,
    cwd: z.string(),
    title: z.string().optional(),
    model: z.string().optional(),
    effort: EffortLevel.nullable().optional(),
    permissionMode: PermissionMode.optional(),
    fastModeState: z.enum(['off', 'cooldown', 'on']).optional(),
    fastModeDisabledReason: z.string().optional(),
    tools: z.array(z.string()).optional(),
    slashCommands: z.array(z.string()).optional(),
    skills: z.array(z.string()).optional(),
    agents: z.array(z.string()).optional(),
    outputStyle: z.string().optional(),
    mcpServers: z.array(McpServerStatus).optional(),
    claudeCodeVersion: z.string().optional(),
    capabilities: z.array(z.string()).optional(),
    lastSeq: z.number().int(),
  })
  .meta({ id: 'ThreadInfo' });
export type ThreadInfo = z.infer<typeof ThreadInfo>;
