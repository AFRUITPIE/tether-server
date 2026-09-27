import { spawn } from 'node:child_process';
import { ErrorCodes, RpcError } from '../rpc/connection.ts';

type Output = { stdout: string; stderr: string };

/**
 * Runs a command to completion, capturing its output. Its stdin is /dev/null, so a command that
 * stops to ask something reads end-of-file and fails at once rather than waiting for an answer
 * nobody can give. (`execFile` can't do this: it always gives the child a stdin pipe.)
 */
function capture(
  file: string,
  args: string[],
  opts: { cwd?: string; env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number },
): Promise<Output> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let why: string | undefined;
    const child = spawn(file, args, { ...(opts.cwd ? { cwd: opts.cwd } : {}), env: opts.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const stop = (reason: string) => {
      why ??= reason;
      child.kill('SIGTERM');
    };
    const timer = setTimeout(() => stop(`timed out after ${Math.round(opts.timeout / 1000)} seconds`), opts.timeout);
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(Object.assign(error, { stdout, stderr }));
      else resolve({ stdout, stderr });
    };
    const collect = (append: (s: string) => void) => (chunk: string) => {
      append(chunk);
      if (stdout.length + stderr.length > opts.maxBuffer) stop('printed more than expected');
    };
    child.stdout.setEncoding('utf8').on('data', collect((s) => (stdout += s)));
    child.stderr.setEncoding('utf8').on('data', collect((s) => (stderr += s)));
    child.on('error', (e) => settle(e));
    child.on('close', (code, signal) => {
      if (why) settle(new Error(`${file} ${why}`));
      else if (code !== 0) settle(new Error(`${file} exited with ${code ?? signal}`));
      else settle();
    });
  });
}

/**
 * Runs `claude plugin …` as the host's Claude Code, in `cwd` for a project's scope. Positional
 * arguments go after `--`, so a plugin id that starts with `-` can't be read as an option.
 */
async function plugin(claude: string, args: string[], cwd: string | undefined, env: Record<string, string>) {
  try {
    const { stdout } = await capture(claude, ['plugin', ...args], {
      ...(cwd ? { cwd } : {}),
      env: { ...process.env, ...env },
      maxBuffer: 32 << 20,
      timeout: 5 * 60_000,
    });
    return stdout;
  } catch (e) {
    const err = e as Error & { stdout?: string; stderr?: string };
    // `--json` failures still say why on stdout; otherwise stderr does.
    const reason = lastJsonMessage(err.stdout) ?? (err.stderr?.trim().split('\n').at(-1) || err.message);
    throw new RpcError(
      ErrorCodes.invalidRequest,
      /unknown (option|command)/i.test(reason) ? `Managing plugins needs a newer Claude Code on this host (${reason}).` : reason,
    );
  }
}

function lastJsonMessage(stdout?: string): string | undefined {
  const line = stdout?.trim().split('\n').at(-1);
  if (!line) return undefined;
  try {
    const parsed = JSON.parse(line);
    return typeof parsed?.error === 'string' ? parsed.error : typeof parsed?.message === 'string' ? parsed.message : undefined;
  } catch {
    return undefined;
  }
}

export async function listPlugins(claude: string, cwd: string | undefined, env: Record<string, string>) {
  const stdout = await plugin(claude, ['list', '--json', '--available'], cwd, env);
  let out: { installed?: unknown; available?: unknown };
  try {
    out = JSON.parse(stdout);
    if (!out || typeof out !== 'object') throw new Error('not an object');
  } catch {
    throw new RpcError(
      ErrorCodes.invalidRequest,
      "Claude Code on this host didn't list its plugins in a form Tether reads. Managing plugins needs a newer Claude Code.",
    );
  }
  return { installed: Array.isArray(out.installed) ? out.installed : [], available: Array.isArray(out.available) ? out.available : [] };
}

export type PluginScope = 'user' | 'project' | 'local';

/** Never with `-y`: a marketplace-declared command has to be accepted by the person, in a terminal. */
export async function installPlugin(claude: string, id: string, scope: PluginScope, cwd: string | undefined, env: Record<string, string>) {
  await plugin(claude, ['install', '--scope', scope, '--json', '--', id], cwd, env);
}

export async function uninstallPlugin(claude: string, id: string, scope: PluginScope | undefined, cwd: string | undefined, env: Record<string, string>) {
  await plugin(claude, ['uninstall', ...(scope ? ['--scope', scope] : []), '--', id], cwd, env);
}

export async function setPluginEnabled(
  claude: string,
  id: string,
  enabled: boolean,
  scope: PluginScope | undefined,
  cwd: string | undefined,
  env: Record<string, string>,
) {
  await plugin(claude, [enabled ? 'enable' : 'disable', ...(scope ? ['--scope', scope] : []), '--', id], cwd, env);
}
