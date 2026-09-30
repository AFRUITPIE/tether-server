import { getSessionMessages, type SessionMessage, type SessionStore } from '@anthropic-ai/claude-agent-sdk';
import { open, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** A session's stored history, and what a follower needs to go on reading it. */
export type StoredHistory = {
  messages: SessionMessage[];
  path?: string;
  /** How far into the file the history was read, to the end of its last whole line. */
  end?: number;
  /** The compaction boundaries read, for `markCompaction` on the SDK's later reads. */
  boundaries?: Map<string, Entry>;
};

/**
 * A session's stored history, from its start. The Agent SDK's `getSessionMessages` rebuilds only
 * the current chain: it walks `parentUuid` back from the newest message and stops at the chain's
 * root, and every compaction starts a new one (a `compact_boundary` whose parent is null), as does
 * a parent missing from the file. The earlier chains are still in the transcript, so they're read
 * from it and put before the SDK's result, which is kept as it is.
 *
 * From each chain's root the one before it ends at the boundary's `logicalParentUuid`, or at the
 * nearest main-chain message above a missing parent, and runs back along its parents to its own
 * root. Following parents rather than file order leaves out what a rewind or fork abandoned. Each
 * chain is converted by the SDK itself (`getSessionMessages` over just its lines), so it comes out
 * as the current one does.
 */
export async function storedHistory(sessionId: string, dir?: string): Promise<StoredHistory> {
  const current = await getSessionMessages(sessionId, { ...(dir ? { dir } : {}), includeSystemMessages: true });
  const path = current.length ? await sessionFile(sessionId, dir) : undefined;
  if (!path) return { messages: current };
  // Unreadable (gone, say) is only the history the SDK found.
  const earlier = await earlierThan(sessionId, path, current).catch(() => undefined);
  if (!earlier) return { messages: current, path };
  const seen = new Set(earlier.messages.map((m) => m.uuid));
  // A compaction keeps its last few messages after the summary; they stay where they were written.
  const later = current.filter((m) => !seen.has(m.uuid)).map((m) => markCompaction(m, earlier.boundaries));
  return { messages: [...earlier.messages, ...later], path, end: earlier.end, boundaries: earlier.boundaries };
}

/** Feeds a long history to an itemizer a batch at a time, letting other work in between. */
export async function ingestAll(messages: SessionMessage[], ingest: (m: SessionMessage) => void): Promise<void> {
  for (let i = 0; i < messages.length; i++) {
    ingest(messages[i]!);
    if (i % 2000 === 1999) await new Promise((resolve) => setImmediate(resolve));
  }
}

// ---------- the transcript ----------

export type Entry = Record<string, any>;

type Transcript = {
  /** The lines the SDK reads (those with a uuid, of these kinds), in file order. */
  entries: Entry[];
  index: Map<string, number>;
  /** Assistant lines by API message id: the CLI writes a reply's blocks as lines of their own. */
  byMessageId: Map<string, number[]>;
  /** Tool-result lines by parent. */
  resultsByParent: Map<string, number[]>;
  boundaries: Map<string, Entry>;
  end: number;
};

const KINDS = new Set(['user', 'assistant', 'progress', 'system', 'attachment']);
const CHUNK = 1024 * 1024;

/**
 * Reads the transcript a chunk at a time, yielding between chunks: one can be hundreds of
 * megabytes. Lines that can't reach the history are kept as stubs (a subagent's, progress, most
 * attachments), and a tool result's structured copy is dropped, since the SDK's messages don't
 * carry it.
 */
async function readTranscript(path: string): Promise<Transcript> {
  const t: Transcript = { entries: [], index: new Map(), byMessageId: new Map(), resultsByParent: new Map(), boundaries: new Map(), end: 0 };
  const fh = await open(path, 'r');
  try {
    const chunk = Buffer.allocUnsafe(CHUNK);
    let rest: Buffer = Buffer.alloc(0);
    let offset = 0;
    for (;;) {
      const { bytesRead } = await fh.read(chunk, 0, CHUNK, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
      const buf = rest.length ? Buffer.concat([rest, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
      let start = 0;
      for (let nl = buf.indexOf(10); nl >= 0; nl = buf.indexOf(10, start)) {
        if (nl > start) take(t, buf.toString('utf8', start, nl));
        start = nl + 1;
      }
      t.end = offset - (buf.length - start);
      rest = Buffer.from(buf.subarray(start));
      await new Promise((resolve) => setImmediate(resolve));
    }
  } finally {
    await fh.close();
  }
  return t;
}

function take(t: Transcript, line: string): void {
  let e: Entry;
  try {
    e = JSON.parse(line);
  } catch {
    return;
  }
  if (typeof e?.uuid !== 'string' || !KINDS.has(e.type)) return;
  const quoted = e.type === 'attachment' && e.attachment?.type === 'queued_command'; // becomes a prompt
  if (e.isSidechain || e.teamName || e.type === 'progress' || (e.type === 'attachment' && !quoted)) {
    e = {
      type: e.type,
      uuid: e.uuid,
      parentUuid: e.parentUuid ?? null,
      ...(e.isSidechain ? { isSidechain: true } : {}),
      ...(e.teamName ? { teamName: e.teamName } : {}),
      timestamp: e.timestamp,
    };
  } else {
    delete e.toolUseResult;
  }
  const i = t.entries.push(e) - 1;
  t.index.set(e.uuid, i);
  const id = messageId(e);
  if (id) push(t.byMessageId, id, i);
  if (isToolResult(e)) push(t.resultsByParent, e.parentUuid, i);
  if (isBoundary(e)) t.boundaries.set(e.uuid, e);
}

function push(map: Map<string, number[]>, key: string, i: number): void {
  const list = map.get(key);
  if (list) list.push(i);
  else map.set(key, [i]);
}

const messageId = (e: Entry): string | undefined =>
  e.type === 'assistant' && typeof e.message?.id === 'string' ? e.message.id : undefined;

const isToolResult = (e: Entry): boolean =>
  e.type === 'user' &&
  !!e.parentUuid &&
  Array.isArray(e.message?.content) &&
  e.message.content.some((b: Entry) => b?.type === 'tool_result');

const isBoundary = (e: Entry): boolean => e.type === 'system' && e.subtype === 'compact_boundary';

// ---------- earlier chains ----------

/**
 * The last read's earlier chains, which stay as they are while the file only grows and its current
 * chain starts where it did (a new compaction starts another). One is kept, for a minute: a followed
 * chat resuming here, or switched back to, isn't read again, and one nobody reopens doesn't hold on
 * to a long transcript (a few hundred megabytes of it for a session that size).
 */
let recent: (Earlier & { path: string; dev: number; ino: number; first: string }) | undefined;
let forget: ReturnType<typeof setTimeout> | undefined;
const RECENT_MS = 60_000;

type Earlier = { messages: SessionMessage[]; boundaries: Map<string, Entry>; end: number };

async function earlierThan(sessionId: string, path: string, current: SessionMessage[]): Promise<Earlier | undefined> {
  const file = await stat(path).catch(() => undefined);
  if (!file) return undefined;
  const first = current[0]!.uuid;
  const same = recent && recent.path === path && recent.dev === file.dev && recent.ino === file.ino && recent.first === first;
  if (!same || file.size < recent!.end) {
    const t = await readTranscript(path);
    const from = current.find((m) => t.index.has(m.uuid));
    const messages = from ? await chainsBefore(sessionId, t, t.index.get(from.uuid)!) : [];
    recent = { messages, boundaries: t.boundaries, end: t.end, path, dev: file.dev, ino: file.ino, first };
  }
  if (forget) clearTimeout(forget);
  forget = setTimeout(() => (recent = undefined), RECENT_MS);
  forget.unref?.();
  return recent;
}

/** Forgets the last read, so the next reads the file again. For tests. */
export function forgetStoredHistory(): void {
  recent = undefined;
}

async function chainsBefore(sessionId: string, t: Transcript, from: number): Promise<SessionMessage[]> {
  const chains: SessionMessage[][] = [];
  const visited = new Set<number>();
  for (let root = from, last = lastBefore(t, root); last !== undefined; last = lastBefore(t, root)) {
    const chain = chainTo(t, last, visited);
    if (!chain.length || chain[0]! >= root) break;
    chains.unshift(await messagesOf(sessionId, t, chain));
    root = chain[0]!;
  }
  const seen = new Set<string>();
  return chains.flat().filter((m) => !seen.has(m.uuid) && !!seen.add(m.uuid));
}

/**
 * The last message of the chain before the one starting at `root`: where a compaction's boundary
 * says the conversation went on from, or for a missing parent the nearest main-chain message above.
 * A root with no parent that isn't a boundary is where the session began.
 */
function lastBefore(t: Transcript, root: number): number | undefined {
  const e = t.entries[root]!;
  const above = (i: number | undefined) => (i !== undefined && i < root ? i : nearestAbove(t, root));
  if (isBoundary(e)) return above(e.logicalParentUuid ? t.index.get(e.logicalParentUuid) : undefined);
  if (!e.parentUuid) return undefined;
  // Present, when the SDK's chain stopped short of it: it reads a large file from its last boundary.
  return above(t.index.get(e.parentUuid));
}

function nearestAbove(t: Transcript, i: number): number | undefined {
  for (let j = i - 1; j >= 0; j--) {
    const e = t.entries[j]!;
    if (!e.isSidechain && (e.type === 'user' || e.type === 'assistant')) return j;
  }
  return undefined;
}

/** `last` and its ancestors, oldest first, stopping at a root, a missing parent or a line already taken. */
function chainTo(t: Transcript, last: number, visited: Set<number>): number[] {
  const chain: number[] = [];
  for (let i: number | undefined = last; i !== undefined && !visited.has(i); ) {
    visited.add(i);
    chain.push(i);
    const parent: string | null | undefined = t.entries[i]!.parentUuid;
    i = parent ? t.index.get(parent) : undefined;
  }
  return chain.reverse();
}

/**
 * One earlier chain as the SDK's messages, by handing `getSessionMessages` just its lines. The SDK
 * starts from the newest user or assistant line (passing over meta ones) and adds back the parts of
 * a reply the chain went around, with their tool results. So the chain is cut after its last such
 * line and put after those parts, and the boundary's relinking of the messages a compaction kept is
 * left out: they're already here, at the end of the chain before.
 */
async function messagesOf(sessionId: string, t: Transcript, chain: number[]): Promise<SessionMessage[]> {
  let n = chain.length;
  while (n > 0 && !startsHistory(t.entries[chain[n - 1]!]!)) n--;
  if (!n) return [];
  const kept = chain.slice(0, n);
  const parts = partsOf(t, kept, new Set(kept)).map((i) => t.entries[i]!);
  const lines = [...parts, ...kept.map((i) => unlinked(t.entries[i]!))];
  const store: SessionStore = { append: async () => {}, load: async () => lines as never };
  const messages = await getSessionMessages(sessionId, { includeSystemMessages: true, sessionStore: store });
  return messages.map((m) => markCompaction(m, t.boundaries));
}

const startsHistory = (e: Entry): boolean =>
  (e.type === 'user' || e.type === 'assistant') && !e.isMeta && !e.isSidechain && !e.teamName;

/** Lines off the chain the SDK adds back: other lines of its replies, and their tool results. */
function partsOf(t: Transcript, chain: number[], on: Set<number>): number[] {
  const out = new Set<number>();
  for (const i of chain) {
    const id = messageId(t.entries[i]!);
    if (!id) continue;
    for (const j of t.byMessageId.get(id) ?? []) {
      if (!on.has(j)) out.add(j);
      for (const k of t.resultsByParent.get(t.entries[j]!.uuid) ?? []) if (!on.has(k)) out.add(k);
    }
  }
  return [...out].sort((a, b) => a - b);
}

function unlinked(e: Entry): Entry {
  if (!isBoundary(e) || !e.compactMetadata) return e;
  const { preservedSegment: _s, preservedMessages: _m, ...compactMetadata } = e.compactMetadata;
  return { ...e, compactMetadata };
}

// ---------- compactions ----------

/**
 * A compaction's boundary as the live stream carries it. The SDK's history keeps a system message's
 * type and uuid but not its subtype or metadata, which the itemizer needs to mark the compaction.
 */
export function markCompaction(m: SessionMessage, boundaries: Map<string, Entry>): SessionMessage {
  const b = m.type === 'system' ? boundaries.get(m.uuid) : undefined;
  if (!b) return m;
  const md = b.compactMetadata ?? {};
  return {
    ...m,
    subtype: 'compact_boundary',
    compact_metadata: {
      ...(md.trigger ? { trigger: md.trigger } : {}),
      ...(typeof md.preTokens === 'number' ? { pre_tokens: md.preTokens } : {}),
      ...(typeof md.postTokens === 'number' ? { post_tokens: md.postTokens } : {}),
    },
  } as SessionMessage;
}

/** Compaction boundaries among transcript lines, by uuid, for `markCompaction`. */
export function boundariesIn(lines: string[], into = new Map<string, Entry>()): Map<string, Entry> {
  for (const line of lines) {
    if (!line.includes('"compact_boundary"')) continue;
    try {
      const e = JSON.parse(line);
      if (typeof e?.uuid === 'string' && isBoundary(e)) into.set(e.uuid, e);
    } catch {
      // a line still being written
    }
  }
  return into;
}

// ---------- where the transcript is ----------

/** Claude Code's configuration directory, whose `projects/` holds the transcripts. */
export function claudeConfigDir(): string {
  return (process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')).normalize('NFC');
}

/**
 * The folder under `projects/` Claude Code keeps a directory's sessions in: its path with each
 * character outside [A-Za-z0-9] made `-`, and a long one cut to 200 and told apart by a hash of
 * the whole.
 */
export function projectDirName(dir: string): string {
  const name = dir.replace(/[^a-zA-Z0-9]/g, '-');
  if (name.length <= 200) return name;
  let hash = 0;
  for (let i = 0; i < dir.length; i++) hash = ((hash << 5) - hash + dir.charCodeAt(i)) | 0;
  return `${name.slice(0, 200)}-${Math.abs(hash).toString(36)}`;
}

/**
 * Where a session's transcript is, looked for as the Agent SDK looks: in the folder for the
 * directory's real path, else in every project folder (which also covers the SDK's next places, the
 * directory's git worktrees and a configured project folder name, without running git).
 */
export async function sessionFile(sessionId: string, dir?: string): Promise<string | undefined> {
  const projects = join(claudeConfigDir(), 'projects');
  const at = async (folder: string) => {
    const path = join(projects, folder, `${sessionId}.jsonl`);
    const s = await stat(path).catch(() => undefined);
    return s?.isFile() && s.size > 0 ? path : undefined;
  };
  if (dir) {
    const real = (await realpath(dir).catch(() => dir)).normalize('NFC');
    const found = await at(projectDirName(real));
    if (found) return found;
  }
  let folders;
  try {
    folders = await readdir(projects, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const f of folders) {
    const found = f.isDirectory() ? await at(f.name) : undefined;
    if (found) return found;
  }
  return undefined;
}
