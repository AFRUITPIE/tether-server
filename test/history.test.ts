import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FollowedThread } from '../src/threads/FollowedThread.ts';
import { readSessionHistory } from '../src/threads/transcript.ts';
import { ThreadManager } from '../src/threads/ThreadManager.ts';

describe('history across compactions', () => {
  // A Claude config folder holding one session that was compacted twice, as the CLI writes it: each
  // boundary starts the chain again (no parentUuid), pointing back with logicalParentUuid.
  const home = mkdtempSync(join(tmpdir(), 'tether-history-'));
  const sid = '5f0c8a52-3f7e-4c1e-9d55-0b7a2f6f1c01';
  const project = join(home, 'projects', '-home-me');
  mkdirSync(project, { recursive: true });
  const path = join(project, `${sid}.jsonl`);
  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  let n = 0;
  let t = Date.parse('2026-10-01T10:00:00Z');
  const common = () => ({ sessionId: sid, cwd: '/home/me', isSidechain: false, userType: 'external', timestamp: new Date((t += 1000)).toISOString() });
  const records: object[] = [];
  let parent: string | null = null;
  const prompt = (text: string, extra: object = {}) => {
    const uuid = id(++n);
    records.push({ ...common(), type: 'user', uuid, parentUuid: parent, message: { role: 'user', content: text }, ...extra });
    parent = uuid;
  };
  const reply = (text: string) => {
    const uuid = id(++n);
    records.push({ ...common(), type: 'assistant', uuid, parentUuid: parent, message: { id: `msg_${n}`, role: 'assistant', model: 'claude-test', content: [{ type: 'text', text }], stop_reason: 'end_turn' } });
    parent = uuid;
  };
  const compact = () => {
    const uuid = id(++n);
    records.push({ ...common(), type: 'system', subtype: 'compact_boundary', uuid, parentUuid: null, logicalParentUuid: parent, content: 'Conversation compacted', level: 'info', compactMetadata: { trigger: 'manual', preTokens: 84000 } });
    parent = uuid;
    prompt('This session is being continued from a previous conversation that ran out of context.', { isCompactSummary: true, isVisibleInTranscriptOnly: true });
  };
  prompt('First question');
  reply('First answer');
  compact();
  prompt('Second question');
  reply('Second answer');
  compact();
  prompt('Third question');
  reply('Third answer');
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join('\n') + '\n');

  const saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = home;
  const mgr = new ThreadManager({ path: '/usr/bin/false', version: '0' } as any);
  afterAll(() => {
    mgr.shutdown();
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
    rmSync(home, { recursive: true, force: true });
  });

  test('every segment, oldest first, each message once', async () => {
    const { messages } = await readSessionHistory(sid, '/home/me', path);
    const uuids = messages.map((m) => m.uuid);
    expect(new Set(uuids).size).toBe(uuids.length);
    expect(uuids[0]).toBe(id(1));
    expect(uuids.at(-1)).toBe(id(n));
  });

  test('a chat opened after two compactions reads from its first prompt', async () => {
    const { items } = await mgr.read(sid, '/home/me', { limit: 100 });
    const prompts = items.flatMap((i) => (i.type === 'userMessage' && !i.synthetic ? [i.content.map((c) => (c.type === 'text' ? c.text : '')).join('')] : []));
    expect(prompts).toEqual(['First question', 'Second question', 'Third question']);
    const replies = items.flatMap((i) => (i.type === 'agentMessage' ? [i.text] : []));
    expect(replies).toEqual(['First answer', 'Second answer', 'Third answer']);
    // Each compaction is its line, with how big the chat was; its summary is Claude Code's.
    const compactions = items.filter((i) => i.type === 'compaction');
    expect(compactions.length).toBe(2);
    expect(compactions[0]).toMatchObject({ trigger: 'manual', preTokens: 84000 });
    const summaries = items.filter((i) => i.type === 'userMessage' && i.origin === 'compaction');
    expect(summaries.length).toBe(2);
    expect(summaries.every((i) => i.type === 'userMessage' && i.synthetic === true)).toBe(true);
  });

  test('a session that never compacted reads as before', async () => {
    const plain = '5f0c8a52-3f7e-4c1e-9d55-0b7a2f6f1c02';
    const file = join(project, `${plain}.jsonl`);
    writeFileSync(file, records.slice(0, 2).map((r) => JSON.stringify({ ...r, sessionId: plain })).join('\n') + '\n');
    const { messages } = await readSessionHistory(plain, '/home/me', file);
    expect(messages.length).toBe(2);
  });
});

