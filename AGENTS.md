# Tether server contributor guide

## What this repository is

`tether-server` is the host-side backend for Tether. It exposes Claude Code through a typed JSON-RPC protocol and a long-lived per-host daemon. The sibling `../tether-app` repository is a native macOS client; this repository also publishes the generated `TetherProtocol` Swift package consumed by that app.

The server wraps the first `claude` executable on the host's effective `PATH`. It does not own provider credentials. Bedrock, Vertex, Anthropic API keys, claude.ai login, settings, hooks, MCP servers, skills, and agents remain the host Claude Code installation's responsibility.

## Toolchain and commands

Bun is pinned by `mise.toml`. Use mise tasks instead of relying on an arbitrary global Bun:

```sh
mise install
mise run install
mise run test
mise run typecheck
mise run gen
mise run swift-test
mise run compile
```

- `mise run dev`: in-process `serve --stdio` development server.
- `mise run test`: Bun unit tests using recorded SDK fixtures.
- `mise run typecheck`: strict TypeScript checking.
- `mise run gen`: regenerate JSON Schema and committed Swift protocol code.
- `mise run swift-test`: verify Swift decoding against recorded wire traffic.
- `mise run build-npm`: the npm package under `npm/`: one bundled file for Node 18 or later, no dependencies (`--dev` stamps a dev version).
- `mise run compile`: standalone darwin/linux × arm64/x64 binaries under `dist/`, which CI runs the CLI tests against.
- Releasing: bump `package.json`'s version and merge. On a push to main whose version has no tag, `.github/workflows/npm.yml` tests and builds the npm package, stages it on npm (trusted publishing, with provenance; no token is stored anywhere), then tags the commit and publishes its GitHub release, which the app's Swift package pin reads. It goes live once a maintainer approves it with 2FA: `npm stage approve <id>`, or Staged Packages on npmjs.com.
- A new Claude Agent SDK becomes a PR by itself (`.github/workflows/sdk-update.yml`, daily): the dependency and the next patch version, after typecheck and tests pass. The app watches npm the same way (its `server-update.yml`) and opens its own PR for a newly published server.
- `mise run e2e`: real Claude Code E2E tests. These use the configured account/provider and can incur cost; do not run casually.

## Repository map

- `src/protocol`: Zod definitions and the protocol's source of truth.
  - `common.ts`: shared types, model/settings/catalog data, thread summaries and info.
  - `items.ts`: transcript items, tool calls, turns, and results.
  - `methods.ts`: client-to-server requests.
  - `notifications.ts`: sequenced server-to-client notifications.
  - `serverRequests.ts`: permission, question, plan, and elicitation calls that require a client response.
  - `tasks.ts`: `TaskState`, a chat's task as it stands (an agent, a command, a monitor, an MCP tool, a workflow, a workflow's agent, a schedule, a goal).
