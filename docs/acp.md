# ACP (Agent Client Protocol) — harness as agent

`plur1bus acp serve [--agent <id>]` serves ACP **schema v1** on stdin/stdout so an editor (Zed, JetBrains, any ACP client)
can drive a harness agent (ADR-008). It needs a running core (`plur1bus daemon start`). Experimental.

Zed (`settings.json`):

```json
{ "agent_servers": { "PLUR1BUS": { "command": "plur1bus", "args": ["acp", "serve", "--agent", "bernd"] } } }
```

## What is implemented

| ACP | Mapping |
|---|---|
| `initialize` | version negotiation (always `1`), `loadSession: false`, text prompts only, no `authMethods` |
| `session/new` | `session.create` with kind `acp`: one ACP session = one harness session (replayable like any other) |
| `session/prompt` | `session.submit`, then `session.events` until the turn ends; `delta` → `agent_message_chunk`, `tool.call`/`tool.result` → `tool_call`/`tool_call_update`; stop reason `end_turn` |
| `session/cancel` (notification) | `session.cancel` → the turn ends `failed(cancelled)`, the prompt answers `stopReason: "cancelled"` |
| anything else | JSON-RPC `-32601`; unknown notifications are ignored; bad JSON `-32700`; invalid message `-32600`; bad params `-32602` |

stdout carries JSON-RPC lines only. stderr gets event names and counts, never prompt text, model output, a provider's
error text or a credential (a test pins this). A line over 1 MiB is answered once with `-32600` and discarded.

Prompt blocks: `text` and `resource_link` are used; every other block type is refused with `-32602`
(`reason: unsupported-content-block`), never dropped silently.

## Client side

The harness is also an ACP client for an external coding agent (`packages/core/src/external-agents/acp-client.ts`). Same schema v1, same line framing, no SDK (owner 2026-10-29). The client sends `initialize` (capabilities `fs.readTextFile`, `fs.writeTextFile`, `terminal`), `session/new` (`cwd` is the provisioned worktree, `mcpServers` is empty until package P), `session/prompt` and `session/cancel`. A `protocolVersion` other than 1 is refused.

`session/update` is appended to a harness session whose `origin` is `acp-agent`. `session/request_permission` becomes a D109 approval for subject `acp-agent`; without a person the answer is a denial. `fs/*` and `terminal/*` run only through worktree containment. Unknown methods get `-32601`. Unknown notifications are ignored and counted. A line over 1 MiB, too many open requests, or more than 200 updates in one turn fails the exchange. `initialize` and `session/new` do not carry memory content. `memoryExposure.acp` is package P's channel and is not placed on those messages.

The agent-side table above is unchanged: `plur1bus acp serve` still does not implement `request_permission`, `fs/*` or `terminal/*`.

## Rulings (A1)

- **No SDK.** The ACP v1 surface needed here is five methods; it is hand-written against the schema instead of adding
  `@agentclientprotocol/sdk` (ADR-008 prefers the SDK; revisit with outbound schema validation, ADR-008 follow-up 5).
- **Polling, not subscription.** A turn is followed with `session.events` (persisted, replayable), every 40 ms.
- **Requests before `initialize` are refused** (`-32600`, `reason: not-initialized`).
- **`cwd` is validated (absolute) and neither stored nor used**; client-supplied `mcpServers` are accepted and not
  started (only their count is logged).
- **A failed turn is `-32603 "turn failed"`** with a fixed message; the provider's error text stays in the core.
- **One prompt per session at a time** (`-32000`, `reason: turn-in-progress`).
- **Closing stdin cancels running turns** and ends the process; so does a destroyed stdin or a stdout whose reader went away
  (broken pipe): nothing more is written and the running turns are cancelled.
- **Not yet:** `session/request_permission`, `fs/*`, `terminal/*`, `session/load|list|resume|…`, non-text content,
  the approval policy hookup (needs the Approval store), A2A/MCP-server side.
