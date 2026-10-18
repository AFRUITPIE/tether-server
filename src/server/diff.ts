import type { DiffHunk } from '../protocol/index.ts';

/**
 * Line diffs as clients get them: hunks of lines prefixed `' '`, `'+'` or `'-'` (as Claude Code's
 * `structuredPatch` and a unified diff have them), bounded. Past `MAX_LINES_PER_FILE` lines a file's
 * lines are counted but not kept (a lockfile or a generated file can be hundreds of thousands, which
 * nobody reads), and a line is cut at `MAX_LINE_LENGTH` characters (a minified file is one line of
 * megabytes), with "…".
 */
export const MAX_LINES_PER_FILE = 5_000;
export const MAX_LINE_LENGTH = 1_000;

export type Bounded = { hunks: DiffHunk[]; added: number; removed: number; truncatedLines: number };

const clipLine = (line: string) => (line.length > MAX_LINE_LENGTH + 1 ? `${line.slice(0, MAX_LINE_LENGTH + 1)}…` : line);

/** Hunks with their lines counted (all of them) and kept (up to the caps). */
export function bounded(hunks: DiffHunk[]): Bounded {
  let added = 0;
  let removed = 0;
  let kept = 0;
  let truncatedLines = 0;
  const out: DiffHunk[] = [];
  for (const h of hunks) {
    const lines: string[] = [];
    for (const line of h.lines) {
      if (line.startsWith('+')) added++;
      else if (line.startsWith('-')) removed++;
      if (kept >= MAX_LINES_PER_FILE) {
        truncatedLines++;
        continue;
      }
      kept++;
      lines.push(clipLine(line));
    }
    if (lines.length) out.push({ ...h, lines });
  }
  return { hunks: out, added, removed, truncatedLines };
}

/** A text's lines: none for empty text, and a final newline doesn't start another. */
export function splitLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

/** A new file's whole content, as one hunk of added lines. */
export function addedHunk(content: string): DiffHunk[] {
  const lines = splitLines(content);
  return lines.length ? [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, lines: lines.map((l) => `+${l}`) }] : [];
}

/** Past this many cells, two texts are compared as all removed then all added. */
const MAX_DIFF_CELLS = 4_000_000;

/**
 * Two versions of some text compared line by line (a longest common subsequence), as one hunk
 * holding every line of both, each removal just before what replaced it. Where in the file it was
 * isn't known: `oldStart` and `newStart` are 0.
 */
export function lineDiffHunk(oldText: string, newText: string): DiffHunk[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  if (!a.length && !b.length) return [];
  const lines: string[] = [];
  if (a.length * b.length > MAX_DIFF_CELLS) {
    lines.push(...a.map((l) => `-${l}`), ...b.map((l) => `+${l}`));
  } else {
    // lcs[i][j]: the common subsequence's length of a[i…] and b[j…].
    const lcs = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
    for (let i = a.length - 1; i >= 0; i--)
      for (let j = b.length - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    let i = 0;
    let j = 0;
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) {
        lines.push(` ${a[i]}`);
        i++;
        j++;
      } else if (i < a.length && (j >= b.length || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) {
        lines.push(`-${a[i++]}`);
      } else {
        lines.push(`+${b[j++]}`);
      }
    }
  }
  return [{ oldStart: 0, oldLines: a.length, newStart: 0, newLines: b.length, lines }];
}

/** A patch as Claude Code's tools report it (`structuredPatch`), read tolerantly. */
export function hunksFromPatch(patch: unknown): DiffHunk[] {
  if (!Array.isArray(patch)) return [];
  const int = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : 0);
  return patch.flatMap((h: any) =>
    h && Array.isArray(h.lines)
      ? [{ oldStart: int(h.oldStart), oldLines: int(h.oldLines), newStart: int(h.newStart), newLines: int(h.newLines), lines: h.lines.filter((l: unknown) => typeof l === 'string') }]
      : [],
  );
}

/** A unified diff's file, as `parseUnifiedDiff` reads it. */
export type DiffFile = {
  path: string;
  oldPath?: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  binary: boolean;
  hunks: DiffHunk[];
};

/**
 * `git diff` output, file by file. Paths come from the `diff --git` line and the `---`/`+++` lines
 * (unquoted as git quotes them); a file's status from `new file`, `deleted file` and `rename` lines.
 */
export function parseUnifiedDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | undefined;
  let hunk: DiffHunk | undefined;
  let inHeader = false;
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git (?:"?a\/((?:[^"\\]|\\.)*?)"?) (?:"?b\/((?:[^"\\]|\\.)*?)"?)$/.exec(line);
      file = { path: unquote(m?.[2] ?? line.slice(line.lastIndexOf(' b/') + 3)), status: 'modified', binary: false, hunks: [] };
      const old = m?.[1] ? unquote(m[1]) : undefined;
      if (old && old !== file.path) file.oldPath = old;
      files.push(file);
      hunk = undefined;
      inHeader = true;
      continue;
    }
    if (!file) continue;
    if (inHeader) {
      if (line.startsWith('new file mode')) file.status = 'added';
      else if (line.startsWith('deleted file mode')) file.status = 'deleted';
      else if (line.startsWith('rename from ')) {
        file.oldPath = unquote(line.slice('rename from '.length));
        file.status = 'renamed';
      } else if (line.startsWith('rename to ')) {
        file.path = unquote(line.slice('rename to '.length));
        file.status = 'renamed';
      } else if (line.startsWith('Binary files ') || line === 'GIT binary patch') file.binary = true;
      else if (line.startsWith('+++ ')) {
        const p = line.slice(4);
        if (p !== '/dev/null') file.path = unquote(p.replace(/^"?b\//, '').replace(/"$/, ''));
      } else if (line.startsWith('--- ')) continue;
    }
    const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line);
    if (h) {
      inHeader = false;
      hunk = {
        oldStart: Number(h[1]),
        oldLines: h[2] === undefined ? 1 : Number(h[2]),
        newStart: Number(h[3]),
        newLines: h[4] === undefined ? 1 : Number(h[4]),
        lines: [],
        ...(h[5]?.trim() ? { header: h[5].trim() } : {}),
      };
      file.hunks.push(hunk);
      continue;
    }
    if (hunk && (line.startsWith('+') || line.startsWith('-') || line.startsWith(' ') || line.startsWith('\\'))) hunk.lines.push(line);
  }
  return files;
}

/** A path as git writes it, its C-style quoting undone (`"a\\tb"`, octal escapes for UTF-8). */
function unquote(p: string): string {
  if (!p.includes('\\')) return p.replace(/^"|"$/g, '');
  const bytes: number[] = [];
  const s = p.replace(/^"|"$/g, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c !== '\\') {
      bytes.push(...Buffer.from(c, 'utf8'));
      continue;
    }
    const next = s[++i]!;
    if (/[0-7]/.test(next)) {
      bytes.push(parseInt(s.slice(i, i + 3), 8));
      i += 2;
    } else bytes.push(({ n: 10, t: 9, r: 13, '"': 34, '\\': 92, a: 7, b: 8, f: 12, v: 11 } as Record<string, number>)[next] ?? next.charCodeAt(0));
  }
  return Buffer.from(bytes).toString('utf8');
}