- `src/rpc/connection.ts`: newline-delimited JSON-RPC framing, correlation, cancellation, and outbound server requests.
- `src/server/session.ts`: handshake validation and method routing for one connected client.
- `src/threads/LiveThread.ts`: one live Claude Agent SDK query, settings, event replay, subscriptions, queued input, and pending requests.
- `src/threads/ThreadManager.ts`: loaded-thread ownership, disk-session resume/read/list, catalog queries, and idle eviction.
- `src/threads/itemizer.ts`: pure-ish SDK-message-to-Tether-item/event reducer, which also keeps each task's facts and sends `task/updated` when a task's state changes (`tasks()`).
- `src/threads/tasks.ts`: the pure parts of task state: a task's state from its call and the CLI's facts (`taskState`), a workflow's and its agents' from its snapshot (`workflowTasks`), statuses and kinds from the CLI's words.
- `src/threads/scheduled.ts`: a chat's schedules (/loop, CronCreate, ScheduleWakeup) and goals (/goal) worked out from its items and `sessionCrons`, as tasks.
- `src/threads/taskStore.ts`: each chat's task states as the daemon saw them, in `<TETHER_HOME>/tasks/<thread id>.json`.
- `src/threads/workflows.ts`: dynamic workflows (the Workflow tool's `local_workflow` task): merging the CLI's undocumented `workflow_progress` into a `WorkflowSnapshot` (internal; clients get `TaskState`s), reading a script's `meta`, and what the CLI writes under the session's folder (`workflows/<runId>.json`, `subagents/workflows/<runId>/journal.jsonl` and `agent-<id>.jsonl`) for a run no live task tells of and for `workflow/agentItems`. Every id is checked against `/^[A-Za-z0-9_-]+$/` before it names a path.
- `src/threads/FollowedThread.ts`: a session another client runs, followed through its transcript (its unsettled workflows' files read again every 5 s while watched); and `TranscriptExtras`, what only the raw transcript holds (queued notifications, scheduled jobs' prompts, a /goal's set and checks, skills' instructions).
- `src/threads/pushQueue.ts`: async streaming-input queue.
- `src/daemon/daemon.ts`: Unix-socket daemon, detached startup, stdio bridge, and graceful version handoff.
- `src/server/fsApi.ts`: remote file and Git helpers exposed to clients, including the worktrees `thread/start` can make under `<repo>/.claude/worktrees/` (excluded locally through `.git/info/exclude`) and their removal. A thread started in a subfolder works in the worktree's copy of it; one started inside a worktree gets a new one beside it in the main checkout, not nested; one that fails to start takes its worktree and branch with it. `git/removeWorktree` removes only a registered worktree at exactly `<checkout>/.claude/worktrees/tether-<8 hex>` (never Claude Desktop's), and never loses work unasked: uncommitted changes need `force` (error `worktreeDirty`), and a `claude/tether-…` branch with commits its upstream or the checkout's HEAD lacks needs `discardCommits` (error `worktreeUnmerged`, raised before anything is removed; the branch is deleted with `git branch -d` otherwise). Both errors' `data` is `{ branch, uncommittedChanges, unmergedCommits, worktreeRemoved? }`.
- `src/threads/Scheduler.ts`: scheduled tasks, kept in `schedules.json` in the daemon's home and run from a one-minute timer as new threads. Only the daemon that owns the socket runs them (`serve --stdio` has none), so none runs twice; a run missed during sleep happens once on waking. A run takes the environment the last client to connect sent in `initialize` (held in memory only, as it can hold credentials). Nobody is there to answer a run, so a request it makes of a person is denied once it has waited `TETHER_SCHEDULED_REQUEST_TIMEOUT_MS` (10 minutes) with no client subscribed, ending the turn and recorded as the task's `lastError`; a subscribed client gets as long as it takes. No task starts once the daemon is draining for an upgrade or exiting, and the file is saved then. `schedule/save` replaces a task whole, keeping only what runs recorded; the file is checked entry by entry on load (`loadTasks`), so one bad entry is repaired or skipped rather than breaking `schedule/list`.
- `src/claude.ts`: resolves and reports the host Claude CLI.
- `scripts/gen-schema.ts`, `scripts/gen-swift.ts`: protocol code generation.
- `scripts/build-npm.ts`: the npm package, bundled with the Agent SDK and without its platform packages (each a Claude Code of its own; Tether runs the host's `claude`).
- `scripts/compile.ts`: standalone binary matrix, for tests.
- `scripts/e2e*.ts`, `scripts/record-sdk.ts`: real-CLI test and fixture tools.
- `Sources/TetherProtocol`: generated Swift types plus hand-written support types.
- `Tests/TetherProtocolTests`: Swift fixture decoding.

## Runtime topology

The CLI has three important modes:

```text
tether connect         stdio <-> per-host daemon bridge; what the app runs
tether daemon          long-lived owner of live Claude queries
tether serve --stdio   single-client in-process server for development/tests
```

The daemon listens on `~/.tether/tether.sock` (or `TETHER_HOME` in isolated tests), with mode `0600`. `tether connect` starts it if needed and forwards JSONL between stdio and the socket. The daemon owns `ThreadManager` and every `LiveThread`, so a client disconnect must not interrupt running work or discard a pending permission/question.

When the server's version changes, `connect` requests a graceful daemon shutdown. Busy work is allowed to finish; replacement occurs after the manager drains.

## How hosts run it

Hosts run the npm package, which needs Node 18 or later: the app runs `npx --yes tether-server@<version> connect` under the host's login shell, pinned to the version it was built against. Nothing is installed beside npm's cache, and an update is the app naming the next version: that `connect` finds a daemon of another version and replaces it as above. The package is one file (`scripts/build-npm.ts`): everything bundled, the Agent SDK included, without the SDK's platform packages, no dependencies and no install scripts, not minified. It's staged from this repository's workflow when a version bump is merged, by trusted publishing (npm's OIDC exchange, no token), which records provenance, and published when a maintainer approves it with 2FA.

