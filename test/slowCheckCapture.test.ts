import { describe, expect, test } from 'bun:test';
import type { Item } from '../src/protocol/index.ts';
import { Itemizer, type Emission } from '../src/threads/itemizer.ts';
import { ingestHistory, TranscriptExtras } from '../src/threads/FollowedThread.ts';
import { runResultReader, workflowAgentLocator, workflowCallLocator } from '../src/threads/workflows.ts';

/**
 * A second real run in the same chat, slow-check (Wait: three haiku agents, each told to run
 * `sleep 45` in Bash; Report: one agent), captured with TETHER_DEBUG_TASKS=1 against Claude Code
 * 2.1.291, paths scrubbed:
 *
 * - `stream.jsonl`: every raw task_* message the daemon got from the run's launch on. The agents
 *   ran their `sleep` in the background: four `local_bash` tasks (one a Monitor) with
 *   `owned_by_subagent: true` and a `tool_use_id` that is a call inside a workflow agent, never in
 *   the main transcript; each was killed when its agent finished. Their notifications don't say
 *   they're owned: only the start does.
 * - `history.jsonl`: the run's turns as the SDK reads the transcript back. The CLI wrote no
 *   `<task-notification>` for the agents' commands, only the workflow's.
 * - `session/`: the run record, the journal, the agents' metadata and transcripts (attachments
 *   dropped), which hold the `sleep` calls.
 *
 * Live, the `<task-notification>` message that starts the answering turn never reaches the SDK
 * stream: the daemon got the task_notification event at 22:07:14.139, then the reply. So the
 * finish is the event's to say, and the result is the run record's.
 */
const DIR = `${import.meta.dir}/fixtures/workflows/slow-check`;
const SESSION = `${DIR}/session`;
const RUN = 'wf_2395e7e7-385';
const TASK = 'wmcpqnf9b';
const CALL = 'toolu_01Jby5Vz6jDDNapaZdT1BPdG';
const FINISH = `workflow_${TASK}_finished`;
/** Each agent's own background task, and the agent whose transcript holds its call. */
const OWNED: Record<string, string> = {
  burds59jn: 'a94a2c3c8051bd3b2', // wait-1's sleep
  bugthm7m1: 'a7e44f6cd9ebe1b61', // wait-2's sleep
  b8r5g0sol: 'aedf699f0125cc7a8', // wait-3's sleep
  bv2g61ik6: 'aedf699f0125cc7a8', // wait-3's Monitor, "waiting for sleep 45 to complete"
};

const lines = async (name: string): Promise<any[]> =>
  (await Bun.file(`${DIR}/${name}`).text())
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));

const stream = await lines('stream.jsonl');
const history = await lines('history.jsonl');
const [prompt, launch, launchResult, waiting, , finishMessage, reply] = history;
const ended = (uuid: string) => ({ type: 'result', subtype: 'success', uuid });
const RESULT = JSON.stringify(
  {
    waits: [
      'waited',
      'Waiting for sleep to complete...\n\nwaited',
      "I'm now monitoring for the sleep task to complete. Once it finishes, I'll reply with the required message.",
    ],
    report: 'all waited',
  },
  null,
  2,
);

/** What the daemon saw: the launching turn, the run's events after it ended, then the reply, with no finish message. */
function live(opts: { disk?: boolean } = { disk: true }) {
  const iz = new Itemizer(() => 1);
  if (opts.disk) {
    iz.locateWorkflowCall = workflowCallLocator(SESSION);
    iz.readRunResult = runResultReader(SESSION);
  }
  const out: Emission[] = [];
  const step = (m: any) => out.push(...iz.ingest(m));
  out.push(...iz.beginUserTurn(prompt.uuid, [{ type: 'text', text: 'ultracode: …' }], false).out);
  const [started, ...rest] = stream;
  step(launch);
  step(started);
  step(launchResult);
  step(waiting);
  step(ended('r1'));
  for (const m of rest) step(m);
  const atReply = out.length;
  step(reply);
  step(ended('r2'));
  return { iz, out, atReply };
}

function read() {
  const iz = new Itemizer(() => 1, true);
  iz.locateWorkflowAgent = workflowAgentLocator(SESSION);
  ingestHistory(iz, history, new TranscriptExtras());
  iz.closeTurn('completed');
  return iz.snapshot();
}

