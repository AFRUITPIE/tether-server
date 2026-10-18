import { describe, expect, test } from 'bun:test';
import type { ToolCallItem, Turn } from '../src/protocol/index.ts';
import { ingestHistory, TranscriptExtras } from '../src/threads/FollowedThread.ts';
import { Itemizer, type Emission } from '../src/threads/itemizer.ts';
import { lineDiffHunk, MAX_LINE_LENGTH, MAX_LINES_PER_FILE } from '../src/server/diff.ts';

const DIR = `${import.meta.dir}/fixtures/loop-goal`;
const text = async (name: string) => (await Bun.file(`${DIR}/${name}`).text()).trim();
const lines = async (name: string): Promise<any[]> => (await text(name)).split('\n').map((l) => JSON.parse(l));

const call = (iz: Itemizer, id: string) => iz.items.get(id) as ToolCallItem;
const assistant = (id: string, content: object[], parent: string | null = null) => ({ type: 'assistant', parent_tool_use_id: parent, message: { id, content } });
const result = (toolUseId: string, content: string, toolUseResult?: object, parent: string | null = null, isError = false) => ({
  type: 'user',
  parent_tool_use_id: parent,
  message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content, ...(isError ? { is_error: true } : {}) }] },
  ...(toolUseResult ? { tool_use_result: toolUseResult } : {}),
});
const turnOf = (out: Emission[], method: 'turn/completed' | 'turn/updated') => out.flatMap((e) => (e.method === method ? [e.body.turn as Turn] : [])).at(-1);

/** One edit in its own turn, live. */
function edit(name: string, input: object, toolUseResult?: object, isError = false) {
  const iz = new Itemizer(() => 1);
  iz.beginUserTurn('u1', [{ type: 'text', text: 'go' }], false);
  iz.ingest(assistant('m1', [{ type: 'tool_use', id: 'e1', name, input }]));
  iz.ingest(result('e1', isError ? 'failed' : 'ok', toolUseResult, null, isError));
  const out = iz.ingest({ type: 'result', subtype: 'success', is_error: false, uuid: 'r' });
  return { edit: call(iz, 'e1').edit, output: call(iz, 'e1').output, turn: turnOf(out, 'turn/completed')! };
}

describe('edits, from the /goal capture', async () => {
  const stream = await lines('goal-stream.jsonl');
  const raw = (await text('goal-raw.jsonl')).split('\n');
  const history = await lines('goal-history.jsonl');
  // Claude fixed the typos with a Write over the file.
  const editCall = (s: { items: any[] }) => s.items.find((i) => i.type === 'toolCall' && i.name === 'Write') as ToolCallItem;
  const expected = {
    path: '/private/tmp/wf-scratch/notes.md',
    hunks: [
      {
        oldStart: 1,
        oldLines: 2,
        newStart: 1,
        newLines: 2,
        lines: ['-The quick brwon fox jumps over teh lazy dog.', '-Recieve the package tommorow.', '+The quick brown fox jumps over the lazy dog.', '+Receive the package tomorrow.'],
      },
    ],
    added: 2,
    removed: 2,
  };

  test("live, Claude Code's patch is the call's edit, and its turn's totals count it", () => {
    const iz = new Itemizer(() => 1);
    iz.beginUserTurn('8892057a-ff55-411e-b335-f39e87fe4a83', [{ type: 'text', text: '/goal …' }], false);
    const out = stream.flatMap((m) => iz.ingest(m));
    const e = editCall(iz.snapshot());
    expect(e.edit).toEqual(expected);
    // The output keeps the rest, not the file's whole text twice over.
    expect(e.output).toMatchObject({ type: 'update', filePath: expected.path });
    expect((e.output as any).originalFile).toBeUndefined();
    expect((e.output as any).structuredPatch).toBeUndefined();
    expect(turnOf(out, 'turn/completed')!.edits).toEqual({ files: 1, added: 2, removed: 2 });
  });

  test("from history: the transcript's result, which getSessionMessages drops, says the same", () => {
    const iz = new Itemizer(() => 1, true);
    const extras = new TranscriptExtras();
    extras.add(raw);
    ingestHistory(iz, history, extras);
    iz.closeTurn('completed');
    const s = iz.snapshot();
    expect(editCall(s).edit).toEqual(expected);
    expect(s.turns[0]!.edits).toEqual({ files: 1, added: 2, removed: 2 });
  });

  test("without the transcript's result, a Write is its content, all added", () => {
    const iz = new Itemizer(() => 1, true);
    ingestHistory(iz, history);
    const e = editCall(iz.snapshot()).edit!;
    expect(e).toMatchObject({ path: expected.path, added: 2, removed: 0 });
    expect(e.hunks[0]!.oldStart).toBe(0);
  });
});

