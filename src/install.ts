/**
 * `tether update [--version <version>]`: installs a release for this machine the way
 * scripts/install.sh does — the same environment, checks, files, progress lines and exit status —
 * without needing curl or a shell. Keep the two in step; test/install.test.ts runs both.
 *
 * The daemon isn't touched. The next `tether connect` through ~/.tether/bin/tether is the new
 * version, and hands the daemon over as any change of version does.
 */
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  createWriteStream,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const DOWNLOADS = 'https://github.com/AFRUITPIE/tether-server/releases/download';
const LATEST = 'https://api.github.com/repos/AFRUITPIE/tether-server/releases/latest';
const PLATFORMS = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'];
/** install.sh's `is_version`: versions end up in file names and URLs, so nothing else gets through. */
const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]*)?$/;
const USAGE = 'usage: tether update [--version <version>]';

type Env = Record<string, string | undefined>;

class InstallError extends Error {}

const say = (line: string) => process.stdout.write(`tether-install: ${line}\n`);

/** Runs `tether update`; the exit status. A failure is one `tether-install: error: …` line on stderr. */
export async function runUpdate(args: string[], env: Env = process.env): Promise<number> {
  try {
    await update(args, env);
    return 0;
  } catch (e) {
    const reason = e instanceof InstallError ? e.message : `${e}`;
    process.stderr.write(`tether-install: error: ${reason.split('\n')[0]}\n`);
    return 1;
  }
}

async function update(args: string[], env: Env) {
  let asked = env.TETHER_VERSION || undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--version' && args[i + 1]) asked = args[++i];
    else if (arg.startsWith('--version=')) asked = arg.slice('--version='.length);
    else throw new InstallError(USAGE);
  }
  const binary = env.TETHER_BINARY || undefined;
  // A binary the caller already has needs no platform, download or checksum.
  const platform = binary ? undefined : detectPlatform(env);
  const named = asked ?? (await latestVersion(env));
  const version = named.replace(/^v/, '');
  if (!VERSION.test(version)) throw new InstallError(`not a version: ${named}`);
  const dir = (env.TETHER_INSTALL_DIR || join(env.HOME || homedir(), '.tether', 'bin')).replace(/\/$/, '');

  if (!binary && installedVersion(dir) === version) {
    say(`Tether ${version} is already installed`);
    return;
  }
  await install({ version, dir, binary, platform, base: (env.TETHER_DOWNLOAD_BASE || DOWNLOADS).replace(/\/$/, '') });
}

function detectPlatform(env: Env): string {
  const platform = env.TETHER_PLATFORM || `${process.platform}-${process.arch}`;
  if (!PLATFORMS.includes(platform)) throw new InstallError(`unsupported platform: ${platform}`);
  return platform;
}

