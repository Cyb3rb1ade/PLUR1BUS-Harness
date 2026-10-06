# ADR-014: MCP host adapter and trust-routing provenance

**Status:** Proposed (2026-10-06; acceptance stays with the owner) · **Date:** 2026-10-06 · **Deciders:** Christian (owner) · **Inputs:** core spec D17 (MCP client and server per agent, MCP Apps), D19 (trust-routing provenance), D25; ADR-008 (protocols), ADR-016 (API stability), ADR-012 §10 (process model); `docs/milestones.md` §M1 (2b) and §M6; `docs/superpowers/specs/2026-09-27-extensions-ecosystem-design.md` (the *Plugin · MCP server* kind, X2); `docs/superpowers/specs/2026-09-28-basics-quality-bar-design.md` (D109 permissions, D94 provenance); plan `docs/superpowers/plans/2026-10-06-m1b-2b-mcp-client.md`.

## Context

ADR-008 decided *which* MCP surfaces the harness uses (official TypeScript SDK, stdio and Streamable HTTP only, none of the deprecated features). It left the **host side** open: how the harness runs MCP servers on behalf of agents, how long they live, what an agent receives back, and what a malicious or broken server can do to the harness. D17 and D19 name the missing pieces (scope, idle timeout and schema cache, MCP Apps, a provenance envelope) and point at this ADR. 2b delivers the **client transport** only; the turn loop that will call it (2c, D106, the D109 policy chokepoint) does not exist yet, so the interfaces here are written to be called by it later.

Facts that shape the design:

- Every MCP server is third-party code or a third-party service. Its tool *results* are untrusted data that reach a model; its *process* runs with the harness user's rights.
- MCP schemas are expensive (13.7k–18k tokens per server, ADR-008). A server that is connected for every agent on every turn taxes every prompt, and a server that is spawned per call pays process start-up on every call.
- `@modelcontextprotocol/sdk` **1.32.1** (MIT, current stable 1.x on 2026-10-06) implements stdio and Streamable HTTP clients, request timeouts and `AbortSignal`s. Its latest negotiated protocol revision is **2025-11-25**; the `2026-07-28` revision ADR-008 pins as the spec reference is not yet in the SDK's `SUPPORTED_PROTOCOL_VERSIONS`. Nothing in this ADR depends on 2026-only features.
- A client declares capabilities in `initialize`. By default the SDK client declares none; Sampling, Roots (and Elicitation) exist only if the host registers handlers and declares them. Logging is a *server* capability the client may merely use.

## Decision

**The harness runs MCP servers through one in-process client layer in the core (`packages/core/src/mcp/`). A server is registered per scope, started lazily, stopped when idle, never trusted, and every result it returns is wrapped in a D19 provenance envelope that marks it as data. The client negotiates no optional client capability.**

### 1. Scope (D17)

A registered server has exactly one scope:

| Scope | Process | Visible to | Typical use |
|---|---|---|---|
| `installation` | one shared process (or one remote session) | every agent that is allowed to use it | a docs server, a PIM module's tools |
| `agent` | one process **per owning agent**, never shared | that agent only | a server holding that agent's credentials or workspace |

Rules: a server's identity is `(scope, agentId?, name)`. A name is unique per agent *as that agent sees it*: registering an `agent` server whose name an `installation` server already uses is refused (`invalid-config`), so a tool name never changes meaning under an agent. An agent can never see, call or learn the existence of another agent's `agent`-scoped server (`not-registered`, not `forbidden`, so existence is not an oracle). Which agents may use an `installation` server (the per-agent enable list, X2) is a policy input for D109 and is **not** decided here; the registry takes the caller's `agentId` and applies scope visibility only.

### 2. Lifecycle (D17)

