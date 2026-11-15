# tether-server contributor guide

## What this is

A JSON-RPC server that runs the host's Claude Code through the Claude Agent SDK. It uses the host's own
`claude` (`TETHER_CLAUDE_PATH`, else `PATH`, else the login shell's), so credentials, settings, hooks, MCP
servers and skills stay the host installation's concern. One long-lived daemon per host owns all live sessions,
so turns survive client disconnects. The only client today is the Sundown macOS app (`../Sundown`), which uses
the generated `TetherProtocol` Swift package published from this repo.

```text
tether connect         stdio <-> daemon socket; starts the daemon, or replaces one of another version (what the app runs)
tether daemon          the daemon, on <TETHER_HOME>/tether.sock (mode 0600; TETHER_HOME defaults to ~/.tether)
tether serve --stdio   one client, in-process (development, tests); keeps task state only under an explicit TETHER_HOME
```

There are also `tether status` and `tether version [--json]`. The app runs `npx --yes tether-server@<version> connect`
in the host's login shell, at the version it pins, with no probe or install step first.

## Commands (mise tasks; Bun pinned in `mise.toml`)

- `install`, `typecheck`, `test`: `bun install`, `tsc --noEmit`, Bun unit tests (no `claude`, no network).
- `gen`: regenerates `schema/tether.schema.json` and `Sources/TetherProtocol/Generated.swift` from the Zod.
- `swift-test`: the generated Swift decoding recorded wire traffic.
- `dev`: `serve --stdio` from source.
- `compile`: standalone binaries in `dist/` (`TETHER_TARGETS` to choose). `build-npm`: the npm package in `npm/`,
  a single bundled file for Node 18+.
- `bench`: hot-path benchmarks over copies of real transcripts in `~/.claude/projects` (read-only, no `claude`).
- **Costs money:** `e2e` (`scripts/e2e*.ts`) and `scripts/record-sdk.ts` run the real `claude` on the host's account,
  creating temp projects and real sessions. Run them only when asked, or when nothing else can check a change.

## Repository map

- `src/cli.ts`: modes. `src/version.ts`: `version --json`. `src/claude.ts`: finds `claude` (`resolveClaude`).
- `src/protocol/`: the Zod protocol, and the only schema source. `common.ts` (shared types, `PROTOCOL_VERSION`),
  `methods.ts`, `notifications.ts`, `serverRequests.ts`, `items.ts`, `tasks.ts` (`TaskState`).
- `src/rpc/connection.ts`: JSONL framing, correlation, cancellation, error codes.
- `src/server/session.ts`: one client: handshake, dispatch, subscriptions.
- `src/server/fsApi.ts`: `fs/*`, `git/*`, and worktrees (`thread/start`'s and `git/removeWorktree`). `diff.ts`: bounded diffs.
- `src/daemon/daemon.ts`: socket daemon, detached start, `connect` bridge, version handoff.
- `src/threads/ThreadManager.ts`: loaded and followed threads, stored sessions, the catalog (models, commands,
  account, defaults), eviction, draining.
- `src/threads/LiveThread.ts`: one streaming-input SDK `query()` with its settings, input and pending requests.
- `src/threads/FollowedThread.ts`: a session another process runs, followed by tailing its transcript.
- `src/threads/events.ts`: per-thread numbered stream and replay buffer (`EventStream`, `seqOrigin`).
- `src/threads/itemizer.ts`: SDK messages to items, turns and task states, live and from history.
- `src/threads/transcript.ts`: Claude Code's transcript files (history, `TranscriptExtras`, `TranscriptTail`).
- `src/threads/tasks.ts`, `scheduled.ts`, `workflows.ts`: pure rules for task state, for schedules and goals,
  and for dynamic workflows (and `isSafeId`).
- `src/threads/taskStore.ts`: per-chat task states saved to `<TETHER_HOME>/tasks/<thread id>.json`.
- `src/threads/edits.ts`: edit calls' hunks. `pushQueue.ts`: async input queue. `src/client/TetherClient.ts`: E2E client.
- `scripts/`: code generation, `compile`, `build-npm`, E2E, `record-sdk`. `bench/run.ts`.
- `Sources/TetherProtocol/`: `Generated.swift` plus hand-written `Support.swift`. `Tests/TetherProtocolTests/`: Swift tests.

## Invariants

- **Wire:** JSON-RPC 2.0 as JSONL, one object per line, with no `"jsonrpc"` member.
- **Handshake first:** every method except `initialize` fails with `notInitialized` until it's done. Params are
  validated against the method's Zod schema before the handler runs.
- **Zod is the only schema source.** Never hand-edit `schema/tether.schema.json` or `Generated.swift`; run `mise run gen`
  (`test/generated.test.ts` catches drift). The generator must keep Swift forward-compatible: string enums as
  `RawRepresentable` structs, and discriminated unions with an `.unknown` case.
- **Versions** (`common.ts`): bump `PROTOCOL_VERSION` only for breaking changes. Raise `MIN_CLIENT_PROTOCOL` only when
  older clients can't be served; they then get `incompatibleProtocol`, with both numbers. Additive changes bump neither,
  and new result fields must be optional. `connect`'s upgrade client (`tether-upgrade`) is served at any protocol, but
  only for `host/requestShutdown`, so any release can replace any other's daemon.
- **Sequencing:** thread-scoped notifications carry `threadId` and a per-thread `seq`. `thread/summaryChanged` is
  host-wide and has neither. Each new stream for a thread starts at `seqOrigin()`, above every earlier stream, so a
  stale `afterSeq` shows as a gap rather than dropped events. A read's `historySeq` is taken together with its items
  and tasks, and replay resumes right after it, so snapshot and stream neither overlap nor gap.
- **Disconnects never end work.** The daemon owns the queries. Eviction and upgrade drains skip any thread that is running,
  waiting on a person, starting, or has background work (`ThreadManager.busy`, `sweep`).
- **Server requests** stay pending until a subscriber answers or the SDK cancels. They're re-sent to each client that
  subscribes, the first answer wins, and the rest get `serverRequest/resolved`.
- **Live and history parity:** both paths must yield the same items, turns and tasks. Capture tests assert this.
- **Tasks are whole state:** `task/updated` carries a complete `TaskState`, never a patch.
- **Unmodeled SDK messages are ignored, never errors.** Shapes change between Claude Code versions, so read optional
  fields defensively.
- **Ids that name paths** (session, thread, workflow run, agent) must pass `isSafeId` first.
- **stdout carries protocol only.** Logs go to stderr; the daemon's stderr is `<TETHER_HOME>/daemon.log`, which nothing
  rotates. Claude Code's stderr goes there too, per thread and with long lines cut.
- **Host config stays the host's:** `settingSources: ['user','project','local']`, the `claude_code` preset prompt, and client
  env layered over the host's. Human input is sent with `origin: { kind: 'human' }`.
- **Session tools:** only the `tether` server's own tools (`SESSION_TOOL_NAMES`), on threads that requested them, skip the
  permission prompt.
- **Isolation:** tests must never touch the real `~/.tether`, daemon or Claude sessions. Use temp `TETHER_HOME`
  (and `HOME`/`CLAUDE_CONFIG_DIR` for transcripts) and a stand-in `claude`. `serve --stdio` uses `<TETHER_HOME>/tasks`
  only when `TETHER_HOME` is set; every E2E script sets a temp one.

## Subsystems: where to read and what will surprise you

These depend on undocumented Claude Code behavior, which the code comments record. Background is in
[docs/notes.md](docs/notes.md) (not auto-loaded, may be stale).

- **History across compactions** (`transcript.ts` `readSessionHistory`): the SDK follows only the latest message chain,
  and every compaction starts a new one, so history is rebuilt chain by chain. The SDK also drops records the server
  needs, which `TranscriptExtras` reads back from the raw file. See `test/history.test.ts`.
- **Workflows** (`workflows.ts`, `itemizer.ts`): a workflow's agents are visible only through `workflow_progress` and the
  session folder's files. Where the finish lands depends on whether a turn is running. See `test/workflows.test.ts`,
  `workflowCapture.test.ts`, `slowCheckCapture.test.ts`.
- **Scheduled jobs and goals** (`scheduled.ts`): /loop, CronCreate, ScheduleWakeup and /goal leave almost nothing in the
  stream. The prompt is read from the transcript, and pending wakeups come from a Stop hook (`sessionCrons`). Tether
  runs no scheduler of its own. See `scheduled.test.ts`, `loopGoalCapture.test.ts`.
- **Skill instructions** become the Skill call's `skillInstructions`, never a message. Live they're matched by position,
  in history by `sourceToolUseID`. See `tasks.test.ts`.
- **Task state** (`tasks.ts`, `itemizer.ts` `tasks()`): every state is recomputed from stored CLI facts after any message
  that could change it, and only the changed ones are sent. History has no task events. See `tasks.test.ts`.
- **Task store** (`taskStore.ts`, `ThreadManager.tasksWith`): what only the live stream says (usage, task types, workflow
  agents) is saved and merged into reads. A running task whose process is gone is shown as stopped.
- **Numbering, eviction, background work:** `events.ts`, `ThreadManager.ts`. See `test/reattach.test.ts`.

`TETHER_DEBUG_TASKS=1` (raw `task_*` messages) and `TETHER_DEBUG_MESSAGES=1` (all SDK messages except deltas) log to
the daemon log. Use them to capture fixtures.

## Changing the protocol

1. Edit the Zod in `src/protocol` and the runtime. 2. `mise run gen`, then review both generated diffs.
3. Update the tests. `Tests/TetherProtocolTests/Fixtures/e2e-wire.jsonl` was recorded with `TETHER_RECORD=<file>` on
   `scripts/e2e.ts` (costs money). 4. `typecheck`, `test`, `swift-test`. 5. Apply the version rules and update the app.

**`../Sundown` contract:** `SundownKit/Package.swift` takes `TetherProtocol` from `../../tether-server` by path when the
checkout exists, otherwise from the GitHub release. Keep the Swift package named `tether-server`, matching the folder. To run this
checkout from the app, set a host's Server Command to `<bun> run <path>/src/cli.ts connect`. Fix mismatches in the
schema or generator, not with hand-written decoding in the app.

## Tests, CI, releases

- `test/*.test.ts` replays recorded data with no `claude`. `test/fixtures/sdk/` holds SDK streams from `record-sdk.ts`
  (`itemizer.test.ts`). `test/fixtures/workflows/` holds real runs, scrubbed: ls-consensus at the root, `typo-check/`, and `slow-check/`
  (agents with background commands). `test/fixtures/loop-goal/` holds a real /loop and /goal. Each fixture has the live
  stream, the history read back, and the transcript or session folder.
- `test/cli.test.ts` runs the CLI modes as processes (fresh `HOME`/`TETHER_HOME`, stand-in `claude`), including `connect`
  replacing a daemon of another version. `TETHER_TEST_BINARY=<path>` targets a compiled binary instead.
- Swift: `Tests/TetherProtocolTests` decodes `Fixtures/e2e-wire.jsonl`.
- E2E (costs money): `e2e.ts` (smoke test over `serve --stdio`), `e2e-daemon.ts` (reattach, parked approvals),
  `e2e-background.ts` (background work across disconnects, renumbering, eviction). `TETHER_E2E_MODEL`/`_EFFORT`
  choose the model (default haiku).
- CI (`ci.yml`, pushes to main and PRs): typecheck, test and a compiled-binary `cli.test.ts` on Ubuntu and macOS 26,
  plus `swift test`. No `claude`, no credentials.
- Release (`npm.yml`): merge a `package.json` version bump to main. The workflow tests, builds, smoke-runs
  `node npm/cli.js version --json`, stages on npm via trusted publishing (OIDC, provenance), then tags `v<version>`
  with a GitHub release. A maintainer publishes it by approving with 2FA. `sdk-update.yml` keeps an `agent-sdk` PR
  open that moves to the newest Agent SDK plus a patch bump.

Don't run paid commands, delete real sessions, stop the user's daemon or change host Claude configuration unless asked.
Keep this guide short and true: behavior belongs in code comments and tests, background in `docs/notes.md`.
