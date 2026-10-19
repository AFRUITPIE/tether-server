import { getSessionMessages, type SessionMessage, type SessionStore } from '@anthropic-ai/claude-agent-sdk';
import { createReadStream, existsSync, readdirSync } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { EffortLevel, PermissionMode } from '../protocol/index.ts';
import { EffortLevel as EffortLevelSchema, PermissionMode as PermissionModeSchema } from '../protocol/common.ts';
import { isWakeup, Itemizer, type Emission } from './itemizer.ts';
import { agentPromptReader, isSafeId, readRunJournal, readRunRecord, runResultReader, workflowAgentLocator, workflowCallLocator } from './workflows.ts';

/**
 * Claude Code's transcripts: where a session's file is, its history across compactions, what only
 * the raw file holds (`TranscriptExtras`), the settings and cwd it records, and reading it into an
 * itemizer (`readTranscript`). One file, `~/.claude/projects/<project>/<session id>.jsonl`, a JSON
 * record a line; the session's folder of the same name beside it holds its workflows' files.
 */

export type RawRecord = Record<string, any>;

// ---------- where a session's files are ----------

/** Where the CLI keeps its projects: CLAUDE_CONFIG_DIR, else ~/.claude, as the CLI and the SDK look. */
const projectsRoot = () => join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects');

/** Transcripts found, by projects folder and session id: a session's file doesn't move. */
const located = new Map<string, string>();

/**
 * A session's transcript. The project folder's name is the CLI's own flattening of the cwd, so the
 * file is looked for rather than its path derived; once found it's remembered while it's there.
 */
export function transcriptFile(sessionId: string): string | undefined {
  if (!isSafeId(sessionId)) return undefined;
  const root = projectsRoot();
  const key = `${root}\0${sessionId}`;
  const known = located.get(key);
  if (known && existsSync(known)) return known;
  located.delete(key);
  let projects: string[];
  try {
    projects = readdirSync(root);
  } catch {
    return undefined;
  }
  for (const p of projects) {
    const file = join(root, p, `${sessionId}.jsonl`);
    if (!existsSync(file)) continue;
    located.set(key, file);
    return file;
  }
  return undefined;
}

/** A session's folder (`<project>/<session id>`), beside its transcript, where its workflows' files are. */
export function sessionDir(sessionId: string): string | undefined {
  return transcriptFile(sessionId)?.slice(0, -'.jsonl'.length);
}

// ---------- reading records ----------

type Read = { records: RawRecord[]; sizes: number[]; end: number };

/**
 * The file's complete records from byte `start` on, each line parsed where it lies in the buffer
 * (no string of the whole file), those `keep` passes at a look. `end` stops before a line still
 * being written; a line that isn't JSON (damaged) is skipped, as the SDK skips it. `midLine`: `start`
 * may be inside a line, which is skipped.
 */
