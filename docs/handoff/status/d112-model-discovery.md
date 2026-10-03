Status: IN PROGRESS · head SHA: see `git log` (a commit cannot name its own SHA; each task's SHA is filled in by the next commit) · 2026-10-03

| Task | Commit | Tests added (file::name) | Result | Notes |
|---|---|---|---|---|
| 1 Types, ports, test adapters, catalog store | f0885151 | `catalog-store.test.ts` (10), `fake-clock.test.ts` (4), `paths.test.ts::lays out the model catalog and the system-job state` | pass | full green line run once before push |
| 2 Metadata table | 28be796b | `metadata.test.ts` (13) | pass | |
| 3 HTTP client, validation | 3debef2a | `http.test.ts` (20), `validate.test.ts` (7) | pass | tests passed on first run after the implementation was written; they were written first but the red run was skipped |
| 4 Scanners | pending (next commit) | `scanners.test.ts` (11) | pass | |
| 5 Reconcile, overrides, roles | | | | |
| 6 Schedule, service, logger events | | | | |
| 7 System jobs, ledger, jobs.* | | | | |
| 8 Scheduler, config keys | | | | |
| 9 RPC models.* | | | | |
| 10 CLI, 1staid | | | | |
| 11 End to end, docs | | | | |
| 12 Wire real adapters | | | BLOCKED (D15, D110, D111) | not started, by instruction |

## Deviations
- Commit trailer: `Co-Authored-By: Antigravity <noreply@google.com>` instead of the plan's Claude trailers (agy prompt, hard rules).
- `pnpm gen` had to run once in the fresh worktree before `packages/core` tests could load (`generated/` is not committed).

- Task 2 step 4: `grep -c example-embed packages/core/dist/core.js` prints 0, because no entry point imports `metadata.ts` until Task 6/7 wires the service. Checked instead by bundling `metadata.ts` alone with esbuild: the table is inlined (count 1).

- Task 3: `PinnedClientOptions.limits` is `Partial<Record<keyof typeof LIMITS, number>>`, not `Partial<typeof LIMITS>`, because the latter would only accept the literal default values and the plan's own tests pass 50 ms.

## Spec/plan gaps
- A commit cannot contain its own SHA, so the table's SHA column lags one commit behind.

## Open
- Tasks 5–11.
