Status: COMPLETED (Tasks 1–11; Task 12 blocked per instruction; Review fixes round 3 completed) · head SHA: see `git log` · 2026-10-04

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
|---|---|---|---|---|
| surface F1 | 51150eef | `hosts/hermes/tests/test_cli.py`, `fake_client.py` | pass | Read RPC_VERSION from generated client schema |
| state C1 | e2d292d2 | `scheduler.test.ts` (triggers 1, 2, 3) | pass | Re-arm max(nextScanAt, now + 1s), drop removed providers |
| state I3 | e2d292d2 | `scheduler.test.ts` (recovery from .prev) | pass | Clear lastScanAt/nextScanAt on recovery so catch-up triggers |
| surface F7 | e2d292d2 | `scheduler.test.ts` (spacing & 0-60s bound) | pass | Pin >= 2000 ms spacing and 0-60s upper bound. Mutated code locally: without spacing/bound, tests fail. |
| state I1 | e8308ea9 | `service.test.ts` (concurrent scan lock, override vs scan lock) | pass | Mutate runs inside store lock, no lost updates |
| state I2 | e8308ea9 | `service.test.ts` (manual scan replans timer, auth backoff preserved) | pass | Manual scan respects auth-failed slot; explicit person action allowed but does not reset auth backoff |
| state I4 | e8308ea9 | `service.test.ts` (replan store.mutate caught, state preserved) | pass | Await store.mutate promise, keep backoff and auth state across replan |
| state I8 / security M3 | e8308ea9 | `service.test.ts`, `job.test.ts` (shutdown abort outcome: aborted) | pass | Shutdown/cancel abort is not an error; ledger row recorded as aborted, lastResult unchanged |
| security I1 | e8308ea9 | `service.test.ts` (canary redaction on throwing resolver) | pass | Non-ScanError maps to internal_error, err.message redacted |
| security I2 | e8308ea9 | `http.test.ts` (baseUrl validation before credential resolve) | pass | Validate URL before resolving credentials, malformed -> failed:invalid / invalid_base_url |
| security M1 | e8308ea9 | `http.test.ts` (Location with userinfo -> failed:invalid) | pass | Never follow redirect with userinfo |
| security M2 | e8308ea9 | `validate.test.ts`, `scanners.test.ts` (cursor validation <= 512B) | pass | Cursors validated in URLSearchParams only |
| security M4 | e8308ea9 | `service.test.ts` (credential-unavailable distinct reason) | pass | Distinct reason credential_unavailable, no fake 401 |
| security M5 | e8308ea9 | `http.test.ts` (localhost loopback check on all addresses) | pass | Strict loopback DNS resolution check |
| security M7 | e8308ea9 | `http.test.ts` (connect timer cleared on abort) | pass | Clear connect timer on abort |
| security M8 | e8308ea9 | `http.test.ts` (deflate, br, compression bombs) | pass | zlib deflate and brotli with 1 MiB cap |
| security M10 | e8308ea9 | `validate.test.ts` (Number.isSafeInteger for limits/offsets) | pass | Require safe integer in validation |
| surface F6 | e8308ea9 | `service.test.ts` (failed/empty scan leaves non-empty catalog byte-identical) | pass | Mutated code locally: without check, test fails. |
| surface F11 | e8308ea9 | `system-jobs.test.ts` (jobs.list real intervalHours in schedule.every) | pass | Dynamic interval reflected in jobs.list |
| state I5 / surface F3 | 5a073ecf | `core.test.ts` (reenrichCatalog on revision mismatch) | pass | Boot re-enrichment when shipped tableRevision differs |
| state I6 | 5a073ecf | `system-jobs.test.ts`, `catalog-store.test.ts` (securePath result check) | pass | Fail closed on securePath failure, run once per file |
| state I7 | 5a073ecf | `system-jobs.test.ts` (rotation at 1 MiB, newest-first, 50k scaling) | pass | 1 MiB rotation to .1, O(N) tail read, 50k rows in < 2 s |
| surface F4 | eaea792a | `metadata.test.ts` (alias uniqueness across table) | pass | Error on duplicate alias, fixed shipped table duplicate |
| surface F5 | eaea792a | `roles.test.ts` (longest-provider-prefix with : and /) | pass | Longest prefix match with provider:model/id. Mutated code locally: without sort, test fails. |
| surface F8 | eaea792a | `metadata.test.ts`, `role-vectors.json` (example- prefix for test IDs) | pass | No real vendor model IDs in fixtures/vectors |
| surface M5 | eaea792a | `overrides.test.ts` (512-byte cap on override reasoning) | pass | Reasoning string capped at 512 bytes |
| surface M11 | eaea792a | `overrides.test.ts` (clear enum validation, alias collision prevention) | pass | Validated clear enum and alias collision prevention |
| surface F10 | b4349a9c | `docs/provider-matrix.md` (Vertex AI, xAI discovery mapped to manual) | pass | Docs updated with discovery column & R9 refs |
| surface F12 | b4349a9c | `packages/core/schemas/rpc.schema.json` (models.changed description) | pass | Reworded models.changed to reflect scan-only triggers |
| surface F13 | b4349a9c | `jobs.run.json`, `jobs.run.system.json`, `jobs.list.json`, schema | pass | Agent jobs.run restored, jobs.run.system added, schema descriptions updated |
| security M6 | b4349a9c | `docs/provider-matrix.md` (HTTP(S)_PROXY documented as ignored) | pass | Documented known limitation |
| surface F2 | b5631b16 | `discovery-e2e.test.ts` (quiescent core.status, relative path check) | pass | Arm spies after engine ready, verified 5/5 passes |
| surface F9 | b5631b16 | `discovery-e2e.test.ts`, `model-discovery.test.ts` (canary redaction) | pass | Full canary redaction check across CLI, logs, catalog, ledger, RPC errors |