export async function readRecords(path: string, start = 0, opts: { keep?: (line: Buffer) => boolean; midLine?: boolean } = {}): Promise<Read> {
  const fh = await open(path, 'r');
  let buf: Buffer;
  try {
    const { size } = await fh.stat();
    buf = Buffer.allocUnsafe(Math.max(0, size - start));
    const { bytesRead } = await fh.read(buf, 0, buf.length, start);
    buf = buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
  const out: Read = { records: [], sizes: [], end: start };
  let at = opts.midLine && start > 0 ? buf.indexOf(0x0a) + 1 : 0;
  if (at === 0 && opts.midLine && start > 0) return out;
  let pause = at + YIELD_BYTES;
  for (let nl = buf.indexOf(0x0a, at); nl >= 0; at = nl + 1, nl = buf.indexOf(0x0a, at)) {
    // A long chat takes a few hundred milliseconds to parse: other threads' streams go on meanwhile.
    if (at > pause) {
      await new Promise((resolve) => setImmediate(resolve));
      pause = at + YIELD_BYTES;
    }
    if (nl - at < 2 || (opts.keep && !opts.keep(buf.subarray(at, nl)))) continue;
    try {
      const r = JSON.parse(buf.toString('utf8', at, nl));
      if (r && typeof r === 'object') {
        out.records.push(r);
        out.sizes.push(nl - at);
      }
    } catch {
      // damaged, or not a record
    }
  }
  out.end = start + at;
  return out;
}

/** How much is parsed before letting the event loop run. */
const YIELD_BYTES = 4 * 1024 * 1024;

/** A line holding one of these strings (as JSON writes them): a cheap look before parsing it. */
const holding = (needles: string[]) => {
  const bufs = needles.map((n) => Buffer.from(n));
  return (line: Buffer) => bufs.some((b) => line.includes(b));
};

// ---------- history across compactions ----------

export type History = {
  messages: SessionMessage[];
  /** Every record of the file, in order (none when it couldn't be read here). */
  records: RawRecord[];
  sizes: number[];
  /** How far into the file was read. */
  end: number;
};

/**
 * A session's messages from its first. `getSessionMessages` follows the chain of messages back from
 * the latest one, and the chain starts again at every compaction (a boundary has no parent) and at
 * some resumes, so a chat compacted once showed nothing from before it. The file is read and parsed
 * once, here, and each chain handed to the SDK as a session store, so the SDK's own chain-building
 * picks its messages: the latest chain, then each one ending before the first message of the chain
 * after it, until the start of the file. A message kept across a compaction is listed once, where
 * it was first said.
 *
 * The SDK also drops what makes a boundary a compaction (its subtype and token counts) and a
 * summary Claude Code's (`isCompactSummary`); they're put back from the file (`restored`), so a
 * compaction is its line in the chat and its summary isn't shown as the person's prompt.
 */
export async function readSessionHistory(sessionId: string, dir: string | undefined, path: string | undefined): Promise<History> {
  const options = { ...(dir ? { dir } : {}), includeSystemMessages: true };
  const read = path ? await readRecords(path).catch(() => undefined) : undefined;
  if (!read) return { messages: await getSessionMessages(sessionId, options), records: [], sizes: [], end: 0 };
  const { records } = read;
  const chains = new Chains(sessionId, records, options);
  const segments: SessionMessage[][] = [];
  let end = records.length;
  while (end > 0) {
    const chain = await chains.endingBefore(end);
    const start = chain.length ? chains.index.get(chain[0]!.uuid) : undefined;
    // Nothing more to read, or no earlier start: stop rather than read the same chain again.
    if (start === undefined || start >= end) break;
    segments.unshift(chain);
    end = start;
  }
  // A message Claude Code kept across a compaction comes again after its summary: it stays where
  // it was first said.
  const seen = new Set<string>();
  const messages = segments.flat().filter((m) => !seen.has(m.uuid) && (seen.add(m.uuid), true));
  return { ...read, messages: messages.map((m) => restored(m, records[chains.index.get(m.uuid) ?? -1])) };
}

/**
 * The chains of a file's records, as the SDK builds them. Each is built from the records since the
 * latest record before it with no parent (a compaction's boundary, a chat's first message), reaching
 * back to a compaction's preserved messages; one that turns out to go back further is built from
 * the start of the file, as the SDK would have.
 */
class Chains {
  readonly index = new Map<string, number>();
  /** Records with no parent, in order: where a chain can start. */
  private roots: number[] = [];

  constructor(
    private sessionId: string,
    private records: RawRecord[],
    private options: { dir?: string; includeSystemMessages: boolean },
  ) {
    records.forEach((r, i) => {
      if (typeof r.uuid !== 'string') return;
      this.index.set(r.uuid, i);
      if (!r.parentUuid) this.roots.push(i);
    });
  }

  async endingBefore(end: number): Promise<SessionMessage[]> {
    let from = 0;
    for (let i = this.roots.length - 1; i >= 0; i--)
      if (this.roots[i]! < end) {
        from = this.roots[i]!;
        break;
      }
    from = Math.min(from, this.preservedFrom(from, end));
    const chain = await chainOf(this.sessionId, this.records.slice(from, end), this.options);
    if (from === 0) return chain;
    const first = chain.length ? this.records[this.index.get(chain[0]!.uuid) ?? -1] : undefined;
    const parent = typeof first?.parentUuid === 'string' ? this.index.get(first.parentUuid) : undefined;
    if (chain.length && (parent === undefined || parent >= from)) return chain;
    return chainOf(this.sessionId, this.records.slice(0, end), this.options);
  }

  /** The earliest record a compaction in `from…end` relinks into its chain (its preserved messages). */
  private preservedFrom(from: number, end: number): number {
    let earliest = from;
    for (let i = from; i < end; i++) {
      const md = this.records[i]!.compactMetadata;
      if (!md || !isBoundary(this.records[i]!)) continue;
      const uuids: unknown[] = [md.preservedSegment?.headUuid, md.preservedSegment?.tailUuid, md.preservedSegment?.anchorUuid, md.preservedMessages?.anchorUuid, ...(md.preservedMessages?.uuids ?? [])];
      for (const u of uuids) {
        const at = typeof u === 'string' ? this.index.get(u) : undefined;
        if (at !== undefined && at < earliest) earliest = at;
      }
    }
    return earliest;
  }
}

/** The chain of messages the SDK reads from these records: the one ending at the latest of them. */
async function chainOf(sessionId: string, records: RawRecord[], options: { dir?: string; includeSystemMessages: boolean }): Promise<SessionMessage[]> {
  const store: SessionStore = {
    append: async () => {},
    // The session alone: a subagent's own transcript isn't part of the chat's messages.
    load: async (key) => (key.subpath ? null : (records as never)),
  };
  try {
    return await getSessionMessages(sessionId, { ...options, sessionStore: store });
  } catch {
    return [];
  }
}

const isBoundary = (r: RawRecord) => r.type === 'system' && r.subtype === 'compact_boundary';

/** A message with what the SDK left out of a compaction's boundary and summary put back. */
export function restored(m: SessionMessage, raw: RawRecord | undefined): SessionMessage {
  if (!raw) return m;
  if (m.type === 'system' && isBoundary(raw)) {
    const md = raw.compactMetadata ?? {};
    return {
      ...m,
      subtype: 'compact_boundary',
      compact_metadata: { trigger: md.trigger, pre_tokens: md.preTokens, post_tokens: md.postTokens },
    } as SessionMessage;
  }
  if (m.type === 'user' && raw.isCompactSummary === true) return { ...m, isCompactSummary: true } as SessionMessage;
  return m;
}

/**
 * New messages as a session's file grows, for a reader that has read it up to here: what's
 * appended is read and parsed alone, and the SDK builds the chain from it and the latest records
 * before it (`RECENT_*`), which is where anything new joins the chain. A message is handed over
 * once, by its uuid, so a compaction or a rewind that starts the chain again says only what's new.
 */
export class TranscriptTail {
  private recent: RawRecord[] = [];
  private recentSizes: number[] = [];
  private seen = new Set<string>();
  offset = 0;

  constructor(
    private sessionId: string,
    private cwd: string | undefined,
  ) {}

  /** Starts from what a read of the whole file found. */
  begin(history: History) {
    for (const m of history.messages) this.seen.add(m.uuid);
    this.offset = history.end;
    this.keep(history.records, history.sizes, 0);
    this.slim(this.recent.length);
  }

  /** What has been appended since the last read: its records, and the messages new among them. */
  async read(path: string): Promise<{ records: RawRecord[]; messages: SessionMessage[] }> {
    const { size } = await stat(path);
    if (size < this.offset) {
      // Rewritten, not appended: read again from the start (what was said isn't said again).
      this.offset = 0;
      this.recent = [];
      this.recentSizes = [];
    }
    const read = await readRecords(path, this.offset);
    this.offset = read.end;
    if (!read.records.length) return { records: [], messages: [] };
    this.keep(read.records, read.sizes);
    const chain = await chainOf(this.sessionId, this.recent, { ...(this.cwd ? { dir: this.cwd } : {}), includeSystemMessages: true });
    const fresh = chain.filter((m) => !this.seen.has(m.uuid));
    for (const m of fresh) this.seen.add(m.uuid);
    const byUuid = new Map(read.records.flatMap((r) => (typeof r.uuid === 'string' ? [[r.uuid as string, r] as const] : [])));
    const messages = fresh.map((m) => restored(m, byUuid.get(m.uuid)));
    this.slim(read.records.length);
    return { records: read.records, messages };
  }

  /**
   * What the chain needs of the last `count` records kept, once what's new among them has been
   * said: a message already said keeps only its place in the chain (its content, tool output and
   * images are the itemizer's now), anything else what the SDK reads to link and convert records.
   */
  private slim(count: number) {
    for (let i = Math.max(0, this.recent.length - count); i < this.recent.length; i++) {
      const r = this.recent[i]!;
      if ((r.type === 'user' || r.type === 'assistant') && !this.seen.has(r.uuid)) continue;
      const kept: RawRecord = {};
      for (const k of LINKS) if (r[k] !== undefined) kept[k] = r[k];
      // A message's id and its calls' and results' ids: the SDK puts parallel calls' results in the chain by them.
      if (r.message) kept.message = { role: r.message.role, id: r.message.id, content: Array.isArray(r.message.content) ? r.message.content.flatMap(callIds) : [] };
      if (r.attachment) kept.attachment = r.attachment.type === 'queued_command' ? r.attachment : { type: r.attachment.type };
      const md = r.compactMetadata;
      if (md) kept.compactMetadata = { preservedSegment: md.preservedSegment, preservedMessages: md.preservedMessages };
      this.recent[i] = kept;
      this.recentSizes[i] = 256;
    }
  }

  /**
   * The latest records, at most `RECENT_RECORDS` and `RECENT_BYTES` of them, but always the last
   * `whole` (those just read, which anything new is among).
   */
  private keep(records: RawRecord[], sizes: number[], whole = records.length) {
    for (let i = 0; i < records.length; i++) {
      this.recent.push(records[i]!);
      this.recentSizes.push(sizes[i]!);
    }
    let bytes = this.recentSizes.reduce((a, b) => a + b, 0);
    let drop = 0;
    while (drop < this.recent.length - whole && (this.recent.length - drop > RECENT_RECORDS || bytes > RECENT_BYTES)) bytes -= this.recentSizes[drop++]!;
    if (drop) {
      this.recent.splice(0, drop);
      this.recentSizes.splice(0, drop);
    }
  }
}

const RECENT_RECORDS = 2000;
const RECENT_BYTES = 16 * 1024 * 1024;
/** What the SDK reads of a record to place it in the chain and convert it (`slim`). */
const LINKS = [
  'uuid', 'parentUuid', 'logicalParentUuid', 'type', 'subtype', 'sessionId', 'timestamp', 'isSidechain', 'teamName', 'agentId',
  'sourceToolAssistantUUID', 'isMeta', 'isCompactSummary', 'isVisibleInTranscriptOnly', 'origin', 'promptSource', 'operation',
  'reason', 'deliveryId', 'commandUuid',
] as const;

/** A content block's ids alone: a call's, or the call a result answers. */
const callIds = (b: any): RawRecord[] => {
  if (b?.type === 'tool_use') return [{ type: 'tool_use', id: b.id }];
  if (b?.type === 'tool_result') return [{ type: 'tool_result', tool_use_id: b.tool_use_id }];
  return [];
};

/**
 * `read`, never two at once: called while it runs, it runs once more right after (what was
 * appended meanwhile is read then), and the caller waits for that.
 */
export function oneAtATime(read: () => Promise<void>): () => Promise<void> {
  let running: Promise<void> | undefined;
  let again = false;
  return () => {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          again = false;
          await read();
        } while (again);
      } finally {
        running = undefined;
      }
    })();
    return running;
  };
}

