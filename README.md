# tether-server

A JSON-RPC app server for Claude Code, built on the Claude Agent SDK. Modelled on the Codex app-server. It wraps whichever `claude` binary comes first on the host's `PATH`, so any provider setup that works in a terminal on that host (Bedrock through `AWS_PROFILE`, Vertex, API key, claude.ai login) also works through Tether.

```
tether connect         # what clients run: stdio ⇄ per-host daemon (starts it if needed)
tether daemon          # the daemon: owns live Claude sessions; turns survive client disconnects
tether serve --stdio   # single-client, in-process mode (tests)
```

- **Wire format:** JSON-RPC 2.0 without the `"jsonrpc"` field, one JSON object per line (JSONL). The protocol is defined in `src/protocol` using zod.
- **Schema:** `mise run gen` writes `schema/tether.schema.json` and `Sources/TetherProtocol/Generated.swift`, the Swift package the app consumes.

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