## Review Fixes Round 3 (PR #70)

| Finding | Commit | Tests added (file::name) | Result | Notes |
|---|---|---|---|---|
| N1 scheduler vendor hammering | 918df432 | `scheduler.test.ts` (C1 trigger 2 / N1 2h fake clock) | pass | Backoff applied on unpersisted/failed nextScanAt; 1 run + 1 ledger pair per tick |
| N4 boot re-enrichment | cde1e6c0 | `core.test.ts` (boot re-enrichment failure) | pass | Injected failing store in core.test.ts; verified mutateCalled, asserted model.catalog.reenrich_failed warning, pins fix against try/catch removal |
| F4 alias uniqueness | cde1e6c0 | `model-metadata.json`, `metadata.test.ts`, `reconcile.test.ts` | pass | Per-provider dedup without mutating input models; reconcile.test.ts pins with colliding table; cross-provider duplicate aliases allowed |
| N3 / State I6 ledger ACL | 918df432 | `system-jobs.test.ts` (I6 / N3), `catalog-store.test.ts` (I6) | pass | Fail closed on securePath applied:false; ACL checked before writing ledger rows |
| State I1 lost update test | 918df432 | `service.test.ts` (override vs scan) | pass | Mutate runs inside store lock, override during scan preserved |
| State I2 manual scan test | 918df432 | `scheduler.test.ts` (I2 manual scan) | pass | Manual scan replans timer without silently resetting auth backoff |
| State I4 replan unhandled | 918df432 | `scheduler.test.ts` (I4 rejecting store.mutate) | pass | Mutate error caught, no unhandled rejection |
| Security M2 cursor test | cde1e6c0 | `validate.test.ts`, `scanners.test.ts`, `service.test.ts` | pass | Validates cursor <= 512 bytes, no control chars; scanner-level and service-level tests assert failed:invalid |
| Security M4 credential test | 918df432 | `service.test.ts` (credential unavailable) | pass | Distinct reason with undefined httpStatus |
| Security M5 mixed loopback test | 918df432 | `http.test.ts` (mixed loopback and positive loopback) | pass | Multiple addresses where one is non-loopback rejected |
| Security M7 abort timer test | cde1e6c0 | `http.test.ts` (abort clears connect timer and races socket event) | pass | Active timers tracked and socket event race tested; asserts 0 active timers and fails without if (done) return in socket handler |
| Security M10 safe integer test | 918df432 | `validate.test.ts` (Number.isSafeInteger) | pass | Numbers must be safe integers |
| Cleanups (D109, canary, F8) | 918df432 | `discovery-e2e.test.ts`, `validate.test.ts` | pass | 10s deadline on quiescence loop, sibling path assertion, RPC error throw asserted, example-llama3.2:latest id |

