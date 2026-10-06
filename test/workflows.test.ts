import { afterAll, describe, expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Item } from '../src/protocol/index.ts';
import { Itemizer, parseTaskNotification, type Emission } from '../src/threads/itemizer.ts';
import { ThreadManager } from '../src/threads/ThreadManager.ts';
import {
  agentState,
  mergeWorkflowProgress,
  readAgentItems,
  readRunJournal,
  readRunRecord,
  scriptMeta,
  workflowAgentLocator,
  workflowCallName,
} from '../src/threads/workflows.ts';

/**
 * A real run of the ls-consensus workflow (three haiku agents run `ls`, a fourth checks they
 * agree), paths scrubbed: its transcript as the SDK reads it back, and the session's folder.
 */
const FIXTURES = `${import.meta.dir}/fixtures/workflows`;
const SESSION = `${FIXTURES}/session`;
const RUN = 'wf_f84c043c-21e';
const TASK = 'wj48yidy3';
const CALL = 'toolu_01JB6kgtS5GRK3NkWjiwSjv8';

async function history(): Promise<any[]> {
  const text = await Bun.file(`${FIXTURES}/history.jsonl`).text();
  return text.trim().split('\n').map((l) => JSON.parse(l));
}

const record = await Bun.file(`${SESSION}/workflows/${RUN}.json`).json();
const progress: any[] = record.workflowProgress;
const SCRIPT: string = record.script;

const items = (out: Emission[]) => out.flatMap((e) => (e.method === 'item/completed' ? [e.body.item as Item] : []));
const taskEvents = (out: Emission[]) => out.flatMap((e) => (e.method === 'task/event' ? [e.body as any] : []));

describe('workflow scripts', () => {
  test('meta is read from the script without running it', () => {
    expect(scriptMeta(SCRIPT)).toEqual({
      name: 'ls-consensus',
      description: 'Three haiku agents run ls; a fourth verifies they agree',
      phases: [
        { index: 1, title: 'List', detail: '3 haiku agents run ls' },
        { index: 2, title: 'Verify', detail: 'haiku checks agreement' },
      ],
    });
  });

  test('a call is named by its meta, else the named workflow, else the script file', () => {
    expect(workflowCallName({ script: SCRIPT })).toBe('ls-consensus');
    expect(workflowCallName({ name: 'review-changes' })).toBe('review-changes');
    expect(workflowCallName({ scriptPath: `/x/workflows/scripts/ls-consensus-${RUN}.js` })).toBe('ls-consensus');
  });

  test("agent states go through as the CLI sent them", () => {
    expect(['start', 'progress', 'done', 'error', 'queued', 'thinking'].map(agentState)).toEqual(['start', 'progress', 'done', 'error', 'queued', 'thinking']);
    // A skipped agent is an error with `skipped`, as the CLI reports it.
    const w = mergeWorkflowProgress({ phases: [], agents: [] }, [
      { type: 'workflow_agent', index: 1, label: 'a', state: 'error', error: 'skipped by user', skipped: true },
      { type: 'workflow_agent', index: 2, label: 'b', state: 'done', cached: true },
    ]);
    expect(w.agents.map((a) => [a.state, a.skipped, a.cached])).toEqual([
      ['error', true, undefined],
      ['done', undefined, true],
    ]);
  });

  test('progress merges by type and index, and log lines are dropped', () => {
    const start = mergeWorkflowProgress({ phases: scriptMeta(SCRIPT).phases, agents: [] }, [
      { type: 'workflow_phase', index: 1, title: 'List' },
      { type: 'workflow_agent', index: 1, label: 'ls-0', state: 'start' },
      { type: 'workflow_log', message: 'hello' },
    ]);
    const next = mergeWorkflowProgress(start, [{ type: 'workflow_agent', index: 1, label: 'ls-0', state: 'done', tokens: 5 }]);
    expect(next.agents).toEqual([{ index: 1, label: 'ls-0', state: 'done', tokens: 5 }]);
    // The script's detail survives an entry that has none.
    expect(next.phases[0]).toEqual({ index: 1, title: 'List', detail: '3 haiku agents run ls' });
    expect(next.phases).toHaveLength(2);
  });
});

