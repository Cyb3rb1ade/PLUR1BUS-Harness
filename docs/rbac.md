# RBAC: `authorize()` for human principals

Status: M3, first slice (2026-10-06). Authorities: ADR-007 (roles, enforcement, privacy, break-glass), ADR-004 §"Pages"
(visibility by role), `docs/milestones.md` §M3. Code: `packages/core/src/rbac/`. Plan:
`docs/superpowers/plans/2026-10-06-m3-rbac-authorize.md`.

This is **not** D109 `policy.decide`. D109 decides what an *agent* may do with a tool; RBAC decides what a *human
principal* (a user, an API token, a channel identity resolved to a user) may do in the harness.

## `authorize(principal, action, resource, ctx?) → Decision`

```ts
import { authorize } from "./rbac/index.ts"; // packages/core/src/rbac/index.ts (core-internal; no package export yet)
authorize({ userId: "u1", role: "member", agentRights: { bernd: "use" } }, "agent.use", { kind: "agent", agentId: "bernd" });
// { effect: "allow", reason: "object-right" }
```

* **Pure.** No clock, no I/O, no logging, no mutation. Time is `ctx.now` (epoch ms); without it no break-glass grant is
  honoured.
* **Deny by default.** Unknown action, malformed principal, a resource of the wrong shape or with an empty id, a role
  with no entry in the table: all `deny`, with a reason code (`unknown-action`, `invalid-principal`,
  `resource-mismatch`, `role-denied`, `not-owner`, `object-right-required`, `break-glass-required`, `token-scope`,
  `unauthenticated`, `audit-failed`, `agent-principal`).
* **Grants** (per role, per action, in `policy.ts`): `allow` (the role holds it), `own` (the resource is the principal's
  own), `object` (an object right on that agent/project: `use` < `manage`, `member` < `lead`; multiplicative with the
  role, so a Viewer holding `manage` is still denied), `break-glass` (a live grant for the target user).
* **Token scopes** (`principal.tokenScopes`, exact action or `prefix.*`) can only narrow: effective = role ∩ scopes.
* `canSee(principal, action, resources)` filters a list (for example `agent.list`) to what the principal may see.

## Principal kind and human-only actions (D109 D6)

`Principal.kind` is `"person"` or `"agent"`. Only the resolver that authenticated a person sets `"person"` (`LOCAL_OWNER` does).
An action marked `humanOnly` in `POLICY` is checked **first** in `authorize`: a principal that is not explicitly a person
is denied with `agent-principal`, whatever its role, object rights, token scopes or break-glass grants (a missing kind
counts as not-a-person, an unknown kind is `invalid-principal`). No role entry can open a human-only action to an agent,
and `canSee`/`authorize` are otherwise unchanged. The four human-only actions are the ones behind the D109 grant and
approval methods (spec 2026-09-28 §4): `grant.read`, `grant.write`, `approval.read`, `approval.decide`. There is no
password or login route for an agent: no RPC method takes a password, and `rbac/` handles none.

| RPC method | Action | Roles (person) |
|---|---|---|
| `grant.list` | `grant.read` | Owner, Admin |
| `grant.create`, `grant.revoke` | `grant.write` | Owner, Admin |
| `approval.list`, `approval.get`, `approval.verify` | `approval.read` | Owner, Admin, Operator |
| `approval.decide`, `approval.cancel` | `approval.decide` | Owner, Admin |

`approval.list` with `status=pending` is the pending queue (there is no `approval.pending`). RBAC is the coarse gate: the
handler still checks that the surface level (`surfaceTrust`, below) meets the request's `requiredSurface`. Whether a Member
may decide requests of their own agents is open (today only Owner/Admin). The methods are also absent from every agent tool
catalogue and the D103 index, refused as WebMCP tools (`admin.*` rule, B15) and never on the harness MCP server.

### Surface trust (`surface.ts`, spec §5)

