import { describe, expect, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import { Connection, ErrorCodes, RpcError } from '../src/rpc/connection.ts';

/** The JSON lines written to `stream`, one at a time and in order. */
function lines(stream: PassThrough) {
  const queue: unknown[] = [];
  const waiters: ((v: unknown) => void)[] = [];
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
      const w = waiters.shift();
      if (w) w(msg);
      else queue.push(msg);
    }
  });
  return {
    next: (): Promise<any> => (queue.length ? Promise.resolve(queue.shift()) : new Promise((r) => waiters.push(r))),
  };
}

/** The error `p` is rejected with; a test fails if it resolves instead. */
const rejection = (p: Promise<unknown>) =>
  p.then(
    (v) => {
      throw new Error(`resolved with ${JSON.stringify(v)}`);
    },
    (e) => e as RpcError,
  );

type Call = { kind: 'request' | 'notification'; method: string; params: unknown };

/** A connection whose peer is the test: it writes raw text in and reads JSON lines out. */
function wire(onRequest: (method: string, params: unknown) => Promise<unknown> = async () => ({})) {
  const input = new PassThrough();
  const output = new PassThrough();
  const conn = new Connection(input, output, 'test');
  const calls: Call[] = [];
  let closes = 0;
  conn.start({
    onRequest: (method, params) => (calls.push({ kind: 'request', method, params }), onRequest(method, params)),
    onNotification: (method, params) => void calls.push({ kind: 'notification', method, params }),
    onClose: () => void closes++,
  });
  return { conn, input, out: lines(output), calls, closes: () => closes };
}

describe('framing', () => {
  test('a message split across chunks, and several in one chunk, are each read once', async () => {
    const { input, out, calls } = wire();
    input.write('{"id":1,"method":"a",');
    input.write('"params":{"x":1}}\n{"id":2,"meth');
    input.write('od":"b"}\n\n   \n{"id":3,"method":"c"}\n');
    expect([(await out.next()).id, (await out.next()).id, (await out.next()).id]).toEqual([1, 2, 3]);
    expect(calls.map((c) => c.method)).toEqual(['a', 'b', 'c']);
    expect(calls[0]!.params).toEqual({ x: 1 });
  });

  test('a request without params is handled with empty params', async () => {
    const { input, out, calls } = wire();
    input.write('{"id":1,"method":"a"}\n');
    await out.next();
    expect(calls[0]!.params).toEqual({});
  });

  test('a line that is not JSON is answered with a parse error, and later lines are still read', async () => {
    const { input, out, calls } = wire();
    input.write('{not json\n{"id":7,"method":"a"}\n');
    expect(await out.next()).toEqual({ id: null, error: { code: ErrorCodes.parseError, message: 'invalid JSON' } });
    expect(await out.next()).toEqual({ id: 7, result: {} });
    expect(calls.map((c) => c.method)).toEqual(['a']);
  });

  test('a message with no id, or a null one, is a notification', async () => {
    const { input, out, calls } = wire();
    input.write('{"method":"n1","params":{"a":1}}\n{"id":null,"method":"n2"}\n{"id":1,"method":"r"}\n');
    await out.next();
    expect(calls).toEqual([
      { kind: 'notification', method: 'n1', params: { a: 1 } },
      { kind: 'notification', method: 'n2', params: undefined },
      { kind: 'request', method: 'r', params: {} },
    ]);
  });

  test('what is written has no "jsonrpc" member', async () => {
    const { conn, out } = wire();
    conn.notify('n', { a: 1 });
    void conn.request('r', {});
    expect(await out.next()).toEqual({ method: 'n', params: { a: 1 } });
    expect(await out.next()).toEqual({ id: 's:1', method: 'r', params: {} });
  });
});

