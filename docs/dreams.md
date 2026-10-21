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
  The same holds for an agent that left the registry and returns: its stale window fires once as `catchup`. A crashed
  window is retried once as `catchup` (see "Agent registry and crash recovery").
* **Manual**: `plur1bus dreams run <phase> --agent A` takes every guard except the cron gate.

## Guards

| Guard | Rule | Reason code |
|---|---|---|
| Idempotency | `sha256(phase, agent, partition, windowId, digest)`; a second run over the same corpus and window is skipped. A failed or aborted run gives its key back | `idempotent` |
| Circuit breaker | 3 LLM sessions per agent per UTC day across rem and deep; the 4th is not started, the run is `aborted`, the breaker stays open to the next UTC midnight | `breaker_sessions`, then `breaker_open` |
| Minimum corpus | see Triggers | `min_corpus` |
| Concurrency | 3 phase runs at once; a second run of the same agent and phase is refused | `already_running` |
| Candidates | dedupe by content hash and 72 h expiry remain. Candidate gates authorize only the explicit promotion step; `consolidate-daily`, `auto-accept-stale` and `gc-run` run with zero candidates too. Real recall counters come from public Engine 1.17.0 `memory.stats` when present: ≥ 3 recalls, ≥ 3 distinct queries, score ≥ 0.75 when a public query result reports one. A `since` listing has no similarity score; `score = null` passes that optional gate while the observed recall/query thresholds still apply. Without counters, a diagnostic fallback field records age ≥ 24 h plus either importance ≥ 0.75 (only if publicly reported) or at least two distinct private source cards with identical normalized content. Search score is never importance; repeated scheduler pulls never count as repeated evidence. This field changes neither shortlist membership nor promotion eligibility; it only explains available evidence. | gate-by-gate candidate decision; no phase-level `no_candidates` skip |
| No LLM route | the engine's `no_llm_*` skip | `no_llm_route` |

An engine job that fails, comes back `incomplete` or `abandoned`, or a diary the engine says it did not write, is recorded
`failed` — never `completed`. A run that crashed mid-way is reconciled at the next start to `aborted / crashed` and its
corpus stays eligible. Cost is **measured, not capped**, and only in tokens: tokens per run are in the ledger. There is no
money dimension (owner decision 2026-10-19); the ledger's legacy money column stays empty.

## Where things live

* Ledger: `<home>/state/dreams/dreams.db` (`node:sqlite`; tables `dream_run`, `dream_schedule`, `dream_candidate`; versioned
  migrations). Per-run logs: `<home>/state/dreams/<agentId>/<phase>/<runId>.log`. Retention: ledger rows 365 days, logs 30 days.
* Code: `packages/core/src/dreams/` (`cron.ts`, `store.ts`, `candidates.ts`, `producer.ts`, `scheduler.ts`, `methods.ts`, `index.ts`).

## CLI and RPC

```
plur1bus dreams status [--agent A]            phases, next/last run, breaker, importance, counters (+ the engine-job view)
plur1bus dreams run <light|rem|deep> --agent A [--dry-run]
plur1bus dreams log --agent A [--phase P]     the phase ledger; --run ID shows one run and its log
plur1bus dreams schedule get --agent A
plur1bus dreams schedule set <phase> --agent A [--cron "…"] [--timezone Z] [--enabled true|false]
plur1bus dreams enable|disable <phase> --agent A
plur1bus dreams diary --agent A               private diary (`dreaming.md`); owner or agent.manage; `--json`
```

