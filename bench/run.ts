/**
 * Benchmarks of the server's hot paths, against copies of real transcripts.
 *
 *   bun run bench/run.ts [case …] [--out results.json]
 *
 * Cases: stream, history, list, tasks, follow, rpc (all by default). Transcripts come from
 * `BENCH_TRANSCRIPTS` (comma-separated `.jsonl` paths), else the largest ones under
 * `~/.claude/projects/-Users-haydenhong-Code-tether-app` and `…-Sundown` (`BENCH_PROJECTS` to name
 * others). Each is cloned (APFS `cp -c`, else copied) with its session folder into a temporary
 * `CLAUDE_CONFIG_DIR`; nothing under `~/.claude` is opened for writing. Nothing here runs `claude`
 * or spends tokens.
 *
 * Times are wall-clock medians where a case repeats; "retained" is the JS heap still held after a
 * full GC, which is what a long-lived daemon pays for.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { heapStats } from 'bun:jsc';

const args = process.argv.slice(2);
const flag = (name: string) => {
  const at = args.indexOf(name);
  return at >= 0 ? args.splice(at, 2)[1] : undefined;
};
const out = flag('--out');
const only = flag('--only');
const child = args[0] === '--child' ? (args.shift(), true) : false;
const CASES = ['stream', 'history', 'list', 'tasks', 'follow', 'rpc'];
const chosen = args.length ? args : CASES;

// Each case runs in a process of its own, so one's garbage and peak memory aren't another's.
if (!child) {
  const results: Record<string, unknown> = {};
  const file = join(mkdtempSync(join(tmpdir(), 'tether-bench-results-')), 'results.json');
  for (const c of chosen) {
    // A long chat's open is measured alone, for its peak memory.
    const each = c === 'history' && !only ? sources().map((f) => basename(f, '.jsonl')) : [only];
    for (const id of each) {
      const r = Bun.spawnSync([process.execPath, 'run', import.meta.path, '--child', c, ...(id ? ['--only', id] : [])], {
        stdio: ['inherit', 'inherit', 'inherit'],
        env: { ...process.env, BENCH_RESULTS: file },
      });
      if (r.exitCode !== 0) process.exit(r.exitCode ?? 1);
      if (existsSync(file)) Object.assign(results, JSON.parse(readFileSync(file, 'utf8')));
    }
  }
  if (out) writeFileSync(out, JSON.stringify(results, null, 2));
  process.exit(0);
}

const ROOT = mkdtempSync(join(tmpdir(), 'tether-bench-'));
const CONFIG = join(ROOT, 'claude');
process.env.CLAUDE_CONFIG_DIR = CONFIG;
process.env.TETHER_HOME = join(ROOT, 'tether');
mkdirSync(join(CONFIG, 'projects'), { recursive: true });

const { Connection } = await import('../src/rpc/connection.ts');
const { LiveThread } = await import('../src/threads/LiveThread.ts');
const { ThreadManager } = await import('../src/threads/ThreadManager.ts');
const { readSessionHistory } = await import('../src/threads/transcript.ts');
const { recordedCwd } = await import('../src/threads/transcript.ts');
const { TaskStore } = await import('../src/threads/taskStore.ts');

const claude = { path: '/usr/bin/false', version: '0' } as any;
const results: Record<string, Record<string, number | string>> = {};

// ---------- helpers ----------

const now = () => performance.now();
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)]! : NaN;
};
const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
/** The JS heap after a full GC, strings' and buffers' own memory included. */
function heapMB(): number {
  Bun.gc(true);
  const h = heapStats();
  return (h.heapSize + h.extraMemorySize) / 1e6;
}
/** The process's peak resident memory so far. */
// getrusage's ru_maxrss is bytes on macOS, kilobytes elsewhere.
const peakRssMB = () => (process.resourceUsage().maxRSS * (process.platform === 'darwin' ? 1 : 1024)) / 1e6;
function record(name: string, values: Record<string, number | string>) {
  results[name] = { ...results[name], ...values };
  const shown = Object.entries(values).map(([k, v]) => `${k}=${typeof v === 'number' ? round(v) : v}`);
  console.log(`${name.padEnd(28)} ${shown.join('  ')}`);
}

