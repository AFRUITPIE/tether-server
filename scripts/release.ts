// Cuts a GitHub release for the current package.json version. Publishing it publishes the same
// version to npm (.github/workflows/npm.yml), which is how hosts run it: `npx tether-server@<version>`.
//
// The tag is the Tether version, not the Agent SDK version: the daemon decides whether to replace
// itself by comparing version strings, so that number has to move whenever Tether changes, even
// when the SDK it wraps has not. The SDK version is recorded in the notes instead, where it is
// traceable without being overloaded.
import { $ } from 'bun';

const pkg = await Bun.file(new URL('../package.json', import.meta.url)).json();
const version: string = pkg.version;
const sdk: string = pkg.dependencies['@anthropic-ai/claude-agent-sdk'];
const tag = `v${version}`;

if (await $`git status --porcelain`.text()) {
  console.error('Working tree is dirty; commit before releasing.');
  process.exit(1);
}

await $`git tag -a ${tag} -m ${`Tether server ${version} (Agent SDK ${sdk})`}`;
await $`git push origin ${tag}`;
await $`gh release create ${tag} --title ${tag} --notes ${`Tether server ${version}\n\nBuilt against Claude Agent SDK ${sdk}.`}`;
console.log(`Released ${tag} (Agent SDK ${sdk}); npm publishes it from the workflow.`);
