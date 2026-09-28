import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checksums, sha256File } from '../scripts/assets.ts';

describe('SHA256SUMS', () => {
  test('one line per binary, which sha256sum or shasum checks', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tether-sums-'));
    const files = ['tether-0.5.7-darwin-arm64', 'tether-0.5.7-linux-x64'].map((name, i) => {
      const path = join(dir, name);
      writeFileSync(path, `binary ${i}`);
      return path;
    });
    const sums = await checksums(files);
    expect(sums.trimEnd().split('\n')).toHaveLength(2);
    expect(sums).toContain(`${await sha256File(files[0]!)}  tether-0.5.7-darwin-arm64\n`);
    writeFileSync(join(dir, 'SHA256SUMS'), sums);
    const check = process.platform === 'darwin' ? ['shasum', ['-a', '256', '-c', 'SHA256SUMS']] as const : ['sha256sum', ['-c', 'SHA256SUMS']] as const;
    expect(execFileSync(check[0], [...check[1]], { cwd: dir }).toString()).toContain('OK');
  });
});
