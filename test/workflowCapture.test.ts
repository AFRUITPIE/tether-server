import { describe, expect, test } from 'bun:test';
import type { Item, Turn } from '../src/protocol/index.ts';
import { Itemizer, type Emission } from '../src/threads/itemizer.ts';
import { readAgentItems, readRunRecord, unframeAgentPrompt, workflowAgentLocator } from '../src/threads/workflows.ts';

/**
 * A real run of a six-agent haiku workflow, typo-check (Scan, Review, Verify), captured with
 * TETHER_DEBUG_TASKS=1 against Claude Code 2.1.291, paths scrubbed:
 *
 * - `stream.jsonl`: every raw task_started / task_progress / task_updated / task_notification the
 *   daemon got, in order. Agent states seen: start, progress, done. `workflow_progress` rides on
 *   some progress events only, and the last agents' finish was never sent before the notification.
 * - `history.jsonl`: the session's transcript as the SDK reads it back.
 * - `session/`: the run record, the saved script, the journal, the agents' metadata, and one
 *   agent's transcript (verify-1, attachments dropped).
 *
 * The task_notification event and the `<task-notification>` message both arrived at 21:39:38.4,
 * the event first, after the launching turn had ended.
 */
const DIR = `${import.meta.dir}/fixtures/workflows/typo-check`;
const SESSION = `${DIR}/session`;
const RUN = 'wf_a2813ad9-faf';
const TASK = 'wsjxcgcst';
const CALL = 'toolu_01FuEnuQgTxh9GN21FUKNyQ9';
const FINISH = `workflow_${TASK}_finished`;

const lines = async (name: string): Promise<any[]> =>
  (await Bun.file(`${DIR}/${name}`).text())
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));

const stream = await lines('stream.jsonl');
const history = await lines('history.jsonl');

const completedItems = (out: Emission[]) => out.flatMap((e) => (e.method === 'item/completed' ? [e.body.item as Item] : []));
const lastWorkflow = (out: Emission[]) => out.flatMap((e) => (e.method === 'task/event' && (e.body as any).workflow ? [(e.body as any).workflow] : [])).at(-1);

const [prompt, launch, launchResult, waiting, , finishMessage, reply] = history;
const ended = (uuid: string) => ({ type: 'result', subtype: 'success', uuid });

/** The live stream as the daemon saw it: the transcript's messages, the task events between them, and the results. */
function live(opts: { tasks?: any[]; midTurn?: boolean } = {}) {
  const tasks = opts.tasks ?? stream;
  const [started, ...rest] = tasks;
  const iz = new Itemizer(() => 1);
  const out: Emission[] = [];
  const step = (m: any) => out.push(...iz.ingest(m));
  out.push(...iz.beginUserTurn(prompt.uuid, [{ type: 'text', text: 'ultracode: …' }], false).out);
  step(launch);
  step(started);
  step(launchResult);
  if (!opts.midTurn) {
    step(waiting);
    step(ended('r1'));
  }
  for (const m of rest) step(m);
  const atFinish = out.length;
  step(finishMessage);
  step(reply);
  step(ended('r2'));
  return { iz, out, atFinish };
}

function read(messages: any[]) {
  const iz = new Itemizer(() => 1, true);
  iz.locateWorkflowAgent = workflowAgentLocator(SESSION);
  for (const m of messages) iz.ingest(m);
  iz.closeTurn('completed');
  return iz.snapshot();
}

const finishOf = (items: Item[]) => items.filter((i) => i.type === 'userMessage' && i.origin === 'workflow') as any[];
const turnOf = (items: Item[], id: string) => items.find((i) => i.id === id)?.turnId;

