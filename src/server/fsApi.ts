import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { ErrorCodes, RpcError } from '../rpc/connection.ts';

const run = promisify(execFile);

function expand(p: string) {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : resolve(p);
}

export async function list(path: string, showHidden = false) {
  const dir = expand(path);
  const dirents = await readdir(dir, { withFileTypes: true }).catch((e) => {
    throw new RpcError(ErrorCodes.invalidParams, e.message);
  });
  const entries = await Promise.all(
    dirents
      .filter((d) => showHidden || !d.name.startsWith('.'))
      .map(async (d) => {
        const full = join(dir, d.name);
        const s = await stat(full).catch(() => undefined);
        return { name: d.name, path: full, isDirectory: s?.isDirectory() ?? d.isDirectory(), size: s?.size ?? 0 };
      }),
  );
  entries.sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name));
  return { entries };
}

export async function read(path: string, maxBytes = 1_000_000) {
  const file = expand(path);
  const fh = await open(file, 'r').catch((e) => {
    throw new RpcError(ErrorCodes.invalidParams, e.message);
  });
  try {
    const size = (await fh.stat()).size;
    const buf = Buffer.alloc(Math.min(size, maxBytes));
    await fh.read(buf, 0, buf.length, 0);
    const binary = buf.subarray(0, 8000).includes(0);
    return {
      content: binary ? buf.toString('base64') : buf.toString('utf8'),
      encoding: binary ? ('base64' as const) : ('utf-8' as const),
      truncated: size > maxBytes,
    };
  } finally {
    await fh.close();
  }
}

/** Fuzzy path search for @-mentions. Uses git ls-files (respects .gitignore) with a readdir fallback. */
export async function search(cwd: string, q: string, limit = 50) {
  const root = expand(cwd);
  let files: string[];
  try {
    const { stdout } = await run('git', ['ls-files', '-co', '--exclude-standard'], { cwd: root, maxBuffer: 64 << 20 });
    files = stdout.split('\n').filter(Boolean);
  } catch {
    files = await walk(root, '', 20_000);
  }
  const dirs = new Set<string>();
  for (const f of files) {
    const parts = f.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/') + '/');
  }
  const candidates = [...dirs, ...files];
  const needle = q.toLowerCase();
  const scored = candidates
    .map((p) => ({ p, s: fuzzyScore(p.toLowerCase(), needle) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.p.length - b.p.length);
  return { paths: scored.slice(0, limit).map((x) => x.p) };
}

function fuzzyScore(hay: string, needle: string): number {
  if (!needle) return 1;
  const base = hay.slice(hay.lastIndexOf('/', hay.length - 2) + 1);
  if (base.startsWith(needle)) return 1000 - hay.length;
  if (hay.includes(needle)) return 500 - hay.length;
  let i = 0;
  let score = 0;
  for (const ch of hay) {
    if (ch === needle[i]) {
      i++;
      score += 1;
      if (i === needle.length) return 100 + score - hay.length / 100;
    }
  }
  return 0;
}

async function walk(root: string, rel: string, cap: number, out: string[] = []): Promise<string[]> {
  if (out.length >= cap) return out;
  const ents = await readdir(join(root, rel), { withFileTypes: true }).catch(() => []);
  for (const e of ents) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) await walk(root, p, cap, out);
    else out.push(p);
    if (out.length >= cap) break;
  }
  return out;
}

export async function gitStatus(cwd: string) {
  try {
    const { stdout } = await run('git', ['status', '--porcelain=v1', '-b'], { cwd: expand(cwd) });
    const lines = stdout.split('\n').filter(Boolean);
    const head = lines[0]?.startsWith('## ') ? lines.shift()!.slice(3) : undefined;
    const branch = head?.split('...')[0];
    return {
      isRepo: true,
      ...(branch ? { branch } : {}),
      files: lines.map((l) => ({ status: l.slice(0, 2).trim(), path: l.slice(3) })),
    };
  } catch {
    return { isRepo: false, files: [] };
  }
}

export async function gitDiff(cwd: string, path?: string, staged?: boolean) {
  const args = ['diff', '--no-color', ...(staged ? ['--cached'] : []), ...(path ? ['--', path] : [])];
  try {
    const { stdout } = await run('git', args, { cwd: expand(cwd), maxBuffer: 64 << 20 });
    return { diff: stdout };
  } catch (e) {
    throw new RpcError(ErrorCodes.invalidParams, (e as Error).message);
  }
}

