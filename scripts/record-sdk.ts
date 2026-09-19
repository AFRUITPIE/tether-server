// Records raw SDKMessages from a real `claude` run into test/fixtures/sdk/<name>.jsonl.
// Usage: bun run scripts/record-sdk.ts <name> <prompt> [--model haiku] [--mode default]
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, appendFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [name, prompt, ...rest] = process.argv.slice(2);
if (!name || !prompt) throw new Error('usage: record-sdk.ts <name> <prompt>');
const flag = (k: string) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : undefined; };
const claude = execFileSync('/bin/sh', ['-lc', 'command -v claude']).toString().trim();
const cwd = flag('--cwd') ?? mkdtempSync(join(tmpdir(), 'tether-rec-'));
writeFileSync(join(cwd, 'hello.txt'), 'hello from tether\n');
const out = join(import.meta.dir, '..', 'test', 'fixtures', 'sdk', `${name}.jsonl`);
mkdirSync(join(out, '..'), { recursive: true });
writeFileSync(out, '');
const log = (kind: string, data: unknown) => appendFileSync(out, JSON.stringify({ kind, data }) + '\n');

async function* input(): AsyncGenerator<SDKUserMessage> {
  yield { type: 'user', message: { role: 'user', content: prompt! }, parent_tool_use_id: null } as SDKUserMessage;
  await new Promise(() => {}); // keep stream open; we close on result
}

const q = query({
  prompt: input(),
  options: {
    pathToClaudeCodeExecutable: claude,
    cwd,
    model: flag('--model') ?? 'haiku',
    permissionMode: (flag('--mode') as any) ?? 'default',
    includePartialMessages: true,
    enableFileCheckpointing: true,
    settingSources: ['user', 'project', 'local'],
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    canUseTool: async (toolName, toolInput, opts) => {
      const { signal, ...rest } = opts;
      log('canUseTool', { toolName, input: toolInput, options: rest });
      if (toolName === 'AskUserQuestion') {
        const qs = (toolInput as any).questions ?? [];
        const answers = Object.fromEntries(qs.map((q: any) => [q.question, q.options?.[0]?.label ?? 'yes']));
        return { behavior: 'allow', updatedInput: { ...toolInput, answers } };
      }
      return { behavior: 'allow', updatedInput: toolInput };
    },
  },
});
log('initializationResult', await q.initializationResult());
for await (const m of q) {
  log('message', m);
  if (m.type === 'result') break;
}
q.close();
console.log('wrote', out, 'cwd', cwd);
