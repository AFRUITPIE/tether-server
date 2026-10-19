import type { FileEdit, ToolCallItem, TurnEdits } from '../protocol/index.ts';
import { addedHunk, bounded, hunksFromPatch, lineDiffHunk } from '../server/diff.ts';

type AnyObj = Record<string, any>;

/** A call that edits a file: its `edit` says how, once it has finished. */
export const isEditCall = (t: ToolCallItem) => t.kind === 'fileEdit' || t.kind === 'fileWrite' || t.kind === 'notebookEdit';

/**
 * What a finished edit call changed: Claude Code's `structuredPatch` when its result has one (live,
 * or read back from the transcript), else the call's own input compared (an Edit's old and new
 * text, each of a MultiEdit's; a Write's or a new notebook cell's content, all added).
 */
export function editOf(t: ToolCallItem, structured: unknown): FileEdit | undefined {
  if (!isEditCall(t) || t.status !== 'completed' || t.isError) return undefined;
  const input = (t.input ?? {}) as AnyObj;
  const out = (structured ?? {}) as AnyObj;
  const path = [out.filePath, input.file_path, input.notebook_path].find((p) => typeof p === 'string' && p);
  if (!path) return undefined;
  let hunks = hunksFromPatch(out.structuredPatch);
  const created = t.kind === 'fileWrite' && out.type === 'create';
  if (!hunks.length) {
    if (t.kind === 'fileWrite') {
      // A Write over a file that's unchanged has an empty patch; with none at all, it's all added.
      if (out.type !== 'update' || !Array.isArray(out.structuredPatch)) hunks = addedHunk(String(input.content ?? out.content ?? ''));
    } else if (t.kind === 'notebookEdit') {
      if (input.edit_mode !== 'delete') hunks = addedHunk(String(input.new_source ?? ''));
    } else if (!Array.isArray(out.structuredPatch)) {
      const edits: AnyObj[] = typeof input.old_string === 'string' ? [input] : Array.isArray(input.edits) ? input.edits : [];
      hunks = edits.flatMap((e) => lineDiffHunk(String(e.old_string ?? ''), String(e.new_string ?? '')));
    }
  }
  const b = bounded(hunks);
  return {
    path,
    hunks: b.hunks,
    added: b.added,
    removed: b.removed,
    ...(b.truncatedLines ? { truncatedLines: b.truncatedLines } : {}),
    ...(created ? { created: true } : {}),
  };
}

/** An edit call's output without what its `edit` holds and the file's whole text. */
export function trimmedEditOutput(structured: unknown): unknown {
  if (!structured || typeof structured !== 'object' || Array.isArray(structured)) return structured;
  const { structuredPatch: _p, originalFile: _o, content: _c, ...rest } = structured as AnyObj;
  return rest;
}

/** The totals of some edits: how many files, lines added and removed. */
export function totalsOf(edits: Iterable<FileEdit>): TurnEdits | undefined {
  const paths = new Set<string>();
  let added = 0;
  let removed = 0;
  for (const e of edits) {
    paths.add(e.path);
    added += e.added;
    removed += e.removed;
  }
  return paths.size ? { files: paths.size, added, removed } : undefined;
}
