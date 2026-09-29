import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveClaude } from '../src/claude.ts';

/** A stand-in `claude` in a folder of its own that says which version it is. */
function standIn(version: string): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'tether-claude-'));
  const path = join(dir, 'claude');
  writeFileSync(path, `#!/bin/sh\necho "${version} (Claude Code)"\n`);
  chmodSync(path, 0o755);
  return { dir, path };
}

describe('resolveClaude', () => {
  test('finds the first claude on the PATH it is given', () => {
    const first = standIn('9.9.1');
    const second = standIn('9.9.2');
    expect(resolveClaude({ PATH: `${first.dir}:${second.dir}` })).toEqual({ path: first.path, version: '9.9.1' });
  });

  /** A host's environment can name a wrapper the daemon's own PATH doesn't have. */
  test('TETHER_CLAUDE_PATH names it outright', () => {
    const onPath = standIn('9.9.3');
    const wrapper = standIn('9.9.4');
    expect(resolveClaude({ PATH: onPath.dir, TETHER_CLAUDE_PATH: wrapper.path })).toEqual({ path: wrapper.path, version: '9.9.4' });
  });

  test('different environments resolve separately', () => {
    const a = standIn('9.9.5');
    const b = standIn('9.9.6');
    expect(resolveClaude({ PATH: a.dir }).version).toBe('9.9.5');
    expect(resolveClaude({ PATH: b.dir }).version).toBe('9.9.6');
  });
});
