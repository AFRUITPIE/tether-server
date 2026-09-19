import { spawn, type ChildProcess } from 'node:child_process';
import { Connection } from '../rpc/connection.ts';
import type { MethodName, Params, Result } from '../protocol/index.ts';

type ServerRequestHandler = (method: string, params: any) => Promise<unknown> | unknown;

/** Minimal Tether client for tests, the REPL, and scripting. */
export class TetherClient {
  readonly conn: Connection;
  private listeners = new Set<(method: string, params: any) => void>();
  /** Every inbound notification / server request, for fixtures. */
  readonly transcript: { kind: 'notification' | 'request'; method: string; params: unknown }[] = [];
  onServerRequest: ServerRequestHandler = () => {
    throw new Error('no server request handler');
  };

  constructor(readonly proc: ChildProcess) {
    this.conn = new Connection(proc.stdout!, proc.stdin!, 'client');
    this.conn.start({
      onRequest: (method, params) => {
        this.transcript.push({ kind: 'request', method, params });
        return Promise.resolve(this.onServerRequest(method, params));
      },
      onNotification: (method, params) => {
        this.transcript.push({ kind: 'notification', method, params });
        for (const l of this.listeners) l(method, params);
      },
      onClose: () => {},
    });
  }

  static spawn(command: string[], env?: Record<string, string>) {
    const proc = spawn(command[0]!, command.slice(1), { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, ...env } });
    return new TetherClient(proc);
  }

  private nextId = 0;
  call<M extends MethodName>(method: M, params: Params<M>): Promise<Result<M>> {
    return this.conn.request(method, params, `c${++this.nextId}` as any) as Promise<Result<M>>;
  }

  on(fn: (method: string, params: any) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  waitFor(pred: (method: string, params: any) => boolean, timeoutMs = 120_000): Promise<{ method: string; params: any }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error('timeout waiting for notification'));
      }, timeoutMs);
      const off = this.on((method, params) => {
        if (pred(method, params)) {
          clearTimeout(timer);
          off();
          resolve({ method, params });
        }
      });
    });
  }

  async initialize(env?: Record<string, string>) {
    const r = await this.call('initialize', {
      clientInfo: { name: 'tether-test', version: '0' },
      capabilities: { experimentalApi: true },
      ...(env ? { env } : {}),
    });
    this.conn.notify('initialized', {});
    return r;
  }

  close() {
    this.conn.close();
    this.proc.kill();
  }
}
