import { describe, expect, test } from 'bun:test';
import { ErrorCodes } from '../src/rpc/connection.ts';
import { askSideQuestion } from '../src/server/session.ts';

describe('side questions', () => {
  test('are answered', async () => {
    const query = { askSideQuestion: async (q: string) => ({ response: `re: ${q}` }) };
    expect(await askSideQuestion(query, 'why?')).toBe('re: why?');
    expect(await askSideQuestion({ askSideQuestion: async () => null }, 'why?')).toBeNull();
  });

  test('are given up on, and cancelled in Claude Code, when no answer comes', async () => {
    let signal: AbortSignal | undefined;
    const query = { askSideQuestion: (_: string, o?: { signal?: AbortSignal }) => ((signal = o?.signal), new Promise<never>(() => {})) };
    const e: any = await askSideQuestion(query, 'why?', 20).catch((e) => e);
    expect(e.code).toBe(ErrorCodes.sdkError);
    expect(e.message).toContain("didn't answer the side question");
    expect(signal?.aborted).toBe(true);
  });

  test('need a Claude Code that has them', async () => {
    await expect(askSideQuestion({}, 'why?')).rejects.toThrow('newer Claude Code');
  });
});