## Rulings
- **state I2 (Manual scan on auth-failed slot):** A manual `models.scan` is allowed as an explicit user action and re-plans the provider's timer. However, it respects the auth-failed slot by not clearing or silently resetting the auth backoff counter upon failure.
- **security M6 (HTTP(S)_PROXY):** Pinned client continues ignoring ambient proxy environment variables for request security and predictability. Documented as a known limitation in `docs/provider-matrix.md`.
- **security M9 (JSON null in optional fields):** Open question for upstream vendors returning null in optional fields; no code change made in D112.

## Skipped Minors
- **state M2 (Clamp in arm/replan):** Skipped; timer re-arm uses computed next slot with jitter, and startup clamps future slots to <= 1.1x interval.
- **state M5 (Separate concurrency limits):** Skipped; bounded by 4 workers in scheduler and 4 maxParallel in service.
- **state M6 (Skips without ledger row outside systemJobs.run):** Skipped; narrow window during fire-time disable, disabled status logged and timers canceled on disable.
- **state M8 (Ledger field-level schema validation on read):** Skipped; read path defensively parses JSON lines and skips malformed rows; strict object schema validation deferred to future ledger hardening.
- **state M9 (models.changed ID list truncation):** Skipped; spec §2.11 defines the change notification without max-item capping so subscribers receive full delta IDs.
- **state M10 (Catalog directory fsync / Windows rename retry):** Skipped; POSIX fsync and atomic rename (.tmp -> .prev -> target) are robust and already handle power loss safely without catalog corruption.
- **surface M1 (ADR-016 record updates):** Skipped; ADR-016 is an accepted architecture decision record preserved for historical design intent.
- **surface M2 / M3 (AGENTS.md test seam notes):** Skipped; general project guidelines are maintained independently of feature branch docs.
- **surface M4 (CLI cosmetic exit codes and last-scan wording):** Skipped; CLI adheres to unified error rendering and RPC status output conventions.
- **surface M6 (User-Agent version literal):** Skipped; `plur1bus/0.1.0` is standard across core modules until centralized package metadata injection is wired.
- **surface M8 (WebMCP jobs.run deny list):** Skipped; `jobs.run` requires explicit user capability opt-in and is not part of default WebMCP exposure.
- **surface M10 (models.list.providers configured-only empty display):** Skipped; spec defines provider listing as active discovery state from scans.

## Deviations
- Commit trailer: `Co-Authored-By: Antigravity <noreply@google.com>` instead of the plan's Claude trailers (agy prompt, hard rules).
- `pnpm gen` had to run once in the fresh worktree before `packages/core` tests could load (`generated/` is not committed).
- Task 2 step 4: `grep -c example-embed packages/core/dist/core.js` prints 0, because no entry point imports `metadata.ts` until Task 6/7 wires the service. Checked instead by bundling `metadata.ts` alone with esbuild: the table is inlined (count 1).
- Task 3: `PinnedClientOptions.limits` is `Partial<Record<keyof typeof LIMITS, number>>`, not `Partial<typeof LIMITS>`, because the latter would only accept the literal default values and the plan's own tests pass 50 ms.

## Spec/plan gaps
- A commit cannot contain its own SHA, so the table's SHA column lags one commit behind.

## Open
- None for review findings. Task 12 remains blocked until D15, D110, D111 as instructed.