/** A sink that drops what it's sent, as fast as a socket that never pushes back. */
const sink = () =>
  new Writable({
    write(_c, _e, cb) {
      cb();
    },
  });

/** A subscriber that sends what it's told down a JSON-RPC connection, as a client session does. */
function wireSubscriber() {
  const conn = new Connection(new PassThrough(), sink(), 'bench');
  conn.start({ onRequest: async () => ({}), onNotification: () => {}, onClose: () => {} });
  let sent = 0;
  return {
    id: randomUUID(),
    notify(method: string, params: unknown) {
      sent++;
      conn.notify(method, params);
    },
    request: () => new Promise<never>(() => {}),
    cancelRequest() {},
    get sent() {
      return sent;
    },
  };
}

// ---------- transcripts ----------

type Transcript = { id: string; path: string; cwd: string; project: string; mb: number; lines: number };

function clone(from: string, to: string, dir = false) {
  mkdirSync(dirname(to), { recursive: true });
  try {
    execFileSync('cp', [...(dir ? ['-R'] : []), '-c', from, to]);
  } catch {
    if (dir) execFileSync('cp', ['-R', from, to]);
    else copyFileSync(from, to);
  }
}

function sources(): string[] {
  const all = picks();
  return only ? all.filter((f) => basename(f, '.jsonl') === only) : all;
}

function picks(): string[] {
  if (process.env.BENCH_TRANSCRIPTS) return process.env.BENCH_TRANSCRIPTS.split(',').filter(Boolean);
  const home = join(homedir(), '.claude', 'projects');
  const projects = (process.env.BENCH_PROJECTS ?? '-Users-haydenhong-Code-tether-app,-Users-haydenhong-Code-Sundown').split(',');
  const fresh = Date.now() - 15 * 60_000;
  const files = projects.flatMap((p) => {
    try {
      return readdirSync(join(home, p))
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => join(home, p, f));
    } catch {
      return [];
    }
  });
  // A session still being written (this one, say) would change under the copy.
  const settled = files.filter((f) => statSync(f).mtimeMs < fresh).sort((a, b) => statSync(b).size - statSync(a).size);
  const hasWorkflows = (f: string) => existsSync(join(f.slice(0, -'.jsonl'.length), 'subagents', 'workflows'));
  const picks = new Set<string>();
  if (settled[0]) picks.add(settled[0]); // the largest
  const wf = settled.find(hasWorkflows);
  if (wf) picks.add(wf); // the largest with workflow runs on disk
  const mid = settled.find((f) => statSync(f).size < 32e6 && !picks.has(f));
  if (mid) picks.add(mid); // a typical long chat
  return [...picks];
}

async function prepare(path: string): Promise<Transcript> {
  const project = basename(dirname(path));
  const id = basename(path, '.jsonl');
  const to = join(CONFIG, 'projects', project, `${id}.jsonl`);
  if (!existsSync(to)) {
    clone(path, to);
    const dir = path.slice(0, -'.jsonl'.length);
    if (existsSync(dir)) clone(dir, to.slice(0, -'.jsonl'.length), true);
  }
  const cwd = (await recordedCwd(to)) ?? '/';
  const size = statSync(to).size;
  const lines = readFileSync(to, 'utf8').split('\n').length;
  return { id, path: to, cwd, project, mb: size / 1e6, lines };
}

const transcripts: Transcript[] = [];
for (const s of sources()) transcripts.push(await prepare(s));
if (chosen.includes('history') || !only)
  for (const t of transcripts) console.log(`  ${t.id} ${round(t.mb, 1)} MB, ${t.lines} lines (${t.project})`);
