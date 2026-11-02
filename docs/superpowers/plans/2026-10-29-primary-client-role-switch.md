# Primary/client role switch and shared compute — implementation plan

**Goal.** An owner moves his one logical PLUR1BUS instance from the MacBook to an SSH host and back, from the desktop
or the CLI alone, with exactly one writer at any time; the other nodes of the cluster share compute with the primary.
Specs: [`2026-10-29-primary-client-role-switch-design.md`](../specs/2026-10-29-primary-client-role-switch-design.md)
("RS spec §n", D118) and [`2026-10-29-shared-compute-design.md`](../specs/2026-10-29-shared-compute-design.md)
("SC spec §n", D119).
**Status.** Owner decisions of 2026-10-31 (PR #825): RS spec Q1–Q14 and SC spec Q1–Q10 decided as recommended; no WP
waits for an owner answer any more. Remaining gates are dependencies, spike results and unknowns (§ "Remaining gates").
No product code yet.
**Language (D120 path B, carried over 2026-10-31).** The D120 design (open PR #833, branch
`docs/harness-hygiene-coding-aci`, proposed ADR-019) makes every **new** component Rust from its first version, run as a
supervised process (first in the one module process `plur1bus-tools`) and called by the TypeScript core over the
harness RPC; a later Phase 4 ports the core. Every WP below was checked against it: new components are Rust; a WP that
touches TypeScript carries a one-line justification that it only extends existing TypeScript code (core wiring in an
existing module, the API allow-list, RBAC tables, or the web SPA).
**Executor.** Every Rust package (`crates/*`, `apps/desktop`) is built by a **Claude agent**, never Codex.
TypeScript-only packages (wiring in existing modules): the controller's choice of agent. **RS0 is briefed for a Sonnet
agent.**
**Constraints.** `AGENTS.md` rules: one branch and one PR per package; commits as `Cyb3rb1ade <cyb3rblade@me.com>`
with the agent's own trailers; no amend, force-push, rebase or stash; no CI polling; no token-like literals; tests
never skipped or weakened; no network in tests; `@cyb3rb1ade/plur1bus-memory` stays a dependency; generated docs via
`pnpm docs:gen`, never by hand; Desktop Green for `apps/desktop`.

## Review focus

1. Never two writer-allowed role records from a cooperative flow, at any kill point (RS spec I1/I2).
2. Automatic transitions only remove writers (I6); every writer grant is a human command with the guards of RS §4.1.
3. A corrupt or unreadable role record allows no writers and is never overwritten (I3).
4. No secret in a bundle, receipt, token, argv, environment, log or audit line; WIF never crosses hosts.
5. Index-bound results commit only under a matching fingerprint or a valid certificate (SC §7).
6. Foreign `privat` items never leave the primary (SC §10.2).

## Dependencies and order

```text
RS0 role model ─► RS1 supervisor gate + role status ─► RS4 handover primitives ─► RS5 --ssh driver
      │           RS2 core role hold ────────────────►        │                 ─► RS8 channel fence + docs
      │           RS3 bundle + node key ─────────────►        │                 ─► RS9 CI + worksheet
      │           RS6 RPC/RBAC/audit (after RS1)               └─► RS7 desktop driver (gated: D113 WP3/WP4, WP5 for Open)
      │
      └─► SC0 queue + placement ─► SC6 privacy/enrolment ─► SC3 node channel (gated: RS7 bridge on remote, M3 pairing,
                                                                              D120 `plur1bus-tools` slot)
SC-S spike ─► SC1 fingerprint + verification ─► SC7 certificates          SC2 engine integration (gated: Rust engine)
SC4 `plur1bus node run` (after SC3) · SC5 node conditions + tray (after SC3) · SC8 surfaces · SC9 harness + worksheet
```

RS0, RS2, RS3, SC0 and SC-S start now: none needs unbuilt D113 code.

---

## Group RS — role switch (D118)

### RS0 — Role model, record store, fencing and lease primitives (Rust, **Claude agent — Sonnet brief**) (≈ 2 agent days)

New module `crates/plur1bus/src/role/` (`mod.rs`, `model.rs`, `store.rs`, `fence.rs`, `tests.rs`), `paths.rs`
(`Layout::role_record()` → `state/role.json`, `Layout::role_dir()` → `state/role/`), `main.rs` (`mod role;`). Pure,
std + serde only (supervisor dependency budget, `scripts/lint-hygiene.mjs` HYG-005/006). Implements the closed
transition table of RS §4.1 as `apply(record, event, now_ms, actor)`, the record schema of RS §4.5 with validation,
`load` (missing → standalone, unreadable or invalid → `Corrupt`, fail closed) and `save` (atomic 0600 via
`ext::state::write_private_atomic`, refuses over a corrupt file and refuses an epoch regression), epoch comparison and
the lease helpers (120 s / 30 s), takeover eligibility, and reason/code mapping (RS §9.2). **Tests first:** every
transition pair (allowed and refused), each guard, epoch monotonicity (proptest over random event sequences: never two
writer roles derivable from one handover, epochs never decrease), store round trip, unknown field, corrupt file not
overwritten, 0600 on Unix. **Acceptance:** `cargo test -p plur1bus role::`, clippy `-D warnings`, fmt, hygiene; no
caller yet (module-level `#![allow(dead_code)]` with a pointer to RS1, as `supervisor/mod.rs` does).

### RS1 — Supervisor gate, `role status`, `1staid` rows (Rust, **Claude agent**) (≈ 3 agent days)

`supervisor/mod.rs` reads the role record at start and after role RPCs; non-writer roles spawn the core with
`PLUR1BUS_ROLE_HOLD=<role>:<epoch>` (`supervisor/child.rs`) and skip writer modules (manifest flag `writer`, defaulting
to true for channel modules; U8 inventory first); a role change goes through the existing `RestartJob` path.
`supervisor/server.rs`: `role.status`. `commands/role.rs` + `cli.rs`: `plur1bus role status [--json]` (schema
`role.status/1`, works without a supervisor). `commands/firstaid.rs`: `role.state`, `role.single-writer`. RPC schema
entry (`packages/rpc-schema/schema/rpc.schema.json`, supervisor server), `pnpm gen`, `pnpm docs:gen`. **Tests:** fake-core
supervisor tests (`crates/plur1bus/tests/` with `fake-core.mjs`) for each role: which units start, the env passed, a
role change restarts the core held; CLI JSON golden; `1staid` rows for corrupt and single-writer violations.
**Acceptance:** Rust gates; `docs:check`; `check-cli-exit-codes`.

### RS2 — Core role hold (TypeScript) (≈ 2.5 agent days)

*Path B justification: extends the existing core hold and its startup wiring (`maintenance-admission.ts`, `core.ts`);
no new component.* Generalise `packages/core/src/import/maintenance-admission.ts` into a hold with a reason (`import` | `role`); the role
hold reads `PLUR1BUS_ROLE_HOLD`, never releases itself, keeps `startImportBackground`'s whole set deferred (system jobs,
discovery, dreams, user jobs, warmup recall path, switchboard, journal replay), allows reads plus
`admin.backup.snapshot`, `secret.set` (while `pending`), `doctor.report`, and answers other methods
`E_CONFLICT reason=role-hold` with the role. Inventory U8 (switchboard vs supervisor modules per channel) and U12
(recurring catch-up rule) recorded in the PR. **Tests:** admission table per method class; background never started
under the role hold; import hold behaviour unchanged (existing tests stay green). **Acceptance:** `pnpm test` for core,
`pnpm lint`.

