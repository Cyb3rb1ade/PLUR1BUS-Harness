# ACP (Agent Client Protocol) — harness as agent

`plur1bus acp serve [--agent <id>] [--profile chat|coding]` serves ACP **schema v1** on stdin/stdout so an editor (Zed, JetBrains, any ACP client)
can drive a harness agent (ADR-008). It needs a running core (`plur1bus daemon start`). Experimental.

Zed (`settings.json`):

```json
{ "agent_servers": { "PLUR1BUS": { "command": "plur1bus", "args": ["acp", "serve", "--agent", "bernd", "--profile", "coding"] } } }
```

## What is implemented

| ACP | Mapping |
|---|---|
| `initialize` | version negotiation (always `1`), `loadSession: false`, text prompts only, no `authMethods` |
| `session/new` | `session.create` with kind `acp`, then `code.session.open` binds `cwd`; `chat`/`coding` modes when Core supports them |
| `session/set_mode` | human-only `code.session.mode` (RPC 1.21.0), audited; future turns only; one cache-miss notice on a change |
| `session/prompt` | `session.submit`, then `session.events` until the turn ends; `delta` → `agent_message_chunk`, `tool.call`/`tool.result` → `tool_call`/`tool_call_update`; stop reason `end_turn` |
| `session/cancel` (notification) | `session.cancel` → the turn ends `failed(cancelled)`, the prompt answers `stopReason: "cancelled"` |
| agent → client `session/request_permission` | pending D109 request → offered ACP option → fresh Core check → `approval.decide` or cancellation |
| `_app.plur1bus/steer`, `_app.plur1bus/follow_up` | `session.submit` with `delivery: "steer"` / `"queue"`, only when Core advertises the queue contract |
| anything else | JSON-RPC `-32601`; unknown notifications are ignored; bad JSON `-32700`; invalid message `-32600`; bad params `-32602` |

stdout carries JSON-RPC lines only. stderr gets event names and counts, never prompt text, model output, a provider's
error text or a credential (a test pins this). A line over 1 MiB is answered once with `-32600` and discarded.

Prompt blocks: `text` and `resource_link` are used; every other block type is refused with `-32602`
(`reason: unsupported-content-block`), never dropped silently.

## Coding mode and file changes (CX5)

The default startup profile is `chat`; `--profile coding` selects coding for each new session. A Core without the
mode contract keeps the original plain-chat ACP surface and refuses a requested coding startup profile. Modes belong
to one authenticated connection/session; multiple editor tabs keep independent modes. The current turn retains its
admitted tool profile when a mode changes. Memory, persona and the immutable worktree binding are retained.
Legacy Core versions accept only `direct`/`channel` through `session.create`, so plain-chat compatibility uses a
`direct` session titled `ACP` there; it does not claim a coding profile or bind `cwd`. RPC 1.21.0 admits the existing
stored `acp` kind through that closed method enum, with no database migration.

`cwd` is a canonical native Git worktree bound by Core. An ungranted folder is refused (`root-not-granted`); use the
interactive local `plur1bus code` approval path first. **ACP never requests or creates a folder grant (Q25)**, and
switching modes never grants additional access. All tools still pass through D109.

A successful complete UTF-8 `file.write` with Core proof of a new file streams a standard ACP `diff` with
`oldText: null`. Exact full contents are limited to **128 KiB combined**. Existing-file changes without exact full
old/new contents are an explicitly labelled **unified text patch**, including truncation or size-limit labels.
Displayed text patches are capped at 32 KiB. No contents are invented from partial hunks and no editor filesystem
methods are called. A Core-only reverse reconstruction would also require unchanged-file integrity proof; that
contract is not available here. The additive K before/after contract remains open in the D120 plan.
Oversized serialized raw `file.write`/`file.edit` inputs are omitted above 128 KiB and marked in
`_meta["app.plur1bus/raw_input"]`, so their tool-call line stays within the protocol budget. New presentation strings
are English or German using the native CLI's `LC_ALL`, `LC_MESSAGES`, `LANG` precedence.

## Permission decisions

The editor sees only options from the pending Core request: once, or a specifically named task/session lifetime, and
deny. ACP's `allow_always` option kind is used only as a UI hint for those **bounded** task/session scopes; permanent
`always` grants and T3 choices are not offered. T2 choices use `approval.decide` with `attest: true`, so the existing
OS confirmation and helper requirements still apply. Missing helpers or refused confirmation remain a refusal.

Only an agent-issued request id and an offered option id can resolve a permission. The request is checked again
against its session, turn, agent, action hash and current grant options. Malformed, cancelled, expired or late replies
do not grant access; cancellation and connection close withdraw pending choices. Requests are limited to 64 pending,
eight options each, one 1 MiB line and a five-minute deadline. No path calls `grant.create`.

## Rulings (A1, extended by CX5)

- **No SDK.** The ACP v1 surface is hand-written against the schema instead of adding
  `@agentclientprotocol/sdk` (ADR-008 prefers the SDK; revisit with outbound schema validation, ADR-008 follow-up 5).
- **Polling, not subscription.** A turn is followed with `session.events` (persisted, replayable), every 40 ms.
- **Requests before `initialize` are refused** (`-32600`, `reason: not-initialized`).
- **`cwd` is validated and bound through Core** when the coding contract is available. Older Core versions keep the
  original plain-chat behavior. Client-supplied `mcpServers` are accepted and not started (only their count is logged).
- **A failed turn is `-32603 "turn failed"`** with a fixed message; the provider's error text stays in the core.
- **One prompt per session at a time** (`-32000`, `reason: turn-in-progress`).
- **Closing stdin cancels running turns** and ends the process; so does a destroyed stdin or a stdout whose reader went away
  (broken pipe): nothing more is written and the running turns are cancelled.
- **Optional delivery:** `_meta["app.plur1bus/steer"]` and `_meta["app.plur1bus/follow_up"]` are true only when the
  connected Core advertises the queue/delivery contract. Unsupported or unknown custom requests remain `-32601`.
- **Pending H3-1 acceptance:** the CX4 base does not provide that contract. Live post-tool steering and queued-turn
  stream integration must be verified after H3-1; current real-Core tests do not advertise those extensions.
- **Not yet:** editor `fs/*`, `terminal/*`, `session/load|list|resume|…` and non-text content.
