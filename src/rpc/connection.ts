import type { Readable, Writable } from 'node:stream';

/** JSON-RPC 2.0 without the "jsonrpc" field, framed as newline-delimited JSON (Codex app-server style). */
export type RequestId = string | number;
export type RpcRequest = { id: RequestId; method: string; params?: unknown };
export type RpcNotification = { method: string; params?: unknown };
export type RpcResponse = { id: RequestId; result: unknown } | { id: RequestId; error: RpcErrorShape };
export type RpcErrorShape = { code: number; message: string; data?: unknown };
export type RpcMessage = RpcRequest | RpcNotification | RpcResponse;

export const ErrorCodes = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  overloaded: -32001,
  notInitialized: -32002,
  alreadyInitialized: -32003,
  threadNotFound: -32010,
  threadNotLoaded: -32011,
  sdkError: -32020,
  requestCancelled: -32800,
} as const;

export class RpcError extends Error {
  constructor(
    public code: number,
    message: string,
    public data?: unknown,
  ) {
    super(message);
  }
}

type Handlers = {
  onRequest: (method: string, params: unknown) => Promise<unknown>;
  onNotification: (method: string, params: unknown) => void;
  onClose: () => void;
};

/**
 * One peer connection. Symmetric: either side can send requests. Server→client
 * requests (approvals) use string ids prefixed "s:" so they never collide with client ids.
 */
export class Connection {
  private buffer = '';
  private pending = new Map<RequestId, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private nextId = 0;
  private closed = false;
  private handlers?: Handlers;

  constructor(
    private input: Readable,
    private output: Writable,
    public readonly label = 'conn',
  ) {}

  start(handlers: Handlers) {
    this.handlers = handlers;
    this.input.setEncoding('utf8');
    this.input.on('data', (chunk: string) => this.onData(chunk));
    this.input.on('end', () => this.close());
    this.input.on('error', () => this.close());
    this.output.on('error', () => this.close());
  }

  get isClosed() {
    return this.closed;
  }

  notify(method: string, params: unknown) {
    this.write({ method, params });
  }

  request<T = unknown>(method: string, params: unknown, id?: string): Promise<T> {
    const reqId = id ?? `s:${++this.nextId}`;
    return new Promise<T>((resolve, reject) => {
      if (this.closed) return reject(new RpcError(ErrorCodes.requestCancelled, 'connection closed'));
      this.pending.set(reqId, { resolve: resolve as (v: unknown) => void, reject });
      this.write({ id: reqId, method, params });
    });
  }

  /** Drop a pending outbound request (e.g. another client answered it). */
  cancelRequest(id: string) {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    p.reject(new RpcError(ErrorCodes.requestCancelled, 'request resolved elsewhere'));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const [, p] of this.pending) p.reject(new RpcError(ErrorCodes.requestCancelled, 'connection closed'));
    this.pending.clear();
    try {
      this.output.end();
    } catch {}
    this.handlers?.onClose();
  }

  private write(msg: RpcMessage) {
    if (this.closed) return;
    this.output.write(JSON.stringify(msg) + '\n');
  }

  private onData(chunk: string) {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (line) this.onLine(line);
    }
  }

  private onLine(line: string) {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      this.write({ id: null as any, error: { code: ErrorCodes.parseError, message: 'invalid JSON' } });
      return;
    }
    if (msg && typeof msg === 'object' && 'method' in msg) {
      if ('id' in msg && msg.id !== undefined && msg.id !== null) void this.handleRequest(msg as RpcRequest);
      else this.handlers?.onNotification(msg.method, msg.params);
    } else if (msg && 'id' in msg) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if ('error' in msg) p.reject(new RpcError(msg.error.code, msg.error.message, msg.error.data));
      else p.resolve(msg.result);
    }
  }

  private async handleRequest(req: RpcRequest) {
    try {
      const result = await this.handlers!.onRequest(req.method, req.params ?? {});
      this.write({ id: req.id, result: result ?? {} });
    } catch (e) {
      const err =
        e instanceof RpcError
          ? { code: e.code, message: e.message, data: e.data }
          : { code: ErrorCodes.internal, message: e instanceof Error ? e.message : String(e) };
      this.write({ id: req.id, error: err });
    }
  }
}
