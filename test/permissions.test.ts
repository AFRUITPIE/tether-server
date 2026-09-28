import { describe, expect, test } from 'bun:test';
import { LiveThread, SESSION_TOOL_NAMES } from '../src/threads/LiveThread.ts';

const claude = { path: '/usr/bin/false', version: '0' } as any;
const sessionTools = { list: async () => [], read: async () => '' };

/** A thread with a client that denies every request, and the requests it was sent. */
function threadWithClient(opts: { sessionTools?: boolean } = {}) {
  const t = new LiveThread({
    threadId: 'thread-1',
    cwd: '/tmp',
    claude,
    env: {},
    mode: 'new',
    ...(opts.sessionTools ? { sessionTools } : {}),
  });
  const asked: { method: string; params: any }[] = [];
  t.subscribe({
    id: 'c',
    notify() {},
    request: async (method, params) => (asked.push({ method, params }), { decision: 'deny', message: 'no' }),
    cancelRequest() {},
  });
  const canUseTool = (toolName: string) =>
    (t as any).canUseTool(toolName, {}, { toolUseID: `tu-${toolName}`, signal: new AbortController().signal });
  return { t, asked, canUseTool };
}

describe('session tools', () => {
  test('are the three tools the thread registers', () => {
    expect([...SESSION_TOOL_NAMES].sort()).toEqual([
      'mcp__tether__list_sessions',
      'mcp__tether__read_session',
      'mcp__tether__suggest_task',
    ]);
  });

  test('run without asking on a thread that has them', async () => {
    const { asked, canUseTool } = threadWithClient({ sessionTools: true });
    for (const name of SESSION_TOOL_NAMES) expect((await canUseTool(name)).behavior).toBe('allow');
    expect(asked).toEqual([]);
  });

  test('are asked about on a thread that does not', async () => {
    const { asked, canUseTool } = threadWithClient();
    expect((await canUseTool('mcp__tether__list_sessions')).behavior).toBe('deny');
    expect(asked.map((a) => [a.method, a.params.toolName])).toEqual([['permission/request', 'mcp__tether__list_sessions']]);
  });

  test('another tool of a server called tether is asked about, even with session tools on', async () => {
    const { asked, canUseTool } = threadWithClient({ sessionTools: true });
    expect((await canUseTool('mcp__tether__delete_everything')).behavior).toBe('deny');
    expect((await canUseTool('mcp__tether__list_sessions_and_more')).behavior).toBe('deny');
    expect(asked.map((a) => a.params.toolName)).toEqual(['mcp__tether__delete_everything', 'mcp__tether__list_sessions_and_more']);
  });
});