### RS3 — Snapshot completeness, role bundle, node key (Rust, **Claude agent**) (≈ 4 agent days)

Inventory test for U1 (a home with every unit populated → `backup create` → diff) and the missing units added to
`backup/create.rs`'s allow-list or the core snapshot (media outputs, media index, channel offset stores, extension
data, `state/media-search.json`, `state/compute.sqlite`). `role/keys.rs`: node key create/load (`ring` Ed25519,
`state/role/node.key` 0600, never regenerated), fingerprint; `ring` as a direct dependency with a dependency-policy
record (already resolved through `plur1bus-ext`, U6). `role/bundle.rs`: `plur1bus.role-bundle/1` header (RS §5.3),
canonical JSON, sign/verify, archive SHA-256, host-path list (U9 inventory over the config schema).
`plur1bus role promote --prepare --plan` and `role accept --dry-run` (no state change). **Tests:** inventory diff
empty; sign/verify; tamper of header, archive or signature; stale epoch; foreign cluster; node key never in an archive.
**Acceptance:** Rust gates; `node scripts/lint-hygiene.mjs` (no committed keys).

### RS4 — Handover primitives and the two-instance harness (Rust, **Claude agent**) (≈ 5 agent days)

`commands/role.rs`: `promote --prepare|--commit|--abort`, `accept [--discard] [--replace]`, `activate`, `demote`,
`takeover [--force]`, `rollback --failback|--restore-frozen|--finish`, `resolve --as-client`, `join`, `members`;
supervisor RPC `role.*` (RS §9.2) behind the install lock; quiesce with budget; vault move through owner-only
`secret set` on stdin (and, for the by-hand path, the existing shipped `portable-backup.mjs` run with the bundled Node
runtime — reuse of an existing component, no new crypto in Rust); host-path mapping; pre-commit health
(core `channel.test` credential checks, schedulers, engine); commit-token and receipt files; activation liveness per
channel. Kill-point seam `PLUR1BUS_TEST_ROLE_FAIL_AT=<step>` (only with `PLUR1BUS_ALLOW_TEST_INTERNALS=1`).
**Tests:** `crates/plur1bus/tests/role_two_instances.rs` — two homes on loopback, by-hand driver end to end; after each
kill point assert I1/I2 from both role records and the running units; source sleep between accept and commit; forced
takeover + reconnect → fenced + divergence archive; failback round trip with byte-equal stores; secrets-never-leave
sweep (marker secrets over files, logs, argv recorder, audit). **Acceptance:** Rust gates; system tests on Linux/macOS.

