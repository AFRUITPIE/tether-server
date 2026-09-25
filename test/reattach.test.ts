import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Item, ToolCallItem } from '../src/protocol/index.ts';
import { FollowedThread, recordedCwd } from '../src/threads/FollowedThread.ts';
import { Itemizer, parseTaskNotification } from '../src/threads/itemizer.ts';
import { LiveThread } from '../src/threads/LiveThread.ts';
import { replayGap } from '../src/threads/seq.ts';
import { mergeHistory, ThreadManager } from '../src/threads/ThreadManager.ts';

const claude = { path: '/usr/bin/false', version: '0' } as any;
const liveThread = (threadId = 'thread-1') => new LiveThread({ threadId, cwd: '/tmp', claude, env: {}, mode: 'new' });

describe('event numbering across streams', () => {
  test('a thread restarted later numbers above everything the earlier stream sent', async () => {
    const first = liveThread();
    for (let i = 0; i < 50; i++) first.emit('thread/stderr', { text: `line ${i}` });
    await Bun.sleep(2);
    const second = liveThread();
    expect(second.threadInfo().lastSeq).toBeGreaterThan(first.threadInfo().lastSeq);
  });

  test('a follower numbers above a live stream that came before it', async () => {
    const live = liveThread();
    await Bun.sleep(2);
    expect(new FollowedThread('thread-1', '/tmp').threadInfo().lastSeq).toBeGreaterThan(live.threadInfo().lastSeq);
  });

  test('a client holding an older stream’s seq is told there is a gap', () => {
    const t = liveThread();
    t.emit('thread/stderr', { text: 'x' });
    const sent: number[] = [];
    const client = { id: 'c', notify: (_: string, p: any) => sent.push(p.seq), request: () => new Promise(() => {}), cancelRequest() {} };
    expect(t.subscribe(client, 19)).toEqual({ replayed: 1, gap: true });
    expect(sent).toEqual([t.threadInfo().lastSeq]);
  });

  test('a stream begun after a clock step back still numbers above the last one', () => {
    // The earlier stream's last seq is ahead of the clock, as after the clock stepped back.
    const earlier = Date.now() * 1000 + 5_000_000;
    const t = new LiveThread({ threadId: 'thread-1', cwd: '/tmp', claude, env: {}, mode: 'resume', seqAfter: earlier });
    expect(t.threadInfo().lastSeq).toBe(earlier + 1);
  });

  test('replayGap', () => {
    expect(replayGap(10, 5, 10)).toBe(false); // up to date
    expect(replayGap(7, 5, 10)).toBe(false); // inside the buffer
    expect(replayGap(4, 5, 10)).toBe(false); // right before it
    expect(replayGap(3, 5, 10)).toBe(true); // older than the buffer
    expect(replayGap(11, 5, 10)).toBe(true); // from another stream
    expect(replayGap(3, undefined, 10)).toBe(true); // nothing buffered to catch up from
  });
});

describe('background work keeps a thread loaded', () => {
  const report = (t: LiveThread, tasks: object[]) =>
    (t as any).onMessage({ type: 'system', subtype: 'background_tasks_changed', tasks });

  test('tracks the CLI’s current set, ignoring ambient watchers', () => {
    const t = liveThread();
    report(t, [{ task_id: 'b1', task_type: 'local_bash', description: 'sleep' }]);
    expect(t.hasBackgroundWork).toBe(true);
    report(t, [{ task_id: 'w1', task_type: 'monitor', description: 'watch', ambient: true }]);
    expect(t.hasBackgroundWork).toBe(false);
  });

  test('an idle thread with a background command is neither evicted nor drained', () => {
    const mgr = new ThreadManager(claude);
    const t = liveThread();
    t.status = 'idle';
    t.lastActivityAt = 0;
    mgr.threads.set(t.id, t);
    report(t, [{ task_id: 'b1', task_type: 'local_bash', description: 'sleep 90' }]);
    (mgr as any).sweep();
    expect(mgr.threads.has(t.id)).toBe(true);
    expect(mgr.busy).toBe(true);
    t.lastActivityAt = 0;
    report(t, []);
    t.lastActivityAt = 0;
    (mgr as any).sweep();
    expect(mgr.threads.has(t.id)).toBe(false);
    mgr.shutdown();
  });
});

/** A turn that sends a subagent to the background, then ends while the subagent still works. */
function backgroundAgentTurn(iz: Itemizer) {
  const out = [...iz.beginUserTurn('u1', [{ type: 'text', text: 'launch' }], false).out];
  const push = (m: object) => out.push(...iz.ingest(m));
  push({ type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 'agent1', name: 'Agent', input: {} }] } });
  // As the CLI reports it: the background set (usually first), then the task's start.
  push({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 't1', task_type: 'local_agent', description: 'x' }] });
  push({ type: 'system', subtype: 'task_started', task_id: 't1', tool_use_id: 'agent1', description: 'x' });
  push({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'agent1', content: 'Running in the background' }] } });
  push({ type: 'assistant', parent_tool_use_id: 'agent1', message: { id: 'm2', content: [{ type: 'tool_use', id: 'bash1', name: 'Bash', input: { command: 'sleep 20' } }] } });
  push({ type: 'assistant', message: { id: 'm3', content: [{ type: 'text', text: 'launched' }] } });
  push({ type: 'result', subtype: 'success', is_error: false });
  return out;
}

