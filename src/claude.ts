import { execFile } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** `path` is empty when there's no `claude` to be found: a thread then says so as it starts. */
export type ClaudeBinary = { path: string; version: string };

const cache = new Map<string, Promise<ClaudeBinary>>();

/**
 * `claude` as `env` finds it: its `TETHER_CLAUDE_PATH`, else the first `claude` on its PATH, else
 * the login shell's. Each client resolves it with the environment the app sends for its host
 * (Settings ▸ Hosts ▸ Environment) over the daemon's own, so a wrapper the daemon's PATH misses can
 * be named there, and takes effect without restarting the daemon. Cached per path and PATH; not
 * found is looked for again next time. Asynchronous: a wrapper slow to say its version held up
 * every client of the daemon while it did.
 */
export function resolveClaude(env: Record<string, string | undefined> = process.env): Promise<ClaudeBinary> {
  const key = `${env.TETHER_CLAUDE_PATH ?? ''}\0${env.PATH ?? ''}`;
  let found = cache.get(key);
  if (!found) {
    found = lookUp(env);
    cache.set(key, found);
    void found.then((c) => c.path || cache.delete(key));
  }
  return found;
}

async function lookUp(env: Record<string, string | undefined>): Promise<ClaudeBinary> {
  // One named outright is the one: if it isn't there, that's said rather than another used.
  const home = env.HOME || homedir();
  const named = env.TETHER_CLAUDE_PATH ? expandHome(env.TETHER_CLAUDE_PATH, home) : undefined;
  const path = named !== undefined ? (isExecutable(named) ? named : '') : which('claude', env.PATH, home) || (await loginShellWhich());
  if (!path) return { path: '', version: 'not found' };
  let version = 'unknown';
  try {
    const { stdout } = await run(path, ['--version'], { timeout: 15_000, env: { ...process.env, ...env } as NodeJS.ProcessEnv });
    // The version itself, past anything a wrapper prints first.
    version = stdout.match(/\d+\.\d+\.\d+\S*/)?.[0] ?? (stdout.trim().split('\n')[0] || version);
  } catch {}
  return { path, version };
}

/** The first executable file of that name on `path`, as `which` finds it: the same under Bun and Node. */
function which(name: string, path: string | undefined, home: string): string | undefined {
  for (const entry of (path ?? '').split(delimiter)) {
    const dir = expandHome(entry, home);
    // A relative entry would be looked up again from each thread's own directory.
    if (!dir || !isAbsolute(dir)) continue;
    const candidate = join(dir, name);
    if (isExecutable(candidate)) return candidate;
  }
  return undefined;
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function expandHome(path: string, home: string): string {
  return path === '~' ? home : path.startsWith('~/') ? join(home, path.slice(2)) : path;
}

async function loginShellWhich(): Promise<string | undefined> {
  try {
    const { stdout } = await run(process.env.SHELL || '/bin/sh', ['-lc', 'command -v claude'], { timeout: 15_000 });
    return stdout.trim().split('\n').pop() || undefined;
  } catch {
    return undefined;
  }
}
