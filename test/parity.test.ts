import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Itemizer, userContentToInputs } from '../src/threads/itemizer.ts';

describe('documents', () => {
  test('a PDF in history is named, not carried', () => {
    const inputs = userContentToInputs([
      { type: 'text', text: 'Summarize this' },
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0x' }, title: 'spec.pdf' },
    ]);
    expect(inputs).toEqual([
      { type: 'text', text: 'Summarize this' },
      { type: 'document', mediaType: 'application/pdf', name: 'spec.pdf' },
    ]);
  });
});

describe('messages from another session', () => {
  test('carry the sender name and session', () => {
    const iz = new Itemizer(() => 1, true);
    iz.ingest({
      type: 'user',
      uuid: 'peer-1',
      parent_tool_use_id: null,
      origin: { kind: 'peer', from: 'uds:/tmp/x.sock', name: 'Refactor auth', fromSession: 'local_1234' },
      message: { role: 'user', content: [{ type: 'text', text: 'I finished the auth refactor.' }] },
    });
    const item = iz.snapshot().items.find((i) => i.id === 'peer-1') as any;
    expect(item.origin).toBe('peer');
    expect(item.originName).toBe('Refactor auth');
    expect(item.originSession).toBe('local_1234');
  });
});

describe('plugins', () => {
  const fake = (script: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'tether-claude-'));
    const path = join(dir, 'claude');
    require('node:fs').writeFileSync(path, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    return path;
  };

  test('lists installed and available plugins', async () => {
    const { listPlugins } = await import('../src/server/plugins.ts');
    const claude = fake(`echo '{"installed":[{"id":"a@m","enabled":true}],"available":[{"pluginId":"b@m","name":"b"}]}'`);
    const r = await listPlugins(claude, undefined, {});
    expect(r.installed).toEqual([{ id: 'a@m', enabled: true }]);
    expect(r.available).toEqual([{ pluginId: 'b@m', name: 'b' }]);
  });

  test("a failed install says the CLI's reason", async () => {
    const { installPlugin } = await import('../src/server/plugins.ts');
    const claude = fake(`echo '{"error":"Plugin nope@m not found"}'; exit 1`);
    await expect(installPlugin(claude, 'nope@m', 'user', undefined, {})).rejects.toThrow('Plugin nope@m not found');
  });
});