// ---------- what a transcript records ----------

/** The first `cwd` a transcript's lines carry, read a line at a time until it turns up. */
export async function recordedCwd(path: string): Promise<string | undefined> {
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.includes('"cwd"')) continue;
      try {
        const cwd = JSON.parse(line).cwd;
        if (typeof cwd === 'string' && cwd) return cwd;
      } catch {
        // a line still being written
      }
    }
  } catch {
    // unreadable: no cwd
  } finally {
    lines.close();
  }
  return undefined;
}

/**
 * The cwd a session's transcript records. The SDK looks for it only near the top of the file, which
 * a first message carrying images can push past, leaving the session without one.
 */
export async function transcriptCwd(sessionId: string): Promise<string | undefined> {
  const path = transcriptFile(sessionId);
  return path ? recordedCwd(path) : undefined;
}

export type SessionSettings = { model?: string; effort?: EffortLevel; permissionMode?: PermissionMode };

const EFFORT: readonly string[] = EffortLevelSchema.options;
const PERMISSION: readonly string[] = PermissionModeSchema.options;

/**
 * The latest model and effort (on assistant records) and permission mode (on user records): what
 * getSessionMessages leaves out (it keeps each message's model but drops the `effort` beside it and
 * the `permissionMode` on user turns). Values the protocol has no case for are left out.
 */