### RS5 — CLI `--ssh` driver (Rust, **Claude agent**) (≈ 1.5 agent days; owner Q6 decided 2026-10-31: system OpenSSH client, CLI only)

`role promote|demote --ssh <user@host> [--port N]`: fixed argv `ssh -T [-p N] -- user@host <fixed command>`, no other
options, bundle on stdin, receipt on stdout (bounded), local commit, remote activate; refuses user/host outside the
D113 charset. **Tests:** a fake `ssh` executable on `PATH` in tests recording argv and replaying a recorded remote; one
job against the D113 OpenSSH container when it exists. **Acceptance:** Rust gates; no secret in recorded argv.

### RS6 — RPC, RBAC, audit, web read (TypeScript + schema) (≈ 2 agent days)

*Path B justification: rows in existing tables (RBAC policy, `RPC_RULES`, the API allow-list, WebMCP prefixes, config
schema); the `role.*` handlers themselves are Rust in the supervisor (RS1/RS4).* `packages/core/src/rbac/policy.ts` actions `role.read` / `role.manage` (Owner only, `humanOnly`, T3); `RPC_RULES`;
`packages/api/src/rpc-route.ts` adds `role.status` to `WEB_SUPERVISOR_METHODS` only; WebMCP forbidden prefix `role.`;
audit and D111 events of RS §9.5; config keys of RS §9.6 in `config.schema.json`; `docs/rbac.md` rows.
**Tests:** RBAC matrix (agent, Admin, Operator, Owner at T1/T3); WebMCP schema walk; config schema fixtures.

### RS7 — Desktop driver and UI (Rust + TypeScript, **Claude agent**) (≈ 5 agent days, gated by D113 WP3/WP4; *Open* by WP5)

D113 `RemoteCommand`s `RoleStatus`, `RolePreflight`, `ReceiveRoleBundle` (WP4 upload channel), `RoleAccept`,
`RoleActivate`, `RoleDemote`; local supervisor `role.*` calls; wizard (plan → confirm → progress → health → done),
rollback page, connection role chip, tray `RoleLabel` beside `PathLabel` (`tray.rs`), badges per RS §9.3; DS17 bridge
allowed on the SSH connection to the owner's own primary (prerequisite for SC3); DE/EN strings. *Path B: the Rust part
is the new code; the TypeScript part is views in the existing desktop shell UI (`apps/desktop/ui`), a web UI like the
SPA.* **Tests:** fixture
russh server + `fake-plur1bus` role scenarios; command charset; Playwright wizard, rollback, tray texts, axe.
**Acceptance:** Desktop Green, `check-i18n`.