describe('typo-check, streamed live', () => {
  const { iz, out, atFinish } = live();

  test("agents' states go through as the CLI sent them", () => {
    const states = new Set(out.flatMap((e) => (e.method === 'task/event' ? ((e.body as any).workflow?.agents ?? []).map((a: any) => a.state) : [])));
    expect([...states].sort()).toEqual(['done', 'progress', 'start']);
  });

  test('the finish is said by the event, opening the turn that answers it', () => {
    const byEvent = finishOf(completedItems(out.slice(0, atFinish)));
    expect(byEvent).toHaveLength(1);
    expect(byEvent[0].id).toBe(FINISH);
    expect(byEvent[0].turnId).toBe(`turn_${FINISH}`);
    expect(byEvent[0].originName).toBe('typo-check');
    expect(byEvent[0].content[0].text).toBe('Dynamic workflow "List files, review each for typos/bugs, verify findings" completed');
  });

  test('the message puts its result in the same item, where it already is', () => {
    const afterMessage = out.slice(atFinish);
    expect(afterMessage.some((e) => e.method === 'item/started' && (e.body.item as Item).id === FINISH)).toBe(false);
    expect(afterMessage.some((e) => e.method === 'turn/started')).toBe(false);
    const finish = finishOf(completedItems(afterMessage));
    expect(finish).toHaveLength(1);
    expect(finish[0].id).toBe(FINISH);
    expect(finish[0].turnId).toBe(`turn_${FINISH}`);
    expect(JSON.parse(finish[0].content[0].text).all).toHaveLength(7);
    // The reply answering it is in that turn.
    expect(turnOf(iz.snapshot().items, `${reply.message.id}:0`)).toBe(`turn_${FINISH}`);
  });

  test('the snapshot completes with its result, and no error', () => {
    const w = iz.workflowByRun(RUN)!;
    expect(w.status).toBe('completed');
    expect(w.agents).toHaveLength(6);
    expect(w.agents.every((a) => a.state === 'done')).toBe(true);
    expect(JSON.parse(w.result!).verified).toHaveLength(2);
    expect(w.error).toBeUndefined();
  });

  test('agents never seen finishing are done once the workflow completes', () => {
    // Progress is throttled: without the last progress that carried agents, verify-1 was last seen in progress.
    const lastAgents = stream.findLastIndex((m) => Array.isArray(m.workflow_progress));
    const { out } = live({ tasks: stream.filter((_, i) => i !== lastAgents) });
    const before = out.flatMap((e) => (e.method === 'task/event' && (e.body as any).event === 'progress' && (e.body as any).workflow ? [(e.body as any).workflow] : [])).at(-1);
    expect(before.agents.map((a: any) => a.state)).toContain('progress');
    expect(lastWorkflow(out).agents.every((a: any) => a.state === 'done')).toBe(true);
  });
});

describe('typo-check, read from history', () => {
  const { items, turns } = read(history);

  test('the finish is the same item, in the same turn, as live', () => {
    const finish = finishOf(items);
    expect(finish).toHaveLength(1);
    expect(finish[0].id).toBe(FINISH);
    expect(finish[0].turnId).toBe(`turn_${FINISH}`);
    expect(JSON.parse(finish[0].content[0].text).all).toHaveLength(7);
    const liveItems = live().iz.snapshot().items;
    expect(finishOf(liveItems)[0].turnId).toBe(finish[0].turnId);
    expect(turnOf(items, CALL)).toBe(turnOf(liveItems, CALL));
    expect(turnOf(items, `${reply.message.id}:0`)).toBe(turnOf(liveItems, `${reply.message.id}:0`));
    expect(turns.map((t: Turn) => t.id)).toEqual([prompt.uuid, `turn_${FINISH}`]);
    expect(live().iz.snapshot().turns.map((t: Turn) => t.id)).toEqual([prompt.uuid, `turn_${FINISH}`]);
  });
});

describe('typo-check, the finish landing mid-turn', () => {
  // The same run, had the launching turn still been going: the notification follows the
  // launch's result directly, before the turn's reply ends it.
  const midTurnHistory = history.filter((m) => m !== waiting && m.type !== 'system');

  test('live, the event waits and the message joins the running turn', () => {
    const { iz, out, atFinish } = live({ midTurn: true });
    expect(finishOf(completedItems(out.slice(0, atFinish)))).toEqual([]);
    const items = iz.snapshot().items;
    const finish = finishOf(items);
    expect(finish).toHaveLength(1);
    expect(finish[0].id).toBe(FINISH);
    expect(finish[0].turnId).toBe(turnOf(items, CALL));
  });

  test('history places it in the same turn', () => {
    const { items } = read(midTurnHistory);
    const finish = finishOf(items);
    expect(finish).toHaveLength(1);
    expect(finish[0].turnId).toBe(turnOf(items, CALL));
    expect(finish[0].turnId).toBe(finishOf(live({ midTurn: true }).iz.snapshot().items)[0].turnId);
  });
});

