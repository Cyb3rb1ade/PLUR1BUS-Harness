# Federation and full protocol control — implementation plan

**Goal.** Two or more PLUR1BUS instances pair over the LAN or a tailnet, share single projects, contribute agents (as a
service or by joining a session), lend agents on a mission under a lease or hand them over permanently, are
orchestrated from the project's home instance with one trace, and keep shared sessions inside the smallest
participant's context window; MCP and ACP clients get a schema-derived control profile.
Specified in [`2026-10-19-federation-cluster-design.md`](../specs/2026-10-19-federation-cluster-design.md) (cited as
"spec §n").
**Architecture.** Peer link = A2A 1.0.0 (JSON-RPC + SSE) served by `packages/api`, plus the PLUR1BUS federation
extension (spec §5.6); Ed25519 instance key with a per-connection challenge over TLS (spec §5.5); peers and shares in
core state; a peer's agent is an M5 `DelegationTarget` of kind `peer`; the shared session lives on the home instance and
its window is set at runtime through the existing `Compactor` (spec §10).
**Status.** Phase 1: spec and plan only, no product code. **Target: Beta 2, after v0.1.0** (decided) — not in the
v0.1.0 total. Decision record **D114**. Owner questions Q1–Q8 decided on 2026-10-19 (spec §15); the loan and hand-over
modes (b2, b3) were added at the owner's request the same day (WP12, WP13); their open questions Q9–Q14 gate WP12 and
WP13 only.
**Constraints.** Repository rules from `AGENTS.md` and the agent rules (COMMON.md): schema-first RPC and config with
`x-restart`/`x-tier`/`x-stability`/`x-server`, closed params, no new dependency without the dependency policy, the
hygiene lint rules, no secrets in tests or commits, TDD, paket-wise test runs, no CI polling, no force-push, rebase, amend
or stash. Each WP that adds RPC methods, config keys, error reasons or a principal kind carries the schema change and
`pnpm gen`/`docs:gen` output in its own PR.

## Review focus

1. A peer can never reach `admin.*`, `humanOnly` actions, configuration writes, secrets, memories or anything outside a
   share; the control profile's never-exposed set is the WebMCP forbidden set, enforced by one schema-walk test.
2. Pairing needs the code **and** a two-sided confirmation of the short authentication string; a revoked peer is refused
   before any work and loses its live connections.
3. Outbound peer calls go through egress with exactly the peer's pinned address; no general opening of private or
   CGNAT ranges.
4. Nothing from a peer enters a prompt as system or user text; tainted turns require approval for side effects.
5. A shared session's view never exceeds `compactAtRatio × W` for the smallest participant; joins below the minimum are
   refused.
6. `privacy.localOnly` blocks every share, loan and hand-over with a non-local peer.
7. A lent agent never acts without a valid lease (one check before every model and tool call); recall and grace
   timeouts end the mission; mission memories come back with provenance.
8. Loan and hand-over packages never contain a secret; a hand-over archives the original and never deletes it;
   memories with a different embedding identity are re-embedded at the receiver, never imported as foreign vectors.

## Dependencies and order

```text
Prereqs: M6 phase N (MCP server) · phase O (ACP client) · phase P (A2A 1.0 out/in, API-served) · M5 on main · M3 remote access
         · #570 localOnly enforcement · POST egress.request · D109 external principal + taint · RBAC kind "peer"
         · M5+ subprojects track (D115) for WP14

S0 spike ──► WP1 control profile ─────────────────────────────────────────────────┐
   │                                                                               │
   └──► WP2 instance key + pairing + peer principal ──► WP3 transport + egress ──► WP4 project sharing
                                                                                   │
                                     WP5 agent as a service ◄──────────────────────┤
                                     WP6 join + context package ◄──────────────────┤
                                     WP7 window policy ◄── WP6                     │
                                     WP8 orchestration + trace ◄── WP5, WP6        │
                                     WP12 agent loan (b2) ◄── WP3, WP4 ─────────────┤
                                     WP13 agent hand-over (b3) ◄── WP12             │
                                     WP14 subproject share/mission unit ◄── WP4, WP12, M5+ subprojects
WP9 web UI (per WP, final pass after WP14) · WP10 docs · WP11 two-instance CI/E2E ◄┘
```

