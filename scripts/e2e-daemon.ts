// Daemon reattach test: a turn keeps running after the client disconnects, and a
// new client catches up via thread/subscribe {afterSeq}, including parked approvals.
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TetherClient } from '../src/client/TetherClient.ts';

// TETHER_E2E_MODEL / TETHER_E2E_EFFORT pick what the runs cost, e.g. sonnet at low effort.
const model = { model: process.env.TETHER_E2E_MODEL ?? 'haiku', ...(process.env.TETHER_E2E_EFFORT ? { effort: process.env.TETHER_E2E_EFFORT as 'low' } : {}) };

const home = mkdtempSync(join(tmpdir(), 'tether-home-'));
const cwd = mkdtempSync(join(tmpdir(), 'tether-d-'));
const env = { TETHER_HOME: home };
const cmd = ['bun', 'run', join(import.meta.dir, '../src/cli.ts'), 'connect'];
const ok = (cond: unknown, msg: string) => {
  if (!cond) {
    console.error('FAIL:', msg);
    process.exit(1);
  }
  console.log('ok -', msg);
};

// Client A starts a turn that needs approval, then vanishes before answering.
const a = TetherClient.spawn(cmd, env);
const initA = await a.initialize();
ok(initA.host.mode === 'daemon', 'connected through daemon');
let lastSeqA = 0;
a.on((_, p) => { if (typeof p?.seq === 'number') lastSeqA = p.seq; });
const gotRequest = new Promise<any>((resolve) => { a.onServerRequest = (m, p) => { resolve({ m, p }); return new Promise(() => {}); }; });
const { thread } = await a.call('thread/start', { cwd, ...model });
await a.call('turn/start', { threadId: thread.threadId, input: [{ type: 'text', text: 'Write the word "survived" to survive.txt, then reply "done".' }] });
const req = await gotRequest;
ok(req.m === 'permission/request', `A received ${req.m} for ${req.p.toolName}`);
a.close();
await Bun.sleep(1000);

// Client B reconnects, catches up, receives the parked request, approves it.
const b = TetherClient.spawn(cmd, env);
await b.initialize();
const loaded = await b.call('thread/loaded', {});
const lt = loaded.threads.find((t) => t.threadId === thread.threadId);
ok(lt?.status === 'requiresAction', `thread still loaded in daemon, status=${lt?.status}`);
const bEvents: any[] = [];
b.on((m, p) => bEvents.push({ m, p }));
const reReq = new Promise<any>((resolve) => { b.onServerRequest = (m, p) => { resolve({ m, p }); return { decision: 'allow' }; }; });
const done = b.waitFor((m, p) => m === 'turn/completed' && p.threadId === thread.threadId);
const sub = await b.call('thread/subscribe', { threadId: thread.threadId, afterSeq: lastSeqA });
ok(sub.gap === false, `subscribe afterSeq=${lastSeqA}: replayed ${sub.replayed}, no gap`);
const rr = await reReq;
ok(rr.p.requestId === req.p.requestId, 'same pending request re-sent to new client');
const t = await done;
ok(t.params.turn.status === 'completed', 'turn completed after reattach');
ok(readdirSync(cwd).some((f) => readFileSync(join(cwd, f), 'utf8').includes('survived')), 'file written after reattach approval');
const seqs = bEvents.filter((e) => e.p?.threadId === thread.threadId).map((e) => e.p.seq);
ok(seqs[0] === lastSeqA + 1 || sub.replayed === 0, `B's first event seq ${seqs[0]} follows A's last ${lastSeqA}`);

// A turn that runs while nobody is connected.
const c = b;
const { thread: t2 } = await c.call('thread/start', { cwd, ...model, permissionMode: 'acceptEdits', allowedTools: ['Bash', 'Write'] });
const done2 = c.waitFor((m, p) => m === 'turn/started' && p.threadId === t2.threadId);
await c.call('turn/start', { threadId: t2.threadId, input: [{ type: 'text', text: 'Run this exact Bash command: for i in 1 2 3 4; do echo $i; sleep 2; done; then write "offline" to offline.txt and reply "ok".' }] });
await done2;
let lastSeqB = 0;
for (const e of bEvents) if (e.p?.threadId === t2.threadId) lastSeqB = Math.max(lastSeqB, e.p.seq);
c.close();
ok(true, 'client disconnected mid-turn');
const offline = () => readdirSync(cwd).some((f) => f.startsWith('offline'));
for (let i = 0; i < 90 && !offline(); i++) await Bun.sleep(1000);
ok(offline(), 'turn finished its work with no client attached');
await Bun.sleep(3000);
const d = TetherClient.spawn(cmd, env);
await d.initialize();
const dEvents: any[] = [];
d.on((m, p) => dEvents.push({ m, p }));
const sub2 = await d.call('thread/subscribe', { threadId: t2.threadId, afterSeq: lastSeqB });
await Bun.sleep(200);
ok(dEvents.some((e) => e.m === 'turn/completed'), `replayed ${sub2.replayed} missed events including turn/completed`);
ok(sub2.thread.status === 'idle', 'thread idle after offline turn');

// Cleanup: stop daemon.
const pid = JSON.parse(readFileSync(join(home, 'daemon.pid'), 'utf8')).pid;
d.close();
process.kill(pid, 'SIGTERM');
console.log('\nall daemon checks passed');
process.exit(0);
