import { execFile } from 'node:child_process';
import { open, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
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