const label = (t: Transcript) => `${t.id.slice(0, 8)}(${Math.round(t.mb)}MB)`;
const typical = transcripts.find((t) => t.mb < 32) ?? transcripts.at(-1)!;
const withWorkflows = transcripts.find((t) => existsSync(join(t.path.slice(0, -6), 'subagents', 'workflows'))) ?? typical;

// ---------- live: a long chat, then a streamed turn ----------

/** A live thread that has been through `t`'s history as if it had streamed it, with `subscribers` attached. */
async function liveAfter(t: Transcript | undefined, subscribers: number) {
  const thread = new LiveThread({ threadId: randomUUID(), cwd: t?.cwd ?? '/tmp', claude, env: {}, mode: 'new' });
  const subs = Array.from({ length: subscribers }, wireSubscriber);
  for (const s of subs) thread.subscribe(s);
  let ingest = 0;
  let messages = 0;
  if (t) {
    const { messages: msgs } = await readSessionHistory(t.id, t.cwd, t.path);
    const t0 = now();
    for (const m of msgs) (thread as any).onMessage(m);
    ingest = now() - t0;
    messages = msgs.length;
  }
  return { thread, subs, ingest, messages };
}

/** One streamed reply of `deltas` text deltas, then a streamed tool call and its result. */
function streamTurn(thread: InstanceType<typeof LiveThread>, deltas: number) {
  const on = (m: object) => (thread as any).onMessage(m);
  const msgId = `msg_bench_${randomUUID()}`;
  thread.send([{ type: 'text', text: 'Benchmark prompt' }]);
  on({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { id: msgId } } });
  on({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
  const piece = 'Streaming a reply, a few words at a time. ';
  const times: number[] = [];
  const t0 = now();
  for (let i = 0; i < deltas; i++) {
    const s = now();
    on({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } } });
    times.push(now() - s);
  }
  const total = now() - t0;
  const toolId = `toolu_bench_${randomUUID()}`;
  on({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: toolId, name: 'Bash' } } });
  for (let i = 0; i < 100; i++)
    on({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"comm' } } });
  const c0 = now();
  on({
    type: 'assistant',
    parent_tool_use_id: null,
    message: {
      id: msgId,
      model: 'claude-bench',
      content: [
        { type: 'text', text: piece.repeat(deltas) },
        { type: 'tool_use', id: toolId, name: 'Bash', input: { command: 'ls' } },
      ],
      stop_reason: 'tool_use',
    },
  });
  on({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: 'x\n'.repeat(5000) }] } });
  on({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1, num_turns: 1, total_cost_usd: 0, usage: {} });
  const complete = now() - c0;
  return { perDeltaUs: (total / deltas) * 1000, p50Us: median(times) * 1000, completeMs: complete };
}

async function benchStream() {
  for (const [name, t] of [['stream.fresh', undefined], [`stream.after ${label(typical)}`, typical]] as const) {
    const h0 = heapMB();
    const { thread, subs, ingest, messages } = await liveAfter(t, 1);
    const held = heapMB() - h0;
    const r = streamTurn(thread, 3000);
    record(name, {
      ...(t ? { historyMsgs: messages, ingestMs: ingest, ingestUsPerMsg: (ingest / messages) * 1000 } : {}),
      deltaUs: r.perDeltaUs,
      deltaP50Us: r.p50Us,
      completeMs: r.completeMs,
      sent: subs[0]!.sent,
    });
    thread.close();
    if (t) record(name, { threadHeldMB: held });
  }
  // Three clients on one thread: each notification is encoded per client.
  const { thread } = await liveAfter(undefined, 3);
  record('stream.3 clients', { deltaUs: streamTurn(thread, 3000).perDeltaUs });
  thread.close();
}

// ---------- history: open a long chat, then page back through it ----------