- **Spawn on demand.** Registering a server starts nothing. The first `listTools` that cannot be answered from the cache, or the first `callTool`, starts the process (stdio) or opens the session (HTTP) and runs `initialize`. Concurrent first calls share one start-up.
- **Idle shutdown, default 15 minutes.** Each use re-arms an idle timer. When it fires, the connection is closed and, for stdio, the process is terminated and reaped. A call in flight holds the timer; it re-arms when the last call settles. The idle time is configurable per installation (`mcp.idleTimeoutMs`) and uses an injectable clock so tests need no sleeping.
- **The tool-schema cache survives the idle stop** (D17). `listTools` is answered from the cache while the server is stopped; the server is started only by a call, by an explicit refresh, or when the cache is stale. The cache is keyed by server identity, holds the tool descriptors and an estimated schema token cost, and is invalidated by `notifications/tools/list_changed`, by an explicit refresh, and by a change of the server's definition. It is memory-only in 2b; persisting it across core restarts is a follow-up.
- **No automatic restart.** A crash or a closed transport marks the server `stopped` with its last error; the next call starts it again. There is no background supervision loop here (the supervisor's restart policy is for the core and modules, not for third-party tool servers).
- **Shutdown.** Core shutdown closes every connection and kills any process that has not exited within a short grace period. No server outlives the core.

### 3. Provenance envelope (D19)

Every tool result leaves the client as:

```
{ provenance: { origin: { system, agent, principal, trust }, hops, transformedBy },
  server, tool, isError, content, structuredContent? }
```

- `origin.system` is `mcp:<server name>`; `origin.agent` is `null` (an MCP server is a system, not an agent; A2A peers will fill it); `origin.principal` is the principal the call ran **under** (the calling agent's principal, D17); `origin.trust` is `untrusted` unless the installation's configuration marks the server `operator-vetted`. `trust` describes the origin, not the caller.
- `hops` counts system boundaries the content has crossed (1 for a direct MCP result; a forwarded A2A message adds its own).
- `transformedBy` lists what the harness did to the content on the way (`truncate` when a result was cut to the size cap; `redact` when a secret value was removed). An empty list means the bytes are as the server sent them.
- Content from an `untrusted` origin is **data, never instructions**. The turn loop (2c) must ingest it only as a `tool_result`, never as system, assistant or user text. Text in a result that claims an approval has no effect (D109: approvals exist only as store records).
- The envelope is created by the client wrapper, not by the caller, so no code path returns a raw MCP result.

### 4. MCP Apps and sandbox rules (D17)

An MCP App is a `ui://` resource a tool points to, rendered by the **host**. 2b only *detects* it: a tool descriptor carries `uiResourceUri` when the server's tool metadata names one, so the CLI can say "app available". The client does **not** yet advertise a UI extension and does not fetch `ui://` resources; that comes with the M3 renderer. Rules the renderer and the proxy must follow, recorded now so the interfaces fit:

1. App HTML is third-party code: rendered only in a sandboxed `<iframe sandbox="allow-scripts">` **without** `allow-same-origin`, on an opaque origin, with a CSP of `default-src 'none'` plus the resource's declared, host-approved origins; no cookies, no storage, no top navigation, no popups, no forms.
2. The iframe talks to the host only through a `postMessage` bridge. The host checks `event.source` against the iframe it created and a per-instance nonce, validates every message against a closed schema, and rate-limits.
3. The only thing an app can ask the host to do is **call tools of its own server**. Those calls go through the same registry path as an agent's (D109 decision, provenance envelope, audit) under the **agent's principal**, never a broader one, and never to another server.
4. Apps get no ambient host data (no memory, no session, no credentials); every byte they see was passed in explicitly.
5. The CLI and any non-rendering surface report "app available" and nothing else. An app is never executed headlessly.

### 5. Capabilities that are not negotiated

| Capability | Decision | Why |
|---|---|---|
| **Sampling** | never declared; a server's `sampling/createMessage` request is answered `method not found` | the server would spend our tokens and steer our model; ADR-008 routes inference through our own provider layer; deprecated in 2026-07-28 |
| **Roots** | never declared; `roots/list` is answered `method not found` | would hand a third party our filesystem layout; the agent's workdir is passed as an explicit tool parameter or server configuration; deprecated |
| **Logging** | never used; `logging/setLevel` is never sent, `notifications/message` is ignored | an unauthenticated side channel into our logs; stdio servers log to stderr (captured, redacted, rate-limited), others to OpenTelemetry; deprecated |
| **Elicitation** | not declared in 2b | a server prompting the person needs a surface (2c/M3) and D109 approval design; may be added by its own decision |
| Dynamic Client Registration, HTTP+SSE two-endpoint transport | not implemented | ADR-008 |

A server that *requires* any of these is unusable by us; `tools/list` and `tools/call` still work against every server that does not. The handshake is tested negatively: the `initialize` request the server receives carries `capabilities: {}`, and a fixture server that offers all three and then issues `sampling/createMessage` and `roots/list` still works while both are refused.

### 6. Error and timeout model

One error class, `McpClientError`, with a closed code vocabulary: `invalid-config`, `not-allowed`, `not-registered`, `connect-failed`, `connect-timeout`, `call-timeout`, `aborted`, `unknown-tool`, `server-error`, `protocol`, `closed`. A tool that ran and reported `isError: true` is **not** an exception: it is a normal result (with provenance) the model can read. Protocol and transport failures are exceptions with a `retryable` flag. Messages are redacted (§7) before they are constructed.

Defaults (all configurable, all bounded): connect (spawn + `initialize`) 30 s; `tools/list` 15 s; `tools/call` 60 s; process-exit grace 2 s before `SIGKILL`; result cap 1 MiB of text; at most 50 `tools/list` pages. Every call accepts the caller's `AbortSignal` and also runs under its own deadline; whichever fires first wins and the code distinguishes them (`aborted` vs `call-timeout`).

**A timeout or abort tears the connection down.** A server that did not answer in time may be wedged or may answer late into a later request, so the client closes the transport, terminates the process (`SIGTERM`, then `SIGKILL` after the grace), waits for exit and marks the server `stopped`. The next call starts a fresh one. A wedged server therefore costs one failed call, never a hung agent or a leaked process.

### 7. Security

- **Stdio only from an allowlisted command.** `mcp.allowedCommands` is a list of absolute paths and bare command names (`node`, `npx`, `uvx`, …) that **defaults to empty**: with no allowlist no stdio server can start. A bare name matches the command exactly (no path separators, no shell metacharacters, no arguments inside the command string); an absolute path must match an entry exactly. Shells and interpreters-with-`-c` are never default entries. The command is spawned directly (no shell), with an argument array.
- **Environment passing.** The child gets the SDK's minimal inherited set (`PATH`, `HOME`, `USER`, …) plus only the variables the server definition declares, by name, either literal or `fromHost` (copied from the harness's own environment at spawn). Nothing else of the harness's environment, including the engine, provider and token variables, is inherited. Logs record variable **names** and never values.
- **No secrets in logs.** A redactor holds every declared environment value flagged secret (any variable whose name matches `token|secret|key|password|credential|auth`, every `fromHost` value, every HTTP header value) and removes occurrences from server stderr, error messages and log fields before anything is written. Server stderr is captured (not inherited), split into lines, redacted, length-capped and rate-limited. Redaction is exact-value matching; it is a backstop, not a licence to log servers' output (D111's writer-side redaction will apply on top).
- **HTTP.** `https:` is required except for loopback hosts; credentials in the URL are refused; headers are static in 2b (OAuth per ADR-008's headless ladder lands with D67). No redirect-following surprises are added over the SDK's behaviour; an SSRF guard with DNS pinning (as A2A has, D63) is a recorded follow-up before remote servers are offered in the UI.
- **Results are untrusted data** (§3). Tool schemas are untrusted too: names and descriptions are length-capped and are not interpreted by the harness.
- **Read-only introspection.** `mcp.list` and `mcp.status` (RPC, `experimental`) never start a server and never return stderr, environment values, headers or tool results.

## Options considered

### Option A: in-process client layer in the core, lazy and scoped (recommended)
| Dimension | Assessment |
|---|---|
| Complexity | Medium: one layer, one registry, SDK does the wire |
| Fit | Direct: D17, ADR-008 option A, the 2c tool dispatcher calls it in-process |
| Cross-platform risk | Low for HTTP; stdio needs the Windows audit already in ADR-008 action 11 |
| Token and latency cost | Lazy start plus the surviving schema cache keeps idle servers free |

**Pros:** one chokepoint for approval, provenance, redaction and audit; no extra IPC hop; easy to test with a fake clock. **Cons:** a crashing SDK bug runs in the core's process (mitigated: the child servers are separate processes; the SDK is pinned); a leaking server process is the core's to clean up (hence the explicit reaping rules).

### Option B: each MCP server as a D14 module under the supervisor
**Pros:** the supervisor already restarts, health-checks and isolates modules. **Cons:** modules are first-party, manifest-declared, API-versioned processes speaking the harness RPC, not arbitrary third-party stdio servers; wrapping every MCP server in a module adds a manifest and an RPC hop per server and makes the supervisor own untrusted lifecycles. Rejected; the X2 `mcp-server` kind *installs* servers (files, trust, effects) and registers them here, it does not turn them into modules.

### Option C: one always-connected client per server, shared by all agents
**Pros:** simplest, no start-up latency after the first call. **Cons:** pays the idle process and (via 2c) the schema tokens for every agent; no isolation between agents' credentials; contradicts D17's `scope: agent`. Rejected.

### Option D: spawn per call
**Pros:** no state, no idle logic. **Cons:** start-up cost on every call (hundreds of ms for Node or Python servers), no schema cache, breaks servers with session state. Rejected.

## Trade-off analysis

The central trade is **lifetime vs. cost and blast radius**. Lazy start with idle shutdown and a surviving cache gives the cheap path (cached listings, no process) most of the time and bounds how long a third-party process lives. Tearing down on every timeout trades some re-start cost for never trusting a server that has stopped answering. Scope is the second trade: `agent` scope costs a process per agent but is the only way to keep one agent's credentials out of another agent's reach; `installation` scope is the default for credential-free servers. The third is **safety vs. reach**: an empty command allowlist and `untrusted` provenance make "add an MCP server" a deliberate, visible act (X2's install disclosure, D38 approvals) rather than something a config file or a prompt can do silently.

## Consequences

- **Easier:** the 2c turn loop gets one call surface (`listTools`, `callTool`) with provenance, timeouts and cleanup already decided; X2 can register installed MCP servers without new lifecycle code; the negative-capability and leak tests run on every PR against local fixture servers.
- **Harder:** the core now owns child processes of third parties and must reap them on every path (idle, timeout, abort, shutdown, crash); the allowlist is one more thing a person must configure before a stdio server works; exact-value redaction cannot catch a secret a server transforms before printing.
- **Not decided here (follow-ups):** the per-agent enable list and D109 decision call (2c/D106, X2); persistence of the schema cache; OAuth and SSRF guard for remote servers (D67, D63); MCP Apps fetch and renderer (M3); an `mcp` CLI group; the MCP *server* side (M6, ADR-008).
- **Revisit when:** the SDK supports the `2026-07-28` revision (re-check the negotiated version and the deprecated-feature list); a server class needs Elicitation; the token cost shows up in D6/D7 telemetry.

## Rulings (defaults taken where the documents were silent)

1. **SDK pin is exact (`1.32.1`)**, not `^1.30` as ADR-008's prose says: a lockfile-pinned exact version makes SDK bumps a reviewed change; the caret range stays the upgrade policy for the bump PR.
2. **`origin.trust` defaults to `untrusted`**; the only other value in 2b is `operator-vetted`, settable only in installation-level configuration.
3. **Stdio allowlist defaults to empty** (fail closed).
4. **`http:` only for loopback.**
5. **A timeout or abort closes and kills the connection** (§6).
6. **Elicitation is not declared** in 2b although D17 does not mention it.
7. **The schema cache is memory-only** in 2b.
8. **Result cap 1 MiB; `tools/list` page cap 50.**

## Open questions for the owner

1. Is `operator-vetted` the right second trust level, or should trust come from the D109 capability taxonomy instead?
2. Should the stdio allowlist ship with `node`, `npx` and `uvx` pre-listed once X2's disclosure UI exists, or stay empty for ever?
3. Should an `agent`-scoped server be able to be marked shareable to named agents (a per-server ACL), or is `installation` plus the enable list enough?
4. Is the SDK's lack of the `2026-07-28` revision acceptable until the next SDK release, or must ADR-008's spec pin be restated to `2025-11-25` for the client?

## Action items

1. [x] `packages/core/src/mcp/`: client, registry, idle manager, schema cache, provenance, redaction, timeouts (this plan).
2. [x] Fixture MCP server (stdio and Streamable HTTP, local only) and the tests listed in the plan.
3. [x] `mcp.list` / `mcp.status` (experimental, read-only) and the `mcp` config block.
4. [ ] D109 `policy.decide` in the dispatcher in front of `callTool` (2b/2c).
5. [ ] Per-agent enable lists and the `mcp-server` extension kind (X2).
6. [ ] OAuth (D67) and SSRF guard for remote servers; Windows stdio audit (ADR-008 action 11).
7. [ ] MCP Apps fetch and sandboxed renderer (M3, §4 rules).
8. [ ] Re-check negotiated protocol revision on every SDK bump; conformance gate per ADR-008.
