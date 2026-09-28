import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { checksums, installScript } from '../scripts/assets.ts';
import { sha256File } from '../src/install.ts';

// install.sh and `tether update` against one fixture: releases laid out as GitHub serves them,
// <base>/v<version>/<asset>, whose "binaries" are small scripts naming their version and platform.
const PLATFORMS = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'];
const binary = (version: string, platform: string) => `#!/bin/sh\necho tether ${version} ${platform}\n`;

const releases = mkdtempSync(join(tmpdir(), 'tether-releases-'));
for (const version of ['0.5.5', '0.5.6', '0.5.7']) {
  mkdirSync(join(releases, `v${version}`));
  const files = PLATFORMS.map((platform) => {
    const file = join(releases, `v${version}`, `tether-${version}-${platform}`);
    writeFileSync(file, binary(version, platform));
    return file;
  });
  let sums = await checksums(files);
  // 0.5.7's binaries don't match its SHA256SUMS.
  if (version === '0.5.7') sums = sums.replace(/^./gm, (c) => (c === '0' ? '1' : '0'));
  writeFileSync(join(releases, `v${version}`, 'SHA256SUMS'), sums);
}
// A binary near the size of a real one (about 70 MB): Bun.write(path, response) could hang on one.
const big = join(releases, 'v0.6.0', 'tether-0.6.0-linux-x64');
mkdirSync(join(releases, 'v0.6.0'));
writeFileSync(big, new Uint8Array(64 * 1024 * 1024).map((_, i) => i % 251));
writeFileSync(join(releases, 'v0.6.0', 'SHA256SUMS'), await checksums([big]));

let latest = '0.5.6';
const requests: string[] = [];
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    requests.push(path);
    if (path === '/releases/latest') return Response.json({ tag_name: `v${latest}` });
    const file = Bun.file(join(releases, path.replace(/^\/download\//, '')));
    return (await file.exists()) ? new Response(file) : new Response('Not Found', { status: 404 });
  },
});
afterAll(() => server.stop(true));
const base = `${server.url.origin}/download`;
beforeEach(() => {
  requests.length = 0;
  latest = '0.5.6';
});
const downloads = () => requests.filter((r) => /\/tether-[^/]*$/.test(r));

type Env = Record<string, string | undefined>;
type Result = { code: number; out: string[]; err: string[] };

