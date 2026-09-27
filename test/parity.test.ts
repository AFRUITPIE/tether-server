import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorktree } from '../src/server/fsApi.ts';
import { Itemizer, userContentToInputs } from '../src/threads/itemizer.ts';

describe('documents', () => {
  test('a PDF in history is named, not carried', () => {
    const inputs = userContentToInputs([
      { type: 'text', text: 'Summarize this' },
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0x' }, title: 'spec.pdf' },
    ]);
    expect(inputs).toEqual([
      { type: 'text', text: 'Summarize this' },
      { type: 'document', mediaType: 'application/pdf', name: 'spec.pdf' },
    ]);
  });
});

describe('messages from another session', () => {
  test('carry the sender name and session', () => {
    const iz = new Itemizer(() => 1, true);
    iz.ingest({
      type: 'user',
      uuid: 'peer-1',
      parent_tool_use_id: null,
      origin: { kind: 'peer', from: 'uds:/tmp/x.sock', name: 'Refactor auth', fromSession: 'local_1234' },
      message: { role: 'user', content: [{ type: 'text', text: 'I finished the auth refactor.' }] },
    });
    const item = iz.snapshot().items.find((i) => i.id === 'peer-1') as any;
    expect(item.origin).toBe('peer');
    expect(item.originName).toBe('Refactor auth');
    expect(item.originSession).toBe('local_1234');
  });
});

describe('worktrees', () => {
  test('a worktree lands under .claude/worktrees on its own branch, excluded from the checkout', async () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'tether-wt-')));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'first');

    const path = await createWorktree(repo, 'tether-abc');

    expect(path).toBe(join(repo, '.claude', 'worktrees', 'tether-abc'));
    expect(existsSync(join(path, '.git'))).toBe(true);
    expect(git('branch', '--list', 'claude/tether-abc').trim()).toContain('claude/tether-abc');
    expect(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8')).toContain('.claude/worktrees/');
    expect(git('status', '--porcelain').trim()).toBe('');
  });

  test('outside a repository it says so', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tether-nowt-'));
    await expect(createWorktree(dir, 'x')).rejects.toThrow("isn't in a git repository");
  });
});
