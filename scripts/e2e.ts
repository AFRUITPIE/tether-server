// End-to-end smoke test against the real `claude` on PATH (uses the haiku model).
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TetherClient } from '../src/client/TetherClient.ts';

// TETHER_E2E_MODEL / TETHER_E2E_EFFORT pick what the runs cost, e.g. sonnet at low effort.
const model = { model: process.env.TETHER_E2E_MODEL ?? 'haiku', ...(process.env.TETHER_E2E_EFFORT ? { effort: process.env.TETHER_E2E_EFFORT as 'low' } : {}) };

const server = process.argv[2] ? process.argv.slice(2) : ['bun', 'run', join(import.meta.dir, '../src/cli.ts'), 'serve', '--stdio'];
const cwd = mkdtempSync(join(tmpdir(), 'tether-e2e-'));
writeFileSync(join(cwd, 'hello.txt'), 'hello from tether\n');
const c = TetherClient.spawn(server);
const events: { method: string; params: any }[] = [];
c.on((method, params) => events.push({ method, params }));
const ok = (cond: unknown, msg: string) => {
  if (!cond) {
    console.error('FAIL:', msg);
    process.exit(1);
  }
  console.log('ok -', msg);
};

let denyNext = true;
c.onServerRequest = (method, params) => {
  if (method === 'permission/request') {
    console.log(`  permission/request ${params.toolName}: ${params.title ?? ''}`);
    if (denyNext) {
      denyNext = false;
      return { decision: 'deny', message: 'Not that file name; use result.md instead.' };
    }
    return { decision: 'allow', scope: 'once' };
  }
  if (method === 'question/request') return { decision: 'answer', answers: Object.fromEntries(params.questions.map((q: any) => [q.question, q.options[0].label])) };
  return { decision: 'deny' };
};

const init = await c.initialize();
ok(init.claude.version && init.protocolVersion === 1, `initialize (claude ${init.claude.version})`);
const models = await c.call('model/list', { cwd });
ok(models.models.length > 0, `model/list returned ${models.models.length} models`);

const { thread } = await c.call('thread/start', { cwd, ...model, permissionMode: 'default' });
ok(thread.threadId && thread.status === 'idle', `thread/start ${thread.threadId}`);

const done1 = c.waitFor((m, p) => m === 'turn/completed' && p.threadId === thread.threadId);
await c.call('turn/start', {
  threadId: thread.threadId,
  input: [{ type: 'text', text: 'Create a file named out.md containing the word "tether". If you are told to use a different name, do so. Reply with one short sentence.' }],
});
const t1 = await done1;
ok(t1.params.turn.status === 'completed', `turn 1 completed (cost $${t1.params.turn.result.totalCostUsd.toFixed(4)})`);
ok(existsSync(join(cwd, 'result.md')) && !existsSync(join(cwd, 'out.md')), 'deny then allow: result.md written, out.md not');
const deltas = events.filter((e) => e.method === 'item/agentMessage/delta').length;
ok(deltas > 0, `streamed ${deltas} text deltas`);
const denied = events.find((e) => e.method === 'item/completed' && e.params.item.type === 'toolCall' && e.params.item.status === 'denied');
ok(denied, 'denied tool call has status=denied');
ok(events.some((e) => e.method === 'serverRequest/resolved'), 'serverRequest/resolved emitted');
const seqs = events.filter((e) => e.params?.threadId === thread.threadId).map((e) => e.params.seq);
ok(seqs.every((s, i) => i === 0 || s > seqs[i - 1]), 'seq strictly increasing');

// Mid-turn queue + interrupt
const done2 = c.waitFor((m, p) => m === 'turn/completed' && p.threadId === thread.threadId);
await c.call('turn/start', { threadId: thread.threadId, input: [{ type: 'text', text: 'Run `sleep 30` with Bash, then say hi.' }] });
await c.waitFor((m, p) => m === 'item/started' && p.item.type === 'toolCall' && p.item.name === 'Bash');
await Bun.sleep(1500);
await c.call('turn/interrupt', { threadId: thread.threadId });
const t2 = await done2;
ok(t2.params.turn.status === 'interrupted', `interrupt → turn status ${t2.params.turn.status}`);

// History + list + fork
const read = await c.call('thread/read', { threadId: thread.threadId, cwd });
ok(read.items.filter((i) => i.type === 'userMessage').length >= 2, `thread/read: ${read.items.length} items, ${read.turns.length} turns`);
const list = await c.call('thread/list', { cwd });
ok(list.threads.some((t) => t.threadId === thread.threadId), 'thread/list includes thread');
const fork = await c.call('thread/fork', { threadId: thread.threadId });
ok(fork.threadId && fork.threadId !== thread.threadId, `thread/fork → ${fork.threadId}`);

// AskUserQuestion + plan approval
let asked = false, planned = false;
const prevHandler = c.onServerRequest;
c.onServerRequest = (method, params) => {
  if (method === 'question/request') { asked = true; return { decision: 'answer', answers: Object.fromEntries(params.questions.map((q: any) => [q.question, 'blue'])) }; }
  if (method === 'plan/approve') { planned = true; return { decision: 'approve', permissionMode: 'acceptEdits' }; }
  return prevHandler(method, params);
};
const q = await c.call('thread/start', { cwd, ...model, permissionMode: 'plan' });
const done4 = c.waitFor((m, p) => m === 'turn/completed' && p.threadId === q.thread.threadId, 240_000);
await c.call('turn/start', { threadId: q.thread.threadId, input: [{ type: 'text', text: 'First use the AskUserQuestion tool to ask which color I prefer (options: red, blue). Then present a one-step plan to write that color into color.txt and exit plan mode. After approval, write the file.' }] });
await done4;
ok(asked, 'question/request answered');
ok(planned, 'plan/approve answered');
ok(existsSync(join(cwd, 'color.txt')) && /blue/i.test(readFileSync(join(cwd, 'color.txt'), 'utf8')), 'color.txt contains the answer');
const loaded = await c.call('thread/loaded', {});
ok(loaded.threads.find((t) => t.threadId === q.thread.threadId)?.permissionMode === 'acceptEdits', 'permission mode switched to acceptEdits after plan approval');
c.onServerRequest = prevHandler;

// Resume in a fresh server process (simulates reconnect without daemon)
if (process.env.TETHER_RECORD) {
  await Bun.write(process.env.TETHER_RECORD, c.transcript.map((t) => JSON.stringify(t)).join('\n') + '\n');
  console.log(`recorded ${c.transcript.length} wire messages to ${process.env.TETHER_RECORD}`);
}
c.close();
const c2 = TetherClient.spawn(server);
await c2.initialize();
const r = await c2.call('thread/resume', { threadId: thread.threadId, includeHistory: true });
ok(r.thread.status === 'idle' && (r.items?.length ?? 0) > 0, `thread/resume in new process with ${r.items?.length} history items`);
const done3 = c2.waitFor((m, p) => m === 'turn/completed');
await c2.call('turn/start', { threadId: thread.threadId, input: [{ type: 'text', text: 'What word did you write into the file? One word.' }] });
const t3 = await done3;
ok(/tether/i.test(t3.params.turn.result.resultText ?? ''), `resumed thread remembers context: "${t3.params.turn.result.resultText}"`);
c2.close();
console.log('\nall e2e checks passed');
process.exit(0);
