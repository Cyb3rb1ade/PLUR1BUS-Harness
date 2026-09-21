# ADR-007: Users, roles, identity linking

**Status:** Proposed · **Date:** 2026-09-22 · **Deciders:** Christian (owner) · **Inputs:** `docs/phase0/brief.md` D2, D3, D10; `docs/phase0/auftrag-original-2026-09-21.md` §2.1, §5.1, §8, §9, §11, §12 (M3/M4), §13 Q5; `docs/phase0/research/plur1bus-host-contract.md` §8; `docs/phase0/research/plur1bus-crons-embedding-portability.md` §3; `docs/phase0/research/hermes-learnings-and-import.md` B1; `docs/phase0/research/harness-engineering-state-of-the-art.md` §5

## Context

The harness is multi-user with RBAC (auftrag §5.1), and the engine's own authorization model is principal-based: memory scope `user` is granted only when the requester's `userPrincipal` matches the row's `ownerUserId`. The principal is not a user id — it is a hash of a *channel identity*:

> `userPrincipal = userId && channel && accountId ? "user:v1:" + sha256(JSON.stringify([channel, accountId, userId])) : ""` — `lib/memory-request-context.js:302-304` (via `plur1bus-host-contract.md` §8 and `plur1bus-crons-embedding-portability.md` §3)

All three inputs must be present or there is no user principal at all, and `acl-middleware.js:102-159` rejects with `acl.user.missing_principal`; the shape is validated against `/^user:v1:[a-f0-9]{64}$/` (`acl-middleware.js:45-76`). The physical pool directory is `u-${sha256(userPrincipal).slice(0,62)}` (`lib/memory-request-context.js:42-43`). Consequences that drive this ADR:

1. **The same human on Telegram and on Discord is two different principals today.** auftrag §5.1 requires that a linked human be one canonical principal across channels; §2.1 states identities come from the core. This cannot be satisfied without an engine change (brief D3 already lists "principal model, multi-identity recall" as PLUR1BUS PRs).
2. **The channel vocabulary is a closed, hard-coded list.** `SUPPORTED_ROUTE_PROVIDERS = {telegram, discord, slack, mattermost}` (`lib/memory-request-context.js:24-25`), and the trusted-command-provider allowlist "covers Telegram, Discord, Slack, Mattermost, and cron, but not WebChat" (`KNOWN-ISSUES.md:13`). **Matrix and Buzz/Nostr — two of the four mandatory channels (auftrag §8) — are absent from both.** Without an engine PR, Matrix and Buzz users get no user principal and their slash commands are refused, which breaks M4 acceptance ("a linked user is remembered as the same principal on two channels").
3. **The hook path reconstructs identity from six loosely-typed fields plus a session-entry read plus a ticket ledger**, and returns an unauthenticated base object on any failure rather than throwing (`lib/memory-request-context.js:1259-1418`, `:1405-1417`). Identity proof is `ticket.senderProof === sha256(senderId)` with `proofMode ∈ {account-session, single-account, turn-run}` (`:1377-1393`). Whatever we design must supply a principal of at least this strength, from a host that actually knows who the user is.
4. **Rehashing is expensive.** `/share` re-embeds rather than copying the stored vector (`lib/telegram-commands/memory-edit.js:508`), so any migration that routes rows through share semantics would change vectors and can mix vector spaces (`plur1bus-crons-embedding-portability.md` §3, Inferences). A principal migration must not be a data rewrite.
5. **Hermes already has the pairing-store shape we want.** Per-platform DM pairing: 8-character codes from an unambiguous 32-character alphabet, 1-hour expiry, max 3 pending per platform, `chmod 0600`; `{platform}-approved.json` is the durable allowlist `{user_id: {user_name, approved_at}}`; the note's own verdict is that **approved lists are safe to import** and **pending-code files must be excluded** as ephemeral and security-sensitive (`gateway/pairing.py:1-9,318-336,357-365`, via `hermes-learnings-and-import.md` B1).

## Decision

