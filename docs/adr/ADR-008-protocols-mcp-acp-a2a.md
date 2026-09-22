# ADR-008: Protocols — MCP, ACP, A2A

**Status:** Accepted (2026-09-22) · **Date:** 2026-09-22 · **Deciders:** Christian (owner) · **Inputs:** `docs/phase0/brief.md` D1, D5, D6, D7; `docs/phase0/auftrag-original-2026-09-21.md` §8, §11, §12 (M6), §13; `docs/phase0/research/protocols-channels-coding-clis.md` (all); `docs/phase0/research/hermes-learnings-and-import.md` A12; `docs/phase0/research/harness-engineering-state-of-the-art.md` rule 7; local spec repos `modelcontextprotocol@24efd6e`, `agent-client-protocol@bba7ddf`, `A2A@afda831`, `buzz@77729ab`

## Context

All three protocols are mandatory (auftrag §8) and all three appear in M6 acceptance: add an MCP server through the UI and use it; expose PLUR1BUS tools to a foreign MCP host; drive the harness from Zed; run an external ACP agent as a team member; have a foreign A2A client find our Agent Card, send a task and receive a streamed result; and have a harness agent consult a remote A2A agent (auftrag §12).

What the specs actually say, verified in the local checkouts:

- **MCP `2026-07-28` is the current final revision.** Two standard transports: **stdio** and **Streamable HTTP** (one POST endpoint, replies as JSON or a request-scoped SSE stream) — `docs/specification/2026-07-28/basic/transports/index.mdx` @ `24efd6e`. Authorization is **OPTIONAL**, applies to HTTP-based transports, is modelled on OAuth 2.1 (`draft-ietf-oauth-v2-1-13`) plus RFC 6750/7591/8414/8707/9728/9207 and OIDC Discovery/Registration; **stdio implementations SHOULD NOT follow it and should take credentials from the environment** — `docs/specification/2026-07-28/basic/authorization/index.mdx` @ `24efd6e`.
- **The same revision deprecates four things we might have leaned on.** `docs/specification/2026-07-28/deprecated.mdx` @ `24efd6e`: **Roots** (SEP-2577, migrate to tool parameters / resource URIs / server configuration), **Sampling** (SEP-2577, migrate to direct LLM-provider integration), **Logging** (SEP-2577, migrate to stderr for stdio and OpenTelemetry for observability), and **Dynamic Client Registration** (PR #2858, migrate to Client ID Metadata Documents) — all with earliest removal "first revision released on or after **2027-07-28**". The old two-endpoint **HTTP+SSE transport** was deprecated in `2025-03-26` and reclassified under SEP-2596, earliest removal "three months after SEP-2596 reaches Final".
- **ACP is not date-versioned.** In the repo at `bba7ddf`, the stable line is **schema v1**, latest entry `1.23.0` (2026-09-18, `schema/v1/CHANGELOG.md`); **v2 is `2.0.0-alpha.5`** (2026-09-18, `schema/v2/CHANGELOG.md`) and can still change wire-incompatibly. Verified v1 method names (`schema/v1/meta.json`, `schema/v1/schema.json` `x-method`): agent side `initialize`, `authenticate`, `session/new|load|prompt|cancel|list|delete|resume|close|set_mode|set_config_option`, `logout`; client side `session/request_permission`, `session/update`, `fs/read_text_file`, `fs/write_text_file`, `terminal/create|output|wait_for_exit|kill|release`, `elicitation/create|complete`, `$/cancel_request`.
- **A2A is at `1.0.0`** (`docs/specification.md` header @ `afda831`), past the 0.3 era. Agent Card at `https://{domain}/.well-known/agent-card.json` (RFC 8615) — `docs/topics/agent-discovery.md:25` @ `afda831`. **Three co-equal protocol bindings**: JSON-RPC 2.0 over HTTP(S) with SSE streaming and PascalCase method names (`§9`), gRPC (`§10`), HTTP+JSON/REST (`§11`). The card `MUST` declare `supportedInterfaces` in preference order and each interface `MUST` declare its transport and URL; clients select the first supported entry (`§8.3`). Security schemes: API key, HTTP auth, OAuth2, OpenID Connect, mutual TLS (`§4.5.2–4.5.6`). Production deployments **MUST** use encrypted communication (`docs/specification.md:1879`). Cards MAY be JWS-signed with JCS canonicalisation (RFC 7515 / RFC 8785, `§8.4`) and clients **SHOULD** verify at least one signature before trusting a card (`:2140`). Push notifications are capability-gated and return `PushNotificationNotSupportedError` when absent (`§7.5`).
- **Token cost is a real constraint.** pi measured MCP at **13.7k–18k tokens of overhead per server, ~7–9% of context per session**, and rejected MCP in favour of CLI-plus-docs ([Zechner 2025-11-30](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/), via `harness-engineering-state-of-the-art.md` rule 7).
- **stdout hygiene.** Hermes's ACP adapter enforces "stdout is reserved for ACP JSON-RPC; human-readable logs go to stderr" (`hermes-learnings-and-import.md` A12) — the same requirement as MCP stdio.

## Decision

Adopt all three protocols with the **official TypeScript SDKs, pinned**, and implement **only the non-deprecated surfaces**. MCP: client (stdio + Streamable HTTP only, per-agent allowlist, per-tool approval, UI management, token accounting) and server (harness functions + engine memory tools for foreign hosts, authorised through harness users/API tokens and RBAC). ACP: **schema v1 only, v2 alpha excluded**, in both directions — harness as ACP agent (Zed, JetBrains, `buzz-acp`, third-party VS Code clients) and as ACP client (the external-coding-agent subsystem, ADR-011). A2A: spec `1.0.0`, **JSON-RPC + SSE as our single declared interface**, server off by default and per-agent opt-in, card at `/.well-known/agent-card.json`, task lifecycle mapped onto harness sessions and tasks, remote content treated as data. Never build on MCP Sampling, Roots, Logging or Dynamic Client Registration.

### Pinned versions

| Item | Pin | Verified | Source |
|---|---|---|---|
| MCP spec revision | `2026-07-28` | yes | `docs/specification/2026-07-28/` @ `modelcontextprotocol` `24efd6e` |
| MCP TS SDK | `@modelcontextprotocol/sdk` **1.30.0** (range `^1.30`) | yes | https://registry.npmjs.org/@modelcontextprotocol/sdk/latest, checked 2026-09-22; also `protocols-channels-coding-clis.md` Table: Protocols |
| ACP schema | **v1**, `1.23.0` (v2 alpha excluded) | yes | `schema/v1/CHANGELOG.md`, `schema/v2/CHANGELOG.md` @ `agent-client-protocol` `bba7ddf` |
| ACP TS SDK | `@agentclientprotocol/sdk` **1.5.0** (exact pin), fluent `agent()` / `client()` API | yes | https://registry.npmjs.org/@agentclientprotocol/sdk/latest, checked 2026-09-22; API shape per `protocols-channels-coding-clis.md` Table: Protocols |
| A2A spec | **1.0.0** | yes | `docs/specification.md` header @ `A2A` `afda831` |
| A2A TS SDK | `@a2a-js/sdk` **1.2.0** (exact pin) | yes | https://registry.npmjs.org/@a2a-js/sdk/latest, checked 2026-09-22; also `protocols-channels-coding-clis.md` Table: Protocols |
| A2A conformance | `a2aproject/a2a-tck` (TCK), `a2aproject/a2a-itk` (ITK) | note-sourced | `protocols-channels-coding-clis.md` Table: Protocols |
| Node engine | ≥ 24 (matches brief D1 and the MCP spec repo's own requirement) | yes | `protocols-channels-coding-clis.md` Table: Protocols; brief D1 |

Exact pins for ACP and A2A (not caret ranges) because both SDKs are young; `^1.30` for the MCP SDK because that line is mature. Renovate/Dependabot opens PRs; upgrades land only with the conformance suite green.

### MCP

**Design consequence of the 2026-07-28 deprecations.** Four capabilities are on a removal clock with earliest removal 2027-07-28 (`deprecated.mdx` @ `24efd6e`). We treat all four as if already removed:

| Deprecated | We use instead |
|---|---|
| **Sampling** (server asks the client for a model completion) | our own provider layer (ADR-006/010). A remote MCP server never gets to spend our tokens through the protocol. This is also a security win: sampling is an inbound request for inference on our account. |
| **Roots** (client advertises working directories) | the agent's `workdir` from its runtime profile (ADR-003), passed as explicit tool parameters or server configuration. |
| **Logging** (protocol-level log notifications) | stderr for stdio servers, OpenTelemetry for everything else — the migration path the spec itself names. |
| **Dynamic Client Registration** | Client ID Metadata Documents for remote OAuth 2.1 servers; pre-registered clients otherwise. |
| **HTTP+SSE two-endpoint transport** | Streamable HTTP only. Not implemented at all, in either direction. |

**Client.** Transports: stdio and Streamable HTTP. Per agent: an explicit server allowlist and a per-tool approval mode (`auto` / `ask` / `deny`) in the runtime profile (ADR-003); servers are registered, tested and managed in the UI (auftrag §8). Because MCP costs 13.7k–18k tokens per server (rule 7), servers are **lazily connected and selectively enabled per agent**, their schema token cost is measured and shown in the UI per server, and the agent's total tool-schema budget is a visible number. Remote servers use OAuth 2.1 with the RFC set the spec lists; tokens live in the secret store (ADR-005), scoped per agent (ADR-003 isolation table). Tool results are untrusted data (auftrag §11).

**Server.** The harness exposes two tool groups to foreign MCP hosts: harness functions (agent listing/invocation, project board, task status) and PLUR1BUS memory tools. Auth and scope map to harness users and personal API tokens (auftrag §8), through the same `authorize()` chokepoint as every other surface (ADR-007) — a token's scopes narrow, never widen, the user's role. Per the spec, **stdio servers take credentials from the environment and do not implement the OAuth flow**; the Streamable HTTP server does, behind TLS and the harness API. Exposed memory tools are ACL-bound exactly as in-process calls: `user` scope requires the caller's principal, `agent-private` requires `manage` on that agent. Deny by default; the default exposure is *no* tools until an operator enables them.

### ACP

**Schema v1 only.** v2 is alpha and explicitly allowed to break wire compatibility while still being called ACP (`schema/v2/CHANGELOG.md` @ `bba7ddf`; `protocols-channels-coding-clis.md` pin recommendation). We also do not follow Hermes onto the unstable track (`use_unstable_protocol=True`, A12). Revisit when v2 reaches a stable release.

**Harness as ACP agent** (`plur1bus-harness acp`): a JSON-RPC-over-stdio server implementing the agent-side methods above, so Zed, JetBrains, `buzz-acp` and third-party VS Code clients can drive a harness agent. Rules: stdout carries only JSON-RPC, all logs to stderr (A12); one ACP session maps to exactly one harness session (replayable, ADR-003); `session/request_permission` is raised whenever the agent's approval policy would ask a human, so the editor's own permission UI becomes the approval surface; non-text prompt blocks are handled or explicitly refused, never silently dropped (Hermes's documented limitation, A12).

**Harness as ACP client:** the external-coding-agent subsystem (ADR-011). As the client we implement `session/request_permission`, `fs/read_text_file`, `fs/write_text_file` and the `terminal/*` family, which is what lets us enforce path containment and command policy on someone else's agent — see ADR-011.

### A2A

**One declared interface.** We implement the **JSON-RPC 2.0 + SSE** binding (`§9`) and declare exactly one entry in `supportedInterfaces` with `protocolVersion "1.0"`. gRPC (`§10`) and HTTP+JSON/REST (`§11`) are out of scope for v0.1; adding one later is a new interface entry, not a redesign. Push notifications stay off (`capabilities.pushNotifications = false`) until a deployment asks — SSE plus our own channels already cover "tell me when it's done", and a registered webhook is an outbound-callback attack surface.

**Server.** Off by default; per-agent opt-in (auftrag §8). Card at `/.well-known/agent-card.json`, with a per-agent base path or tenant. The card advertises identity, skills and security schemes only — **never memory content, never workspace paths, never model or provider names**. A2A's own goal statement is collaboration "without needing access to each other's internal state, memory, or tools" (`docs/specification.md` §1 @ `afda831`); our card must not undercut it. We sign our card (JWS/JCS, `§8.4`) and verify signatures on remote cards where present (`:2140`).

**Task lifecycle → harness objects.**

| A2A task state | Harness |
|---|---|
| submitted | task created on the project board, queued |
| working | a live harness session (replayable, ADR-003) |
| `input-required` (`§4.1.3`, `docs/specification.md:632`) | an elicitation surfaced to the requesting client; mapped to the agent's approval/clarification gate |
| `TASK_STATE_AUTH_REQUIRED` (`:1926-1931`) | a harness auth challenge; the stream is kept open while the credential is obtained out of band |
| completed / failed / canceled / rejected | terminal task status + session end + cost recorded |

Ordering guarantee: events MUST be delivered in generation order and MUST NOT be reordered (`docs/specification.md:683`) — our SSE writer is a single ordered queue per task.

**Client.** Remote agents are registered by URL or card, with a trust level, a per-agent allowlist and a budget, and become targets for `consult_agent` / `delegate_task` (ADR-003). Remote output enters as `tool_result` with provenance, never as instructions (auftrag §7, §11).

**Security.** TLS always (`:1879`). Card security schemes (API key / HTTP / OAuth2 / OIDC / mTLS, `§4.5.2–4.5.6`) map onto harness users and API tokens and then onto RBAC through the single `authorize()` chokepoint (ADR-007). Rate limits per remote peer and per token. Everything reachable only through the harness API — no separate listener.

### Conformance test plan

| Target | Method | Gate |
|---|---|---|
| MCP client | connect to a reference stdio server and a Streamable HTTP server from `@modelcontextprotocol/sdk@1.30.0`; assert no Roots/Sampling/Logging capability is negotiated | CI, every PR |
| MCP client (regression) | a fixture server that *offers* Sampling — assert we decline and still function | CI |
| MCP server | drive our server from the SDK's client against the exposed tool set; assert deny-by-default, per-token scope narrowing, and ACL enforcement on memory tools | CI |
| MCP token cost | measure schema tokens per registered server; fail the build if a bundled default exceeds a budget | CI, nightly |
| ACP agent side | schema-validate every outbound message against `schema/v1/schema.json` @ the pinned version; smoke-drive from `@agentclientprotocol/sdk` `client()` | CI |
| ACP agent side (real client) | manual/nightly: drive from Zed (M6 acceptance) | M6 |
| ACP client side | spawn the ADR-011 Tier-1 set; assert `session/request_permission` reaches the approval policy and `fs/*`/`terminal/*` are path-contained | CI with stub agent, nightly with real CLIs |
| A2A server | `a2aproject/a2a-tck` against our JSON-RPC+SSE endpoint; plus card fetch, JCS canonicalisation and JWS verification tests | CI once integrated |
| A2A client | `a2a-tck`/`a2a-itk` counterpart mode; event-ordering test; `PushNotificationNotSupportedError` handling | CI |
| Cross-protocol | "no memory content in any outbound descriptor" — a single test that greps every generated Agent Card, MCP tool schema and ACP capability payload against a fixture store | CI |
| Privacy/RBAC | deny-by-default on the MCP and A2A endpoints for unauthenticated and Viewer principals (auftrag §11) | CI |

## Options considered

### Option A: Official TS SDKs, pinned, non-deprecated surfaces only (recommended)
| Dimension | Assessment |
|---|---|
| Complexity | Medium |
| Fit with brief D1–D11 | Direct: D1 (TS monorepo, Node ≥ 24), auftrag §8, M6 acceptance |
| Cross-platform risk | Low — pure JS/TS, no native deps; stdio subprocess handling needs a Windows audit |
| Maintenance burden | Medium: three SDKs on independent release cadences, one of them young |
| Latency / token cost | MCP schemas are the dominant cost (13.7k–18k tokens/server); mitigated by lazy, per-agent enablement |

**Pros:** spec conformance is someone else's job; the A2A TCK exists and can gate CI; three deprecation clocks are avoided by construction. **Cons:** SDK churn is real — the ACP TS SDK already deprecated its class-based API once (`protocols-channels-coding-clis.md`), and `@a2a-js/sdk` 1.2.0 is young against a just-1.0 protocol.

### Option B: Hand-rolled protocol implementations
| Dimension | Assessment |
|---|---|
| Complexity | High |
| Fit with brief D1–D11 | Fits functionally, but spends the budget the brief wants on memory and latency |
| Cross-platform risk | Same |
| Maintenance burden | High — three specs to track by hand, MCP revising annually |
| Latency / token cost | Marginally better control over wire overhead |

**Pros:** no SDK churn, minimal dependency surface, exact control (a real argument for A2A, where we want one binding out of three). **Cons:** the spec churn does not disappear, it just becomes ours; the A2A TCK would then test our own code against a protocol we also interpreted ourselves; nothing in the brief rewards it.

### Option C: Delegate to an external bridge process (buzz-acp / acpx style)
| Dimension | Assessment |
|---|---|
| Complexity | Medium |
| Fit with brief D1–D11 | **Conflicts with D1** (single monorepo, one daemon) and with §11 (approval and audit must be in the harness) |
| Cross-platform risk | High — a second supervised binary on five targets |
| Maintenance burden | Shifted, not reduced |
| Latency / token cost | Extra process hop |

**Pros:** proven shape — `buzz-acp` does exactly this and has three agents working today (`crates/buzz-acp/README.md:12` @ `buzz` `77729ab`). **Cons:** permission requests, approval policy, budget and audit would sit outside the harness, which is precisely where ADR-003/007 require them.

## Trade-off analysis

The central trade is **SDK maturity vs. implementation cost**, and it resolves differently per protocol, but not differently enough to justify mixing strategies. MCP's SDK is mature and the spec is the most volatile — SDK wins. ACP's protocol is stable at v1 while its TS SDK is young and has already churned its API once; hand-rolling JSON-RPC over stdio against a published JSON Schema would be genuinely feasible, but the SDK is the SDK the ecosystem tests against, and we can pin exactly and validate every message against `schema/v1/schema.json` ourselves — which gets most of the benefit of hand-rolling without the cost. A2A is the one place where we implement only one of three bindings, so the SDK is partly overkill; the TCK tips it, because conformance evidence is an M6 acceptance criterion and the TCK targets the protocol, not our code.

The second trade is **MCP breadth vs. token budget**. pi's measurement (13.7k–18k tokens/server, 7–9% of context) means that "MCP support" implemented as "connect all configured servers for every agent" would silently tax every turn against D6/D7. Hence per-agent allowlists, lazy connection, and a visible per-server token cost — the feature is supported without being a default-on cost.

The third trade is **A2A reach vs. attack surface**. Off-by-default, one binding, no push notifications and a content-free card is deliberately the smallest thing that satisfies M6. Each of gRPC, REST and push notifications can be added later as an additive change.

## Consequences

- **Easier:** one wire path per protocol to test; spec conformance has an external gate for A2A; deprecated MCP features cannot leak into the design because they are absent; per-agent allowlists give the RBAC story a natural attachment point; adding an A2A binding later is additive.
- **Harder:** three SDK upgrade streams with a conformance gate on each; the ACP v2 decision has to be revisited on a cadence; declining MCP Sampling means any server that *requires* it is unusable by us (acceptable — it is deprecated); the "no memory in descriptors" invariant needs a real test, not a review habit; Windows stdio subprocess handling needs an explicit audit (Hermes hit `conhost.exe` pipe-handle hangs, `hermes-learnings-and-import.md` A14).
- **Revisit when:** ACP v2 ships stable; MCP's next revision lands (check the deprecation registry again — removal becomes possible from 2027-07-28); a deployment needs gRPC or push notifications; or the MCP token tax shows up in D6/D7 telemetry, in which case follow pi/HumanLayer and move that integration to CLI-plus-docs.

## Conflicts with the brief

**Finding 1 — "JSON-RPC binding mandatory" is our requirement, not the spec's.**
auftrag §8 states "JSON-RPC-Binding Pflicht, HTTP+JSON und gRPC optional". In A2A `1.0.0` the three bindings are co-equal (`docs/specification.md` §9/§10/§11 @ `afda831`); the only hard requirement is that the Agent Card declares `supportedInterfaces` accurately and that clients pick the first supported entry (`§8.3`). No binding is mandated by the specification.
**Options:** (a) restate the brief's line as a harness policy ("we implement and declare JSON-RPC+SSE"); (b) implement all three; (c) implement REST instead.
**Recommended resolution:** (a). Functionally identical to the brief's intent, but correctly attributed — and it matters for interop expectations: a conformant remote agent may legitimately offer gRPC only, and our client must fail with a clear "no mutually supported interface" error rather than assuming JSON-RPC exists.

**Finding 2 — "Spec v1.0 with 0.3 compatibility, if the official SDK offers it" (auftrag §8) needs checking.**
A2A `1.0.0` documents a migration with breaking changes (e.g. the `kind` discriminator removed in favour of wrapper member names, `docs/specification.md:3523-3525` @ `afda831`). Whether `@a2a-js/sdk@1.2.0` still speaks 0.3 was **not verified** in this pass.
**Options:** (a) drop 0.3 compatibility for v0.1; (b) verify the SDK and support 0.3 if free; (c) implement a shim.
**Recommended resolution:** (a) with a spike for (b). 0.3 compatibility is conditional in the brief's own wording; do not build a shim.

**Finding 3 — the research note's ACP schema figure is stale.**
`protocols-channels-coding-clis.md` cites "recent releases e.g. `1.16.0`, 2026-06-24". The checked-out repo at `bba7ddf` shows v1 at **1.23.0 (2026-09-18)**. No decision changes (still "pin the v1 line, exclude v2 alpha"), but the pin table above uses the verified figure, and the note should be corrected.

## Open questions for the owner

1. **A2A 0.3 back-compat:** confirm dropping it for v0.1?
2. **A2A push notifications:** stay off for v0.1, or is a webhook target needed for a known integration?
3. **MCP server default exposure:** should the harness MCP server expose *any* tool by default once enabled, or must an operator enable each group explicitly (proposed)?
4. **Memory tools over MCP:** expose read-only recall only, or also capture/write to foreign hosts? (Proposed: read-only for v0.1; writes would let a foreign host mutate the core.)
5. **ACP v2:** should we track the alpha on a branch so the v2 jump is cheap, or ignore it until stable (proposed)?
6. **gRPC binding:** any known counterparty that needs it, or defer indefinitely?

## Action items

1. [ ] Create `packages/protocols/{mcp,acp,a2a}` with the pins from the table; add the `contract` version constants to `docs/assumptions.md`.
2. [ ] Implement the MCP client for stdio + Streamable HTTP with per-agent allowlist, per-tool approval, lazy connect and per-server token accounting surfaced in the UI.
3. [ ] Add the negative capability test: a fixture MCP server offering Sampling/Roots/Logging — assert we negotiate none of them and still work.
4. [ ] Implement the MCP server (harness functions + read-only memory tools) behind `authorize()`, with deny-by-default exposure and stdio-vs-HTTP credential handling per spec.
5. [ ] Implement the ACP agent side (`plur1bus-harness acp`), stdout-JSON-RPC-only, one ACP session = one harness session, `session/request_permission` wired to the approval policy; add outbound schema validation against the pinned `schema/v1/schema.json`.
6. [ ] Implement the A2A server: card generation and JWS/JCS signing, JSON-RPC+SSE binding, task-state mapping table above, ordered event queue, per-agent opt-in, TLS-only.
7. [ ] Implement the A2A client: card fetch and signature verification, interface selection with a clear "no mutually supported interface" error, trust level, allowlist, budget, `tool_result` provenance ingestion.
8. [ ] Wire `a2a-tck` (and `a2a-itk` where applicable) into CI; make the protocol suite a required check for any SDK bump.
9. [ ] Write the cross-protocol "no memory content in any outbound descriptor" test against a fixture store.
10. [ ] Spike (0.5 d): does `@a2a-js/sdk@1.2.0` still speak A2A 0.3? Record the answer and close Conflict 2.
11. [ ] Windows audit of stdio subprocess handling for MCP stdio and ACP (pipe handles, `stdio` inheritance) before M6.
12. [ ] Correct the ACP schema version in `docs/phase0/research/protocols-channels-coding-clis.md` to 1.23.0 @ `bba7ddf`.
