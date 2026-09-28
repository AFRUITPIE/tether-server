// Cuts a GitHub release for the current package.json version and attaches the compiled binaries,
// with the SHA256SUMS compile.ts writes beside them. Publishing the release publishes the same
// version to npm (.github/workflows/npm.yml), which is how hosts run it; the binaries are for a
// host without Node, which the app copies one to after checking it against the checksum it carries.
//
// The tag is the Tether version, not the Agent SDK version: the daemon decides whether to replace
// itself by comparing version strings, so that number has to move whenever Tether changes, even
// when the SDK it wraps has not. The SDK version is recorded in the notes instead, where it is
// traceable without being overloaded.
import { $ } from 'bun';
import { existsSync, readFileSync } from 'node:fs';

const pkg = await Bun.file(new URL('../package.json', import.meta.url)).json();
const version: string = pkg.version;
const sdk: string = pkg.dependencies['@anthropic-ai/claude-agent-sdk'];
const tag = `v${version}`;

if (await $`git status --porcelain`.text()) {
  console.error('Working tree is dirty; commit before releasing.');
  process.exit(1);
}

await $`bun run scripts/compile.ts`;

// The binaries SHA256SUMS lists, which are the ones compile.ts just built: a glob of dist/ would
// also take a dev build of this version (`tether-<version>-dev.…`).
const binaries = readFileSync('dist/SHA256SUMS', 'utf8')
  .trim()
  .split('\n')
  .map((line) => `dist/${line.split(/\s+/)[1]}`);
const assets = [...binaries, 'dist/SHA256SUMS'];
for (const a of assets) if (!existsSync(a)) throw new Error(`missing ${a}`);

const notes = `Tether server ${version}\n\nBuilt against Claude Agent SDK ${sdk}.`;
const exists = await $`gh release view ${tag}`.quiet().nothrow();
if (exists.exitCode === 0) {
  console.log(`${tag} exists; replacing its assets.`);
  await $`gh release upload ${tag} ${assets} --clobber`;
} else {
  await $`git tag -a ${tag} -m ${`Tether server ${version} (Agent SDK ${sdk})`}`.nothrow();
  await $`git push origin ${tag}`;
  await $`gh release create ${tag} ${assets} --title ${tag} --notes ${notes}`;
}
console.log(`Released ${tag} with ${binaries.length} binaries and SHA256SUMS (Agent SDK ${sdk}).`);