Ship **five RBAC roles as presets over one capability set** (Owner, Admin, Operator, Member, Viewer), plus object rights per agent (`use` / `manage`) and per project (`member` / `lead`), enforced deny-by-default at a **single server-side `authorize(principal, action, object)` chokepoint** in the harness API that every surface — UI, CLI, API tokens, MCP server endpoint, A2A endpoint, channels — passes through. Introduce a **channel-independent canonical principal `user:v2:sha256(<harnessUserId>)`** that keeps the engine's existing `user:v<n>:<64 hex>` grammar: the harness supplies a **`subject`** on ADR-002's `Principal`, and the engine derives `userPrincipal` from it — the engine keeps owning the formula and still never accepts a ready-made principal from the host. Channel identities are linked to harness users through a **pairing store modelled on Hermes's** (durable approved list, ephemeral pending codes). Recall reads the **union** of a user's v2 principal and all v1 principals still linked to them, so nothing has to be rewritten or re-embedded. Unlinked channel identities stay separate v1 principals (fail-closed); merges require confirmation; unlink is always available and detaches, never deletes.

### Roles — answer to open question Q5

**Recommendation: keep the five roles from auftrag §5.1. Do not slim to Owner/Admin/Member.** Implement them as *named presets* over a single capability enum, and hide Operator/Viewer in the UI until the installation has more than one non-owner user ("simple mode").

Reasoning:

- The cost of five roles is not in the authorization code — with a capability enum and one `authorize()` function, a role is a constant array. The cost is UI surface and documentation, and "simple mode" removes that for the single-user case, which is the common one.
- **Operator is the role that makes the audit story work.** auftrag §11 requires an audit trail over configuration changes, approvals, shares, model changes, break-glass and imports, and §5.1 defines Operator as operations + logs + cron **without secrets**. Collapsing Operator into Admin means anyone who may restart a cron may also read the secret store — exactly the separation the brief asks for. There is no cheap way to re-add this later, because removing capabilities from an existing role is a breaking change for deployments.
- **Viewer is required by features already decided.** auftrag §7 mirrors project communication into Buzz/Matrix so humans can read along; §9 makes page visibility follow the role. A read-only principal is the natural representation and is also what compliance reviews ask for.
- The slim alternative (Owner/Admin/Member) is strictly a subset: if the owner later disagrees, the presets can be reduced without touching the capability model. Going the other way is the expensive direction.

| Role | Capabilities (summary) |
|---|---|
| **Owner** | everything, plus: installation, secret store, licence confirmations (§11 CC BY-NC), user management, ownership transfer, break-glass. Exactly one; transferable. |
| **Admin** | agents, providers, models, channels, bot connections, plugins/skills installation, MCP/A2A registration. No secret *values*, no user deletion, no ownership transfer. |
| **Operator** | run/pause agents, sessions, logs, cron and dreaming schedules, doctor, backup/restore dry-run. **No secrets, no config schema changes, no RBAC changes.** |
| **Member** | use agents shared with them, manage their own memories, participate in projects, own API tokens, own 2FA, own linked identities. |
| **Viewer** | read-only on what is shared with them; no writes anywhere, including no tool invocation. |

**Object rights** are separate and multiplicative with roles: per agent `use` / `manage`; per project `member` / `lead`. A Member with `manage` on one agent can edit that agent and no other. The project role **reviewer** from ADR-003 is a workflow role inside a project, not an RBAC role — it grants `request_review` targeting and approve/reject on that board, nothing else.

### Enforcement

Deny by default. One `authorize(principal, action, object)` call, one policy table, zero surface-specific policy code. Surfaces resolve to a `Principal` first:

| Surface | Principal source | Notes |
|---|---|---|
| Web UI | session cookie (`HttpOnly`, `SameSite`, CSRF one-time token for writes, auftrag §9) | |
| CLI | local session or personal API token | loopback default |
| API tokens | token → user + token scopes; effective capability = role ∩ token scopes | scopes can only narrow |
| MCP server (ADR-008) | harness user or API token; stdio pulls credentials from the environment per spec, HTTP uses OAuth 2.1 | tool visibility is the agent's allowlist ∩ caller's rights |
| A2A server (ADR-008) | Agent Card security scheme → harness user/API token → RBAC | off by default |
| Channels | channel identity → link record → harness user, or unlinked pseudo-principal | unlinked ⇒ Member-minus (no project writes, no agent management) |