const finishOf = (items: Item[]) => items.filter((i) => i.type === 'userMessage' && i.origin === 'workflow') as any[];
const turnOf = (items: Item[], id: string) => items.find((i) => i.id === id)?.turnId;
const taskEvents = (out: Emission[], taskId: string) =>
  out.flatMap((e) => (e.method === 'task/event' && (e.body as any).taskId === taskId ? [e.body as any] : []));

describe('slow-check, streamed live', () => {
  const { iz, out, atReply } = live();
  const items = iz.snapshot().items;

  test('the stream has no finish message: the event alone says it', () => {
    expect(stream.at(-1)).toMatchObject({ subtype: 'task_notification', task_id: TASK, status: 'completed' });
    expect(finishMessage.uuid).toBe('537ce9e8-da8a-422e-9744-aca679006835');
    expect(items.some((i) => i.id === finishMessage.uuid)).toBe(false);
  });

  test('the finish is one item, before the reply, opening the turn that answers it', () => {
    const before = finishOf(out.slice(0, atReply).flatMap((e) => (e.method === 'item/completed' ? [e.body.item as Item] : [])));
    expect(before.map((i) => i.id)).toEqual([FINISH]);
    const finish = finishOf(items);
    expect(finish).toHaveLength(1);
    expect(finish[0]).toMatchObject({ id: FINISH, turnId: `turn_${FINISH}`, originName: 'slow-check', synthetic: true });
    expect(turnOf(items, `${reply.message.id}:0`)).toBe(`turn_${FINISH}`);
    expect(iz.snapshot().turns.map((t) => t.id)).toEqual([prompt.uuid, `turn_${FINISH}`]);
  });

  test("it holds the run's result, from its record, as history's message does", () => {
    expect(finishOf(items)[0].content[0].text).toBe(RESULT);
    expect(iz.workflowByRun(RUN)!.result).toBe(RESULT);
  });

  test('without the record it says the summary', () => {
    const { iz } = live({ disk: false });
    expect(finishOf(iz.snapshot().items)[0].content[0].text).toBe('Dynamic workflow "Three agents sleep 45s, then one reports" completed');
  });

  test("the agents' own commands are no notices in the chat", () => {
    expect(items.filter((i) => i.type === 'notice')).toEqual([]);
    expect(live({ disk: false }).iz.snapshot().items.filter((i) => i.type === 'notice')).toEqual([]);
  });

  test("each agent's command is said to be its agent's, on every event", () => {
    for (const [taskId, agentId] of Object.entries(OWNED)) {
      const events = taskEvents(out, taskId);
      expect(events.map((e) => e.event)).toEqual(['started', 'updated', 'notification']);
      for (const e of events) expect(e).toMatchObject({ ownedBySubagent: true, workflowToolUseId: CALL, workflowAgentId: agentId });
    }
    // The agent ids are the snapshot's, so a client finds each agent's row.
    const agents = iz.workflowByRun(RUN)!.agents;
    expect(agents.find((a) => a.agentId === OWNED.burds59jn)?.label).toBe('wait-1');
    expect(agents.find((a) => a.agentId === OWNED.b8r5g0sol)?.label).toBe('wait-3');
  });

  test('without the transcripts, a command is the running workflow\'s', () => {
    const { out } = live({ disk: false });
    for (const taskId of Object.keys(OWNED))
      for (const e of taskEvents(out, taskId)) {
        expect(e).toMatchObject({ ownedBySubagent: true, workflowToolUseId: CALL });
        expect(e.workflowAgentId).toBeUndefined();
      }
  });

  test('the workflow and its call carry no owner', () => {
    for (const e of taskEvents(out, TASK)) {
      expect(e.ownedBySubagent).toBeUndefined();
      expect(e.workflowToolUseId).toBeUndefined();
    }
  });
});

describe('slow-check, read from history', () => {
  const { items, turns } = read();

  test('the finish is the same item, in the same turn, with the same text, as live', () => {
    const liveItems = live().iz.snapshot().items;
    const finish = finishOf(items);
    expect(finish).toHaveLength(1);
    expect(finish[0].id).toBe(FINISH);
    expect(finish[0].turnId).toBe(finishOf(liveItems)[0].turnId);
    expect(finish[0].content[0].text).toBe(finishOf(liveItems)[0].content[0].text);
    expect(turnOf(items, `${reply.message.id}:0`)).toBe(turnOf(liveItems, `${reply.message.id}:0`));
    expect(turns.map((t) => t.id)).toEqual([prompt.uuid, `turn_${FINISH}`]);
    expect(items.filter((i) => i.type === 'notice')).toEqual([]);
  });
});
