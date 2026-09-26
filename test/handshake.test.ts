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

  test('a client that predates the field is served as protocol 1', async () => {
    const r: any = await connect().request('initialize', { clientInfo }, 'c1');
    expect(r.protocolVersion).toBe(PROTOCOL_VERSION);
  });

  test('a client older than the server serves is refused with both numbers', async () => {
    const e: any = await connect()
      .request('initialize', { clientInfo, protocolVersion: MIN_CLIENT_PROTOCOL - 1 }, 'c1')
      .catch((e) => e);
    expect(e.code).toBe(ErrorCodes.incompatibleProtocol);
    expect(e.data).toEqual({ protocolVersion: PROTOCOL_VERSION, minClientProtocol: MIN_CLIENT_PROTOCOL });
  });

  test('`tether version --json` names this machine’s release asset', () => {
    const v = versionInfo();
    expect(v.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(v.minClientProtocol).toBe(MIN_CLIENT_PROTOCOL);
    expect(v.platform).toMatch(/^(darwin|linux)-(arm64|x64)$/);
    expect(v.agentSdkVersion).toBeTruthy();
  });
});
