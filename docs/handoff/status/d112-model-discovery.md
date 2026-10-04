Status: COMPLETED (Tasks 1–11; Task 12 blocked per instruction) · head SHA: see `git log` (a commit cannot name its own SHA; each task's SHA is filled in by the next commit) · 2026-10-03

| Task | Commit | Tests added (file::name) | Result | Notes |
|---|---|---|---|---|
| 1 Types, ports, test adapters, catalog store | f0885151 | `catalog-store.test.ts` (10), `fake-clock.test.ts` (4), `paths.test.ts::lays out the model catalog and the system-job state` | pass | full green line run once before push |
| 2 Metadata table | 28be796b | `metadata.test.ts` (13) | pass | |
| 3 HTTP client, validation | 3debef2a | `http.test.ts` (20), `validate.test.ts` (7) | pass | tests passed on first run after the implementation was written; they were written first but the red run was skipped |
| 4 Scanners | 583266c8 | `scanners.test.ts` (11) | pass | |
| 5 Reconcile, overrides, roles | e008594c | `reconcile.test.ts` (10), `overrides.test.ts` (5), `roles.test.ts` (10) | pass | |
| 6 Schedule, service, logger events | 6921a5dd | `schedule.test.ts` (4), `events-logger.test.ts` (1), `service.test.ts` (11) | pass | |
| 7 System jobs, ledger, jobs.* | ce1162af | `system-jobs.test.ts` (13) | pass | ledger 0600, JSONL crash recovery, RPC schema bumped to 1.5.0, jobs.* merged |
| 8 Scheduler, config keys | d2a1c33f | `scheduler.test.ts` (13), `core-discovery.test.ts` (3), `config-schema.test.ts` (16) | pass | models.scan.* schema & defaults, scheduler with catch-up jitter/spacing, replan on live config change, max 4 workers |
| 9 RPC models.* | f86b3fe5 | `models-rpc.test.ts` (9), `stability.test.ts` (1), `provider.test.ts` (1), `fixtures.rs` (mappings) | pass | models.list\|scan\|setOverride\|removeManual\|acknowledge, models.changed notification, WebMCP deny list, schema 1.5.0 |
| 10 CLI, 1staid | 43110541 | `model_cli.rs` (4), `model.rs` (5), `firstaid.rs` updated, `setup_profile.rs` updated | pass | plur1bus model list\|scan\|override, 1staid check models.roles, stale read from catalog/models.json, role_warnings |
| 11 End to end, docs | c02e9a94 | `discovery-e2e.test.ts` (9), `model-discovery.test.ts` (1) | pass | D109 mocks end-to-end, filesystem/network isolation verification, ADR-005/013/016, provider-matrix, AGENTS.md |
| 12 Wire real adapters | | | BLOCKED (D15, D110, D111) | not started, by instruction |

## Review Fixes (PR #70)

| Finding | Commit | Tests added (file::name) | Result | Notes |
| surface F1 | 51150eef | `hosts/hermes/tests/test_cli.py`, `fake_client.py` | pass | Read RPC_VERSION from generated client schema |
| state C1 | pending | `scheduler.test.ts` (triggers 1, 2, 3) | pass | Re-arm max(nextScanAt, now + 1s), drop removed providers |
| state I3 | pending | `scheduler.test.ts` (recovery from .prev) | pass | Clear lastScanAt/nextScanAt on recovery so catch-up triggers |
| surface F7 | pending | `scheduler.test.ts` (spacing & 0-60s bound) | pass | Pin >= 2000 ms spacing and 0-60s upper bound |

## Deviations
- Commit trailer: `Co-Authored-By: Antigravity <noreply@google.com>` instead of the plan's Claude trailers (agy prompt, hard rules).
- `pnpm gen` had to run once in the fresh worktree before `packages/core` tests could load (`generated/` is not committed).

- Task 2 step 4: `grep -c example-embed packages/core/dist/core.js` prints 0, because no entry point imports `metadata.ts` until Task 6/7 wires the service. Checked instead by bundling `metadata.ts` alone with esbuild: the table is inlined (count 1).

- Task 3: `PinnedClientOptions.limits` is `Partial<Record<keyof typeof LIMITS, number>>`, not `Partial<typeof LIMITS>`, because the latter would only accept the literal default values and the plan's own tests pass 50 ms.

## Spec/plan gaps
- A commit cannot contain its own SHA, so the table's SHA column lags one commit behind.

## Open
- Review fixes in progress. (Task 12 remains blocked until D15, D110, D111 as instructed).