describe('following a chat as it is written', () => {
  // A session another client runs, appended to while it's followed, compacted along the way.
  const home = mkdtempSync(join(tmpdir(), 'tether-follow-'));
  const sid = '5f0c8a52-3f7e-4c1e-9d55-0b7a2f6f1c09';
  const project = join(home, 'projects', '-home-me');
  mkdirSync(project, { recursive: true });
  const path = join(project, `${sid}.jsonl`);
  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  let n = 0;
  let t = Date.parse('2026-10-01T10:00:00Z');
  let parent: string | null = null;
  const common = () => ({ sessionId: sid, cwd: '/home/me', isSidechain: false, userType: 'external', timestamp: new Date((t += 1000)).toISOString() });
  const line = (r: object) => JSON.stringify(r) + '\n';
  const prompt = (text: string, extra: object = {}) => {
    const uuid = id(++n);
    const r = { ...common(), type: 'user', uuid, parentUuid: parent, permissionMode: 'default', message: { role: 'user', content: text }, ...extra };
    parent = uuid;
    return line(r);
  };
  const reply = (text: string, model = 'claude-test') => {
    const uuid = id(++n);
    const r = { ...common(), type: 'assistant', uuid, parentUuid: parent, message: { id: `msg_${n}`, role: 'assistant', model, content: [{ type: 'text', text }], stop_reason: 'end_turn' } };
    parent = uuid;
    return line(r);
  };
  const compact = () => {
    const uuid = id(++n);
    const r = { ...common(), type: 'system', subtype: 'compact_boundary', uuid, parentUuid: null, logicalParentUuid: parent, content: 'Conversation compacted', level: 'info', compactMetadata: { trigger: 'auto', preTokens: 90000 } };
    parent = uuid;
    return line(r) + prompt('This session is being continued from a previous conversation that ran out of context.', { isCompactSummary: true, isVisibleInTranscriptOnly: true });
  };
  writeFileSync(path, prompt('First question') + reply('First answer'));

  const saved = process.env.CLAUDE_CONFIG_DIR;
  beforeAll(() => {
    process.env.CLAUDE_CONFIG_DIR = home;
  });
  afterAll(() => {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
    rmSync(home, { recursive: true, force: true });
  });

  test('says each new message once, across a compaction, and ends as a fresh read of the file does', async () => {
    const f = new FollowedThread(sid, '/home/me');
    await f.start();
    (f as any).watcher?.close();
    const sent: { method: string; params: any }[] = [];
    f.subscribe({ id: 'c', notify: (method, params: any) => sent.push({ method, params }), request: () => new Promise(() => {}), cancelRequest() {} });
    const refresh = () => (f as any).refresh() as Promise<void>;
    const started = () => sent.filter((e) => e.method === 'item/started').map((e) => e.params.item);

    appendFileSync(path, prompt('Second question') + reply('Second answer'));
    await refresh();
    expect(started().map((i) => i.type)).toEqual(['userMessage', 'agentMessage']);
    // Nothing new: nothing said.
    await refresh();
    expect(started().length).toBe(2);

    // Compacted while followed: the chain starts again at the boundary, and only what's new is said.
    appendFileSync(path, compact() + prompt('Third question') + reply('Third answer', 'claude-other'));
    await refresh();
    expect(started().slice(2).map((i) => i.type)).toEqual(['compaction', 'userMessage', 'userMessage', 'agentMessage']);
    expect(started()[2]).toMatchObject({ type: 'compaction', trigger: 'auto', preTokens: 90000 });
    expect(started()[3]).toMatchObject({ origin: 'compaction', synthetic: true });
    // The owner's model changed: the follower's settings say so.
    expect(sent.filter((e) => e.method === 'thread/updated').at(-1)?.params.thread.model).toBe('claude-other');

    const fresh = new FollowedThread(sid, '/home/me');
    await fresh.start();
    expect(f.history().items).toEqual(fresh.history().items);
    expect(f.history().turns).toEqual(fresh.history().turns);
    f.close();
    fresh.close();
  });

  test('a line still being written is read once it is whole', async () => {
    const f = new FollowedThread(sid, '/home/me');
    await f.start();
    (f as any).watcher?.close();
    const before = f.history().items.length;
    const whole = prompt('Fourth question');
    appendFileSync(path, whole.slice(0, 40));
    await (f as any).refresh();
    expect(f.history().items.length).toBe(before);
    appendFileSync(path, whole.slice(40));
    await (f as any).refresh();
    expect(f.history().items.length).toBe(before + 1);
    f.close();
  });
});