### RS8 — Channel fence signal and docs (TypeScript + docs) (≈ 1.5 agent days)

*Path B justification: a status signal in the existing channel registry and Telegram adapter; no new component.*
Sustained Telegram `409` (> 5 min) and an overtaken webhook raise `role.channel-conflict` (registry status → `1staid`,
tray, audit); `docs/role-switch.md` (operator page), `docs/cli.md` via `docs:gen`, pointer sections in the D113 spec
(§6.3 commands) and WIF §12.5 when #823 has merged; user-guide DE/EN text as a template in the PR body (agy edits
`docs/user/`). **Tests:** loopback fake Bot API answering `409`.

### RS9 — CI job and owner worksheet (≈ 1.5 agent days)

A `role-two-instances` job (Linux, macOS) for RS4's suite, path-filtered to `crates/plur1bus/src/role/**`, backup and
supervisor code; an owner worksheet (MacBook → Ubuntu VM, Telegram test bot, notebook off for an hour, failback).

---

## Group SC — shared compute (D119)

### SC-S — Runtime spike (Claude agent; measurement scripts, not a product component) (≈ 2 agent days + owner time)

ONNX CPU vs CoreML EP vs MLX on Apple Silicon against ONNX CPU on the VPS/Ubuntu VM, EmbeddingGemma 2 text (270M, q8)
and full (740M): throughput, RAM, cosine to reference (min/mean/p01), recall@10 parity, arm64 vs x64 CPU drift; check
for an EmbeddingGemma 2 MLX port and the CoreML EP in the pinned onnxruntime-node prebuild (SC U1, U2, U4, U7).
Result: `docs/handoff/status/<date>-compute-spike.md` with proposed τ values and go/no-go per backend.

### SC0 — Job queue and placement (Rust library crate, **Claude agent**) (≈ 3 agent days) — *changed 2026-10-31: was TypeScript*

New crate `crates/plur1bus-compute` (workspace member; SC spec SC12): `classes.rs` (class table, SC §5.1, from the
config view the core passes), `queue.rs` (state machine, SC §5.3, over a `Store` trait and an injected clock),
`placement.rs` (SC §5.2 as a pure function of jobs, node snapshots and policy), a `rusqlite` store for
`state/compute.sqlite` behind the trait (`rusqlite` is already in the workspace lockfile through the engine; a
dependency-policy record if it becomes a new direct dependency of this crate). No process and no RPC yet: SC3 hosts
the crate in `plur1bus-tools`. **Tests:** deferral by node absence (59 min vs 61 min), age cap, re-embed `wait`, node
return mid-backlog, lease expiry requeue, max attempts, cancellation, paused queue outside writer roles; proptest over
event sequences (a job is committed at most once). Still the second-best Sonnet candidate (pure, not blocked).

### SC1 — Fingerprint fields and result verification (Rust, **Claude agent**) (≈ 2.5 agent days, after SC-S for defaults) — *changed 2026-10-31: was TypeScript*

`encoders`, `runtimeFamily`, `precision` as additive fields of `VectorSpaceIdentity` in
`crates/plur1bus-engine/schema/engine-contract.schema.json` with the compatibility default (SC §7.1); the producer
check and the primary's result verification (dimension, norm, NaN, stale, duplicate, spot-check decision) as pure
functions in `crates/plur1bus-compute/src/verify.rs`. **Tests:** comparison table; legacy identity equals its explicit
form; every rejection reason; `node scripts/check-engine-contract.mjs`.

### SC2 — Engine integration (Rust engine, **Claude agent**) (≈ 4 agent days, gated by the Rust engine) — *changed 2026-10-31: Rust engine only*

