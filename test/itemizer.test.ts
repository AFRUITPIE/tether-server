import { describe, expect, test } from 'bun:test';
import { Itemizer } from '../src/threads/itemizer.ts';

async function loadFixture(name: string) {
  const text = await Bun.file(`${import.meta.dir}/fixtures/sdk/${name}.jsonl`).text();
  return text.trim().split('\n').map((l) => JSON.parse(l)).filter((l) => l.kind === 'message').map((l) => l.data);
}

describe('itemizer: basic-tools', async () => {
  const msgs = await loadFixture('basic-tools');
  let t = 0;
  const iz = new Itemizer(() => ++t);
  const { out } = iz.beginUserTurn('u1', [{ type: 'text', text: 'go' }], false);
  const emissions = [...out, ...msgs.flatMap((m) => iz.ingest(m))];
  const { items, turns } = iz.snapshot();

  test('one completed turn', () => {
    expect(turns).toHaveLength(1);
    expect(turns[0]!.status).toBe('completed');
    expect(turns[0]!.result!.totalCostUsd).toBeGreaterThan(0);
    expect(emissions.at(-2)!.method).toBe('turn/completed');
  });

  test('tool calls paired with results', () => {
    const tools = items.filter((i) => i.type === 'toolCall');
    expect(tools.map((t) => t.type === 'toolCall' && t.kind)).toEqual(['fileRead', 'bash', 'fileWrite', 'fileRead', 'fileEdit']);
    for (const tc of tools) if (tc.type === 'toolCall') {
      expect(tc.status).toBe('completed');
      expect(tc.outputText).toBeTruthy();
    }
  });

  test('streamed text matches final text, no duplicate items', () => {
    const msgsOut = items.filter((i) => i.type === 'agentMessage');
    expect(msgsOut).toHaveLength(1);
    const deltas = emissions.filter((e) => e.method === 'item/agentMessage/delta').map((e: any) => e.body.delta).join('');
    expect(deltas).toBe((msgsOut[0] as any).text);
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
  });

  test('every started item is completed', () => {
    const started = new Set(emissions.filter((e) => e.method === 'item/started').map((e: any) => e.body.item.id));
    const completed = new Set(emissions.filter((e) => e.method === 'item/completed').map((e: any) => e.body.item.id));
    expect([...started].filter((id) => !completed.has(id))).toEqual([]);
  });
});

describe('itemizer: transcript history', async () => {
  const text = await Bun.file(`${import.meta.dir}/fixtures/sdk/history-e2e.jsonl`).text();
  const msgs = text.trim().split('\n').map((l) => JSON.parse(l).data);
  const iz = new Itemizer(Date.now, true);
  for (const m of msgs) iz.ingest(m);
  iz.closeTurn('completed');
  const { items, turns } = iz.snapshot();

  test('one turn per human prompt, interrupted turn marked', () => {
    expect(items.filter((i) => i.type === 'userMessage' && !i.synthetic)).toHaveLength(3);
    expect(turns.map((t) => t.status)).toEqual(['completed', 'interrupted', 'completed']);
  });

  test('interrupt marker becomes a notice, denied write shows error', () => {
    expect(items.some((i) => i.type === 'notice' && i.kind === 'interrupted')).toBe(true);
    const writes = items.filter((i) => i.type === 'toolCall' && i.name === 'Write');
    expect(writes.map((w) => w.type === 'toolCall' && w.status)).toEqual(['failed', 'completed']);
  });
});

describe('itemizer: a background agent hands back its report', () => {
  const frame = (from: string, report: string) =>
    `Another Claude session sent a message:\n<agent-message from="${from}">\n[Subagent hand-back] The text below is the final report of a subagent. The report follows:\n${report
      .split('\n')
      .map((l) => '  ' + l)
      .join('\n')}\n</agent-message>\n\nThat "other Claude session" is an agent working inside this same session.`;
  const launch = [
    { type: 'user', uuid: 'p1', origin: { kind: 'human' }, message: { role: 'user', content: [{ type: 'text', text: 'Run an agent' }] } },
    { type: 'assistant', uuid: 'a1', message: { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_A', name: 'Agent', input: { description: '5 second timer', prompt: 'sleep 5' } }] } },
    {
      type: 'user',
      uuid: 'r1',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_A', content: [{ type: 'text', text: 'Async agent launched successfully.\nagentId: abc123 (internal ID)' }] }] },
      tool_use_result: { isAsync: true, status: 'async_launched', agentId: 'abc123', description: '5 second timer' },
    },
  ];
  const handback = {
    type: 'user',
    uuid: 'h1',
    isMeta: true,
    origin: { kind: 'peer', from: 'abc123', senderTaskId: 'abc123', name: 'general-purpose', handback: true },
    message: { role: 'user', content: frame('abc123', 'hello world\n- second line') },
  };
  const notification = {
    type: 'user',
    uuid: 'n1',
    origin: { kind: 'task-notification' },
    message: {
      role: 'user',
      content: `<task-notification>\n<task-id>abc123</task-id>\n<tool-use-id>toolu_A</tool-use-id>\n<status>completed</status>\n<summary>Agent "5 second timer" finished</summary>\n<result>This agent's report was delivered to you as a message from "abc123" (its SubagentHandback call). Read it there; it is not repeated here.</result>\n</task-notification>`,
    },
  };

  test('the report alone, from the agent, and no notice after it', () => {
    const iz = new Itemizer(Date.now, true);
    for (const m of [...launch, handback, notification]) iz.ingest(m);
    const { items } = iz.snapshot();
    const report = items.find((i) => i.type === 'userMessage' && i.id === 'h1');
    expect(report).toMatchObject({ synthetic: true, origin: 'subagent', originName: '5 second timer', content: [{ type: 'text', text: 'hello world\n- second line' }] });
    expect(items.some((i) => i.type === 'notice')).toBe(false);
  });

  test("a notice never shows the CLI's note to the model", () => {
    const iz = new Itemizer(Date.now);
    iz.beginUserTurn('p1', [{ type: 'text', text: 'Run an agent' }], false);
    for (const m of launch.slice(1)) iz.ingest(m);
    iz.ingest({
      type: 'system',
      subtype: 'task_notification',
      uuid: 'n2',
      task_id: 'abc123',
      tool_use_id: 'toolu_A',
      status: 'completed',
      summary: 'This agent\'s report was delivered to you as a message from "abc123" (its SubagentHandback call).',
    });
    const notice = iz.snapshot().items.find((i) => i.type === 'notice');
    expect(notice).toMatchObject({ kind: 'taskNotification', text: 'Agent "5 second timer" finished' });
  });
});
