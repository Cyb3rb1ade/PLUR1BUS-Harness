# Primary/client role switch and shared compute — implementation plan

**Goal.** An owner moves his one logical PLUR1BUS instance from the MacBook to an SSH host and back, from the desktop
or the CLI alone, with exactly one writer at any time; the other nodes of the cluster share compute with the primary.
Specs: [`2026-10-29-primary-client-role-switch-design.md`](../specs/2026-10-29-primary-client-role-switch-design.md)
("RS spec §n", proposed D118) and [`2026-10-29-shared-compute-design.md`](../specs/2026-10-29-shared-compute-design.md)
("SC spec §n", proposed D119).
**Status.** Draft; owner questions open (RS spec §15, SC spec §16). No product code yet.
**Executor.** Every Rust package (`crates/plur1bus`, `apps/desktop`) is built by a **Claude agent**, never Codex.
TypeScript-only packages: the controller's choice of agent. **RS0 is briefed for a Sonnet agent.**
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
      └─► SC0 queue + placement ─► SC6 privacy/enrolment ─► SC3 node channel (gated: RS7 bridge on remote, M3 pairing)
SC-S spike ─► SC1 fingerprint + verification ─► SC7 certificates          SC2 engine integration (gated: engine)
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

Generalise `packages/core/src/import/maintenance-admission.ts` into a hold with a reason (`import` | `role`); the role
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
`secret set` on stdin (and the portable-backup format for the by-hand path); host-path mapping; pre-commit health
(core `channel.test` credential checks, schedulers, engine); commit-token and receipt files; activation liveness per
channel. Kill-point seam `PLUR1BUS_TEST_ROLE_FAIL_AT=<step>` (only with `PLUR1BUS_ALLOW_TEST_INTERNALS=1`).
**Tests:** `crates/plur1bus/tests/role_two_instances.rs` — two homes on loopback, by-hand driver end to end; after each
kill point assert I1/I2 from both role records and the running units; source sleep between accept and commit; forced
takeover + reconnect → fenced + divergence archive; failback round trip with byte-equal stores; secrets-never-leave
sweep (marker secrets over files, logs, argv recorder, audit). **Acceptance:** Rust gates; system tests on Linux/macOS.

### RS5 — CLI `--ssh` driver (Rust, **Claude agent**) (≈ 1.5 agent days, gated by owner Q6)

`role promote|demote --ssh <user@host> [--port N]`: fixed argv `ssh -T [-p N] -- user@host <fixed command>`, no other
options, bundle on stdin, receipt on stdout (bounded), local commit, remote activate; refuses user/host outside the
D113 charset. **Tests:** a fake `ssh` executable on `PATH` in tests recording argv and replaying a recorded remote; one
job against the D113 OpenSSH container when it exists. **Acceptance:** Rust gates; no secret in recorded argv.

### RS6 — RPC, RBAC, audit, web read (TypeScript + schema) (≈ 2 agent days)

`packages/core/src/rbac/policy.ts` actions `role.read` / `role.manage` (Owner only, `humanOnly`, T3); `RPC_RULES`;
`packages/api/src/rpc-route.ts` adds `role.status` to `WEB_SUPERVISOR_METHODS` only; WebMCP forbidden prefix `role.`;
audit and D111 events of RS §9.5; config keys of RS §9.6 in `config.schema.json`; `docs/rbac.md` rows.
**Tests:** RBAC matrix (agent, Admin, Operator, Owner at T1/T3); WebMCP schema walk; config schema fixtures.

### RS7 — Desktop driver and UI (Rust + TypeScript, **Claude agent**) (≈ 5 agent days, gated by D113 WP3/WP4; *Open* by WP5)

D113 `RemoteCommand`s `RoleStatus`, `RolePreflight`, `ReceiveRoleBundle` (WP4 upload channel), `RoleAccept`,
`RoleActivate`, `RoleDemote`; local supervisor `role.*` calls; wizard (plan → confirm → progress → health → done),
rollback page, connection role chip, tray `RoleLabel` beside `PathLabel` (`tray.rs`), badges per RS §9.3; DS17 bridge
allowed on the SSH connection to the owner's own primary (prerequisite for SC3); DE/EN strings. **Tests:** fixture
russh server + `fake-plur1bus` role scenarios; command charset; Playwright wizard, rollback, tray texts, axe.
**Acceptance:** Desktop Green, `check-i18n`.

