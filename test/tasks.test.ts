import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Item, TaskState, ToolCallItem } from '../src/protocol/index.ts';
import { ingestHistory, TranscriptExtras } from '../src/threads/FollowedThread.ts';
import { Itemizer, type Emission } from '../src/threads/itemizer.ts';
import { TaskStore } from '../src/threads/taskStore.ts';
import { ThreadManager } from '../src/threads/ThreadManager.ts';
import { RECENT_RUN_MS } from '../src/threads/workflows.ts';

const updates = (out: Emission[]) => out.flatMap((e) => (e.method === 'task/updated' ? [e.body.task] : []));
const assistant = (id: string, content: object[], parent: string | null = null) => ({ type: 'assistant', parent_tool_use_id: parent, message: { id, content } });
const result = (toolUseId: string, content: string, toolUseResult?: object, parent: string | null = null) => ({
  type: 'user',
  parent_tool_use_id: parent,
  message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content }] },
  ...(toolUseResult ? { tool_use_result: toolUseResult } : {}),
});
const done = (uuid = 'r') => ({ type: 'result', subtype: 'success', is_error: false, uuid });

describe('agents and commands', () => {
  test('a foreground subagent: running while its call is, done with its report, and its own calls under it', () => {
    const iz = new Itemizer(() => 5);
    iz.beginUserTurn('u1', [{ type: 'text', text: 'go' }], false);
    const started = iz.ingest(assistant('m1', [{ type: 'tool_use', id: 'agent1', name: 'Agent', input: { description: 'Look around', prompt: 'x' } }]));
    expect(updates(started)).toEqual([
      expect.objectContaining({ id: 'agent1', toolUseId: 'agent1', kind: 'agent', title: 'Look around', status: 'running', startedAt: 5 }),
    ]);
    iz.ingest({ type: 'system', subtype: 'task_started', task_id: 't1', tool_use_id: 'agent1', task_type: 'local_agent', description: 'Look around' });
    const task = iz.tasks().find((t) => t.id === 'agent1')!;
    expect(task).toMatchObject({ taskId: 't1', taskType: 'local_agent', canBackground: true });
    // Its own background command, streamed inside it.
    iz.ingest(assistant('m2', [{ type: 'tool_use', id: 'bash1', name: 'Bash', input: { command: 'sleep 5', run_in_background: true } }], 'agent1'));
    iz.ingest(result('bash1', 'Command running in background with ID: b1. Output is being written to: /tmp/b1.output. If it exits…', undefined, 'agent1'));
    expect(iz.tasks().find((t) => t.id === 'bash1')).toMatchObject({ kind: 'command', parentId: 'agent1', status: 'running', taskId: 'b1', outputFile: '/tmp/b1.output', backgrounded: true });
    iz.ingest(result('agent1', 'Found three files.'));
    expect(iz.tasks().find((t) => t.id === 'agent1')).toMatchObject({ status: 'done', output: 'Found three files.' });
    expect(iz.tasks().find((t) => t.id === 'agent1')!.canBackground).toBeUndefined();
  });

  test('a background agent goes on after its call and its turn, until its notification', () => {
    const iz = new Itemizer(() => 1);
    iz.beginUserTurn('u1', [{ type: 'text', text: 'go' }], false);
    iz.ingest(assistant('m1', [{ type: 'tool_use', id: 'agent1', name: 'Agent', input: { description: 'Sleep then reply', run_in_background: true } }]));
    iz.ingest(result('agent1', 'Async agent launched successfully.\nagentId: abc123', { isAsync: true, status: 'async_launched', agentId: 'abc123' }));
    iz.ingest(done());
    expect(iz.tasks()[0]).toMatchObject({ id: 'agent1', taskId: 'abc123', status: 'running', backgrounded: true });
    const out = iz.ingest({ type: 'system', subtype: 'task_notification', task_id: 'abc123', status: 'completed', summary: 'Agent "Sleep then reply" completed', usage: { total_tokens: 900, tool_uses: 2, duration_ms: 5000 } });
    expect(updates(out)).toEqual([
      expect.objectContaining({ id: 'agent1', status: 'done', summary: 'Agent "Sleep then reply" completed', usage: { totalTokens: 900, toolUses: 2, durationMs: 5000 }, endedAt: 1 }),
    ]);
    expect(updates(out)[0]!.backgrounded).toBeUndefined();
  });

  test('from history alone: the launch and the notification say the same', () => {
    const iz = new Itemizer(() => 1, true);
    iz.ingest({ type: 'user', uuid: 'p', message: { content: 'go' }, parent_tool_use_id: null, timestamp: '2026-10-06T10:00:00Z' });
    iz.ingest({ ...assistant('m1', [{ type: 'tool_use', id: 'bash1', name: 'Bash', input: { command: 'make', run_in_background: true } }]), timestamp: '2026-10-06T10:00:01Z' });
    iz.ingest({ ...result('bash1', 'Command running in background with ID: b9. Output is being written to: /tmp/b9.output.'), timestamp: '2026-10-06T10:00:02Z' });
    expect(iz.tasks()[0]).toMatchObject({ id: 'bash1', kind: 'command', status: 'running', taskId: 'b9' });
    iz.ingest({
      type: 'user',
      uuid: 'n',
      timestamp: '2026-10-06T10:01:00Z',
      message: { content: '<task-notification>\n<task-id>b9</task-id>\n<tool-use-id>bash1</tool-use-id>\n<status>failed</status>\n<summary>Background command "make" failed: exit code 2</summary>\n</task-notification>' },
      parent_tool_use_id: null,
    });
    expect(iz.tasks()[0]).toMatchObject({ status: 'failed', summary: 'Background command "make" failed: exit code 2', error: 'exit code 2', endedAt: Date.parse('2026-10-06T10:01:00Z') });
  });

  test('a task the CLI reports with no call this chat holds is listed by its task id', () => {
    const iz = new Itemizer(() => 1);
    iz.ingest({ type: 'system', subtype: 'task_started', task_id: 'mon1', task_type: 'monitor_mcp', description: 'Watching the build' });
    expect(iz.tasks()).toEqual([expect.objectContaining({ id: 'task:mon1', kind: 'monitor', title: 'Watching the build', status: 'running' })]);
    iz.ingest({ type: 'system', subtype: 'task_started', task_id: 'x1', task_type: 'future_kind', description: 'Something new' });
    expect(iz.tasks()[1]).toMatchObject({ kind: 'other', taskType: 'future_kind' });
  });

  test('sent to the background mid-call, it goes on and can no longer be sent', () => {
    const iz = new Itemizer(() => 1);
    iz.beginUserTurn('u1', [{ type: 'text', text: 'go' }], false);
    iz.ingest(assistant('m1', [{ type: 'tool_use', id: 'bash1', name: 'Bash', input: { command: 'npm test' } }]));
    iz.ingest({ type: 'system', subtype: 'task_started', task_id: 'b1', tool_use_id: 'bash1', task_type: 'local_bash', description: 'npm test' });
    expect(iz.tasks()[0]).toMatchObject({ id: 'bash1', canBackground: true });
    iz.ingest({ type: 'system', subtype: 'task_updated', task_id: 'b1', patch: { is_backgrounded: true } });
    iz.ingest(result('bash1', 'Command was moved to the background with ID: b1.'));
    const t = iz.tasks()[0]!;
    expect(t).toMatchObject({ status: 'running', backgrounded: true });
    expect(t.canBackground).toBeUndefined();
  });

  test('the process ending stops everything it ran', () => {
    const iz = new Itemizer(() => 1);
    iz.beginUserTurn('u1', [{ type: 'text', text: 'go' }], false);
    iz.ingest(assistant('m1', [{ type: 'tool_use', id: 'agent1', name: 'Agent', input: { description: 'x', run_in_background: true } }]));
    iz.ingest(result('agent1', 'launched', { status: 'async_launched', agentId: 'a1' }));
    const out = iz.abandonAll();
    expect(updates(out)).toEqual([expect.objectContaining({ id: 'agent1', status: 'stopped' })]);
  });

  test('a state is sent only when it changes', () => {
    const iz = new Itemizer(() => 1);
    iz.beginUserTurn('u1', [{ type: 'text', text: 'go' }], false);
    iz.ingest(assistant('m1', [{ type: 'tool_use', id: 'agent1', name: 'Agent', input: { description: 'x' } }]));
    expect(updates(iz.ingest(assistant('m2', [{ type: 'text', text: 'thinking about it' }], 'agent1')))).toEqual([]);
    expect(updates(iz.ingest({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { id: 'm3' } } }))).toEqual([]);
  });
});

