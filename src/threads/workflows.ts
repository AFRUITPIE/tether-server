import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { Item, WorkflowAgent, WorkflowPhase, WorkflowSnapshot } from '../protocol/index.ts';
import { Itemizer } from './itemizer.ts';

/**
 * Claude Code's dynamic workflows (the Workflow tool, a `local_workflow` task). Its agents run
 * inside the workflow runner: they are not tasks, start no tool call, and none of their messages
 * reach the SDK stream. What a client can know of them comes from the `workflow_progress` array on
 * the task's progress events, and from what the CLI writes under the session's directory:
 *
 * - `workflows/<runId>.json`, the run record, once the run has finished;
 * - `subagents/workflows/<runId>/journal.jsonl`, a line as each agent starts and returns;
 * - `subagents/workflows/<runId>/agent-<agentId>.jsonl` (and `.meta.json`), each agent's transcript.
 *
 * None of this is documented, so everything here is read tolerantly.
 */

type AnyObj = Record<string, any>;

const ID = /^[A-Za-z0-9_-]+$/;

/** Whether `id` can name a file or directory: no separators, no `..`. */
export function isSafeId(id: unknown): id is string {
  return typeof id === 'string' && ID.test(id);
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/**
 * An agent's state as the CLI reported it. Seen: `start` (queued, or waiting out a rate limit),
 * `progress`, `done`, and `error` (with `skipped` or `blocked` when the person skipped it or the
 * classifier stopped it). It goes through unchanged, for the app to interpret.
 */
export function agentState(state: unknown): string {
  return typeof state === 'string' && state ? state : 'progress';
}

/**
 * A completed run's snapshot with every agent still starting or in progress marked done: the CLI
 * sends progress at most every few seconds, so the last agents are often never seen finishing.
 */
export function settleAgents(snapshot: WorkflowSnapshot): WorkflowSnapshot {
  if (!snapshot.agents.some((a) => a.state === 'start' || a.state === 'progress')) return snapshot;
  return { ...snapshot, agents: snapshot.agents.map((a) => (a.state === 'start' || a.state === 'progress' ? { ...a, state: 'done' } : a)) };
}

/** A task's status as a workflow's: running | completed | failed | stopped | paused. */
export function workflowStatus(status: unknown): string | undefined {
  switch (status) {
    case 'killed':
    case 'stopped':
      return 'stopped';
    case 'pending':
      return 'running';
    default:
      return str(status);
  }
}

function phaseFrom(e: AnyObj): WorkflowPhase | undefined {
  const index = num(e.index);
  if (index === undefined) return undefined;
  return { index, title: str(e.title) ?? `Phase ${index}`, ...(str(e.detail) ? { detail: e.detail } : {}) };
}

function agentFrom(e: AnyObj): WorkflowAgent | undefined {
  const index = num(e.index);
  if (index === undefined) return undefined;
  const a: WorkflowAgent = { index, label: str(e.label) ?? `Agent ${index}`, state: agentState(e.state) };
  for (const k of ['phaseIndex', 'queuedAt', 'startedAt', 'durationMs', 'tokens', 'toolCalls'] as const) {
    const v = num(e[k]);
    if (v !== undefined) a[k] = v;
  }
  for (const k of ['phaseTitle', 'agentId', 'model', 'lastToolName', 'lastToolSummary', 'promptPreview', 'resultPreview'] as const) {
    const v = str(e[k]);
    if (v !== undefined) a[k] = v;
  }
  const error = str(e.error) ?? str(e.error?.message);
  if (error) a.error = error;
  for (const k of ['skipped', 'cached', 'blocked'] as const) if (e[k] === true) a[k] = true;
  return a;
}

/**
 * `snapshot` with the CLI's `workflow_progress` entries merged in: an entry replaces the one of the
 * same type and index (the CLI's own rule), a new one is added, and log lines are dropped.
 */
export function mergeWorkflowProgress(snapshot: WorkflowSnapshot, progress: unknown): WorkflowSnapshot {
  if (!Array.isArray(progress)) return snapshot;
  const phases = [...snapshot.phases];
  const agents = [...snapshot.agents];
  for (const e of progress as AnyObj[]) {
    if (e?.type === 'workflow_phase') {
      const p = phaseFrom(e);
      if (!p) continue;
      const i = phases.findIndex((x) => x.index === p.index);
      // A progress entry has no detail; the script's meta keeps it.
      if (i >= 0) phases[i] = { ...phases[i]!, ...p };
      else phases.push(p);
    } else if (e?.type === 'workflow_agent') {
      const a = agentFrom(e);
      if (!a) continue;
      const i = agents.findIndex((x) => x.index === a.index);
      if (i >= 0) agents[i] = a;
      else agents.push(a);
    }
  }
  phases.sort((a, b) => a.index - b.index);
  agents.sort((a, b) => a.index - b.index);
  return { ...snapshot, phases, agents };
}

/** The value of a string property in a JS object literal's text: `name: 'x'`, `"name": "x"` or `` name: `x` ``. */
function literal(text: string, key: string): string | undefined {
  const m = new RegExp(`["']?\\b${key}["']?\\s*:\\s*(['"\`])((?:\\\\.|(?!\\1)[\\s\\S])*?)\\1`).exec(text);
  return m?.[2]?.replace(/\\(['"`\\])/g, '$1');
}

/**
 * What a workflow script's `export const meta = { name, description, phases }` says. The CLI
 * requires a pure literal, but this reads it with patterns, not by running anything.
 */
export function scriptMeta(script: unknown): { name?: string; description?: string; phases: WorkflowPhase[] } {
  if (typeof script !== 'string') return { phases: [] };
  const start = script.search(/\bmeta\s*=\s*\{/);
  if (start < 0) return { phases: [] };
  // The meta block ends at the first top-level statement after it; 4 KB is ample for a literal.
  const block = script.slice(start, start + 4096);
  const phasesText = /\bphases\s*:\s*\[([\s\S]*?)\]\s*,?\s*\}/.exec(block)?.[1] ?? '';
  const phases: WorkflowPhase[] = [];
  for (const m of phasesText.matchAll(/\{([^{}]*)\}/g)) {
    const title = literal(m[1]!, 'title');
    if (title) phases.push({ index: phases.length + 1, title, ...(literal(m[1]!, 'detail') ? { detail: literal(m[1]!, 'detail')! } : {}) });
  }
  // Name and description before the phases, so a phase's own fields aren't taken for them.
  const head = phasesText ? block.slice(0, block.indexOf(phasesText)) : block;
  const name = literal(head, 'name');
  const description = literal(head, 'description');
  return { ...(name ? { name } : {}), ...(description ? { description } : {}), phases };
}

/** A Workflow call's name for the workflow: the script's meta name, else the named workflow, else the script file's. */
export function workflowCallName(input: unknown): string | undefined {
  const i = (input ?? {}) as AnyObj;
  const fromScript = scriptMeta(i.script).name;
  if (fromScript) return fromScript;
  if (str(i.name)) return i.name;
  const path = str(i.scriptPath);
  // `<name>-<runId>.js`, as the CLI saves a script.
  return path ? basename(path).replace(/\.[cm]?[jt]s$/, '').replace(/-wf_[A-Za-z0-9_-]+$/, '') : undefined;
}

/** The run id a Workflow call's launch reports: its structured output, else the `Run ID:` line. */
export function launchRunId(output: unknown, text: string | undefined): string | undefined {
  const o = (output ?? {}) as AnyObj;
  return str(o.runId) ?? (text ? /^Run ID: (\S+)/m.exec(text)?.[1] : undefined);
}

/** The task id a Workflow call's launch reports. */
export function launchTaskId(output: unknown, text: string | undefined): string | undefined {
  const o = (output ?? {}) as AnyObj;
  return str(o.taskId) ?? (text ? /Task ID: (\S+)/.exec(text)?.[1] : undefined);
}

/** A workflow's return value as text: a string as it is, anything else as indented JSON. */
export function resultText(result: unknown): string | undefined {
  if (result === undefined || result === null) return undefined;
  if (typeof result === 'string') return result;
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

/** The notification's `<result>`, which the CLI writes compactly, reindented when it is JSON. */
export function notificationResult(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

// ---------- the session's directory on disk ----------

/**
 * A session's directory (`~/.claude/projects/<project>/<sessionId>`), beside its transcript. The
 * project folder's name is the CLI's flattening of the cwd, so the transcript is looked for.
 */
export function sessionDirSync(sessionId: string): string | undefined {
  if (!isSafeId(sessionId)) return undefined;
  // Where the CLI keeps its files: CLAUDE_CONFIG_DIR, else ~/.claude.
  const root = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects');
  let projects: string[];
  try {
    projects = readdirSync(root);
  } catch {
    return undefined;
  }
  for (const p of projects) if (existsSync(join(root, p, `${sessionId}.jsonl`))) return join(root, p, sessionId);
  return undefined;
}

/** `<session dir>/subagents/workflows/<runId>` */
export const runDir = (sessionDir: string, runId: string) => join(sessionDir, 'subagents', 'workflows', runId);

/**
 * Which workflow run an agent id belongs to, from the run directories' file names. The listing is
 * read once and again only when asked about an id it doesn't have, at most once per id: a run
 * started since the last read is found, and a peer that isn't a workflow agent costs one read.
 */
export function workflowAgentLocator(sessionDir: string | (() => string | undefined)): (agentId: string) => string | undefined {
  let byAgent: Map<string, string> | undefined;
  const missed = new Set<string>();
  let dir = typeof sessionDir === 'string' ? sessionDir : undefined;
  const list = () => {
    const found = new Map<string, string>();
    byAgent = found;
    dir ??= typeof sessionDir === 'function' ? sessionDir() : undefined;
    if (!dir) return;
    let runs: string[] = [];
    try {
      runs = readdirSync(join(dir, 'subagents', 'workflows'));
    } catch {
      return;
    }
    for (const run of runs) {
      if (!isSafeId(run)) continue;
      let files: string[] = [];
      try {
        files = readdirSync(runDir(dir!, run));
      } catch {
        continue;
      }
      for (const f of files) {
        const m = /^agent-([A-Za-z0-9_-]+)\.jsonl$/.exec(f);
        if (m) found.set(m[1]!, run);
      }
    }
  };
  return (agentId) => {
    if (!isSafeId(agentId)) return undefined;
    if (!byAgent || !dir) list();
    const run = byAgent!.get(agentId);
    // Without a directory yet there is nothing to have missed.
    if (run || !dir || missed.has(agentId)) return run;
    missed.add(agentId);
    list();
    return byAgent!.get(agentId);
  };
}

async function readJson(path: string): Promise<AnyObj | undefined> {
  try {
    const v = JSON.parse(await readFile(path, 'utf8'));
    return v && typeof v === 'object' ? v : undefined;
  } catch {
    return undefined;
  }
}

async function readLines(path: string): Promise<AnyObj[] | undefined> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
  const out: AnyObj[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line);
      if (v && typeof v === 'object') out.push(v);
    } catch {
      // a line still being written
    }
  }
  return out;
}

/** A finished run, from the CLI's run record (`workflows/<runId>.json`). */
export async function readRunRecord(sessionDir: string, runId: string): Promise<WorkflowSnapshot | undefined> {
  if (!isSafeId(runId)) return undefined;
  const r = await readJson(join(sessionDir, 'workflows', `${runId}.json`));
  if (!r) return undefined;
  const meta = scriptMeta(r.script);
  let snap: WorkflowSnapshot = {
    runId,
    phases: (Array.isArray(r.phases) ? r.phases : meta.phases).flatMap((p: AnyObj, i: number) =>
      str(p?.title) ? [{ index: num(p.index) ?? i + 1, title: p.title, ...(str(p.detail) ? { detail: p.detail } : {}) }] : [],
    ),
    agents: [],
  };
  snap = mergeWorkflowProgress(snap, r.workflowProgress);
  const name = str(r.workflowName) ?? meta.name;
  const description = str(r.summary) ?? meta.description;
  const status = workflowStatus(r.status);
  const result = resultText(r.result);
  const error = str(r.error) ?? str(r.error?.message);
  return {
    ...snap,
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
    ...(status ? { status } : {}),
    ...(num(r.totalTokens) !== undefined ? { totalTokens: r.totalTokens } : {}),
    ...(num(r.totalToolCalls) !== undefined ? { toolUses: r.totalToolCalls } : {}),
    ...(num(r.durationMs) !== undefined ? { durationMs: r.durationMs } : {}),
    ...(result ? { result } : {}),
    ...(error ? { error } : {}),
  };
}

/**
 * A run with no record yet: its agents from the journal's `started` and `result` lines and each
 * agent's `.meta.json`, its name and phases from the saved script. Its status is `unknown`: the
 * journal can't say whether the run is still going or was cut off (a live run is the live
 * thread's, and a finished one has a record), so it isn't reported as running.
 */
export async function readRunJournal(sessionDir: string, runId: string): Promise<WorkflowSnapshot | undefined> {
  if (!isSafeId(runId)) return undefined;
  const dir = runDir(sessionDir, runId);
  const lines = await readLines(join(dir, 'journal.jsonl'));
  if (!lines) return undefined;
  const meta = await savedScriptMeta(sessionDir, runId);
  const phases: WorkflowPhase[] = [...meta.phases];
  const phaseIndex = (title: string) => {
    let p = phases.find((x) => x.title === title);
    if (!p) phases.push((p = { index: phases.length + 1, title }));
    return p.index;
  };
  const agents: WorkflowAgent[] = [];
  const byId = new Map<string, WorkflowAgent>();
  for (const l of lines) {
    const agentId = str(l.agentId);
    if (l.type === 'started' && agentId && !byId.has(agentId)) {
      const a: WorkflowAgent = { index: agents.length + 1, label: str(l.label) ?? agentId, agentId, state: 'progress' };
      if (str(l.phase)) Object.assign(a, { phaseTitle: l.phase, phaseIndex: phaseIndex(l.phase) });
      agents.push(a);
      byId.set(agentId, a);
    } else if (l.type === 'result' && agentId) {
      const a = byId.get(agentId);
      if (!a) continue;
      a.state = 'done';
      const preview = typeof l.result === 'string' ? l.result : l.result === undefined ? undefined : JSON.stringify(l.result);
      if (preview) a.resultPreview = preview.length > 400 ? `${preview.slice(0, 400)}…` : preview;
    } else if ((l.type === 'error' || l.type === 'failed') && agentId) {
      const a = byId.get(agentId);
      if (!a) continue;
      a.state = 'error';
      const error = str(l.error) ?? str(l.error?.message) ?? str(l.message);
      if (error) a.error = error;
    }
  }
  await Promise.all(
    agents.map(async (a) => {
      const m = await readJson(join(dir, `agent-${a.agentId}.meta.json`));
      if (str(m?.model)) a.model = m!.model;
      if (!a.phaseTitle && str(m?.workflowPhase)) Object.assign(a, { phaseTitle: m!.workflowPhase, phaseIndex: phaseIndex(m!.workflowPhase) });
    }),
  );
  return {
    runId,
    ...(meta.name ? { name: meta.name } : {}),
    ...(meta.description ? { description: meta.description } : {}),
    status: 'unknown',
    phases,
    agents,
  };
}

/** The meta of the script the CLI saved for a run (`workflows/scripts/<name>-<runId>.js`). */
async function savedScriptMeta(sessionDir: string, runId: string): Promise<{ name?: string; description?: string; phases: WorkflowPhase[] }> {
  const dir = join(sessionDir, 'workflows', 'scripts');
  let files: string[] = [];
  try {
    files = await readdir(dir);
  } catch {
    return { phases: [] };
  }
  const file = files.find((f) => f.endsWith(`-${runId}.js`) || f === `${runId}.js`);
  if (!file) return { phases: [] };
  try {
    const meta = scriptMeta(await readFile(join(dir, file), 'utf8'));
    return { ...meta, ...(meta.name ? {} : { name: file.slice(0, -`-${runId}.js`.length) || undefined }) };
  } catch {
    return { phases: [] };
  }
}

/**
 * What a workflow agent was asked, without the harness's framing. The CLI hands each agent two
 * messages: "[Workflow harness — user request] …:" relaying the session's request, and
 * "[Workflow harness — computed task] … The computed task text follows:" before the script's
 * prompt, every line of each indented by two spaces. The request isn't the agent's task (it is
 * dropped: `null`); the task is its prompt, de-indented. Any other text is `undefined`: unchanged.
 */
export function unframeAgentPrompt(text: string): string | null | undefined {
  if (text.startsWith('[Workflow harness — user request]')) return null;
  if (!text.startsWith('[Workflow harness — computed task]')) return undefined;
  const marker = 'The computed task text follows:\n';
  const at = text.indexOf(marker);
  if (at < 0) return undefined;
  return text
    .slice(at + marker.length)
    .split('\n')
    .map((l) => l.replace(/^ {1,2}/, ''))
    .join('\n');
}

/** A transcript record's text, when its content is text alone. */
function soleText(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (Array.isArray(content) && content.length === 1 && content[0]?.type === 'text' && typeof content[0].text === 'string') return content[0].text;
  return undefined;
}

/**
 * A workflow agent's transcript as items, itemized as history is. Its lines are the CLI's own
 * transcript records; those that aren't messages (attachments, metadata) are skipped, and its
 * prompt is served without the harness's framing (`unframeAgentPrompt`). A file not written yet
 * is no items.
 */
export async function readAgentItems(sessionDir: string, runId: string, agentId: string): Promise<Item[]> {
  if (!isSafeId(runId) || !isSafeId(agentId)) return [];
  const lines = await readLines(join(runDir(sessionDir, runId), `agent-${agentId}.jsonl`));
  if (!lines) return [];
  const iz = new Itemizer(Date.now, true);
  for (const l of lines) {
    if (l.type !== 'user' && l.type !== 'assistant') continue;
    let message = l.message;
    const text = l.type === 'user' ? soleText(message?.content) : undefined;
    if (text !== undefined) {
      const prompt = unframeAgentPrompt(text);
      if (prompt === null) continue;
      if (prompt !== undefined) message = { ...message, content: prompt };
    }
    iz.ingest({
      type: l.type,
      uuid: l.uuid,
      session_id: l.sessionId,
      message,
      parent_tool_use_id: null,
      ...(l.timestamp ? { timestamp: l.timestamp } : {}),
      ...(l.toolUseResult !== undefined ? { tool_use_result: l.toolUseResult } : {}),
      ...(l.isMeta ? { isMeta: true } : {}),
    });
  }
  iz.closeTurn('completed');
  return iz.snapshot().items;
}