describe('a workflow stopped or failed', () => {
  const [started, ...rest] = stream;
  const progress = rest.filter((m) => m.subtype === 'task_progress');

  test('stopped with no message, it is still said, in no turn when none is running', () => {
    const iz = new Itemizer(() => 1);
    iz.beginUserTurn('u1', [{ type: 'text', text: 'go' }], false);
    for (const m of [launch, started, launchResult, waiting, ended('r1'), ...progress.slice(0, 5)]) iz.ingest(m);
    const out = iz.ingest({ type: 'system', subtype: 'task_updated', task_id: TASK, patch: { status: 'killed' } });
    const finish = finishOf(completedItems(out));
    expect(finish).toHaveLength(1);
    expect(finish[0].id).toBe(FINISH);
    expect(finish[0].turnId).toBeNull();
    expect(finish[0].content[0].text).toBe('Workflow stopped');
    expect(out.some((e) => e.method === 'turn/started')).toBe(false);
    expect(iz.workflowByRun(RUN)!.status).toBe('stopped');
    // A notification after says nothing more.
    const again = iz.ingest({ type: 'system', subtype: 'task_notification', task_id: TASK, tool_use_id: CALL, status: 'killed' });
    expect(finishOf(completedItems(again))).toEqual([]);
  });

  test('stopped mid-turn, it joins that turn', () => {
    const iz = new Itemizer(() => 1);
    const turnId = iz.beginUserTurn('u1', [{ type: 'text', text: 'go' }], false).turnId;
    for (const m of [launch, started, launchResult]) iz.ingest(m);
    const out = iz.ingest({ type: 'system', subtype: 'task_notification', task_id: TASK, tool_use_id: CALL, status: 'killed' });
    expect(finishOf(completedItems(out))[0].turnId).toBe(turnId);
  });

  test('failed, the error is the snapshot\'s and not its result', () => {
    const iz = new Itemizer(() => 1);
    iz.beginUserTurn('u1', [{ type: 'text', text: 'go' }], false);
    for (const m of [launch, started, launchResult, waiting, ended('r1')]) iz.ingest(m);
    const out = iz.ingest({
      type: 'system',
      subtype: 'task_notification',
      task_id: TASK,
      tool_use_id: CALL,
      status: 'failed',
      summary: 'Dynamic workflow "List files, review each for typos/bugs, verify findings" failed: agent quota exceeded',
    });
    const w = lastWorkflow(out);
    expect(w.status).toBe('failed');
    expect(w.error).toBe('agent quota exceeded');
    expect(w.result).toBeUndefined();
    expect(finishOf(completedItems(out))[0].turnId).toBe(`turn_${FINISH}`);
  });
});

describe('typo-check on disk', () => {
  test('the run record: its result, and no error', async () => {
    const w = (await readRunRecord(SESSION, RUN))!;
    expect(w.name).toBe('typo-check');
    expect(w.status).toBe('completed');
    expect(w.phases.map((p) => p.title)).toEqual(['Scan', 'Review', 'Verify']);
    expect(w.agents.map((a) => [a.label, a.phaseTitle, a.state])).toEqual([
      ['list-files', 'Scan', 'done'],
      ['review:math.swift', 'Review', 'done'],
      ['review:README.md', 'Review', 'done'],
      ['review:notes.md', 'Review', 'done'],
      ['verify-1', 'Verify', 'done'],
      ['verify-2', 'Verify', 'done'],
    ]);
    expect(JSON.parse(w.result!).files).toHaveLength(3);
    expect(w.error).toBeUndefined();
  });

  test("an agent's prompt is its computed task, without the harness's framing", async () => {
    const items = await readAgentItems(SESSION, RUN, 'a657d2373f196b3c2');
    const prompts = items.filter((i) => i.type === 'userMessage' && i.parentToolUseId === null) as any[];
    expect(prompts).toHaveLength(1);
    const text: string = prompts[0].content[0].text;
    expect(text.startsWith('Double-check these findings by reading the files (do not edit). Return only the real ones.\n[{"file"')).toBe(true);
    expect(items.some((i) => JSON.stringify(i).includes('Workflow harness'))).toBe(false);
    expect(items.some((i) => i.type === 'toolCall')).toBe(true);
  });

  test('the framing comes off as the CLI writes it', () => {
    expect(unframeAgentPrompt('[Workflow harness — user request] The harness relays …:\n  ultracode: do it')).toBeNull();
    expect(
      unframeAgentPrompt('[Workflow harness — computed task] The task text … The computed task text follows:\n  Line one\n    indented\n  \n  last'),
    ).toBe('Line one\n  indented\n\nlast');
    expect(unframeAgentPrompt('Just a prompt')).toBeUndefined();
  });
});
