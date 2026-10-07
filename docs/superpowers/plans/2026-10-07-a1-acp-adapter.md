# A1 — ACP adapter (agent side), skeleton

Goal: `plur1bus acp serve` speaks ACP schema v1 over stdio and maps it onto the core's `session.*` surface
(ADR-008 "Harness as ACP agent"). One ACP session = one harness session of kind `acp` (ADR-003, replayable).

## Shape

- `packages/core/src/acp/framing.ts` — newline-delimited JSON reader with a line limit (oversize line: one
  `-32600` answer, the rest of the line is discarded, the connection stays usable).
- `packages/core/src/acp/server.ts` — the JSON-RPC dispatcher: `initialize`, `session/new`, `session/prompt`,
  `session/cancel` (notification), `session/update` notifications out, unknown method → `-32601`.
  stdout carries JSON-RPC only; logs go to an injected sink (stderr in the binary) and never carry prompt text,
  agent output or credentials.
- `packages/core/src/acp/backend.ts` — the `AcpBackend` port and `CoreSessionBackend`, which uses only
  `session.create|submit|events|cancel` over a `CoreClient`-shaped `call`.
- `packages/core/src/acp-bin.ts` → `dist/acp.js`; `plur1bus acp serve [--agent ID]` (Rust) execs Node on it,
  stdio inherited.
- `session.cancel` (experimental RPC, x-since next minor): aborts the running turn of a session; the turn ends
  `failed` with error `cancelled`. Needed because ACP `session/cancel` must stop the model, not just the stream.

## Tests (test-first)

handshake · prompt round trip with streamed `agent_message_chunk` · tool call/update mapping · cancel mid-turn ·
unknown method · line limit · malformed JSON · non-text blocks refused · concurrent prompt refused · no secret in log ·
`session.cancel` in the turn loop and over core RPC · Rust CLI argv test.

## Out of scope (A1)

`session/load`, `authenticate`, `session/request_permission`, `fs/*`, `terminal/*`, MCP servers passed by the client,
images/audio/embedded resources, outbound schema validation against `schema/v1/schema.json` (ADR-008 follow-up 5).