### RS8 — Channel fence signal and docs (TypeScript + docs) (≈ 1.5 agent days)

Sustained Telegram `409` (> 5 min) and an overtaken webhook raise `role.channel-conflict` (registry status → `1staid`,
tray, audit); `docs/role-switch.md` (operator page), `docs/cli.md` via `docs:gen`, pointer sections in the D113 spec
(§6.3 commands) and WIF §12.5 when #823 has merged; user-guide DE/EN text as a template in the PR body (agy edits
`docs/user/`). **Tests:** loopback fake Bot API answering `409`.

### RS9 — CI job and owner worksheet (≈ 1.5 agent days)

A `role-two-instances` job (Linux, macOS) for RS4's suite, path-filtered to `crates/plur1bus/src/role/**`, backup and
supervisor code; an owner worksheet (MacBook → Ubuntu VM, Telegram test bot, notebook off for an hour, failback).

---

## Group SC — shared compute (D119)

### SC-S — Runtime spike (Claude agent; scripts) (≈ 2 agent days + owner time)

ONNX CPU vs CoreML EP vs MLX on Apple Silicon against ONNX CPU on the VPS/Ubuntu VM, EmbeddingGemma 2 text (270M, q8)
and full (740M): throughput, RAM, cosine to reference (min/mean/p01), recall@10 parity, arm64 vs x64 CPU drift; check
for an EmbeddingGemma 2 MLX port and the CoreML EP in the pinned onnxruntime-node prebuild (SC U1, U2, U4, U7).
Result: `docs/handoff/status/<date>-compute-spike.md` with proposed τ values and go/no-go per backend.

### SC0 — Job queue and placement (TypeScript, pure) (≈ 2.5 agent days)

`packages/core/src/compute/{classes,queue,placement}.ts`: class table (SC §5.1) from config, queue state machine
(SC §5.3) over an injected store interface and clock, placement (SC §5.2) as a pure function of jobs, node snapshots
and policy; `state/compute.sqlite` adapter behind the interface. **Tests:** deferral by node absence (59 min vs 61
min), age cap, re-embed `wait`, node return mid-backlog, lease expiry requeue, max attempts, cancellation, paused queue
outside writer roles. Second-best Sonnet candidate (pure, not blocked).

### SC1 — Fingerprint fields and result verification (TypeScript + engine schema) (≈ 2.5 agent days, after SC-S for defaults)

`encoders`, `runtimeFamily`, `precision` as additive identity fields with the compatibility default (SC §7.1); the
producer check and the primary's result verification (dimension, norm, NaN, stale, duplicate, spot check) as pure
functions; engine contract schema additions proposed in the engine repo. **Tests:** comparison table; legacy identity
equals its explicit form; every rejection reason.

### SC2 — Engine integration (engine repository / Rust engine; Claude agent for Rust) (≈ 4 agent days, gated by the engine)

Per-item `embedding: pending` marker with FTS-only recall, external vector commit under a fingerprint, compute-only
`embed()` without opening stores (SC U3, RS U7). Harness adapter in `packages/core/src/engine/`. **Tests:** engine
contract tests; harness adapter tests with the fake engine.

### SC3 — Node channel and lease protocol (TypeScript API/core + Rust desktop bridge, **Claude agent** for Rust) (≈ 5 agent days, gated by RS7 and M3 pairing)

Worker methods (SC §8.1) on the D51 b/DS17 socket, scope `compute.serve`, chunked binary frames (SC U5), blob route,
leases, idempotent commit, cancellation, back-pressure; desktop carrier relays to the bundled core over its local
socket. **Tests:** two-instance harness with a fake node: redelivery with one commit, cancellation mid-batch, partial
completion, fenced primary stops leasing, node follows the higher epoch.

### SC4 — `plur1bus node run` (Rust, **Claude agent**) (≈ 3 agent days, after SC3)

