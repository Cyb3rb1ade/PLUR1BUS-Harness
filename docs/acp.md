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

The harness is also an ACP client for an external coding agent (`packages/core/src/external-agents/acp-client.ts`). Same schema v1, same line framing, no SDK (owner 2026-10-29). The client sends `initialize` (capabilities `fs.readTextFile`, `fs.writeTextFile`, `terminal`), `session/new` (`cwd` is the provisioned worktree, `mcpServers` is empty until the later D32(d) credential and memory package), `session/prompt` and `session/cancel`. A `protocolVersion` other than 1 is refused.

`session/update` is appended to a harness session whose `origin` is `acp-agent`. `session/request_permission` becomes a D109 approval for subject `acp-agent`; without a person the answer is a denial. `fs/*` and `terminal/*` run only through worktree containment. Unknown methods get `-32601`. Unknown notifications are ignored and counted. A line over 1 MiB, too many open requests, or more than 10 MiB of updates in one turn fails the exchange. Prompt requests use the run deadline and an update-refreshed idle deadline, rather than the generic 15 second request timeout. `initialize`, `session/new` and `session/prompt` carry no memory policy or delegation memory context. D32(d) ACP memory access is deferred; real connector commands remain disabled.

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

## External process containment (#820 Q3)

Every agent, discovery probe and terminal uses the shared sandbox and native resource helper. Children get a fresh empty
HOME/TMPDIR, a fixed system PATH, no inherited credentials and no network. Discovery runs from empty scratch, never the
user's home. Windows refuses before spawn. Four terminals may be live at once; release and run completion kill and await them.
Terminal creation accepts command, args, cwd and outputByteLimit; output returns immediately with bounded output/truncated and
an exitStatus when finished. wait_for_exit returns exitCode or signal.

Each write or terminal creation is evaluated by D109 with its canonical path/content or executable/argv/cwd hash. Only an
allow_once permission option can be selected. A held permission binds its exact ToolCall-ID and action hash, and is consumed
by the first matching action. Calls without that binding receive their own policy decision and, when necessary, their own
human approval. Headless approval requests cancel. Abort is rechecked after asynchronous preparation and approval steps.

Linux's sole writable bind exception is an opaque grant from a live Harness worktree record. Its canonical path must be under
state/worktrees, its provisioned device/inode must match, every ancestor must be free of symlinks, and the bounded pre-mount
scan must find no regular file with more than one hard link. Ordinary backend callers retain writable-root refusal. Both
per-worktree and common Git directories are read-only. A Linux process can create links within its own writable mount;
those links make the next mount refuse. Outside link attempts fail with ENOENT or EXDEV. macOS denies file-link entirely.

On macOS each ACP process has its own process group. The shared native helper attaches before releasing the target's exec
gate, recursively enumerates children using proc_listchildpids/proc_pidinfo on 50 ms cycles, and sums their RSS.
Task/RSS limits are checked during traversal; a scan exceeding 40 ms fails closed rather than extending the sampling interval. Exceeding maxTasks
or RSS kills the entire group with SIGKILL and reports task-limit-exceeded or rss-limit-exceeded, including during streaming.
Observation/attach failure is sandbox-unavailable. Enforcement is sampled: brief overshoot between observations is possible.
A descendant that creates a new session/process group is a residual boundary for group cleanup; this is not a kernel Job
Object/cgroup guarantee or a UID-wide cap. The shared deny-default Seatbelt profile permits ACP forks while preserving
ordinary no-fork callers, denies Apple events and limits file reads/writes to measured runtime, worktree and scratch paths.

Root and card checkouts are siblings beneath state/worktrees/<rootId>; local coding and completion use the same provisioned
checkout. Host verification uses DB-pinned Git metadata, never a writable .git pointer, and disables clean/smudge/process filters.
Rebinding or unbinding refuses while worktrees are live. agents.<id>.engine is Owner/Admin writable and audited.

Host completion reads also refuse special files, hardlinks and files over 16 MiB before reading their contents.
