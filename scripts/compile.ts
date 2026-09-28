// Builds standalone tether binaries (no Node/Bun needed on the host) into dist/, with the
// SHA256SUMS a release carries beside them (scripts/assets.ts). Hosts with Node run the npm
// package instead (scripts/build-npm.ts).
//
// `--dev` stamps the version as `<package.json version>-dev.<time>` and replaces any earlier dev
// build. The daemon replaces itself only when a connecting client's version differs, so a local
// change has to carry a new version to reach the running daemon.
import { $ } from 'bun';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { writeReleaseFiles } from './assets.ts';

const targets = (process.env.TETHER_TARGETS ?? 'darwin-arm64,darwin-x64,linux-x64,linux-arm64').split(',');
const pkg = await Bun.file(new URL('../package.json', import.meta.url)).json();
const dev = process.argv.includes('--dev');
const version = dev ? `${pkg.version}-dev.${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}` : pkg.version;
mkdirSync('dist', { recursive: true });
if (dev) for (const f of readdirSync('dist')) if (f.includes('-dev.')) rmSync(`dist/${f}`);
const built: string[] = [];
for (const t of targets) {
  const out = `dist/tether-${version}-${t}`;
  // The SDK's bundled platform `claude` binaries are never used: Tether always runs the host's own `claude`.
  await $`bun build src/cli.ts --compile --minify --sourcemap --target=bun-${t} --outfile ${out} --external '@anthropic-ai/claude-agent-sdk-*' --define TETHER_BUILD_VERSION=${JSON.stringify(version)}`.quiet();
  const size = (Bun.file(out).size / 1e6).toFixed(1);
  console.log(`${out} (${size} MB)`);
  built.push(out);
}
await writeReleaseFiles('dist', built);
console.log('dist/SHA256SUMS');