describe('a workflow streamed live', async () => {
  const h = await history();
  const launch = h.find((m) => m.type === 'assistant' && m.message.content.some((b: any) => b.name === 'Workflow'));
  const launchResult = h.find((m) => m.type === 'user' && Array.isArray(m.message.content) && m.message.content[0]?.tool_use_id === CALL);
  const peer = h.find((m) => m.origin?.kind === 'peer' && m.origin.from === 'a7967148a35efb746');
  const otherSession = h.find((m) => m.origin?.kind === 'peer' && String(m.origin.from).startsWith('uds:'));
  const finish = h.find((m) => m.origin?.kind === 'task-notification');

  let t = 1000;
  const iz = new Itemizer(() => ++t);
  const out: Emission[][] = [];
  const step = (m: any) => {
    const e = iz.ingest(m);
    out.push(e);
    return e;
  };
  const sys = (subtype: string, rest: Record<string, unknown>) => ({ type: 'system', subtype, task_id: TASK, tool_use_id: CALL, uuid: `${subtype}-${out.length}`, ...rest });
  const usage = (n: number) => ({ total_tokens: n, tool_uses: n / 1000, duration_ms: n });
  const agents = progress.filter((e) => e.type === 'workflow_agent');
  const phases = progress.filter((e) => e.type === 'workflow_phase');

  const first = iz.beginUserTurn('u1', [{ type: 'text', text: 'do an ultracode workflow' }], false).turnId;
  step(launch);
  const started = step(
    sys('task_started', {
      description: 'Three haiku agents run ls; a fourth verifies they agree',
      task_type: 'local_workflow',
      workflow_name: 'ls-consensus',
      prompt: SCRIPT,
    }),
  );
  step({
    ...launchResult,
    tool_use_result: { status: 'async_launched', taskId: TASK, taskType: 'local_workflow', workflowName: 'ls-consensus', runId: RUN },
  });
  step({ type: 'result', subtype: 'success', uuid: 'r1' });
  const p1 = step(
    sys('task_progress', {
      description: 'List: ls-0',
      usage: usage(1000),
      workflow_progress: [phases[0], ...agents.slice(0, 3).map((a) => ({ ...a, state: 'start' })), { type: 'workflow_log', message: 'x' }],
    }),
  );
  const p2 = step(sys('task_progress', { description: 'List: ls-2', usage: usage(2000) }));
  const peerOut = step(peer);
  const otherOut = step(otherSession);
  step({ type: 'result', subtype: 'success', uuid: 'r2' });
  const p3 = step(sys('task_progress', { description: 'Verify: verify', usage: usage(3000), workflow_progress: progress }));
  const done = step(sys('task_notification', { status: 'completed', summary: 'Dynamic workflow "Three haiku agents run ls; a fourth verifies they agree" completed', usage: usage(4000) }));
  const finished = step(finish);

  test('the start names the workflow, its phases from the script, and drops the script', () => {
    const e = taskEvents(started)[0];
    expect(e.workflow.name).toBe('ls-consensus');
    expect(e.workflow.description).toBe('Three haiku agents run ls; a fourth verifies they agree');
    expect(e.workflow.status).toBe('running');
    expect(e.workflow.phases.map((p: any) => p.title)).toEqual(['List', 'Verify']);
    expect(e.data.prompt).toBeUndefined();
  });

  test('progress keeps the started description and says the latest agent as activity', () => {
    const e = taskEvents(p1)[0];
    expect(e.description).toBeUndefined();
    expect(e.workflow.activity).toBe('List: ls-0');
    expect(e.workflow.agents.map((a: any) => [a.label, a.state])).toEqual([
      ['ls-0', 'start'],
      ['ls-1', 'start'],
      ['ls-2', 'start'],
    ]);
    expect(e.workflow.runId).toBe(RUN);
    expect(e.data.workflow_progress).toBeUndefined();
  });

  test('progress without agents sends no snapshot, and the last one holds', () => {
    const e = taskEvents(p2)[0];
    expect(e.workflow).toBeUndefined();
    expect(e.description).toBeUndefined();
    const w = taskEvents(p3)[0].workflow;
    expect(w.description).toBe('Three haiku agents run ls; a fourth verifies they agree');
    expect(w.agents).toHaveLength(4);
    expect(w.agents.every((a: any) => a.state === 'done')).toBe(true);
    expect(w.phases[1]).toEqual({ index: 2, title: 'Verify', detail: 'haiku checks agreement' });
    expect(w.activity).toBe('Verify: verify');
  });

  test("an agent's message to the session goes under its workflow", () => {
    const m = items(peerOut).find((i) => i.type === 'userMessage') as any;
    expect(m.parentToolUseId).toBe(CALL);
    expect(m.synthetic).toBe(true);
    expect(m.turnId).toBe(first);
    // Another session's message is still the chat's.
    const other = items(otherOut).find((i) => i.type === 'userMessage') as any;
    expect(other.parentToolUseId).toBeNull();
  });

  test('the finish is one message from the workflow holding its result, and no notice', () => {
    expect(taskEvents(done)[0].workflow.status).toBe('completed');
    const all = out.flat();
    expect(items(all).filter((i) => i.type === 'notice')).toEqual([]);
    const msgs = items(finished).filter((i) => i.type === 'userMessage') as any[];
    expect(msgs).toHaveLength(1);
    expect(msgs[0].origin).toBe('workflow');
    expect(msgs[0].originName).toBe('ls-consensus');
    expect(msgs[0].synthetic).toBe(true);
    expect(JSON.parse(msgs[0].content[0].text).verdict.agree).toBe(true);
    // The event said it first, opening the turn that answers it; the message filled in the result.
    expect(msgs[0].id).toBe(`workflow_${TASK}_finished`);
    expect(msgs[0].turnId).toBe(`turn_workflow_${TASK}_finished`);
    expect(msgs[0].turnId).not.toBe(first);
    expect(done.some((e) => e.method === 'turn/started')).toBe(true);
    expect(finished.some((e) => e.method === 'turn/started' || e.method === 'item/started')).toBe(false);
  });

  test('the snapshot is kept, with the result, by run id', () => {
    const w = iz.workflowByRun(RUN)!;
    expect(w.status).toBe('completed');
    expect(w.totalTokens).toBe(4000);
    expect(JSON.parse(w.result!).counts).toEqual([10, 10, 10]);
  });
});

