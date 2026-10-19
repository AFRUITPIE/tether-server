import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { PROTOCOL_VERSION, type ThreadSummary } from '../src/protocol/index.ts';
import { Connection } from '../src/rpc/connection.ts';
import { ClientSession } from '../src/server/session.ts';
import { LiveThread } from '../src/threads/LiveThread.ts';
import { ThreadManager } from '../src/threads/ThreadManager.ts';

const claude = { path: '/usr/bin/false', version: '0' } as any;
const clientInfo = { name: 'test', version: '0' };

describe('thread/summaryChanged', () => {
  const home = mkdtempSync(join(tmpdir(), 'tether-summaries-'));
  const sid = '0d9a7b1c-0000-4000-8000-000000000001';
  const project = join(home, 'projects', '-home-me');
  mkdirSync(project, { recursive: true });
  const record = { type: 'user', uuid: '00000000-0000-4000-8000-000000000001', parentUuid: null, sessionId: sid, cwd: '/home/me', isSidechain: false, userType: 'external', timestamp: '2026-10-06T10:00:00.000Z', message: { role: 'user', content: 'Fix the build' } };
  writeFileSync(join(project, `${sid}.jsonl`), JSON.stringify(record) + '\n');
  const saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = home;
  const mgr = new ThreadManager(claude);
  afterAll(() => {
    mgr.shutdown();
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
    rmSync(home, { recursive: true, force: true });
  });

  async function client() {
    const toServer = new PassThrough();
    const toClient = new PassThrough();
    new ClientSession(new Connection(toServer, toClient, 'server'), mgr, 'daemon').start();
    const c = new Connection(toClient, toServer, 'client');
    const summaries: ThreadSummary[] = [];
    c.start({ onRequest: async () => ({}), onNotification: (m, p: any) => void (m === 'thread/summaryChanged' && summaries.push(p.summary)), onClose: () => {} });
    await c.request('initialize', { clientInfo, protocolVersion: PROTOCOL_VERSION }, 'init');
    let n = 0;
    return { c, summaries, call: (method: string, params: object) => c.request<any>(method, params, `r${++n}`) };
  }
  const until = async (f: () => boolean) => {
    for (let i = 0; i < 100 && !f(); i++) await new Promise((r) => setTimeout(r, 20));
    expect(f()).toBe(true);
  };

  test('a rename and a tag reach every client, subscribed or not, once each', async () => {
    const a = await client();
    const b = await client();
    await a.call('thread/rename', { threadId: sid, title: 'Build fix' });
    await until(() => b.summaries.length === 1);
    expect(b.summaries[0]).toMatchObject({ threadId: sid, title: 'Build fix', customTitle: 'Build fix', cwd: '/home/me', status: 'notLoaded' });
    expect(a.summaries.map((s) => s.title)).toEqual(['Build fix']);
    await a.call('thread/tag', { threadId: sid, tag: 'archived' });
    await until(() => b.summaries.length === 2);
    expect(b.summaries[1]).toMatchObject({ tag: 'archived' });
    // Renamed to what it's called already: nothing new to tell.
    await a.call('thread/rename', { threadId: sid, title: 'Build fix' });
    await new Promise((r) => setTimeout(r, 300));
    expect(b.summaries).toHaveLength(2);
    a.c.close();
    b.c.close();
  });

  test("a live chat's status, before its file is written, is told from what the thread knows", async () => {
    const a = await client();
    const id = '0d9a7b1c-0000-4000-8000-000000000002';
    const t = new LiveThread({ threadId: id, cwd: '/tmp/new', claude, env: {}, mode: 'new', title: 'New chat', onSummaryChange: () => mgr.summaryChanged(id) });
    mgr.threads.set(id, t);
    t.send([{ type: 'text', text: 'go' }]);
    await until(() => a.summaries.some((s) => s.threadId === id));
    expect(a.summaries.find((s) => s.threadId === id)).toMatchObject({ title: 'New chat', cwd: '/tmp/new', status: 'running', backgroundTasks: 0 });
    mgr.threads.delete(id);
    a.c.close();
  });
});
