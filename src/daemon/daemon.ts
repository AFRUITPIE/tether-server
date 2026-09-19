import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection, createServer, type Socket } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveClaude } from '../claude.ts';
import { Connection } from '../rpc/connection.ts';
import { ClientSession } from '../server/session.ts';
import { TETHER_VERSION } from '../threads/LiveThread.ts';
import { ThreadManager } from '../threads/ThreadManager.ts';

export const TETHER_HOME = process.env.TETHER_HOME ?? join(homedir(), '.tether');
export const SOCKET_PATH = join(TETHER_HOME, 'tether.sock');
const PID_PATH = join(TETHER_HOME, 'daemon.pid');
const LOG_PATH = join(TETHER_HOME, 'daemon.log');

type DaemonMeta = { pid: number; version: string; startedAt: number };

/**
 * Long-lived per-host server. Owns every live Claude query so turns keep
 * running while clients disconnect; clients attach via `tether connect`.
 */
export async function runDaemon() {
  mkdirSync(TETHER_HOME, { recursive: true, mode: 0o700 });
  const log = (m: string) => process.stderr.write(`[tetherd ${new Date().toISOString()}] ${m}\n`);
  const claude = resolveClaude();
  const mgr = new ThreadManager(claude, log);
  const clients = new Set<ClientSession>();

  if (await isSocketLive()) {
    log('another daemon is already listening; exiting');
    process.exit(0);
  }
  rmSync(SOCKET_PATH, { force: true });

  const server = createServer((sock: Socket) => {
    const conn = new Connection(sock, sock, 'socket');
    const session = new ClientSession(conn, mgr, 'daemon', log);
    clients.add(session);
    sock.on('close', () => clients.delete(session));
    session.start();
  });
  server.listen(SOCKET_PATH, () => {
    chmodSync(SOCKET_PATH, 0o600);
    const meta: DaemonMeta = { pid: process.pid, version: TETHER_VERSION, startedAt: Date.now() };
    writeFileSync(PID_PATH, JSON.stringify(meta));
    log(`daemon ${TETHER_VERSION} listening on ${SOCKET_PATH}; claude ${claude.version} at ${claude.path}`);
  });

  const shutdown = (why: string) => {
    log(`shutting down: ${why}`);
    server.close();
    mgr.shutdown();
    rmSync(SOCKET_PATH, { force: true });
    try {
      const meta = JSON.parse(readFileSync(PID_PATH, 'utf8')) as DaemonMeta;
      if (meta.pid === process.pid) rmSync(PID_PATH, { force: true });
    } catch {}
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGHUP', () => {}); // survive the SSH session that spawned us
  mgr.onDrainRequest = () => shutdown('upgrade');
}

export function readDaemonMeta(): DaemonMeta | undefined {
  try {
    return JSON.parse(readFileSync(PID_PATH, 'utf8'));
  } catch {
    return undefined;
  }
}

function isSocketLive(): Promise<boolean> {
  return new Promise((resolve) => {
    if (!existsSync(SOCKET_PATH)) return resolve(false);
    const s = createConnection(SOCKET_PATH);
    s.once('connect', () => {
      s.destroy();
      resolve(true);
    });
    s.once('error', () => resolve(false));
  });
}

/** Start a detached daemon from the current executable. */
export function spawnDaemon() {
  mkdirSync(TETHER_HOME, { recursive: true, mode: 0o700 });
  const out = openSync(LOG_PATH, 'a');
  const [exe, ...pre] = selfCommand() as [string, ...string[]];
  const child = spawn(exe, [...pre, 'daemon'], { detached: true, stdio: ['ignore', out, out], env: process.env });
  child.unref();
}

/** argv prefix that re-invokes this program: the compiled binary, or `bun src/cli.ts` in dev. */
export function selfCommand(): string[] {
  const script = process.argv[1];
  const isCompiled = !script || script.startsWith('/$bunfs/') || script === process.execPath;
  return isCompiled ? [process.execPath] : [process.execPath, script!];
}

async function connectSocket(timeoutMs: number): Promise<Socket> {
  const deadline = Date.now() + timeoutMs;
  let spawned = false;
  for (;;) {
    try {
      return await new Promise<Socket>((resolve, reject) => {
        const s = createConnection(SOCKET_PATH);
        s.once('connect', () => resolve(s));
        s.once('error', reject);
      });
    } catch (e) {
      if (!spawned) {
        spawnDaemon();
        spawned = true;
      }
      if (Date.now() > deadline) throw e;
      await Bun.sleep(100);
    }
  }
}

/**
 * stdio ⇄ daemon socket bridge. What the app runs (locally or over SSH).
 * Upgrades: if the running daemon is an older version and has nothing running,
 * it is asked to exit and a new one is spawned; otherwise the old one is used.
 */
export async function runConnect() {
  const meta = readDaemonMeta();
  if (meta && meta.version !== TETHER_VERSION) await tryUpgrade(meta);
  const sock = await connectSocket(15_000);
  process.stdin.pipe(sock);
  sock.pipe(process.stdout);
  sock.on('close', () => process.exit(0));
  process.stdin.on('end', () => sock.end());
}

async function tryUpgrade(meta: DaemonMeta) {
  try {
    const sock = await new Promise<Socket>((resolve, reject) => {
      const s = createConnection(SOCKET_PATH);
      s.once('connect', () => resolve(s));
      s.once('error', reject);
    });
    const conn = new Connection(sock, sock, 'upgrade');
    conn.start({ onRequest: async () => ({}), onNotification: () => {}, onClose: () => {} });
    await conn.request('initialize', { clientInfo: { name: 'tether-upgrade', version: TETHER_VERSION } }, 'u1');
    const r = (await conn.request('host/requestShutdown', { reason: `upgrade to ${TETHER_VERSION}` }, 'u2')) as {
      accepted: boolean;
    };
    conn.close();
    if (r.accepted) {
      process.stderr.write(`[tether] replacing daemon ${meta.version} with ${TETHER_VERSION}\n`);
      for (let i = 0; i < 50 && existsSync(SOCKET_PATH); i++) await Bun.sleep(100);
    } else {
      process.stderr.write(`[tether] daemon ${meta.version} is busy; will upgrade when idle\n`);
    }
  } catch {}
}
