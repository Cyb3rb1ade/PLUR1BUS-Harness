# ADR-009: Dreaming scheduler

**Status:** Proposed · **Date:** 2026-09-22 · **Deciders:** Christian (owner) · **Inputs:** `docs/phase0/brief.md` D4, D6, D9, D11 · `docs/phase0/auftrag-original-2026-09-21.md` §4.1 (feature crons), §6.2, §9, §11, §12 · `docs/phase0/openclaw-sleep-plan-reference.png` (D4's reference screenshot) · `docs/phase0/research/plur1bus-crons-embedding-portability.md` §1 · `docs/phase0/research/openclaw-layout-dreaming-ui.md` §2 · `docs/phase0/research/harness-engineering-state-of-the-art.md` §6, §7 · `docs/phase0/research/plur1bus-host-contract.md` §1, §5 · Source of record: `/home/claude/refs/openclaw-plur1bus-memory` @ `89148f9`; `/home/claude/refs/openclaw` @ `b9421f4` (2026.9.5). Companion: ADR-002 (`engine.jobs` registry), ADR-006 (embed/rerank), ADR-010 (budgets).

## Context

### The owner's experience

D4 states the problem in one line: **dreaming must demonstrably work.** The reported experience under PLUR1BUS on OpenClaw is that dreaming either never ran or it was impossible to tell whether it ran. That is not a vague impression — it is the predictable output of the code, and the causes are enumerable.

### Why PLUR1BUS dreaming is invisible — concrete causes

All rows below are drawn from `plur1bus-crons-embedding-portability.md` §1 ("Why dreaming 'never ran'"); rows marked **(read directly)** were additionally re-opened in `/home/claude/refs/openclaw-plur1bus-memory` @ `89148f9` for this ADR.

| # | Cause | file:line @ `89148f9` |
|---|---|---|
| 1 | **The provisioning script is contractually forbidden to fail.** "Contract: this script must NEVER fail an install… exits 0." Every failure branch writes one line and returns 0 — at least nine distinct silent-skip branches | `scripts/setup-feature-crons.mjs:13-17` (read directly), `:354-737` |
| 2 | **A fail-closed native probe *disables* existing jobs.** The probe requires `cron add --help` to contain `--command-argv`, `--timeout-seconds`, `--output-max-bytes` **and** `plur1bus-feature-cron --help` to contain `--agent`, `--feature` **and** `existsSync(FEATURE_CRON_RUNNER_PATH)`; otherwise it throws, and the caller safety-disables matching jobs and renames them `" [plur1bus:host-dispatch-unavailable]"`. The probe budget was already raised 5 s → 30 s because host CLI boot took 11.6 s — a slower host silently re-enters the disable branch | `scripts/setup-feature-crons.mjs:57-72` (read directly), `:41-48`, `:415-490`; `lib/setup/feature-cron-plan.js:412, 480-504` |
| 3 | **Provisioning depends on host *source* config text, not effective config.** `selectEnabledFeatureCronSpecs` reads `sourceConfig.plugins.entries["memory-lancedb-namespaced"].config`; absent or `enabled:false` ⇒ `[]` and the message "no explicitly enabled feature owns a cron job — nothing to do" | `lib/setup/feature-cron-plan.js:307-344`; `setup-feature-crons.mjs:543` |
| 4 | **`rem-dream` is gated by the *merging* switch, not by anything named dreaming.** `if (explicitlyEnabled(cfg.merging)) enabledFeatures.add("rem-dream")` — turning off merging removes the nightly dream with no dreaming-named signal | `lib/setup/feature-cron-plan.js:337` (read directly) |
| 5 | **The commonest "it did nothing" outcome produces no warning.** `if (!mergingEnabled \|\| !isLlmRouteAvailable(remPatternLlmCfg)) return { job:"rem-dream", skipped:true, reason:"no_llm_config" }` — a JSON payload on the cron's stdout, never a log line | `index.js:7691-7694` (read directly) |
| 6 | **Six silent early returns inside `runRemDream`;** four invisible at default log level: `acl_partition_missing` (no log), `acl_sink_missing` (`logger.debug`), `candidate_read_failed` (`logger.debug`), **`too_few_memories` (< 3, no log at all)**, `lock_held`, `already_processed` | `lib/dreaming/rem-dream.js:1094, 1118, 1136, 1139, 1165, 1170` (read directly) |
| 7 | **A run could be marked completed with no dream written.** Until 7.12.58 a run was closed even when the model returned nothing — the code's own comment records a real case: 241 memories, 59 s, recorded `completed`, no entry ever reached `DREAMS.md`, and every later night reported `already_processed`. Fixed by leaving the run open with a `logger.warn` when `narrativeExpected && !narrative` | `lib/dreaming/rem-dream.js:1326-1340` (read directly) |
| 8 | **Light dreaming has no cron at all** — it runs fire-and-forget inside the `agent_end` hook, dies with the process, and its four-way precondition (`!background && mergingEnabled && isLlmRouteAvailable(conversationInsightsLlmCfg) && neoEnabled`) logs **nothing** when it fails | `index.js:10951-10962` (read directly); `lib/dreaming/light-dream.js:1-11` |
| 9 | **There is no single deep-sleep job.** Promotion, compaction, GC and the diary are four unrelated schedules (04:00 `consolidate-daily`, 04:45 `gc-run`, hook-time light dream, 01:15 `rem-dream`) with no shared run identity | `plur1bus-crons-embedding-portability.md` §1 "Mapping onto OpenClaw's three-phase sleep model" |
| 10 | **Run state is almost nothing.** One `api.logger.info` line per run, a JSON `ReplyPayload` on the cron's stdout, `runs.json completed[runKey]` for rem-dream/reflection/compaction only, and a 20-hour bootstrap throttle marker `{pluginVersion, lastRunAt, lastPlanCreateCount}` that says nothing about whether any job ever *ran* | ibid.; `lib/setup/feature-cron-bootstrap.js:15-40`; `lib/neo-arch.js:1916-1925` |
| 11 | Diary write and host-event emission are both **fail-open**, and the event is emitted only when the diary write succeeded — so a failed diary write is doubly invisible | `lib/dreaming/dream-diary.js:141-170`, `:177-206` |

Field symptom that ties them together: `too_few_memories, count: 0` for both shared partitions, because shared `workspace`/`user` partitions read only `.plur1bus-shared/`, populated solely by `/share` — `memory_store` rows with `scope: workspace` in the agent table belong to no partition (`KNOWN-ISSUES.md:19`). Four independent mechanisms each produce a silent no-op, and none writes durable state a human or a doctor command can inspect afterwards.

### OpenClaw's memory-core dreaming — the reference model (D4) and its documented failures

OpenClaw implements the same three phases in the bundled `memory-core` plugin, with all defaults literal in source (`src/memory-host-sdk/dreaming.ts:21-56` @ `b9421f4`, version 2026.9.5, read directly):

- Top level: `enabled: true`, `frequency: "0 3 * * *"`, `timezone: undefined` (host-local), `storage: { mode: "separate", separateReports: false }`, `execution.defaults: { speed: "balanced", thinking: "medium", budget: "medium" }`.
- **Light:** `lookbackDays: 2`, `limit: 100`, `dedupeSimilarity: 0.9`, `sources: ["daily","sessions","recall"]`. Stages candidates; does not touch `MEMORY.md`.
- **REM:** `lookbackDays: 7`, `limit: 10`, `minPatternStrength: 0.75`, `sources: ["memory","daily","deep"]`. Records reinforcement signals; does not touch `MEMORY.md`.
- **Deep:** `limit: 10`, `minScore: 0.75`, `minRecallCount: 3`, `minUniqueQueries: 3`, `recencyHalfLifeDays: 14`, `maxAgeDays: 30`, `maxPromotedSnippetTokens: 160`, `maxPriorEntryLossFraction: 0.25`, plus a `recovery` sub-config (`triggerBelowHealth: 0.35`, `minRecoveryConfidence: 0.9`, `autoWriteMinConfidence: 0.97`). **The only phase that promotes into `MEMORY.md`.** The `minScore: 0.75` default carries a calibration comment: durable 3-day/3-query facts score 0.750–0.756 vs repeated filler 0.489–0.549 and high-relevance one-offs 0.529–0.606.
- Mechanics: **one managed cron job for the whole sweep**, reconciled idempotently through a `CronServiceLike` interface, `sessionTarget: "isolated"`, `payload: { kind: "agentTurn", message: "__openclaw_memory_core_short_term_promotion_dream__", lightContext: true }`, `delivery: { mode: "none" }` (`extensions/memory-core/src/dreaming-cron.ts:96-121`, read directly). Legacy per-phase job constants still exist (`LEGACY_MEMORY_LIGHT_DREAMING_CRON_NAME`, `…REM…`), i.e. three separate jobs were consolidated into one.
- Explicit scoring weights (docs): relevance 0.30, frequency 0.24, query diversity 0.15, recency 0.15, consolidation 0.10, conceptual richness 0.06; three deterministic gates must **all** pass; the model emits typed add/merge/supersede operations that a deterministic validator applies; consolidation runs in fresh contexts so diary output cannot become a promotion source (`harness-engineering-state-of-the-art.md` §6).

And its failures, which are the real design input:

| Issue | What happened |
|---|---|
| [openclaw#65550](https://github.com/openclaw/openclaw/issues/65550) (2026-04-11, v2026.4.10) | **94 dreaming-narrative session pairs in 65 minutes, $4.35 burned, 100 % zero-confidence output, 302 lines of dream fragments overwrote legitimate daily notes.** Stated root causes: no dedupe (same candidates reprocessed in a tight loop), no rate limit or circuit breaker, stale candidates (`confidence: 0.00, recalls: 0`, from 2–4-day-old transcripts) stayed eligible. 18 workspaces iterated serially with no scoping option; 7 942 recall entries at a **95 % zero-recall rate**. Resolved only by disabling the plugin |
| [openclaw#142393](https://github.com/openclaw/openclaw/issues/142393) (v2026.7.1-2) | **Promotion inversion + silent truncation.** Deep dreaming accepts `recalls=0` entries into `MEMORY.md` while `DREAMING_MEMORY_PATH_RE` *excludes dreaming paths from recall tallying* — genuinely useful content can never accumulate recalls. `MEMORY.md` grew to 9 728 bytes against a 9 000-char `bootstrapMaxChars` cap and **the tail silently truncates on every load**. Three consecutive nightly runs each added zero-recall entries |
| [openclaw#147157](https://github.com/openclaw/openclaw/issues/147157) | "dreaming-narrative hangs 994 s per run and starves turn-slot budget across all agents" (title only) |
| #62920 / #62296 / #62857 / #65412 / #67922 / #143206 | Cron not created after startup or config change; cron system-event not triggering the reply hook; silent init failure; narrative never writes to `DREAMS.md`; diary output to stdout instead of the file; **a run with failed and pending narratives recorded as OK without retry** (`openclaw-layout-dreaming-ui.md` §2 — titles from search; **status not individually verified**, treat as a named recurring failure class, not as confirmed-open bugs) |

Bounded concurrency exists (max 3 concurrent background runs system-wide) but, as #65550 shows, is **insufficient without dedupe and a circuit breaker** (`harness-engineering-state-of-the-art.md` §6). Consolidating three phases onto one trigger removes an out-of-sync failure class but concentrates all three phases' failures on one path — consistent with #62920/#62296/#62857 all being *trigger* failures (`openclaw-layout-dreaming-ui.md` §2 Inferences).

### Literature

- **Sleep-time compute** (Lin, Snell, Wang, Packer, Wooders, Stoica, Gonzalez, [arXiv 2504.13171](https://arxiv.org/abs/2504.13171), 2025-04-17): pre-computing inferences over a context between sessions gives **~5× reduction in test-time compute** at equal accuracy, **+13 %/+18 % accuracy** on Stateful GSM-Symbolic and Stateful AIME, and **2.5× lower average cost per query** when amortised — **conditional on query predictability**. This is the strongest evidence that an offline phase is worth building, and it says consolidation should be steered by observed query patterns rather than run blindly.
- **Generative Agents** (Park et al., [arXiv 2304.03442](https://ar5iv.labs.arxiv.org/html/2304.03442)): reflection fires when the **summed importance of recent events exceeds a threshold (150 in the paper)**, ≈2–3× per simulated day — not on a clock. Ablation: TrueSkill μ 29.89 (full) > 26.88 (no reflection) > 21.21 (no memory/reflection/planning), full-vs-no-memory effect size **d = 8.16**, p<0.001. Retrieval score = recency (0.995/hour decay) × importance (1–10) × relevance.

The contrast is the decision: **importance-accumulation triggering is evidenced; 3 a.m. cron is exactly what produced #65550** (`harness-engineering-state-of-the-art.md` §6, §"What better means" item 6).

## Decision

**The harness owns the dreaming scheduler. It never uses a host cron, an `agentTurn` system event, or an external provisioning script.** The scheduler lives in the resident core daemon (ADR-001) and drives a **job registry fed by the PLUR1BUS engine** (`engine.jobs`, ADR-002 P5), which is the sole owner of the dreaming logic (D4, §2.1 "Doppelte Lernschleifen vermeiden"). Every run — including every skip — writes one durable record before any early return. Three phases are first-class objects with their own schedule, enable switch, status, log and "run now". Triggering is **importance-accumulation primary, cron as a floor.** Guards are mandatory, not optional: dedupe, circuit breaker, spend cap, stale-candidate expiry, minimum corpus, per-agent budget. Model-free jobs stay model-free; LLM-using jobs run on the agent's own model and credentials, never hardwired (§4.1).

### Phase mapping onto PLUR1BUS jobs

| Phase | PLUR1BUS jobs mapped | Default schedule (source) | Writes long-term memory? | New work |
|---|---|---|---|---|
| **Light** — sort short-term notes, shortlist candidates | `light-dream` (today: no cron, fire-and-forget in `agent_end`, `index.js:10951-10962`) · `classify-recent` (today `every 3h`, `feature-cron-plan.js:116`) · `afterthought` triage (today `every 3h`, `:49`) · `embedding-drain` (today `20 3 * * *` Berlin, `:91-92`) | `0 */4 * * *`, agent tz | **No.** Shortlist only | **New: a "shortlist without promotion" mode.** Light dreaming today *does* touch durable memory (`replaceLightDreamRow` delete+add, `light-dream.js:154-186`; `storeDreamAsMemory`, `:416-431`). Under the harness it writes only to the candidate table. **New: a cron** — it has none today. **New:** candidate shortlist artifact between light and deep (does not exist) |
| **REM** — reflect on themes and recurring ideas, improve ranking | `rem-dream` (`15 1 * * *` Berlin, `:125-126`) · `discover-semantic-links` (`0 2 * * *` Berlin, `:151-152`, **model-free**) · `emotion-refine` (`every 1h`, `:105`) · `persona-evolve` (`15 4 * * *`, `:37`) | `15 1 * * *`, agent tz | **No.** Patterns, links, ranking signals | **New: trends must feed recall ranking.** The writers exist (`appendPatterns`, `analyzeTrends`) but no reader was traced in `lib/recall-pipeline.js` (`plur1bus-crons-embedding-portability.md` §1 Gaps) — if nothing reads them, REM is decorative. **New:** nightly-incremental option; today REM is weekly (`getPreviousWeekWindow`, `rem-dream.js:1088`) |
| **Deep** — evaluate shortlisted candidates, promote, GC, write the diary | `consolidate-daily` (`0 4 * * *` Berlin, `:58-59`) · Schicht-1.5 / `knowledge_update` promotion (`lib/jobs/schicht15-tracker.js`) · `gc-run` (`45 4 * * *` Berlin, **`singleton: true`**, `:163-168`) · `auto-accept-stale` (`50 4 * * *`, `:71-78`) · diary write (`lib/dreaming/dream-diary.js`) | `0 4 * * *`, agent tz | **Yes — the only phase that may** | **New: one deep-sleep job with one run identity**, replacing four unrelated schedules (cause 9). **New: an explicit promotion step with a decision record per candidate.** **New: a guaranteed diary entry** (today the write is fail-open, `dream-diary.js:141-170`) |

Jobs deliberately **outside** the sleep phases and left on their own schedules: `skill-miner` (`0 5 * * *`) is procedural-memory mining with its own review queue (§8), `reminder-dispatch` and `proactive-check` are user-facing delivery, `meta-reflect` and `feedback-report` are diagnostics. They use the same registry, ledger and guards, but do not appear under "Dreams" in the UI.

### Per-phase surface (all three phases, identical shape) — satisfies D4

| Field | Notes |
|---|---|
| `cron` + `timezone` | Per phase, per agent; **timezone-aware and explicit** — never host-local-implicit. OpenClaw's default leaves `timezone: undefined` (`dreaming.ts:23`); PLUR1BUS pins `Europe/Berlin` in code (`feature-cron-plan.js:58-59`). Neither is right for a multi-user harness: default to the agent owner's timezone, stored explicitly |
| `enabled` | Per phase. **Never coupled to an unrelated switch** — cause 4 is the anti-pattern |
| `stagger` | Declarative per agent: `offsetSeconds = hash(agentId, phase) % window`. Today staggering is hand-tuned in comments (`staggerPersonaEvolveSchedule` etc., `feature-cron-plan.js:34, 75, 90`) |
| `lastRunAt` / `nextRunAt` / `lastDurationMs` | From the ledger, not from a log line |
| `lastOutcome` + `counts` | `completed \| skipped \| failed \| aborted` + `{candidates, promoted, merged, superseded, dropped, tokensIn, tokensOut, costCents}` |
| per-run log | One file per run under `<stateRoot>/dreams/<agentId>/<phase>/<runId>.log`, path recorded in the ledger row |
| `error` | Structured; a failing phase is **never** reported as `completed` (causes 7, 11; OpenClaw #143206) |
| **run now** | CLI, API and UI; takes the same guards as a scheduled run except the cron gate |
| **dream diary** | Markdown per agent, readable in the UI, one entry per deep sweep plus phase summaries — the auditable-diary rule (`harness-engineering-state-of-the-art.md` §6: "Unauditable consolidation is how OpenClaw users discovered garbage in MEMORY.md only after it had accumulated") |

### Run-state persistence (`node:sqlite`, FTS5 verified V1/V2)

```
CREATE TABLE dream_run (
  run_id           TEXT PRIMARY KEY,
  agent_id         TEXT NOT NULL,
  phase            TEXT NOT NULL CHECK (phase IN ('light','rem','deep')),
  job_id           TEXT NOT NULL,          -- rem-dream | consolidate-daily | ...
  partition        TEXT,                   -- ACL partition (agent-private | workspace | user)
  idempotency_key  TEXT NOT NULL,          -- see below
  trigger          TEXT NOT NULL CHECK (trigger IN ('cron','importance','manual','catchup')),
  scheduled_for    INTEGER, started_at INTEGER NOT NULL, finished_at INTEGER,
  outcome          TEXT CHECK (outcome IN ('completed','skipped','failed','aborted')),
  reason           TEXT,                   -- no_llm_route | too_few_memories | lock_held | ...
  counts_json      TEXT NOT NULL DEFAULT '{}',
  tokens_in INTEGER, tokens_out INTEGER, cost_micros INTEGER,
  log_path         TEXT, error_json TEXT,
  UNIQUE (idempotency_key)
);
CREATE INDEX dream_run_agent_phase_started ON dream_run(agent_id, phase, started_at DESC);

CREATE TABLE dream_schedule (
  agent_id TEXT NOT NULL, phase TEXT NOT NULL,
  cron TEXT NOT NULL, timezone TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
  stagger_offset_s INTEGER NOT NULL DEFAULT 0,
  next_run_at INTEGER, last_run_id TEXT,
  breaker_state TEXT NOT NULL DEFAULT 'closed', breaker_until INTEGER, breaker_reason TEXT,
  PRIMARY KEY (agent_id, phase)
);

CREATE TABLE dream_candidate (          -- the artifact that does not exist today
  candidate_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, partition TEXT,
  content_hash TEXT NOT NULL,           -- dedupe key
  source_run_id TEXT NOT NULL, first_seen_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  recalls INTEGER NOT NULL DEFAULT 0, unique_queries INTEGER NOT NULL DEFAULT 0,
  score REAL, state TEXT NOT NULL,      -- shortlisted | promoted | rejected | expired
  decision_json TEXT,                   -- gate-by-gate record for the promotion audit
  UNIQUE (agent_id, partition, content_hash)
);
```

The ledger row is written **before** the job body runs (`started_at`, `outcome = NULL`) and updated on exit, so a crashed run is distinguishable from a skipped one. This inverts the default the research note recommends: "every job run should append one record… *before* any early return, so that 'skipped because X' is as visible as 'completed'" (`plur1bus-crons-embedding-portability.md` §1 Inferences).

### Guards (all mandatory)

| Guard | Rule | Evidence it is needed |
|---|---|---|
| **Circuit breaker** | Per agent per sweep: max **3 LLM sessions** and max **N cost-micros** (default equivalent of $0.25/agent/day, configurable). Breach ⇒ abort the sweep, set `breaker_state='open'` until the next scheduled window, surface a visible error | #65550: 94 sessions / 65 min / $4.35, "no rate limit or circuit breaker" |
| **Dedupe** | Content-hash on every candidate (`dream_candidate.content_hash` unique per agent+partition); a candidate already processed in the current window is skipped with a counted reason | #65550 root cause 1: "same candidates reprocessed in a tight loop" |
| **Stale-candidate expiry** | `expires_at` default 72 h; expired candidates are ineligible regardless of score | #65550: stale candidates from 2–4-day-old transcripts, all `confidence 0.00, recalls 0`, stayed eligible |
| **Minimum corpus** | Deep runs only above a minimum candidate count and a minimum *fresh* fraction; below it the run records `skipped, reason=min_corpus` with counts — **not silence** | Cause 6: `too_few_memories` (<3) logs nothing today |
| **Promotion requires demonstrated utility** | Never promote `recalls = 0`; and the recall counter **must** cover the paths that can be promoted | #142393's inverted incentive — "a pure design error worth encoding as a test" (`harness-engineering-state-of-the-art.md` §"What better means" item 5) |
| **Bounded prior-entry loss** | A consolidation pass may not remove more than **25 %** of prior entries (`maxPriorEntryLossFraction` 0.25) and may not exceed **160 tokens** per promoted snippet | OpenClaw's own defaults, `dreaming.ts:47-48` |
| **No silent truncation** | If a memory file or an injected copy would be clipped, emit a visible warning and a deferral record | #142393: 9 728 B against a 9 000-char cap, tail truncated on every load |
| **Model emits operations, a validator applies them** | The consolidation model returns typed `add/merge/supersede`, never prose; a deterministic validator enforces prior-entry preservation, source attribution and size compliance; prior versions backed up | `harness-engineering-state-of-the-art.md` §6 ("Adopt exactly. Never let a model write the memory file directly") |
| **Fresh context per run** | Consolidation and diary completions never inherit a conversation session, so diary output cannot become a promotion source | ibid. |
| **Budget per agent** | Token and cost budget enforced by the scheduler before each LLM call, not requested in a prompt; charged against the agent's project/user budget (§6.1 routing budgets) | Hermes has *no* cost governance at all (`harness-engineering-state-of-the-art.md` §7) |
| **Model-free stays model-free** | `discover-semantic-links`, `gc-run`, `auto-accept-stale`, `embedding-drain`, `reminder-dispatch`, `feedback-report`, `proactive-check` take **no** LLM route (`plur1bus-crons-embedding-portability.md` §1 table). LLM-using phases use the **agent's own model and credentials** (§4.1), never a hardwired one; absence of a route is `skipped, reason=no_llm_route` with a warning and a UI badge — never a silent no-op | Cause 5 |
| **Concurrency** | Global cap of 3 concurrent phase runs; `singleton` jobs (today only `gc-run`) declared in the registry, not encoded in comments | OpenClaw's 3-slot budget, plus `feature-cron-plan.js:163-168` |

### Idempotency

`idempotency_key = sha256(phase ‖ agentId ‖ partition ‖ windowId ‖ transcriptDigest)`, where `windowId` is the phase's scheduling window (date for deep/REM, 4-hour bucket for light) and `transcriptDigest` is the digest of the corpus the run would consume. Enforced by the `UNIQUE` constraint: a second run over the same corpus in the same window is a no-op recorded as `skipped, reason=idempotent`. PLUR1BUS already has the ingredients — a `digestHash` for light dreaming (`index.js:10955`) and `runs.json completed[runKey]` for rem-dream (`lib/neo-arch.js:1916-1925`) — but the key is a bare boolean and the digest is not part of it, which is how "run completed, nothing written, every later night says `already_processed`" became possible (cause 7). Binding the key to the transcript digest means a *failed* run leaves the corpus eligible.

### Delivery, and never a host cron

Results go only to **validated targets** (§4.1): the dream diary file, the ledger, the status API, and — for phases the owner opts into — a channel message to a delivery target that passed validation. No `agentTurn` carrier: OpenClaw's managed job wakes an isolated agent turn with a magic sentinel string (`payload.kind: "agentTurn"`, `message: "__openclaw_memory_core_short_term_promotion_dream__"`, `dreaming-cron.ts:96-121`), and three of the cited issue titles describe exactly that handoff failing. PLUR1BUS's own legacy carrier form "lief zuverlässig in den 300 s-Timeout (neun Läufe in Folge, alle Agenten)" (`lib/setup/feature-cron-plugin-runtime.js:24-28`). The harness calls `engine.jobs.run(id, …)` in-process instead.

### Observability

- **Status API:** `GET /api/dreams/status[?agentId=]` → per agent per phase `{ enabled, cron, timezone, nextRunAt, lastRun: { runId, startedAt, durationMs, outcome, reason, counts, cost }, breaker }`. RBAC-scoped (§9).
- **CLI:** `plur1bus-harness dreams status [--agent A] [--json]`, `dreams run <light|rem|deep> --agent A [--dry-run]`, `dreams log <runId>`, `dreams diary --agent A`.
- **UI:** Memory → Dreams: three phase cards with badges, next/last run, counts, error state, "run now", and the diary rendered inline (§9 Memory is a main area).
- **Doctor:** `doctor` fails loudly if any enabled phase has had no run in 2× its interval — the check PLUR1BUS lacks for its own jobs, though it ships `scripts/repair-dreaming-cron.mjs` for the *host's* dreaming cron precisely because an error-latched cron "stops writing memory files entirely until reset" (`scripts/repair-dreaming-cron.mjs:1-18`).
- **Events:** typed `EngineEvent`/scheduler events so the UI streams progress rather than polling.

## Options considered

### Option A: Keep the current model — engine provisions host cron jobs via an external script

| Dimension | Assessment |
|---|---|
| Complexity | Low to build, **high to operate** |
| Fit with brief D1–D11 | **Violates D4** ("own scheduler, never host cron") |
| Cross-platform risk | High: depends on host CLI `--help` string matching (cause 2), `process.execPath` byte-exact argv comparison that breaks on Windows paths (`lib/setup/feature-cron-native.js:68-77`), and four `bash` scripts |
| Maintenance burden | Every host CLI change can silently disable dreaming |
| Latency / token cost | Neutral, but the 600 s job timeout and 540 s RPC timeout invite 994 s hangs (#147157) |

**Pros:** exists. **Cons:** it is the thing that failed; eleven documented causes above.

### Option B: Harness-owned scheduler + engine job registry (recommended)

| Dimension | Assessment |
|---|---|
| Complexity | Medium: a cron evaluator with timezones, a ledger, guards, and a UI. No new IPC — `engine.jobs.run()` is in-process (ADR-002) |
| Fit with brief D1–D11 | **Exactly D4.** Also D9 (model-free jobs use the engine's embedder), D6 (background work is off the turn's critical path) |
| Cross-platform risk | Low: no host CLI, no shell scripts, no argv round-tripping. The one platform concern is timezone handling, which is Node-native |
| Maintenance burden | Ours, but small and testable; the guards are unit-testable in isolation |
| Latency / token cost | Controlled by construction: spend cap + breaker + budget per agent are scheduler-level, not prompt-level |

**Pros:** every failure becomes a record; "run now" and "why did nothing happen" are answerable; PLUR1BUS stays the sole owner of the logic (no second loop).
**Cons:** we own cron semantics (DST, catch-up after downtime, clock changes) — a classic source of subtle bugs; the ledger is new persistent state to migrate and back up.

### Option C: One consolidated sweep job, OpenClaw-style (one cron triggers all three phases in sequence)

| Dimension | Assessment |
|---|---|
| Complexity | Lowest of the three |
| Fit with brief D1–D11 | **Partially violates D4**, which requires *per-phase* schedule and enable switch |
| Cross-platform risk | Same as B |
| Maintenance burden | Low |
| Latency / token cost | One long run instead of three short ones; harder to bound |

**Pros:** removes the "N jobs get out of sync" class; it is what OpenClaw converged on after starting with three separate jobs (`LEGACY_MEMORY_*_CRON_NAME` constants, `dreaming.ts:31-36`).
**Cons:** "concentrates all three phases' failure modes onto a single trigger path — if the one system event never fires, *no* phase runs at all", which matches #62920/#62296/#62857 (`openclaw-layout-dreaming-ui.md` §2 Inferences). D4 requires per-phase control anyway.

**Recommendation: B, taking C's lesson as a constraint** — phases are independently scheduled, but a *deep* run consumes the candidate table produced by *light*, so a deep run with no fresh light output records `skipped, reason=no_candidates` instead of doing nothing quietly.

### Triggering: cron floor plus importance accumulation

Primary trigger is **accumulated importance** in the style of Generative Agents (threshold on summed importance of recent events; the paper uses 150 and fires ≈2–3× per simulated day). Cron is a **floor**, not the driver: if the threshold has not been reached by the scheduled window, the phase runs anyway at reduced scope (or records `skipped, reason=below_threshold`, per phase policy). This is rule 6 of the "better than OpenClaw" list: "Consolidation is importance-triggered, not cron-triggered, with cron only as a floor. Removes the whole class of '3 a.m. job chewed stale candidates'" (`harness-engineering-state-of-the-art.md`). Sleep-time compute's caveat applies and is why the floor exists: gains depend on **query predictability**, so a corpus nobody queries should not be consolidated aggressively ([arXiv 2504.13171](https://arxiv.org/abs/2504.13171)).

## Acceptance tests (D4's "demonstrably work")

| # | Test | Pass condition |
|---|---|---|
| **A1** | **Fresh install, 24 h.** Install, create one agent, hold three short conversations, wait 24 h (or run the clock forward in CI) | `dreams status` shows a `lastRunAt` for **all three phases** with a non-null `outcome`, and the diary file exists and is non-empty. No manual step, no repair script |
| **A2** | **A failing phase shows an error, not `completed`.** Remove the agent's LLM route, force a deep run | Ledger row `outcome='skipped', reason='no_llm_route'`; UI badge visible; `doctor` warns. **Never** `completed`. Variant: make the diary write fail ⇒ `outcome='failed'`, error recorded, diary failure not swallowed (causes 7, 11) |
| **A3** | **Cost cap trips.** Set the per-agent sweep cap to 2 sessions; seed enough candidates for 10 | Run aborts after 2 sessions with `outcome='aborted', reason='breaker_cost'`; `breaker_state='open'`; total spend ≤ cap; nothing written to long-term memory from the aborted portion. This is the #65550 regression test |
| **A4** | **Second run is idempotent.** Run deep twice over the same corpus in the same window | Second run `skipped, reason='idempotent'`; zero LLM calls; zero new promotions; no duplicate diary entry |
| **A5** | **Promotion requires utility.** Seed a candidate with `recalls=0` and a high raw score | Not promoted; `decision_json` records which gate rejected it. Seed one with `recalls≥3` and `unique_queries≥3` ⇒ promoted, and the promotion is visible in the diary with its source attribution (#142393) |
| **A6** | **No host cron, ever.** Static check plus runtime assertion | No `cron add`/`schtasks`/`crontab` invocation anywhere in the harness; the scheduler's only external effect is the ledger and the diary |
| **A7** | **Staggering.** 20 agents, same phase, same window | Start times spread across the stagger window; global concurrency never exceeds 3 |
| **A8** | **Downtime catch-up.** Stop the daemon across a scheduled window, restart | Exactly **one** catch-up run per missed window (`trigger='catchup'`), not one per missed tick |

## Trade-offs

The scheduler is not hard; the honesty is. Every one of the eleven PLUR1BUS causes and most of the OpenClaw issues are the same bug shape: *a failure that produces no durable evidence*. The cost of the design above is that the harness writes a row for every no-op, keeps a candidate table, and refuses to promote things that look useful but have never been recalled — all of which make dreaming *less* productive in the short term and much more trustworthy. Given that OpenClaw publishes **no** quality measurement for dreaming while documenting the mechanism in unusual detail (`harness-engineering-state-of-the-art.md` §"hype vs holds up"), trustworthiness is the right thing to optimise first.

The second trade-off is scope: importance-accumulation triggering requires an importance signal per captured memory. PLUR1BUS already computes importance and refines it (`emotion-refine`, tier-3 classifier, `index.js:8096-8192`), so the signal exists — but wiring it into a trigger is new work, and if it slips, the cron floor alone is a working (if inferior) system.

## Consequences

- **Easier:** "did it run, and what happened?" is one CLI command; a fresh install produces visible dreaming within a day; cost is bounded by construction; the same ledger serves the UI, the API, `doctor` and the audit trail; the OpenClaw plugin inherits the structured `JobResult` and run ledger through ADR-002 P5, so dreaming becomes observable there too.
- **Harder:** we own cron semantics including DST and catch-up; there is new persistent state to back up and migrate (§11 backup takes stores first, then this); a per-run log file per phase per agent needs a retention policy; the promotion gates will reject material that "feels" useful, which will generate support questions; the importance-trigger depends on an importance signal whose calibration is not yet validated for our corpus.
- **Revisit when:** (a) A1 passes but the diary is judged worthless — then the problem is phase content, not scheduling, and ADR-003/ADR-006 own it; (b) the importance threshold proves untunable across agents — fall back to cron-only and record it; (c) REM trends turn out never to be read by the recall ranker (see conflict C2) — then REM's value proposition has to be re-argued before it keeps a schedule.

## Conflicts with the brief

**C1 — D4 says "PLUR1BUS is the sole owner of the dreaming logic (`rem-dream`, `consolidate-daily`, `classify-recent`, …); no second loop." Two of the three phases cannot be served by existing PLUR1BUS jobs without new engine code.**
*Finding:* Light sleep as the brief defines it ("sort short-term notes, shortlist candidates", not touching long-term memory) does not exist: `lightDream` has no cron, dies with the process, and **does** write durable memory (`replaceLightDreamRow` delete+add, `lib/dreaming/light-dream.js:154-186`; `storeDreamAsMemory`, `:416-431`). Deep sleep as a single job does not exist at all — promotion, compaction, GC and diary are four unrelated schedules with no shared run identity. And there is **no candidate shortlist artifact** between the phases (`plur1bus-crons-embedding-portability.md` §1 mapping table and its closing list (a)–(e)).
*Source:* `lib/dreaming/light-dream.js:154-186, 416-431`; `index.js:10951-10962, 7501-7631, 8056-8070`; `plur1bus-crons-embedding-portability.md` §1.
*Options:* (1) add the missing pieces as PRs to the PLUR1BUS engine (shortlist-only light mode, candidate table, one deep-sleep job with a shared run identity) so PLUR1BUS remains the owner; (2) implement the shortlist and the deep orchestration in the harness scheduler, leaving PLUR1BUS as a library of steps — which creates the second loop D4 forbids; (3) redefine the phases to match what exists.
*Recommended resolution:* **(1).** The scheduler orchestrates; the engine owns every step and the candidate table. This keeps D4 literally true, and the OpenClaw plugin gains the same capability. It does mean ADR-002's P5 grows: the job registry must ship *with* the new light-shortlist mode and the deep composite job, not just wrap the existing eleven.

**C2 — "REM improves ranking" is unverified in the code.**
*Finding:* REM writes patterns and trends (`appendPatterns`, `analyzeTrends` against the previous week — `rem-dream.js:1088`, `:1326-1342`), but no reader of those trends was found in `lib/recall-pipeline.js`; the research note records this explicitly as not established.
*Source:* `plur1bus-crons-embedding-portability.md` §1 Gaps ("Whether REM trend output actually influences recall ranking is not established").
*Options:* (1) trace it before M1 and, if there is no reader, wire trends into the recall ranker as part of the REM phase's definition of done; (2) keep REM as a diary/narrative feature only and say so; (3) drop REM.
*Recommended resolution:* **(1), as a blocking investigation before the REM phase gets a schedule.** A phase that costs LLM calls nightly and demonstrably changes nothing is the exact failure #65550 describes in extreme form.

## Open questions for the owner

1. **Q1 — default cost cap.** Proposed: **$0.25 per agent per day** across all phases, hard-aborting. Too low, too high, or should it be a token cap instead (more predictable, less meaningful)?
2. **Q2 — importance trigger vs cron floor.** Ship both in M1, or cron-only in M1 with importance triggering in a later milestone? Importance triggering is the evidenced design but depends on calibrating a threshold (Generative Agents used 150 on a different corpus).
3. **Q3 — promotion target.** OpenClaw's deep phase promotes into `MEMORY.md`; **`MEMORY.md` does not exist anywhere in the PLUR1BUS codebase** (`plur1bus-crons-embedding-portability.md` §1 Gaps), and PLUR1BUS's own curated file is `memory/KNOWLEDGE.md` (`index.js:3921`). Should deep sleep promote into `KNOWLEDGE.md`, into durable memory cards, or into both?
4. **Q4 — timezone default.** Agent owner's timezone, installation timezone, or UTC? PLUR1BUS hardcodes `Europe/Berlin` in several specs; OpenClaw leaves it unset (host-local).
5. **Q5 — diary scope.** Today the diary is written only for agent/agent-private scopes and skipped for `workspace`/`user` (`rem-dream.js:1339`, `light-dream.js:433`). Should workspace-scoped dreaming get its own shared diary visible to project members, or stay private?
6. **Q6 — light-dream cadence.** Proposed `0 */4 * * *`. Alternative: keep an *additional* post-session light pass (as today, but recording to the candidate table only and writing a ledger row). Both, or cron only?
7. **Q7 — retention.** Per-run logs and ledger rows: how long? Proposal — ledger 365 days, logs 30 days, diary forever.

## Action items

1. [ ] Trace whether anything in `lib/recall-pipeline.js` reads REM trends (conflict C2) and record the answer in `docs/engine-extraction.md` — **blocking** for giving REM a schedule.
2. [ ] Specify the `JobSpec`/`JobResult` types with the run ledger in ADR-002 P5, including the "write the row before any early return" rule, and land them before any scheduler code.
3. [ ] Open PLUR1BUS issues for the three missing pieces (conflict C1): shortlist-only light mode, `dream_candidate` table, single deep-sleep composite job with one run identity.
4. [ ] Write A1–A8 as executable tests **before** the scheduler, with a virtual clock; A1 and A3 are the two that would have caught the historical failures.
5. [ ] Verify the current status of OpenClaw issues #65550, #142393, #147157, #62920, #62296, #62857, #65412, #143206 via `gh api` and record open/closed/fixed-in-version — the research note explicitly flags their status as unverified.
6. [ ] Define the importance signal contract with ADR-003 (what increments it, per capture) so Q2 can be answered with a number rather than a guess.
7. [ ] Add `dreams` to the CLI command list in ADR-001's layout and to §9's UI page list (Memory → Dreams), and add the dream ledger to §11's backup order after the stores.
