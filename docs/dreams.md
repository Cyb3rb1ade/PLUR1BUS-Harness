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

## Edge-case behaviour (characterised, PR #409)

The sections below document what the code does today, derived from `packages/core/test/dreams/` and
`packages/core/src/dreams/`. Cases marked "characterization" in the tests are *observed* behaviour that no specification
asked for; where one looks like a defect it is listed under [Open points](#open-points-offene-punkte) and is **not** a
commitment. Test references are `file > test name` relative to `packages/core/test/dreams/`.

### Cron dialect (`cron.ts`)

* Five fields, split on any whitespace; leading and trailing whitespace is ignored. Anything else (`""`, 4 or 6 fields,
  `@daily`) throws `invalid cron expression (5 fields expected)`. Ranges are minute 0-59, hour 0-23, day-of-month 1-31,
  month 1-12, day-of-week 0-7 (7 is folded to 0, so `0,7` is one Sunday).
* Forms: `*`, `a`, `a-b`, `a,b`, `*/n`, `a-b/n`, and `a/n` (runs from `a` to the field maximum, e.g. `10/20` in the
  minute field is 10, 30, 50). Rejected, each with a message naming the field: step 0 or non-numeric, empty list items,
  reversed or out-of-range ranges, a second `/`, decimals, names. Test: `cron-table.test.ts > dreams/cron parseCron: field forms`.
* `isValidTimezone` accepts IANA zone names that `Intl.DateTimeFormat` knows and rejects `""`, unknown names and path-like
  strings. Test: `cron-table.test.ts > dreams/cron isValidTimezone`.
* `nextAfter` is strictly after the given instant, so feeding a result back never repeats it. It scans at most
  `366 * 8` days ahead and returns `null` when the expression can never fire (for example 31 February).
* Day rule: when both day-of-month and day-of-week are restricted they are OR-ed; when only one is restricted it decides
  alone. A field counts as restricted unless it is **exactly** `*`. Test: `cron-table.test.ts > dom and dow are OR-ed ...`.
  * Edge case: `*/2` in day-of-month is *restricted*, so `0 3 */2 * 1` fires on Tuesday 2026-10-13 (odd day of month)
    although day-of-week asks for Monday. Test: `cron-table.test.ts > characterization: ... '*/2' in day-of-month counts as restricted, so it is OR-ed with day-of-week`.
* Daylight saving time (the zone is always explicit, never host-local):
  * A wall time that does not exist (spring forward) is skipped for that day (Berlin 2026-03-29, `30 2 * * *` next fires 2026-03-30).
  * An ambiguous wall time (fall back) fires once, at its first occurrence (Berlin 2026-10-25 02:30 CEST).
  * Edge case: an hourly `0 * * * *` in `Europe/Berlin` fires at 00:00Z and 02:00Z on 2026-10-25, then 03:00Z. The second
    02:00 wall time (01:00Z) is the same wall time as the first and is not fired, so the real-time gap is 2 h. Test:
    `cron-table.test.ts > characterization: ... an hourly cron skips the repeated hour at fall back (2 h gap in real time)`.
  * A daily `0 4 * * *` follows the local clock across the change (the deep default).

### Candidate content hash (`candidates.ts`)

`contentHash(text)` is the SHA-256 (hex) of `text.normalize("NFC").trim()`. It is case-sensitive, unifies Unicode normal
forms, ignores leading and trailing whitespace, and hashes the empty (or all-whitespace) string to the SHA-256 of the empty
input. Inner whitespace is **not** collapsed: `"a  b"`, `"a\nb"` and `"a b"` are three different candidates. Test:
`candidates-table.test.ts > characterization: ... inner whitespace is not collapsed, so 'a  b' and 'a b' are different candidates`.

### Idempotency key handling (`store.ts`)

* `insertRun` stores `<key>#<runId>`, so skipped rows can carry the computed key without blocking a rerun. `claimKey`
  swaps in the bare key through the table's UNIQUE constraint and returns `false` when another run holds it. `claimKey`
  only works on a run that is still open (`outcome IS NULL`).
* `finishRun` with `completed` keeps the bare key; any other outcome rewrites it to `<key>#<outcome>:<runId>`, giving the
  key back. The ledger row still shows the computed key and `claimed = false`. An unknown run id throws
  `unknown dream run <id>`. Tests: `store.test.ts > a <outcome> run gives the key back, so a rerun can claim it`,
  `store.test.ts > finishRun records outcome, reason, counts, tokens and the error, and refuses an unknown run`.
* Edge case: closing a run as `completed` that never claimed the key, while another completed run holds the same key,
  throws a SQLite `UNIQUE` error and leaves the run open (`outcome` stays `null`). The scheduler always claims first, so
  this path is not reached in normal operation. Test: `store.test.ts > characterization: ... closing an unclaimed run as completed while another completed run holds the same key throws (the scheduler always claims first)`.
* The store refuses `phase` and `trigger` values outside the closed sets. Test: `store.test.ts > the store refuses values outside the closed phase and trigger sets`.

### Agent registry and crash recovery (`scheduler.ts`, `methods.ts`)

* Who may dream is decided by the live agent registry. An agent removed from it gets no cron run, no catch-up and no
  importance trigger; captures reported for it are ignored and not recorded. `status()` lists registered agents only.
  Test: `scheduler-time.test.ts > an agent removed from the registry gets no cron run, no catch-up and no importance trigger; its rows stay`.
  * Its three `dream_schedule` rows are **kept** (assertion `the removed agent's schedule rows are kept` in the same
    case). After a restart no catch-up is created for it (`scheduler-time.test.ts > restart after the agent was removed: no catch-up for it`).
  * If the agent comes back, its stale `nextRunAt` fires once with `trigger = cron` (not `catchup`) and
    `scheduledFor` equal to the stale value. Test: `scheduler-time.test.ts > characterization: ... a removed agent that returns fires its stale firing once as cron (not as catchup)`.
* A run left open by a killed process is closed at the next start as `aborted / crashed`, including one of an agent that
  has left the registry. The in-flight marker is memory only, so `status` does not report such a run as running.
* A crashed window is **not** retried automatically: the corpus stays eligible, and the next window, an importance
  trigger or a manual run picks it up (no engine call happens at restart, the schedule's accumulated captures are
  unchanged). Test: `scheduler-time.test.ts > a crashed window is not retried by itself: the next window or an importance trigger picks the corpus up`.
* A disabled phase has no next run, gets no cron run and no catch-up; enabling it recomputes the next run from now (no
  burst of missed runs). Enabling an enabled phase keeps its stored next run.
* RPC (`methods.ts`): `dreams.run`, `dreams.schedule.*`, `dreams.enable` and `dreams.disable` check the registry through
  `requireAgent` first and have no effect on an unregistered agent; `dreams.status` and `dreams.log` do the same only when
  an `agentId` is given. A stopped scheduler answers `E_NOT_AVAILABLE`
  (`reason: "dreams-unavailable"`, plus `detail` when a cause is known). `dreams.schedule.set` validates before writing and
  maps a bad cron or timezone to `E_INVALID_PARAMS` with `detail: "cron"` or `"timezone"`; the row stays unchanged.
  `dreams.log` with an unknown `runId` is `E_NOT_FOUND`. A failing engine job is an answered run (`failed`), not an RPC
  error. `dryRun` writes no ledger row and calls no engine job. Tests: `methods.test.ts` (all `describe` blocks).

### Open points (Offene Punkte)

These are observations, not decisions. Do not rely on them.

1. **`runPhase` does not check the registry.** `DreamScheduler.runPhase` for an agent that left the registry runs and
   completes with engine calls; only `dreams.*` in `methods.ts` calls `requireAgent`. Marked as a known gap (`todo` test):
   `scheduler-time.test.ts > KNOWN GAP: core/dreams DreamScheduler.runPhase ...`.
2. **`*/n` day fields are treated as restricted**, although the header of `cron.ts` says semantics follow Vixie cron, where a
   field starting with `*` is unrestricted for the OR rule. `0 3 */2 * 1` therefore means "odd days OR Mondays".
3. **Hourly crons lose an hour on fall back.** The repeated wall hour is skipped, so a schedule gets a 2 h real-time gap
   once a year (see the hourly case above). The comment in the test notes this matches the "first occurrence" rule only
   literally.
4. **A returning agent fires its stale window as `cron`** and not as `catchup`, which makes the ledger's trigger column
   inconsistent with the catch-up rule in "Triggers".
5. **Schedule rows of removed agents are kept** and nothing in the characterised paths removes them.
6. **`finishRun` can throw `UNIQUE`** for an unclaimed completed close; the error surfaces raw from SQLite.
7. **No retry for a crashed window** (docs say only "its corpus stays eligible"); whether an automatic retry is wanted is
   undecided.