async function benchHistory() {
  for (const t of transcripts) {
    const mgr = new ThreadManager(claude);
    const h0 = heapMB();
    let t0 = now();
    let r = await mgr.read(t.id, t.cwd, { limit: 50 });
    const open = now() - t0;
    const openPeak = peakRssMB();
    const held = heapMB() - h0;
    t0 = now();
    await mgr.read(t.id, t.cwd, { limit: 50 });
    const reopen = now() - t0;
    const pages: number[] = [];
    let total = r.items.length;
    let before = r.items[0]?.id;
    while (r.hasMore && before) {
      t0 = now();
      r = await mgr.read(t.id, t.cwd, { limit: 500, before });
      pages.push(now() - t0);
      total += r.items.length;
      before = r.items[0]?.id;
    }
    mgr.unfollow(t.id);
    t0 = now();
    const stored = await (mgr as any).readStored(t.id, t.cwd);
    const readStored = now() - t0;
    // The same chat loaded here: what was on disk, then what the live thread has said since.
    const live = new LiveThread({ threadId: t.id, cwd: t.cwd, claude, env: {}, mode: 'resume' });
    mgr.threads.set(t.id, live);
    for (let i = 0; i < 20; i++) streamTurn(live, 50);
    t0 = now();
    let lr = await mgr.read(t.id, t.cwd, { limit: 50 });
    const liveOpen = now() - t0;
    const livePages: number[] = [];
    while (lr.hasMore && lr.items[0]) {
      t0 = now();
      lr = await mgr.read(t.id, t.cwd, { limit: 500, before: lr.items[0].id });
      livePages.push(now() - t0);
    }
    live.close();
    mgr.threads.delete(t.id);
    record(`history ${label(t)}`, {
      liveOpenMs: liveOpen,
      livePageMs: median(livePages),
      items: total,
      tasks: stored.tasks.length,
      openMs: open,
      reopenMs: reopen,
      pageMs: median(pages),
      pages: pages.length,
      readStoredMs: readStored,
      followerHeldMB: held,
      openPeakRssMB: openPeak,
    });
    mgr.shutdown();
  }
}

// ---------- the chat list ----------

async function benchList() {
  // Every transcript under ~/.claude/projects (cloned, not read in place), for a list of realistic length.
  const home = join(homedir(), '.claude', 'projects');
  let n = 0;
  for (const p of readdirSync(home)) {
    let files: string[] = [];
    try {
      files = readdirSync(join(home, p)).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const f of files) {
      const to = join(CONFIG, 'projects', p, f);
      if (!existsSync(to)) clone(join(home, p, f), to);
      n++;
    }
  }
  const mgr = new ThreadManager(claude);
  const times = (k: number, f: () => Promise<unknown>) => (async () => {
    const xs: number[] = [];
    for (let i = 0; i < k; i++) {
      const t0 = now();
      await f();
      xs.push(now() - t0);
    }
    return median(xs);
  })();
  const all = await mgr.list({});
  record('list', {
    sessions: n,
    listed: all.length,
    all: await times(3, () => mgr.list({})),
    limit200: await times(3, () => mgr.list({ limit: 200 })),
    limit5: await times(5, () => mgr.list({ limit: 5 })),
    summaryOfMs: await times(20, () => mgr.summaryOf(typical.id)),
  });
  mgr.shutdown();
}

// ---------- tasks: a busy workflow in a long live chat ----------

