import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PROTOCOL_VERSION } from '../src/protocol/index.ts';
import { Connection } from '../src/rpc/connection.ts';
import { TETHER_VERSION } from '../src/threads/LiveThread.ts';
import { versionInfo } from '../src/version.ts';

// The CLI as the app runs it, in its own processes. Every one gets a fresh HOME and TETHER_HOME,
// never the user's ~/.tether, and a stand-in `claude` that only reports its version.
// TETHER_TEST_BINARY runs them against a compiled binary instead of the source, as CI does.
const binary = process.env.TETHER_TEST_BINARY;
const command = binary ? [resolve(binary)] : [process.execPath, join(import.meta.dir, '..', 'src', 'cli.ts')];
const SLOW = { timeout: 30_000 };
const clientInfo = { name: 'test', version: '0' };

/** Daemons these tests may have started, stopped at the end whatever happened, and their homes. */
const pids = new Set<number>();
const homes: string[] = [];
afterAll(async () => {
  for (const pid of pids) if (alive(pid)) process.kill(pid, 'SIGTERM');
  await until('the daemons exit', () => ![...pids].some(alive)).catch(() => {});
  for (const dir of homes) rmSync(dir, { recursive: true, force: true });
});

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(what: string, cond: () => boolean, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting until ${what}`);
    await Bun.sleep(25);
  }
}

/** A fresh home for Tether, and the environment that points the CLI at it. */
function sandbox() {
  // Short, as a socket's path is limited to about 100 bytes.
  const dir = mkdtempSync(join(tmpdir(), 'td-'));
  homes.push(dir);
  const claude = join(dir, 'claude');
  writeFileSync(claude, '#!/bin/sh\necho "9.9.9 (Claude Code)"\n');
  chmodSync(claude, 0o755);
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('TETHER_')));
  const env = { ...inherited, HOME: dir, TETHER_HOME: join(dir, 'tether'), TETHER_CLAUDE_PATH: claude } as Record<string, string>;
  const home = env.TETHER_HOME!;
  return {
    env,
    claude,
    socket: join(home, 'tether.sock'),
    pidFile: join(home, 'daemon.pid'),
    meta: () => JSON.parse(readFileSync(join(home, 'daemon.pid'), 'utf8')) as { pid: number; version: string },
  };
}

type Sandbox = ReturnType<typeof sandbox>;

/** `tether <args>` in `box`, with what it writes and how it exits. */
function tether(box: Sandbox, ...args: string[]) {
  const child = spawn(command[0]!, [...command.slice(1), ...args], { env: box.env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout!.on('data', (c) => (stdout += c));
  child.stderr!.on('data', (c) => (stderr += c));
  const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
  return { child, exited, stdout: () => stdout, stderr: () => stderr };
}

function client(input: NodeJS.ReadableStream, output: NodeJS.WritableStream) {
  const c = new Connection(input as any, output as any, 'client');
  c.start({ onRequest: async () => ({}), onNotification: () => {}, onClose: () => {} });
  return c;
}

/** A client on a child's stdio, as the app talks to `tether connect`. */
const stdioClient = (child: ChildProcess) => client(child.stdout!, child.stdin!);

function socketClient(path: string) {
  return new Promise<Connection>((resolve, reject) => {
    const s = createConnection(path);
    s.once('connect', () => resolve(client(s, s)));
    s.once('error', reject);
  });
}

async function initialize(c: Connection) {
  return c.request<any>('initialize', { clientInfo, protocolVersion: PROTOCOL_VERSION }, 'init');
}

/** `tether daemon` in `box`, once it's listening. */
async function startDaemon(box: Sandbox) {
  const d = tether(box, 'daemon');
  pids.add(d.child.pid!);
  await until('the daemon listens', () => existsSync(box.socket) && existsSync(box.pidFile));
  return d;
}

describe('tether version', () => {
  test('prints the version, or with --json what a client probes a host for', async () => {
    const box = sandbox();
    const plain = tether(box, 'version');
    expect(await plain.exited).toBe(0);
    expect(plain.stdout()).toBe(`${TETHER_VERSION}\n`);
    const json = tether(box, 'version', '--json');
    expect(await json.exited).toBe(0);
    expect(JSON.parse(json.stdout())).toEqual(versionInfo());
  }, SLOW);
});

describe('tether serve --stdio', () => {
  test('is the only serve mode', async () => {
    const run = tether(sandbox(), 'serve');
    expect(await run.exited).toBe(2);
    expect(run.stdout()).toBe('');
    expect(run.stderr()).toContain('--stdio');
  }, SLOW);

  test('serves one client on stdio, keeps stdout to protocol lines, and exits when stdin closes', async () => {
    const box = sandbox();
    const run = tether(box, 'serve', '--stdio');
    const c = stdioClient(run.child);
    const init = await initialize(c);
    expect(init.host.mode).toBe('stdio');
    expect(init.host.pid).toBe(run.child.pid);
    expect(init.claude).toEqual({ path: box.claude, version: '9.9.9' });
    expect((await c.request<any>('host/info', {}, 'info')).loadedThreads).toBe(0);
    run.child.stdin!.end();
    expect(await run.exited).toBe(0);
    const lines = run.stdout().trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.map((l) => l.id)).toEqual(['init', 'info']);
    expect(run.stderr()).toContain('serving on stdio');
  }, SLOW);
});

describe('tether daemon', () => {
  const box = sandbox();
  let daemon: ReturnType<typeof tether>;
  beforeAll(async () => {
    daemon = await startDaemon(box);
  }, SLOW);

  test('listens on a socket only its user can open', () => {
    expect(statSync(box.socket).mode & 0o777).toBe(0o600);
  });

  test('is reported by `tether status`', async () => {
    const status = tether(box, 'status');
    expect(await status.exited).toBe(0);
    expect(JSON.parse(status.stdout())).toMatchObject({ pid: daemon.child.pid, version: TETHER_VERSION, socket: box.socket });
  }, SLOW);

  test('serves clients through `tether connect`, and outlives them', async () => {
    const connect = tether(box, 'connect');
    const init = await initialize(stdioClient(connect.child));
    expect(init.host.mode).toBe('daemon');
    expect(init.host.pid).toBe(daemon.child.pid);
    expect(init.claude).toEqual({ path: box.claude, version: '9.9.9' });
    connect.child.stdin!.end();
    expect(await connect.exited).toBe(0);
    expect((await initialize(await socketClient(box.socket))).host.pid).toBe(daemon.child.pid);
  }, SLOW);

  test('offers scheduled tasks', async () => {
    const c = await socketClient(box.socket);
    await initialize(c);
    expect(await c.request<any>('schedule/list', {}, 'l')).toEqual({ tasks: [] });
    c.close();
  });

  test('a second one leaves the first serving', async () => {
    const second = tether(box, 'daemon');
    expect(await second.exited).toBe(0);
    expect(second.stderr()).toContain('already listening');
    expect(box.meta().pid).toBe(daemon.child.pid!);
    expect((await initialize(await socketClient(box.socket))).host.pid).toBe(daemon.child.pid);
  }, SLOW);

  test('with nothing running, agrees to shut down, and removes its socket and pid file', async () => {
    const c = await socketClient(box.socket);
    await initialize(c);
    expect(await c.request<any>('host/requestShutdown', { reason: 'test' }, 's')).toEqual({ accepted: true });
    expect(await daemon.exited).toBe(0);
    expect(existsSync(box.socket)).toBe(false);
    expect(existsSync(box.pidFile)).toBe(false);
  }, SLOW);
});

describe('tether connect', () => {
  test('starts a daemon when none is running', async () => {
    const box = sandbox();
    const connect = tether(box, 'connect');
    const c = stdioClient(connect.child);
    const init = await initialize(c);
    const pid: number = init.host.pid;
    pids.add(pid);
    expect(init.host.mode).toBe('daemon');
    expect(pid).not.toBe(connect.child.pid);
    expect(box.meta()).toMatchObject({ pid, version: TETHER_VERSION });
    // Through the bridge: once the daemon goes, so does `connect`.
    expect(await c.request<any>('host/requestShutdown', {}, 's')).toEqual({ accepted: true });
    expect(await connect.exited).toBe(0);
    await until('the daemon exits', () => !alive(pid));
  }, SLOW);

  test('replaces an idle daemon of another version', async () => {
    const box = sandbox();
    const old = await startDaemon(box);
    // What an earlier release's daemon would have recorded.
    writeFileSync(box.pidFile, JSON.stringify({ ...box.meta(), version: '0.0.1' }));
    const connect = tether(box, 'connect');
    const c = stdioClient(connect.child);
    const init = await initialize(c);
    pids.add(init.host.pid);
    expect(await old.exited).toBe(0);
    expect(init.host.pid).not.toBe(old.child.pid);
    expect(box.meta()).toMatchObject({ pid: init.host.pid, version: TETHER_VERSION });
    expect(connect.stderr()).toContain(`replacing daemon 0.0.1 with ${TETHER_VERSION}`);
    await c.request<any>('host/requestShutdown', {}, 's');
    expect(await connect.exited).toBe(0);
    await until('the daemon exits', () => !alive(init.host.pid));
  }, SLOW);
});