`dreams run <job>` with an engine job name (for example `gc-run`) and `dreams log --job` keep working as before. The RPC
methods are `dreams.status|log|run|schedule.get|schedule.set|enable|disable|diary` (experimental, `docs/rpc.md`). `dreams.diary`
is `agent.manage` on the agent; a viewer is denied. HTTP `WEB_CORE_METHODS` does not include `dreams.diary` (`packages/api/**`
was out of scope); a web `/rpc` caller is refused with `E_DENIED` / `web-method`. Test: `packages/core/test/dreams/methods.test.ts` "Diary only with the right (viewer sees nothing foreign)."

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
* Day rule (Vixie cron): a day field **starting with `*`** (`*`, `*/2`, `*/3`) is unrestricted. When both day-of-month and
  day-of-week are restricted (neither starts with `*`) they are OR-ed; otherwise they are AND-ed, so `*/n` still limits the
  days it names. `0 3 */2 * 1` therefore means "Mondays that fall on an odd day of the month" (next after Tuesday
  2026-10-13: Monday 2026-10-19), and `0 3 15 * */2` "the 15th, when it is an even weekday number". Tests:
  `cron-table.test.ts > dom and dow are OR-ed ...`, `> '*/n' in day-of-month is unrestricted for the OR rule, like Vixie cron ...`,
  `> '*/n' in day-of-week is unrestricted as well ...`, `> a field is restricted unless it starts with '*' (Vixie cron)`.
* Daylight saving time (the zone is always explicit, never host-local):
  * A wall time that does not exist (spring forward) is skipped for that day (Berlin 2026-03-29, `30 2 * * *` next fires 2026-03-30).
  * An ambiguous wall time (fall back) fires once, at its first occurrence (Berlin 2026-10-25 02:30 CEST).
  * Owner decision 2026-10-14: **one run per wall-clock time**; the doubled hour at fall back runs **once**, at its first
    occurrence (not skipped, not twice). An hourly `0 * * * *` in `Europe/Berlin` fires at 00:00Z (02:00 CEST) and then
    02:00Z (03:00 CET) on 2026-10-25; the real-time gap of up to 2 h during fall-back is accepted. The same holds for
    `*/30 * * * *` and for fixed-hour schedules (`0 2,3 * * *`). At spring forward no wall time is invented. Tests:
    `cron-table.test.ts > owner decision 2026-10-14: an hourly cron runs once per wall-clock hour ...`, `> a sub-hourly wildcard cron ...`,
    `> a cron with fixed hours fires at the first occurrence only ...`, `> an hourly cron does not fire twice at spring forward ...`;
    with an injected clock in Europe/Berlin: `scheduler-time.test.ts > dreams scheduler: DST in Europe/Berlin on an injected clock`.
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
* Closing a run as `completed` that never claimed the key, while another completed run holds the same key, throws a
  defined `RpcError` `E_CONFLICT` (`reason: "idempotent"`, message names both runs, no SQLite text) and leaves the run open
  (`outcome` stays `null`). The scheduler always claims first, so this path is not reached in normal operation. Test:
  `store.test.ts > closing an unclaimed run as completed while another completed run holds the same key is a defined E_CONFLICT ...`.
* The store refuses `phase` and `trigger` values outside the closed sets. Test: `store.test.ts > the store refuses values outside the closed phase and trigger sets`.

### Agent registry and crash recovery (`scheduler.ts`, `methods.ts`)

* Who may dream is decided by the live agent registry. An agent removed from it gets no cron run, no catch-up and no
  importance trigger; captures reported for it are ignored and not recorded. `status()` lists registered agents only.
  Test: `scheduler-time.test.ts > an agent removed from the registry gets no cron run, no catch-up and no importance trigger; its rows stay`.
  * Its three `dream_schedule` rows stay while the process runs (the agent may come back) and are **deleted at the next
    start**; the ledger keeps its rows. After a restart no catch-up is created for it (`scheduler-time.test.ts > restart after the agent was removed: no catch-up for it`),
    and a returning agent gets fresh rows without a stale firing. The Core calls `DreamScheduler.forgetAgent(agentId)` (through
    `forgetRemovedAgent`, `dreams/index.ts`) as soon as an agent is removed: after `agent.delete` has marked the agent deleted
    (it then drops out of the active registry; `admin-surface.ts` `onAgentDeleted`) and when a configuration change removes the
    agent from `agents` (`core.ts`, `cs.onChange`). `forgetAgent` refuses a still-registered agent; the wiring then logs a warning
    and leaves the rows to the next start. A failing call never fails the deletion. Tests: `backend.test.ts > agent.delete drops the agent's dream schedule rows at once ...`, `backend.test.ts > a failing forget hook ...`, `scheduler-time.test.ts > the schedule rows of a removed agent are deleted at the next start ...`,
    `> forgetAgent removes the rows at once ...`; store: `store.test.ts > deleteSchedules removes the three schedule rows ...`.
  * If the agent comes back within the same process, its stale `nextRunAt` fires once with `trigger = catchup` and
    `scheduledFor` equal to the stale value; the schedule is normal afterwards. The scheduler notices the absence at its
    ticks (at least hourly). Test: `scheduler-time.test.ts > a removed agent that returns fires its missed window once as catchup ...`.