In `crates/plur1bus-engine` (the RE plan's engine; the Node engine package gets no new features): per-item
`embedding: pending` marker with FTS-only recall, external vector commit under a fingerprint, compute-only `embed()`
without opening stores (SC U3, RS U7). *Path B justification for the TypeScript part:* the core-side calls are wiring
in the existing `packages/core/src/engine/client.ts` (`EngineClient`). **Tests:** engine contract tests; harness
adapter tests with the fake engine.

### SC3 — Node channel and lease protocol (Rust, **Claude agent**) (≈ 5.5 agent days, gated by RS7, M3 pairing and D120's `plur1bus-tools` slot) — *changed 2026-10-31: server side moved from TypeScript to Rust*

`plur1bus-compute` hosted in the supervised `plur1bus-tools` process (D120 §12.3); worker methods (SC §8.1) and the
core-facing enqueue/result methods as `x-server: "tools"` in `rpc.schema.json`; leases, idempotent commit,
cancellation, back-pressure, blob route; desktop carrier (Rust `bridge.rs`) relays to the bundled core over its local
socket; chunked binary frames on the bridge (SC U5). *Path B justification for the TypeScript part:* the API adds the
routes to its existing allow-list and the core calls the new methods from its existing capture, import, media and
migration paths (wiring only). **Tests:** two-instance harness with a fake node: redelivery with one commit, cancellation mid-batch, partial
completion, fenced primary stops leasing, node follows the higher epoch.

### SC4 — `plur1bus node run` (Rust, **Claude agent**) (≈ 3 agent days, after SC3)

D51 b CLI carrier for headless nodes (`tailnet`/`network` primaries, SC Q9); announces D112-discovered local servers and
in-core identities; relays chat (D51) and compute. **Tests:** loopback primary fixture; reconnect with backoff; epoch.

### SC5 — Node conditions and tray (Rust desktop, **Claude agent**) (≈ 3 agent days, after SC3)

Power, thermal, idle, in-call probes per OS where available (SC U6), limits, *Pause sharing* menu and tray texts
(SC §12.5), `plur1bus compute pause|resume` on the node. **Tests:** conditions table with injected probes; tray texts.

### SC6 — Privacy, enrolment, licences, local-only node rule (Rust + TypeScript wiring, **Claude agent**) (≈ 3 agent days) — *changed 2026-10-31: new logic moved to Rust*

In `plur1bus-compute`: the D116 filter (SC §10.2), the enrolment store and `compute.node.enroll|remove|limits.set`
(Owner, `humanOnly`, T3), the per-device NC licence check. *Path B justification for the TypeScript part:* the scope
`compute.serve` in the existing device store and grants, the RBAC rows, and the cluster rule in the existing
`local-only.ts` (RS Q7) extend existing modules. **Tests:** household fixture (Owner, Eva) with all
levels; RBAC matrix; local-only refusals.

### SC7 — Equivalence certificates (Rust, **Claude agent**) (≈ 3 agent days, after SC-S, SC1, SC3) — *changed 2026-10-31: was TypeScript + Rust CLI*

Certificate store and gate in `plur1bus-compute`, `plur1bus compute certify` in the CLI, calibration set shipped with the release, thresholds from SC-S, recall@10 parity on the
store's benchmark, expiry on any identity change. **Tests:** pass, fail, expiry, a perturbed backend refused.

### SC8 — Surfaces (Rust + web SPA, **Claude agent**) (≈ 3.5 agent days) — *changed 2026-10-31: RPC handlers in Rust*

`plur1bus compute status|nodes|jobs|node …` (CLI), the `compute.*` read and management handlers in `plur1bus-compute`
(SC §12.2), config keys (SC §12.3), `1staid` rows (SC §12.4), audit (SC §12.6), `docs/compute.md`. *Path B
justification for the TypeScript part:* the Settings → Compute page is the web SPA, and the API allow-list rows extend
existing code. **Tests:** CLI JSON
goldens, RBAC matrix, `docs:check`.

### SC9 — Compute harness and worksheet (≈ 2 agent days)

CI job for the two-instance compute suite; owner worksheet: VPS backlog with the MacBook offline > 1 h → primary
fallback; MacBook back → backlog moves; *Pause sharing*.

---

## Effort and gates

| WP | Est. (agent days) | Executor | Language | Gate (no owner answer is pending) |
|---|---|---|---|---|
| RS0 | 2 | **Claude (Sonnet brief)** | Rust | none |
| RS1 | 3 | Claude | Rust | RS0 |
| RS2 | 2.5 | controller's choice | TypeScript (extends the existing core hold) | none |
| RS3 | 4 | Claude | Rust | RS0; dependency record for `ring` (U6); U1 inventory |
| RS4 | 5 | Claude | Rust | RS1, RS2, RS3 |
| RS5 | 1.5 | Claude | Rust | RS4 |
| RS6 | 2 | controller's choice | TypeScript (rows in existing tables) | RS1 |
| RS7 | 5 | Claude | Rust + desktop UI views | D113 WP3/WP4 (WP5 and M3 P1–P3 for *Open*), RS4 |
| RS8 | 1.5 | controller's choice | TypeScript (existing registry) + docs | RS4 |
| RS9 | 1.5 | Claude | CI + worksheet | RS4 |
| SC-S | 2 (+ owner time) | Claude | measurement scripts | none |
| SC0 | 3 (was 2.5) | **Claude** (was controller's choice; Sonnet-suitable) | **Rust** (was TypeScript) | none |
| SC1 | 2.5 | **Claude** (was controller's choice) | **Rust** (was TypeScript) | SC-S results (defaults) |
| SC2 | 4 | Claude | Rust engine (+ wiring in `EngineClient`) | Rust engine progress (RE-03, PR #809); U3 |
| SC3 | 5.5 (was 5) | Claude | **Rust** server side (was TypeScript) + Rust bridge | RS7, M3 pairing, D120 `plur1bus-tools` slot (PR #833) |
| SC4 | 3 | Claude | Rust | SC3 |
| SC5 | 3 | Claude | Rust | SC3; U6 per-OS signals |
| SC6 | 3 (was 2.5) | **Claude** (was controller's choice) | **Rust** + TypeScript wiring (was TypeScript) | SC0 |
| SC7 | 3 | Claude | **Rust** (was TypeScript + Rust CLI) | SC-S results, SC1, SC3 |
| SC8 | 3.5 (was 3) | Claude | **Rust** + web SPA page (was Rust CLI + TypeScript) | SC0, SC6 |
| SC9 | 2 | Claude | CI + worksheet | SC3 |

Total ≈ **28 agent days** for RS0–RS9 (unchanged) and ≈ **34.5** for SC-S–SC9 (was 32.5: the Rust moves of SC0, SC3,
SC6 and SC8 cost 2 days more), **≈ 62.5** together. The first usable promote (CLI, by hand or `--ssh`) still needs
RS0–RS6 (≈ 20 days) and none of D113's unbuilt packages.

## Remaining gates (not owner answers)

All owner questions were decided on 2026-10-31 (PR #825); the gates that waited on Q6 (RS5) and Q12 (RS4) are gone.
What still gates work:

- **Dependencies on other tracks:** D113 WP3/WP4 for RS7, and D113 WP5 with M3 P1–P3 for opening the server in the app;
  M3 pairing for the node bridge (SC3); D120's `plur1bus-tools` module slot for hosting `plur1bus-compute` (SC3; PR
  #833, not merged); the Rust engine's embedding work (RE-03, PR #809) for SC2; WIF WP13 (PR #823) for WIF on the
  server.
- **Spike results (SC-S):** the certificate thresholds τ_min, τ_mean and Δmax (SC1, SC7); go/no-go for the CoreML
  execution provider and for MLX on index-bound jobs (U1, U2, U4); whether the CPU architecture joins the fingerprint
  (U2); deferral and queue defaults from measured throughput and RAM of the 740M model (U7).
- **Unknowns:** the backup inventory (U1) decides RS3's allow-list additions; a compute-only engine mode (RS U7 / SC U3)
  decides whether clients compute in-core; where each channel runs (U8) decides RS1's supervisor gate; cross-platform
  restore (U2) and chain continuity (U3) decide RS4's acceptance; per-OS power/thermal/idle/in-call signals (SC U6)
  bound SC5; the bridge frame size (SC U5) shapes SC3.
- **Process:** the dependency-policy record for `ring` as a direct dependency (RS3, U6) and for any new direct
  dependency of `plur1bus-compute` (`rusqlite`, used today by `plur1bus-engine` and the desktop).

## Open points carried from the specs

- Owner decisions RS §15 Q1–Q14 and SC §16 Q1–Q10 are binding (2026-10-31); Q12 decides B19 for promote targets.
- Unknowns RS §16 U1–U13 and SC §17 U1–U9; U1, RS U7 / SC U3 and SC U2 are the largest risks.
- WIF §12.5 and WP13 live in open PR #823; RS8 adds the pointers after it merges. The language rule cites the D120
  design in open PR #833 (proposed ADR-019).
