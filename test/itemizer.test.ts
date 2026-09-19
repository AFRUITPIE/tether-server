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