* A run left open by a killed process is closed at the next start as `aborted / crashed`, including one of an agent that
  has left the registry. The in-flight marker is memory only, so `status` does not report such a run as running.
* A crashed window is **retried once**, at the next start (cap `RETRY_CAP = 1`, `types.ts`): a crashed run that had a
  scheduled instant (`cron` or `catchup`) of an agent that is still registered, whose phase is still enabled, whose
  `scheduledFor` is not older than `RETRY_MAX_AGE_MS` (24 h; `clock.now() - scheduledFor > bound` refuses, so exactly 24 h
  still retries), and for which no other run for that instant exists, is re-run with the **same `scheduledFor`** and
  `trigger = catchup` (no new trigger value; the retry is recognised by sharing the instant with an `aborted / crashed`
  run). If the retry crashes as well, it is not retried again; the corpus stays eligible for the next window, an importance
  trigger or a manual run. Crashed manual or importance runs have no window and are not retried, nor are runs of removed
  agents or disabled phases, nor a window older than the age bound. A phase that is catching up anyway at that start covers
  the retry. The normal guards apply to the retry (idempotency, minimum corpus). Clock is injected (no sleeps).
  Tests: `scheduler-time.test.ts > a crashed window is retried once at the next start ...`,
  `> the retry is capped at one ...`, `> a crashed window older than RETRY_MAX_AGE_MS is not retried`,
  `> a crashed manual or importance run ... is not retried ...`;
  `store.test.ts > windowRuns lists the runs of one agent, phase and scheduled instant ...`.
* A disabled phase has no next run, gets no cron run and no catch-up; enabling it recomputes the next run from now (no
  burst of missed runs). Enabling an enabled phase keeps its stored next run.
* RPC (`methods.ts`): `dreams.run`, `dreams.schedule.*`, `dreams.enable`, `dreams.disable` and `dreams.diary` check the registry through
  `requireAgent` first and have no effect on an unregistered agent; `dreams.status` and `dreams.log` do the same only when
  an `agentId` is given. A stopped scheduler answers `E_NOT_AVAILABLE`
  (`reason: "dreams-unavailable"`, plus `detail` when a cause is known). `dreams.schedule.set` validates before writing and
  maps a bad cron or timezone to `E_INVALID_PARAMS` with `detail: "cron"` or `"timezone"`; the row stays unchanged.
  `dreams.log` with an unknown `runId` is `E_NOT_FOUND`. A failing engine job is an answered run (`failed`), not an RPC
  error. `dryRun` writes no ledger row and calls no engine job. `dreams.diary` reads `dreaming.md` (capped at 262 144 bytes,
  redacted); unlimited diary retention is unchanged. Tests: `methods.test.ts` (all `describe` blocks).
* Doctor (`1staid check` id `dreams.last-runs`, append-only after `models.roles`): last run per phase and agent, error
  state, missed windows (`enabled && nextRunAt <= now`). Injectable clock (`Env.now`). Test: `doctor_reports_a_missed_window`
  in `crates/plur1bus/src/commands/firstaid.rs`.

### Open points (Offene Punkte)

Fixed in the 2026-10-14 consistency wave (test references above):

1. **`runPhase` checks the registry.** `DreamScheduler.runPhase` throws `unknown agent` for an agent that left the registry
   (`scheduler-time.test.ts > KNOWN GAP: core/dreams DreamScheduler.runPhase ...` is a plain test now).