Contract tests (auftrag §11): every endpoint denies an unauthenticated request; every endpoint denies a Viewer write; a Member sees only shared agents and only their own `user`-scope memories (M3 acceptance).

### Authentication

Local accounts with **Argon2id** (parameters fixed in ADR-005 together with the secret store); optional **OIDC SSO**; **2FA** TOTP and WebAuthn, enforceable per role (recommend: required for Owner/Admin); sessions with absolute + idle expiry and server-side revocation (revoke-one and revoke-all); **personal API tokens** stored as `prefix + hash`, with explicit scopes, expiry, last-used timestamp and one-click revocation, shown in full exactly once; brute-force protection per account *and* per source with exponential backoff and lockout notification; **owner bootstrap** via a one-time token emitted by the installer or printed to the console, single-use, short TTL, never written to a log (auftrag §5.1, §11).

### Identity linking and the canonical principal

**Pairing flow.** In the harness UI, the user requests a pairing code for a channel. The user sends the code to the bot from the channel identity they want to link. The bot resolves the code, and the harness writes a link record. Store design, adapted from Hermes B1:

- `pending`: ephemeral, in-memory + `0600` spill file, 8-character code from an unambiguous alphabet, **1-hour expiry**, max 3 pending per user per channel, rate-limited, never exported, never imported.
- `approved` (durable): `LinkRecord { harnessUserId, channelKind, accountId, channelUserId, displayName, linkedAt, linkedBy, v1Principal }`. Safe to back up and to import from a Hermes installation (B1's own verdict).
- `declined` / `rateLimits`: as in Hermes, to make repeated guessing expensive.

**New principal shape.**

```
v1 (today):     user:v1:sha256(JSON.stringify([channel, accountId, userId]))
v2 (proposed):  user:v2:sha256(<harnessUserId>)      // 64 lowercase hex — same grammar
```

`harnessUserId` is an opaque UUIDv7 minted at user creation and never reused. Choosing `sha256(harnessUserId)` rather than an opaque string is deliberate: the engine's validators (`acl-middleware.js:45-76`, `:102-159`) and its pool-key derivation (`lib/memory-request-context.js:42-43`) all assume `user:v<n>:` + 64 hex, so the **only** engine change on the shape axis is widening one regex from `^user:v1:` to `^user:v(1|2):`. A free-form principal would touch every validation site.

**Reconciliation with ADR-002.** ADR-002 fixes the engine's `Principal` contract with `user?: {channel, accountId, userId}` and `userPrincipal?: user:v1:${string}` marked "engine-computed; never accepted from the host". That invariant is right and we keep it: the harness does **not** hand the engine a finished principal. Instead `Principal` gains one optional discriminated field:

```ts
subject?: { kind: "harness-user"; id: string }   // opaque, transport-authenticated
// engine derivation, unchanged ownership of the formula:
//   subject present → userPrincipal = "user:v2:" + sha256(subject.id)
//   else user triple present → userPrincipal = "user:v1:" + sha256(JSON.stringify([channel, accountId, userId]))
//   else → no user principal (fail-closed, as today)
```

`subject` wins over the triple when both are present, and both may be present — the triple still carries channel provenance for audit and for the union below. ADR-002's `proof: "transport"` is what makes `subject` trustworthy: the harness authenticated the human before the call.

**Engine PR (brief D3) — three changes:**

1. **`subject` on `Principal`, `user:v2` derivation, widened regex** (`^user:v(1|2):[a-f0-9]{64}$`). The `[channel, accountId, userId]` derivation stays as the fallback, so the OpenClaw adapter path is unchanged.
2. **Multi-identity recall.** Read paths accept a set of principals and match `ownerUserId ∈ set`; write paths take exactly one. The harness supplies the set as `linkedIdentities: Array<{channel, accountId, userId}>` on the `Principal` and the engine derives their v1 hashes itself — again, the engine owns the formula. This is the union described below, and it is the same PR ADR-002 lists under "multi-identity recall".
3. **Channel vocabulary.** Make `SUPPORTED_ROUTE_PROVIDERS` and the trusted-command-provider allowlist host-declared and validated rather than hard-coded (`lib/memory-request-context.js:24-25`; `KNOWN-ISSUES.md:13`) — ADR-002 already specifies this change; ADR-007 records that it is an **M4 blocker**, because without it Matrix and Buzz users have no user principal and their commands are refused.

A fourth, smaller PR: turn ACL-violation logging (`logViolations`) on by default with rotation for `<workspaceDir>/.adaptive-learning/acl-audit.jsonl` — today denials are invisible unless the host opts in (`acl-middleware.js:183-215,227-238`).

**Migration, without rewriting data.** For every linked channel identity we store its `v1Principal` in the link record. Then:

- **Write path:** after linking, new `user`-scope rows are written with the v2 principal. Before linking, or for unlinked identities, v1 as today.
- **Read path:** the union `{v2} ∪ {v1 of every currently linked identity}`. No row is updated, no vector is touched, and therefore the `/share` re-embedding hazard (`memory-edit.js:508`) is never triggered by migration.
- **Optional back-fill:** an explicit, audited, dry-runnable admin operation that rewrites `ownerUserId` from v1 to v2 in place — metadata only, vectors untouched. Must not go through `/share`.
- **Unlink** removes the identity from the union. Rows written under that v1 principal become unreadable to the user until it is re-linked; rows written under v2 are unaffected. This is documented in the UI at unlink time, because it is surprising.

**Fail-closed rules.** An unlinked channel identity is a separate principal and gets its own v1 derivation — never the harness user's v2. If `channel`, `accountId` or `userId` is incomplete, there is **no** user principal and `user`-scope reads and writes fail with `acl.user.missing_principal` (`acl-middleware.js:102-159`) — the harness surfaces this as a visible degraded state, never as a silent empty recall. Merging two harness users, or attaching an identity already linked elsewhere, requires an identity-bound two-phase confirmation (user + chat + nonce, auftrag §11) from **both** sides plus an audit entry; the `/share` two-phase pattern (`index.js:10120-10190`) is the template.

### Privacy

- `user`-scope cards are visible in the UI only to the owning user. Admin access exists **only** as break-glass: a mandatory free-text reason, a time-boxed grant, an audit entry, and a notification to the affected user.
- `agent-private` cards are visible only to principals holding `manage` on that agent.
- **Export**: a user can export their own data (memories across all linked identities, sessions, tokens metadata, audit entries about them) as a bundle without secrets.
- **Hard delete on request**: archive-first is the default everywhere (auftrag §2.1), but a user-requested erasure purges archives too, is confirmed, dry-runnable, and leaves only a tombstone in the audit log (event, actor, timestamp — no content).
- Provenance already hashes rather than stores principals in share records (`shared-memory.js:222`); keep that property everywhere a principal crosses a boundary.

## Options considered

### Option A: No engine change — synthesise a stable v1 tuple
Pass `channel = "harness"`, `accountId = <installationId>`, `userId = <harnessUserId>` for every request, so the engine's own v1 derivation yields one stable, person-scoped principal.

| Dimension | Assessment |
|---|---|
| Complexity | Low |
| Fit with brief D1–D11 | **Conflicts with D2/§2.1** — identity would come from the host lying to the core, not from the core |
| Cross-platform risk | None |
| Maintenance burden | Low initially, high later |
| Latency / token cost | None |

**Pros:** zero PRs beyond ADR-002's, works immediately, hash shape unchanged. **Cons:** destroys per-channel provenance inside the principal (audit can no longer say *which* identity wrote a card); imported OpenClaw rows keep their real v1 principals and become unreadable to the same human; the OpenClaw adapter path still derives real triples from hook fields (`lib/memory-request-context.js:1259-1418`), so the same person is one principal under the harness and another under the plugin — with D2 committing to both hosts, that split is permanent; and the channel-allowlist problem (Matrix/Buzz absent) is untouched, so commands still fail on two mandatory channels.

### Option B: `user:v2` from a host-supplied `subject` + link table + union recall (recommended)

| Dimension | Assessment |
|---|---|
| Complexity | Medium |
| Fit with brief D1–D11 | Direct fit with D2, D3 (engine PRs), §5.1, §2.1; unblocks M4 acceptance |
| Cross-platform risk | None (pure logic) |
| Maintenance burden | Medium — three engine PRs must be merged and kept green under both adapters |
| Latency / token cost | Union recall widens one filter; negligible against the existing recall time budget |

**Pros:** the canonical principal is genuinely canonical; no data rewrite and no re-embedding; v1 remains the fallback so the OpenClaw plugin is unaffected; the regex widening is a one-line change; multi-identity recall is a capability the brief already wants. **Cons:** blocked on upstream PR review; recall must handle a set, which touches query construction and its tests; unlink semantics ("your old Telegram memories are hidden now") need UI explanation.

### Option C: Harness-side ACL in front of the engine
Keep v1 everywhere, and have the harness filter results across identities after the engine returns them.

| Dimension | Assessment |
|---|---|
| Complexity | Medium |
| Fit with brief D1–D11 | **Conflicts with §2.1** — "the PLUR1BUS ACL model is the permission model for the whole harness" |
| Cross-platform risk | None |
| Maintenance burden | High — two authorization models to keep consistent forever |
| Latency / token cost | Worse: the engine must over-fetch across principals before the harness narrows |

**Pros:** no upstream dependency. **Cons:** a second ACL implementation is exactly the "harness contains a diverging copy of the memory logic" that D2/§2.1 forbids; every engine ACL fix would need mirroring; over-fetching across principals is a data-leak footgun (the engine would have to return rows the requester is not authorized for).

## Trade-off analysis

Option A is tempting because it needs nothing from upstream, but it buys speed by making the host the source of a fake channel identity — and the engine's hook path would immediately expose the lie, because it rebuilds context from host fields on a different code path than the tool path (`plur1bus-host-contract.md` §8 lists six distinct resolution paths with different proof strength). Option C is worse: it duplicates authorization, which is the one thing the brief singles out as belonging to the core.

Option B's only real cost is the upstream dependency, and the brief already commits to that (D3: principal model and multi-identity recall go to PLUR1BUS as PRs). Its design choice — keeping the `user:v<n>:<64 hex>` grammar — is what makes the diff small enough to be reviewable, and the union-read strategy is what keeps the migration free of vector churn. The residual risk is schedule: if the PRs are not merged in time for M4, the fallback is to run the harness against a pinned branch and document the delta in `UPSTREAM.md`, not to switch to Option A.

The Q5 trade (five roles vs three) is a one-way door in one direction only. Shipping five and later collapsing is a preset edit; shipping three and later splitting Admin is a migration with a security regression window.

## Consequences

- **Easier:** one authorization chokepoint to test and audit; a user is one row regardless of how many channels they use; adding a channel means adding a `channelKind`, not a new identity concept; importing Hermes's approved pairing lists is a direct mapping; break-glass is a feature rather than an undocumented admin capability.
- **Harder:** three upstream PRs must land and stay green under both adapters (behaviour-neutrality suite); recall query construction becomes set-based; unlink has counter-intuitive visibility semantics that need UX work; hard delete must reach archives, which fights the archive-first default everywhere else; the Matrix/Buzz channel-vocabulary PR is on the critical path for M4 and is easy to under-scope.
- **Revisit when:** the engine gains a first-class principal object (then v2 could become opaque); or an OIDC deployment wants the IdP subject to *be* the principal (then `user:v3:sha256(iss + sub)` with the same union mechanism); or the five-role preset proves to be friction in real use (collapse presets, keep capabilities).

## Conflicts with the brief

**Finding 1 — Matrix and Buzz cannot produce a user principal or accept commands today.**
**Source:** `SUPPORTED_ROUTE_PROVIDERS = {telegram, discord, slack, mattermost}` (`lib/memory-request-context.js:24-25`) and trusted command providers "Telegram, Discord, Slack, Mattermost, and cron, but not WebChat" (`KNOWN-ISSUES.md:13`), both via `plur1bus-host-contract.md` §8 and `plur1bus-crons-embedding-portability.md` §3 — against auftrag §8 (Matrix and Buzz are mandatory channels) and §12 M4 acceptance.
**Options:** (a) engine PR making both lists host-supplied and validated; (b) engine PR adding the four values; (c) map Matrix/Buzz onto an existing allowed provider string (a lie, and it collides with real Telegram/Discord principals).
**Recommended resolution:** (a), with (b) as the minimal fallback if upstream prefers a closed list. This is on the M4 critical path and should be the **first** of the three principal PRs, because it is the smallest and unblocks channel work independently.

**Finding 2 — "the core sees one canonical principal" (auftrag §2.1, §5.1) is not achievable without an engine change.**
**Source:** the v1 formula is channel-bound by construction (`lib/memory-request-context.js:302-304`).
**Options:** as in Options A–C above.
**Recommended resolution:** Option B. This is not a deviation from the brief's intent — the brief already anticipates it ("Nötige Erweiterung des PLUR1BUS-Prinzipalmodells als PR", §5.1) — but it does make M4 depend on upstream, which the milestone plan must reflect.

## Open questions for the owner

1. **Q5 (needs a decision now):** confirm the five roles from §5.1 as presets with "simple mode", or reduce to Owner/Admin/Member?
2. **2FA enforcement:** required for Owner and Admin, or optional everywhere for v0.1?
3. **Break-glass notification:** should the affected user be notified immediately, or is an audit entry they can read sufficient?
4. **Unlink semantics:** hide the old identity's memories (proposed), or offer a one-click back-fill to v2 at unlink time so nothing disappears?
5. **OIDC:** is SSO in scope for v0.1 at all, or deferred past M3? (It changes whether `user:v3` should be designed now.)
6. **Hard delete:** should user-requested erasure also purge the audit log entries *about* that user, or is the content-free tombstone acceptable?

## Action items

1. [ ] Define the capability enum and the five role presets as data; implement one `authorize(principal, action, object)` and route every surface through it.
2. [ ] Write the deny-by-default contract test suite: unauthenticated request on every endpoint, Viewer write on every endpoint, Member cross-user memory read, API-token scope narrowing (auftrag §11).
3. [ ] Draft PLUR1BUS PR #1: host-supplied `SUPPORTED_ROUTE_PROVIDERS` and trusted-command-provider list (M4 blocker).
4. [ ] Draft PLUR1BUS PR #2: `subject` on `Principal` with engine-side `user:v2` derivation, regex widened to `^user:v(1|2):[a-f0-9]{64}$`; behaviour-neutrality suite green under both adapters. Coordinate with ADR-002's `Principal`/`TurnOrigin` PR so there is one contract change, not two.
5. [ ] Draft PLUR1BUS PR #3: multi-identity recall — `linkedIdentities` on the `Principal`, engine-derived principal set on read paths, single principal on write.
6. [ ] Draft PLUR1BUS PR #4 (small): `logViolations` on by default + rotation policy for `acl-audit.jsonl`.
7. [ ] Implement the pairing store (pending ephemeral / approved durable / declined / rate limits) with Hermes's parameters as defaults: 8 chars, unambiguous alphabet, 1 h, max 3 pending, `0600`; exclude pending from backup and import.
8. [ ] Implement the link table with `v1Principal` recorded per identity, plus the audited, dry-runnable metadata-only back-fill tool (explicitly not via `/share`).
9. [ ] Implement owner bootstrap (one-time token, single use, short TTL, never logged) and the M3 acceptance path.
10. [ ] Implement break-glass with mandatory reason, time-box, audit entry and user notification; add an audit-completeness test over the §11 event list.
11. [ ] Implement export and hard delete including archives, with dry-run and tombstoning.
