Status: IN PROGRESS · head SHA: see `git log` (a commit cannot name its own SHA; each task's SHA is filled in by the next commit) · 2026-10-03

| Task | Commit | Tests added (file::name) | Result | Notes |
|---|---|---|---|---|
| 1 Types, ports, test adapters, catalog store | pending (next commit) | `catalog-store.test.ts` (10), `fake-clock.test.ts` (4), `paths.test.ts::lays out the model catalog and the system-job state` | pass | full green line run once before push |
| 2 Metadata table | | | | |
| 3 HTTP client, validation | | | | |
| 4 Scanners | | | | |
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

## Spec/plan gaps
- A commit cannot contain its own SHA, so the table's SHA column lags one commit behind.

## Open
- Tasks 2–11.