2. **`*/n` day fields** follow Vixie cron: fixed, see "Cron dialect".
3. **Hourly crons and the repeated hour on fall back**: decided, see "Cron dialect" (owner decision 2026-10-14: one run per
   wall-clock hour, the doubled hour runs once; a real-time gap of up to 2 h is accepted). Pinned by tests.
4. **A returning agent fires its stale window as `catchup`**: fixed.
5. **Schedule rows of removed agents** are deleted at once when the Core removes the agent (`agent.delete`, configuration change) and, as a fallback, at the next start: fixed.
6. **`finishRun` UNIQUE conflict** is a defined `E_CONFLICT`: fixed.
7. **Crashed window** is retried once (`RETRY_CAP = 1`): fixed. Age bound `RETRY_MAX_AGE_MS` (24 h) added:
   `scheduler-time.test.ts > a crashed window older than RETRY_MAX_AGE_MS is not retried`.
8. **Candidate producer** ships (`packages/core/src/dreams/producer.ts`); test
   `packages/core/test/dreams/producer.test.ts` "Producer yields candidates against a fake engine." Production wiring maps
   `Engine.memory.list` agent-private cards only (ADR-009 Q5; workspace/user cards are not ingested as `agent-private`)
   and never invents recalls/uniqueQueries. The public 100-card time listing is paged with overlapping inclusive boundaries and ids are deduplicated. If more than 100 cards share one boundary timestamp, the cursor-less API cannot prove completeness: candidate reading fails closed (`failed/engine_error`) after independent maintenance. Score is copied only when
   present; a `since` listing does not include scores (no topic query).
9. **`plur1bus dreams diary`** / RPC `dreams.diary` (agent.manage, redacted, `--json`):
   `methods.test.ts` "Diary only with the right (viewer sees nothing foreign)."
10. **Doctor check** `dreams.last-runs`: `doctor_reports_a_missed_window` in `crates/plur1bus/src/commands/firstaid.rs`.

Still open (deliberately):

* The retry is not distinguishable from a normal catch-up in the ledger's trigger column (it shares `scheduledFor` with the
  crashed run). A dedicated trigger value would need a schema, wire-format and web-string change.
* **Controller pin pending (A1):** the current Engine pin has no public recall-statistics or explicit promotion API. The optional compatibility adapter uses Engine contract **1.17.0** `memory.stats(ids, principal, context)` and `memory.promote({ ids }, principal, context)` when available. Until the Controller pins that contract, maintenance works and candidates remain unpromoted. Both fixture regressions and strict source acceptance are required; final installed-pin promotion acceptance remains mandatory after that pin. No statistics are fabricated.

## Promotion confirmation (A3)

The producer retains the Engine's currently visible agent-private memory id; a ledger content hash cannot reconstruct an id or confer access. It joins `memory.stats` by that id and refuses foreign-agent, duplicate or malformed counter responses. Shared workspace/user cards stay outside this producer. An incomplete listing fails closed for promotion; the independent light/deep maintenance jobs still run, then the run reports `failed/engine_error` for the candidate read.

Statistics and promotion requests use batches of at most 500 source ids, respecting both Engine admission limits. After the jobs complete, the scheduler submits eligible source ids to the Engine's explicit promotion operation. Every batch receipt must validate before any ledger row advances; cancellation or a later failed batch leaves the ledger open for reconciliation. The ledger advances to `promoted` only for a matching same-agent `promoted/integrated` receipt. `skipped/already-promoted` is also positive confirmation: A1 found its durable source marker, allowing reconciliation after a crash between the Engine write and the ledger write. Other skips, missing receipts, errors and cancellation leave the candidate shortlisted; the Engine result/reason is kept with its gate decision. Receipts are validated before a single ledger transaction records them.

The host operation uses the existing proved agent/workspace principal and `AgentContext { origin: "system", background: false }`, matching A1's explicit host transaction contract. Here `background: false` describes that authorized transaction; the enclosing sweep may originate from cron. Model calls never receive this context. Engine ACL, lifecycle, source scope and promotion caps remain authoritative.