The daemon finds `claude` when it starts, on the PATH of the first `connect` (a login shell's, not an interactive one's), or at `TETHER_CLAUDE_PATH`; none there doesn't stop it. A client whose host's environment (Settings ▸ Hosts ▸ Environment in the app) sets `TETHER_CLAUDE_PATH` or `PATH` gets `claude` looked up there instead, for its chats, the catalog (cached per directory and `claude`), plugins and what `initialize` reports (`ThreadManager.claudeFor`): a company wrapper that only an interactive shell's PATH reaches can be named there, without restarting the daemon. A PATH set there replaces the daemon's rather than extending it. The lookup is asynchronous (`resolveClaude`), skips directories and relative PATH entries, expands `~` with that environment's HOME, and never throws: none found is `{ path: '', version: 'not found' }` in what `initialize` reports, and a chat, catalog or plugin command fails with why (`ThreadManager.runnable`). Either way the SDK runs the file as it is, so a wrapper's exports reach Claude Code.

## Protocol invariants

- The wire format is JSON-RPC 2.0-shaped JSONL without a `"jsonrpc"` member: one object per line.
- `initialize` must precede all other methods. Validate every request with its Zod parameter schema.
- Protocol version is `PROTOCOL_VERSION`; changes must remain coordinated with generated Swift types and app behavior.
- Protocol version 2 is the floor: `PROTOCOL_VERSION` and `MIN_CLIENT_PROTOCOL` are both 2, so a client that sends no `protocolVersion` (protocol 1) or 1 is refused, and a protocol 2 client needs no fallbacks for a protocol 1 server. Version 2 replaced `task/event`'s partial patches, `task/backgroundChanged` and `workflow/read` with typed, persisted `TaskState`s, and added edits on tool calls and turns, `git/changes`, `thread/summaryChanged` and `thread/start`'s `messageId` (see "Protocol 2" below). The one exception is `tether connect`'s own upgrade client (`clientInfo.name` `tether-upgrade`), served whatever protocol it speaks for `host/requestShutdown` alone, so any release's `connect` can replace any other release's daemon.
- Bump `PROTOCOL_VERSION` only for a breaking change. Raise `MIN_CLIENT_PROTOCOL` only when the server can no longer serve older clients: `initialize` then refuses them with `incompatibleProtocol`, carrying both numbers so the app can say which side to update. Additive changes (a new notification, an optional field) bump neither, and a new result field must be optional so older servers still decode.
- `tether version --json` reports the version, protocol range, Agent SDK version and platform without a daemon; clients probe a host with it before installing or updating.
- Every thread-scoped notification carries `threadId` and a monotonically increasing per-thread `seq`. Each event stream (a `LiveThread` or `FollowedThread` instance) starts at `seqOrigin()`, microseconds since the epoch, so a stream begun later — after a process exit, a resume, a rewind or a daemon restart — numbers above every earlier one, and a client's stale `afterSeq` is reported as a gap instead of swallowing new events.
- A history snapshot's `historySeq` states exactly which event prefix it includes. Replay starts after that value so snapshots and live streams never overlap or leave a gap.
- Unknown SDK messages are forwarded as raw events rather than crashing the session. Generated Swift discriminated unions likewise retain `.unknown` cases.
- A server-to-client request remains pending until one subscribed client answers or the SDK cancels it. Re-subscribing clients must receive pending requests again. The first answer wins; other clients receive `serverRequest/resolved`.
- A dropped client never owns a query. Running and action-required threads are not idle-eviction candidates, nor is one with background work (the CLI's latest `background_tasks_changed`, ambient watchers excluded): closing its query would kill that work. The same holds for an upgrade drain. A scheduled run waiting on a person with no client subscribed doesn't hold up a drain: it would only be denied.
- `turn/start` on an unloaded historical thread resumes it before sending. On a running thread, input respects the requested `now`/`next`/`later` priority.

## Protocol 2

What a client gets as typed state rather than working out itself:

- **Tasks.** `TaskState` (`src/protocol/tasks.ts`): `id`, `parentId`, `toolUseId`, `taskId` (what `task/stop` and `task/background` take), `kind` (agent, command, monitor, mcpTool, workflow, workflowAgent, schedule, goal, other), `taskType`, `title`, `status` (waiting, running, done, failed, stopped), `startedAt`, `endedAt`, `backgrounded`, `canBackground`, `summary`, `error`, `output`, `outputFile`, `usage`, and one of `workflow`, `workflowAgent`, `schedule`, `goal`. `thread/read` (every page) and `thread/subscribe` return `tasks`, all of the chat's, finished ones included, and `thread/resume` with `includeHistory` too; `task/updated { task }` sends a task's whole state whenever it changes. `task/event`, `task/backgroundChanged` and `workflow/read` are gone; `workflow/agentItems` stays (an agent's transcript). Ids: the call's id where a call started it, else `task:<task id>`; `<workflow id>/agent/<index>`; `schedule:<call id>` (`schedule:wakeup:<item id>` for a job known only by its firing); `goal:<notice id>`.
- **Items.** A Skill call carries `skillInstructions` (no message for them); a wakeup carries `fromLoop`.
- **Edits.** A finished Edit, MultiEdit, Write or NotebookEdit call carries `edit { path, hunks [{ oldStart, oldLines, newStart, newLines, lines, header? }], added, removed, truncatedLines?, created? }`: Claude Code's `structuredPatch` (live from the stream, in history from the transcript's `toolUseResult`, which getSessionMessages drops, so `TranscriptExtras.withResult` puts it back), else the call's own input compared (`lineDiffHunk`; position 0, unknown). Bounded as `src/server/diff.ts` says: 5,000 lines a file kept, the rest counted; lines cut at 1,000 characters. The call's `output` then leaves out `structuredPatch`, `originalFile` and `content`. A turn carries `edits { files, added, removed }` once it ends (its subagents' edits included, a file once); a background agent's edit after its turn ended sends `turn/updated` with the new totals.
- **Starting a chat.** `thread/start` with `input` returns the prompt's `messageId` and `turnId`. Ordering guarantee: the handler subscribes the client before sending, and notifications are written as they are emitted, so the prompt's `turn/started`, `item/started` and `item/completed` are on the wire before the result. A client holding the result holds the item.

## Claude Agent SDK boundary

`LiveThread` is the adapter around one streaming-input `query()`:

- Use the resolved host Claude binary as `pathToClaudeCodeExecutable`.
- Preserve `settingSources: ['user', 'project', 'local']` and the `claude_code` preset system prompt.
- Merge client/thread environment overrides without dropping the host environment.
- Stamp human input with its human origin so Claude Code features that depend on provenance keep working.
- Keep partial-message streaming, file checkpointing, permission callbacks, elicitation, stderr, task events, and initialization data routed through the typed Tether protocol.
- Session tools (`sessionTools` on `thread/start`/`thread/resume`) are an in-process MCP server named `tether`. Only its own tools (`SESSION_TOOL_NAMES`), and only on a thread that asked for them, skip the permission prompt; any other `mcp__tether__…` tool, such as one from a project's own server of that name, is asked about like every other tool.

- What a session starts with is Claude Code's, as an interactive session would have it. `session/defaults` asks a catalog session (never a thread's: it changes the session's model through flag settings to ask about another, one question at a time, and puts it back) for `getSettings().applied`: the model, and the effort Claude Code sends it (its per-model default when none is chosen). The permission mode is `startingPermissionMode`: the settings' `defaultMode` after `filterEscalatingDefaultMode`, else auto where the model supports it and `disableAutoMode` doesn't forbid it, else default. `thread/start` without a permission mode starts in that mode, since the SDK's own start is always default; a scheduled run keeps default. A live thread reports its applied effort as `appliedEffort`, read after it starts and after its model or effort changes. An older Claude Code without get_settings leaves both unknown.

SDK types and events can change between Claude Code versions. Be defensive around optional fields, preserve raw unknown events, and cover newly observed shapes with recorded fixtures before tightening assumptions.

## Itemization and history

The live event path and history path must produce the same conceptual `Item` and `Turn` model. `itemizer.ts` pairs tool uses with results, streams agent/reasoning deltas, nests subagent content using parent tool-use IDs, maps status/task events, and closes turns from result messages.

A subagent's messages belong to the turn that launched it, even after that turn ends; a background subagent's tool calls are not cut short when it does. A background task settling becomes one `taskNotification` notice, from either the `task_notification` event or the `<task-notification>` message the CLI hands the model (the only form history has); a foreground command's own task, and a subagent's inner one, get none.

A dynamic workflow's agents run inside the CLI's workflow runner: no task, no tool call, no message with a parent tool-use id. Their only trace in the stream is `workflow_progress` on the workflow task's progress events, sent at most every few seconds, so the itemizer merges it into one snapshot per task (entries replaced by type and index, `workflow_log` dropped), from which the workflow's `TaskState` and one `workflowAgent` state per agent are made (`workflowTasks`); neither the raw array nor the started event's `prompt` (the whole script) is sent. A workflow's progress `description` names its latest agent, so it is the workflow's `activity`, never its title. Agent states are read from the CLI's words (start before a slot is waiting, start and progress running, done, error failed; skipped or blocked stopped, cached done), and a settled run settles the agents it last heard of as going: completed, those in progress or started are done, since the last progress is often never sent, and one still waiting for a slot (`start` with no `startedAt`) never ran and is skipped; failed or stopped, they stopped. A phase's status is its agents'. An agent's `prompt` is the CLI's preview (unframed), read whole from its transcript once the preview is cut (`agentPromptReader`, at most every 5 s until found). A snapshot's `result` is only the return value; why it failed is `error`. A run found only by its journal (no live task, no record) is `running` while the session's transcript or the run's files were written in the last five minutes (`RECENT_RUN_MS`), else `unknown`. Its finish is a synthetic `userMessage` (`origin: "workflow"`, named for it, id `workflow_<taskId>_finished`), not a notice, said by whichever comes first of the `task_notification` event and the `<task-notification>` message; the message, coming after, puts its `<result>` in the same item. Live, the SDK stream never carries that message (it starts the answering turn unechoed), so the event says the finish with the result from the run record (`readRunResult`), which the CLI writes just before it. It goes in the running turn if there is one, else it opens the turn that answers it (`turn_workflow_<taskId>_finished`), live and in history alike: history counts a turn as over once its last reply's stop reason isn't `tool_use` or it was interrupted. Mid-turn, the CLI never sends the message in that turn: it hands the model the notification at the turn's next step, written to the transcript as an `attachment` (`queued_command`) after that step's tool result, which getSessionMessages drops. So live, an event mid-turn waits for the next top-level tool result or reply and is said there, in the running turn, or after the turn if it ends first; history reads those attachments from the raw file (`QueuedNotifications`, `ingestHistory` in `FollowedThread.ts`, for `readStored` and followed threads alike) and ingests each after the message it follows. A stopped workflow gets no message, so its event says it at once, in the running turn or in none. A workflow agent's own task (a background `sleep`: `owned_by_subagent` on its start, a `tool_use_id` inside the agent) is never a notice in the chat; its `TaskState`'s `parentId` is the agent's (`<workflow id>/agent/<index>`) once the call is found in a running run's `agent-<id>.jsonl` (`workflowCallLocator`), until then the workflow running when it started (the latest if several), and with neither it isn't listed at all. `workflow/agentItems` serves an agent's prompt without the CLI's harness framing: the relayed user request is dropped and the computed task de-indented. A workflow agent's message to the session (a `peer` from its agent id) goes under the Workflow call; in history the agent is found by its transcript's file name. History items and turns take the time their message was written. `TETHER_DEBUG_TASKS=1` logs every raw `task_*` message to the daemon's log, since none of this is documented.

Scheduled jobs (/loop, CronCreate, ScheduleWakeup) and /goal leave little in the SDK stream, so what the app needs is read from the transcript file too (`TranscriptExtras` in `FollowedThread.ts`: after the message each record follows in history, `take()` live in file order from where the file ended when the process started). A job firing is a meta user record with `turnOrigin: scheduled` whose uuid is the CLI's command uuid; live, the stream has only `command_lifecycle` `started` for a command Tether never sent, which opens the turn (id: that uuid) at once, and LiveThread reads the transcript a few times until the prompt is found. It becomes a synthetic `userMessage` with `origin: "wakeup"` and the prompt as its content, first in its turn, live and in history alike. The CLI's `<synthetic>` "Goal set: …" reply (`local_command_run.command: goal`; history's `local_command` record) and its `goal_status` attachments (a check not met, met, failed; the set's sentinel skipped) are `notice` items of kind `goal` with a typed `goal` (condition, event, reason, iterations); a check goes in the turn it judged. While a goal is active its Stop hook's "Stop hook feedback:" and its brief to the model ("A session-scoped Stop hook is now active…") are not messages. `active_goal` is sent only to remote sessions, so it's never relied on. What will wake a session is `ThreadInfo.sessionCrons`: a Stop hook callback (it changes nothing) is told the CLI's `session_crons` after every turn (verified: the same ids CronCreate returns); a process starts with none and ends with none, since they're session-only. No control request lists or deletes a cron or the goal. A slash command's prompt keeps its args whichever order the CLI wrote its tags in.

The server owns what these add up to: `scheduled.ts` works the chat's schedules and goals out from its items (the call that made a job, the wakeups it fired, the call that deleted it; a goal's set and checks) and, for a thread loaded here, `sessionCrons` (a job the hook no longer lists, once no turn runs, has gone; one whose process ended went with it), as tasks of kinds `schedule` and `goal`. A live thread that resumed a session is seeded with the transcript's items (`seed`), so it works from the whole chat, not only its own process. A wakeup item says whether its job was a /loop's (`fromLoop`: its job was made in a turn a /loop prompt started, or is a dynamic /loop's wakeup, or the CLI marks it one).

A skill's instructions, which Claude Code puts in the conversation as a meta message right after the Skill call, are the call's `skillInstructions`, never a message: live by place (a synthetic message right after a Skill call of the same agent), from the transcript by its `sourceToolUseID`, which getSessionMessages drops, so `TranscriptExtras` reads it.

Tasks are typed state (`TaskState`), never patches: the itemizer keeps what the CLI said of each task (`TaskFacts`, from `task_*` events and, in history, the `<task-notification>` message), and after each message whose effect could change a task (a task event, the background set, a call that is or started a task, a schedule's item, a turn's start or end, `sessionCrons`, the process ending) works every state out again and sends those that changed as `task/updated`. Which tasks: the calls that are tasks whether the CLI reports one or not (Agent/Task, Workflow, Monitor, a Bash with `run_in_background`), every task the CLI reports (by the call that started it, its newest task if more than one, else `task:<task id>`), each workflow's agents, then the schedules and goals. `parentId` follows the call: a task whose call a subagent made goes under that subagent (or workflow); a workflow agent's own task as above. Status: a settled CLI status wins; then the background set (and a patch's `is_backgrounded`); then a foreground call that finished; then the CLI's status; then the call's (a launch in the background, which returns at once, is running). The process ending stops everything still going. History has no task events: its states come from the calls, their launch texts (task ids, output files) and the notifications, and its workflows from their run records or journals (`loadWorkflows`). What only the live stream says (usage, task types, a workflow's agents as they ran) is kept with the chat (`TaskStore`, written a second after a change, flushed on shutdown, deleted with the chat) and merged into every read: a task kept as going whose process isn't running here any more is stopped, unless its transcript says how it ended; a task only the transcript tells of that is still going in a chat nobody has written to for five minutes is stopped too (a workflow's files say how it stands, so its `waiting` stays).

Keep itemization deterministic and testable. Prefer adding a minimal recorded fixture plus assertions over embedding UI-specific interpretation in the server. The app decides how compactly to display reasoning and tool runs; the server preserves semantic data.

## Generated artifacts

The Zod files under `src/protocol` are the only hand-edited schema source. Never hand-edit:

```text
schema/tether.schema.json
Sources/TetherProtocol/Generated.swift
```

For a protocol change:

1. Update Zod definitions in `src/protocol`.
2. Implement or update routing/runtime behavior.
3. Run `mise run gen`.
4. Review both generated artifacts for intentional changes.
5. Update TypeScript and Swift fixture tests.
6. Run `mise run typecheck`, `mise run test`, and `mise run swift-test`.
7. Update `../tether-app` call sites when the wire surface changed.

Generated string enums are forward-compatible `RawRepresentable` Swift structs. Discriminated unions include unknown fallbacks. Preserve those properties in the generator.

## Tests and fixtures

- `test/itemizer.test.ts` consumes recorded `test/fixtures/sdk/*.jsonl` messages and checks emitted items/events.
- `Tests/TetherProtocolTests/Fixtures/e2e-wire.jsonl` is shared wire traffic used to verify Swift decoding.
- `test/workflows.test.ts` replays a real ls-consensus workflow run (`test/fixtures/workflows`, paths scrubbed): its stream, its transcript read back, its run record, journal and an agent's transcript, and path validation.
- `test/workflowCapture.test.ts` replays a real typo-check run captured with `TETHER_DEBUG_TASKS=1` (`test/fixtures/workflows/typo-check`: the raw task messages in order, the transcript read back, the session's folder), live against history, including the finish landing mid-turn and stopped or failed runs. `test/slowCheckCapture.test.ts` replays a second run (`slow-check`) whose agents ran background commands: its finish said by the event alone, with the record's result, and the agents' commands placed under them, never as notices, and as the `TaskState`s a client gets after each task message (the app's Tasks tab's view of it).
- `test/loopGoalCapture.test.ts` replays a real /loop (two firings, then deleted) and a /goal met on its first check (`test/fixtures/loop-goal`: the live stream from `TETHER_DEBUG_MESSAGES=1`, getSessionMessages' history and the raw transcript, scrubbed), live against history, as items and as schedule and goal tasks.
- `test/scheduled.test.ts` covers the schedule and goal rules (a /loop's job, a one-shot, a dynamic /loop, what the Stop hook lists, a cut prompt, goals' checks); `test/tasks.test.ts` agents' and commands' states live and from history, skill instructions, a live thread seeded with its history, and the task store merged into a read.
- `test/reattach.test.ts` covers stream numbering, background work and eviction, background subagents, task notices and history merging without a CLI.
- `test/connection.test.ts` covers JSONL framing, request correlation, errors and closing; `test/session.test.ts` covers method routing, the handshake's refusals and capabilities.
- `test/cli.test.ts` runs `tether version`, `serve --stdio`, `daemon` and `connect` as processes, each in a fresh `HOME` and `TETHER_HOME` with a stand-in `claude`, including `connect` starting a daemon and replacing one of another version. `TETHER_TEST_BINARY=<path>` runs it against a compiled binary instead of the source.
- `test/generated.test.ts` regenerates the schema and Swift into a temporary directory and fails if the committed files differ: run `mise run gen` after changing `src/protocol`.
- `scripts/e2e-background.ts` (in `mise run e2e`) runs background work across disconnects, a restarted thread's numbering, and eviction against the real CLI. `TETHER_E2E_MODEL`/`TETHER_E2E_EFFORT` choose the model the E2E scripts use.
- `scripts/record-sdk.ts` and `mise run e2e` invoke a real Claude CLI and may write temporary project files or spend provider tokens. Run them only when explicitly useful.
- Daemon tests must set `TETHER_HOME` to a fresh temporary directory. Never test destructive daemon behavior against the user's real `~/.tether`.
- Prefer `serve --stdio` for deterministic local protocol debugging; use daemon E2E only for reconnect, replay, upgrade, or disconnect-survival behavior.

## Continuous integration

`.github/workflows/ci.yml` runs on pushes to `main` and on pull requests:

- On Linux and macOS: `bun install --frozen-lockfile`, `mise run typecheck`, `mise run test`, then `mise run compile` for the runner's own platform and `test/cli.test.ts` against that binary.
- On macOS 26 (Swift 6.2): `swift test`.

CI never runs `mise run e2e` or `scripts/record-sdk.ts`, and has no Claude Code or provider credentials. A test that needs `claude` must use a stand-in, as `test/cli.test.ts` and `test/plugins.test.ts` do.

## Cross-repository contract

The app expects this repository at `../tether-server` and builds against its protocol package by path during development; to run this checkout's server, set a host's Server Command in the app to `<bun> run <path>/src/cli.ts connect`.

When runtime behavior changes, consider all three consumers:

1. TypeScript clients/tests.
2. Generated `TetherProtocol` Swift API.
3. `tether-app` state reducers and UI.

Do not paper over a protocol mismatch with hand-written decoding in the app when the schema or generator is the correct fix.

## Change discipline

- Preserve the core promise: provider configuration stays on the host and turns survive client disconnects.
- Keep stdout protocol-clean; operational logs go to stderr or the daemon log.
- Preserve unrelated work and generated-file provenance.
- Do not delete real Claude sessions, stop the user's daemon, rewrite Git history, or alter authentication/provider configuration without explicit direction.
- Update this guide when commands, topology, or protocol invariants change.
