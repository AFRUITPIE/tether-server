import { getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Item } from '../src/protocol/index.ts';
import { FollowedThread } from '../src/threads/FollowedThread.ts';
import { forgetStoredHistory, projectDirName, sessionFile, storedHistory } from '../src/threads/history.ts';
import { Itemizer } from '../src/threads/itemizer.ts';
import { LiveThread } from '../src/threads/LiveThread.ts';
import { ThreadManager } from '../src/threads/ThreadManager.ts';

// Transcripts written the way Claude Code writes them, under a CLAUDE_CONFIG_DIR of the tests' own.
const root = mkdtempSync(join(tmpdir(), 'tether-history-'));
const config = join(root, 'config');
const cwd = join(root, 'project');
mkdirSync(cwd);
const realCwd = realpathSync(cwd);
let savedConfig: string | undefined;

beforeAll(() => {
  savedConfig = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = config;
});
afterAll(() => {
  if (savedConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedConfig;
  rmSync(root, { recursive: true, force: true });
});
afterEach(() => forgetStoredHistory());

type Line = Record<string, unknown>;

/** A session's lines, built with each line's uuid named for the test's reading. */
class Session {
  readonly id = randomUUID();
  readonly lines: Line[] = [];
  private second = 0;

  constructor(readonly dir = cwd) {}

  get path(): string {
    return join(config, 'projects', projectDirName(realpathSync(this.dir)), `${this.id}.jsonl`);
  }

  add(e: Line): this {
    const at = new Date(Date.UTC(2026, 8, 1, 9, 0, this.second++)).toISOString();
    this.lines.push({ isSidechain: false, userType: 'external', cwd: this.dir, sessionId: this.id, version: '2.1.99', ...e, timestamp: at });
    return this;
  }

  prompt(uuid: string, parent: string | null, text: string, extra: Line = {}) {
    return this.add({ type: 'user', uuid, parentUuid: parent, message: { role: 'user', content: text }, ...extra });
  }
  reply(uuid: string, parent: string | null, text: string, id = `msg_${uuid}`, extra: Line = {}) {
    const message = { id, type: 'message', role: 'assistant', model: 'claude-test', content: [{ type: 'text', text }] };
    return this.add({ type: 'assistant', uuid, parentUuid: parent, message, ...extra });
  }
  call(uuid: string, parent: string, tool: string, id = `msg_${uuid}`) {
    const content = [{ type: 'tool_use', id: tool, name: 'Bash', input: { command: `echo ${tool}` } }];
    return this.add({ type: 'assistant', uuid, parentUuid: parent, message: { id, type: 'message', role: 'assistant', model: 'claude-test', content } });
  }
  result(uuid: string, parent: string, tool: string) {
    const content = [{ type: 'tool_result', tool_use_id: tool, content: `ran ${tool}` }];
    return this.add({ type: 'user', uuid, parentUuid: parent, message: { role: 'user', content }, toolUseResult: { stdout: `ran ${tool}` } });
  }
  attachment(uuid: string, parent: string, attachment: Line = { type: 'output_style', style: 'default' }) {
    return this.add({ type: 'attachment', uuid, parentUuid: parent, attachment });
  }
  /** A compaction: its boundary, context the CLI attaches, and the summary the model is handed. */
  compaction(uuid: string, logicalParent: string, kept?: string[]) {
    const summary = `${uuid}-summary`;
    const compactMetadata = {
      trigger: 'auto',
      preTokens: 1000,
      postTokens: 100,
      ...(kept
        ? {
            preservedSegment: { headUuid: kept[0], anchorUuid: summary, tailUuid: kept.at(-1) },
            preservedMessages: { anchorUuid: summary, uuids: kept },
          }
        : {}),
    };
    this.add({ type: 'system', subtype: 'compact_boundary', uuid, parentUuid: null, logicalParentUuid: logicalParent, content: 'Conversation compacted', level: 'info', compactMetadata });
    this.attachment(`${uuid}-context`, uuid, { type: 'date', date: '2026-09-01' });
    return this.prompt(summary, `${uuid}-context`, 'This session is being continued from a previous conversation that ran out of context.', {
      isCompactSummary: true,
      isVisibleInTranscriptOnly: true,
    });
  }
  /** Lines without a uuid, which Claude Code writes between messages. */
  metadata() {
    this.lines.push({ type: 'custom-title', customTitle: 'A chat', sessionId: this.id });
    return this;
  }

  write(): this {
    mkdirSync(join(this.path, '..'), { recursive: true });
    writeFileSync(this.path, this.lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    return this;
  }
  /** Writes the lines added since `from`, as the CLI appends them. */
  append(from: number): void {
    appendFileSync(this.path, this.lines.slice(from).map((l) => JSON.stringify(l) + '\n').join(''));
  }
}

const itemize = (messages: unknown[]): Item[] => {
  const iz = new Itemizer(() => 0, true);
  for (const m of messages) iz.ingest(m as never);
  iz.closeTurn('completed');
  return iz.snapshot().items;
};

/** What a reader sees, a line per item. */
const read = (items: Item[]) =>
  items.map((i) => {
    switch (i.type) {
      case 'userMessage':
        return `you: ${i.content.map((c) => (c.type === 'text' ? c.text : c.type)).join(' ')}`;
      case 'agentMessage':
        return `claude: ${i.text}`;
      case 'toolCall':
        return `ran ${i.id} (${i.status})`;
      case 'compaction':
        return 'compacted';
      default:
        return i.type;
    }
  });

const history = async (s: Session) => read(itemize((await storedHistory(s.id, cwd)).messages));

describe('a session’s history reaches back past where the SDK’s chain starts', () => {
  test('through every compaction, each one a marker rather than its summary', async () => {
    const s = new Session()
      .prompt('p1', null, 'one')
      .reply('r1', 'p1', 'first')
      .metadata()
      .compaction('b1', 'r1')
      .prompt('p2', 'b1-summary', 'two')
      .reply('r2', 'p2', 'second')
      .compaction('b2', 'r2')
      .prompt('p3', 'b2-summary', 'three')
      .reply('r3', 'p3', 'third')
      .write();

    // The SDK alone: the last chain, from its boundary.
    const sdk = await getSessionMessages(s.id, { dir: cwd, includeSystemMessages: true });
    expect(sdk.map((m) => m.uuid)).toEqual(['b2', 'b2-summary', 'p3', 'r3']);

    expect(await history(s)).toEqual([
      'you: one',
      'claude: first',
      'compacted',
      'you: two',
      'claude: second',
      'compacted',
      'you: three',
      'claude: third',
    ]);
    const items = itemize((await storedHistory(s.id, cwd)).messages);
    const marker = items.find((i) => i.id === 'b1');
    expect(marker).toMatchObject({ type: 'compaction', trigger: 'auto', preTokens: 1000, postTokens: 100 });
    // When it happened, and inside the turn it interrupted.
    expect(marker!.createdAt).toBe(Date.parse(s.lines.find((l) => l.uuid === 'b1')!.timestamp as string));
    expect(marker!.turnId).toBe(items.find((i) => i.id === 'p1')!.turnId);
  });

  test('past a parent missing from the file, to the nearest main-chain message above it', async () => {
    const s = new Session()
      .prompt('p1', null, 'one')
      .reply('r1', 'p1', 'first')
      // A subagent's lines, as older versions wrote them into the session's own file.
      .prompt('side1', null, 'subagent task', { isSidechain: true })
      .reply('side2', 'side1', 'subagent reply', 'msg_side2', { isSidechain: true })
      // Lost: whatever `p2`'s parent was.
      .prompt('p2', 'lost', 'two')
      .reply('r2', 'p2', 'second')
      .write();
    const sdk = await getSessionMessages(s.id, { dir: cwd, includeSystemMessages: true });
    expect(sdk.map((m) => m.uuid)).toEqual(['p2', 'r2']);
    expect(await history(s)).toEqual(['you: one', 'claude: first', 'you: two', 'claude: second']);
  });

  test('along the branch it went on with, leaving a rewound one out', async () => {
    const s = new Session()
      .prompt('p1', null, 'one')
      .reply('r1', 'p1', 'first')
      .prompt('p2', 'r1', 'abandoned')
      .reply('r2', 'p2', 'abandoned reply')
      .prompt('p2b', 'r1', 'instead')
      .reply('r2b', 'p2b', 'kept reply')
      .compaction('b1', 'r2b')
      .prompt('p3', 'b1-summary', 'three')
      .reply('r3', 'p3', 'third')
      .write();
    expect(await history(s)).toEqual([
      'you: one',
      'claude: first',
      'you: instead',
      'claude: kept reply',
      'compacted',
      'you: three',
      'claude: third',
    ]);
  });

  test('keeps the messages a compaction kept where they were written, once', async () => {
    const s = new Session()
      .prompt('p1', null, 'one')
      .reply('r1', 'p1', 'first')
      .prompt('p2', 'r1', 'two')
      .call('c1', 'p2', 'tool1')
      .result('t1', 'c1', 'tool1')
      .attachment('a1', 't1')
      .compaction('b1', 'a1', ['c1', 't1'])
      // The CLI parents what follows on the summary; the SDK relinks it after the kept messages.
      .reply('r2', 'b1-summary', 'after the compaction')
      .prompt('p3', 'r2', 'three')
      .reply('r3', 'p3', 'third')
      .write();
    const sdk = await getSessionMessages(s.id, { dir: cwd, includeSystemMessages: true });
    expect(sdk.map((m) => m.uuid)).toEqual(['b1', 'b1-summary', 'c1', 't1', 'r2', 'p3', 'r3']);
    expect(await history(s)).toEqual([
      'you: one',
      'claude: first',
      'you: two',
      'ran tool1 (completed)',
      'compacted',
      'claude: after the compaction',
      'you: three',
      'claude: third',
    ]);
  });

  test('a chain before a compaction comes out as the SDK makes it when it’s the current one', async () => {
    // Everything the SDK treats specially: a reply written a block at a time with parallel tool
    // calls (one result off the chain), meta and queued messages, an interruption, a subagent's
    // lines, progress, attachments and lines without a uuid.
    const earlier = (s: Session) =>
      s
        .prompt('p1', null, 'one')
        .prompt('meta', 'p1', '<system-reminder>context</system-reminder>', { isMeta: true })
        .reply('r1', 'meta', 'thinking about it', 'msg_A')
        .call('c1', 'r1', 'tool1', 'msg_A')
        .call('c2', 'c1', 'tool2', 'msg_A')
        .result('t1', 'c1', 'tool1')
        .result('t2', 'c2', 'tool2')
        .prompt('side', 't2', 'subagent', { isSidechain: true })
        .add({ type: 'progress', uuid: 'prog', parentUuid: 't2', data: { type: 'hook_progress' } })
        .attachment('q1', 'prog', { type: 'queued_command', prompt: 'also this', commandMode: 'prompt' })
        .reply('r2', 'q1', 'done both', 'msg_B')
        .metadata()
        .prompt('p2', 'r2', 'two')
        .prompt('int', 'p2', '[Request interrupted by user]')
        .prompt('p3', 'int', 'three')
        .reply('r3', 'p3', 'third');
    const alone = earlier(new Session()).write();
    const expected = await getSessionMessages(alone.id, { dir: cwd, includeSystemMessages: true });
    expect(expected.length).toBeGreaterThan(8);

    const later = earlier(new Session()).compaction('b1', 'r3').prompt('p4', 'b1-summary', 'four').write();
    const { messages } = await storedHistory(later.id, cwd);
    const withSession = (m: object) => ({ ...m, session_id: 'x' });
    expect(messages.slice(0, expected.length).map(withSession)).toEqual(expected.map(withSession));
    expect(messages.slice(expected.length).map((m) => m.uuid)).toEqual(['b1', 'b1-summary', 'p4']);
  });

  test('a chain that ends on parallel tool calls keeps its end and both results', async () => {
    // The first call's result, written last, is the newest line off the chain the SDK is given.
    const s = new Session()
      .prompt('p1', null, 'one')
      .call('c1', 'p1', 'tool1', 'msg_A')
      .call('c2', 'c1', 'tool2', 'msg_A')
      .result('t2', 'c2', 'tool2')
      .result('t1', 'c1', 'tool1')
      .compaction('b1', 'c2')
      .prompt('p2', 'b1-summary', 'two')
      .write();
    expect(await history(s)).toEqual(['you: one', 'ran tool1 (completed)', 'ran tool2 (completed)', 'compacted', 'you: two']);
  });

  test('a rewind to before a compaction, in a transcript the SDK reads from its last boundary', async () => {
    // Over 5 MB the SDK reads only from the last compaction on, so the chain it finds stops at
    // the first message whose parent is before that.
    const big = 'x'.repeat(6 * 1024 * 1024);
    const s = new Session()
      .prompt('p1', null, 'one')
      .reply('r1', 'p1', big)
      .prompt('p2', 'r1', 'abandoned')
      .reply('r2', 'p2', 'abandoned reply')
      .compaction('b1', 'r2')
      .prompt('p3', 'b1-summary', 'abandoned too')
      .prompt('p2b', 'r1', 'rewound to here')
      .reply('r2b', 'p2b', 'kept reply')
      .write();
    const sdk = await getSessionMessages(s.id, { dir: cwd, includeSystemMessages: true });
    expect(sdk.map((m) => m.uuid)).toEqual(['p2b', 'r2b']);
    const read = await history(s);
    expect(read.map((l) => l.slice(0, 20))).toEqual(['you: one', 'claude: xxxxxxxxxxxx', 'you: rewound to here', 'claude: kept reply']);
  });

  test('a session with nothing before its chain is the SDK’s result as it is', async () => {
    const s = new Session().prompt('p1', null, 'one').reply('r1', 'p1', 'first').write();
    const sdk = await getSessionMessages(s.id, { dir: cwd, includeSystemMessages: true });
    expect((await storedHistory(s.id, cwd)).messages).toEqual(sdk);
    expect((await storedHistory(randomUUID(), cwd)).messages).toEqual([]);
  });
});

describe('reading the joined history', () => {
  const longSession = () => {
    const s = new Session();
    let parent: string | null = null;
    for (let chain = 0; chain < 3; chain++) {
      if (chain) {
        s.compaction(`b${chain}`, parent!);
        parent = `b${chain}-summary`;
      }
      for (let turn = 0; turn < 3; turn++) {
        s.prompt(`p${chain}.${turn}`, parent, `prompt ${chain}.${turn}`).reply(`r${chain}.${turn}`, `p${chain}.${turn}`, `reply ${chain}.${turn}`);
        parent = `r${chain}.${turn}`;
      }
    }
    return s.write();
  };

  test('pages back across compactions to the session’s start', async () => {
    const s = longSession();
    const mgr = new ThreadManager({ path: '/usr/bin/false', version: '0' });
    try {
      const whole = await mgr.read(s.id, cwd);
      expect(read(whole.items)).toHaveLength(20);
      expect(read(whole.items)[0]).toBe('you: prompt 0.0');
      expect(whole.historySeq).toBeDefined();

      const pages: Item[][] = [];
      let before: string | undefined;
      for (;;) {
        const page = await mgr.read(s.id, cwd, { limit: 3, ...(before ? { before } : {}) });
        pages.unshift(page.items);
        expect(page.historySeq).toBe(whole.historySeq);
        if (!page.hasMore) break;
        before = page.items[0]!.id;
      }
      expect(pages.flat().map((i) => i.id)).toEqual(whole.items.map((i) => i.id));
    } finally {
      mgr.unfollow(s.id);
      mgr.shutdown();
    }
  });

  test('a live thread’s history is the whole stored one, then what it has done since', async () => {
    const s = longSession();
    const mgr = new ThreadManager({ path: '/usr/bin/false', version: '0' });
    const live = new LiveThread({ threadId: s.id, cwd, claude: mgr.claude, env: {}, mode: 'resume' });
    live.status = 'idle';
    mgr.threads.set(s.id, live);
    try {
      (live as any).onMessage({ type: 'user', uuid: 'p9', message: { role: 'user', content: 'live prompt' } });
      (live as any).onMessage({ type: 'assistant', uuid: 'r9', message: { id: 'msg_r9', content: [{ type: 'text', text: 'live reply' }] } });
      const r = await mgr.read(s.id, cwd);
      expect(read(r.items)).toEqual([...(await history(s)), 'you: live prompt', 'claude: live reply']);
      expect(r.historySeq).toBe(live.threadInfo().lastSeq);
      const last = await mgr.read(s.id, cwd, { limit: 2 });
      expect(read(last.items)).toEqual(['you: live prompt', 'claude: live reply']);
    } finally {
      mgr.threads.delete(s.id);
      mgr.shutdown();
    }
  });
});

describe('following a session through a compaction', () => {
  test('streams what follows the snapshot, the new chain once, with its marker', async () => {
    const s = new Session()
      .prompt('p1', null, 'one')
      .reply('r1', 'p1', 'first')
      .compaction('b1', 'r1')
      .prompt('p2', 'b1-summary', 'two')
      .call('c2', 'p2', 'tool2')
      .result('t2', 'c2', 'tool2')
      .write();
    const f = new FollowedThread(s.id, cwd);
    const sent: { method: string; params: any }[] = [];
    try {
      await f.start();
      const snapshot = f.history();
      expect(read(snapshot.items)).toEqual(['you: one', 'claude: first', 'compacted', 'you: two', 'ran tool2 (completed)']);
      f.subscribe({ id: 'c', notify: (method: string, params: any) => sent.push({ method, params }), request: () => new Promise(() => {}), cancelRequest() {} } as any, snapshot.seq);

      // The CLI compacts mid-turn, keeping the tool call, and carries on.
      const from = s.lines.length;
      s.compaction('b2', 't2', ['c2', 't2']).reply('r2', 'b2-summary', 'second').prompt('p3', 'r2', 'three');
      s.append(from);
      const started = () => sent.filter((e) => e.method === 'item/started').map((e) => e.params.item.id);
      for (let i = 0; i < 100 && !started().includes('p3'); i++) {
        await (f as any).refresh();
        await Bun.sleep(20);
      }

      expect(started()).toEqual(['b2', 'msg_r2:0', 'p3']);
      expect(sent.every((e) => e.params.seq > snapshot.seq)).toBe(true);
      // The snapshot and what followed it are the history read afresh, no more and no less.
      const fresh = itemize((await storedHistory(s.id, cwd)).messages);
      expect(f.history().items.map((i) => i.id)).toEqual(fresh.map((i) => i.id));
      expect(read(f.history().items)).toEqual([
        'you: one',
        'claude: first',
        'compacted',
        'you: two',
        'ran tool2 (completed)',
        'compacted',
        'claude: second',
        'you: three',
      ]);
    } finally {
      f.close();
    }
  });
});

describe('finding a session’s transcript', () => {
  test('in the folder Claude Code names for the directory, as the SDK looks for it', async () => {
    expect(projectDirName('/Users/me/my project.v2')).toBe('-Users-me-my-project-v2');
    // A long path is cut and told apart by a hash; the SDK finds the session where it's put.
    const long = join(root, 'd'.repeat(220));
    mkdirSync(long);
    const s = new Session(long).prompt('p1', null, 'one').reply('r1', 'p1', 'first').write();
    expect(projectDirName(realpathSync(long))).toMatch(/^.{200}-[0-9a-z]+$/);
    expect((await getSessionMessages(s.id, { dir: long })).map((m) => m.uuid)).toEqual(['p1', 'r1']);
    expect(await sessionFile(s.id, long)).toBe(s.path);
  });

  test('anywhere under the configuration directory when the directory doesn’t say', async () => {
    const s = new Session().prompt('p1', null, 'one').write();
    expect(await sessionFile(s.id)).toBe(s.path);
    expect(await sessionFile(s.id, join(root, 'elsewhere'))).toBe(s.path);
    expect(await sessionFile(randomUUID(), cwd)).toBeUndefined();
  });
});