/**
 * A new git worktree of `cwd`'s repository, where the desktop app keeps them
 * (`<repo>/.claude/worktrees/<name>`), on a branch of its own off the current HEAD. The folder is
 * excluded locally (`.git/info/exclude`) so the main checkout doesn't list it as untracked.
 *
 * Started from inside a worktree, the new one goes beside it in the main checkout rather than
 * inside it, and branches from that worktree's HEAD. `cwd` is the new worktree's counterpart of the
 * folder started from (its root when that folder isn't in the new checkout, say an ignored one).
 */
export async function createWorktree(cwd: string, name: string): Promise<{ path: string; cwd: string }> {
  const dir = expand(cwd);
  let top: string;
  let prefix: string;
  try {
    const [t = '', p = ''] = (await git(['rev-parse', '--show-toplevel', '--show-prefix'], dir)).stdout.split('\n');
    top = t.trim();
    prefix = p.trim();
  } catch {
    throw new RpcError(ErrorCodes.invalidParams, `${cwd} isn't in a git repository, so it can't have a worktree`);
  }
  const main = await mainCheckout(top);
  const path = join(main, '.claude', 'worktrees', name);
  try {
    await git(['worktree', 'add', '-b', `claude/${name}`, path, 'HEAD'], top);
  } catch (e) {
    throw new RpcError(ErrorCodes.invalidParams, `Couldn't create a worktree: ${gitMessage(e)}`);
  }
  try {
    const common = (await git(['rev-parse', '--git-common-dir'], main)).stdout.trim();
    const exclude = resolve(main, common, 'info', 'exclude');
    const { readFile, appendFile, mkdir } = await import('node:fs/promises');
    const current = await readFile(exclude, 'utf8').catch(() => '');
    if (!current.split('\n').includes('.claude/worktrees/')) {
      await mkdir(resolve(exclude, '..'), { recursive: true });
      await appendFile(exclude, `${current && !current.endsWith('\n') ? '\n' : ''}.claude/worktrees/\n`);
    }
  } catch {
    // Only tidiness: the worktree itself is made.
  }
  const sub = prefix ? join(path, prefix.replace(/\/$/, '')) : path;
  return { path, cwd: existsSync(sub) ? sub : path };
}

/** The repository's main checkout, which git lists first; `top` itself for a bare repository. */
async function mainCheckout(top: string): Promise<string> {
  try {
    const [first, ...rest] = (await git(['worktree', 'list', '--porcelain'], top)).stdout.split('\n\n')[0]!.split('\n');
    if (first?.startsWith('worktree ') && !rest.includes('bare')) return first.slice('worktree '.length);
  } catch {}
  return top;
}

/** A worktree Tether makes is named `tether-<first 8 of the thread id>`, on a branch `claude/<name>`. */
export function worktreeName(threadId: string) {
  return `tether-${threadId.slice(0, 8)}`;
}
const TETHER_WORKTREE_NAME = /^tether-[0-9a-f]{8}$/;

/** What `git/removeWorktree` found, as the `data` of its `worktreeDirty` and `worktreeUnmerged` errors. */
export type WorktreeRemovalData = {
  branch: string;
  uncommittedChanges: boolean;
  /** Commits on the branch that neither its upstream nor the main checkout's HEAD has. */
  unmergedCommits: number;
  /** Set when the folder is gone already and only the branch was kept. */
  worktreeRemoved?: boolean;
};

/**
 * Removes a worktree `thread/start` made, and its `claude/…` branch. Only a registered worktree at
 * exactly `<checkout>/.claude/worktrees/tether-<id>` qualifies: Claude Desktop's worktrees there,
 * and anything else, are refused. Nothing is lost without being asked for: uncommitted changes need
 * `force` (else `worktreeDirty`), and a branch with commits merged nowhere else needs
 * `discardCommits` (else `worktreeUnmerged`, checked before anything is removed). Both errors carry
 * `WorktreeRemovalData`, so a client can ask once for both. Any other failure is reported.
 */