`surfaceTrust(facts)` is a pure function of facts the core established itself (never of client or model claims); anything
unlisted or malformed is T0. `surfaceSatisfies(have, required)`: T0 satisfies nothing; `required: null` (a capability that never asks) is never satisfied.

| Level | Facts |
|---|---|
| T3 | `desktop-app`; `cli` with a TTY of the owning OS user; `web` with a step-up within `STEP_UP_WINDOW_MS` (5 min) |
| T2 | `web` session without (or with a stale) step-up; `channel` with a private chat, a linked identity, a valid one-time nonce and a first-party module (a third-party module only if the person opted it in) |
| T1 | `acp-editor` that started the session |
| T0 | group chats, unlinked identities, MCP clients, A2A peers, agents, model output, tool results, a CLI without TTY, everything else |

## Privacy (ADR-007 §Privacy)

* `user`-scope cards: only the owning user. Owner and Admin can read **another** user's cards only through break-glass;
  no role can write them.
* `agent-private` cards: only with `manage` on that agent (Owner/Admin hold it by role).
* Workspace cards: at least `use` on the agent (Owner/Admin by role).

## Break-glass (`break-glass.ts`)

`createBreakGlass({ audit, notify, clock })` is the stateful side; `authorize` stays pure and receives the grants.

| Rule | Value |
|---|---|
| Who may request | `breakglass.request`: Owner, Admin (narrowed by token scopes) |
| Reason | mandatory, 10–500 characters after trimming |
| Lifetime | integer ms, default 15 min, 1 min ≤ ttl ≤ 60 min (a violation is an error, not a clamp) |
| Scope | one holder, one target user, **read only** |
| Audit | `break-glass.granted`, `.used` (every use), `.revoked`, `.expired` (exactly once per lapsed grant, from `sweep()` or any later call), `.notify-failed` |
| Audit failure | fail closed: no grant is made, a use is denied (`audit-failed`); a failed expiry audit is retried by the next sweep |
| Notification | the affected user is notified at once with holder, reason and expiry (ADR-007 Q3, recommended default) |
| Forgery | `registry.authorize` ignores grants carried on the principal; only the registry's own live grants count |

Audit lines are the five-key shape of `crates/plur1bus/src/audit.rs` (`{ at, actor: { user, host }, action, target,
detail }`); `createJsonlAuditSink(path)` writes them append-only, 0600, fsynced.

## RPC integration (`guard.ts`)

`guardMethods(handlers, { resolve, audit, now })` wraps the handlers named in `RPC_RULES`; everything else passes
through untouched. A refusal is `E_DENIED` with the reason code, a missing or failing principal is `E_UNAUTHORIZED`
(`no-principal`, `resolver-failed`), and both are audited (`rbac.denied`, `rbac.unauthenticated`; allowed calls are not).
`createCore({ rbac: { resolve, audit } })` sets the resolver; the default maps the token-authenticated local connection to
the installation owner (RULING R8), so today's behaviour is unchanged until the M3 Harness API supplies sessions.

Secured now: `memory.forget` (→ `memory.forget` on the agent), `agent.status` (→ `agent.read`), `jobs.run`,
`models.setOverride` and `models.removeManual` (→ `models.write`), `logs.query` and `logs.tail` (→ `logs.query`, Owner/Admin only, D4), `egress.status` (→ `egress.read`, Owner/Admin; B4, `docs/egress.md`), and the whole `admin.*` family (`admin.obsidian.*`,
`admin.migrate`, `admin.embedding.*`, `admin.reembed.*`). A test pins that every `admin.*` method in the schema has a rule.
The M1b-3 `dreams.*` methods follow the nearest existing pattern: `dreams.run` → `jobs.run` (Owner, Admin, Operator), `dreams.schedule.set|enable|disable` → `settings.write` (Owner, Admin); the reads `dreams.status|log|schedule.get` stay open like `jobs.list|history`.