const tool = (iz: Itemizer, id: string) => iz.items.get(id) as ToolCallItem;

describe('background subagents', () => {
  test('the turn ending leaves a background subagent’s tool calls running', () => {
    const iz = new Itemizer();
    backgroundAgentTurn(iz);
    expect(tool(iz, 'agent1').status).toBe('completed');
    expect(tool(iz, 'bash1').status).toBe('running');
  });

  test('its later messages stay in the turn that launched it rather than opening one', () => {
    const iz = new Itemizer();
    backgroundAgentTurn(iz);
    const out = iz.ingest({ type: 'assistant', parent_tool_use_id: 'agent1', message: { id: 'm4', content: [{ type: 'text', text: 'agent-done' }] } });
    expect(out.some((e) => e.method === 'turn/started')).toBe(false);
    expect(iz.currentTurn).toBeNull();
    expect(iz.items.get('m4:0')?.turnId).toBe('u1');
  });

  test('its completion is one readable notice, whether it arrives as an event, a message, or both', () => {
    const iz = new Itemizer();
    backgroundAgentTurn(iz);
    const event = iz.ingest({
      type: 'system',
      subtype: 'task_notification',
      task_id: 't1',
      tool_use_id: 'agent1',
      status: 'completed',
      summary: 'Agent "Sleep then reply" completed',
      uuid: 'n1',
    });
    expect(event.some((e) => e.method === 'task/event')).toBe(true);
    const notices = [...iz.items.values()].filter((i) => i.type === 'notice');
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ kind: 'taskNotification', text: 'Agent "Sleep then reply" completed' });
    const echo = iz.ingest({
      type: 'user',
      uuid: 'n2',
      message: { content: '<task-notification>\n<task-id>t1</task-id>\n<status>completed</status>\n<summary>x</summary>\n</task-notification>' },
    });
    expect(echo).toEqual([]);
    expect([...iz.items.values()].filter((i) => i.type === 'userMessage')).toHaveLength(1);
  });

  test('a subagent’s own background command settling is not a transcript notice', () => {
    const iz = new Itemizer();
    backgroundAgentTurn(iz);
    const out = iz.ingest({ type: 'system', subtype: 'task_notification', task_id: 'inner', tool_use_id: 'bash1', status: 'completed', summary: 'sleep 20', uuid: 'n0' });
    expect(out.map((e) => e.method)).toContain('task/event');
    expect([...iz.items.values()].some((i) => i.type === 'notice')).toBe(false);
  });

  test('a foreground command finishing is not a notice: its tool call reports it', () => {
    const iz = new Itemizer();
    iz.beginUserTurn('u1', [{ type: 'text', text: 'go' }], false);
    iz.ingest({ type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 'bash1', name: 'Bash', input: {} }] } });
    iz.ingest({ type: 'system', subtype: 'task_notification', task_id: 'fg', tool_use_id: 'bash1', status: 'completed', summary: 'loop', uuid: 'n0' });
    expect([...iz.items.values()].some((i) => i.type === 'notice')).toBe(false);
  });

  test('a stopped background agent closes the tool calls it left running', () => {
    const iz = new Itemizer();
    backgroundAgentTurn(iz);
    iz.ingest({ type: 'system', subtype: 'task_notification', task_id: 't1', tool_use_id: 'agent1', status: 'stopped', summary: 'stopped', uuid: 'n1' });
    expect(tool(iz, 'bash1').status).toBe('interrupted');
  });

  test('a foreground subagent that ended in error takes its unfinished tool calls with its turn', () => {
    const iz = new Itemizer();
    iz.beginUserTurn('u1', [{ type: 'text', text: 'go' }], false);
    iz.ingest({ type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 'agent1', name: 'Agent', input: {} }] } });
    iz.ingest({ type: 'assistant', parent_tool_use_id: 'agent1', message: { id: 'm2', content: [{ type: 'tool_use', id: 'bash1', name: 'Bash', input: {} }] } });
    iz.ingest({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'agent1', content: 'interrupted', is_error: true }] } });
    iz.ingest({ type: 'result', subtype: 'error_during_execution', is_error: true });
    expect(tool(iz, 'agent1').status).toBe('failed');
    expect(tool(iz, 'bash1').status).toBe('interrupted');
  });

  test('when the process ends, a background subagent’s tool calls end with it', () => {
    const iz = new Itemizer();
    backgroundAgentTurn(iz);
    iz.abandonAll();
    expect(tool(iz, 'bash1').status).toBe('interrupted');
  });

  test('a subagent’s own notification message is not a transcript notice', () => {
    const iz = new Itemizer();
    backgroundAgentTurn(iz);
    const out = iz.ingest({
      type: 'user',
      parent_tool_use_id: 'agent1',
      uuid: 'n3',
      message: { content: '<task-notification>\n<task-id>inner</task-id>\n<status>completed</status>\n<summary>sleep 20</summary>\n</task-notification>' },
    });
    expect(out).toEqual([]);
    expect([...iz.items.values()].some((i) => i.type === 'notice')).toBe(false);
  });

  test('a foreground subagent cut off with its turn takes its tool calls with it', () => {
    const iz = new Itemizer();
    iz.beginUserTurn('u1', [{ type: 'text', text: 'go' }], false);
    iz.ingest({ type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 'agent1', name: 'Agent', input: {} }] } });
    iz.ingest({ type: 'assistant', parent_tool_use_id: 'agent1', message: { id: 'm2', content: [{ type: 'tool_use', id: 'bash1', name: 'Bash', input: {} }] } });
    iz.ingest({ type: 'result', subtype: 'error_during_execution', is_error: true });
    expect(tool(iz, 'agent1').status).toBe('interrupted');
    expect(tool(iz, 'bash1').status).toBe('interrupted');
  });
});