describe('answering requests', () => {
  test('a result is sent back under the request’s id, and none at all as {}', async () => {
    const { input, out } = wire(async (m) => (m === 'value' ? { ok: true } : undefined));
    input.write('{"id":"c1","method":"value"}\n{"id":2,"method":"nothing"}\n');
    expect(await out.next()).toEqual({ id: 'c1', result: { ok: true } });
    expect(await out.next()).toEqual({ id: 2, result: {} });
  });

  test('an RpcError keeps its code, message and data; any other error is internal', async () => {
    const { input, out } = wire(async (m) => {
      if (m === 'rpc') throw new RpcError(ErrorCodes.threadNotLoaded, 'not loaded', { threadId: 't' });
      if (m === 'error') throw new Error('boom');
      throw 'a string';
    });
    input.write('{"id":1,"method":"rpc"}\n');
    expect(await out.next()).toEqual({ id: 1, error: { code: ErrorCodes.threadNotLoaded, message: 'not loaded', data: { threadId: 't' } } });
    input.write('{"id":2,"method":"error"}\n');
    expect(await out.next()).toEqual({ id: 2, error: { code: ErrorCodes.internal, message: 'boom' } });
    input.write('{"id":3,"method":"string"}\n');
    expect(await out.next()).toEqual({ id: 3, error: { code: ErrorCodes.internal, message: 'a string' } });
  });

  test('a slow request does not hold up the ones after it', async () => {
    let release!: () => void;
    const { input, out } = wire((m) => (m === 'slow' ? new Promise((r) => (release = () => r({ m }))) : Promise.resolve({ m })));
    input.write('{"id":1,"method":"slow"}\n{"id":2,"method":"fast"}\n');
    expect(await out.next()).toEqual({ id: 2, result: { m: 'fast' } });
    release();
    expect(await out.next()).toEqual({ id: 1, result: { m: 'slow' } });
  });
});

describe('sending requests', () => {
  test('ids of its own are prefixed "s:", so they never collide with the peer’s', async () => {
    const { conn, out } = wire();
    void conn.request('a', {});
    void conn.request('b', {});
    void conn.request('c', {}, 'chosen');
    expect([(await out.next()).id, (await out.next()).id, (await out.next()).id]).toEqual(['s:1', 's:2', 'chosen']);
  });

  test('responses are matched by id, in any order, and one for no pending request is ignored', async () => {
    const { conn, input, out } = wire();
    const a = conn.request('a', {});
    const b = conn.request('b', {});
    await out.next();
    await out.next();
    input.write('{"id":"s:99","result":"stray"}\n{"id":"s:2","result":"B"}\n');
    input.write('{"id":"s:1","error":{"code":-32010,"message":"gone","data":{"x":1}}}\n');
    expect(await b).toBe('B');
    const e = await rejection(a);
    expect(e).toBeInstanceOf(RpcError);
    expect([e.code, e.message, e.data]).toEqual([-32010, 'gone', { x: 1 }]);
  });

  test('cancelling one rejects it alone, and its late answer is ignored', async () => {
    const { conn, input } = wire();
    const a = conn.request('a', {}, 'a');
    const b = conn.request('b', {}, 'b');
    conn.cancelRequest('a');
    conn.cancelRequest('never-sent');
    expect((await rejection(a)).code).toBe(ErrorCodes.requestCancelled);
    input.write('{"id":"a","result":1}\n{"id":"b","result":2}\n');
    expect(await b).toBe(2);
  });
});

describe('closing', () => {
  test('rejects every pending request, and any made afterwards, and says so once', async () => {
    const { conn, closes } = wire();
    const pending = [conn.request('a', {}), conn.request('b', {})];
    conn.close();
    conn.close();
    for (const p of pending) expect((await rejection(p)).code).toBe(ErrorCodes.requestCancelled);
    expect((await rejection(conn.request('c', {}))).code).toBe(ErrorCodes.requestCancelled);
    expect(conn.isClosed).toBe(true);
    expect(closes()).toBe(1);
  });

  test('happens when the peer’s side ends', async () => {
    const { conn, input, closes } = wire();
    const pending = conn.request('a', {});
    input.end();
    expect((await rejection(pending)).code).toBe(ErrorCodes.requestCancelled);
    expect(conn.isClosed).toBe(true);
    expect(closes()).toBe(1);
  });

  test('a request still being handled when the connection closes writes nothing', async () => {
    let release!: () => void;
    let handling!: () => void;
    const started = new Promise<void>((r) => (handling = r));
    const input = new PassThrough();
    const output = new PassThrough();
    const written: string[] = [];
    output.on('data', (c) => written.push(String(c)));
    const conn = new Connection(input, output, 'test');
    conn.start({
      onRequest: () => (handling(), new Promise((r) => (release = () => r({})))),
      onNotification: () => {},
      onClose: () => {},
    });
    input.write('{"id":1,"method":"slow"}\n');
    await started;
    conn.close();
    release();
    await Bun.sleep(5);
    expect(written).toEqual([]);
  });
});
