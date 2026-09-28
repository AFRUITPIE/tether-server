// SHA256SUMS, the file a release carries beside its binaries. compile.ts writes it for what it
// built; release.ts uploads what it lists. The app carries each release's checksums itself.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { basename, join } from 'node:path';

/** A file's SHA-256, in hex, as `sha256sum` prints it. */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

/** One `<sha256>  <file name>` line per file, as `sha256sum` writes and `sha256sum -c` reads them. */
export async function checksums(paths: string[]): Promise<string> {
  const lines = await Promise.all(paths.map(async (p) => `${await sha256File(p)}  ${basename(p)}\n`));
  return lines.join('');
}

/** Writes `<dir>/SHA256SUMS` for `binaries`. */
export async function writeReleaseFiles(dir: string, binaries: string[]) {
  await Bun.write(join(dir, 'SHA256SUMS'), await checksums(binaries));
}
