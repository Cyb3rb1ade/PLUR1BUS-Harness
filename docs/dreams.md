# Dreaming

The harness owns the dreaming scheduler (ADR-009, M1b-3). It schedules and guards the engine's jobs through the engine job
registry (`engine.jobs.run`), writes one ledger row for every run — including every skip — and never registers a host cron.
There is no dreaming logic in the harness: the engine owns every step.

## Phases

Each agent has three phases, each with its own schedule, enable switch, stagger, status and log:

| Phase | Default cron | Jobs run (engine) | LLM session |
|---|---|---|---|
| `light` | `0 */4 * * *` | `light-dream`, `embedding-drain` | `light-dream` |
| `rem` | `15 1 * * *` | `rem-dream`, `discover-semantic-links` | `rem-dream` |
| `deep` | `0 4 * * *` | `consolidate-daily`, `auto-accept-stale`, `gc-run` | `consolidate-daily` |

The cron's timezone is stored explicitly in the schedule (default: the host's IANA zone at creation). The start is offset
by `hash(agentId, phase) % 1800 s` so many agents do not start together; at most 3 phase runs execute at once.

## Triggers

* **Importance** (primary): every stored capture adds 5 to each phase's accumulator; a phase fires when its accumulator
  reaches its threshold (light 150, rem 300, deep 450), at most once per minimum gap (1 h, 6 h, 12 h).
* **Cron** (floor): the phase fires on its schedule. A phase with fewer than its minimum corpus (stored captures since it
  last completed: light 1, rem 3, deep 3) records `skipped / min_corpus`.
* **Catch-up**: after downtime, a phase whose window was missed runs **once** (`trigger = catchup`), not once per missed tick.
* **Manual**: `plur1bus dreams run <phase> --agent A` takes every guard except the cron gate.

## Guards

| Guard | Rule | Reason code |
|---|---|---|
| Idempotency | `sha256(phase, agent, partition, windowId, digest)`; a second run over the same corpus and window is skipped. A failed or aborted run gives its key back | `idempotent` |
| Circuit breaker | 3 LLM sessions per agent per UTC day across rem and deep; the 4th is not started, the run is `aborted`, the breaker stays open to the next UTC midnight | `breaker_sessions`, then `breaker_open` |
| Minimum corpus | see Triggers | `min_corpus` |
| Concurrency | 3 phase runs at once; a second run of the same agent and phase is refused | `already_running` |
| Candidates | dedupe by content hash, 72 h expiry, utility gate (never `recalls = 0`; ≥ 3 recalls, ≥ 3 queries, score ≥ 0.75) with a gate-by-gate decision record. Inert until a candidate producer is wired (the pinned engine has none) | `no_candidates` |
| No LLM route | the engine's `no_llm_*` skip | `no_llm_route` |

An engine job that fails, comes back `incomplete` or `abandoned`, or a diary the engine says it did not write, is recorded
`failed` — never `completed`. A run that crashed mid-way is reconciled at the next start to `aborted / crashed` and its
corpus stays eligible. Cost is **measured, not capped**: tokens per run are in the ledger (`cost_micros` stays empty until a
price table exists).

## Where things live

* Ledger: `<home>/state/dreams/dreams.db` (`node:sqlite`; tables `dream_run`, `dream_schedule`, `dream_candidate`; versioned
  migrations). Per-run logs: `<home>/state/dreams/<agentId>/<phase>/<runId>.log`. Retention: ledger rows 365 days, logs 30 days.
* Code: `packages/core/src/dreams/` (`cron.ts`, `store.ts`, `candidates.ts`, `scheduler.ts`, `methods.ts`, `index.ts`).

## CLI and RPC

```
plur1bus dreams status [--agent A]            phases, next/last run, breaker, importance, counters (+ the engine-job view)
plur1bus dreams run <light|rem|deep> --agent A [--dry-run]
plur1bus dreams log --agent A [--phase P]     the phase ledger; --run ID shows one run and its log
plur1bus dreams schedule get --agent A
plur1bus dreams schedule set <phase> --agent A [--cron "…"] [--timezone Z] [--enabled true|false]
plur1bus dreams enable|disable <phase> --agent A
```

`dreams run <job>` with an engine job name (for example `gc-run`) and `dreams log --job` keep working as before. The RPC
methods are `dreams.status|log|run|schedule.get|schedule.set|enable|disable` (experimental, `docs/rpc.md`).

## Testing

`packages/core/test/dreams-*.test.ts` run the scheduler on a virtual clock against a scripted engine (ADR-009 A1–A8, the
ledger rules, breaker, crash reconcile, catch-up, retention); `dreams-rpc.test.ts` also drives a real core and engine;
`tests/system/dreams.test.ts` drives the real CLI. Under `--test-internals` the scheduler's own timers stay off (manual
runs and the RPC still work), so the system and soak tests never meet a scheduled dream.
