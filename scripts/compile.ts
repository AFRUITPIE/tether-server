// Builds standalone tether binaries (no Node/Bun needed on the host) into dist/.
import { $ } from 'bun';
import { mkdirSync } from 'node:fs';

const targets = (process.env.TETHER_TARGETS ?? 'darwin-arm64,darwin-x64,linux-x64,linux-arm64').split(',');
const pkg = await Bun.file(new URL('../package.json', import.meta.url)).json();
mkdirSync('dist', { recursive: true });
for (const t of targets) {
  const out = `dist/tether-${pkg.version}-${t}`;
  // The SDK's bundled platform `claude` binaries are never used: Tether always runs the host's own `claude`.
  await $`bun build src/cli.ts --compile --minify --sourcemap --target=bun-${t} --outfile ${out} --external '@anthropic-ai/claude-agent-sdk-*'`.quiet();
  const size = (Bun.file(out).size / 1e6).toFixed(1);
  console.log(`${out} (${size} MB)`);
}