async function run(cmd: string[], env: Env, stdin?: string): Promise<Result> {
  const inherited = Object.entries(process.env).filter(([k]) => !k.startsWith('TETHER_'));
  const merged = Object.entries({ ...Object.fromEntries(inherited), ...env }).filter(([, v]) => v !== undefined);
  const proc = Bun.spawn(cmd, {
    env: Object.fromEntries(merged) as Record<string, string>,
    stdin: stdin ? Bun.file(stdin) : 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  const lines = (s: string) => s.split('\n').filter(Boolean);
  return { code, out: lines(out), err: lines(err) };
}

/** An empty home and install directory, and the environment that points the installers at the fixture. */
function sandbox() {
  const home = mkdtempSync(join(tmpdir(), 'tether-install-'));
  const dir = join(home, 'bin');
  const env: Env = {
    HOME: home,
    TETHER_INSTALL_DIR: dir,
    TETHER_DOWNLOAD_BASE: base,
    TETHER_PLATFORM: 'linux-x64',
    TETHER_RELEASES_API: `${server.url.origin}/releases/latest`,
  };
  return { home, dir, env, files: () => readdirSync(dir).sort(), link: () => readlinkSync(join(dir, 'tether')) };
}

const script = join(import.meta.dir, '..', 'scripts', 'install.sh');
const cli = join(import.meta.dir, '..', 'src', 'cli.ts');
const shells = ['sh', 'dash'].map((s) => Bun.which(s)).filter((s): s is string => !!s);
const say = (...lines: string[]) => lines.map((l) => `tether-install: ${l}`);

type Installer = { name: string; install(version: string | undefined, env: Env): Promise<Result> };
const installers: Installer[] = [
  ...shells.map((sh) => ({
    name: `install.sh (${basename(sh)})`,
    install: (version: string | undefined, env: Env) => run([sh, script], { TETHER_VERSION: version, ...env }),
  })),
  {
    name: 'tether update',
    install: (version: string | undefined, env: Env) =>
      run([process.execPath, cli, 'update', ...(version ? ['--version', version] : [])], env),
  },
];

describe.each(installers)('$name', (installer) => {
  const install = installer.install;

  test('a fresh install downloads, verifies and links the binary', async () => {
    const { dir, env, files, link } = sandbox();
    expect(await install('0.5.6', env)).toEqual({
      code: 0,
      out: say('Downloading Tether 0.5.6 for linux-x64', 'Verifying', 'Installed Tether 0.5.6'),
      err: [],
    });
    expect(files()).toEqual(['tether', 'tether-0.5.6']);
    expect(link()).toBe('tether-0.5.6');
    expect(statSync(join(dir, 'tether-0.5.6')).mode & 0o777).toBe(0o755);
    expect((await run([join(dir, 'tether')], {})).out).toEqual(['tether 0.5.6 linux-x64']);
  });

  test('a binary already there with the right checksum is not downloaded again', async () => {
    const { dir, env, files, link } = sandbox();
    mkdirSync(dir);
    writeFileSync(join(dir, 'tether-0.5.6'), binary('0.5.6', 'linux-x64'));
    expect(await install('0.5.6', env)).toEqual({
      code: 0,
      out: say('Tether 0.5.6 for linux-x64 is already downloaded', 'Installed Tether 0.5.6'),
      err: [],
    });
    expect(downloads()).toEqual([]);
    expect(files()).toEqual(['tether', 'tether-0.5.6']);
    expect(link()).toBe('tether-0.5.6');
    expect(statSync(join(dir, 'tether-0.5.6')).mode & 0o777).toBe(0o755);
  });

  test('one with the wrong checksum is replaced', async () => {
    const { dir, env } = sandbox();
    mkdirSync(dir);
    writeFileSync(join(dir, 'tether-0.5.6'), 'corrupt');
    expect((await install('0.5.6', env)).code).toBe(0);
    expect(downloads()).toEqual(['/download/v0.5.6/tether-0.5.6-linux-x64']);
    expect(readFileSync(join(dir, 'tether-0.5.6'), 'utf8')).toBe(binary('0.5.6', 'linux-x64'));
  });

  test('an upgrade relinks and prunes other versions, dev builds and leftovers, and nothing else', async () => {
    const { dir, env, files, link } = sandbox();
    mkdirSync(join(dir, 'tether-9.9.9'), { recursive: true });
    for (const f of ['tether-0.5.4', 'tether-0.5.6-dev.20260101000000', 'tether-0.5.3.tmp', '.tether-install.1.bin', 'notes.txt', 'tether-helper', 'tether.conf'])
      writeFileSync(join(dir, f), '');
    expect((await install('0.5.5', env)).code).toBe(0);
    expect(link()).toBe('tether-0.5.5');
    expect(await install('0.5.6', env)).toEqual({
      code: 0,
      out: say('Downloading Tether 0.5.6 for linux-x64', 'Verifying', 'Installed Tether 0.5.6'),
      err: [],
    });
    expect(link()).toBe('tether-0.5.6');
    expect(files()).toEqual(['notes.txt', 'tether', 'tether-0.5.6', 'tether-9.9.9', 'tether-helper', 'tether.conf']);
  });

  test('a binary the size of a real one arrives whole', async () => {
    const { dir, env } = sandbox();
    expect((await install('0.6.0', env)).out.at(-1)).toBe('tether-install: Installed Tether 0.6.0');
    expect(await sha256File(join(dir, 'tether-0.6.0'))).toBe(await sha256File(big));
  });

  test('a checksum mismatch installs nothing and leaves the link alone', async () => {
    const { env, files, link } = sandbox();
    expect((await install('0.5.6', env)).code).toBe(0);
    const r = await install('0.5.7', env);
    expect(r.code).toBe(1);
    expect(r.out).toEqual(say('Downloading Tether 0.5.7 for linux-x64', 'Verifying'));
    expect(r.err).toHaveLength(1);
    expect(r.err[0]).toMatch(/^tether-install: error: checksum mismatch for tether-0\.5\.7-linux-x64: expected [0-9a-f]{64}, got [0-9a-f]{64}$/);
    expect(files()).toEqual(['tether', 'tether-0.5.6']);
    expect(link()).toBe('tether-0.5.6');
  });

  test('an unsupported platform is refused before anything is made', async () => {
    const { dir, env } = sandbox();
    expect(await install('0.5.6', { ...env, TETHER_PLATFORM: 'freebsd-x64' })).toEqual({
      code: 1,
      out: [],
      err: say('error: unsupported platform: freebsd-x64'),
    });
    expect(requests).toEqual([]);
    expect(existsSync(dir)).toBe(false);
  });

  test('a release that is not there says what could not be downloaded', async () => {
    const { env, files } = sandbox();
    const r = await install('9.9.9', env);
    expect(r.code).toBe(1);
    expect(r.out).toEqual([]);
    expect(r.err).toHaveLength(1);
    expect(r.err[0]).toStartWith(`tether-install: error: couldn't download ${base}/v9.9.9/SHA256SUMS`);
    expect(files()).toEqual([]);
  });

  test('a version that is not one is refused', async () => {
    const { env } = sandbox();
    expect(await install('../0.5.6', env)).toEqual({ code: 1, out: [], err: say('error: not a version: ../0.5.6') });
  });

  test('TETHER_BINARY installs that file, with no platform, download or checksum', async () => {
    const { home, env, files, link } = sandbox();
    const upload = join(home, 'upload');
    writeFileSync(upload, binary('0.5.6', 'linux-x64'));
    expect(await install('0.5.6', { ...env, TETHER_BINARY: upload, TETHER_PLATFORM: 'freebsd-x64' })).toEqual({
      code: 0,
      out: say(`Installing Tether 0.5.6 from ${upload}`, 'Installed Tether 0.5.6'),
      err: [],
    });
    expect(requests).toEqual([]);
    expect(files()).toEqual(['tether', 'tether-0.5.6']);
    expect(link()).toBe('tether-0.5.6');
    expect(readFileSync(join(home, 'bin', 'tether'), 'utf8')).toBe(binary('0.5.6', 'linux-x64'));
  });

  test('TETHER_BINARY naming nothing is an error', async () => {
    const { home, env } = sandbox();
    expect(await install('0.5.6', { ...env, TETHER_BINARY: join(home, 'missing') })).toEqual({
      code: 1,
      out: [],
      err: say(`error: no file at ${join(home, 'missing')}`),
    });
  });

  test('installs into ~/.tether/bin by default, keeping ~/.tether private', async () => {
    const { home, env } = sandbox();
    expect((await install('0.5.6', { ...env, TETHER_INSTALL_DIR: undefined })).code).toBe(0);
    expect(readlinkSync(join(home, '.tether', 'bin', 'tether'))).toBe('tether-0.5.6');
    expect(statSync(join(home, '.tether')).mode & 0o777).toBe(0o700);
  });
});

describe.each(shells.map((sh) => [basename(sh), sh]))('install.sh (%s)', (_, sh) => {
  test('running it again fetches only SHA256SUMS', async () => {
    const { env, files } = sandbox();
    await run([sh, script], { ...env, TETHER_VERSION: '0.5.6' });
    requests.length = 0;
    expect(await run([sh, script], { ...env, TETHER_VERSION: '0.5.6' })).toEqual({
      code: 0,
      out: say('Tether 0.5.6 for linux-x64 is already downloaded', 'Installed Tether 0.5.6'),
      err: [],
    });
    expect(requests).toEqual(['/download/v0.5.6/SHA256SUMS']);
    expect(files()).toEqual(['tether', 'tether-0.5.6']);
  });

  test('a release’s copy installs its own version unless TETHER_VERSION names another', async () => {
    const { home, env, link } = sandbox();
    const released = join(home, 'install.sh');
    writeFileSync(released, await installScript('0.5.5'));
    expect((await run([sh, released], env)).out.at(-1)).toBe('tether-install: Installed Tether 0.5.5');
    expect(link()).toBe('tether-0.5.5');
    expect((await run([sh, released], { ...env, TETHER_VERSION: 'v0.5.6' })).out.at(-1)).toBe('tether-install: Installed Tether 0.5.6');
    expect(link()).toBe('tether-0.5.6');
  });

  test('the unreleased script names no version', async () => {
    const { env } = sandbox();
    expect(await run([sh, script], env)).toEqual({
      code: 1,
      out: [],
      err: say('error: this install.sh names no version; set TETHER_VERSION'),
    });
  });

  test('piped to `sh -s`, as over SSH', async () => {
    const { env, link } = sandbox();
    const r = await run([sh, '-s'], { ...env, TETHER_VERSION: '0.5.6' }, script);
    expect(r.code).toBe(0);
    expect(r.out.at(-1)).toBe('tether-install: Installed Tether 0.5.6');
    expect(link()).toBe('tether-0.5.6');
  });

  test.each([
    ['Linux aarch64', 'linux-arm64'],
    ['Linux x86_64', 'linux-x64'],
    ['Darwin arm64', 'darwin-arm64'],
    ['Darwin x86_64', 'darwin-x64'],
  ])('`uname -sm` of %s installs %s', async (machine, platform) => {
    const { dir, env } = sandbox();
    const r = await run([sh, script], { ...env, TETHER_PLATFORM: undefined, TETHER_VERSION: '0.5.6', PATH: fakeUname(machine) });
    expect(r.out[0]).toBe(`tether-install: Downloading Tether 0.5.6 for ${platform}`);
    expect(readFileSync(join(dir, 'tether'), 'utf8')).toBe(binary('0.5.6', platform));
  });

  test('an unsupported machine is named', async () => {
    const { env } = sandbox();
    const r = await run([sh, script], { ...env, TETHER_PLATFORM: undefined, TETHER_VERSION: '0.5.6', PATH: fakeUname('FreeBSD amd64') });
    expect(r).toEqual({ code: 1, out: [], err: say('error: unsupported platform: FreeBSD amd64') });
  });

  test('downloads with wget when there is no curl', async () => {
    const { env, link } = sandbox();
    const path = toolsWithout('curl');
    const curl = Bun.which('curl')!;
    writeFileSync(join(path, 'wget'), `#!/bin/sh\n[ "$1" = -q ] && [ "$2" = -O ] || exit 2\nexec ${curl} -fsSL -o "$3" "$4"\n`, { mode: 0o755 });
    const r = await run([sh, script], { ...env, TETHER_VERSION: '0.5.6', PATH: path });
    expect(r.out.at(-1)).toBe('tether-install: Installed Tether 0.5.6');
    expect(link()).toBe('tether-0.5.6');
  });

  test('without curl or wget, or anything to check the download with, it stops', async () => {
    const { dir, env } = sandbox();
    expect(await run([sh, script], { ...env, TETHER_VERSION: '0.5.6', PATH: toolsWithout('curl', 'wget') })).toEqual({
      code: 1,
      out: [],
      err: say('error: curl or wget is needed to download Tether'),
    });
    expect(await run([sh, script], { ...env, TETHER_VERSION: '0.5.6', PATH: toolsWithout('sha256sum', 'shasum') })).toEqual({
      code: 1,
      out: [],
      err: say('error: sha256sum or shasum is needed to check the download'),
    });
    expect(requests).toEqual([]);
    expect(existsSync(dir)).toBe(false);
  });
});

/** A PATH whose `uname` says this machine is `machine`. */
function fakeUname(machine: string) {
  const bin = mkdtempSync(join(tmpdir(), 'tether-uname-'));
  writeFileSync(join(bin, 'uname'), `#!/bin/sh\necho '${machine}'\n`, { mode: 0o755 });
  return `${bin}:${process.env.PATH}`;
}

/** A PATH holding only the tools install.sh uses, less `missing`. */
function toolsWithout(...missing: string[]) {
  const bin = mkdtempSync(join(tmpdir(), 'tether-tools-'));
  for (const tool of ['uname', 'mkdir', 'chmod', 'cp', 'mv', 'ln', 'rm', 'curl', 'wget', 'sha256sum', 'shasum']) {
    const path = Bun.which(tool);
    if (path && !missing.includes(tool)) symlinkSync(path, join(bin, tool));
  }
  return bin;
}

describe('tether update', () => {
  const update = (env: Env, ...args: string[]) => run([process.execPath, cli, 'update', ...args], env);

  test('installs the latest release', async () => {
    const { env, link } = sandbox();
    latest = '0.5.5';
    expect(await update(env)).toEqual({
      code: 0,
      out: say('Downloading Tether 0.5.5 for linux-x64', 'Verifying', 'Installed Tether 0.5.5'),
      err: [],
    });
    expect(requests[0]).toBe('/releases/latest');
    expect(link()).toBe('tether-0.5.5');
  });

  test('TETHER_VERSION names a version as --version does', async () => {
    const { env, link } = sandbox();
    expect((await update({ ...env, TETHER_VERSION: '0.5.5' })).out.at(-1)).toBe('tether-install: Installed Tether 0.5.5');
    expect(requests).not.toContain('/releases/latest');
    expect(link()).toBe('tether-0.5.5');
  });

  test('says when that version is already installed, and downloads nothing', async () => {
    const { env } = sandbox();
    await update(env, '--version', '0.5.6');
    requests.length = 0;
    expect(await update(env, '--version=v0.5.6')).toEqual({ code: 0, out: say('Tether 0.5.6 is already installed'), err: [] });
    expect(requests).toEqual([]);
    expect(await update(env)).toEqual({ code: 0, out: say('Tether 0.5.6 is already installed'), err: [] });
    expect(requests).toEqual(['/releases/latest']);
  });

  test('says when the latest release cannot be found', async () => {
    const { env } = sandbox();
    const api = `${server.url.origin}/missing`;
    expect(await update({ ...env, TETHER_RELEASES_API: api })).toEqual({
      code: 1,
      out: [],
      err: say(`error: couldn't find the latest release at ${api}: HTTP 404`),
    });
  });

  test('refuses arguments it does not know', async () => {
    const { env } = sandbox();
    expect(await update(env, '--version')).toEqual({ code: 1, out: [], err: say('error: usage: tether update [--version <version>]') });
    expect(requests).toEqual([]);
  });
});

describe('release files', () => {
  test('SHA256SUMS is what `sha256sum -c` reads', async () => {
    const check = Bun.which('sha256sum') ? ['sha256sum', '-c'] : ['shasum', '-a', '256', '-c'];
    const proc = Bun.spawn([...check, 'SHA256SUMS'], { cwd: join(releases, 'v0.5.6'), stdout: 'pipe' });
    expect(await proc.exited).toBe(0);
    expect((await new Response(proc.stdout).text()).trim().split('\n')).toHaveLength(PLATFORMS.length);
  });

  test('a release’s install.sh has its version in place of the placeholder', async () => {
    const released = await installScript('1.2.3');
    expect(released).toContain('version=${TETHER_VERSION:-1.2.3}');
    expect(released).not.toContain('__TETHER_VERSION__');
  });

  test('`tether version --json` is what a client probes a host with', async () => {
    const r = await run([process.execPath, cli, 'version', '--json'], {});
    expect(r.out).toHaveLength(1);
    const info = JSON.parse(r.out[0]!);
    expect(Object.keys(info)).toEqual(['version', 'protocolVersion', 'minClientProtocol', 'agentSdkVersion', 'platform']);
    expect(info.platform).toMatch(/^(darwin|linux)-(arm64|x64)$/);
  });
});