describe('skill instructions', () => {
  const skillCall = assistant('m1', [{ type: 'tool_use', id: 'skill1', name: 'Skill', input: { skill: 'pdf' } }]);
  const launched = result('skill1', 'Launching skill: pdf', { success: true, commandName: 'pdf' });
  const body = { type: 'user', uuid: 'body1', isSynthetic: true, parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'Base directory for this skill: /x\n\n# PDF' }] } };

  test("live, the message right after the call is the call's, never a message of the chat", () => {
    const iz = new Itemizer(() => 1);
    iz.beginUserTurn('u1', [{ type: 'text', text: 'make a pdf' }], false);
    iz.ingest(skillCall);
    iz.ingest(launched);
    const out = iz.ingest(body);
    expect(out.map((e) => e.method)).toEqual(['item/updated']);
    expect((out[0]!.body as any).item.skillInstructions).toBe('Base directory for this skill: /x\n\n# PDF');
    // Said again (the same message), nothing more.
    expect(iz.ingest(body)).toEqual([]);
    expect([...iz.items.values()].filter((i) => i.type === 'userMessage')).toHaveLength(1);
  });

  test('a synthetic message after anything else is still a message', () => {
    const iz = new Itemizer(() => 1);
    iz.beginUserTurn('u1', [{ type: 'text', text: 'go' }], false);
    iz.ingest(skillCall);
    iz.ingest(launched);
    iz.ingest(assistant('m2', [{ type: 'text', text: 'done' }]));
    iz.ingest({ ...body, uuid: 'other' });
    expect((iz.items.get('skill1') as ToolCallItem).skillInstructions).toBeUndefined();
    expect(iz.items.get('other')?.type).toBe('userMessage');
  });

  test('history reads it from the transcript, which names its call', () => {
    const iz = new Itemizer(() => 1, true);
    const extras = new TranscriptExtras();
    extras.add([
      JSON.stringify({ type: 'user', uuid: 'body1', parentUuid: 'res', isMeta: true, sourceToolUseID: 'skill1', message: { role: 'user', content: [{ type: 'text', text: '# PDF' }] } }),
    ]);
    ingestHistory(iz, [{ type: 'user', uuid: 'p', message: { content: 'make a pdf' }, parent_tool_use_id: null }, { ...skillCall, uuid: 'call' }, { ...launched, uuid: 'res' }], extras);
    expect((iz.items.get('skill1') as ToolCallItem).skillInstructions).toBe('# PDF');
    expect(iz.items.has('body1')).toBe(false);
  });
});

