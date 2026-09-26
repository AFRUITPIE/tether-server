#!/usr/bin/env bun
import { resolveClaude } from './claude.ts';
import { Connection } from './rpc/connection.ts';
import { ClientSession } from './server/session.ts';
import { ThreadManager } from './threads/ThreadManager.ts';
import { TETHER_VERSION } from './threads/LiveThread.ts';
import { versionInfo } from './version.ts';
import { readDaemonMeta, runConnect, runDaemon, SOCKET_PATH } from './daemon/daemon.ts';

const [cmd = 'help', ...args] = process.argv.slice(2);
const log = (m: string) => process.stderr.write(`[tether ${new Date().toISOString()}] ${m}\n`);

async function serveStdio() {
  const claude = resolveClaude();
  log(`serving on stdio; claude ${claude.version} at ${claude.path}`);
  const mgr = new ThreadManager(claude, log);
  const conn = new Connection(process.stdin, process.stdout, 'stdio');
  const session = new ClientSession(conn, mgr, 'stdio', log);
  session.start();
  process.stdin.on('end', () => {
    mgr.shutdown();
    process.exit(0);
  });
}

switch (cmd) {
  case 'serve':
    if (!args.includes('--stdio')) {
      console.error('only `serve --stdio` is supported (daemon mode: `tether daemon` / `tether connect`)');
      process.exit(2);
    }
    await serveStdio();
    break;
  case 'daemon':
    await runDaemon();
    break;
  case 'connect':
    await runConnect();
    break;
  case 'status': {
    const meta = readDaemonMeta();
    console.log(meta ? JSON.stringify({ ...meta, socket: SOCKET_PATH }) : 'daemon not running');
    break;
  }
  case 'version':
  case '--version':
    // `--json` is what a client probes a host with before deciding to install or update.
    if (process.argv.includes('--json')) console.log(JSON.stringify(versionInfo()));
    else console.log(TETHER_VERSION);
    break;
  default:
    console.log(`tether ${TETHER_VERSION}
usage:
  tether connect           bridge stdio to the per-host daemon (starting it if needed) — what clients run
  tether daemon            run the daemon in the foreground
  tether status            show the running daemon
  tether serve --stdio     JSON-RPC over stdio (single client, in-process threads; for tests)
  tether version [--json]`);
}
