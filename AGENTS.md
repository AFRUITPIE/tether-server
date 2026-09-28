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
- `mise run compile`: standalone darwin/linux × arm64/x64 binaries under `dist/`, with the `SHA256SUMS` and `install.sh` a release carries.
- `mise run release`: compile, then publish the binaries, `SHA256SUMS` and `install.sh` as the GitHub release for `package.json`'s version.
- `mise run e2e`: real Claude Code E2E tests. These use the configured account/provider and can incur cost; do not run casually.

## Repository map

- `src/protocol`: Zod definitions and the protocol's source of truth.
  - `common.ts`: shared types, model/settings/catalog data, thread summaries and info.
  - `items.ts`: transcript items, tool calls, turns, and results.
  - `methods.ts`: client-to-server requests.
  - `notifications.ts`: sequenced server-to-client notifications.
  - `serverRequests.ts`: permission, question, plan, and elicitation calls that require a client response.
- `src/rpc/connection.ts`: newline-delimited JSON-RPC framing, correlation, cancellation, and outbound server requests.
- `src/server/session.ts`: handshake validation and method routing for one connected client.
- `src/threads/LiveThread.ts`: one live Claude Agent SDK query, settings, event replay, subscriptions, queued input, and pending requests.
- `src/threads/ThreadManager.ts`: loaded-thread ownership, disk-session resume/read/list, catalog queries, and idle eviction.
- `src/threads/itemizer.ts`: pure-ish SDK-message-to-Tether-item/event reducer.
- `src/threads/pushQueue.ts`: async streaming-input queue.
- `src/daemon/daemon.ts`: Unix-socket daemon, detached startup, stdio bridge, and graceful version handoff.
- `src/server/fsApi.ts`: remote file and Git helpers exposed to clients, including the worktrees `thread/start` can make under `<repo>/.claude/worktrees/` (excluded locally through `.git/info/exclude`) and their removal. A thread started in a subfolder works in the worktree's copy of it; one started inside a worktree gets a new one beside it in the main checkout, not nested; one that fails to start takes its worktree and branch with it. `git/removeWorktree` removes only a registered worktree at exactly `<checkout>/.claude/worktrees/tether-<8 hex>` (never Claude Desktop's), and never loses work unasked: uncommitted changes need `force` (error `worktreeDirty`), and a `claude/tether-…` branch with commits its upstream or the checkout's HEAD lacks needs `discardCommits` (error `worktreeUnmerged`, raised before anything is removed; the branch is deleted with `git branch -d` otherwise). Both errors' `data` is `{ branch, uncommittedChanges, unmergedCommits, worktreeRemoved? }`.
- `src/threads/Scheduler.ts`: scheduled tasks, kept in `schedules.json` in the daemon's home and run from a one-minute timer as new threads. Only the daemon that owns the socket runs them (`serve --stdio` has none), so none runs twice; a run missed during sleep happens once on waking. A run takes the environment the last client to connect sent in `initialize` (held in memory only, as it can hold credentials). Nobody is there to answer a run, so a request it makes of a person is denied once it has waited `TETHER_SCHEDULED_REQUEST_TIMEOUT_MS` (10 minutes) with no client subscribed, ending the turn and recorded as the task's `lastError`; a subscribed client gets as long as it takes. No task starts once the daemon is draining for an upgrade or exiting, and the file is saved then. `schedule/save` replaces a task whole, keeping only what runs recorded; the file is checked entry by entry on load (`loadTasks`), so one bad entry is repaired or skipped rather than breaking `schedule/list`.
- `src/claude.ts`: resolves and reports the host Claude CLI.
- `scripts/gen-schema.ts`, `scripts/gen-swift.ts`: protocol code generation.
- `src/install.ts`: `tether update`, which installs a release the way `install.sh` does.
- `scripts/compile.ts`: standalone binary matrix, and the release files beside it (`scripts/assets.ts`).
- `scripts/install.sh`: the host installer published with each release (`scripts/release.ts`).
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

When a bundled binary version changes, `connect` requests a graceful daemon shutdown. Busy work is allowed to finish; replacement occurs after the manager drains.

## Installing and updating a host

A release carries the binaries (`tether-<version>-<platform>`), `SHA256SUMS` (one `<sha256>  <file>` line per binary, as `sha256sum -c` reads it) and `install.sh`, whose version `compile.ts` bakes in. `release.ts` uploads the binaries `SHA256SUMS` lists, never a glob of `dist/`, which would take a dev build of the same version too.