async function benchTasks() {
  const store = new TaskStore(join(ROOT, 'tether', 'tasks'), 60_000);
  for (const t of [undefined, withWorkflows]) {
    const thread = new LiveThread({
      threadId: randomUUID(),
      cwd: t?.cwd ?? '/tmp',
      claude,
      env: {},
      mode: 'new',
      onTasks: (tasks) => store.put(thread.id, tasks),
    });
    const sub = wireSubscriber();
    thread.subscribe(sub);
    if (t) for (const m of (await readSessionHistory(t.id, t.cwd, t.path)).messages) (thread as any).onMessage(m);
    const on = (m: object) => (thread as any).onMessage(m);
    const call = `toolu_wf_${randomUUID().slice(0, 8)}`;
    const taskId = `w${randomUUID().slice(0, 8)}`;
    const script = "export const meta = { name: 'bench', description: 'A busy workflow', phases: [{ title: 'Scan' }, { title: 'Review' }, { title: 'Verify' }] }";
    thread.send([{ type: 'text', text: 'run it' }]);
    on({ type: 'assistant', parent_tool_use_id: null, message: { id: `msg_${call}`, content: [{ type: 'tool_use', id: call, name: 'Workflow', input: { script } }], stop_reason: 'tool_use' } });
    on({
      type: 'user',
      parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: call, content: `Workflow launched in background.\nTask ID: ${taskId}\nRun ID: wf_bench1` }] },
    });
    on({ type: 'system', subtype: 'task_started', task_id: taskId, tool_use_id: call, task_type: 'local_workflow', workflow_name: 'bench', description: 'A busy workflow' });
    const AGENTS = 60;
    const EVENTS = 300;
    const sentBefore = sub.sent;
    const times: number[] = [];
    for (let e = 0; e < EVENTS; e++) {
      const started = Math.min(AGENTS, Math.floor((e / EVENTS) * AGENTS * 1.3) + 1);
      const progress: object[] = [1, 2, 3].map((i) => ({ type: 'workflow_phase', index: i, title: ['Scan', 'Review', 'Verify'][i - 1] }));
      for (let a = 1; a <= started; a++)
        progress.push({
          type: 'workflow_agent',
          index: a,
          label: `review:file-${a}.swift`,
          phaseIndex: 1 + (a % 3),
          agentId: `a${String(a).padStart(16, '0')}`,
          model: 'claude-haiku',
          state: a < started - 4 ? 'done' : 'progress',
          startedAt: 1_700_000_000_000 + a * 1000,
          // A finished agent's numbers stay put; a running one's grow.
          tokens: a < started - 4 ? a * 100 : a * 100 + e,
          toolCalls: a,
          lastToolName: 'Read',
          lastToolSummary: `Reading file-${a}.swift`,
          promptPreview: `Review file-${a}.swift for typos and bugs, then return what you found.`,
        });
      const s = now();
      on({ type: 'system', subtype: 'task_progress', task_id: taskId, tool_use_id: call, description: `Review: file-${started}`, usage: { total_tokens: e * 1000, tool_uses: e, duration_ms: e * 100 }, workflow_progress: progress });
      times.push(now() - s);
    }
    const s = now();
    on({ type: 'system', subtype: 'task_notification', task_id: taskId, tool_use_id: call, status: 'completed', summary: 'done' });
    const settle = now() - s;
    const f0 = now();
    store.flush();
    const flush = now() - f0;
    record(`tasks ${t ? label(t) : 'fresh'}`, {
      chatTasks: thread.tasks().length,
      perEventUs: median(times) * 1000,
      settleMs: settle,
      updatesPerEvent: (sub.sent - sentBefore) / EVENTS,
      flushMs: flush,
    });
    thread.close();
  }
}

// ---------- following a session another client runs ----------