One branch and one PR per WP (`codex/fed-<wp>-<slug>` or the controller's naming). A WP whose predecessor PR is still
open is a Draft "baut auf #N auf" against that branch; otherwise ready against `main` (COMMON.md).

---

## S0 — Spike and protocol record (≈ 2 agent days)

**Purpose.** Settle the four technical unknowns before product code depends on them.

**Checks (each a recorded yes/no).**
- `@a2a-js/sdk` 1.2.0 (the ADR-008 pin) serves an A2A 1.0.0 card with `capabilities.extensions` and accepts
  extension-defined JSON-RPC methods on the same endpoint; otherwise the fallback `/federation/v1` path (spec §4.3).
- Two cores on one machine behind `tailscale serve` (two tailnet names, or one name and two paths): A2A SSE through
  Tailscale's HTTPS proxy without buffering; first-event latency.
- The Ed25519 challenge (spec §5.5) bound to the TLS session: which channel-binding value is available behind
  `tailscale serve` (none — then bind to the API session + nonce) and on a direct `network` listener (exported keying
  material).
- Egress: a per-peer pinned-address exception for a `100.64.0.0/10` and an RFC 1918 address without widening the SSRF
  ranges (shape of the `decide()` input).
- ACP v1 extension methods `_plur1bus/*` and `_meta` with Zed's current ACP client: ignored cleanly, no error.

**Files.** `docs/handoff/status/2026-1x-xx-fed-s0.md` (results and decisions). Throwaway code only under a spike
directory, not merged.

**Acceptance.** The status doc lists each check with evidence and the resulting decision; no product code merged.

---

## WP1 — Control profile for MCP and ACP (≈ 5 agent days)

**Purpose.** Spec §4: "all functions" over MCP and ACP within RBAC and D109.

**Prerequisites.** Phase N (MCP server) for the MCP half; ACP agent side exists. Q5 decided 2026-10-19: profile minus the WebMCP
forbidden set, no further families for personal tokens.

**Files.**
- `packages/webmcp/src/profile.ts` (new): the derivation now inside `provider.ts` (method → tool, params →
  `inputSchema`, bound params, never-exposed set) extracted into a platform-neutral module; `provider.ts` uses it
  unchanged in behaviour.
- `packages/core/src/mcp-server/control.ts` (in the phase-N server's tree): tool group `control`, names
  `plur1bus_<method>`, exposure per token scope (default none).
- `packages/core/src/acp/server.ts`: `_plur1bus/describe`, `_plur1bus/call`; capability `_meta.plur1bus.control`.
- `docs/acp.md`, the MCP server doc of phase N, `docs/security.md` (matrix section).

**Tests.**
- `packages/webmcp/test/profile.test.ts`: provider output byte-identical before/after the extraction (golden).
- Extended `packages/webmcp/test/rbac-matrix.test.ts`: every schema method that is reachable as an MCP control tool or
  an ACP `_plur1bus/call` target is allowed for WebMCP; every `admin.*` and `humanOnly` method is unreachable on all
  three; a hypothetical future `admin.*` method is refused.
- `packages/core/test/acp/extension.test.ts`: describe lists only allowed methods for the caller; call runs through the
  real guard; agent principal refused for `humanOnly`; unknown method `-32601`; params validated (closed schema).
- MCP: token without control scope sees no control tools; read scope sees reads only; a write family needs its scope.
- No token can be given a never-exposed family: an Owner's personal token that lists `admin.*` or a `humanOnly` family
  in its scopes is refused at creation, and a hand-edited token record with such a scope exposes nothing (Q5).

**Acceptance.** No new RPC method for the profile itself; `node scripts/lint-hygiene.mjs` passes; the matrix test is the
single list of exposure decisions.

---

## WP2 — Instance identity, pairing and the peer principal (≈ 6 agent days)

**Purpose.** Spec §5.2, §5.4, §5.5, §6.

**Prerequisites.** M3 remote access (pairing code store, pair-proof), M2 secret store; RBAC owners accept principal kind
`peer` (P9).

**Files.**
- `packages/core/src/federation/identity.ts`: instance key generation into the secret store, fingerprint, signed instance
  card, rotation announcement.
- `packages/core/src/federation/peers.ts`: `PeerStore` over `state/peers.json` (closed schema, `0600`, atomic writes,
  tombstones, close callbacks), states `pending|active|suspended|revoked`.
- `packages/core/src/federation/invite.ts`: invite codes (identity alphabet, 10 min, one use, three open, salted hash),
  link build/parse, pair-proof reuse, SAS derivation, two-sided confirmation with its own window, lockouts.
- `packages/core/src/federation/session-auth.ts`: challenge, signature check, short-lived connection credential, nonce +
  timestamp replay guard.
- `packages/core/src/rbac/policy.ts` + `packages/rpc-schema/schema/rpc.schema.json`: kind `peer`, federation scopes,
  methods `federation.status`, `federation.invite.create`, `federation.peer.list|add|confirm|suspend|revoke|rename`
  (Owner/Admin; `humanOnly` for invite, confirm, revoke); config keys `federation.enabled`, `federation.displayName`.
  Scopes include `agent.loan` and `agent.handover` (off for a new peer) and the peer record carries `autoAccept` (Q8).
- CLI: `plur1bus federation status|invite|peers|add|confirm|revoke` with `--json` schemas `federation.*/1`.

**Tests.**
- Pairing happy path between two in-process cores; SAS mismatch → no pair; one-sided confirmation → `pending` forever,
  expires; expired, reused and wrong codes; five failures lock the source, ten burn the code; pair-proof detects a
  relaying certificate.
- Peer principal: every `humanOnly` action and every role-gated action refused; scopes narrow per share; unknown kind
  `invalid-principal`.
- Revocation closes live connections (fake transport counts close callbacks); a failed write keeps the old state and
  reports `E_STORAGE`.
- Replay: reused nonce and stale timestamp refused; signature over another callee fingerprint refused.
- Secrets never leave: invite code, instance private key and connection credentials absent from every return, audit
  event, log line and the peer file.

**Acceptance.** `federation.enabled=false` → no route, no invite, `federation.status` says disabled; RPC/config schema
regenerated (`pnpm gen`, `docs:gen` output committed by the controller if Rust is needed).

---

## WP3 — Transport, egress and limits (≈ 4 agent days)

**Purpose.** Spec §5.3, §5.6, §11.2, §8.3 limits.

**Prerequisites.** Phase P (A2A 1.0.0 served by `packages/api`), POST-capable `egress.request` (P7), S0.

**Files.**
- `packages/api/src/federation-routes.ts`: mount the extension methods and the A2A agent routes for peers behind the
  session auth of WP2; same listener as the API (loopback, `tailnet`, `network`).
- `packages/core/src/federation/client.ts`: outbound A2A + extension client; pinned addresses per peer;
  `networkClass`.
- `packages/core/src/egress/`: per-peer exception (exact address + port, only for calls made by the federation client).
- `packages/core/src/federation/limits.ts`: per-peer and per-address limits (A2A defaults), failed-auth lockout before
  signature work; config `federation.limits.*`.

**Tests.**
- Two cores, loopback; fake resolver maps `peer-b.test.ts.net` → `100.64.1.2` → second listener: allowed only for the
  federation client and only that address; `web.fetch` to the same address still refused.
- LAN class with a `192.168.x.y` fixture; a redirect to another private address refused.
- `local` exposure: only same-machine peers; `network` without notice confirmation refuses as today.
- Limits: 61st request in a minute → 429 with the spec's error; failed auth flood locks before any signature check.

**Acceptance.** No Funnel path; no listener beyond the API's; the egress change is covered by the existing egress suite
plus the new cases.

---

## WP4 — Project sharing (≈ 6 agent days)

**Purpose.** Spec §7 (F-R7), §11.1, §11.5.

**Prerequisites.** M5 on `main` (project store, board, trace), #570 enforcement (P6), WP2, WP3.

**Files.**
- `packages/core/src/collab/shares.ts` (with the M5 owners' agreement on the collab tree): share records
  `{ projectId, peerId, level: read|contribute, items, guestMemory, createdBy, confirmedAt, revokedAt }` in the collab
  store (migration), audit events.
- `packages/core/src/federation/project-api.ts`: `federation/project.list|get|subscribe` on the home; redaction of board
  and trace previews; incognito and private chats never included.
- RPC: `project.share.create|list|update|revoke` (project lead + Owner/Admin; create and level raise are `humanOnly`).
- Memory share items (Q3): `project.share.items.add|remove` for single memory entries chosen by their owner; the guest
  gets a copy with `origin.system: "peer:<id>"` and `sourceRef`, tainted; removal sends
  `federation.share.item.revoked`. No worktree files in v1.
- Privacy gate: `privacy.localOnly` (installation or any project agent) → only `localForPrivacy` peers; reason
  `local-only`.

**Tests.**
- Read share: guest sees brief, board and redacted trace; cannot write; other projects invisible (404, no oracle).
- Contribute share: guest posts cards and comments, tagged with peer provenance.
- `localOnly` on the installation, and on one agent only → share with a tailnet peer refused; loopback peer allowed;
  peer listed in `privacy.localEndpoints` allowed.
- Memory markers (pattern `collab/isolation.test.ts`) never in any share payload; secret fixtures never leave.
- Revocation ends subscriptions and contributions at once; guest receives `federation.share.revoked`.
- Memory items: nothing reaches the guest without an explicit per-entry item; an item arrives as a tainted copy with
  provenance; removing it sends `federation.share.item.revoked` and a cooperative guest deletes the copy; a worktree
  path cannot be added as an item (refused).

**Acceptance.** Every share needs an explicit confirmation record; audit shows create/change/revoke without content.

---

## WP5 — Agent as a service (≈ 5 agent days)

**Purpose.** Spec §7.1 (a), §7.2, §8.3.

**Prerequisites.** WP4; M5 `DelegationTarget`, D104 hand-off; phase P outbound client.

**Files.**
- `packages/core/src/collab/target.ts`: kind `peer` added to `DelegationTarget['kind']` (single `delegate_task`
  unchanged).
- `packages/core/src/federation/peer-target.ts`: home side — contract + excerpts → A2A `message/stream` with D104 data
  part and `traceparent`; ack, progress, return, partial on cancel.
- `packages/core/src/federation/serve.ts`: guest side — offered agents (`federation/agent.offer`), incoming task →
  project session `collab-peer:<home>:<project>`, approval gate (`federation.serve.requireApproval`), optional
  per-peer auto-accept within the offered agent's daily token cap (Q8), daily token cap, budget refusal, stateless by
  default (`guestMemory: none`).
- RPC: `federation.offer.list|set|remove` (agent `manage` + Owner/Admin).

**Tests.**
- Home delegates to a guest agent with a fixed fake model; return validated (`validateReturn`), citations required.
- Guest approval pending → home sees `input-required`; denial → refusal, not timeout.
- Auto-accept (Q8): a peer with `autoAccept` starts tasks without a prompt until the daily cap is used up, then every
  task waits for approval again; a contract asking for more than the remaining cap is never auto-accepted; a peer
  without the flag always waits; auto-accept never applies to joins.
- Guest budget exhausted → budget refusal with reason; daily cap enforced.
- Home abort → `tasks/cancel` → partial return on both sides; trace span `partial`.
- A forged approval reference in the contract refused (D104); contract over 2 k tokens sent back for repair.
- Guest memories never recalled or captured with `guestMemory: none` (fake engine counts calls = 0).

**Acceptance.** The guest's model, budget ledger and D109 decisions are the only ones used for the guest's work.

---

## WP6 — Join and context package (≈ 5 agent days)

**Purpose.** Spec §7.1 (b), §9.

**Prerequisites.** WP4, WP5 (transport of turns), M5 project sessions.

**Files.**
- `packages/core/src/federation/join.ts`: `join.request|accept|leave` state machine, participant list per shared
  session, turn scheduling (home decides whose turn; joined agent turns are A2A tasks bound to the session).
- `packages/core/src/federation/context-package.ts`: brief + summary + newest whole turns + referenced excerpts;
  exclusion of zone 3, volatile tail, incognito; redaction; provenance `transformedBy`; optional full transcript by owner
  choice.
- Session store: participant records on project sessions (migration within the M5/session owners' agreement).

**Tests.**
- Package never contains the home agent's frozen snapshot or recall blocks (markers in a fake engine); never an
  incognito session; secret fixtures removed; full-transcript option needs an explicit flag and still fits.
- Joined agent's turns enter as tool-result envelopes with `origin.system: "peer:<id>"`; a home turn after them is
  tainted (approval required for a side-effect tool).
- Leave: participant removed, its live task cancelled, the session continues.

**Acceptance.** Join is refused unless the share level is `contribute`, the home owner allowed joins and the guest owner
allowed this agent to be joined.

---

## WP7 — Context-window policy (≈ 4 agent days)

**Purpose.** Spec §10.

**Prerequisites.** WP6; discovery catalogue `contextWindow`.

**Files.**
- `packages/core/src/federation/window.ts`: `avail_i` per participant (catalogue window − fixed zones − reserve), claim
  capping with the home catalogue, `W = min`, band checks (`minWindowTokens`, `warnWindowTokens`), mixed-tokenizer
  margin.
- `packages/core/src/session/compaction.ts` (with the session owners): a per-session ratio override so a shared session
  uses `min(hardRatio, compactAtRatio)` and `min(softRatio, compactAtRatio − 0.15)`; `configureModel` already scales
  the window; a forced compaction entry point for the join (`prepare` with an optional bounded wait for a prepared
  summary).
- `packages/core/src/federation/pre-turn.ts`: check before every participant turn; `federation.window.changed` and
  `federation.compaction.forced` events; `window.update` handling on model switch and leave; the owner confirmation
  before a join forces compaction of a running session (Q7), reason `compaction-declined` on refusal.
- Config keys `federation.context.compactAtRatio|minWindowTokens|warnWindowTokens|joinSummaryWaitMs` (`live`,
  `advanced`); refusal reason `context-window-too-small` under `E_DENIED`.

**Tests (fake models with 32 k / 128 k windows, deterministic summarizer).**
- Join fits → no compaction; view bound becomes `0.8 × W`.
- Join does not fit → the home owner is asked first (Q7); on confirmation compaction runs before the package is sent,
  view after ≤ bound, checkpoint ran before the swap; on refusal the join is refused with `compaction-declined` and the
  session is untouched; an auto-accepted peer still triggers the question.
- Join below `minWindowTokens` → refused with both numbers; in the warning band → needs confirmation.
- Pre-turn: a long tool result pushes the view over 80 % → swap before the turn, never inside a turn, newest turn kept.
- Mixed tokenizer families → 10 % margin applied; same family → none.
- Leave → `W` grows; hidden history is not re-inserted.
- Under `privacy.localOnly` the join summary uses only a local summarize model or the digest.
- Prompt-cache events: each swap emits `prompt.prefix-invalidated` once per participant; zones 1–3 hashes unchanged.

**Acceptance.** The L14 bound property test (random message sizes, joins and leaves) never observes a view above
`compactAtRatio × W`.

---

## WP8 — Orchestration and trace across instances (≈ 6 agent days)

**Purpose.** Spec §8.

**Prerequisites.** WP5, WP6; M5 fan-out and verifiers (L10).

**Files.**
- `packages/core/src/collab/` (with M5 owners): mode `distributed | parallel` on the orchestration request; merge rules
  `best-of | review | owner` in the contract; `federation.parallelEnabled` gate on top of
  `collaboration.fanoutEnabled`.
- `packages/core/src/federation/trace.ts`: `traceparent` propagation, guest span summaries, stitching into the home
  trace, cycle check by trace id, no-transitivity rule on the guest.
- Board integration: sub-task cards per delegated part; returns as card comments.

**Tests.**
- Distributed: three sub-tasks over one local and two peer agents; verifiers decide; one failing verifier → card
  reopened, not "done".
- Parallel: same contract to a local and a peer agent; each merge rule; parallel refused while either switch is off.
- Abort on the home cancels all peer tasks; partials kept on cards and spans.
- Cycle: a contract whose trace already holds a span of the guest for this project is refused; a guest cannot forward a
  peer contract to a third instance.
- Stitched trace contains every span with redacted previews; replay of home spans identical; guest span replay only
  on the guest.
- Budget: home ledger never books guest cost; guest refusal surfaces as refusal.

**Acceptance.** M5 acceptance 2, 3, 5 and 7 hold with peer targets in the chain (same tests, peer fixtures added).

---

## WP9 — Web UI (≈ 8 agent days)

**Purpose.** Peers, shares, offers, joins and window status in the SPA.

**Files.** `packages/web/src/pages/federation/*` (Peers: list, invite with QR and code, add by link/address, SAS
confirmation dialog, suspend/revoke with consequences, auto-accept toggle, loan/hand-over scopes; Shares per project:
level, items including single memory entries, privacy confirmation, revoke; Offers per agent: join allowed, approval,
daily cap; Session header: participants, effective window, compaction count, "next turn re-reads the conversation"
notice, the compaction question before a join; Loans: offer dialog (scope, expiry, restrictions, memory selection),
acceptance dialog with model mapping and effective tool profile, "on loan from/to" badges, lease state (active,
paused, ended), recall and return, returned mission memories; Hand-overs: offer, acceptance, confirmation dialogs with
the package manifest, provenance on the agent page, archived original, undo within the window), de/en catalogues,
routes, RBAC-based visibility.

**Tests.** Browser suite (mock server): invite → SAS confirm both sides (two mock peers); `localOnly` refusal message;
join warning band dialog; compaction question before a join; revoke flow; loan offer → accept → paused banner on lease
loss → recall; hand-over three-step flow and the archived original; axe light/dark DE/EN, 44 px targets in compact, 400 px layout, keyboard-only.
`node scripts/check-i18n.mjs` passes.

**Acceptance.** Codes appear only in transient page state; no instance key or credential reaches the page.

---

## WP10 — Documentation (≈ 3 agent days)

**Files.** `docs/federation.md` (architecture, peer model, protocol extension, window policy, loans and leases,
hand-overs, limits, audit, known gaps); `docs/user/en/federation.md` and `docs/user/de/federation.md` (pair with a
friend over Tailscale, share a project, offer or join an agent, lend an agent on a mission, hand an agent over, what
leaves your machine, revoke); updates to `docs/a2a.md`, `docs/acp.md`,
`docs/rbac.md` (peer kind and scopes), `docs/egress.md` (peer exception), `docs/collaboration.md` (peer targets),
`docs/architecture/compaction.md` (shared-session ratios), `docs/user/*/privacy.md` (shares under `localOnly`); owner
worksheet `docs/demos/federation.md` (two real hosts on one tailnet, local models, NOT RUN until executed).

**Acceptance.** `node scripts/check-doc-links.mjs`, `pnpm docs:check` command check for the user pages.

---

## WP11 — CI and two-instance end-to-end (≈ 5 agent days)

**Files.** `tests/system/federation.test.ts` (two supervised harnesses with separate homes on loopback, fake chat
providers with fixed windows, fake tailnet resolver seam behind `PLUR1BUS_ALLOW_TEST_INTERNALS=1`), CI job entry in the
system job (Linux, macOS) — workflow changes through the release/CI owners.

**Scenario.** enable → invite → pair + confirm → share (contribute) → offer → delegate (service) → join with forced
compaction (owner confirms) → parallel with `review` merge → abort → loan an agent to the other home (lease, kill the
lender's core → mission paused, restart → resumed, mission memories back at return) → hand an agent over (new ID,
original archived) → revoke → every peer call refused. Plus `localOnly` refusal and
secret/memory-marker scans over both homes' logs, audit and state.

**Acceptance.** Green locally on Linux and macOS with the system-test command from `AGENTS.md`; the real two-machine
tailnet run is recorded once in the owner worksheet (not polled by implementers).

---

## WP12 — Agent loan on a mission (b2) (≈ 8 agent days)

**Purpose.** Spec §7.3 (F-R14): lend an agent to a peer for one borrower project; ownership and identity stay with the
lender; lease while both instances are online; recall, expiry, return; mission memories flow back.

**Prerequisites.** WP3 (transport, egress), WP4 (memory share items: copy, taint, provenance), M5 project sessions,
`agent.export`/`agent.import` (on `main`, experimental), D105 class table and D112 catalogue for the model mapping,
D109 dispatcher wiring (P8). Owner questions Q9, Q10, Q11, Q13, Q14 answered.

**Files.**
- `packages/core/src/federation/loan.ts`: loan state machine (`offered → accepted → active ⇄ paused → returned |
  returned-by-timeout | recalled`), offer/request/accept/decline/recall/return handlers, expiry, removal confirmation.
- `packages/core/src/federation/loan-package.ts`: package from the `plur1bus.agent-export/1` bundle without memories
  plus explicitly selected memory copies; secret references reduced to names; skills by id/version/hash; signature and
  hash with the instance key; manifest for the offer.
- `packages/core/src/federation/lease.ts`: lease issue and verification (signed, `notAfter`), heartbeat client on the
  borrower, renewal handler on the lender, lender/borrower grace timers, outbox for undelivered mission memories.
- `packages/core/src/federation/mission-agent.ts` (borrower): mission agent registration `peer:<lender>/agent:<id>`
  bound to one project, model-profile mapping (class table + catalogue + `minWindowTokens`/`warnWindowTokens`, local
  only under `privacy.localOnly` or a local-locality offer), effective tool profile = agent ∩ borrower mission policy ∩
  lender restrictions, no federation tools.
- Lease gate in the dispatcher path (with the D109/tools owners): one `leaseValid(missionId)` check before every model
  call in the turn loop and every tool call in `policy.decide`'s path; held results on a paused mission.
- `packages/core/src/federation/mission-memories.ts`: mission store tagging, live or on-return push in acknowledged
  batches, lender-side import through `memory.import` with provenance `mission` (or memory proposals with
  `memoryReturn: propose`), borrower-side removal or kept copies (Q13).
- RPC (schema change, own PR section): `federation.loan.offer|request|accept|decline|recall|return|list|get`
  (Owner/Admin; offer, accept, recall `humanOnly`); config keys `federation.loan.*` (spec §12); audit events
  `federation.loan.*`; refusal reasons `context-window-too-small`, `lease-expired`, `loan-recalled` under `E_DENIED`.
- CLI: `plur1bus federation loan offer|accept|recall|return|list` with `--json` schemas `federation.loan.*/1`.

**Tests (two in-process cores, fake models with fixed windows, fake clock).**
- Offer → accept with model mapping → package fetched; the package manifest matches the content hash; acceptance with a
  mapped model below `minWindowTokens` refused, in the warning band needs confirmation; under `privacy.localOnly` only a
  local model can be mapped and only a `localForPrivacy` peer can borrow.
- **No secrets in the package:** secret fixtures in the agent's definition and tool settings never appear in the
  package, the manifest, audit or logs; secret names remain and an unbound name leaves its tool unavailable.
- Selected memories arrive as tainted copies with provenance; unselected memories never (memory markers in a fake
  engine); default selection empty.
- Effective tool profile: a lender restriction removes a tool the borrower would allow; the borrower's policy removes a
  tool the agent has; no standing grant exists at mission start; approvals are asked of borrower persons only.
- **Lease expiry pauses the mission:** stop renewals (fake lender unreachable) → the next model call and the next tool
  call are refused with `lease-expired`; a cancellable tool call is cancelled, a non-cancellable one finishes and its
  result is held; a later successful renewal resumes the mission.
- Lender unreachable beyond `lenderGraceMs` → mission ends, definition and copies removed at the borrower, mission
  memories stay in the outbox (encrypted, not readable by agents) and are delivered at reconnection; outbox purge after
  `outboxDays`.
- Borrower unreachable beyond `borrowerGraceMs` → lender marks `returned-by-timeout`; the returning borrower cannot
  resume, delivers its outbox and confirms removal.
- **Recall:** stops at the next turn boundary with the borrower reachable; with the borrower unreachable the mission
  stops at the latest at lease expiry; the final memory batch is pushed and removal is confirmed.
- **Mission memories back:** live mode pushes acknowledged batches during the mission and the rest at return;
  on-return mode only at the end; lender import with provenance `mission`, duplicates skipped; `propose` mode files
  proposals; at the borrower removed after confirmed delivery, or kept as tagged copies when the offer allowed it.
- Depth: the mission agent has no federation tools; lending on, handing over, offering as a service or joining it to
  another instance is refused; the lender cannot hand over the agent while the loan runs.
- Audit on both sides for every state change (counts and hashes, no content); the lender receives redacted mission
  summaries.

**Acceptance.** No model or tool call of a mission agent without a valid lease (property test over random renewal
outages); every loan ends in a confirmed removal or a timeout state on both sides; secret and memory-marker scans are
clean over both homes.

---

## WP13 — Permanent agent hand-over (b3) (≈ 6 agent days)

**Purpose.** Spec §7.4 (F-R15): two-sided hand-over with a signed package, new agent ID with provenance, archived
original, re-embedding at the receiver.

**Prerequisites.** WP12 (package builder, secret reduction, skill handling, model mapping), `agent.import`,
`agent.archive`, `agent.delete` (on `main`, experimental), `memory.import` and the re-embedding migration
(`docs/embedding-migration.md`). Owner question Q12 answered.

**Files.**
- `packages/core/src/federation/handover.ts`: state machine `offered → accepted → confirmed → delivered → done |
  declined | expired | incomplete`, offer validity (7 days), replay refusal per offer id and package hash, undo within
  `federation.handover.undoDays` if Q12 keeps it.
- `packages/core/src/federation/handover-package.ts`: `plur1bus.agent-export/1` bundle plus the hand-over header (giver
  and receiver fingerprints, offer id, both confirmations), signature and hash; selected memories as text with their
  embedding identity; never secret values.
- Receiver import path: `agent.import` with `onConflict: rename`, new agent ID, `handedOverFrom` provenance;
  memories through `memory.import`, re-embedded with the receiver's model when the identity differs, parked as
  `pending-reembed` while the receiver store is in a re-embedding migration (the importer's rule).
- Giver: `agent.archive` on `handover.done`; `incomplete` with retry when `done` does not arrive; deletion only through
  the separate `agent.delete`.
- RPC (schema change): `federation.handover.offer|accept|confirm|decline|undo|list|get` (Owner/Admin, all decisions
  `humanOnly`, T3); provenance field on the agent record; audit events `federation.handover.*`.
- CLI: `plur1bus federation handover offer|accept|confirm|decline|list` with `--json` schemas
  `federation.handover.*/1`.

**Tests.**
- Three steps with both confirmations; the package is not fetchable before the giver's confirmation; decline and
  expiry at each step leave both sides unchanged.
- **No secrets in the package** (secret fixtures, as in WP12); the receiver must bind its own secret names.
- New agent ID at the receiver with `handedOverFrom` (fingerprint, agent ID, offer id, package hash); rights bounded by
  the receiver's policy, no grants imported.
- **Archive, not delete:** after `done` the giver's original is archived, its store untouched (row counts equal),
  `agent.delete` was not called; without `done` the original stays active and the hand-over is `incomplete`.
- **Re-embedding at the receiver:** giver and receiver with fake embedders of different identities → every imported
  memory is embedded with the receiver's model, no foreign vector stored; same identity → normal import; receiver in a
  re-embedding migration → entries parked as `pending-reembed` and carried by `memory reembed`.
- Replay: a second import of the same package or offer id is refused; a package for another receiver fingerprint is
  refused; a tampered package fails the signature check.
- Undo (if Q12 keeps it): within the window the receiver's agent is archived and the giver's original unarchived;
  after the window refused.
- Audit on both sides for every step, without content.

**Acceptance.** A hand-over never leaves two active owners of one agent and never deletes anything by itself; the
receiver's store never contains vectors of another embedding identity.

---

## WP14 — Subproject as share and mission unit (≈ 4 agent days)

**Purpose.** Make one **subproject** (subprojects spec, D115) the unit a peer is given and a b2 mission is bound to, so
that a guest or mission agent sees exactly that subproject and nothing lateral (subprojects spec §12, §13.1). The
subprojects spec only defined the interface because Track F did not exist; this WP builds the federation side.

**Prerequisites.** The M5+ subprojects track on `main` (at least its WP1 hierarchy, WP2 `visibleFrom`, WP5 report channel,
WP7 allocation and WP11 isolation suite), WP4 (share records), WP12 (loan, lease, mission agent). Federation spec Q14
decided 2026-10-19 (a mission is bound to exactly one borrower project the lender does not see).

**Files.**
- `packages/core/src/collab/shares.ts`: share target `SubprojectRef { rootId, projectId, depth, parentId }`; a share
  names **exactly one** subproject; a root share covers descendants only with an explicit `includeDescendants` set by
  the owner (default off).
- `packages/core/src/collab/visibility.ts` (with the subprojects owners): principal kind `peer` evaluated by
  `visibleFrom` like a child member of the bound node (`self`), never `ancestor`; lookups outside it answer
  `E_NOT_FOUND`.
- `packages/core/src/federation/project-api.ts`: `federation/project.list|get|subscribe` filtered to the bound
  subproject; no breadcrumb beyond it, no sibling, no parent board.
- `packages/core/src/federation/loan.ts` and `mission-agent.ts`: mission scope = one borrower **subproject**; mission
  agent runs with the subproject's D109 roots (its worktree only), the subproject allocation as hard cap for
  borrower-side mission spend (on top of the lease), upward path only `plur1bus.report/1` (tainted on arrival), never
  coordinator tools; loan ends with return when the subproject reaches `completed`, `cancelled` or `archived`; mission
  memories = the subproject pool entries authored by the mission agent.
- RPC (schema change in this WP's PR): optional `subprojectId` target on `project.share.create` and
  `federation.loan.offer|accept`; audit fields `subprojectId` on `federation.share.*` and `federation.loan.*` events.
- Web: share dialog and loan acceptance offer the subproject picker; the guest view shows only the subproject.

**Tests.**
- Subprojects isolation suite (its WP11) gains the rows "federation peer bound to A" and "mission agent in A": no marker of
  sibling B, of the root board or of A's parent anywhere; lookups `E_NOT_FOUND`; refusals audited.
- Root share without `includeDescendants` hides every child; with it, children are visible and grandchildren follow the
  same rule.
- A peer or mission agent cannot call coordinator tools, control or merge the subproject, or create a grandchild (peer
  principals never count as child coordinators for `childrenMayCreate`).
- Mission in subproject A: host tools refuse paths outside A's worktree; exhausted allocation pauses the mission like a
  lease loss; cancelling A ends the loan with return and pushes the mission memories; the lender sees only the redacted
  mission summary.
- A share or loan naming two subprojects, or a subproject of another root, is refused (`E_INVALID_PARAMS`).

**Acceptance.** Every share and every mission binds to at most one subproject; the extended isolation matrix is green;
no peer principal ever receives `ancestor` visibility.

---

## Effort and gates

| WP | Est. (agent days) | Gate |
|---|---|---|
| S0 | 2 | phase P branch available for the SDK check (can start on the ADR-008 pin otherwise) |
| WP1 | 5 | S0; phase N (Q5 decided) |
| WP2 | 6 | S0; M3 pairing on `main`; RBAC kind `peer` accepted (P9) (Q1 decided) |
| WP3 | 4 | WP2; phase P; POST `egress.request` (P7) (Q6 decided) |
| WP4 | 6 | WP3; M5 on `main`; #570 enforcement (P6) (Q3 decided: per-entry memory items) |
| WP5 | 5 | WP4 (Q2, Q8 decided: auto-accept option) |
| WP6 | 5 | WP5 (Q2 decided: join opt-in) |
| WP7 | 4 | WP6 (Q7 decided: owner question before forced compaction) |
| WP8 | 6 | WP5, WP6 (Q4 decided) |
| WP12 | 8 | WP3, WP4; M5 project sessions; D109 dispatcher wiring (P8); **Q9, Q10, Q11, Q13, Q14** |
| WP13 | 6 | WP12; **Q12** |
| WP14 | 4 | WP4, WP12; M5+ subprojects track on `main` (D115) |
| WP9 | 8 | per WP; final pass after WP14 |
| WP10 | 3 | WP14 |
| WP11 | 5 | WP14 |

**Total ≈ 77 agent days** for S0–WP14 (range about 65–96 depending on S0's SDK finding, how much of the M5/M6
prerequisites is on `main` when the work starts, and the answers to Q9–Q14). Before the owner decisions of 2026-10-19
the total was ≈ 54 (45–68); the increase is WP12 (8), WP13 (6), memory share items in WP4 (+1), the loan and
hand-over parts of WP9 (+2), WP10 (+1) and WP11 (+1), and WP14 (+4, added 2026-10-19 with the subprojects decisions,
D115). Not in the v0.1.0 total of `docs/milestones.md`; recorded there as Track F (Beta 2).

## Open points carried from the spec

- Prerequisites P1–P9 (spec §3) belong to M3, M5, M6 (Codex Großpaket 2 phases N, O, P), M2/#570 and the D109
  follow-ups; these WPs consume them and do not re-implement them.
- Locality and window claims of a peer are unverifiable; the design caps windows with the home catalogue and states the
  residual risk for locality in the confirmation dialog.
- Deletion of shared content on a revoked guest depends on a well-behaved guest; the UI says so. The same holds for a
  borrower after a loan: a compromised borrower can keep the definition and the selected memories.
- Owner questions Q9–Q14 (spec §15) on lease and grace times, memory flow back, the lent agent at home, hand-over undo,
  kept mission-memory copies and mission scope gate WP12/WP13; the proposed defaults are in spec §12.
- WP14 waits for the M5+ subprojects track ([`2026-10-19-subprojects.md`](2026-10-19-subprojects.md)), which is
  scheduled directly after the M5 base and therefore before Track F (D115).
