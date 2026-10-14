import { getSessionMessages, type SessionMessage, type SessionStore } from '@anthropic-ai/claude-agent-sdk';
import { readFile } from 'node:fs/promises';

type RawRecord = Record<string, any>;

/**
 * A session's messages from its first. `getSessionMessages` follows the chain of messages back from
 * the latest one, and the chain starts again at every compaction (a boundary has no parent) and at
 * some resumes, so a chat compacted once showed nothing from before it. Each earlier chain is read
 * the same way, from the records before the first message of the chain after it, handed to the SDK
 * as a session store, so the SDK's own chain-building picks its messages; until the start of the
 * file. A message kept across a compaction is listed once, where it was first said.
 *
 * The SDK also drops what makes a boundary a compaction (its subtype and token counts) and a
 * summary Claude Code's (`isCompactSummary`); they're put back from the file, so a compaction is
 * its line in the chat and its summary isn't shown as the person's prompt.
 *
 * `tail` is how many messages came from the latest chain: what `getSessionMessages`' own `offset`
 * counts, for reading what's appended later.
 */
export async function readSessionHistory(
  sessionId: string,
  dir: string | undefined,
  path: string | undefined,
): Promise<{ messages: SessionMessage[]; tail: number }> {
  const options = { ...(dir ? { dir } : {}), includeSystemMessages: true };
  const tail = await getSessionMessages(sessionId, options);
  const records = path && tail.length ? await recordsBefore(path, tail[0]!.uuid) : undefined;
  if (!records) return { messages: tail, tail: tail.length };
  const index = new Map(records.flatMap((r, i) => (typeof r.uuid === 'string' ? [[r.uuid as string, i] as const] : [])));
  const chains: SessionMessage[][] = [];
  let end = index.get(tail[0]!.uuid) ?? 0;
  while (end > 0) {
    const chain = await chainEndingBefore(sessionId, records.slice(0, end), options);
    const start = chain.length ? index.get(chain[0]!.uuid) : undefined;
    // Nothing more to read, or no earlier start: stop rather than read the same chain again.
    if (start === undefined || start >= end) break;
    chains.unshift(chain);
    end = start;
  }
  // A message Claude Code kept across a compaction comes again after its summary: it stays where
  // it was first said.
  const seen = new Set<string>();
  const messages = [...chains.flat(), ...tail].filter((m) => !seen.has(m.uuid) && (seen.add(m.uuid), true));
  return { messages: messages.map((m) => restored(m, records[index.get(m.uuid) ?? -1])), tail: tail.length };
}

/**
 * The transcript's records, when a message comes before `first` (the latest chain's first message):
 * only then is there more to read, and only then is the file parsed here.
 */
async function recordsBefore(path: string, first: string): Promise<RawRecord[] | undefined> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
  const at = text.indexOf(first);
  if (at < 0) return undefined;
  const head = text.slice(0, at);
  if (!/"type":\s*"(user|assistant)"/.test(head)) return undefined;
  const records: RawRecord[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // A line mid-write, or damaged: the SDK skips it too.
    }
  }
  return records;
}

/** The chain of messages the SDK reads from these records: the one ending at the latest of them. */
async function chainEndingBefore(sessionId: string, records: RawRecord[], options: { dir?: string; includeSystemMessages: boolean }): Promise<SessionMessage[]> {
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
function restored(m: SessionMessage, raw: RawRecord | undefined): SessionMessage {
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