describe('schedules of a live thread', () => {
  test("a goal set before the process started is the one its checks now judge (the chat's items seeded)", () => {
    const iz = new Itemizer(() => 1);
    const set: Item = {
      type: 'notice',
      id: 'g',
      turnId: 't0',
      parentToolUseId: null,
      createdAt: 1,
      kind: 'goal',
      text: 'Goal set: tests pass',
      goal: { condition: 'tests pass', event: 'set' },
    };
    expect(updates(iz.seed([set]))).toEqual([expect.objectContaining({ id: 'goal:g', status: 'running' })]);
    iz.beginUserTurn('u1', [{ type: 'text', text: 'keep going' }], false);
    const out = iz.ingestExtra({ type: 'attachment', uuid: 'c1', attachment: { type: 'goal_status', met: true, condition: 'tests pass', reason: 'all green' } });
    expect(updates(out)).toEqual([expect.objectContaining({ id: 'goal:g', status: 'done', goal: { condition: 'tests pass', checks: 1, lastCheck: { met: true, reason: 'all green' } } })]);
  });

  test("a job the session's Stop hook no longer lists has gone", () => {
    const iz = new Itemizer(() => 1);
    iz.noteSessionCrons([]);
    iz.beginUserTurn('u1', [{ type: 'text', text: 'remind me' }], false);
    iz.ingest(assistant('m1', [{ type: 'tool_use', id: 'c', name: 'CronCreate', input: { cron: '0 9 * * *', prompt: 'stand up', recurring: true } }]));
    iz.ingest(result('c', 'Scheduled recurring job j1 (Every day at 9am).', { id: 'j1', humanSchedule: 'Every day at 9am', recurring: true, durable: false }));
    // Its turn still running: the hook hasn't said yet.
    expect(iz.tasks().find((t) => t.kind === 'schedule')!.status).toBe('running');
    iz.noteSessionCrons([{ id: 'j1', schedule: '0 9 * * *', recurring: true, prompt: 'stand up' }]);
    iz.ingest(done());
    expect(iz.tasks().find((t) => t.kind === 'schedule')!.status).toBe('running');
    expect(updates(iz.noteSessionCrons([]))).toEqual([expect.objectContaining({ id: 'schedule:c', status: 'stopped', schedule: expect.objectContaining({ ended: 'sessionEnded' }) })]);
  });
});

