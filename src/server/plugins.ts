import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ErrorCodes, RpcError } from '../rpc/connection.ts';

const run = promisify(execFile);

/** Runs `claude plugin …` as the host's Claude Code, in `cwd` for a project's scope. */
async function plugin(claude: string, args: string[], cwd: string | undefined, env: Record<string, string>) {
  try {
    const { stdout } = await run(claude, ['plugin', ...args], {
      ...(cwd ? { cwd } : {}),
      env: { ...process.env, ...env },
      maxBuffer: 32 << 20,
      timeout: 5 * 60_000,
    });
    return stdout;
  } catch (e) {
    const err = e as Error & { stdout?: string; stderr?: string };
    // `--json` failures still say why on stdout; otherwise stderr does.
    const reason = lastJsonMessage(err.stdout) ?? err.stderr?.trim().split('\n').at(-1) ?? err.message;
    throw new RpcError(ErrorCodes.invalidRequest, reason);
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
  const out = JSON.parse(await plugin(claude, ['list', '--json', '--available'], cwd, env));
  return { installed: out.installed ?? [], available: out.available ?? [] };
}

/** Never with `-y`: a marketplace-declared command has to be accepted by the person, in a terminal. */
export async function installPlugin(claude: string, id: string, scope: string, cwd: string | undefined, env: Record<string, string>) {
  await plugin(claude, ['install', id, '--scope', scope, '--json'], cwd, env);
}

export async function uninstallPlugin(claude: string, id: string, scope: string | undefined, cwd: string | undefined, env: Record<string, string>) {
  await plugin(claude, ['uninstall', id, ...(scope ? ['--scope', scope] : [])], cwd, env);
}

export async function setPluginEnabled(claude: string, id: string, enabled: boolean, scope: string | undefined, cwd: string | undefined, env: Record<string, string>) {
  await plugin(claude, [enabled ? 'enable' : 'disable', id, ...(scope ? ['--scope', scope] : [])], cwd, env);
}
