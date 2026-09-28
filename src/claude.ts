import { execFileSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';

export type ClaudeBinary = { path: string; version: string };

let cached: ClaudeBinary | undefined;

/** The first `claude` on PATH. Tether is launched from a login shell so PATH matches the user's terminal. */
export function resolveClaude(): ClaudeBinary {
  if (cached) return cached;
  const override = process.env.TETHER_CLAUDE_PATH;
  const path = override || which('claude') || loginShellWhich();
  if (!path) throw new Error('`claude` not found on PATH. Install Claude Code on this host.');
  let version = 'unknown';
  try {
    version = execFileSync(path, ['--version'], { timeout: 15_000 }).toString().trim().split(/\s+/)[0] ?? version;
  } catch {}
  cached = { path, version };
  return cached;
}

/** The first executable of that name on PATH, as `which` finds it: the same under Bun and Node. */
function which(name: string): string | undefined {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
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
