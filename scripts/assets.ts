// The files a release carries beside its binaries: SHA256SUMS, and install.sh with the release's
// version baked in. compile.ts writes them for what it built; release.ts uploads what they list.
import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';

const PLACEHOLDER = '__TETHER_VERSION__';

/** scripts/install.sh, installing `version` unless the environment names another. */
export async function installScript(version: string): Promise<string> {
  const template = await Bun.file(new URL('install.sh', import.meta.url)).text();
  // Exactly one: a script that lost its placeholder would install whatever TETHER_VERSION says, or nothing.
  if (template.split(PLACEHOLDER).length !== 2) throw new Error(`install.sh must name ${PLACEHOLDER} exactly once`);
  return template.replace(PLACEHOLDER, version);
}

/** One `<sha256>  <file name>` line per file, as `sha256sum` writes and `sha256sum -c` reads them. */
export async function checksums(paths: string[]): Promise<string> {
  const lines = await Promise.all(
    paths.map(async (p) => {
      const hash = createHash('sha256');
      for await (const chunk of Bun.file(p).stream()) hash.update(chunk);
      return `${hash.digest('hex')}  ${basename(p)}\n`;
    }),
  );
  return lines.join('');
}

/** Writes `<dir>/SHA256SUMS` for `binaries` and `<dir>/install.sh` for `version`. */
export async function writeReleaseFiles(dir: string, version: string, binaries: string[]) {
  await Bun.write(join(dir, 'SHA256SUMS'), await checksums(binaries));
  await Bun.write(join(dir, 'install.sh'), await installScript(version));
}
