import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ErrorCodes } from '../src/rpc/connection.ts';
import { createWorktree, removeWorktree, worktreeName } from '../src/server/fsApi.ts';

// The test's own git commands ignore the user's configuration (signing, hooks).
const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
};
const gitIn = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: gitEnv });

/** A repository with one commit; `tmp` is its path as tmpdir() spells it (on macOS, through /var). */
function repository() {
  const tmp = mkdtempSync(join(tmpdir(), 'tether-wt-'));
  const repo = realpathSync(tmp);
  gitIn(repo, 'init', '-q', '-b', 'main');
  gitIn(repo, 'commit', '-q', '--allow-empty', '-m', 'first');
  const branches = () => gitIn(repo, 'branch', '--list', '--format=%(refname:short)').trim().split('\n').filter(Boolean);
  return { tmp, repo, git: (...args: string[]) => gitIn(repo, ...args), branches };
}

const name = (n: number) => worktreeName(`${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`);
const code = (p: Promise<unknown>) => p.then(() => 'resolved', (e) => e.code as number);

describe('creating a worktree', () => {
  test('lands under .claude/worktrees on its own branch, excluded from the checkout', async () => {
    const { repo, git, branches } = repository();
    const { path, cwd } = await createWorktree(repo, name(1));
    expect(path).toBe(join(repo, '.claude', 'worktrees', name(1)));
    expect(cwd).toBe(path);
    expect(existsSync(join(path, '.git'))).toBe(true);
    expect(branches()).toContain(`claude/${name(1)}`);
    expect(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8')).toContain('.claude/worktrees/');
    expect(git('status', '--porcelain').trim()).toBe('');
  });

  test("started in a subfolder, the thread works in the new worktree's copy of it", async () => {
    const { repo, git } = repository();
    mkdirSync(join(repo, 'packages', 'app'), { recursive: true });
    writeFileSync(join(repo, 'packages', 'app', 'index.ts'), '\n');
    mkdirSync(join(repo, 'scratch'));
    git('add', 'packages');
    git('commit', '-q', '-m', 'app');

    const { path, cwd } = await createWorktree(join(repo, 'packages', 'app'), name(1));
    expect(cwd).toBe(join(path, 'packages', 'app'));
    expect(existsSync(join(cwd, 'index.ts'))).toBe(true);
    // A folder the new checkout doesn't have: its root instead.
    const other = await createWorktree(join(repo, 'scratch'), name(2));
    expect(other.cwd).toBe(other.path);
  });

  test('started inside a worktree, the new one goes beside it, from where that one is', async () => {
    const { repo, git } = repository();
    mkdirSync(join(repo, 'src'));
    writeFileSync(join(repo, 'src', 'a.ts'), '\n');
    git('add', 'src');
    git('commit', '-q', '-m', 'src');
    const first = await createWorktree(repo, name(1));
    gitIn(first.path, 'commit', '-q', '--allow-empty', '-m', 'work in the first');

    const second = await createWorktree(join(first.path, 'src'), name(2));
    expect(second.path).toBe(join(repo, '.claude', 'worktrees', name(2)));
    expect(second.cwd).toBe(join(second.path, 'src'));
    expect(gitIn(second.path, 'rev-parse', 'HEAD')).toBe(gitIn(first.path, 'rev-parse', 'HEAD'));
  });

  test('outside a repository it says so', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tether-nowt-'));
    await expect(createWorktree(dir, name(1))).rejects.toThrow("isn't in a git repository");
  });
});