The M3 `identity.*` methods are secured by the nearest existing pattern: `identity.list` → `users.read`, and `identity.human.create`, `identity.link`, `identity.unlink`, `identity.pair.start|claim|confirm` → `users.manage` (system resource, Owner and Admin). Their descriptions say "Owner only"; today every connection is the owner, so nothing changes, and whether these should be Owner-only is for the roles ruling (R4/R5 open).

`audit.verify` (B5, the hash-chained audit file, docs/audit-chain.md) → `audit.read` on the system resource: Owner and Admin, the same pair that may read the audit trail. It is read-only on the log and its findings carry file names and line numbers, never record content.

`grant.*` and `approval.*` (D109, the eight methods in the table above) are secured by human-only actions; an agent principal is refused with `E_DENIED reason=agent-principal` in every state. The handlers are registered in the core (`approvals/rpc.ts`, `grants/rpc.ts`) and run behind the same guard.

**Not yet secured** (they stay owner-equivalent for the local connection): `core.*`, `memory.recall|capture|checkpoint|
list|show|correct|share|state|propose|proposals.*|proposal`, `agent.open|close|list|activity`, `jobs.list|history`,
`models.list|scan|acknowledge`, `dreams.status|log|schedule.get`, `session.create|list|get|resume|archive|submit|events` (M1b-2c: per-caller, the owner is derived from the caller identity inside the handler and another owner's session is `E_NOT_FOUND`; classified like the per-caller `memory.*` and `agent.*` methods). Params are schema-validated before the guard runs, so a malformed call is
`E_INVALID_PARAMS` even for a caller who would be refused.

## Rulings (document defaults; owner questions stay open)

R1 five roles as presets (ADR-007 Q5). R2 immediate notification (Q3). R3 break-glass read-only, reason ≥ 10 chars,
15 min default, 1–60 min. R4 Owner/Admin hold `manage` on every agent by role. R5 Operator reads and runs/pauses
agents, uses one only with a `use` right. R6 secret reveal and write are Owner-only; Admin lists names. R7 `audit.read`
is Owner/Admin. R8 the local authenticated RPC connection is the owner until sessions exist.

## Action table

Generated from `POLICY` (`✔` = role grants it, `own` = own resource, `use`/`manage`/`member`/`lead` = that object right is
needed, `bg` = a live break-glass grant, `–` = denied). The matrix test compares every cell with the ADR-004 fixture
(`packages/core/test/rbac/fixtures/visibility.ts`).

| Action | Resource | Owner | Admin | Operator | Member | Viewer |
|---|---|---|---|---|---|---|
| `memory.user.read` | memory-user | own / bg | own / bg | own | own | own |
| `memory.user.write` | memory-user | own | own | own | own | – |
| `memory.agent-private.read` | memory-agent:agent-private | ✔ | ✔ | – | manage | – |
| `memory.agent-private.write` | memory-agent:agent-private | ✔ | ✔ | – | manage | – |
| `memory.workspace.read` | memory-agent:workspace | ✔ | ✔ | use | use | use |
| `memory.workspace.write` | memory-agent:workspace | ✔ | ✔ | use | use | – |
| `memory.forget` | agent | ✔ | ✔ | use | use | – |
| `agent.list` | system | ✔ | ✔ | ✔ | ✔ | ✔ |
| `agent.read` | agent | ✔ | ✔ | ✔ | use | use |
| `agent.use` | agent | ✔ | ✔ | use | use | – |
| `agent.operate` | agent | ✔ | ✔ | ✔ | – | – |
| `agent.manage` | agent | ✔ | ✔ | – | manage | – |
| `agent.create` | system | ✔ | ✔ | – | – | – |
| `agent.delete` | agent | ✔ | ✔ | – | – | – |
| `dreaming.read` | system | ✔ | ✔ | ✔ | – | ✔ |
| `dreaming.operate` | system | ✔ | ✔ | ✔ | – | – |
| `cron.read` | system | ✔ | ✔ | ✔ | – | ✔ |
| `cron.operate` | system | ✔ | ✔ | ✔ | – | – |
| `jobs.run` | system | ✔ | ✔ | ✔ | – | – |
| `sessions.read` | system | ✔ | ✔ | ✔ | – | ✔ |
| `logs.read` | system | ✔ | ✔ | ✔ | – | ✔ |
| `audit.read` | system | ✔ | ✔ | – | – | – |
| `logs.query` | system | ✔ | ✔ | – | – | – |
| `models.read` | system | ✔ | ✔ | ✔ | – | ✔ |
| `models.write` | system | ✔ | ✔ | – | – | – |
| `providers.read` | system | ✔ | ✔ | ✔ | – | ✔ |
| `providers.write` | system | ✔ | ✔ | – | – | – |
| `channels.read` | system | ✔ | ✔ | ✔ | – | ✔ |
| `channels.write` | system | ✔ | ✔ | – | – | – |
| `plugins.read` | system | ✔ | ✔ | ✔ | – | ✔ |
| `plugins.write` | system | ✔ | ✔ | – | – | – |
| `mcp.read` | system | ✔ | ✔ | ✔ | – | ✔ |
| `mcp.write` | system | ✔ | ✔ | – | – | – |
| `users.read` | system | ✔ | ✔ | – | – | – |
| `users.manage` | system | ✔ | ✔ | – | – | – |
| `users.delete` | user | ✔ | – | – | – | – |
| `ownership.transfer` | system | ✔ | – | – | – | – |
| `breakglass.request` | user | ✔ | ✔ | – | – | – |
| `breakglass.log.read` | system | ✔ | ✔ | – | – | – |
| `licence.confirm` | system | ✔ | – | – | – | – |
| `my.read` | user | own | own | own | own | own |
| `my.write` | user | own | own | own | own | – |
| `project.read` | project | ✔ | ✔ | ✔ | ✔ | ✔ |
| `project.write` | project | ✔ | ✔ | member | member | – |
| `project.manage` | project | ✔ | ✔ | lead | lead | – |
| `settings.read` | system | ✔ | ✔ | – | – | – |
| `settings.write` | system | ✔ | ✔ | – | – | – |
| `egress.read` | system | ✔ | ✔ | – | – | – |
| `grant.read` (human-only) | system | ✔ | ✔ | – | – | – |
| `grant.write` (human-only) | system | ✔ | ✔ | – | – | – |
| `approval.read` (human-only) | system | ✔ | ✔ | ✔ | – | – |
| `approval.decide` (human-only) | system | ✔ | ✔ | – | – | – |
| `secrets.list` | system | ✔ | ✔ | – | – | – |
| `secrets.reveal` | system | ✔ | – | – | – | – |
| `secrets.write` | system | ✔ | – | – | – | – |
| `import.run` | system | ✔ | ✔ | – | – | – |
| `doctor.read` | system | ✔ | ✔ | ✔ | – | – |
| `doctor.run` | system | ✔ | ✔ | ✔ | – | – |
| `admin.obsidian.detect` | system | ✔ | ✔ | – | – | – |
| `admin.obsidian.prepare` | system | ✔ | ✔ | – | – | – |
| `admin.obsidian.confirm` | system | ✔ | ✔ | – | – | – |
| `admin.migrate` | system | ✔ | ✔ | – | – | – |
| `admin.embedding.probe` | system | ✔ | ✔ | – | – | – |
| `admin.embedding.serve` | system | ✔ | ✔ | – | – | – |
| `admin.reembed.plan` | system | ✔ | ✔ | – | – | – |
| `admin.reembed.run` | system | ✔ | ✔ | – | – | – |
| `admin.reembed.status` | system | ✔ | ✔ | – | – | – |
| `admin.reembed.abort` | system | ✔ | ✔ | – | – | – |
| `admin.backup.snapshot` | system | ✔ | ✔ | – | – | – |
