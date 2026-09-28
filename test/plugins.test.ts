import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { Connection, ErrorCodes } from '../src/rpc/connection.ts';
import { installPlugin, listPlugins, setPluginEnabled, uninstallPlugin } from '../src/server/plugins.ts';
import { ClientSession } from '../src/server/session.ts';
import { ThreadManager } from '../src/threads/ThreadManager.ts';

/** A stand-in `claude` running `script`, which writes the arguments it was given to `args`. */
function fake(script: string) {
  const dir = mkdtempSync(join(tmpdir(), 'tether-claude-'));
  const path = join(dir, 'claude');
  const args = join(dir, 'args');
  writeFileSync(path, `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > '${args}'\n${script}\n`, { mode: 0o755 });
  return { path, args: () => readFileSync(args, 'utf8').trim().split('\n') };
}

describe('plugins', () => {
  test('lists installed and available plugins', async () => {
    const claude = fake(`echo '{"installed":[{"id":"a@m","enabled":true}],"available":[{"pluginId":"b@m","name":"b"}]}'`);
    const r = await listPlugins(claude.path, undefined, {});
    expect(r.installed).toEqual([{ id: 'a@m', enabled: true }]);
    expect(r.available).toEqual([{ pluginId: 'b@m', name: 'b' }]);
    expect(claude.args()).toEqual(['plugin', 'list', '--json', '--available']);
  });

  test("a failed install says the CLI's reason", async () => {
    const claude = fake(`echo '{"error":"Plugin nope@m not found"}'; exit 1`);
    await expect(installPlugin(claude.path, 'nope@m', 'user', undefined, {})).rejects.toThrow('Plugin nope@m not found');
  });

  test('a command that stops to ask reads end-of-file instead of waiting', async () => {
    // `cat` reads stdin until it ends: forever, were stdin an open pipe.
    const claude = fake(`cat; echo '{"installed":[],"available":[]}'`);
    expect(await listPlugins(claude.path, undefined, {})).toEqual({ installed: [], available: [] });
  }, 5_000);

  test('a plugin id is never read as an option', async () => {
    const claude = fake('true');
    await installPlugin(claude.path, '--yes', 'project', undefined, {});
    expect(claude.args()).toEqual(['plugin', 'install', '--scope', 'project', '--json', '--', '--yes']);
    await uninstallPlugin(claude.path, '-y', undefined, undefined, {});
    expect(claude.args()).toEqual(['plugin', 'uninstall', '--', '-y']);
    await setPluginEnabled(claude.path, '-x@m', false, 'local', undefined, {});
    expect(claude.args()).toEqual(['plugin', 'disable', '--scope', 'local', '--', '-x@m']);
  });

  test('a Claude Code too old to list plugins as JSON is said to be', async () => {
    await expect(listPlugins(fake(`echo 'Installed plugins:'`).path, undefined, {})).rejects.toThrow('newer Claude Code');
    await expect(listPlugins(fake(`echo "error: unknown option '--available'" >&2; exit 1`).path, undefined, {})).rejects.toThrow(
      'newer Claude Code',
    );
  });

  test('a scope other than user, project or local is refused', async () => {
    const toServer = new PassThrough();
    const toClient = new PassThrough();
    new ClientSession(new Connection(toServer, toClient, 'server'), new ThreadManager({ path: '/usr/bin/false', version: '0' }), 'stdio').start();
    const client = new Connection(toClient, toServer, 'client');
    client.start({ onRequest: async () => ({}), onNotification: () => {}, onClose: () => {} });
    await client.request('initialize', { clientInfo: { name: 'test', version: '0' } }, 'c1');
    for (const [method, params] of [
      ['plugin/uninstall', { pluginId: 'a@m', scope: 'everywhere' }],
      ['plugin/setEnabled', { pluginId: 'a@m', enabled: true, scope: '--help' }],
    ] as const) {
      const e: any = await client.request(method, params, `c-${method}`).catch((e) => e);
      expect(e.code).toBe(ErrorCodes.invalidParams);
    }
  });
});
