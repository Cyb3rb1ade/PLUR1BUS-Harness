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

A person on a local token-authenticated RPC connection (`connectionSurface`, `connection-surface.ts`) is **T1** unless the embedder
supplies a server-side attestation that raises it to T3 (#192): reading `run/core.token` proves only same-OS-user access, which an
agent process has too. So without attestation only low-risk requests are decidable and no standing grant above T1 can be created,
unless the person confirms that one approval with the operating system (next section).

### OS-backed attestation (#192, option C)

One confirmation by the operating system lifts **one approval** of an unattested local connection from T1 to T2. The core asks
for it and reads the answer itself (`packages/core/src/attestation/`); the native helper `plur1bus-attest`
(`crates/plur1bus-attest`) is a child process with a one-line JSON protocol and shows the OS's own dialog: Touch ID or the account
password (macOS, LocalAuthentication), Windows Hello or the UAC consent prompt (Windows), polkit `org.plur1bus.approve` (Linux).
It happens inside `approval.decide` (`attest: true`; without it the core answers `E_APPROVAL_REQUIRED attestation-required`
and names the method). Details, error reasons, audit and what is bound to the confirmation: `docs/approvals.md` 3.2.1.

Rules the RBAC layer keeps: an agent principal (and any principal that is not `kind: "person"`) never reaches the helper (the
`humanOnly` actions are refused first); a connection already at T3 through `CoreOptions.rbac.attest` never needs it; a request
that needs T3 is refused without a dialog; the lift is for exactly one decision at surface 2 and does not change the
connection's own level for the next call.

**Threat model: token theft by an agent.** The agent runs as the same OS user, can read `run/core.token` and connects as the
local owner. Before this change that gave T1 only; with it the agent can still do only what T1 can do on its own, and every T2
decision needs a human to answer an OS dialog on the machine, which the token does not provide and which the agent cannot answer
(Touch ID needs the finger; the password prompt is the OS's secure dialog, not an RPC parameter). It cannot pre-confirm, replay or
reuse a confirmation: the hash covers the concrete approval, the nonce is single-use, the lifetime is 60 s, every attempt is
fresh. What remains: (1) a person who confirms without reading the dialog text, so the text names agent, capability and scope and
nothing the model wrote; an agent can also raise approval requests to wear the person down (the fatigue limits of approvals.md 3.4
apply); (2) **a replaced helper**: the core checks that `PLUR1BUS_ATTEST_BIN` is an absolute, regular file that is not group- or
world-writable, which stops other users, but an agent running as the owner who can write the helper's location can substitute a
program that always says yes. Install the helper where only an administrator can write (a package-manager install), and keep the
exec sandbox from writing to it; a signature check of the helper (macOS code signature, Windows Authenticode) is a follow-up, see
`docs/security/os-attestation-2026-10.md`; (3) a shell-capable agent on a machine where it also drives the logged-in desktop
session (UI automation) could in principle click an OS dialog itself; the `ui.control` capability is T2 and `os.privilege` /
`remote.control` are T3 for that reason.

**Secrets and the same threat.** `secret.set`, `secret.get` with `reveal` and `secret.delete` (owner only, `secrets.reveal` and `secrets.write`) also
check the connection's trust level: below T1 they are refused and audited. An agent that holds `run/core.token` is T1, exactly like `plur1bus secret get
--reveal` and the web UI, so for it the plaintext of a secret is not behind the OS confirmation that a T2 approval needs. The core cannot tell the two apart
until the CLI can be attested; the one-line change then is `MIN_SECRET_SURFACE` in `packages/core/src/secrets/types.ts`. Until then keep the exec sandbox
away from `run/` and `state/`, as for the approval chain key.

## Privacy (ADR-007 §Privacy)

* `user`-scope cards: only the owning user. Owner and Admin can read **another** user's cards only through break-glass;
  no role can write them.
* `agent-private` cards: only with `manage` on that agent (Owner/Admin hold it by role).
* Workspace cards: at least `use` on the agent (Owner/Admin by role).

## Break-glass (`break-glass.ts`)

`createBreakGlass({ audit, notify, clock })` is the stateful side; `authorize` stays pure and receives the grants.

There is exactly one registry per installation: the core's (`core.ts` creates it, `requireNotification: true`). The Harness API holds none: `POST /breakglass`, `GET /breakglass`, `POST /breakglass/revoke` and `GET /me/notices` forward to `breakglass.request|list|revoke|notices` as the caller, so a grant made over REST is the one a core read consults and a grant made over RPC shows over REST (D116: reason, notice and audit chain are not weakened by the second path). The core sweeps lapsed grants every 30 seconds in addition to every list, read and request.

| Rule | Value |
|---|---|
| Who may request | `breakglass.request`: Owner, Admin (narrowed by token scopes); people only, the library also refuses a principal whose kind is not `person` (request and revoke) |
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

Caller-taking memory ops (`memory.forget`, `correct`, `share`, `state`, `propose`, `proposals.list|accept|reject`) additionally bind `params.caller` to the authenticated person (`E_DENIED`, reason `caller-not-linked`), as `memory.list|show` and `session.*` do; the installation owner keeps its OS caller.

Secured now: `memory.forget` (→ `memory.forget` on the agent), `agent.status` (→ `agent.read`), `jobs.run`,
`models.setOverride` and `models.removeManual` (→ `models.write`), `logs.query`, `logs.tail` and `logs.levels` (→ `logs.query`, Owner/Admin only, D4/D111), `egress.status` (→ `egress.read`, Owner/Admin; B4, `docs/egress.md`), and the whole `admin.*` family (`admin.obsidian.*`,
`admin.migrate`, `admin.embedding.*`, `admin.reembed.*`). A test pins that every `admin.*` method in the schema has a rule.
The M1b-3 `dreams.*` methods follow the nearest existing pattern: `dreams.run` → `jobs.run` (Owner, Admin, Operator), `dreams.schedule.set|enable|disable` → `settings.write` (Owner, Admin); the reads `dreams.status|log|schedule.get` stay open like `jobs.list|history`. `dreams.diary` → `agent.manage` on the agent resource (Owner, Admin, member with manage); a viewer is denied and does not see a foreign agent's diary.

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
| `memory.sensitivity.read` | agent | ✔ | ✔ | use | use | use |
| `memory.sensitivity.write` | agent | ✔ | ✔ | manage | manage | – |
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
| `admin.embedding.check` | system | ✔ | ✔ | – | – | – |
| `admin.engine.test` | system | ✔ | ✔ | – | – | – |
| `admin.reembed.plan` | system | ✔ | ✔ | – | – | – |
| `admin.reembed.run` | system | ✔ | ✔ | – | – | – |
| `admin.reembed.status` | system | ✔ | ✔ | – | – | – |
| `admin.reembed.abort` | system | ✔ | ✔ | – | – | – |
| `admin.backup.snapshot` | system | ✔ | ✔ | – | – | – |

## Media, project/collaboration and own-identity surfaces

Every new method is declared in RPC_RULES and is human-only at the surface gate:

| RPC family | Coarse action | Additional stored-object check |
|---|---|---|
| media.generate/edit, media.job.cancel, media.output.delete | media.write | agent.use |
| media.job.get/list, media.output.get/list | media.read | agent.read; lists filter inaccessible agents |
| media.adapters.list, media.preferences.get | media.read | no credentials returned |
| media.preferences.set | media.write | settings.write globally, agent.manage per agent |
| project.create | project.create | Owner/Admin |
| project.get/list, collab.trace.get/list | project.surface.read | role-level readers or actual project membership |
| project.update/archive, project.member.add/remove/role | project.surface.write | project.manage (lead) |
| project.agent.add/remove, collab.chain.cancel | project.surface.write | project.write (member); add also agent.use |
| identity.link.list, identity.principals | identity.self.read | self or Owner/Admin target override |
| identity.link.request/approve/decline/remove | identity.self.write | self or Owner/Admin; service authorization remains |

Read gates include all human roles. Write gates exclude Viewer. Token scopes
still narrow role rights; the service's existing object checks remain additive.
All new methods reject unauthenticated and agent callers before invoking handlers.
The guard passes its resolved principal to the invocation through a private
context map; params cannot forge it. Existing method authorization is unchanged.

## Provider login (`auth.*`)

The R2 methods are declared in RPC_RULES and are human-only; the two actions are granted to **Owner only** (ChatGPT-plan credentials are the installation owner's own, and the D110 `AuthService` enforces `requireOwner` a second time). Admin, Operator, Member and Viewer are denied with `role-denied`, an agent principal with `agent-principal`, an unauthenticated call with `E_UNAUTHORIZED`; the handler never runs in any of those cases.

| RPC | Coarse action | Notes |
|---|---|---|
| auth.credentials.list, auth.status | auth.credentials.read | Ids, workspace and expiry only |
| auth.login.start, auth.login.await, auth.login.cancel, auth.logout | auth.credentials.write | The login is bound to the authenticated person; an `await` whose connection closes cancels the login |

## Channel management (`channel.*`)

The R3 methods are declared in RPC_RULES and are human-only; both actions are granted to **Owner and Admin** (the catalogue's `channels.read` stays the Operator/Viewer page gate and is not used by these methods). Operator, Member and Viewer are denied with `role-denied`, an agent principal with `agent-principal`, an unauthenticated call with `E_UNAUTHORIZED`; the handler never runs in any of those cases.

| RPC | Coarse action | Notes |
|---|---|---|
| channel.list, channel.get, channel.status | channel.read | Secrets appear as names only (`{ secret, present }`), never a value |
| channel.test | channel.read | `sendOwner: true` additionally requires `channel.write` (checked in the handler) and sends one fixed text to the caller's own linked identity on that channel |
| channel.enable, channel.disable, channel.set | channel.write | A write is a `config.set` through the supervisor, so the per-key restart class applies; `channel.set` refuses secret values |

## Media index (`media.search`, `media.index.*`, `media.caption.set`)

Three actions cover the media search surface. Everything is denied by default: an unauthenticated call is `E_UNAUTHORIZED`, a principal with an unknown or missing role is `E_DENIED`, and the handler never runs in either case.

| RPC | Coarse action | Who | Notes |
|---|---|---|---|
| media.search, media.index.status | media.index.read | Every role, agents included | Not human-only. The handler searches in the caller's scope (`scopeOf`: an agent sees its own scope) and drops every hit the caller may not read (`readable`); `likeMediaId` needs read access to the seed medium, otherwise `E_NOT_FOUND` |
| media.index.pause, media.index.resume, media.index.reindex | media.index.operate | Owner and Admin, people only | Agents are denied with `agent-principal`. `reindex` needs `confirm: true` |
| media.caption.set | media.caption.write | Owner, Admin, Operator, Member, people only | Agents are denied with `agent-principal`; the handler also needs edit rights on the medium (`editable`: `agent.use` on the agent that made it, from the owner file under `<home>/media/owners`), otherwise `E_DENIED reason=not-editable`; an unreadable medium is `E_NOT_FOUND` |

The `E_MEDIA_*` codes (capability, licence, “Only local models”, availability, dimension, unsupported kind) are not RBAC outcomes; they report that the media index itself cannot do what was asked (see [errors.md](errors.md)).

## F39–F42/F44 administration backend

See [Administration backends](admin-backends.md) for format, lifecycle, invitation redemption, notices and engine limitations.
Every rule below is human-only, including reads; an agent principal is denied regardless of role, scopes or object rights.
Assigned roles and explicit agent rights are read from `state/admin.sqlite` on every authenticated core invocation.

| RPC methods | Policy action | Human roles |
|---|---|---|
| `agent.pause`, `agent.resume` | `admin.agent.operate` | Owner, Admin, Operator |
| `agent.archive`, `agent.unarchive`, `agent.export` | `admin.agent.manage` | Owner, Admin |
| `agent.delete` | `admin.agent.delete` | Owner, Admin; archived, typed display name and actor-bound export offer required; engine erasure currently unavailable |
| `agent.rights.get`, `agent.rights.set` | `admin.agent.rights` | Owner, Admin |
| `user.list`, `user.invite.list` | `admin.users.read` | Owner, Admin |
| `user.role.set`, `user.invite.create`, `user.invite.revoke` | `admin.users.write` | Owner, Admin; ownership changes Owner only, last Owner protected; `user.role.set` and invitations never create a second Owner (ADR-007: exactly one; no ownership transfer operation exists yet) |
| `user.invite.redeem` | none (no principal yet) | Any connection that passed the core handshake; the one-time token is the credential, failures are rate-limited and uniform ([invites.md](invites.md)) |
| `breakglass.request`, `breakglass.revoke` | `admin.breakglass.write` | Owner, Admin; library also enforces request/revoke rules |
| `breakglass.list` | `admin.breakglass.read` | Owner, Admin; holder's grants only |
| `breakglass.notices` | `admin.notices.read` | All five; affected person's own inbox only |
| `inbox.list`, `inbox.count` | `inbox.read` | All five, human principals only; the caller's own inbox, no parameter names another person |
| `inbox.markRead`, `inbox.dismiss` | `inbox.write` | All five, human principals only; own entries only, foreign ids change nothing |
| `session.list` | `admin.sessions.read` | All five; Member own only; Owner/Admin/Operator/Viewer may filter all metadata |
| `session.get`, `session.resume`, `session.events` | `admin.sessions.transcript` | All five; own session or live audited Break-Glass grant |
| `session.model.set` | `admin.sessions.write` | Human Owner, Admin, Operator, Member; own idle direct session and `agent.use`; never WebMCP |
| `chat.model.get` | `chat:read` | Owner, Admin, Operator, Member, Viewer; own direct chat (identity from the authenticated person) and `agent.read` |
| `chat.model.set` | `chat:write` | Human Owner, Admin, Operator, Member; own idle direct chat and `agent.use`; a profile locked by "Nur lokale Modelle" is `E_DENIED` `local-only`; never WebMCP |
| `session.create`, `session.submit`, `session.cancel`, `session.archive` | `admin.sessions.write` | Owner, Admin, Operator, Member; own session and `agent.use` required |
| `memory.list`, `memory.show` | `admin.memory.read` | All five; optional `targetUserId` requires `agent.read` and live library `memory.user.read` authorization |
| `pairing.qr` | `admin.pairing.read` | Owner, Admin; existing payload only, no code issuance |

Token scopes intersect **every** gate. For example, a scoped invitation caller also needs the existing Identity `users.manage`
scope; a scoped Break-Glass request needs `breakglass.request` as well as the new surface action. These nested checks never
widen a token. Explicit `manage` implies `use`; Viewer still cannot write. Break-Glass never authorizes a session mutation.
All these method names occur in `RPC_RULES`, the independent role-matrix fixture and deny-by-default guard tests.

D109's `harness.admin` capability is never available to agents; its specification explicitly delegates direct harness admin
operations to human CLI/UI callers. These backends do not route human actions through an agent tool grant. Destructive
operations use mandatory audit and the existing human RBAC gates; the pinned engine's missing hard-erasure API fails closed.
The existing D109 approval service is unchanged.

`createBreakGlass({ requireNotification: true })` adds a fail-closed notice gate used by the core: a failed durable notice write
leaves no usable grant. Existing library callers retain their default behavior. Core notices are persisted, self-scoped, and
optionally delivered through the checked `breakglass.notice` audience. A lapsed/revoked window cannot read foreign transcripts
or user cards, and every allowed use is audited. Web binding remains follow-up; no web sources are changed.

## Device management (F44)

All `device.*` methods are human-only and intersected with exact token scopes
(`device.list`, `device.revoke`, `device.rename`) or `device.*`. Agents, missing
principal kinds, unknown roles and unscoped tokens are denied regardless of rights
or Break-Glass grants. The central system-resource rules admit the person; the
handler applies the stored `pairedBy` ownership gate, as for identity self-service.
Ownership is never accepted from RPC params.

| Method | Owner/Admin | Operator/Member/Viewer |
|---|---|---|
| `device.list` | All, including revoked entries | Own entries only |
| `device.revoke` | Any device | Own device only |
| `device.rename` | Own device only | Own device only |

The matrix fixture covers method admission. The guard/handler tests independently
cover stored ownership, spoofed ownership params, token scopes, unknown roles and
agent principals. Successful pairing, revocation and rename use the existing audit
sink with `device.paired`, `device.revoked`, `device.renamed`; audit failure prevents
the mutation. UI binding and remote transport mounting remain follow-up work.

## Project board

See [Project board backend](projects-board.md#rights) for the stored-role matrix.
All 17 board methods are declared in `RPC_RULES`. The independent policy fixture
covers `project.board.read/write/move/comment/manage`; the guard/handler tests
cover every method, absent/unknown principals, empty token scopes, Viewer writes,
forged object rights, foreign projects and live agent assignment.

Read, move and comment admit agents at the coarse guard. The object gate then
requires their trusted identity in the persisted project's agents. Agents may
move only cards explicitly assigned to themselves and cannot override WIP.
Write and manage are human-only. Human mutations require `project.write`
(member), column administration and WIP override require `project.manage`
(lead); stored membership replaces caller-supplied rights. Owner/Admin retain
the existing object policy override. Viewer cannot mutate even as a lead.
Board token scopes are the corresponding `project.board.*` action names;
object checks do not require an additional unrelated token scope.

Events reauthorize stored membership and read scopes for each recipient. The
WebMCP provider blocks `project.column.` even on explicit inclusion; workflow
structure and WIP policy remain human-managed.


## Voice V3

Every human role (Owner, Admin, Operator, Member, Viewer) may read the canonical
Voice UI RPCs and model/status metadata. Owner/Admin alone may write language
selection, realtime profiles, sparse agent overrides, install models, or start /
stop realtime sessions. Agent principals may only read their own
`voice.agent.override.get`; the authenticated agent identity must equal `agentId`.
The Voice surface resolves and checks identity before any config, disk or network
mutation. Token scopes further narrow these grants through `voice.read`,
`voice.write`, and `voice.override.read` (`voice.*` includes them).

Realtime state/transcripts and download progress target only the originating
connection and require named event subscriptions; foreign persons and agents
cannot receive them through unfiltered subscriptions. A foreign voice session
cannot be stopped, including by another Owner/Admin. The seven Voice write RPCs
are blocked by the existing WebMCP forbidden-method list. Licence acceptance
is an explicit request for the specific current model licence, never a default.

## Agent creation, wizard validation and import

`agent.create`, `agent.validate` and `agent.import` require an authenticated
Owner/Admin person and the `settings.write` token scope. All three are blocked
by WebMCP. Agent principals are refused before payload processing even with an
Owner role. Config Schema settings, model-profile references and channel names
are checked before mutation; wizard errors are grouped by identity/model/rights.

Initial `rights` is a person-ID → `use`/`manage` parameter written to the existing
AdminStore, never duplicated in Config Schema. The caller receives `manage`.
Only existing people receive explicit grants; agent IDs are not people. Role
and token scopes bound delegation (`agent.read` for use, `agent.manage` for
manage). Import discards recipients absent on the target and reports them as
`discardedRights`; scoped callers cannot carry excessive imported rights over.
Export reads live rights from AdminStore and includes them in its signed manifest.
Required secret names are metadata only; no secret values are imported.
See [agents.md](agents.md) for CLI formats, compatibility and recovery behavior.

## Import maintenance and SSH sources

Import maintenance is available to Owner/Admin people only. Token scopes narrow
these grants; a PAT remains an agent principal even when its stored role is Owner.

| Method | Coarse action | Owner | Admin | Operator | Member | Viewer |
|---|---|---|---|---|---|---|
| `admin.import.detect` | `imports.manage` | ✔ | ✔ | – | – | – |
| `admin.import.wsl.list` | `imports.manage` | ✔ | ✔ | – | – | – |
| `admin.import.plan` | `imports.manage` | ✔ | ✔ | – | – | – |
| `admin.import.preflight` | `imports.manage` | ✔ | ✔ | – | – | – |
| `admin.import.skills` | `imports.manage` | ✔ | ✔ | – | – | – |
| `admin.import.apply` | `imports.manage` | ✔ | ✔ | – | – | – |
| `admin.import.status` | `imports.manage` | ✔ | ✔ | – | – | – |
| `admin.import.abort` | `imports.manage` | ✔ | ✔ | – | – | – |
| `admin.import.runs` | `imports.manage` | ✔ | ✔ | – | – | – |
| `admin.import.rollback` | `imports.manage` | ✔ | ✔ | – | – | – |
| `admin.import.ssh.key.status` | `imports.read` | ✔ | ✔ | – | – | – |
| `admin.import.ssh.key.generate` | `imports.manage` | ✔ | ✔ | – | – | – |
| `admin.import.ssh.key.rotate` | `imports.manage` | ✔ | ✔ | – | – | – |
| `admin.import.ssh.key.delete` | `imports.manage` | ✔ | ✔ | – | – | – |
| `admin.import.ssh.connections.list` | `imports.read` | ✔ | ✔ | – | – | – |
| `admin.import.ssh.connections.set` | `imports.manage` | ✔ | ✔ | – | – | – |
| `admin.import.ssh.connections.delete` | `imports.manage` | ✔ | ✔ | – | – | – |
| `admin.import.ssh.hostKey.probe` | `imports.manage` | ✔ | ✔ | – | – | – |
| `admin.import.ssh.hostKey.trust` | `imports.manage` | ✔ | ✔ | – | – | – |

The SSH handlers additionally require the Owner for all key operations, connection
writes, host-key probing and trust. Only the public key and fingerprint can leave
the key service. The private Ed25519 key stays in Secret Store and reaches the
verified native helper over a private lease after the host fingerprint matches.
Connection configuration and its ancestors carry the Owner-only write policy, so
generic `config.set` cannot bypass these handler checks.

Host-key probes belong to their initiating Owner and current connection revision,
expire after five minutes and are consumed by trust. A changed host key stops
before authentication. Owner/Admin can read only explicitly configured source roots;
the current role and original token scopes are rechecked on each filesystem call.
Private SSH destinations require consent on that connection. This allowance does
not change HTTPS egress policy. Key or connection changes revoke existing read handles.
Import plans, run status and rollback remain bound to their authenticated initiator.


### Import GUI and temporary maintenance authority

`GET /api/v1/import/sources` requires human `imports.read` and returns only canonical
format names and a server-derived host-path capability hint. The GUI uses the same
human import methods at `/import` and setup F37. Source upload, inspection, plan,
preflight and run IDs have different purposes; no browser-selected path becomes an
upload ID. Snapshot uploads use their own private namespace, ten-minute ownership
and a fixed 1 GiB compressed limit.

Decision8 free host paths and additional source path mappings require Owner on remote surfaces.
Admin may supply them on a verified loopback/local Desktop connection. The API stamps
`ApiDelegation.transport` from its socket/listener facts. The shared RPC server checks
the registration credential, binds the fact separately from the principal in a WeakMap,
and locks it to that connection. Public params, forwarding headers and a forged context
field cannot supply it. Absent delegated proof fails closed. This locality fact does
not raise approval surface trust or satisfy MFA. Secret migration additionally requires
Owner; re-embedding still checks the real actor/model/revision licence ledger and use class.

A successful authenticated apply/rollback can create one temporary context for its
initiating ordinary cookie, authenticated person, credential/auth version, logical
connection and exact run. It is capped at 75 minutes and the session's own expiry;
status, reload and reconnect do not renew it. The native active-run proof independently
limits the job to its hard deadline and recovery. A native device cookie is eligible only
when the API-private `DesktopStepUp.importSessionProof` map supplies stable provenance
from a same-person imports-purpose approval. The context additionally binds the immutable
device ID, device expiry and narrowed enrolled scopes, Core identity version and local
credential version. Public fields, an MFA timestamp alone, another cookie or a different
purpose cannot create that proof. The originating approval grant's short lifetime does
not renew or truncate a successfully redeemed normal device session. Its own logout,
session expiry and credential-version changes revoke maintenance access.

Only genuine Core transport loss or its typed `E_CORE_UNAVAILABLE/core-stopping`
shutdown branch may use that context: explicit live Core
refusals, untrusted endpoints and account-storage errors never do. Permitted operations
are that run's status and cancellation, history filtered to that one run, and bounded
`import.progress` checkpoints. Own whoami, CSRF issuance and logout are infrastructure
for that same cookie; they grant no other operation. Config, setup, detection, planning,
new apply and new rollback require live Core authorization. Another cookie, including
another session of the same person, cannot inherit the context.

The CoreLink may retain only the service credential actually used by the successful
run, privately in memory for the same bounded person/connection/run. Missing-file
fallback is never available to generic RPC or Core calls. Fresh credential rotation,
terminal status, native proof refusal/close, expiry and shutdown retire it. No credential
is persisted, logged or returned. Logout or a local credential-version change revokes
the cookie context immediately; live Core authority supersedes it when available.
Progress accepts only same-run schema-valid metadata up to 4096 bytes and has no source
paths, names, configuration or secret values.

`admin.import.runtime.config.set` is a separate private Core-to-supervisor control, absent from the Web gateway.
It requires no API delegation and the kernel-reported peer PID must match the currently tracked Core process.
The run ID, plan ID and plan hash must match the active maintenance reservation. Writes keep the initiating job's
role and ordinary configuration policy, while maintenance owns the restart. Losing that private connection refuses
the write; it never falls back to ordinary `config.set` or direct file writes.

`admin.import.runtime.release`, `admin.import.runtime.status` and `admin.import.runtime.complete` are private
native-to-Core lifecycle controls, also absent from the human Web gateway and ordinary human allow rules.
Their closed run/plan/hash parameters carry no actor, selected model or source path; those derive from the
authenticated immutable plan. They do not grant API delegation, module-client or agent authority.
The Core handlers require the trusted local Owner credential, reject API delegation and client contexts, and check
the held run's fixed private record in `restarting-core` state against the same immutable plan hash. They resolve
the initiating person again as Owner/Admin and repeat model artifact, licence-ledger and use-class checks where
needed. Release waits for completion with no pending model restart before enabling normal routing.

The controlled-port HTTP and real credential-file deletion checks cover these gates.
Actual ordinary-cookie HTTP apply has passed across native Core shutdown and restart.
Actual cancellation and mid-entity automatic restoration also passed an exact full mutable-data baseline check.
The imports-purpose MFA device cookie also passed actual stopped-Core status/progress isolation and restart.
Fresh manual rollback also passed with exact mutable-data restoration and a second Core restart.
Required browser/axe execution remains pending; see
[Web UI validation status](web-ui.md#m-v2-extensionimport-validation-status).

## Web transport reachability

The session-only `/rpc` gateway uses an explicit exposure list in `packages/api/src/rpc-route.ts`. It delegates the actual person through a separately registered local API credential; stored core roles and agent rights override forwarded snapshots. It never accepts a browser principal or actAs. Personal API tokens remain agent principals and retain scope narrowing.

### Extensions

Every extension operation is human-only and restricted to Owner/Admin. Member,
Operator, Viewer and agent principals are denied, including metadata reads and
watch subscriptions. The API and supervisor use the same explicit extension
method inventory; the Core guard covers extension setup and sign-in.

| Methods | Action |
|---|---|
| `ext.list`, `ext.show`, `ext.watch`, `ext.inspection.get`, `admin.extensions.setup.get`, `admin.extensions.auth.status` | `extensions.read` |
| `ext.inspect`, `ext.install`, `ext.uninstall`, `ext.restore`, `ext.enable`, `ext.disable`, `admin.extensions.setup.set`, `admin.extensions.auth.start`, `admin.extensions.auth.submit`, `admin.extensions.auth.cancel` | `extensions.manage` |

Token scopes intersect these grants. Setup metadata contains declared secret slot
names and availability only. The secret setter separately requires the Owner;
Admin cannot store or reveal secret values. OAuth attempts belong to their
initiating person and extension; discovery never starts sign-in. Status uses the
read action; start, callback submission and cancellation use manage.

Browser inspection accepts an opaque uploaded-package ID, never a host path.
Uploads and inspections belong to the authenticated person, expire after ten
minutes, and cannot be installed by another person. Multipart uploads stream into
private staging; their response contains only an ID, expiry and SHA-256. Session
writes require CSRF. `ext.changed` is forwarded only to an authorized person's
extension feed and is checked again against the live session authority.

The native file upload and inspect routes additionally accept a live, person-bound
device credential with explicit `extensions.manage` enrollment. Import snapshot
uploads use a separate ID namespace and explicit `imports.manage` enrollment.
Neither opt-in changes PAT authority or opens Bearer access to `/rpc`. A required native
TOTP/WebAuthn continuation uses a short-lived same-person browser approval and private,
operation-bound one-use proofs. The purpose and scopes can only narrow the actual live
device enrollment; no caller-supplied factor timestamp is accepted. A redeemed device
cookie retains private verified provenance and intersects its narrowed scopes with the
fresh live device identity on every resolution. Runtime hold/release
and status RPCs retain their separate native-only handler checks and are absent
from the Web gateway.

| Method | Action | Owner | Admin | Operator | Member | Viewer |
|---|---|---|---|---|---|---|
| `admin.extensions.setup.get` | `extensions.read` | ✔ | ✔ | – | – | – |
| `admin.extensions.auth.status` | `extensions.read` | ✔ | ✔ | – | – | – |
| `admin.extensions.runtime.status` | `extensions.read` | ✔ | ✔ | – | – | – |
| `admin.extensions.setup.set` | `extensions.manage` | ✔ | ✔ | – | – | – |
| `admin.extensions.auth.start` | `extensions.manage` | ✔ | ✔ | – | – | – |
| `admin.extensions.auth.submit` | `extensions.manage` | ✔ | ✔ | – | – | – |
| `admin.extensions.auth.cancel` | `extensions.manage` | ✔ | ✔ | – | – | – |
| `admin.extensions.runtime.hold` | `extensions.manage` | ✔ | ✔ | – | – | – |
| `admin.extensions.runtime.release` | `extensions.manage` | ✔ | ✔ | – | – | – |

`admin.extensions.runtime.reconcile` is a supervisor method that only the Core calls, with its own supervisor
connection, after an extension's secret changed. Neither the Harness API nor a delegated person reaches it, so it has
no rule in `RPC_RULES`.

Config get/set and module list/graph use the supervisor, which obtains current identity from the core; config writes are Owner/Admin and additionally obey every affected x-write-roles annotation, including parent replacements. Annotations and sensitivity are checked at the mutation boundary. Internal lifecycle/auth/subscription RPCs, admin backup/import, secret reveal and raw caller-based memory calls remain excluded. For legacy methods without a guard, API admission is conservative: actual Owner only, except authorized diagnostics and filtered agent listing. This is narrower than the previous local-token compatibility path. Remaining exposed methods keep their existing Core policy and humanOnly requirements.

Person-bound SSE is independent of WebMCP. An event requires a matching person/connection audience, or (for recall, jobs, dreams, ACL denials and agent activity) a typed agent audience plus current `agent.read` permission; only process-only `core.state` is globally forwarded. Subscription filters do not grant access. Explicit agent subscriptions are checked at admission and agent events are checked again at delivery, so rights revocation takes effect on existing subscriptions. Owner/Admin see all agents; Member/Viewer need `use` or `manage` rights. Operator follows the existing `agent.read` policy. Local owner IPC keeps its unfiltered event stream. Replay retains already filtered events per person and session. A delegated connection has no automatic step-up/OS attestation. See [api.md](api.md#browser-rpc-and-events) for limits and local trust boundaries.

### Agent activity history

`agent.activity.list` is human-only, uses the `agent.list` admission gate and filters every returned transition against current agent rights. Owner and Admin see all agents. Operator, Member and Viewer need `use` or `manage` for each agent. Cursor validity includes the visible roster, so a rights change requires a fresh query.

### Doctor snapshots

`doctor.report` is human-only. Its admission gate permits all five human roles to read the cached report. The all-human read admission uses `agent.list`; the handler additionally authorizes `doctor.run` (including token scopes) and requires Owner, Admin or Operator for `refresh: true`; it rate-limits a fresh check to once per 30 seconds. Agents cannot request or read this report.

### User recurring task methods

New human-only rules: `jobs.create` → `agent.manage` on params.agentId; `jobs.update` and `jobs.delete` → `agent.list` for the initial authenticated read, followed by handler-level `agent.manage` checks on the stored and proposed targets. These require the corresponding token scopes as well as roles/rights. `jobs.list/history` user paths resolve a person and apply `agent.list` plus visibility filtering; legacy engine/system paths retain their existing classification.

The existing `agent.manage` policy grants owner/admin and member-with-manage, and excludes operator/viewer. The existing `jobs.run` rule remains owner/admin/operator; user runs additionally need use rights and execute as stored `runAs`, never the triggering caller. Existing approval roles and surface requirements remain unchanged. The new create/update/delete methods, `doctor.report` and `agent.activity.list` are explicitly excluded from WebMCP exposure.

The internal `admin.api.person.resolve` and `admin.api.invite.validate` methods carry `admin.users.read` rules (Owner/Admin policy), but require the separate API service credential with **no delegated principal**. Ordinary IPC, browser persons, and agents are refused. They are absent from the Web RPC allowlist and the `admin.` WebMCP exclusion applies.

| `admin.api.person.resolve` | `admin.users.read` | ✔ | ✔ | – | – | – | API service credential only; role policy does not admit ordinary clients |
| `admin.api.invite.validate` | `admin.users.read` | ✔ | ✔ | – | – | – | API service credential only; role policy does not admit ordinary clients |

Remote trust challenge and acknowledgement use the additive human-only `remote.device.write` action (Owner/Admin/Operator/Member; Viewer denied) and cookie sessions with CSRF. Nonce-only pairing proof and one-use code redemption are reviewed bootstrap exceptions: no delegated identity or normal session is manufactured. All four private device services use the existing DeviceStore and a separately authenticated API service credential without a delegated principal.

| `admin.api.device.pair` | `admin.pairing.read` | ✔ | ✔ | – | – | – | API service credential only; ordinary IPC, persons and agents denied |
| `admin.api.desktop.redeem` | `admin.pairing.read` | ✔ | ✔ | – | – | – | API service credential only; ordinary IPC, persons and agents denied |
| `admin.api.desktop.token` | `admin.pairing.read` | ✔ | ✔ | – | – | – | API service credential only; ordinary IPC, persons and agents denied |
| `admin.api.desktop.resolve` | `admin.pairing.read` | ✔ | ✔ | – | – | – | API service credential only; ordinary IPC, persons and agents denied |
| `device.pair` | `remote.device.write` | ✔ | ✔ | ✔ | ✔ | – | Human only; code belongs to the authenticated person and kind desktop |
| `admin.api.device.challenge` | `admin.pairing.read` | ✔ | ✔ | – | – | – | API service credential only; ordinary IPC, persons and agents denied |
| `admin.api.device.prove` | `admin.pairing.read` | ✔ | ✔ | – | – | – | API service credential only; ordinary IPC, persons and agents denied |
| `admin.api.device.announce` | `admin.pairing.read` | ✔ | ✔ | – | – | – | API service credential only; ordinary IPC, persons and agents denied |

### Secret metadata and lease read view (Phase E, 2026-10-18)

`secret.describe` adds a human-only `settings.write` guard and `secret.grants.list` a human-only `settings.read` guard.
The store's principal gate additionally restricts both to the owner; Admin passing the coarse settings permission still
cannot use them. WebMCP forbids the entire `secret.` namespace. No grant writer or agent lease route exists. Configuration
references are not grants. See [secret metadata and access](secrets.md).
### Model role probe (Phase A, 2026-10-18)

`admin.engine.test` requires `settings.write` and a human Owner/Admin principal, including the existing device scope
checks. It is excluded from WebMCP and never exposes provider errors, URLs or key values. The Web API's reviewed RPC
bridge explicitly permits this method under those same Core rules; no standalone admin REST route is added.

`models.test` requires `settings.write` (Owner/Admin) and an explicit human principal at the RPC guard. Token scopes can
only narrow access. It is forbidden as a WebMCP tool. The handler takes only a model identifier; prompt, output cap, tool
set, memory and timeout are server-owned. It selects one configured candidate without fallback and admits the request
through the same budget/router and adapter egress as ordinary model calls. It creates no session or transcript.

### A4: human memory curation

`memory.curation.list` and `memory.curation.resolve` are **humanOnly** and require
`agent.manage` on the exact requested agent. Owner/Admin may operate the queue;
a Member needs an explicit `manage` grant for that agent. A grant on a different
agent is insufficient. Agent principals are denied even when their role is Owner
or their object grants contain `manage`. Operator/Viewer receive no role-wide
access. The handler derives Engine identity from the authenticated connection,
not request text; the closed params reject `caller` and target-human overrides.

The explicit object grant is the current proxy for “own human”, matching the
private diary boundary. A new active relationship binding is D116 C3 and is not
introduced here. Engine ACLs additionally filter individual queue records. Keep
and drop use the Engine's mandatory curation audit. Both RPCs are exposed on the
human web route and forbidden over WebMCP, including explicit include lists.
`memory.proposals.*` remains D31 shared-card correction proposals, not curation.
