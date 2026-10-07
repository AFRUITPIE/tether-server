import { describe, expect, test } from 'bun:test';
import type { Item, Turn } from '../src/protocol/index.ts';
import { Itemizer, type Emission } from '../src/threads/itemizer.ts';
import { ingestHistory, TranscriptExtras } from '../src/threads/FollowedThread.ts';
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
 *
 * The finish landing mid-turn is this run as the launching turn would have had it had it waited
 * (`midturn.jsonl`: a `sleep` call and its result), in the shape real transcripts give it: the CLI
 * hands the model a mid-turn `<task-notification>` at the turn's next step, written as a
 * `queued_command` attachment after that step's tool result (`midturn-raw.jsonl`, the raw line),
 * never as a user message of that turn; getSessionMessages drops it.
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
const [waitCall, waitResult] = await lines('midturn.jsonl');
const queuedLines = (await Bun.file(`${DIR}/midturn-raw.jsonl`).text()).trim().split('\n');

const completedItems = (out: Emission[]) => out.flatMap((e) => (e.method === 'item/completed' ? [e.body.item as Item] : []));
const lastWorkflow = (out: Emission[]) => out.flatMap((e) => (e.method === 'task/event' && (e.body as any).workflow ? [(e.body as any).workflow] : [])).at(-1);

const [prompt, launch, launchResult, waiting, , finishMessage, reply] = history;
const ended = (uuid: string) => ({ type: 'result', subtype: 'success', uuid });

/**
 * The live stream as the daemon saw it: the transcript's messages, the task events between them,
 * and the results. Mid-turn, the turn waits on a call while the workflow runs and finishes, and the
 * CLI sends no message for the finish in that turn.
 */
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
  if (opts.midTurn) {
    step(waitCall);
    for (const m of rest) step(m);
    const atFinish = out.length;
    step(waitResult);
    step(reply);
    step(ended('r1'));
    return { iz, out, atFinish };
  }
  step(waiting);
  step(ended('r1'));
  for (const m of rest) step(m);
  const atFinish = out.length;
  step(finishMessage);
  step(reply);
  step(ended('r2'));
  return { iz, out, atFinish };
}

function read(messages: any[], raw: string[] = []) {
  const iz = new Itemizer(() => 1, true);
  iz.locateWorkflowAgent = workflowAgentLocator(SESSION);
  const queued = new TranscriptExtras();
  queued.add(raw);
  ingestHistory(iz, messages, queued);
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
  const midTurnHistory = [prompt, launch, launchResult, waitCall, waitResult, reply];
  const order = (items: Item[]) => items.map((i) => i.id);

  test('live, the event waits for the turn\'s next step and says it there, in the running turn', () => {
    const { iz, out, atFinish } = live({ midTurn: true });
    expect(finishOf(completedItems(out.slice(0, atFinish)))).toEqual([]);
    const items = iz.snapshot().items;
    const finish = finishOf(items);
    expect(finish).toHaveLength(1);
    expect(finish[0].id).toBe(FINISH);
    expect(finish[0].turnId).toBe(turnOf(items, CALL));
    expect(finish[0].content[0].text).toBe('Dynamic workflow "List files, review each for typos/bugs, verify findings" completed');
    // Right after the step's tool result, before the reply.
    const ids = order(items);
    expect(ids.indexOf(FINISH)).toBe(ids.indexOf('toolu_midturn_wait') + 1);
    expect(iz.snapshot().turns).toHaveLength(1);
  });

  test('history reads the attachment, the same item in the same place', () => {
    const { items, turns } = read(midTurnHistory, queuedLines);
    const finish = finishOf(items);
    expect(finish).toHaveLength(1);
    expect(finish[0].id).toBe(FINISH);
    expect(finish[0].turnId).toBe(turnOf(items, CALL));
    expect(JSON.parse(finish[0].content[0].text).all).toHaveLength(7);
    expect(turns).toHaveLength(1);
    const liveItems = live({ midTurn: true }).iz.snapshot().items;
    expect(finishOf(liveItems)[0].turnId).toBe(finish[0].turnId);
    expect(order(items)).toEqual(order(liveItems));
  });

  test('without the attachment (getSessionMessages alone) history has no finish', () => {
    expect(finishOf(read(midTurnHistory).items)).toEqual([]);
  });

  test("an attachment written after its message was read is read on the next pass", () => {
    const iz = new Itemizer(() => 1, true);
    const queued = new TranscriptExtras();
    ingestHistory(iz, [prompt, launch, launchResult, waitCall, waitResult], queued);
    queued.add(queuedLines);
    const out = ingestHistory(iz, [reply], queued);
    const ids = order(iz.snapshot().items);
    expect(finishOf(completedItems(out))).toHaveLength(1);
    expect(ids.indexOf(FINISH)).toBe(ids.indexOf('toolu_midturn_wait') + 1);
  });

  test('a finish whose event came at the turn\'s last step comes after it, as the turn that answers it', () => {
    const iz = new Itemizer(() => 1);
    const [started, ...rest] = stream;
    iz.beginUserTurn(prompt.uuid, [{ type: 'text', text: 'go' }], false);
    for (const m of [launch, started, launchResult, waiting, ...rest]) iz.ingest(m);
    expect(finishOf(iz.snapshot().items)).toEqual([]);
    const out = iz.ingest(ended('r1'));
    const finish = finishOf(completedItems(out));
    expect(finish).toHaveLength(1);
    expect(finish[0].turnId).toBe(`turn_${FINISH}`);
    // As history has it: the message after the reply that ended the turn opens the turn that answers it.
    expect(finishOf(read([prompt, launch, launchResult, waiting, finishMessage]).items)[0].turnId).toBe(`turn_${FINISH}`);
  });

  test('an interrupted turn: history and live put the finish in the turn after it', () => {
    const interrupt = {
      type: 'user',
      uuid: '9f1d6c1e-0000-4000-8000-00000000a004',
      session_id: prompt.session_id,
      message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] },
      parent_tool_use_id: null,
      timestamp: '2026-10-06T21:39:20.000Z',
    };
    const fromHistory = read([prompt, launch, launchResult, waitCall, interrupt, finishMessage]);
    expect(finishOf(fromHistory.items)[0].turnId).toBe(`turn_${FINISH}`);
    expect(fromHistory.turns.find((t: Turn) => t.id === prompt.uuid)?.status).toBe('interrupted');

    const iz = new Itemizer(() => 1);
    const [started, ...rest] = stream;
    iz.beginUserTurn(prompt.uuid, [{ type: 'text', text: 'go' }], false);
    for (const m of [launch, started, launchResult, waitCall]) iz.ingest(m);
    iz.noteInterruptRequested();
    iz.ingest(interrupt);
    iz.ingest({ type: 'result', subtype: 'error_during_execution', uuid: 'r1' });
    for (const m of rest) iz.ingest(m);
    iz.ingest(finishMessage);
    expect(finishOf(iz.snapshot().items)[0].turnId).toBe(`turn_${FINISH}`);
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
