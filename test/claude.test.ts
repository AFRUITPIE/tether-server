import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveClaude } from '../src/claude.ts';

/** A stand-in `claude` in a folder of its own that says which version it is, after `banner`. */
function standIn(version: string, banner = ''): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'tether-claude-'));
  const path = join(dir, 'claude');
  writeFileSync(path, `#!/bin/sh\n${banner ? `echo "${banner}"\n` : ''}echo "${version} (Claude Code)"\n`);
  chmodSync(path, 0o755);
  return { dir, path };
}

describe('resolveClaude', () => {
  test('finds the first claude on the PATH it is given', async () => {
    const first = standIn('9.9.1');
    const second = standIn('9.9.2');
    expect(await resolveClaude({ PATH: `${first.dir}:${second.dir}` })).toEqual({ path: first.path, version: '9.9.1' });
  });

  /** A host's environment can name a wrapper the daemon's own PATH doesn't have. */
  test('TETHER_CLAUDE_PATH names it outright', async () => {
    const onPath = standIn('9.9.3');
    const wrapper = standIn('9.9.4');
    expect(await resolveClaude({ PATH: onPath.dir, TETHER_CLAUDE_PATH: wrapper.path })).toEqual({ path: wrapper.path, version: '9.9.4' });
  });

  test('different environments resolve separately', async () => {
    const a = standIn('9.9.5');
    const b = standIn('9.9.6');
    expect((await resolveClaude({ PATH: a.dir })).version).toBe('9.9.5');
    expect((await resolveClaude({ PATH: b.dir })).version).toBe('9.9.6');
  });

  /** Said, rather than another claude used, or the daemon or `initialize` failing. */
  test('a TETHER_CLAUDE_PATH that is not there is not found', async () => {
    const onPath = standIn('9.9.7');
    expect(await resolveClaude({ PATH: onPath.dir, TETHER_CLAUDE_PATH: '/nonexistent/claude' })).toEqual({ path: '', version: 'not found' });
  });

  test('a directory named claude, and a relative PATH entry, are passed over', async () => {
    const shadow = mkdtempSync(join(tmpdir(), 'tether-shadow-'));
    mkdirSync(join(shadow, 'claude'));
    const real = standIn('9.9.8');
    expect(await resolveClaude({ PATH: `${shadow}:relative/bin:${real.dir}` })).toEqual({ path: real.path, version: '9.9.8' });
  });

  test('the version, past a banner a wrapper prints first', async () => {
    const wrapper = standIn('9.9.9', 'Using the company claude');
    expect((await resolveClaude({ TETHER_CLAUDE_PATH: wrapper.path })).version).toBe('9.9.9');
  });

  test('~ in TETHER_CLAUDE_PATH is the home directory', async () => {
    const home = mkdtempSync(join(tmpdir(), 'tether-home-'));
    const wrapper = join(home, 'claude');
    writeFileSync(wrapper, '#!/bin/sh\necho "9.9.10 (Claude Code)"\n');
    chmodSync(wrapper, 0o755);
    expect(await resolveClaude({ HOME: home, TETHER_CLAUDE_PATH: '~/claude' })).toEqual({ path: wrapper, version: '9.9.10' });
  });
});