export async function removeWorktree(path: string, opts: { force?: boolean; discardCommits?: boolean } = {}) {
  const dir = expand(path);
  const name = basename(dir);
  const worktrees = dirname(dir);
  const root = dirname(dirname(worktrees));
  const notOurs = () => new RpcError(ErrorCodes.invalidParams, `${path} isn't a worktree Tether made`);
  if (!TETHER_WORKTREE_NAME.test(name) || basename(worktrees) !== 'worktrees' || basename(dirname(worktrees)) !== '.claude')
    throw notOurs();
  // The folder holding `.claude/worktrees` has to be the top of a checkout of the repository.
  let top: string;
  try {
    top = (await git(['rev-parse', '--show-toplevel'], root)).stdout.trim();
  } catch {
    throw notOurs();
  }
  if (canonical(top) !== canonical(root)) throw notOurs();

  let listed: string[];
  try {
    listed = parseWorktreeList((await git(['worktree', 'list', '--porcelain'], root)).stdout);
  } catch (e) {
    throw new RpcError(ErrorCodes.invalidRequest, `Couldn't list the repository's worktrees: ${gitMessage(e)}`);
  }
  const registered = listed.some((w) => canonical(w) === canonical(dir));
  const exists = existsSync(dir);
  // A folder there that git doesn't know as a worktree isn't one to delete.
  if (!registered && exists) throw notOurs();

  const branch = `claude/${name}`;
  const hasBranch = await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], root).then(
    () => true,
    () => false,
  );
  const uncommittedChanges = registered && exists ? await isDirty(dir) : false;
  const unmergedCommits = hasBranch ? await unmergedCount(branch, root) : 0;
  const data: WorktreeRemovalData = { branch, uncommittedChanges, unmergedCommits };
  if (uncommittedChanges && !opts.force)
    throw new RpcError(ErrorCodes.worktreeDirty, 'The worktree has uncommitted changes.', data);
  if (unmergedCommits > 0 && !opts.discardCommits)
    throw new RpcError(ErrorCodes.worktreeUnmerged, unmergedMessage(branch, unmergedCommits), data);

  if (registered) {
    try {
      if (exists) await git(['worktree', 'remove', ...(opts.force ? ['--force'] : []), dir], root);
      else await git(['worktree', 'prune'], root);
    } catch (e) {
      const message = gitMessage(e);
      if (/modified or untracked|contains modified/.test(message))
        throw new RpcError(ErrorCodes.worktreeDirty, 'The worktree has uncommitted changes.', { ...data, uncommittedChanges: true });
      throw new RpcError(ErrorCodes.invalidRequest, `Couldn't remove the worktree: ${message}`);
    }
  }
  if (!hasBranch) return;
  try {
    await git(['branch', opts.discardCommits ? '-D' : '-d', branch], root);
  } catch (e) {
    const message = gitMessage(e);
    // Merged by the check above, but not by git's own: the commits are kept, and so is the branch.
    if (/not fully merged/.test(message))
      throw new RpcError(
        ErrorCodes.worktreeUnmerged,
        `The worktree is removed, but its branch ${branch} has commits that aren't merged, so it's kept.`,
        { ...data, unmergedCommits: Math.max(unmergedCommits, 1), worktreeRemoved: true },
      );
    throw new RpcError(ErrorCodes.invalidRequest, `The worktree is removed, but its branch ${branch} couldn't be deleted: ${message}`);
  }
}

function unmergedMessage(branch: string, count: number) {
  return `Its branch ${branch} has ${count === 1 ? 'a commit' : `${count} commits`} that ${count === 1 ? "isn't" : "aren't"} merged.`;
}

/** Uncommitted changes, untracked files included, as `git worktree remove` counts them. */
async function isDirty(dir: string) {
  try {
    return (await git(['status', '--porcelain'], dir)).stdout.trim().length > 0;
  } catch {
    return true;
  }
}

/**
 * Commits `git branch -d` would refuse to lose: those on `branch` that its upstream (or, with none,
 * the checkout's HEAD) doesn't have. Unknown counts as one, so a failed check never deletes.
 */
async function unmergedCount(branch: string, root: string): Promise<number> {
  const upstream = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', `${branch}@{upstream}`], root).then(
    (r) => r.stdout.trim(),
    () => '',
  );
  try {
    const out = await git(['rev-list', '--count', `${upstream || 'HEAD'}..refs/heads/${branch}`], root);
    return Number(out.stdout.trim()) || 0;
  } catch {
    return 1;
  }
}

/** The paths `git worktree list --porcelain` reports. */
function parseWorktreeList(out: string): string[] {
  return out
    .split('\n')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice('worktree '.length));
}

/** A path with symlinks resolved as far as it exists (macOS's /var is /private/var). */
function canonical(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    const parent = dirname(p);
    return parent === p ? p : join(canonical(parent), basename(p));
  }
}

function git(args: string[], cwd: string) {
  return run('git', args, { cwd, maxBuffer: 64 << 20 });
}

/** What git said went wrong, without Node's "Command failed" preamble. */
function gitMessage(e: unknown): string {
  const err = e as Error & { stderr?: string };
  return err.stderr?.trim() || err.message;
}
