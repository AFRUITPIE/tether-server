import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Item, Turn } from '../src/protocol/index.ts';
import { goalFromCommandOutput, Itemizer, type Emission } from '../src/threads/itemizer.ts';
import { ingestHistory, TranscriptExtras } from '../src/threads/FollowedThread.ts';
import { sessionCronsOf } from '../src/threads/LiveThread.ts';

/**
 * Two real sessions against Claude Code 2.1.291, captured with TETHER_DEBUG_MESSAGES=1 (every SDK
 * message but stream deltas; the init lines, cut at 4000 characters, left out), paths and email
 * scrubbed (`test/fixtures/loop-goal`):
 *
 * - loop: "/loop 1m reply with the current time in one short line" → CronCreate every minute (job
 *   6db9ae9a) → it fired twice → "stop the loop" → CronDelete. Live, a firing is only a
 *   `command_lifecycle` `started` for a command Tether never sent (no `queued` before it), then the
 *   turn's work; its prompt is never echoed. The transcript has it as a meta user record,
 *   `turnOrigin: scheduled`, whose uuid is that command's, which getSessionMessages drops.
 * - goal: "/goal notes.md in this directory has no spelling mistakes", met on the first check. Live,
 *   the set is a `<synthetic>` reply with `local_command_run: { command: 'goal' }`; no
 *   `active_goal` message comes (the CLI sends it only to remote sessions). The transcript has
 *   `goal_status` attachments (a sentinel at the set, then the check that found it met), the
 *   `local_command` record, and a meta "A session-scoped Stop hook is now active…" message.
 *
 * `*-stream.jsonl` is the live stream, `*-history.jsonl` what getSessionMessages reads back, and
 * `*-raw.jsonl` the transcript file (attachments other than goal_status and queued_command reduced
 * to their type).
 */
const DIR = `${import.meta.dir}/fixtures/loop-goal`;
const text = async (name: string) => (await Bun.file(`${DIR}/${name}`).text()).trim();
const lines = async (name: string): Promise<any[]> => (await text(name)).split('\n').map((l) => JSON.parse(l));

const FIRINGS = ['0f881351-4fec-42c7-bc61-be643a0bd2c7', '78d09459-cc94-495f-b4e5-71f7577d6dde'];
const PROMPT = 'reply with the current time in one short line';
const CONDITION = 'notes.md in this directory has no spelling mistakes';

const completed = (out: Emission[]) => out.flatMap((e) => (e.method === 'item/completed' ? [e.body.item as Item] : []));

/**
 * The stream as the daemon saw it, with Tether's own prompts begun as `send` begins them and the
 * transcript read as LiveThread reads it (`TranscriptExtras.take`).
 */
function live(stream: any[], raw: string[], prompts: Record<string, string>) {
  const iz = new Itemizer(() => 1);
  const extras = new TranscriptExtras();
  const out: Emission[] = [];
  let read = 0;
  const readTranscript = (upTo: number) => {
    extras.add(raw.slice(read, upTo));
    read = upTo;
    for (const r of extras.take()) if (r.attachment?.type !== 'queued_command') out.push(...iz.ingestExtra(r));
  };
  const written = raw.map((l) => Date.parse(JSON.parse(l).timestamp ?? '') || 0);
  for (const m of stream) {
    // LiveThread reads within a moment of a turn starting, a turn ending or (with a goal active) a
    // request starting: by the next message that says when it was sent, what was written before it
    // has been read. Records without a time (queue operations) go with the ones around them.
    const t = Date.parse(m.timestamp ?? '');
    if (Number.isFinite(t)) {
      let upTo = read;
      while (upTo < raw.length && written[upTo]! < t) upTo++;
      readTranscript(upTo);
    }
    if (m.type === 'command_lifecycle' && m.state === 'queued' && prompts[m.command_uuid]) {
      const r = iz.beginUserTurn(m.command_uuid, [{ type: 'text', text: prompts[m.command_uuid]! }], false);
      iz.noteSentUserMessage(m.command_uuid);
      out.push(...r.out);
    }
    out.push(...iz.ingest(m));
  }
  readTranscript(raw.length);
  return { iz, out, snapshot: iz.snapshot() };
}

