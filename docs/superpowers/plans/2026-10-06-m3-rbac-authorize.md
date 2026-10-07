# M3 RBAC `authorize()` Implementation Plan

**Goal:** One pure, deny-by-default `authorize(principal, action, resource) → allow|deny + reason` for *human* principals
(ADR-007 §Roles/§Enforcement/§Privacy), with a time-limited, audited break-glass, and a small integration helper that
secures a handful of core RPC methods. Lives in `packages/core/src/rbac/**`, separate from D109 `policy.decide`
(which governs *agent* actions).

**Authorities:** ADR-007 (five roles as presets over one capability set, object rights `use|manage` / `member|lead`,
one chokepoint, privacy, break-glass), ADR-004 §"Pages" visibility-by-role table (the matrix fixture), `docs/milestones.md`
§M3 (RBAC bullet, acceptance 3 and 4) and §6.1 item 3 (RBAC/privacy suite).

## Design

* **Data, not code.** `policy.ts` is a table `action → { resource kind, grants per role }`. A grant is one of
  `allow` (role grants it outright), `own` (the resource is the principal's own), `object` (needs an object right on that
  agent/project: multiplicative with the role, ADR-007 "Object rights"), `break-glass` (a live grant covering the target
  user). A role with no entry is denied. Unknown action → deny `unknown-action`.
* **`authorize` is pure**: no clock read, no I/O. Time enters as `ctx.now`; break-glass grants travel on the principal
  (`principal.breakGlass`). Without `ctx.now` a break-glass grant is never honoured (fail closed).
* **Token scopes** can only narrow: `principal.tokenScopes` (exact action or `prefix.*`) is intersected with the role.
* **Break-glass** (`break-glass.ts`) is the stateful part: `request` (owner/admin only, reason ≥ 10 chars, TTL clamped),
  audit-before-effect (an audit write failure means no grant), notification of the affected user, per-use audit,
  `sweep` that writes exactly one `break-glass.expired` event per lapsed grant, `revoke`. Read-only: it never grants a
  write on another user's cards.
* **Audit** (`audit.ts`): `AuditSink` with the same five-key line shape as `crates/plur1bus/src/audit.rs`; an in-memory
  sink for tests and a private (0600, fsynced, append-only) JSONL sink for `logs/audit.log`.
* **RPC integration** (`guard.ts`): `guardMethods(handlers, { resolve, audit, now })` wraps handlers named in a rule
  table (`RPC_RULES`) with a principal resolution + `authorize`, answering `E_DENIED` (reason code) or
  `E_UNAUTHORIZED`. `core.ts` gets one wrapping call; the default resolver maps the token-authenticated local connection
  to the installation owner (no behaviour change until the M3 Harness API supplies sessions).

## Files

| File | Purpose |
|---|---|
| `packages/core/src/rbac/types.ts` | `Role`, `Principal`, `Resource`, `Decision`, reason codes, `BreakGlassGrant` |
| `packages/core/src/rbac/policy.ts` | the action table |
| `packages/core/src/rbac/authorize.ts` | the pure function, `canSee` filter helper |
| `packages/core/src/rbac/audit.ts` | `AuditSink`, memory and JSONL sinks |
| `packages/core/src/rbac/break-glass.ts` | `BreakGlassRegistry` |
| `packages/core/src/rbac/guard.ts` | `RPC_RULES`, `guardMethods`, local-owner resolver |
| `packages/core/src/rbac/index.ts` | exports |
| `packages/core/test/rbac/*.test.ts` | matrix, privacy, break-glass, guard, audit-sink tests; ADR-004 fixture |
| `packages/core/src/core.ts` | one wrapping call + optional `rbac` core option |
| `docs/rbac.md` | the surface page (§6.1 item 9) |

## Tasks → acceptance

| # | Task | Acceptance → test |
|---|---|---|
| 1 | Types + policy table + `authorize` | Matrix over all 5 roles × every action equals the ADR-004 fixture, no deviation, no uncovered action (`matrix.test.ts`) |
| 2 | Object rights, own-scope, token scopes | Member sees only agents with a `use` right; `manage` implies `use`; Viewer with `manage` still denied; scopes narrow (`object-rights.test.ts`) |
| 3 | Privacy rules | `user` scope only for the owner, other users' only via break-glass; `agent-private` only with `manage` (`privacy.test.ts`) |
| 4 | Unknown / malformed input | unknown action, prototype keys, bad role, missing principal, resource mismatch → deny (`edge.test.ts`) |
| 5 | Audit sinks | JSONL line shape, 0600, append-only (`audit.test.ts`) |
| 6 | Break-glass | reason required, TTL bound, expiry boundary, one `expired` audit event, notification, per-use audit, audit failure ⇒ no grant, read-only (`break-glass.test.ts`) |
| 7 | RPC guard | 5 representative methods denied/allowed per role, E_DENIED reason, unauthenticated, default resolver unchanged behaviour, every rule names a real schema method (`guard.test.ts`) |
| 8 | Docs + gates | `docs/rbac.md`; `pnpm test`, lint, typecheck, `docs:check`, cargo test/clippy/fmt green |

## Rulings (owner questions answered with the document's recommended default, else fail closed)

* R1 (ADR-007 Q1/Q5): five roles, as presets.
* R2 (ADR-007 Q3): the affected user is notified immediately (milestones M3 acceptance 4 requires it).
* R3: break-glass is read-only; reason ≥ 10 characters; default 15 min, min 1 min, max 60 min (not fixed by the ADR; short and bounded).
* R4: Owner/Admin hold `manage` on every agent by role (Agents CRUD ✔), so they may read `agent-private`; Operator and below need an explicit `manage` right.
* R5: Operator may read agents and run/pause them (ADR-007 role summary) but uses one only via a `use` right, like a Member.
* R6: secret *reveal and write* are Owner-only; Admin may list secret names (ADR-004 "no secret reveal").
* R7: the audit trail (`audit.read`) is Owner/Admin; Operator gets logs, not audit.
* R8: until the Harness API supplies sessions, the token-authenticated local RPC connection is the installation owner.

## Out of scope / open points

Wiring the remaining RPC methods; break-glass RPC/CLI surface (needs RPC schema additions); principal resolution from
sessions, tokens and channels; 2FA enforcement (ADR-007 Q2); owner-bootstrap.