describe('kept with the chat', () => {
  const home = mkdtempSync(join(tmpdir(), 'tether-tasks-'));
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  test('the store keeps each state by id, writes it a moment later, and reads it back', () => {
    const dir = join(home, 'store');
    const store = new TaskStore(dir, 10_000);
    const a: TaskState = { id: 'a', kind: 'agent', title: 'A', status: 'running' };
    store.put('thread-1', [a]);
    store.put('thread-1', [{ ...a, status: 'done' }, { id: 'b', kind: 'command', title: 'B', status: 'running' }]);
    expect(existsSync(join(dir, 'thread-1.json'))).toBe(false);
    store.flush();
    const again = new TaskStore(dir);
    expect(again.get('thread-1').map((t) => [t.id, t.status])).toEqual([
      ['a', 'done'],
      ['b', 'running'],
    ]);
    // A bad entry is skipped, not the file.
    writeFileSync(join(dir, 'thread-2.json'), JSON.stringify({ tasks: [{ id: 'x' }, a] }));
    expect(new TaskStore(dir).get('thread-2').map((t) => t.id)).toEqual(['a']);
    // Ids that could leave the folder are never files.
    store.put('../escape', [a]);
    store.flush();
    expect(existsSync(join(home, 'escape.json'))).toBe(false);
    store.delete('thread-1');
    expect(existsSync(join(dir, 'thread-1.json'))).toBe(false);
    expect(JSON.parse(readFileSync(join(dir, 'thread-2.json'), 'utf8')).tasks).toHaveLength(2);
  });

  test("a read has what the daemon saw live, a task kept as going stopped once its process isn't, unless the transcript says how it ended", async () => {
    const config = join(home, 'claude');
    const sid = '6a1c4e2b-0000-4000-8000-000000000001';
    const project = join(config, 'projects', '-home-me');
    mkdirSync(project, { recursive: true });
    const records = [
      { type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: 'go' } },
      { type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: { id: 'msg1', role: 'assistant', model: 'claude-test', content: [{ type: 'tool_use', id: 'agent1', name: 'Agent', input: { description: 'Look', run_in_background: true } }, { type: 'tool_use', id: 'agent2', name: 'Agent', input: { description: 'Wait' , run_in_background: true } }], stop_reason: 'tool_use' } },
      { type: 'user', uuid: 'r1', parentUuid: 'a1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'agent1', content: 'Async agent launched successfully.\nagentId: t1' }, { type: 'tool_result', tool_use_id: 'agent2', content: 'Async agent launched successfully.\nagentId: t2' }] } },
      { type: 'user', uuid: 'n1', parentUuid: 'r1', message: { role: 'user', content: '<task-notification>\n<task-id>t1</task-id>\n<status>completed</status>\n<summary>Agent "Look" completed</summary>\n</task-notification>' } },
    ].map((r, i) => ({ ...r, sessionId: sid, cwd: '/home/me', isSidechain: false, userType: 'external', timestamp: new Date(Date.parse('2026-10-06T10:00:00Z') + i * 1000).toISOString() }));
    const transcript = join(project, `${sid}.jsonl`);
    writeFileSync(transcript, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const saved = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = config;
    const store = new TaskStore(join(home, 'kept'));
    // What the daemon saw of them live, before a restart: usage no transcript holds.
    store.put(sid, [
      { id: 'agent1', toolUseId: 'agent1', taskId: 't1', kind: 'agent', title: 'Look', status: 'running', backgrounded: true, usage: { totalTokens: 500 } },
      { id: 'agent2', toolUseId: 'agent2', taskId: 't2', kind: 'agent', title: 'Wait', status: 'running', backgrounded: true, usage: { totalTokens: 700 } },
    ]);
    const mgr = new ThreadManager({ path: '/usr/bin/false', version: '0' } as any, () => {}, { taskStore: store });
    try {
      const { tasks } = await mgr.read(sid, '/home/me');
      expect(tasks.map((t) => [t.id, t.status, t.usage?.totalTokens, t.backgrounded])).toEqual([
        // The transcript says it finished; what was kept says what it used.
        ['agent1', 'done', 500, undefined],
        ['agent2', 'stopped', 700, undefined],
      ]);
      // Untouched for a while, nothing of it is going: what only the transcript tells of stopped too.
      const old = new Date(Date.now() - 2 * RECENT_RUN_MS);
      utimesSync(transcript, old, old);
      mgr.unfollow(sid);
      store.delete(sid);
      expect((await mgr.read(sid, '/home/me')).tasks.map((t) => [t.id, t.status])).toEqual([
        ['agent1', 'done'],
        ['agent2', 'stopped'],
      ]);
    } finally {
      mgr.shutdown();
      if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = saved;
    }
  });
});