export function settingsOf(records: readonly RawRecord[]): SessionSettings {
  const out: SessionSettings = {};
  for (let i = records.length - 1; i >= 0 && !(out.model && out.permissionMode); i--) {
    const o = records[i]!;
    if (o.isSidechain) continue; // a subagent's turn, not the session's
    // An error the CLI wrote itself carries the model `<synthetic>`, not the one in use.
    if (!out.model && o.type === 'assistant' && typeof o.message?.model === 'string' && o.message.model !== '<synthetic>') {
      out.model = o.message.model;
      if (typeof o.effort === 'string' && EFFORT.includes(o.effort)) out.effort = o.effort as EffortLevel;
    }
    if (!out.permissionMode && o.type === 'user' && PERMISSION.includes(o.permissionMode)) out.permissionMode = o.permissionMode as PermissionMode;
  }
  return out;
}

/** `settings` with what newer records say over it: a newer model brings its effort, or none. */
export function newerSettings(settings: SessionSettings, records: readonly RawRecord[]): SessionSettings {
  const newer = settingsOf(records);
  const next = { ...settings };
  if (newer.model) {
    next.model = newer.model;
    if (newer.effort) next.effort = newer.effort;
    else delete next.effort;
  }
  if (newer.permissionMode) next.permissionMode = newer.permissionMode;
  return next;
}

