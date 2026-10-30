# M v2 Import Maintenance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans for the assigned worker lane; the parent coordinates the native supervisor, schema, remote-fs and UI lanes. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run a fully checked GUI import under the supervisor with durable, complete rollback and metadata-only progress.

**Architecture:** Core plans and preflights a sealed local source while running. After Core exits, the private worker takes both import/core locks, snapshots every authenticated mutation root, journals before mutations, and executes the existing importer through injected ports. The supervisor alone owns configuration writes and process restart; failure or GUI abort restores the cold baseline before restart.

**Tech Stack:** Existing Node 24/Rust 1.95 workspace, existing Engine ports, Secret Store, package-store transaction ports and `@plur1bus/remote-fs`; no Engine changes or new worker dependencies.

**Spec:** [M v2 parent plan](2026-10-28-extensions-import-m-v2.md), [import mapping](../../import.md), ADR-013 §5, ADR-016.

## Global Constraints

- Existing CLI `--json` and report shapes stay unchanged; supervised control and receipts use new private sidecars.
- Every source read goes through the six-method asynchronous `ReadonlyFs`; maintenance consumes a sealed local snapshot.
- Progress, journals, worker stdout and public RPC carry no credential values or imported content.
- Only Owner opts into allowlisted secret migration. Existing target secrets are skipped; no implicit overwrite or plaintext undo preimage.
- Full coverage and exclusive ownership of configured external target roots are required before Core stops.
- Configuration is validated and written/restored by the supervisor; standalone CLI retains its existing direct-file fallback.
- GUI abort restores the baseline and resets applied receipts for resume. Existing standalone CLI behavior stays compatible.
- Manual rollback refuses changes made after commit during preflight; a backup does not authorize discarding later work.

## Review Focus

- A backend or consumer never resolves: cancellation and Core shutdown still complete, late credentials are revoked.
- A crash follows a mutation but precedes its receipt: durable intent and cold recovery restore the complete baseline.
- A custom store, linked target or live secondary writer falls outside snapshot coverage: preflight refuses before stopping Core.
- A source/config/target changes after confirmation: immutable-source hashes, config revision and committed-target fingerprints refuse stale work.
- A secret is created immediately before a crash: absent-before intent permits only this run's newly created name to be deleted; no value appears in a journal.

### C worker foundation: journal and cold snapshot

**Files:** new `packages/core/src/import/maintenance-{types,journal,snapshot}.ts`; tests under `packages/core/test/import/maintenance-*.test.ts`.

**Interfaces:** journal records bounded phases/attempts/hashes and missing-only secret intents. Cold snapshot consumes authenticated mutation roots, preserves audit/API/run/lock paths, verifies copied file hashes and restores through a replayable journal. Config snapshot bytes are restored only by the private `config.restore` host port.

- [ ] Write real filesystem tests for phase persistence, invalid transitions/paths, complete store/card restore, added/deleted files, absent roots, exclusions, tampered snapshots and interrupted restore.
- [ ] Observe red, implement each boundary, then run the focused tests green.
- [ ] Verify restoration precedes reset of legacy applied ledger and `extensions.json`; preserve attempt history and the source plan.

### C1/C2/C6: existing importer ports

**Files:** existing `importers/{openclaw,hermes}.ts`, entity helpers, `skills-import.ts`, `source.ts`, source adapters and `snapshot.ts`; new progress/config/secret adapters.

**Interfaces:** optional `onProgress`, `signal`, configuration reader/writer/validator, store-probe injection and A13 `ImportedExtensionPort`. Root's `ReadonlyFs` has only asynchronous stat/lstat/readdir/readFile(maxBytes)/realpath/readlink.

- [ ] Write red tests for entity-boundary cancellation, unchanged legacy report envelopes, supervisor-only config writes, live-Core probe injection and missing-only allowlisted secrets with durable intent/readback.
- [ ] Implement hooks at agent/skill/store/card-batch boundaries; no second target Engine owner during live preflight.
- [ ] Adapt source detection/snapshot reads to `ReadonlyFs`; retain existing snapshot integrity, SQLite/LanceDB consistency and credential omissions.
- [ ] Run complete importer regression tests; no skip or weakened assertion.

### C3/C4/C5: service, preflight and private worker

**Files:** new `maintenance-preflight.ts`, `maintenance-worker.ts`, `worker-port.ts`; extend `import-bin.ts` only with a private supervised mode.

**Interfaces:** initial bounded stdin `{v:1,runId,mode,plan,home,...}`; stdout lines at most 64 KiB tagged `progress`, `request`, `result`. Requests are only `config.get`, `config.set` with minimal nonsecret changes/dryRun, and `config.restore {sha256}` at the native fixed snapshot path. Replies arrive on private stdin. Results reference the fixed report file by hash/size instead of emitting an unbounded legacy report.

- [ ] Write red preflight tests collecting source/conflict/parse/config/space/permission/lock/schema/model/licence/secret-backend failures; none requests maintenance stop.
- [ ] Implement immutable plan checks and a downtime estimate, then worker lock/snapshot/journal/apply/close/restore ordering.
- [ ] Write crash/abort/recovery tests, including a real Engine card import restored from cold bytes and subsequent resume.
- [ ] Integrate parent-owned supervisor/RPC/RBAC/schema ports and system tests; run leak tests over every new result/event/control envelope.

### Verification and task boundaries

- [ ] Run focused red/green commands, record long outputs in `/workspace/m-logs/`, then run all importer tests and shared typecheck.
- [ ] Parent runs actual-supervisor system apply/progress/rollback/failure-recovery tests and repository-wide gates.
- [ ] Parent stages one commit per M task after the shared integration checkpoint; this worker does not stage or commit independently.
