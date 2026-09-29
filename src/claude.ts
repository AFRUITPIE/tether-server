import { execFileSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';

export type ClaudeBinary = { path: string; version: string };

const cache = new Map<string, ClaudeBinary>();

/**
 * `claude` as `env` finds it: its `TETHER_CLAUDE_PATH`, else the first `claude` on its PATH, else
 * the login shell's. Each client resolves it with the environment the app sends for its host
 * (Settings ▸ Hosts ▸ Environment) over the daemon's own, so a wrapper the daemon's PATH misses can
 * be named there, and takes effect without restarting the daemon. Cached per path and PATH.
 */
export function resolveClaude(env: Record<string, string | undefined> = process.env): ClaudeBinary {
  const key = `${env.TETHER_CLAUDE_PATH ?? ''}\0${env.PATH ?? ''}`;
  const known = cache.get(key);
  if (known) return known;
  const path = env.TETHER_CLAUDE_PATH || which('claude', env.PATH) || loginShellWhich();
  if (!path) throw new Error('`claude` not found on PATH. Install Claude Code on this host.');
  let version = 'unknown';
  try {
    version = execFileSync(path, ['--version'], { timeout: 15_000, env: { ...process.env, ...env } as NodeJS.ProcessEnv })
      .toString().trim().split(/\s+/)[0] ?? version;
  } catch {}
  const found = { path, version };
  cache.set(key, found);
  return found;
}

/** The first executable of that name on `path`, as `which` finds it: the same under Bun and Node. */
function which(name: string, path: string | undefined): string | undefined {
  for (const dir of (path ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  return undefined;
}

function loginShellWhich(): string | undefined {
  try {
    const shell = process.env.SHELL || '/bin/sh';
    const out = execFileSync(shell, ['-lc', 'command -v claude'], { timeout: 15_000 }).toString().trim();
    return out.split('\n').pop() || undefined;
  } catch {
    return undefined;
  }
}
