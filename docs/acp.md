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

## Client side

The harness is also an ACP client for an external coding agent (`packages/core/src/external-agents/acp-client.ts`). Same schema v1, same line framing, no SDK (owner 2026-10-29). The client sends `initialize` (capabilities `fs.readTextFile`, `fs.writeTextFile`, `terminal`), `session/new` (`cwd` is the provisioned worktree, `mcpServers` is empty until the later D32(d) credential and memory package), `session/prompt` and `session/cancel`. A `protocolVersion` other than 1 is refused.

`session/update` is appended to a harness session whose `origin` is `acp-agent`. `session/request_permission` becomes a D109 approval for subject `acp-agent`; without a person the answer is a denial. `fs/*` and `terminal/*` run only through worktree containment. Unknown methods get `-32601`. Unknown notifications are ignored and counted. A line over 1 MiB, too many open requests, or more than 10 MiB of updates in one turn fails the exchange. Prompt requests use the run deadline and an update-refreshed idle deadline, rather than the generic 15 second request timeout. `initialize`, `session/new` and `session/prompt` carry no memory policy or delegation memory context. D32(d) ACP memory access is deferred; real connector commands remain disabled.

The agent-side table above describes editor permission decisions separately. Editor `fs/*` and `terminal/*` methods remain unavailable.

## External process containment (#820 Q3)

On macOS, every external ACP agent, discovery probe and terminal launch refuses before any process is created with typed
`sandbox-unavailable`, cause `macos-acceptance-pending`. Discovery is metadata-only (executable/login existence and mode),
with no version/initialize execution or credential-content reads. A platform override cannot disguise the real macOS host.
The bounded Core event `external.agent.refused` and Doctor row `external.agents.sandbox` retain the cause. Ordinary sandboxed
tools keep their independent policy. Windows remains fail-closed without the Mac acceptance cause; there is no unsandboxed fallback.
Delegation checks this policy before engine selection, worktree lookup, transcript/turn creation or an injected transport.
The typed collaboration error keeps both reason and cause; see [errors](errors.md#external-acp-platform-refusals).

On Linux, every agent, discovery probe and terminal uses the shared sandbox and native resource helper. Children get a fresh empty
HOME/TMPDIR, a fixed system PATH, no inherited credentials and no network. Discovery runs from empty scratch, never the
user's home. Windows refuses before spawn. Four terminals may be live at once; release and run completion kill and await them.
Terminal creation accepts command, args, cwd and outputByteLimit; output returns immediately with bounded output/truncated and
an exitStatus when finished. wait_for_exit returns exitCode or signal, including after an explicit terminal/kill.
The live tools.sandbox.maxTasks value applies to agents and terminals. Configured agent deadlines through one hour are
honored; ordinary sandbox callers retain their ten-minute ceiling. External read-only review handoffs refuse before any
connection, session or worktree mutation until a read-only external process mode exists.

Each write or terminal creation is evaluated by D109 with its canonical path/content or executable/argv/cwd hash. Only an
allow_once permission option can be selected. A held permission binds its exact ToolCall-ID and action hash, and is consumed
by the first matching action. Calls without that binding receive their own policy decision and, when necessary, their own
human approval. Approved file identities and terminal executable/cwd identities stay bound across authorization; changed targets refuse. Headless approval requests cancel. Abort is rechecked after asynchronous preparation and approval steps.

Linux's sole writable bind exception is an opaque grant from a live Harness worktree record. Its canonical path must be under
state/worktrees, its provisioned device/inode must match, every ancestor must be free of symlinks, and the bounded pre-mount
scan must find no regular file with more than one hard link. Ordinary backend callers retain writable-root refusal. Both
per-worktree and common Git directories are read-only. A Linux process can create links within its own writable mount;
those links make the next mount refuse. Outside link attempts fail with ENOENT or EXDEV.

The existing macOS native helper remains available for D123 acceptance work; production ACP cannot reach it while the
acceptance policy is in force. It has not been replaced by a TypeScript watchdog. The implementation under acceptance gives
each ACP process its own process group. The shared native helper attaches before releasing the target's exec
gate, enumerates all members of its process group with proc_listpgrppids, recursively enumerates children using
proc_listchildpids/proc_pidinfo, and retains identity-checked known descendants across reparenting on 50 ms cycles.
Each PID/start-time identity contributes once to task count and aggregate RSS; same-group orphan children remain measured.
Task/RSS limits are checked during traversal; a scan exceeding 40 ms fails closed rather than extending the sampling interval. Exceeding maxTasks
or RSS kills the entire group with SIGKILL and reports task-limit-exceeded or rss-limit-exceeded, including during streaming.
Observation/attach failure is sandbox-unavailable. Enforcement is sampled: brief overshoot between observations is possible.
A descendant that creates a new session/process group is a residual boundary for group cleanup; this is not a kernel Job
Object/cgroup guarantee or a UID-wide cap. The shared deny-default Seatbelt profile permits ACP forks while preserving
ordinary no-fork callers, denies Apple events and new hard links, and limits file reads/writes to measured runtime, worktree
and scratch paths. Native acceptance remains D123 SB-1 (pnpm hardlink/build and RSS `PROC_PIDTASKINFO` ESRCH) and SB-3
(real Git with relocated-Xcode `libxcrun.dylib`, open/osascript containment). No broad Developer/Xcode read allowance is added.

Card checkouts are not provisioned in production until K2a supplies trusted, assignment-checked provisioning; coding completion and review for a card of a bound project refuse with E_CONFLICT, and external ACP delegation is limited to the root checkout.
Production repo binding provisions the root checkout. Lookup never auto-forks a root or card. Internal provisioner tests
can explicitly create sibling card checkouts beneath state/worktrees/<rootId>; the coding bridge uses such a test-provisioned tree.
Ordinary coding turns and host tools receive no ACP grant; native coding execution is separate K2a work. Host verification uses DB-pinned Git metadata, never a writable .git pointer, and disables clean/smudge/process filters.
Card suffixes use six UUID hex characters after the typed prefix; shortened collisions receive a deterministic alternate.
Removed worktrees retain their branches, which subsequent provisioning safely reattaches without reset or force. Rebinding
or unbinding refuses while worktrees are live. agents.<id>.engine is Owner/Admin writable and audited.

Host completion reads also refuse special files, hardlinks and files over 16 MiB before reading their contents.
