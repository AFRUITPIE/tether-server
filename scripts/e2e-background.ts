// Long-running and background work across disconnects: a background command outlives its turn and
// its client, a restarted thread numbers its events above the old stream, and idle eviction spares
// a thread whose background command is still running. Real `claude`; costs a few cents.
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TetherClient } from '../src/client/TetherClient.ts';

// TETHER_E2E_MODEL / TETHER_E2E_EFFORT pick what the runs cost, e.g. sonnet at low effort.
const model = { model: process.env.TETHER_E2E_MODEL ?? 'haiku', ...(process.env.TETHER_E2E_EFFORT ? { effort: process.env.TETHER_E2E_EFFORT as 'low' } : {}) };
const home = mkdtempSync(join(tmpdir(), 'tether-home-'));
const cwd = mkdtempSync(join(tmpdir(), 'tether-bg-'));
// Evict idle threads after 2s; the sweep itself runs once a minute.
const env = { TETHER_HOME: home, TETHER_IDLE_EVICT_MS: '2000' };
const cmd = ['bun', 'run', join(import.meta.dir, '../src/cli.ts'), 'connect'];
const ok = (cond: unknown, msg: string) => {
  if (!cond) {
    console.error('FAIL:', msg);
    process.exit(1);
  }
  console.log('ok -', msg);
};

async function client() {
  const c = TetherClient.spawn(cmd, env);
  const seqs = new Map<string, number>();
  const events: { m: string; p: any }[] = [];
  c.on((m, p) => {
    events.push({ m, p });
    if (p?.threadId && typeof p.seq === 'number') seqs.set(p.threadId, p.seq);
  });
  c.onServerRequest = () => ({ decision: 'allow' });
  await c.initialize();
  return { c, seqs, events };
}

async function startTurn(c: TetherClient, text: string) {
  const { thread } = await c.call('thread/start', { cwd, ...model, permissionMode: 'bypassPermissions' } as any);
  const done = c.waitFor((m, p) => m === 'turn/completed' && p.threadId === thread.threadId);
  await c.call('turn/start', { threadId: thread.threadId, input: [{ type: 'text', text }] });
  await done;
  return thread.threadId as string;
}

// 1. A background command outlives its turn and its client; the next client sees it finish as a notice.
const a = await client();
const bg = await startTurn(a.c, 'Run `sleep 20 && echo bg > bg.txt` with Bash in the background (run_in_background: true), then reply with just "started". Do not wait for it.');
const after = a.seqs.get(bg)!;
a.c.close();
for (let i = 0; i < 60 && !existsSync(join(cwd, 'bg.txt')); i++) await Bun.sleep(1000);
ok(existsSync(join(cwd, 'bg.txt')), 'background command finished with no client attached');
await Bun.sleep(5000);
const b = await client();
const sub = await b.c.call('thread/subscribe', { threadId: bg, afterSeq: after });
await Bun.sleep(300);
ok(!sub.gap, `caught up from seq ${after}: replayed ${sub.replayed}`);
const notice = b.events.find((e) => e.m === 'item/completed' && e.p.item?.kind === 'taskNotification');
ok(notice, `finished background command is a notice: "${notice?.p.item.text}"`);
ok(
  !b.events.some((e) => e.m === 'item/completed' && JSON.stringify(e.p.item?.content ?? '').includes('<task-notification>')),
  'no raw <task-notification> message in the transcript',
);

// 2. A thread whose query ended numbers its next stream above the old one.
const before = b.seqs.get(bg)!;
await b.c.call('thread/close', { threadId: bg });
const again = b.c.waitFor((m, p) => m === 'turn/completed' && p.threadId === bg);
await b.c.call('turn/start', { threadId: bg, input: [{ type: 'text', text: 'Reply with just the word again.' }] });
await again;
ok(b.seqs.get(bg)! > before, `resumed thread's events number above the old stream (${before} → ${b.seqs.get(bg)})`);

// 3. Idle eviction spares a thread whose background command is still running.
const ev = await startTurn(b.c, 'Run `sleep 80 && echo kept > kept.txt` with Bash in the background (run_in_background: true), then reply with just "started". Do not wait for it.');
b.c.close();
await Bun.sleep(70_000); // past one sweep
const c = await client();
const loaded = await c.c.call('thread/loaded', {});
ok(loaded.threads.some((t) => t.threadId === ev), 'idle thread with a running background command was not evicted');
for (let i = 0; i < 30 && !existsSync(join(cwd, 'kept.txt')); i++) await Bun.sleep(1000);
ok(existsSync(join(cwd, 'kept.txt')), 'its background command finished');

const pid = JSON.parse(readFileSync(join(home, 'daemon.pid'), 'utf8')).pid;
c.c.close();
process.kill(pid, 'SIGTERM');
console.log('\nall background checks passed');
process.exit(0);
