# M1b-3 — Dreaming scheduler (core side) — plan

**Goal.** The harness owns the dreaming scheduler of ADR-009: three phases (light / rem / deep) as first-class
objects per agent (cron + timezone, enable, stagger, status, log, run now), importance accumulation as the primary
trigger with cron as the floor, mandatory guards, a run ledger written *before* the body, delivery through the
engine job registry (`engine.jobs.run`), and visibility through `dreams.*` RPC and `plur1bus dreams …`. It never
registers a host cron and holds no dreaming logic of its own.

**Not in scope.** Engine-side work (shortlist-only light mode, the `dream_candidate` producer, one deep composite job —
ADR-009 C1/action 3), the UI, `doctor` (D111 / M2), `dreams diary` as a CLI command.

## Files

| File | Purpose |
|---|---|
| `packages/core/src/dreams/types.ts` | phases, outcomes, reason codes, constants, ports (`DreamEngine`, `CandidateSource`, `Clock`) |
| `packages/core/src/dreams/cron.ts` | 5-field cron + IANA timezone evaluator (`nextAfter`, `previousAtOrBefore`), DST-safe, no deps |
| `packages/core/src/dreams/store.ts` | `node:sqlite` store, versioned migrations (`PRAGMA user_version`), `dream_run`/`dream_schedule`/`dream_candidate` |
| `packages/core/src/dreams/candidates.ts` | dedupe, expiry, utility gate with a per-candidate decision record (pure) |
| `packages/core/src/dreams/scheduler.ts` | timers, triggers, guards, run lifecycle, reconcile, catch-up, breaker, concurrency 3 |
| `packages/core/src/dreams/methods.ts` | `dreams.*` RPC handlers (a new block, spread into `buildMethods`) |
| `packages/core/src/dreams/index.ts` | `createDreams` wiring |
| `packages/rpc-schema/schema/rpc.schema.json` | `dreams.status/log/run/schedule.get/schedule.set/enable/disable` (+ `$defs`), additive |
| `crates/plur1bus/src/{cli.rs,commands/dreams.rs}` | `dreams status\|log\|run\|schedule\|enable\|disable`; the legacy job forms keep working |
| `packages/core/src/core.ts` | one contained block: create + start the scheduler, feed captures, stop on shutdown |

## Tasks (test first)

1. Cron evaluator — tests: every-4h, daily, DST gap/overlap (Europe/Berlin), timezone, invalid expressions.
2. Store + migrations — tests: fresh create, reopen, forward migration, UNIQUE idempotency claim, release on failure.
3. Scheduler core: ledger-before-body (L15), skip reasons (L16), idempotency, guards, breaker, concurrency, stagger.
4. Triggers: cron floor, importance accumulation, catch-up (A8), crash reconcile.
5. RPC schema + methods + core wiring; no-host-cron test (A6) against the service layer and a static scan.
6. CLI + docs (`pnpm docs:gen`), PR.

## Acceptance → test

| Criterion | Test file |
|---|---|
| A1 fresh install, 24 h: three phases + diary | `dreams-acceptance.test.ts` |
| A2 failing phase shows skipped/failed, never completed (+ diary variant) | `dreams-acceptance.test.ts` |
| A3 session breaker trips (cap 2 of 10) | `dreams-acceptance.test.ts` |
| A4 second deep run idempotent | `dreams-acceptance.test.ts` |
| A5 promotion needs utility | `dreams-candidates.test.ts` |
| A6 no host cron | `dreams-no-host-cron.test.ts` (+ Rust service-layer test) |
| A7 staggering, concurrency ≤ 3 | `dreams-acceptance.test.ts` |
| A8 downtime catch-up, one per window | `dreams-acceptance.test.ts` |
| L15 skip writes its row first, L16 | `dreams-scheduler.test.ts` |
| breaker trips and recovers | `dreams-scheduler.test.ts` |
| idempotent rerun, no double run | `dreams-scheduler.test.ts` |
| crash mid-run reconciled at start | `dreams-scheduler.test.ts` |
| RPC / CLI surface | `dreams-rpc.test.ts`, `crates/plur1bus/tests/cli.rs` |