/** Most lines are tool output; only these can carry a setting. */
const mayHoldSettings = holding(['"assistant"', '"permissionMode"']);

/**
 * The settings a transcript records, from its tail, widened while they aren't all found: a long
 * turn of tool output (screenshots especially) can put the last prompt, and so the permission
 * mode, megabytes back.
 */
export async function recordedSettings(path: string): Promise<{ settings: SessionSettings; end: number }> {
  let read = { settings: {} as SessionSettings, end: 0 };
  try {
    const { size } = await stat(path);
    for (const bytes of [256 * 1024, 4 * 1024 * 1024, Infinity]) {
      const start = Math.max(0, size - bytes);
      const tail = await readRecords(path, start, { keep: mayHoldSettings, midLine: true });
      read = { settings: settingsOf(tail.records), end: tail.end };
      if ((read.settings.model && read.settings.permissionMode) || start === 0) break;
    }
  } catch {
    // unreadable: nothing recorded
  }
  return read;
}

/** The settings a session last ran with, as its transcript records them. */
export async function transcriptSettings(sessionId: string): Promise<SessionSettings> {
  const path = transcriptFile(sessionId);
  return path ? (await recordedSettings(path)).settings : {};
}

// ---------- what only the raw transcript holds ----------

/**
 * What only the raw transcript holds, read from the file: getSessionMessages drops attachments and
 * meta prompts, and keeps a system record without its content.
 *
 * - The `<task-notification>`s the CLI queued mid-turn: it writes each as an `attachment`
 *   (`queued_command`) after the message it followed (a tool result, or another attachment after
 *   one), so a workflow's finish lands in history where it did live.
 * - A scheduled job's prompt (a /loop, CronCreate or ScheduleWakeup firing): a meta `user` record
 *   with `turnOrigin: scheduled`, whose uuid is the CLI's command uuid.
 * - A /goal's checks (`goal_status` attachments, after the reply each judged) and its set (the
 *   `local_command` record, after the prompt).
 * - A skill's instructions: a meta `user` record naming its Skill call (`sourceToolUseID`), after
 *   the call's result, which the call holds (`skillInstructions`).
 * - Edit calls' results (`toolUseResult`, with Claude Code's `structuredPatch`), by tool use id: a
 *   call's `edit` is made of them (`withResult`).
 *
 * Each is held under the message it follows (the nearest record getSessionMessages keeps, through
 * dropped attachments and meta prompts), to be read right after that message (`ingestHistory`).
 * Live, `take()` hands over what was written since the last read, in file order.
 */