async function benchFollow() {
  for (const t of [typical, withWorkflows].filter((x, i, a) => a.indexOf(x) === i)) {
    const lines = readFileSync(t.path, 'utf8').split('\n').filter(Boolean);
    const id = randomUUID();
    const path = join(dirname(t.path), `${id}.jsonl`);
    const BATCHES = 30;
    const PER = 4;
    const head = lines.length - BATCHES * PER;
    writeFileSync(path, lines.slice(0, head).join('\n') + '\n');
    const mgr = new ThreadManager(claude);
    let t0 = now();
    const f = (await mgr.follow(id, t.cwd))!;
    const start = now() - t0;
    const sub = wireSubscriber();
    f.subscribe(sub);
    // Stop the watcher's own reads: each append is read once, here, so they can be timed.
    (f as any).watcher?.close();
    const times: number[] = [];
    for (let b = 0; b < BATCHES; b++) {
      appendFileSync(path, lines.slice(head + b * PER, head + (b + 1) * PER).join('\n') + '\n');
      t0 = now();
      await (f as any).refresh();
      times.push(now() - t0);
    }
    record(`follow ${label(t)}`, { startMs: start, refreshMs: median(times), maxRefreshMs: Math.max(...times), sent: sub.sent });
    mgr.unfollow(id);
    mgr.shutdown();
    rmSync(path, { force: true });
  }
}

// ---------- JSON-RPC: encoding and framing ----------

async function benchRpc() {
  const conn = new Connection(new PassThrough(), sink(), 'bench');
  conn.start({ onRequest: async () => ({}), onNotification: () => {}, onClose: () => {} });
  const timeEach = (n: number, f: () => void) => {
    const t0 = now();
    for (let i = 0; i < n; i++) f();
    return ((now() - t0) / n) * 1000;
  };
  const delta = { threadId: randomUUID(), seq: 1_700_000_000_000_000, itemId: 'msg_01:0', delta: 'a few words of a reply ' };
  const bigTool = {
    threadId: delta.threadId,
    seq: 1,
    item: { type: 'toolCall', id: 'toolu_x', turnId: 't', parentToolUseId: null, createdAt: 1, name: 'Read', kind: 'fileRead', input: { file_path: '/x' }, status: 'completed', outputText: 'line of a file\n'.repeat(15_000) },
  };
  record('rpc.notify', {
    deltaUs: timeEach(100_000, () => conn.notify('item/agentMessage/delta', delta)),
    toolCall200KBUs: timeEach(500, () => conn.notify('item/completed', bigTool)),
  });

  // A large request (an image attached to a prompt) arriving as a socket delivers it.
  const input = new PassThrough();
  let got = 0;
  const server = new Connection(input, sink(), 'bench-in');
  server.start({ onRequest: async () => ({}), onNotification: () => void got++, onClose: () => {} });
  const line = JSON.stringify({ method: 'bench', params: { data: 'A'.repeat(8 * 1024 * 1024) } }) + '\n';
  const chunk = 64 * 1024;
  const t0 = now();
  for (let i = 0; i < line.length; i += chunk) (server as any).onData(line.slice(i, i + chunk));
  record('rpc.inbound 8MB line', { ms: now() - t0, parsed: got });

  // A thread's replay buffer, once full: every emit then drops the oldest event.
  const thread = new LiveThread({ threadId: randomUUID(), cwd: '/tmp', claude, env: {}, mode: 'new' });
  const filling = timeEach(20_000, () => thread.emit('item/agentMessage/delta', { itemId: 'x', delta: 'y' }));
  const full = timeEach(40_000, () => thread.emit('item/agentMessage/delta', { itemId: 'x', delta: 'y' }));
  record('rpc.emit (buffer)', { fillingUs: filling, fullUs: full });
  thread.close();
}

const run: Record<string, () => Promise<void>> = {
  stream: benchStream,
  history: benchHistory,
  list: benchList,
  tasks: benchTasks,
  follow: benchFollow,
  rpc: benchRpc,
};
try {
  for (const c of chosen) {
    if (!run[c]) throw new Error(`no bench ${c}; cases: ${CASES.join(', ')}`);
    await run[c]!();
  }
  if (process.env.BENCH_RESULTS) {
    const file = process.env.BENCH_RESULTS;
    const before = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
    writeFileSync(file, JSON.stringify({ ...before, ...results }));
  }
} finally {
  rmSync(ROOT, { recursive: true, force: true });
}
process.exit(0);
