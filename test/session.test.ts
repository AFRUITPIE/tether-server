import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { PROTOCOL_VERSION } from '../src/protocol/index.ts';
import { Connection, ErrorCodes } from '../src/rpc/connection.ts';
import { ClientSession } from '../src/server/session.ts';
import { ThreadManager } from '../src/threads/ThreadManager.ts';

const claude = { path: '/usr/bin/false', version: '0' } as any;
const clientInfo = { name: 'test', version: '0' };

/** A client connection to a fresh single-client session, and the notifications it receives. */
function connect() {
  const toServer = new PassThrough();
  const toClient = new PassThrough();
  const session = new ClientSession(new Connection(toServer, toClient, 'server'), new ThreadManager(claude), 'stdio');
  session.start();
  const client = new Connection(toClient, toServer, 'client');
  const notified: { method: string; params: unknown }[] = [];
  client.start({ onRequest: async () => ({}), onNotification: (method, params) => void notified.push({ method, params }), onClose: () => {} });
  let n = 0;
  const call = (method: string, params: unknown = {}) => client.request<any>(method, params, `c${++n}`);
  const fails = (method: string, params: unknown = {}) => call(method, params).then(
    () => {
      throw new Error(`${method} succeeded`);
    },
    (e) => e,
  );
  return { session, client, call, fails, notified };
}

async function initialized(capabilities?: object) {
  const c = connect();
  await c.call('initialize', { clientInfo, protocolVersion: PROTOCOL_VERSION, ...(capabilities ? { capabilities } : {}) });
  return c;
}

describe('method routing', () => {
  test('nothing but initialize is served before the handshake', async () => {
    const { fails } = connect();
    expect((await fails('host/info')).code).toBe(ErrorCodes.notInitialized);
  });

  test('an unknown method is not found, before or after the handshake', async () => {
    expect((await connect().fails('thread/explode')).code).toBe(ErrorCodes.methodNotFound);
    expect((await (await initialized()).fails('thread/explode')).code).toBe(ErrorCodes.methodNotFound);
  });

  test('a second initialize is refused', async () => {
    const { fails } = await initialized();
    expect((await fails('initialize', { clientInfo })).code).toBe(ErrorCodes.alreadyInitialized);
  });

  test('parameters are checked against the method’s schema', async () => {
    const { fails } = await initialized();
    expect((await fails('thread/close', {})).code).toBe(ErrorCodes.invalidParams);
    expect((await fails('turn/interrupt', { threadId: 7 })).code).toBe(ErrorCodes.invalidParams);
    expect((await fails('initialize', { clientInfo: { name: 'no version' } })).code).toBe(ErrorCodes.invalidParams);
  });

  test('a thread that is not loaded is reported as such', async () => {
    const { fails } = await initialized();
    const e = await fails('turn/interrupt', { threadId: 'nope' });
    expect(e.code).toBe(ErrorCodes.threadNotLoaded);
    expect(e.message).toContain('nope');
  });

  test('host/info reports the loaded threads and Claude Code', async () => {
    const { call } = await initialized();
    const r = await call('host/info');
    expect(r.loadedThreads).toBe(0);
    expect(r.claude).toEqual(claude);
    expect(r.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });
});

describe('a host that names its claude', () => {
  /** A company wrapper the daemon's PATH doesn't reach, named in Settings ▸ Hosts ▸ Environment. */
  test('initialize reports that claude, not the daemon\'s', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tether-wrapper-'));
    const wrapper = join(dir, 'claude');
    writeFileSync(wrapper, '#!/bin/sh\necho "9.9.9 (Claude Code)"\n');
    chmodSync(wrapper, 0o755);
    const r = await connect().call('initialize', { clientInfo, protocolVersion: PROTOCOL_VERSION, env: { TETHER_CLAUDE_PATH: wrapper } });
    expect(r.claude).toEqual({ path: wrapper, version: '9.9.9' });
  });

  /** It used to fail initialize, and a retry was then refused as already initialized. */
  test('one that is not there is reported, and initialize still succeeds', async () => {
    const r = await connect().call('initialize', { clientInfo, protocolVersion: PROTOCOL_VERSION, env: { TETHER_CLAUDE_PATH: '/nonexistent/claude' } });
    expect(r.claude).toEqual({ path: '', version: 'not found' });
  });
});

describe('a single-client server', () => {
  test('declines to shut down', async () => {
    const { call } = await initialized();
    expect(await call('host/requestShutdown', { reason: 'test' })).toEqual({ accepted: false });
  });

  test('has no scheduled tasks to offer', async () => {
    const { fails } = await initialized();
    const e = await fails('schedule/list');
    expect(e.code).toBe(ErrorCodes.invalidRequest);
    expect(e.message).toContain('daemon');
  });

  test('says which kind of server it is', async () => {
    const r = await connect().call('initialize', { clientInfo });
    expect(r.host.mode).toBe('stdio');
    expect(r.host.pid).toBe(process.pid);
    expect(r.claude).toEqual(claude);
  });
});

describe('capabilities', () => {
  test('experimental methods need experimentalApi', async () => {
    const e = await (await initialized()).fails('account/usage');
    expect(e.code).toBe(ErrorCodes.invalidRequest);
    expect(e.message).toContain('experimentalApi');
  });

  test('notifications a client opted out of are not sent to it', async () => {
    const { session, call, notified } = await initialized({ optOutNotificationMethods: ['item/agentMessage/delta'] });
    session.notify('item/agentMessage/delta', { threadId: 't', seq: 1 });
    session.notify('turn/started', { threadId: 't', seq: 2 });
    // A request after them: its answer arrives after anything they wrote.
    await call('host/info');
    expect(notified.map((n) => n.method)).toEqual(['turn/started']);
  });
});
