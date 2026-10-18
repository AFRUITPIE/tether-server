import { describe, expect, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import { MIN_CLIENT_PROTOCOL, PROTOCOL_VERSION } from '../src/protocol/index.ts';
import { Connection, ErrorCodes } from '../src/rpc/connection.ts';
import { ClientSession } from '../src/server/session.ts';
import { ThreadManager } from '../src/threads/ThreadManager.ts';
import { versionInfo } from '../src/version.ts';

const claude = { path: '/usr/bin/false', version: '0' } as any;

/** A client connection to a fresh session, over in-memory pipes. */
function connect() {
  const toServer = new PassThrough();
  const toClient = new PassThrough();
  new ClientSession(new Connection(toServer, toClient, 'server'), new ThreadManager(claude), 'stdio').start();
  const client = new Connection(toClient, toServer, 'client');
  client.start({ onRequest: async () => ({}), onNotification: () => {}, onClose: () => {} });
  return client;
}

const clientInfo = { name: 'test', version: '0' };

describe('protocol handshake', () => {
  test('a current client is served, and told the range the server speaks', async () => {
    const r: any = await connect().request('initialize', { clientInfo, protocolVersion: PROTOCOL_VERSION }, 'c1');
    expect(r.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(r.minClientProtocol).toBe(MIN_CLIENT_PROTOCOL);
  });

  test('a client that predates the field speaks protocol 1, and is refused', async () => {
    const e: any = await connect()
      .request('initialize', { clientInfo }, 'c1')
      .catch((e) => e);
    expect(e.code).toBe(ErrorCodes.incompatibleProtocol);
    expect(MIN_CLIENT_PROTOCOL).toBe(2);
  });

  test('a client older than the server serves is refused with both numbers', async () => {
    const e: any = await connect()
      .request('initialize', { clientInfo, protocolVersion: MIN_CLIENT_PROTOCOL - 1 }, 'c1')
      .catch((e) => e);
    expect(e.code).toBe(ErrorCodes.incompatibleProtocol);
    expect(e.data).toEqual({ protocolVersion: PROTOCOL_VERSION, minClientProtocol: MIN_CLIENT_PROTOCOL });
  });

  test("an older release's `connect` can still ask the daemon to make way, and nothing else", async () => {
    const c = connect();
    const r: any = await c.request('initialize', { clientInfo: { name: 'tether-upgrade', version: '0.5.22' } }, 'c1');
    expect(r.protocolVersion).toBe(PROTOCOL_VERSION);
    // serve --stdio has no daemon to stop, but the method is served.
    expect(await c.request<any>('host/requestShutdown', { reason: 'upgrade' }, 'c2')).toEqual({ accepted: false });
    const e: any = await c.request('thread/list', {}, 'c3').catch((e) => e);
    expect(e.code).toBe(ErrorCodes.incompatibleProtocol);
  });

  test('`tether version --json` names this machine’s release asset', () => {
    const v = versionInfo();
    expect(v.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(v.minClientProtocol).toBe(MIN_CLIENT_PROTOCOL);
    expect(v.platform).toMatch(/^(darwin|linux)-(arm64|x64)$/);
    expect(v.agentSdkVersion).toBeTruthy();
  });
});
