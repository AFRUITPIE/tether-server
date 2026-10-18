# tether-server

A JSON-RPC app server for Claude Code, built on the Claude Agent SDK. Modelled on the Codex app-server. It wraps whichever `claude` binary comes first on the host's `PATH`, so any provider setup that works in a terminal on that host (Bedrock through `AWS_PROFILE`, Vertex, API key, claude.ai login) also works through Tether.

```
tether connect         # what clients run: stdio ⇄ per-host daemon (starts it if needed)
tether daemon          # the daemon: owns live Claude sessions; turns survive client disconnects
tether serve --stdio   # single-client, in-process mode (tests)
```

A host runs it from npm, with Node 18 or later. The Tether app runs this, pinned to its version:

```
npx -y tether-server@<version> connect
```

`npm install -g tether-server` installs it instead. The package is one bundled file with no dependencies and no install scripts, published from this repository's workflow with npm provenance.

- **Wire format:** JSON-RPC 2.0 without the `"jsonrpc"` field, one JSON object per line (JSONL). The protocol is defined in `src/protocol` using zod.
- **Schema:** `mise run gen` writes `schema/tether.schema.json` and `Sources/TetherProtocol/Generated.swift`, the Swift package the app consumes.

## Protocol

Version 2 (`PROTOCOL_VERSION`; clients must send `protocolVersion: 2` in `initialize`). `schema/tether.schema.json` has every method, notification and type; `AGENTS.md` ("Protocol 2") what each means. In short:

- Every thread-scoped notification carries `threadId` and a per-thread `seq`; a read's `historySeq` says which events its snapshot includes, and `thread/subscribe` with `afterSeq` replays the rest (`gap` when it can't).
- **Tasks** are typed state: `TaskState` (agents, commands, monitors, MCP tools, workflows and their agents, schedules, goals; each with its `parentId`, `status`, usage and kind-specific fields). `thread/read`, `thread/resume` (with history) and `thread/subscribe` return all of a chat's `tasks`, finished ones included, kept by the daemon across reloads and restarts; `task/updated` sends a task's whole state each time it changes.

## Development (Bun via mise)

```
mise install
mise run install
mise run test          # unit tests (itemizer against recorded SDK fixtures)
mise run typecheck
mise run e2e           # real `claude`, haiku model
mise run gen           # regenerate JSON Schema + Swift
mise run swift-test    # Swift decoding tests against recorded wire traffic
mise run compile       # standalone binaries for darwin/linux × arm64/x64 → dist/
```

## License

MIT, in [LICENSE](LICENSE).
