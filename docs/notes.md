# Background notes

These notes are background only. They are **not loaded automatically** and **may be stale**. Most of
them describe undocumented Claude Code or Agent SDK behavior that the code depends on, as it was
observed when the code was written. The code and its tests are the authority; check them before
relying on anything here. Current rules live in `AGENTS.md`.

## Hosting and the `claude` binary

- The npm package (`scripts/build-npm.ts`) bundles the Agent SDK but leaves out the SDK's per-platform
  packages, because each of those is a full Claude Code. Tether always runs the host's `claude`. The
  package has no dependencies and no install scripts, and isn't minified.
- The daemon looks up `claude` when it starts, using the PATH of the first `connect`, which is a login
  shell's and not an interactive one's. A client whose host environment (in the app) sets `PATH` or
  `TETHER_CLAUDE_PATH` gets `claude` looked up there instead (`ThreadManager.claudeFor`). That's how a
  wrapper that only an interactive shell's PATH reaches can be used without restarting the daemon. A
  `PATH` set there replaces the daemon's rather than extending it. The SDK runs the file as it is, so a
  wrapper script's exports reach Claude Code.
- Version handoff: `connect` sees a daemon of another version (`daemon.pid`) and asks it to shut down.
  A busy daemon refuses but starts draining, and keeps serving, which means that `connect` attaches to
  the old daemon. Once it's idle it exits, and the next `connect` starts the new one.

## Session defaults

- The SDK always starts a session in `default` permission mode. An interactive Claude Code starts in
  the settings' `defaultMode` (after its trust filter, `filterEscalatingDefaultMode`), otherwise in
  `auto` when the model supports it and auto isn't disabled. That's why `thread/start` without a mode
  uses `startingPermissionMode`.
- `session/defaults` asks a catalog session, never a thread's, because asking about another model
  changes the session's model through flag settings and then puts it back. Questions are asked one at
  a time. An older Claude Code without `get_settings` leaves effort unknown.

## Transcripts and compactions

- One file per session: `<CLAUDE_CONFIG_DIR or ~/.claude>/projects/<project>/<session id>.jsonl`. A
  folder of the same name beside it holds the session's workflow files.
- A compaction boundary has no `parentUuid` and points back with `logicalParentUuid`. Some resumes
  also restart the chain. `getSessionMessages` follows one chain back from the latest message, so on
  its own it shows nothing from before a compaction.
- The SDK drops the boundary's compaction subtype and token counts, and the summary's
  `isCompactSummary`. Both are restored from the file (`restored`), so that a summary isn't shown as the
  person's prompt.
- Records `getSessionMessages` drops and the server needs: `attachment` records (queued
  `<task-notification>`s as `queued_command`, `goal_status`), meta `user` records (scheduled prompts,
  skill instructions), the `local_command` record of a /goal, and `toolUseResult` (Claude Code's
  `structuredPatch` for edits).

## Dynamic workflows

- A workflow's agents run inside the CLI's workflow runner. They have no task, no tool call, and no
  message with a parent tool-use id. Their only trace in the stream is `workflow_progress` on the
  workflow task's progress events, sent at most every few seconds. Entries replace earlier ones by
  type and index (the CLI's own rule), and log lines are dropped.
- The progress `description` names the latest agent, so it's activity, never a title.
- The last progress event is often never sent. When a run settles, its agents that were last seen
  going are treated as finished, except one still waiting for a slot, which never ran.
- The finish `<task-notification>` is never echoed in the live SDK stream: the CLI starts the
  answering turn without echoing it. So live, the `task_notification` event announces the finish, with
  the result taken from the run record, which the CLI writes just before. If a turn is running, the
  CLI hands the notification to the model at the turn's next step and writes it as a `queued_command`
  attachment after that step's tool result.
- A stopped workflow gets no message.
- A workflow agent's own background task is marked `owned_by_subagent` and has a `tool_use_id` inside
  the agent. Its parent is found from the call in the run's `agent-<id>.jsonl`.
- A run known only from its journal counts as running while the transcript or its files were written
  in the last five minutes (`RECENT_RUN_MS`).

## Scheduled jobs and goals

- A job firing (/loop, CronCreate, ScheduleWakeup) is a meta `user` record with
  `turnOrigin: scheduled`. Its uuid is the CLI's command uuid. Live, the stream carries only
  `command_lifecycle` `started` for a command Tether never sent, so the turn opens at once and
  `LiveThread` re-reads the transcript until the prompt appears.
- What will wake a session is reported to every Stop hook as `session_crons` after each turn, with the
  same ids CronCreate returns. Crons are session-only: a new process starts with none. No control
  request lists or deletes crons or the goal.
- /goal: the CLI's `<synthetic>` "Goal set: …" reply and its `goal_status` attachments become `goal`
  notices. While a goal is active, its Stop hook's "Stop hook feedback:" and its brief to the model are
  not shown as messages. `active_goal` was observed to be sent only to remote sessions, so it isn't
  relied on (not re-verified).
- A slash command's tags may be written in either order, so its args are kept whichever comes first.

## Skill instructions

- Claude Code puts a skill's instructions in the conversation as a meta message right after the Skill
  call. Claude often makes several calls in one message, and each content block arrives as its own SDK
  message with that message's id, with results in between. So live, instructions go to the earliest
  Skill call of the same agent that's still waiting for them. A call stops waiting when a new message
  starts at its level, its instructions arrive, it fails, or its turn ends.

## Task state

- Status precedence (`tasks.ts`): a settled CLI status wins, then the background set (and a patch's
  `is_backgrounded`), then a foreground call that finished, then the CLI's status, then the call's own.
  A background launch returns at once, so it counts as running. The process ending stops everything
  still going.
- `background_tasks_changed` includes ambient watchers. They don't count as background work, so they
  don't keep a thread from eviction.
- Task events never reach the transcript, which is why the daemon saves task state (`TaskStore`). A
  task only the transcript knows about, still going in a chat nobody has written to for five minutes,
  is shown as stopped, except a workflow's `waiting`, which its files report.