/** The latest release's version, from GitHub (TETHER_RELEASES_API in tests). */
async function latestVersion(env: Env): Promise<string> {
  const api = env.TETHER_RELEASES_API || LATEST;
  let tag: unknown;
  try {
    const r = await fetch(api, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'tether' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    tag = ((await r.json()) as { tag_name?: unknown }).tag_name;
  } catch (e) {
    throw new InstallError(`couldn't find the latest release at ${api}: ${(e as Error).message}`);
  }
  if (typeof tag !== 'string') throw new InstallError(`the latest release at ${api} has no tag`);
  return tag;
}

/** The version `<dir>/tether` runs, if it's a link to a versioned binary that's there. */
function installedVersion(dir: string): string | undefined {
  try {
    const link = readlinkSync(join(dir, 'tether'));
    if (!link.startsWith('tether-') || !statSync(join(dir, link)).isFile()) return undefined;
    return link.slice('tether-'.length);
  } catch {
    return undefined;
  }
}

async function install(o: { version: string; dir: string; binary?: string; platform?: string; base: string }) {
  const { version, dir, binary, platform } = o;
  const target = join(dir, `tether-${version}`);
  const tmp = join(dir, `.tether-install.${process.pid}`);
  if (binary && !isFile(binary)) throw new InstallError(`no file at ${binary}`);

  // ~/.tether holds the daemon's socket, log and schedules: private, as the daemon makes it.
  attempt(`couldn't create ${dir}`, () => mkdirSync(dir, { recursive: true, mode: 0o700 }));
  if (isDirectory(join(dir, 'tether'))) throw new InstallError(`${dir}/tether is a directory`);
  try {
    if (binary) {
      say(`Installing Tether ${version} from ${binary}`);
      attempt(`couldn't install ${binary} into ${dir}`, () => {
        copyFileSync(binary, `${tmp}.bin`);
        chmodSync(`${tmp}.bin`, 0o755);
        renameSync(`${tmp}.bin`, target);
      });
    } else {
      const base = `${o.base}/v${version}`;
      const asset = `tether-${version}-${platform}`;
      const sums = await (await download(`${base}/SHA256SUMS`)).text();
      const expected = sums
        .split('\n')
        .map((line) => line.trim().split(/\s+/))
        .find(([, file]) => file?.replace(/^\*/, '') === asset)?.[0];
      if (!expected || !/^[0-9a-f]{64}$/.test(expected)) throw new InstallError(`SHA256SUMS has no checksum for ${asset}`);

      if (isFile(target) && (await sha256File(target)) === expected) {
        say(`Tether ${version} for ${platform} is already downloaded`);
        attempt(`couldn't install into ${dir}`, () => chmodSync(target, 0o755));
      } else {
        say(`Downloading Tether ${version} for ${platform}`);
        const url = `${base}/${asset}`;
        const response = await download(url);
        try {
          // Streamed: Bun.write(path, response) can hang on a body this size (Bun 1.3.14).
          await pipeline(Readable.fromWeb(response.body!), createWriteStream(`${tmp}.bin`));
        } catch (e) {
          throw new InstallError(`couldn't download ${url}: ${(e as Error).message}`);
        }
        say('Verifying');
        const sum = await sha256File(`${tmp}.bin`);
        if (sum !== expected) throw new InstallError(`checksum mismatch for ${asset}: expected ${expected}, got ${sum}`);
        attempt(`couldn't install into ${dir}`, () => {
          chmodSync(`${tmp}.bin`, 0o755);
          renameSync(`${tmp}.bin`, target);
        });
      }
    }

    // Relative, so the directory can move; renamed into place, so `tether` always runs something.
    attempt(`couldn't link ${dir}/tether`, () => {
      rmSync(`${tmp}.link`, { force: true });
      symlinkSync(`tether-${version}`, `${tmp}.link`);
      renameSync(`${tmp}.link`, join(dir, 'tether'));
    });
    prune(dir, version);
  } finally {
    rmSync(`${tmp}.bin`, { force: true });
    rmSync(`${tmp}.link`, { force: true });
  }
  say(`Installed Tether ${version}`);
}

/**
 * Other versions, dev builds and interrupted installs, but nothing else. A daemon still running one
 * keeps its deleted file until the next connect replaces it.
 */
function prune(dir: string, version: string) {
  for (const name of readdirSync(dir)) {
    if (name === `tether-${version}`) continue;
    const versioned = /^tether-(.+?)(?:\.tmp)?$/.exec(name)?.[1];
    if (!name.startsWith('.tether-install.') && !(versioned && VERSION.test(versioned))) continue;
    const path = join(dir, name);
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (stat?.isFile() || stat?.isSymbolicLink()) rmSync(path, { force: true });
  }
}

async function download(url: string): Promise<Response> {
  let r: Response;
  try {
    r = await fetch(url, { headers: { 'user-agent': 'tether' } });
  } catch (e) {
    throw new InstallError(`couldn't download ${url}: ${(e as Error).message}`);
  }
  if (!r.ok) throw new InstallError(`couldn't download ${url}: HTTP ${r.status}`);
  return r;
}

/** A file's SHA-256, in hex, as `sha256sum` prints it. */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of Bun.file(path).stream()) hash.update(chunk);
  return hash.digest('hex');
}

function attempt(failure: string, body: () => void) {
  try {
    body();
  } catch {
    throw new InstallError(failure);
  }
}

const isFile = (path: string) => statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;
const isDirectory = (path: string) => statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;