describe('a workflow read from history', async () => {
  const h = await history();
  const iz = new Itemizer(() => 1, true);
  iz.locateWorkflowAgent = workflowAgentLocator(SESSION);
  for (const m of h) iz.ingest(m);
  iz.closeTurn('completed');
  const { items, turns } = iz.snapshot();

  test('the finish is a message from the workflow, beginning its own turn', () => {
    const finish = items.filter((i) => i.type === 'userMessage' && i.origin === 'workflow') as any[];
    expect(finish).toHaveLength(1);
    expect(finish[0].originName).toBe('ls-consensus');
    expect(finish[0].content[0].text).toContain('"agree": true');
    const call = items.find((i) => i.id === CALL)!;
    expect(finish[0].id).toBe(`workflow_${TASK}_finished`);
    expect(finish[0].turnId).toBe(`turn_workflow_${TASK}_finished`);
    expect(finish[0].turnId).not.toBe(call.turnId);
    expect(items.filter((i) => i.type === 'notice' && i.kind === 'taskNotification')).toEqual([]);
  });

  test("agents' messages go under the workflow; other sessions' stay in the chat", () => {
    const peers = items.filter((i) => i.type === 'userMessage' && i.origin === 'peer') as any[];
    expect(peers.filter((p) => p.parentToolUseId === CALL)).toHaveLength(5);
    expect(peers.filter((p) => p.parentToolUseId === null)).toHaveLength(2);
  });

  test('items and turns carry the times they were written', () => {
    const call = items.find((i) => i.id === CALL)!;
    expect(call.createdAt).toBe(Date.parse('2026-10-06T15:16:32.908Z'));
    for (const i of items) expect(i.createdAt).toBeGreaterThan(Date.parse('2026-10-06T00:00:00Z'));
    expect(turns[0]!.startedAt).toBe(Date.parse('2026-10-06T15:16:27.503Z'));
    expect(turns[0]!.completedAt!).toBeLessThan(Date.parse('2026-10-06T15:17:20.560Z'));
  });
});

describe('task notifications', () => {
  test('carry the result and output file', () => {
    const n = parseTaskNotification(
      '<task-notification>\n<task-id>t</task-id>\n<output-file>/tmp/t.output</output-file>\n<status>completed</status>\n<summary>s</summary>\n<result>{"a":"<b>x</b>"}</result>\n<diagnostics>d</diagnostics>\n</task-notification>',
    )!;
    expect(n.result).toBe('{"a":"<b>x</b>"}');
    expect(n.outputFile).toBe('/tmp/t.output');
  });
});

