# RE-07 — Memory and admin operations, snapshot, tombstones, re-embedding, models

**Package.** Every contract member a person reaches through the CLI, the API or the web UI rather than through a turn:
`MemoryOps` (13 methods plus the A1 curation members), `AdminOps` (including `reembedding.validate`, contract 1.17.0), `StoreOps::adopt`, `status()`, `system_supplement()`,
`models()`, the store snapshot and its verification, the tombstone re-apply the harness restore has waited for, and
the re-embedding migration. Size L; seven tasks, one pull request each (T7 optional, owner-gated).

**Depends on.** RE-02, RE-03, RE-04 T1 (`RequestContext`). **Enables.** RE-06 (jobs call `forget`/`share` internals),
RE-10 (the core paths that move here).

**Assumes.** RE-D3, RE-D6 (curation ops in scope).

**Read first.**
- Plan §1.3 (the private imports that become methods: `lib/snapshot/store-snapshot.js`, `lib/tombstone-reapply.js`,
  `lib/reembedding/*`, `lib/providers/config-normalize.js`), RE-7 in §4, `docs/embedding-migration.md`,
  `docs/curation.md`, `docs/identity.md` (rebind), `docs/import.md` §10.6 (backfill/rebind).
- Engine at the harness pin `9f34008c` (= `98dfe2f0` for every file below; the pin adds only the `validate` facade in `engine/create-engine.js`, and the coordinator logic it calls is already in `lib/reembedding/coordinator.js`):