describe('task notifications in history', () => {
  const xml =
    '<task-notification>\n<task-id>bevhhzqa5</task-id>\n<tool-use-id>toolu_1</tool-use-id>\n<output-file>/tmp/x.output</output-file>\n<status>completed</status>\n<summary>Background command "Sleep then echo" completed (exit code 0)</summary>\n</task-notification>';

  test('parses the CLI’s message', () => {
    expect(parseTaskNotification(xml)).toEqual({
      taskId: 'bevhhzqa5',
      toolUseId: 'toolu_1',
      status: 'completed',
      summary: 'Background command "Sleep then echo" completed (exit code 0)',
    });
    expect(parseTaskNotification('hello')).toBeUndefined();
  });

  test('a transcript’s notification message becomes a notice, not a raw user message', () => {
    const iz = new Itemizer(Date.now, true);
    iz.ingest({ type: 'user', uuid: 'p1', message: { content: 'start it' } });
    iz.ingest({ type: 'user', uuid: 'n1', isMeta: true, message: { content: xml } });
    const items = [...iz.items.values()];
    expect(items.filter((i) => i.type === 'userMessage')).toHaveLength(1);
    expect(items.find((i) => i.id === 'n1')).toMatchObject({ type: 'notice', kind: 'taskNotification' });
  });
});

describe('merging stored and live history', () => {
  const user = (id: string, turnId: string): Item =>
    ({ type: 'userMessage', id, turnId, parentToolUseId: null, createdAt: 0, content: [] }) as Item;

  test('a message sent mid-turn does not leave an empty turn behind', () => {
    // On disk the steering message reads as a prompt of its own; live, it joined the running turn.
    const stored = {
      items: [user('a', 'a'), user('b', 'b')],
      turns: [{ id: 'a', status: 'completed', startedAt: 0 }, { id: 'b', status: 'completed', startedAt: 0 }],
    } as any;
    const live = { items: [user('b', 'a')], turns: [{ id: 'x', status: 'completed', startedAt: 0 }] } as any;
    const merged = mergeHistory(stored, live);
    expect(merged.items.map((i) => [i.id, i.turnId])).toEqual([['a', 'a'], ['b', 'a']]);
    expect(merged.turns.map((t) => t.id)).toEqual(['a', 'x']);
  });
});

describe('a session whose cwd the SDK misses', () => {
  test('is read from past a first message too long for the SDK’s look at the head', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'tether-cwd-')), 'session.jsonl');
    const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(1_000_000) } };
    writeFileSync(
      path,
      [
        JSON.stringify({ type: 'queue-operation', operation: 'enqueue' }),
        JSON.stringify({ type: 'user', message: { role: 'user', content: [image] } }),
        JSON.stringify({ type: 'attachment', cwd: '/Users/me/project' }),
        JSON.stringify({ type: 'assistant', cwd: '/Users/me/project/sub' }),
      ].join('\n') + '\n',
    );
    expect(await recordedCwd(path)).toBe('/Users/me/project');
  });

  test('a transcript that records none has none', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'tether-cwd-')), 'session.jsonl');
    writeFileSync(path, '{"type":"summary","note":"no \\"cwd\\" here"}\n{"cwd":\n');
    expect(await recordedCwd(path)).toBeUndefined();
    expect(await recordedCwd(join(tmpdir(), 'missing-transcript.jsonl'))).toBeUndefined();
  });
});