function history(messages: any[], raw: string[]) {
  const iz = new Itemizer(() => 1, true);
  const extras = new TranscriptExtras();
  extras.add(raw);
  ingestHistory(iz, messages, extras);
  iz.closeTurn('completed');
  return iz.snapshot();
}

/** Turns as their ids and the items in each, for comparing live with history. */
const shape = (s: { items: Item[]; turns: Turn[] }) =>
  s.turns.map((t) => ({ turn: t.id, items: s.items.filter((i) => i.turnId === t.id && i.parentToolUseId === null).map((i) => `${i.type}:${i.id}`) }));

describe('/loop', async () => {
  const stream = await lines('loop-stream.jsonl');
  const raw = (await text('loop-raw.jsonl')).split('\n');
  const prompts = {
    '8324df9f-5591-4897-a38d-ee85b3c7e71f': '/loop 1m reply with the current time in one short line',
    '1ea78172-4a6a-4888-bf93-d200e0cc1f56': 'stop the loop',
  };
  const streamed = live(stream, raw, prompts);
  const read = history(await lines('loop-history.jsonl'), raw);

  test('live, each firing opens a turn of its own, named for its command', () => {
    expect(streamed.snapshot.turns.map((t) => t.id)).toEqual([
      '8324df9f-5591-4897-a38d-ee85b3c7e71f',
      ...FIRINGS,
      '1ea78172-4a6a-4888-bf93-d200e0cc1f56',
    ]);
    expect(streamed.snapshot.turns.every((t) => t.status === 'completed')).toBe(true);
  });

  test('a firing is one quiet wakeup line, first in its turn, with the prompt it fired with', () => {
    for (const s of [streamed.snapshot, read]) {
      const wakeups = s.items.filter((i) => i.type === 'userMessage' && i.origin === 'wakeup') as any[];
      expect(wakeups.map((w) => w.id)).toEqual(FIRINGS);
      for (const w of wakeups) {
        expect(w.synthetic).toBe(true);
        expect(w.turnId).toBe(w.id);
        expect(w.content).toEqual([{ type: 'text', text: PROMPT }]);
        expect(s.items.find((i) => i.turnId === w.id)?.id).toBe(w.id);
      }
      // Nothing else of the loop is a message: the /loop skill's expansion stays out.
      const others = s.items.filter((i) => i.type === 'userMessage' && i.origin !== 'wakeup') as any[];
      expect(others.map((m) => m.content[0].text)).toEqual(['/loop 1m reply with the current time in one short line', 'stop the loop']);
    }
  });

  test("history's turns are live's", () => {
    // History's first turn is named for its prompt's message, as live's is for the message sent.
    expect(shape(read)).toEqual(shape(streamed.snapshot));
  });

  test('the command lifecycle is no raw event any more', () => {
    expect(streamed.out.some((e) => e.method === 'thread/rawEvent' && (e.body as any).sdkType === 'command_lifecycle')).toBe(false);
  });

  test("the schedule's calls keep their inputs and outputs for the client", () => {
    const create = read.items.find((i) => i.type === 'toolCall' && i.name === 'CronCreate') as any;
    expect(create.kind).toBe('schedule');
    expect(create.input).toEqual({ cron: '*/1 * * * *', prompt: PROMPT, recurring: true });
    expect(create.outputText).toStartWith('Scheduled recurring job 6db9ae9a (Every minute).');
    const live = streamed.snapshot.items.find((i) => i.type === 'toolCall' && i.name === 'CronCreate') as any;
    expect(live.output).toEqual({ id: '6db9ae9a', humanSchedule: 'Every minute', recurring: true, durable: false });
    const del = read.items.find((i) => i.type === 'toolCall' && i.name === 'CronDelete') as any;
    expect(del.input).toEqual({ id: '6db9ae9a' });
  });
});

