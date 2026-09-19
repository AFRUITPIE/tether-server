#!/usr/bin/env bun
import { resolveClaude } from './claude.ts';
import { Connection } from './rpc/connection.ts';
import { ClientSession } from './server/session.ts';
import { ThreadManager } from './threads/ThreadManager.ts';
import { TETHER_VERSION } from './threads/LiveThread.ts';

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
  case 'version':
  case '--version':
    console.log(TETHER_VERSION);
    break;
  default:
    console.log(`tether ${TETHER_VERSION}
usage:
  tether serve --stdio     JSON-RPC over stdio (single client, in-process threads)
  tether version`);
}