D51 b CLI carrier for headless nodes (`tailnet`/`network` primaries, SC Q9); announces D112-discovered local servers and
in-core identities; relays chat (D51) and compute. **Tests:** loopback primary fixture; reconnect with backoff; epoch.

### SC5 — Node conditions and tray (Rust desktop, **Claude agent**) (≈ 3 agent days, after SC3)

Power, thermal, idle, in-call probes per OS where available (SC U6), limits, *Pause sharing* menu and tray texts
(SC §12.5), `plur1bus compute pause|resume` on the node. **Tests:** conditions table with injected probes; tray texts.

### SC6 — Privacy, enrolment, licences, local-only node rule (TypeScript) (≈ 2.5 agent days)

D116 filter (SC §10.2), `compute.node.enroll|remove|limits.set` (Owner, `humanOnly`, T3), device grant `compute.serve`,
per-device NC licence check, `local-only.ts` cluster rule (RS Q7). **Tests:** household fixture (Owner, Eva) with all
levels; RBAC matrix; local-only refusals.

### SC7 — Equivalence certificates (TypeScript + Rust CLI, **Claude agent** for Rust) (≈ 3 agent days, after SC-S, SC1, SC3)

`plur1bus compute certify`, calibration set shipped with the release, thresholds from SC-S, recall@10 parity on the
store's benchmark, expiry on any identity change. **Tests:** pass, fail, expiry, a perturbed backend refused.

### SC8 — Surfaces (Rust CLI + TypeScript, **Claude agent** for Rust) (≈ 3 agent days)

`plur1bus compute status|nodes|jobs|node …`, RPC and RBAC (SC §12.2), config keys (SC §12.3), `1staid` rows (SC §12.4),
audit (SC §12.6), Settings → Compute page (read + Owner actions with step-up), `docs/compute.md`. **Tests:** CLI JSON
goldens, RBAC matrix, `docs:check`.

### SC9 — Compute harness and worksheet (≈ 2 agent days)

CI job for the two-instance compute suite; owner worksheet: VPS backlog with the MacBook offline > 1 h → primary
fallback; MacBook back → backlog moves; *Pause sharing*.

---

## Effort and gates

| WP | Est. (agent days) | Executor | Gate |
|---|---|---|---|
| RS0 | 2 | **Claude (Sonnet brief)** | none |
| RS1 | 3 | Claude | RS0 |
| RS2 | 2.5 | controller's choice | none |
| RS3 | 4 | Claude | RS0; dependency record for `ring` |
| RS4 | 5 | Claude | RS1, RS2, RS3; Q12 for headless targets |
| RS5 | 1.5 | Claude | RS4, Q6 |
| RS6 | 2 | controller's choice | RS1 |
| RS7 | 5 | Claude | D113 WP3/WP4 (WP5 for *Open*), RS4 |
| RS8 | 1.5 | controller's choice | RS4 |
| RS9 | 1.5 | Claude | RS4 |
| SC-S | 2 (+ owner time) | Claude | none |
| SC0 | 2.5 | controller's choice (Sonnet-suitable) | none |
| SC1 | 2.5 | controller's choice | SC-S |
| SC2 | 4 | Claude for Rust engine parts | engine repository |
| SC3 | 5 | Claude | RS7, M3 pairing |
| SC4 | 3 | Claude | SC3 |
| SC5 | 3 | Claude | SC3 |
| SC6 | 2.5 | controller's choice | SC0 |
| SC7 | 3 | Claude | SC-S, SC1, SC3 |
| SC8 | 3 | Claude | SC0, SC6 |
| SC9 | 2 | Claude | SC3 |

Total ≈ **28 agent days** for RS0–RS9 and ≈ **32.5** for SC-S–SC9, **≈ 60.5** together. The first usable promote (CLI,
by hand or `--ssh`) needs RS0–RS6 (≈ 20 days) and none of D113's unbuilt packages.

## Open points carried from the specs

- Owner questions RS §15 Q1–Q14 and SC §16 Q1–Q10; B19 (Q12) decides headless targets.
- Unknowns RS §16 U1–U13 and SC §17 U1–U9; U1, U7/SC U3 and SC U2 are the largest risks.
- WIF §12.5 and WP13 live in open PR #823; RS8 adds the pointers after it merges.