describe('removing a worktree', () => {
  test('a clean one goes, with its branch', async () => {
    const { repo, branches } = repository();
    const { path } = await createWorktree(repo, name(1));
    await removeWorktree(path);
    expect(existsSync(path)).toBe(false);
    expect(branches()).toEqual(['main']);
  });

  test('uncommitted changes are kept unless forced', async () => {
    const { repo, branches } = repository();
    const { path } = await createWorktree(repo, name(1));
    writeFileSync(join(path, 'notes.txt'), 'hi\n');

    const e: any = await removeWorktree(path).catch((e) => e);
    expect(e.code).toBe(ErrorCodes.worktreeDirty);
    expect(e.message).toContain('uncommitted changes');
    expect(e.data).toEqual({ branch: `claude/${name(1)}`, uncommittedChanges: true, unmergedCommits: 0 });
    expect(existsSync(join(path, 'notes.txt'))).toBe(true);

    await removeWorktree(path, { force: true });
    expect(existsSync(path)).toBe(false);
    expect(branches()).toEqual(['main']);
  });

  test('commits merged nowhere else are kept unless discarded, and nothing is removed first', async () => {
    const { repo, branches, git } = repository();
    const { path } = await createWorktree(repo, name(1));
    gitIn(path, 'commit', '-q', '--allow-empty', '-m', 'work');

    const e: any = await removeWorktree(path, { force: true }).catch((e) => e);
    expect(e.code).toBe(ErrorCodes.worktreeUnmerged);
    expect(e.message).toContain("a commit that isn't merged");
    expect(e.data).toEqual({ branch: `claude/${name(1)}`, uncommittedChanges: false, unmergedCommits: 1 });
    expect(existsSync(path)).toBe(true);
    expect(branches()).toContain(`claude/${name(1)}`);

    await removeWorktree(path, { discardCommits: true });
    expect(existsSync(path)).toBe(false);
    expect(branches()).toEqual(['main']);
    expect(git('log', '--oneline').trim().split('\n')).toHaveLength(1);
  });

  test('both at once are reported together, so one question covers them', async () => {
    const { repo } = repository();
    const { path } = await createWorktree(repo, name(1));
    gitIn(path, 'commit', '-q', '--allow-empty', '-m', 'work');
    writeFileSync(join(path, 'notes.txt'), 'hi\n');
    const e: any = await removeWorktree(path).catch((e) => e);
    expect(e.code).toBe(ErrorCodes.worktreeDirty);
    expect(e.data).toMatchObject({ uncommittedChanges: true, unmergedCommits: 1 });
    await removeWorktree(path, { force: true, discardCommits: true });
    expect(existsSync(path)).toBe(false);
  });

  test('commits already merged into the checkout need no confirmation', async () => {
    const { repo, git, branches } = repository();
    const { path } = await createWorktree(repo, name(1));
    gitIn(path, 'commit', '-q', '--allow-empty', '-m', 'work');
    git('merge', '-q', '--ff-only', `claude/${name(1)}`);
    await removeWorktree(path);
    expect(existsSync(path)).toBe(false);
    expect(branches()).toEqual(['main']);
  });

  test('the path may be spelled through a symlink', async () => {
    const { tmp, repo } = repository();
    const { path } = await createWorktree(repo, name(1));
    await removeWorktree(join(tmp, '.claude', 'worktrees', name(1)));
    expect(existsSync(path)).toBe(false);
  });

  test('a branch kept once the folder is gone can still be discarded', async () => {
    const { repo, git, branches } = repository();
    const { path } = await createWorktree(repo, name(1));
    gitIn(path, 'commit', '-q', '--allow-empty', '-m', 'work');
    git('worktree', 'remove', path);
    expect(await code(removeWorktree(path))).toBe(ErrorCodes.worktreeUnmerged);
    await removeWorktree(path, { discardCommits: true });
    expect(branches()).toEqual(['main']);
    // And once both are gone, there's nothing left to do.
    await removeWorktree(path);
  });

  test("Claude Desktop's worktrees, and folders git doesn't know, are refused and left alone", async () => {
    const { repo, git } = repository();
    const desktop = join(repo, '.claude', 'worktrees', 'brave-otter');
    git('worktree', 'add', '-q', '-b', 'claude/brave-otter', desktop);
    expect(await code(removeWorktree(desktop, { force: true, discardCommits: true }))).toBe(ErrorCodes.invalidParams);
    expect(existsSync(desktop)).toBe(true);

    const stray = join(repo, '.claude', 'worktrees', name(2));
    mkdirSync(stray, { recursive: true });
    writeFileSync(join(stray, 'keep.txt'), 'mine\n');
    expect(await code(removeWorktree(stray, { force: true, discardCommits: true }))).toBe(ErrorCodes.invalidParams);
    expect(existsSync(join(stray, 'keep.txt'))).toBe(true);
  });

  test('only the worktree folder itself qualifies, however the path is spelled', async () => {
    const { repo } = repository();
    const { path } = await createWorktree(repo, name(1));
    mkdirSync(join(path, 'sub'));
    for (const p of [
      join(path, 'sub'),
      `${path}/../../..`,
      `${path}/..`,
      join(repo, 'nested', '.claude', 'worktrees', name(1)),
    ])
      expect(await code(removeWorktree(p, { force: true, discardCommits: true }))).toBe(ErrorCodes.invalidParams);
    expect(existsSync(path)).toBe(true);
    // `..` is resolved first: this one names the worktree itself.
    await removeWorktree(`${path}/sub/..`);
    expect(existsSync(path)).toBe(false);
  });
});

describe('a thread in a new worktree', () => {
  test('that fails to start leaves neither the worktree nor its branch behind', async () => {
    const { ThreadManager } = await import('../src/threads/ThreadManager.ts');
    const { repo, branches } = repository();
    // Not Claude Code: it exits at once, so the thread fails to start.
    const mgr = new ThreadManager({ path: '/usr/bin/false', version: '0' });
    await expect(mgr.start({ cwd: repo, worktree: true }, {})).rejects.toThrow();
    mgr.shutdown();
    const worktrees = join(repo, '.claude', 'worktrees');
    expect(existsSync(worktrees) ? readdirSync(worktrees) : []).toEqual([]);
    expect(branches()).toEqual(['main']);
    expect(gitIn(repo, 'worktree', 'list').trim().split('\n')).toHaveLength(1);
  });
});