| Area | Files | Lines |
|---|---|---|
| memory ops | `engine/memory-ops/read.js`, `write.js`, `shared.js`, `proposals.js`, `proposal-store.js`, `import.js`, `import-ledger.js`, `import-lock.js`, `rebind.js`, `rebind-ledger.js`, `unimport.js`, `unimport-ledger.js`, `link.js`, `link-ledger.js` | 329 + 302 + 220 + 418 + 243 + 603 + 226 + 213 + 352 + 475 + 621 + 198 + 237 + 201 |
| shares and policy | `lib/shared-memory.js`, `lib/shared-memory-pool.js`, `lib/shared-memory-migration.js`, `lib/workspace-policy.js`, `lib/workspace-policy-guard.js` | 386 + 446 + 1,174 + 194 + 114 |
| forget | `lib/tombstone.js` (the registry a forget writes; `state/_tombstones` is harness-owned per AGENTS.md's backup notes — read both) | 595 |
| adopt, status, supplement | `engine/stores/adopt.js`, `engine/status/status-reporter.js`, `engine/recall/system-supplement.js` | 635 + 168 + — |
| snapshot | `lib/snapshot/store-snapshot.js` (`createSnapshot`, `verifySnapshot`, `SnapshotError`) | 815 |
| tombstone re-apply | **does not exist on `main`** (AGENTS.md: KNOWN GAP); the harness side is `packages/core/src/restore-reapply.ts` (`ENGINE_REAPPLY_MODULE`, what it imports and calls — read lines 1–80) | — |
| re-embedding | `lib/reembedding/planner.js`, `coordinator.js`, `state-store.js`, `lance-backend.js`, `generation-layout.js`, `switch-runtime.js`, `runtime-probe.js`, `confirmation.js`, `runtime-config.js`, `fingerprint.js` | 197 + 364 + 331 + 559 + 85 + 230 + 121 + 75 + 181 + 157 |
| obsidian | `engine/admin/obsidian.js` (detect/prepare/confirm), `lib/obsidian/*` (29 files, vault writers) | 301 + 3,517 |
| curation (A1) | branch `codex/gp3-a1-curated-memory` tip `9b935ce1` (labelled 1.17.0 there, a number the pin already uses; renumbered on merge): `git diff 98dfe2f..9b935ce -- engine lib types` | — |

  Not ported: `engine/commands/*` (1,663 — the OpenClaw chat command bodies), `engine/tools/memory-tools.js` (957 —
  tool specs for the OpenClaw agent); the harness has its own tool layer.
- Harness callers to keep green: `crates/plur1bus/src/commands/memory_ops.rs` and its tests, `tests/system/memory-ops.test.ts`,
  `tests/system/backup.test.ts`, `portable-backup.test.ts`, `reembed.test.ts`, `identity.test.ts`, `admin.test.ts`,
  `packages/core/src/backup-ops.ts`, `restore-reapply.ts`, `embedding-migrate/*`, `admin-ops.ts`, the `memory.curation.*`
  handlers in `packages/core/src` (search the RPC method names), `packages/rpc-schema/schema/rpc.schema.json` for every
  `memory.*`, `admin.*` result shape (ruling R13: `--json` prints the raw value, so the shapes must not drift).

**Rules that apply.** Every op takes `(principal, agent)` last and authorises through `RequestContext` before touching
a row; a forgotten id never returns from any read (tombstone first). Ledgers are append-only with the Node line
shapes (RE-02 `JsonlLedger`). Import, rebind, unimport and link are idempotent by their `idempotencyKey` and support
`dryRun`.

**Modules added by the 2026-10-23 audit** (rows owned by RE-07 in [`MODULE-MAP.md`](MODULE-MAP.md)). T1: `lib/curation-resolve.js`;
the archive directory is `<state_dir>/memory/_archive` — the host override `HostCapabilities.memoryArchiveDir` (used by
`engine/memory-ops/context.js:20`) is dropped. T4: `lib/health-watch.js` (274 — two signal sources the health scan cannot see)
and `engine/store/control-health.js` feed `engine.status`. T6: `host.mutateConfig` (used by `lib/reembedding/runtime-config.js`)
has no Rust counterpart — `switch` returns the config patch and the core applies it through the supervisor's `config.set`,
as `packages/core/src/embedding-migrate/switch.ts` does today. T7: `lib/obsidian-bridge.js` (2,359 — the vault bridge, T7b),
`lib/obsidian-mutation-policy.js` (396), `lib/obsidian-vault-authority.js` (136), `lib/obsidian-vault-confirmation-flow.js` (151 —
T7a's `confirm` uses it), `lib/obsidian-review-authority.js` (220) and the 30 files under `lib/obsidian/` are the owner-gated
rows (`decide`). Not ported: `lib/obsidian-control-room.js` (4,006 — the adapter's review flows and chat UI; the morning and
evening reviews are not Phase 1 engine jobs; their digest half becomes RE-13 T3 in Phase 2, the vault-change half stays
T7b), `lib/security.js` (chat auth/ACL — the owner
gate is the core's RBAC, the engine receives the caller principal), `lib/memory-doctor.js` (reachable only through the chat
commands).

## Files

- Create: `src/ops/{mod,memory,curation,shares,proposals,import,rebind,unimport,link,ledgers,admin,workspace_policy,
  adopt,status,supplement,models,snapshot,tombstones,reembedding/{mod,planner,coordinator,state,backend,switch,probe,confirm},
  obsidian/{mod,detect,prepare,confirm}}.rs`, `tests/ops_memory.rs`, `tests/ops_shares.rs`, `tests/ops_import.rs`,
  `tests/ops_adopt_status.rs`, `tests/ops_snapshot.rs`, `tests/ops_reembedding.rs`, `tests/ops_obsidian.rs`,
  `tests/fixtures/ops/{record.mjs,golden/*.json,snapshots/*}`
- Modify: `src/lib.rs`, `docs/engine-stores.md` (ledger lines), `docs/embedding-migration.md` (engine side in Rust)
- Test: the seven Rust test files and the fixtures

## Interfaces

**Consumes:** RE-01 `MemoryOps`, `AdminOps`, `StoreOps`, every `Memory*`/`Obsidian*`/`Migration*` type, `EngineStatus`;
RE-02 `Store`, `JsonlLedger`, `StateFile`, `JobLock`, `schema_version`, `identity_status`; RE-03 `identity_id`,
`fingerprint_id`, `normalize_embedding_config`, `EmbeddingProvider`; RE-04 `RequestContext`.

**Produces:** the implementations of `MemoryOps`, `AdminOps`, `StoreOps` plus:

```rust
// src/ops/snapshot.rs — replaces lib/snapshot/store-snapshot.js for packages/core/src/backup-ops.ts
pub fn create_snapshot(stores: &dyn StoreRoutes, out: &Path, cancel: &Cancel) -> Result<SnapshotManifest, SnapshotError>;
pub fn verify_snapshot(dir: &Path) -> Result<SnapshotReport, SnapshotError>;   // same report fields the Node function returns

// src/ops/tombstones.rs — closes the KNOWN GAP of restore-reapply.ts
pub fn reapply(stores: &dyn StoreRoutes, registry: &Path /* state/_tombstones */, cancel: &Cancel) -> Result<ReapplyReport, EngineError>;
// ReapplyReport { examined, archived, already_archived, missing }

// src/ops/reembedding/mod.rs — AdminOps::reembedding
pub fn plan(..) -> Result<ReembedPlan, EngineError>; pub fn apply(..); pub fn resume(..); pub fn validate(..); pub fn rollback(..); pub fn status(..); pub fn switch(..);
// validate (1.17.0, types/engine.d.ts AdminOps.reembedding): moves a fully copied migration from `validating` to `ready_to_switch`
// after the target generation check and the semantic recall probe; on failure it rejects and the record stays `validating`.
// The core calls it through packages/core/src/embedding-migrate/engine-port.ts:55-70; without it the harness migration stops in `validating`.
// the checkpoint file shape of lib/reembedding/state-store.js is kept so a migration started by the Node engine can be resumed by this one

// src/ops/models.rs
pub fn models(config: &EngineConfig, readiness: &dyn ModelsService) -> Vec<ModelInfo>;  // exactly the configured embedding and reranker identities with licence id and artifact status (CP-4b)
```

## Tasks

### T1 — Read ops, forget, correct, state, curation (one pull request)

- [ ] **Step 1: goldens** `record.mjs --read`: `list` (topic, since/until, limit, truncated), `show`, `state`
  (counts per scope, tombstones, archive dir), `forget` (tombstone id, `alreadyForgotten`), `correct` (archived: true and
  the successor row), and for A1 `curation.list/keep/drop` recorded from a `9b935ce1` build.
- [ ] **Step 2: failing tests** `tests/ops_memory.rs`: one per golden; `a_forgotten_id_never_returns_from_list_show_or_recall`;
  `a_principal_without_access_gets_the_memory_op_error_code_the_node_engine_returns` (`MemoryOpErrorCode` parity: record
  the codes per case).
- [ ] **Step 3: implement** `memory.rs`, `curation.rs`, the tombstone write through `lib/tombstone.js`'s format; the archive
  directory is fixed to `<state_dir>/memory/_archive` (no host override).
- [ ] **Step 4: commit** `RE-07/T1: read ops, forget, correct, state, curation`.

### T2 — Shares, proposals, workspace policy, admin share/forget (one pull request)

- [ ] **Step 1: goldens** `record.mjs --shares`: `share` to workspace and user (with and without `allowSensitive`;
  the sensitive gate `sensitiveSharedMemoryReason` at `lib/shared-memory.js:164` — f.10 notes it is duplicated in the adapter; port it once),
  `propose`, `proposals.list/accept/reject`, `admin.workspacePolicy.get/list/set`, `admin.share`, `admin.forget`.
- [ ] **Step 2: failing tests** `tests/ops_shares.rs`: one per golden plus `a_sensitive_share_is_refused_without_allow_sensitive`,
  `a_stale_proposal_is_reported_stale_and_cannot_be_accepted`, `proposal_events_are_emitted_through_the_host`.
- [ ] **Step 3: implement**; the shared pool migration (`shared-memory-migration.js`, 1,174 lines) is ported only as far
  as `admin.migrate` needs it (T4 decides the schema-version steps it covers; list what is left out in the PR).
- [ ] **Step 4: commit** `RE-07/T2: shares, proposals, workspace policy`.

### T3 — Import, rebind, unbind, unimport, link with ledgers (one pull request)

- [ ] **Step 1: goldens** `record.mjs --import`: an import run (dry run and apply), its ledger, a rebind by identity
  (`docs/identity.md`), its unbind, an unimport, a link and the three outcomes (`linked`, `already-linked`,
  `already-source`); the import lock refusing a concurrent run.
- [ ] **Step 2: failing tests** `tests/ops_import.rs`: one per golden; `the_same_idempotency_key_is_a_no_op`;
  `dry_run_writes_no_row_and_no_ledger_line`; `the_import_lock_is_a_job_lock_with_process_identity` (RE-02).
- [ ] **Step 3: implement**; the harness importer (`packages/core/src/import/`) keeps calling these through the
  contract — run `crates/plur1bus/tests/import.rs` after RE-08 wires the client.
- [ ] **Step 4: commit** `RE-07/T3: import, rebind, unbind, unimport, link`.

### T4 — Adopt, status, system supplement, migrate, models (one pull request)

- [ ] **Step 1: failing tests** `tests/ops_adopt_status.rs`: `adopt_reports_schema_version_identity_and_counts_as_the_node_report`
  (golden over the RE-02 fixture and over a legacy "0" store the recorder makes), `status_has_every_field_of_core_status_engine`
  (`packages/rpc-schema` `core.status.engine` shape — the core copies the engine status into it), `system_supplement_is_byte_identical`,
  `migrate_0_to_1_applies_once_and_reports_applied_false_the_second_time`, `models_lists_exactly_the_configured_identities_with_licence_and_artifact_status`.
- [ ] **Step 2: implement** `adopt.rs`, `status.rs` (with the signal sources of `lib/health-watch.js` and `engine/store/control-health.js`),
  `supplement.rs`, `admin.rs::migrate`, `models.rs`.
- [ ] **Step 3: commit** `RE-07/T4: adopt, status, supplement, migrate, models`.

### T5 — Snapshot, verify, tombstone re-apply (one pull request)

- [ ] **Step 1: fixtures** `tests/fixtures/ops/snapshots/`: a snapshot the Node `createSnapshot` wrote from the RE-02
  fixture, and its `verifySnapshot` report.
- [ ] **Step 2: failing tests** `tests/ops_snapshot.rs`: `rust_verifies_the_node_snapshot_and_node_verifies_the_rust_snapshot`
  (through `tests/node/roundtrip-check.mjs --snapshot`), `verify_reports_a_tampered_file`, `reapply_archives_every_registered_tombstone_once`
  (a restored store with three rows whose ids are in `state/_tombstones`), `reapply_is_idempotent`.
- [ ] **Step 3: implement**; then change `packages/core/src/restore-reapply.ts` to call the engine method through the
  contract once RE-08's client exists (track it as a follow-up line in the PR if RE-08 is not merged yet; the Node path
  keeps working until then).
- [ ] **Step 4: commit** `RE-07/T5: snapshot, verify, tombstone re-apply`.

### T6 — Re-embedding migration (one pull request)

- [ ] **Step 1: goldens** `record.mjs --reembed`: a plan for a 384→1536 switch, the state file after `apply` on a
- [ ] **Step 1: goldens.** `record.mjs --reembed` records:
  - a plan for a 384→1536 switch;
  - the state file after `apply` on a 12-row store interrupted after 6 rows;
  - `resume`;
  - `validate` in three cases: success moves to `ready_to_switch`; a failed recall probe rejects and the record stays
    `validating`; an empty source table validates on the generation check alone;
  - `status`, `rollback` and `switch`;
  - the generation layout on disk (`generation-layout.js`).
  12-row store interrupted after 6 rows, `resume`, `status`, `rollback`, `switch`; the generation layout on disk
  (`generation-layout.js`).
- [ ] **Step 2: failing tests** `tests/ops_reembedding.rs`: one per golden; `a_migration_started_by_the_node_engine_resumes_in_rust`
  (the state file is the fixture); `fingerprint_ids_in_the_plan_equal_the_node_plan` (RE-03 T1).
- [ ] **Step 3: implement** `reembedding/*`; `switch` returns the config patch (the `embedding.*` keys) instead of writing it,
  the core applies it through the supervisor's `config.set`; `tests/system/reembed.test.ts` is the acceptance after RE-08.
  the core applies it through the supervisor's `config.set`; `tests/system/reembed.test.ts` is the acceptance after RE-08 (it now reaches `switched` end to end through `plur1bus config set` and runs in the `system` job).
- [ ] **Step 4: commit** `RE-07/T6: re-embedding migration`.

### T7 — Obsidian: detect/prepare/confirm, and the vault bridge (owner-gated; one pull request each)

- [ ] **T7a (in scope):** `admin.obsidian.detect/prepare/confirm` from `engine/admin/obsidian.js` with
  `tests/ops_obsidian.rs` (`detect_lists_config_workspace_and_candidate_vaults`, `prepare_issues_a_nonce_bound_to_the_vault_digest`,
  `confirm_refuses_an_expired_or_foreign_nonce`, `a_confirmed_vault_is_already_confirmed_the_second_time`);
  `tests/system/admin.test.ts` is the acceptance.
- [ ] **T7b (owner decides):** the vault writers (`lib/obsidian/*`, 3,517 lines: note writer, graph links, dashboards,
  bases, tasks, weekly synthesis, record index) — a separate brief if the owner wants them in Phase 1; otherwise the
  jobs that call them report their vault step as `skipped: "obsidian-bridge-not-ported"` in `counts`.

## Acceptance

- `crates/plur1bus/tests` memory, import, backup and reembed suites and `tests/system/{memory-ops,backup,portable-backup,
  reembed,identity,admin}.test.ts` pass with `PLUR1BUS_ENGINE_IMPL=rust` after RE-08; until then every golden test here
  is green and the PR says so.
- The `--json` shapes of `plur1bus memory …` and `plur1bus admin …` are unchanged (compare against the Node engine's
  output in the parity runner, RE-09).
- `restore-reapply.ts`'s KNOWN GAP line in AGENTS.md is removed in the PR that wires T5 into the core.

## Out of scope

The harness-side RPC handlers and RBAC (unchanged; RE-10 moves logic, not the front door); the OpenClaw command and
tool bodies; the vault writers unless the owner takes T7b.

## Hand-off

Seven PRs; T1 first (RE-06 depends on forget/share internals), T5 and T6 can run in parallel with T2–T4. Record every
golden through `record.mjs` with the documented flags.