export class TranscriptExtras {
  /** A dropped record's parent, to find the message a run of them follows. */
  private parentOf = new Map<string, string>();
  private waiting = new Map<string, RawRecord[]>();
  /** What was found and not yet taken, in file order, for a live reader (`take`). */
  private found: RawRecord[] = [];
  /** Handed over by the message each follows (`after`), as history reads them: nothing is taken. */
  private byMessage = false;
  /** Messages already read, for a record written after its message was. */
  private read = new Set<string>();
  /** How far into the file has been read. */
  offset = 0;
  private results = new Map<string, Record<string, unknown>>();

  /** Reads what the file holds from `offset` on. */
  async readFile(path: string): Promise<void> {
    try {
      const { size } = await stat(path);
      if (size < this.offset) this.offset = 0; // rewritten, not appended
      const added = await readRecords(path, this.offset, { keep: mayBeExtra });
      this.offset = added.end;
      this.addRecords(added.records);
    } catch {
      // unreadable: nothing more
    }
  }

  /** Skips what the file holds now: a live reader wants only what is written from here on. */
  async skipTo(path: string): Promise<void> {
    try {
      this.offset = (await stat(path)).size;
    } catch {
      this.offset = 0;
    }
  }

  /** A transcript's lines, as the file holds them. */
  add(lines: string[]): void {
    const records: RawRecord[] = [];
    for (const line of lines) {
      if (!EXTRA_NEEDLES.some((n) => line.includes(n))) continue;
      try {
        records.push(JSON.parse(line));
      } catch {
        // damaged, or cut
      }
    }
    this.addRecords(records);
  }

  addRecords(records: readonly RawRecord[]): void {
    for (const o of records) {
      if (!o || typeof o !== 'object') continue;
      this.keepResult(o);
      if (o.isSidechain || typeof o.uuid !== 'string') continue;
      const dropped = o.type === 'attachment' || (o.type === 'user' && o.isMeta === true);
      if (dropped && typeof o.parentUuid === 'string') this.parentOf.set(o.uuid, o.parentUuid);
      if (!isExtra(o)) continue;
      delete o.rendered;
      if (!this.byMessage) this.found.push(o);
      if (typeof o.parentUuid !== 'string') continue;
      const anchor = this.anchor(o.parentUuid);
      const list = this.waiting.get(anchor);
      if (list) list.push(o);
      else this.waiting.set(anchor, [o]);
    }
  }

  /** The message a run of dropped records follows. */
  private anchor(uuid: string): string {
    let at = uuid;
    for (let i = 0; i < 1000 && this.parentOf.has(at); i++) at = this.parentOf.get(at)!;
    return at;
  }

  /** The records that follow a message, once, as it is read. */
  after(uuid: unknown): RawRecord[] {
    if (!this.byMessage) {
      this.byMessage = true;
      this.found = [];
    }
    if (typeof uuid !== 'string') return [];
    this.read.add(uuid);
    const found = this.waiting.get(uuid) ?? [];
    this.waiting.delete(uuid);
    return found;
  }

  /** Records written after the message they follow had already been read. */
  late(): RawRecord[] {
    const out: RawRecord[] = [];
    for (const [uuid, found] of this.waiting) {
      if (!this.read.has(uuid)) continue;
      out.push(...found);
      this.waiting.delete(uuid);
    }
    return out;
  }

  /** Live: every record found since the last take, in the order written. */
  take(): RawRecord[] {
    const out = this.found;
    this.found = [];
    this.waiting.clear();
    // The stream carries results itself.
    this.results.clear();
    return out;
  }

  /** An edit's result: a tool result whose `toolUseResult` has a `structuredPatch`. */
  private keepResult(o: RawRecord) {
    const r = o.toolUseResult;
    const blocks = o.message?.content;
    if (o.type !== 'user' || !r || typeof r !== 'object' || !('structuredPatch' in r) || !Array.isArray(blocks)) return;
    const id = blocks.find((b: any) => b?.type === 'tool_result')?.tool_use_id;
    if (typeof id === 'string') this.results.set(id, { type: r.type, filePath: r.filePath, structuredPatch: r.structuredPatch });
  }