describe('workflow runs on disk', () => {
  test('a finished run, from its record', async () => {
    const w = (await readRunRecord(SESSION, RUN))!;
    expect(w.name).toBe('ls-consensus');
    expect(w.status).toBe('completed');
    expect(w.phases).toEqual([
      { index: 1, title: 'List', detail: '3 haiku agents run ls' },
      { index: 2, title: 'Verify', detail: 'haiku checks agreement' },
    ]);
    expect(w.agents.map((a) => [a.label, a.phaseTitle, a.state])).toEqual([
      ['ls-0', 'List', 'done'],
      ['ls-1', 'List', 'done'],
      ['ls-2', 'List', 'done'],
      ['verify', 'Verify', 'done'],
    ]);
    expect(w.totalTokens).toBe(98951);
    expect(w.toolUses).toBe(23);
    expect(JSON.parse(w.result!).verdict.agree).toBe(true);
    expect(w.result).toContain('\n  "counts"');
    expect(w.error).toBeUndefined();
  });

  test('a run with only a journal, its status unknown', async () => {
    expect(await readRunRecord(SESSION, 'wf_journalonly-1')).toBeUndefined();
    const w = (await readRunJournal(SESSION, 'wf_journalonly-1'))!;
    // Still going, or cut off: the journal can't say, so it isn't reported as running.
    expect(w.status).toBe('unknown');
    expect(w.name).toBe('ls-consensus');
    expect(w.agents.map((a) => [a.label, a.state, a.model])).toEqual([
      ['ls-0', 'progress', 'haiku'],
      ['ls-1', 'progress', 'haiku'],
      ['ls-2', 'done', 'haiku'],
    ]);
    expect(w.phases.map((p) => p.title)).toEqual(['List', 'Verify']);
  });

  test("an agent's transcript, itemized", async () => {
    const items = await readAgentItems(SESSION, RUN, 'a8a2b2c3f7641bbd4');
    expect(items[0]?.type).toBe('userMessage');
    const call = items.find((i) => i.type === 'toolCall') as any;
    expect(call.name).toBe('StructuredOutput');
    expect(call.status).toBe('completed');
    expect(items.some((i) => i.type === 'agentMessage')).toBe(true);
    expect(items.every((i) => i.parentToolUseId === null)).toBe(true);
    expect(await readAgentItems(SESSION, RUN, 'nobody')).toEqual([]);
  });

  test('ids that could leave the folder are refused', async () => {
    expect(await readRunRecord(SESSION, '../workflows/wf_f84c043c-21e')).toBeUndefined();
    expect(await readRunJournal(SESSION, '..')).toBeUndefined();
    expect(await readAgentItems(SESSION, RUN, '../../x')).toEqual([]);
    expect(await readAgentItems(SESSION, '../wf_f84c043c-21e', 'a8a2b2c3f7641bbd4')).toEqual([]);
  });
});

describe('workflow methods', () => {
  // A Claude config folder whose projects hold the fixture session, found by its transcript as the CLI's are.
  const home = mkdtempSync(join(tmpdir(), 'tether-wf-'));
  const sid = '7b6fdb6f-2818-40c9-a34a-82ca9650b1e0';
  const project = join(home, 'projects', '-home-me');
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, `${sid}.jsonl`), '');
  cpSync(SESSION, join(project, sid), { recursive: true });
  const saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = home;
  const mgr = new ThreadManager({ path: '/usr/bin/false', version: '0' } as any);
  afterAll(() => {
    mgr.shutdown();
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
    rmSync(home, { recursive: true, force: true });
  });

  test('workflow/read finds the record, then the journal, else nothing', async () => {
    expect((await mgr.readWorkflow(sid, RUN))?.status).toBe('completed');
    expect((await mgr.readWorkflow(sid, 'wf_journalonly-1'))?.status).toBe('unknown');
    expect(await mgr.readWorkflow(sid, 'wf_missing')).toBeNull();
  });

  test('workflow/agentItems reads an agent', async () => {
    expect((await mgr.workflowAgentItems(sid, RUN, 'a7967148a35efb746')).length).toBeGreaterThan(0);
    expect(await mgr.workflowAgentItems(sid, RUN, 'a0')).toEqual([]);
  });

  test('path traversal is refused', async () => {
    await expect(mgr.readWorkflow(sid, '../../etc')).rejects.toThrow();
    await expect(mgr.workflowAgentItems(sid, RUN, '../agent-a7967148a35efb746')).rejects.toThrow();
    await expect(mgr.readWorkflow('../x', RUN)).rejects.toThrow();
  });
});