- `curl -fsSL <releases>/download/v<version>/install.sh | sh`, or `sh -s < install.sh` over SSH, installs `~/.tether/bin/tether-<version>` and points `~/.tether/bin/tether` at it. POSIX `sh` only: it's piped to `sh` because the login shell may be fish (tests run it under `sh` and `dash`).
- `tether update [--version <version>]` does the same in TypeScript, for GitHub's latest release unless told, and says so when `tether` already links to that version. Keep the two in step: `test/install.test.ts` runs both against one fixture.
- The binary is checked against `SHA256SUMS` before it's moved into place: a mismatch, or no `sha256sum` or `shasum` to check with, installs nothing and leaves the link alone. One already there with the right checksum isn't downloaded again. The link is relative and renamed into place. Then other versioned binaries (`tether-<semver>`, dev builds, `.tmp` and `.tether-install.*` leftovers) are deleted, and nothing else; a daemon running one keeps its file.
- Output is `tether-install: …` lines on stdout, the last `Installed Tether <version>` (`tether update`'s `Tether <version> is already installed` instead when there was nothing to do); a failure is one `tether-install: error: <reason>` line on stderr and exit status 1. The app reads these: change them together.
- The environment steers both: `TETHER_VERSION`, `TETHER_INSTALL_DIR` (`~/.tether/bin`), `TETHER_DOWNLOAD_BASE` (`<base>/v<version>/<asset>`), `TETHER_PLATFORM` (else `uname -sm`, or the running binary's), `TETHER_RELEASES_API` (`tether update`'s latest release) and `TETHER_BINARY`, a file to install with no platform, download or checksum: the app's offline path, which checks the binary on the Mac and copies it over itself. A dev build's `install.sh` names its dev version, so it installs only that way.
- Neither touches the daemon. The next `tether connect` through `~/.tether/bin/tether` is the new version, and replaces the daemon as above.

## Protocol invariants

- The wire format is JSON-RPC 2.0-shaped JSONL without a `"jsonrpc"` member: one object per line.
- `initialize` must precede all other methods. Validate every request with its Zod parameter schema.
- Protocol version is `PROTOCOL_VERSION`; changes must remain coordinated with generated Swift types and app behavior.
- Bump `PROTOCOL_VERSION` only for a breaking change. Raise `MIN_CLIENT_PROTOCOL` only when the server can no longer serve older clients: `initialize` then refuses them with `incompatibleProtocol`, carrying both numbers so the app can say which side to update. Additive changes (a new notification, an optional field) bump neither, and a new result field must be optional so older servers still decode.
- `tether version --json` reports the version, protocol range, Agent SDK version and platform without a daemon; clients probe a host with it before installing or updating.
- Every thread-scoped notification carries `threadId` and a monotonically increasing per-thread `seq`. Each event stream (a `LiveThread` or `FollowedThread` instance) starts at `seqOrigin()`, microseconds since the epoch, so a stream begun later — after a process exit, a resume, a rewind or a daemon restart — numbers above every earlier one, and a client's stale `afterSeq` is reported as a gap instead of swallowing new events.
- A history snapshot's `historySeq` states exactly which event prefix it includes. Replay starts after that value so snapshots and live streams never overlap or leave a gap.
- Unknown SDK messages are forwarded as raw events rather than crashing the session. Generated Swift discriminated unions likewise retain `.unknown` cases.
- A server-to-client request remains pending until one subscribed client answers or the SDK cancels it. Re-subscribing clients must receive pending requests again. The first answer wins; other clients receive `serverRequest/resolved`.
- A dropped client never owns a query. Running and action-required threads are not idle-eviction candidates, nor is one with background work (the CLI's latest `background_tasks_changed`, ambient watchers excluded): closing its query would kill that work. The same holds for an upgrade drain. A scheduled run waiting on a person with no client subscribed doesn't hold up a drain: it would only be denied.
- `turn/start` on an unloaded historical thread resumes it before sending. On a running thread, input respects the requested `now`/`next`/`later` priority.

## Claude Agent SDK boundary

`LiveThread` is the adapter around one streaming-input `query()`:

- Use the resolved host Claude binary as `pathToClaudeCodeExecutable`.
- Preserve `settingSources: ['user', 'project', 'local']` and the `claude_code` preset system prompt.
- Merge client/thread environment overrides without dropping the host environment.
- Stamp human input with its human origin so Claude Code features that depend on provenance keep working.
- Keep partial-message streaming, file checkpointing, permission callbacks, elicitation, stderr, task events, and initialization data routed through the typed Tether protocol.
- Session tools (`sessionTools` on `thread/start`/`thread/resume`) are an in-process MCP server named `tether`. Only its own tools (`SESSION_TOOL_NAMES`), and only on a thread that asked for them, skip the permission prompt; any other `mcp__tether__…` tool, such as one from a project's own server of that name, is asked about like every other tool.

SDK types and events can change between Claude Code versions. Be defensive around optional fields, preserve raw unknown events, and cover newly observed shapes with recorded fixtures before tightening assumptions.

## Itemization and history

The live event path and history path must produce the same conceptual `Item` and `Turn` model. `itemizer.ts` pairs tool uses with results, streams agent/reasoning deltas, nests subagent content using parent tool-use IDs, maps status/task events, and closes turns from result messages.

A subagent's messages belong to the turn that launched it, even after that turn ends; a background subagent's tool calls are not cut short when it does. A background task settling becomes one `taskNotification` notice, from either the `task_notification` event or the `<task-notification>` message the CLI hands the model (the only form history has); a foreground command's own task, and a subagent's inner one, get none.

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
- `test/reattach.test.ts` covers stream numbering, background work and eviction, background subagents, task notices and history merging without a CLI.
- `test/install.test.ts` runs `install.sh` and `tether update` against a local `Bun.serve` fixture of releases; nothing leaves the machine.
- `scripts/e2e-background.ts` (in `mise run e2e`) runs background work across disconnects, a restarted thread's numbering, and eviction against the real CLI. `TETHER_E2E_MODEL`/`TETHER_E2E_EFFORT` choose the model the E2E scripts use.
- `scripts/record-sdk.ts` and `mise run e2e` invoke a real Claude CLI and may write temporary project files or spend provider tokens. Run them only when explicitly useful.
- Daemon tests must set `TETHER_HOME` to a fresh temporary directory. Never test destructive daemon behavior against the user's real `~/.tether`.
- Prefer `serve --stdio` for deterministic local protocol debugging; use daemon E2E only for reconnect, replay, upgrade, or disconnect-survival behavior.

## Cross-repository contract

The app expects this repository at `../tether-server` and searches its `dist/` directory during development. A Tether app build can succeed without binaries but emits a warning and cannot bootstrap a fresh host.

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
