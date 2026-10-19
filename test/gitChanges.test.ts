import { afterAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitChanges, MAX_UNTRACKED_FILES } from '../src/server/fsApi.ts';
import { parseUnifiedDiff } from '../src/server/diff.ts';

const tmp = mkdtempSync(join(tmpdir(), 'tether-changes-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function repo(name: string) {
  const dir = join(tmp, name);
  mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  return { dir, git, write: (path: string, text: string | Buffer) => writeFileSync(join(dir, path), text) };
}

describe('git/changes', () => {
  test('staged and unstaged changes against HEAD, renames, deletions, binaries and new files, sorted', async () => {
    const r = repo('work');
    mkdirSync(join(r.dir, 'src'));
    r.write('src/a.txt', 'one\ntwo\nthree\n');
    r.write('b.txt', 'keep\n');
    r.write('gone.txt', 'bye\n');
    r.write('old name.txt', 'moved\nunchanged\nlines\n');
    r.write('img.bin', Buffer.from([0, 1, 2, 3]));
    r.git('add', '-A');
    r.git('commit', '-qm', 'first');
    // Staged, then changed again unstaged: one diff against HEAD.
    r.write('src/a.txt', 'one\nTWO\nthree\n');
    r.git('add', 'src/a.txt');
    r.write('src/a.txt', 'one\nTWO\nthree\nfour\n');
    unlinkSync(join(r.dir, 'gone.txt'));
    renameSync(join(r.dir, 'old name.txt'), join(r.dir, 'new name.txt'));
    r.git('add', '-A', 'old name.txt', 'new name.txt');
    r.write('img.bin', Buffer.from([0, 9, 9]));
    r.write('fresh.md', '# New\n\nbody\n');
    const c = await gitChanges(join(r.dir, 'src'));
    expect(c.isRepo).toBe(true);
    expect(c.branch).toBe('main');
    expect(c.omittedFiles).toBe(0);
    expect(c.files.map((f) => [f.path, f.status, f.added, f.removed])).toEqual([
      ['fresh.md', 'untracked', 3, 0],
      ['gone.txt', 'deleted', 0, 1],
      ['img.bin', 'modified', 0, 0],
      ['new name.txt', 'renamed', 0, 0],
      ['src/a.txt', 'modified', 2, 1],
    ]);
    const a = c.files.find((f) => f.path === 'src/a.txt')!;
    expect(a.hunks).toEqual([{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 4, lines: [' one', '-two', '+TWO', ' three', '+four'] }]);
    expect(a.truncatedLines).toBe(0);
    expect(c.files.find((f) => f.path === 'img.bin')!.binary).toBe(true);
    expect(c.files.find((f) => f.path === 'new name.txt')!.oldPath).toBe('old name.txt');
    expect(c.files.find((f) => f.path === 'fresh.md')!.hunks[0]).toEqual({ oldStart: 0, oldLines: 0, newStart: 1, newLines: 3, lines: ['+# New', '+', '+body'] });
    expect(c.root?.endsWith('work')).toBe(true);
  });

  test('before the first commit, everything is new; past 200 untracked files the rest are counted', async () => {
    const r = repo('fresh');
    r.write('staged.txt', 'a\nb\n');
    r.git('add', 'staged.txt');
    for (let i = 0; i < MAX_UNTRACKED_FILES + 3; i++) r.write(`f${String(i).padStart(3, '0')}.txt`, `${i}\n`);
    const c = await gitChanges(r.dir);
    expect(c.files.find((f) => f.path === 'staged.txt')).toMatchObject({ status: 'added', added: 2 });
    expect(c.files.filter((f) => f.status === 'untracked')).toHaveLength(MAX_UNTRACKED_FILES);
    expect(c.omittedFiles).toBe(3);
  });

  test('not a repository', async () => {
    const dir = join(tmp, 'plain');
    mkdirSync(dir);
    expect(await gitChanges(dir)).toEqual({ isRepo: false, files: [], omittedFiles: 0 });
  });
});

describe('unified diffs', () => {
  test('quoted paths, hunks with a section heading, and a missing final newline', () => {
    const files = parseUnifiedDiff(
      [
        'diff --git "a/caf\\303\\251 \\"x\\".txt" "b/caf\\303\\251 \\"x\\".txt"',
        'index 1..2 100644',
        '--- "a/caf\\303\\251 \\"x\\".txt"',
        '+++ "b/caf\\303\\251 \\"x\\".txt"',
        '@@ -3 +3,2 @@ func body()',
        '-old',
        '+new',
        '+more',
        '\\ No newline at end of file',
        '',
      ].join('\n'),
    );
    expect(files).toEqual([
      {
        path: 'café "x".txt',
        status: 'modified',
        binary: false,
        hunks: [{ oldStart: 3, oldLines: 1, newStart: 3, newLines: 2, lines: ['-old', '+new', '+more', '\\ No newline at end of file'], header: 'func body()' }],
      },
    ]);
  });
});