describe('edits from calls', () => {
  test("an Edit's old and new text, compared line by line, removals before what replaced them", () => {
    const { edit: e } = edit('Edit', { file_path: '/a.swift', old_string: 'let a = 1\nlet b = 2\nlet c = 3', new_string: 'let a = 1\nlet b = 20\nlet c = 3\nlet d = 4' });
    expect(e).toEqual({
      path: '/a.swift',
      hunks: [{ oldStart: 0, oldLines: 3, newStart: 0, newLines: 4, lines: [' let a = 1', '-let b = 2', '+let b = 20', ' let c = 3', '+let d = 4'] }],
      added: 2,
      removed: 1,
    });
  });

  test("each of a MultiEdit's edits, and a new file's whole content", () => {
    const multi = edit('MultiEdit', { file_path: '/m', edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c\nd', new_string: 'c' }] }).edit!;
    expect([multi.added, multi.removed, multi.hunks.length]).toEqual([1, 2, 2]);
    const write = edit('Write', { file_path: '/n.md', content: 'one\ntwo\n' }, { type: 'create', filePath: '/n.md', content: 'one\ntwo\n', structuredPatch: [] });
    expect(write.edit).toEqual({
      path: '/n.md',
      hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, lines: ['+one', '+two'] }],
      added: 2,
      removed: 0,
      created: true,
    });
    expect(write.turn.edits).toEqual({ files: 1, added: 2, removed: 0 });
    const cell = edit('NotebookEdit', { notebook_path: '/n.ipynb', new_source: 'print(1)' }).edit!;
    expect([cell.path, cell.added]).toEqual(['/n.ipynb', 1]);
    expect(edit('NotebookEdit', { notebook_path: '/n.ipynb', edit_mode: 'delete' }).edit).toMatchObject({ added: 0, removed: 0, hunks: [] });
  });

  test('a call that failed changed nothing, and its turn has no edits', () => {
    const failed = edit('Edit', { file_path: '/a', old_string: 'x', new_string: 'y' }, undefined, true);
    expect(failed.edit).toBeUndefined();
    expect(failed.turn.edits).toBeUndefined();
  });

  test('bounded: 5,000 lines a file kept, the rest counted; a line cut at 1,000 characters', () => {
    const many = Array.from({ length: MAX_LINES_PER_FILE + 1000 }, (_, i) => (i === 0 ? 'x'.repeat(5000) : `line ${i}`)).join('\n');
    const e = edit('Write', { file_path: '/big', content: many }).edit!;
    expect(e.added).toBe(MAX_LINES_PER_FILE + 1000);
    expect(e.truncatedLines).toBe(1000);
    expect(e.hunks[0]!.lines).toHaveLength(MAX_LINES_PER_FILE);
    expect(e.hunks[0]!.lines[0]).toBe(`+${'x'.repeat(MAX_LINE_LENGTH)}…`);
  });

  test("a turn's totals count its subagents' edits, files once, and a later edit updates the turn", () => {
    const iz = new Itemizer(() => 1);
    iz.beginUserTurn('u1', [{ type: 'text', text: 'go' }], false);
    iz.ingest(assistant('m1', [{ type: 'tool_use', id: 'agent1', name: 'Agent', input: { description: 'x', run_in_background: true } }]));
    iz.ingest(result('agent1', 'launched', { status: 'async_launched', agentId: 'a1' }));
    iz.ingest(assistant('m2', [{ type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: '/a', old_string: 'a', new_string: 'b' } }], 'agent1'));
    iz.ingest(result('e1', 'ok', undefined, 'agent1'));
    iz.ingest(assistant('m3', [{ type: 'tool_use', id: 'e2', name: 'Edit', input: { file_path: '/a', old_string: 'c', new_string: 'd\ne' } }]));
    iz.ingest(result('e2', 'ok'));
    const done = iz.ingest({ type: 'result', subtype: 'success', is_error: false, uuid: 'r' });
    expect(turnOf(done, 'turn/completed')!.edits).toEqual({ files: 1, added: 3, removed: 2 });
    // The background agent goes on editing after its turn.
    iz.ingest(assistant('m4', [{ type: 'tool_use', id: 'e3', name: 'Write', input: { file_path: '/b', content: 'z' } }], 'agent1'));
    const later = iz.ingest(result('e3', 'ok', undefined, 'agent1'));
    expect(turnOf(later, 'turn/updated')).toMatchObject({ id: 'u1', edits: { files: 2, added: 4, removed: 2 } });
  });
});

describe('line diffs', () => {
  test('nothing for two empty texts, everything for a new one', () => {
    expect(lineDiffHunk('', '')).toEqual([]);
    expect(lineDiffHunk('', 'a\n')[0]!.lines).toEqual(['+a']);
    expect(lineDiffHunk('a\nb', '')[0]!.lines).toEqual(['-a', '-b']);
  });
});
