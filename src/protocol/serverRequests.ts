import { z } from 'zod';
import { JsonValue, PermissionMode } from './common.ts';

const R = { threadId: z.string(), requestId: z.string() };

export const PermissionScope = z.enum(['once', 'session', 'project', 'local', 'user']).meta({ id: 'PermissionScope' });

/** Server → client requests. The client must answer each; any subscribed client may answer. */
export const ServerRequests = {
  'permission/request': {
    params: z.object({
      ...R,
      toolUseId: z.string(),
      toolName: z.string(),
      input: JsonValue,
      title: z.string().optional(),
      displayName: z.string().optional(),
      description: z.string().optional(),
      decisionReason: z.string().optional(),
      blockedPath: z.string().optional(),
      /** Raw PermissionUpdate suggestions; `allow` with scope != once applies them. */
      suggestions: z.array(JsonValue).optional(),
      defaultToNo: z.boolean().optional(),
      suppressAlwaysAllowRule: z.boolean().optional(),
      agentId: z.string().optional(),
      mcpServer: z.object({ name: z.string(), source: z.string() }).optional(),
    }),
    result: z.discriminatedUnion('decision', [
      z.object({
        decision: z.literal('allow'),
        scope: PermissionScope.optional(),
        updatedInput: JsonValue.optional(),
      }),
      z.object({ decision: z.literal('deny'), message: z.string().optional(), interrupt: z.boolean().optional() }),
    ]),
  },

  'question/request': {
    params: z.object({
      ...R,
      toolUseId: z.string(),
      questions: z.array(
        z.object({
          question: z.string(),
          header: z.string(),
          multiSelect: z.boolean(),
          options: z.array(z.object({ label: z.string(), description: z.string(), preview: z.string().optional() })),
        }),
      ),
    }),
    result: z.discriminatedUnion('decision', [
      /** answers: question text → chosen label(s) (comma-joined for multiSelect) or free text. */
      z.object({ decision: z.literal('answer'), answers: z.record(z.string(), z.string()) }),
      z.object({ decision: z.literal('decline'), message: z.string().optional() }),
    ]),
  },

  'plan/approve': {
    params: z.object({ ...R, toolUseId: z.string(), plan: z.string(), planFilePath: z.string().optional() }),
    result: z.discriminatedUnion('decision', [
      z.object({ decision: z.literal('approve'), permissionMode: PermissionMode.optional() }),
      z.object({ decision: z.literal('reject'), feedback: z.string().optional() }),
    ]),
  },

  'elicitation/request': {
    params: z.object({
      ...R,
      serverName: z.string(),
      message: z.string(),
      mode: z.string().optional(),
      url: z.string().optional(),
      requestedSchema: JsonValue.optional(),
    }),
    result: z.object({ action: z.enum(['accept', 'decline', 'cancel']), content: JsonValue.optional() }),
  },

  'dialog/request': {
    params: z.object({ ...R, dialogKind: z.string(), payload: JsonValue, toolUseId: z.string().optional() }),
    result: z.discriminatedUnion('behavior', [
      z.object({ behavior: z.literal('completed'), result: JsonValue }),
      z.object({ behavior: z.literal('cancelled') }),
    ]),
  },
} as const;

export type ServerRequestName = keyof typeof ServerRequests;
export type ServerRequestParams<N extends ServerRequestName> = z.infer<(typeof ServerRequests)[N]['params']>;
export type ServerRequestResult<N extends ServerRequestName> = z.infer<(typeof ServerRequests)[N]['result']>;