  /** A history message with its edit call's result put back, which getSessionMessages leaves out. */
  withResult(m: RawRecord): RawRecord {
    if (m?.type !== 'user' || m.tool_use_result !== undefined || !Array.isArray(m.message?.content)) return m;
    const results = m.message.content.filter((b: any) => b?.type === 'tool_result');
    const id = results.length === 1 ? results[0].tool_use_id : undefined;
    const r = id ? this.results.get(id) : undefined;
    if (!r) return m;
    // Each result is its call's once.
    this.results.delete(id);
    return { ...m, tool_use_result: r };
  }
}

/** What a line that may be a record `TranscriptExtras` keeps holds, by a look at its text. */
const EXTRA_NEEDLES = ['"structuredPatch"', '"attachment"', '"isMeta":true', '"local_command"'];
const mayBeExtra = holding(EXTRA_NEEDLES);

/** A raw record the itemizer reads that getSessionMessages leaves out (see `TranscriptExtras`). */
function isExtra(o: RawRecord): boolean {
  if (o.type === 'attachment') {
    const a = o.attachment;
    if (a?.type === 'queued_command') return typeof a.prompt === 'string' && /^\s*<task-notification>/.test(a.prompt);
    return a?.type === 'goal_status' && a.sentinel !== true;
  }
  // A skill's instructions, right after its Skill call (`sourceToolUseID`), or a scheduled job's prompt.
  if (o.type === 'user') return o.isMeta === true && (typeof o.sourceToolUseID === 'string' || isWakeup(o));
  return o.type === 'system' && o.subtype === 'local_command' && o.commandRun?.command === 'goal';
}

// ---------- into an itemizer ----------

/** An itemizer for a session, finding its workflows' files on disk as it needs them. */
export function sessionItemizer(sessionId: string, historyMode: boolean): Itemizer {
  const iz = new Itemizer(Date.now, historyMode);
  // The session's folder may not exist until the CLI first writes to it.
  const dir = () => sessionDir(sessionId);
  iz.locateWorkflowAgent = workflowAgentLocator(dir);
  iz.locateWorkflowCall = workflowCallLocator(dir);
  iz.readRunResult = runResultReader(dir);
  iz.readAgentPrompt = agentPromptReader(dir);
  return iz;
}

/**
 * A session's transcript read whole into a history itemizer, `quiet` (nobody reads what it would
 * emit), with the session's workflow files: what `thread/read` hands back, and where a follower
 * starts from.
 */
export async function readTranscript(sessionId: string, cwd: string | undefined) {
  const path = transcriptFile(sessionId);
  const history = await readSessionHistory(sessionId, cwd, path);
  const extras = new TranscriptExtras();
  extras.addRecords(history.records);
  const itemizer = sessionItemizer(sessionId, true);
  itemizer.quiet = true;
  ingestHistory(itemizer, history.messages, extras);
  await loadWorkflows(itemizer, sessionDir(sessionId));
  return { itemizer, extras, history, path };
}

/**
 * The session's workflow runs that the itemizer hasn't seen settle, from their files: the run
 * record once a run has finished, else its journal (`readRunJournal`). What a read of history, a
 * follower, or a live thread's earlier runs know of a workflow's agents.
 */
export async function loadWorkflows(iz: Itemizer, sessionDir: string | undefined): Promise<Emission[]> {
  if (!sessionDir) return [];
  const out: Emission[] = [];
  for (const runId of iz.unsettledWorkflowRuns()) {
    const snapshot = (await readRunRecord(sessionDir, runId)) ?? (await readRunJournal(sessionDir, runId));
    if (snapshot) out.push(...iz.applyWorkflowSnapshot(runId, snapshot));
  }
  return out;
}

/** History's messages into an itemizer, each followed by what the raw transcript wrote after it. */
export function ingestHistory(iz: Itemizer, msgs: readonly unknown[], extras?: TranscriptExtras): Emission[] {
  const out: Emission[] = [];
  if (extras) for (const r of extras.late()) out.push(...iz.ingestExtra(r));
  for (const m of msgs as RawRecord[]) {
    out.push(...iz.ingest(extras ? extras.withResult(m) : m));
    if (extras) for (const r of extras.after(m.uuid)) out.push(...iz.ingestExtra(r));
  }
  return out;
}