describe('/goal', async () => {
  const stream = await lines('goal-stream.jsonl');
  const raw = (await text('goal-raw.jsonl')).split('\n');
  const SET = '8a0390c6-c0d9-4b62-b17a-55b7e1aa5805';
  const prompts = { '8892057a-ff55-411e-b335-f39e87fe4a83': `/goal ${CONDITION}` };
  const streamed = live(stream, raw, prompts);
  const read = history(await lines('goal-history.jsonl'), raw);
  const metId = raw.map((l) => JSON.parse(l)).find((o) => o.attachment?.type === 'goal_status' && o.attachment.met)!.uuid;

  test('set and met are quiet goal lines, live and in history alike', () => {
    for (const s of [streamed.snapshot, read]) {
      const goals = s.items.filter((i) => i.type === 'notice' && i.kind === 'goal') as any[];
      expect(goals.map((g) => [g.id, g.goal.event, g.goal.condition])).toEqual([
        [SET, 'set', CONDITION],
        [metId, 'met', CONDITION],
      ]);
      expect(goals[1].goal.reason).toStartWith('The assistant read notes.md');
      expect(goals[1].text).toBe('Goal met');
      // The check is written after the reply it judged, in that reply's turn.
      expect(goals[1].turnId).toBe(s.turns[0]!.id);
      expect(s.items.at(-1)?.id).toBe(metId);
    }
  });

  test("the CLI's \"Goal set\" reply and the goal's brief to the model are no messages", () => {
    for (const s of [streamed.snapshot, read]) {
      expect(s.items.some((i) => i.type === 'agentMessage' && i.text.startsWith('Goal set:'))).toBe(false);
      expect(s.items.some((i) => i.type === 'userMessage' && i.synthetic)).toBe(false);
    }
    // The prompt is the command as typed, its condition included.
    expect((read.items[0] as any).content).toEqual([{ type: 'text', text: `/goal ${CONDITION}` }]);
  });

  test("history's turns are live's", () => {
    expect(shape(read)).toEqual(shape(streamed.snapshot));
  });

  test("a check that isn't met yet is said, and the hook's feedback to the model isn't", () => {
    const iz = new Itemizer(() => 1);
    iz.beginUserTurn('p', [{ type: 'text', text: `/goal ${CONDITION}` }], false);
    iz.ingest(stream.find((m) => m.local_command_run)!);
    expect(iz.goalActive).toBe(true);
    const notMet = iz.ingestExtra({
      type: 'attachment',
      uuid: 'check-1',
      timestamp: '2026-10-07T05:15:17.000Z',
      attachment: { type: 'goal_status', met: false, condition: CONDITION, reason: 'line 2 still says "tommorow"' },
    });
    expect((completed(notMet)[0] as any).goal).toEqual({ condition: CONDITION, event: 'notMet', reason: 'line 2 still says "tommorow"' });
    const feedback = iz.ingest({ type: 'user', uuid: 'fb', isMeta: true, message: { role: 'user', content: 'Stop hook feedback:\nline 2 still says "tommorow"' }, parent_tool_use_id: null });
    expect(feedback).toEqual([]);
    expect(iz.goalActive).toBe(true);
  });

  test("the command's output reads as a goal's", () => {
    expect(goalFromCommandOutput('<local-command-stdout>Goal set: x y</local-command-stdout>')).toEqual({ event: 'set', condition: 'x y' });
    expect(goalFromCommandOutput('Goal cleared: x')).toEqual({ event: 'cleared', condition: 'x' });
    expect(goalFromCommandOutput('No goal set')).toBeUndefined();
    expect(goalFromCommandOutput('Goal active: x (2 turns)')).toBeUndefined();
  });
});

describe('reading the transcript live', () => {
  test('only what is written after the reader starts, each record once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'extras-'));
    const path = join(dir, 's.jsonl');
    const raw = (await text('loop-raw.jsonl')).split('\n');
    const at = raw.findIndex((l) => l.includes(FIRINGS[0]!));
    writeFileSync(path, raw.slice(0, at).join('\n') + '\n');
    const extras = new TranscriptExtras();
    await extras.skipTo(path);
    appendFileSync(path, raw.slice(at).join('\n') + '\n');
    await extras.readFile(path);
    expect(extras.take().map((r) => r.uuid)).toEqual(FIRINGS);
    await extras.readFile(path);
    expect(extras.take()).toEqual([]);
  });
});

describe('session crons from the Stop hook', () => {
  test("the CLI's summaries, tolerantly", () => {
    expect(sessionCronsOf(undefined)).toBeUndefined();
    expect(sessionCronsOf([])).toEqual([]);
    expect(sessionCronsOf([{ id: '6db9ae9a', schedule: '*/1 * * * *', recurring: true, prompt: PROMPT }, { nope: 1 }])).toEqual([
      { id: '6db9ae9a', schedule: '*/1 * * * *', recurring: true, prompt: PROMPT },
    ]);
  });
});
