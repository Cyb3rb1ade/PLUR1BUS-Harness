# RE-06 — Job registry, the 19 jobs, prompts, dreams, afterthought, skill-miner

**Package.** `Engine::jobs()`: the registry with run state, locks and history, the versioned prompt layer with the
stable-prefix layout, and the nineteen job bodies in four groups — at parity on recorded LLM fixtures, with CP-1, CP-3,
CP-6 and CP-7 built in. Size XL; seven tasks, one pull request each. **This package starts only after the go/no-go
in T0** (RE-D5): the deterministic core (RE-02…RE-05, RE-07, RE-08) must be at parity first, because every job here
reads and writes what those packages own.

**Depends on.** RE-05, RE-07, RE-03 (`LlmPort` is a host port from RE-01; the result cache from RE-02). **Enables.**
Phase 1 exit.

**Assumes.** RE-D5 (staged, go/no-go). An unported job is reported, never silently skipped (see T1).

**Read first.**
- Plan §3.1 (CP-1), §3.3 (CP-3), §3.7 (CP-6), §3.8 (CP-7), RE-6 in §4; ADR-009 and `docs/dreams.md` (the harness
  scheduler owns *when*, the engine owns *what*; never a host cron).
- Engine at `98dfe2f`:

| Group | Files | Lines |
|---|---|---|
| registry | `engine/jobs/job-registry.js` (names → bodies, run state, history, `JobRun`), `engine/jobs/internal-job-bodies.js` (`createInternalJobBodies(ctx)`), `lib/job-lock.js` (replaced by RE-02 `JobLock`) | 635 + 993 + 76 |
| LLM plumbing | `lib/llm-router.js` (routes, limits — CP-1 changes on the plugin line), `engine/runtime/llm-calls.js`, `lib/featureModels.js`, `lib/chat-model.js`, `lib/local-model-generation.js`, `lib/llm-result-cache.js` (RE-02) | 517 + 248 + 272 + 155 |
| maintenance | `lib/jobs/daily-consolidation.js`, `consolidation-report.js`, `memory-compaction.js`, `memory-dynamics-maintenance.js`, `gc-job.js`, `auto-accept-stale-criticals.js`, `conflict-resolver.js`, `apply-conflict-resolution.js`, `critical-classifier.js`, `schicht15-tracker.js`, `lib/episodes.js` (rebuild), `lib/obsidian/semantic-link-discoverer.js` + `engine/runtime/semantic-discovery.js` (discover-semantic-links) | 580 + 107 + 1,550 + 559 + 241 + 115 + 292 + 76 + 325 + 120 + 987 |
| reflection | `lib/afterthought.js` (main) and plugin-line `lib/afterthought-reflection.js`, `afterthought-host.js`, `afterthought-hooks.js` (CP-3), `lib/meta-cognition.js`, `lib/persona-voice.js`, `lib/emotion-*.js` (refine), `lib/jobs/reflection-job.js`, `lib/jobs/proactive-check.js` + `lib/proactive-governor.js` + `lib/proactive-nudge.js`, `lib/jobs/reminder-dispatch.js`, `lib/feedback-log.js` + `lib/jobs/feedback-analyzer.js` | 191 + 380 + 698 + 122 + 205 + 312 + 156 + 142 + 264 + 36 |
| dreams | `lib/dreaming/rem-dream.js`, `light-dream.js`, `dream-narrative.js`, `dream-diary.js`, `dreaming-status-provider.js` | 1,534 + 635 + 339 + 206 + 175 |
| skill-miner | `lib/jobs/skill-miner.js` (main) and plugin-line `lib/jobs/skill-miner.js` + `lib/jobs/skill-miner/candidate-matching.js` (CP-7) | 849 + … |

  The job name → body mapping is built in `job-registry.js`/`internal-job-bodies.js`; read it and write the table into
  T1's PR before porting (the nineteen names: `persona-evolve afterthought consolidate-daily auto-accept-stale
  embedding-drain emotion-refine post-turn-refine classify-recent rem-dream skill-miner discover-semantic-links gc-run
  reminder-dispatch feedback-report proactive-check meta-reflect skill-benefit-backfill episodes-rebuild light-dream`).
- Engine tests: `tests/skill-*.test.js` (16), `tests/rem-*.test.js` (7), `tests/critical-*.test.js`, `tests/reminder-*.test.js`,
  `tests/llm-*.test.js`, `tests/importance-*.test.js`, `tests/feature-*.test.js`, `tests/post-turn-queue.test.js`.
- Harness: `packages/core/src/dreams/` (scheduler, ledger, guards — stays in the core in Phase 1; it calls
  `jobs.run("rem-dream" | "light-dream", trigger: "harness")`), `packages/core/src/system-jobs/` (the periodic runner
  that calls `jobs.run` for maintenance), `packages/core/src/prompt/` (ADR-010 zones and breakpoints — the harness's
  own prompt builder; the engine's layout mirrors its breakpoint semantics), `docs/decision-service.md` (the decision
  role CP-1's reasoning flag belongs to), `packages/providers/README.md` (`ProviderError` names).

**Rules that apply.** No job prompt is an inline string: every prompt is a versioned template file with a golden hash.
Every job is idempotent per run window and reports `skipped: "already-running"` on overlap (CP-6). A retryable LLM
failure is never cached as a negative decision (CP-7 and coding-standard §6.4). A job that this package has not ported
yet is listed with `available: false, reason: "not-implemented"` and refused by `run` with `E_NOT_AVAILABLE`.

## Files

- Create: `src/jobs/{mod,registry,run_state,history,window,outcome}.rs`, one file per job under `src/jobs/bodies/`
  (`persona_evolve.rs`, `afterthought/mod.rs` + `quiet_window.rs` + `state.rs`, `consolidate_daily.rs`, …,
  `skill_miner/{mod,decision_cache,fingerprint,catalogue,evidence,supersede}.rs`, `dreams/{rem,light,narrative,diary}.rs`),
  `src/prompt/{mod,layout,params,templates.rs}` and `src/prompt/templates/*.v<N>.txt`, `src/llm/{mod,purpose,router_requirements}.rs`,
  `tests/jobs_registry.rs`, `tests/prompt_layout.rs`, `tests/jobs_maintenance.rs`, `tests/jobs_reflection.rs`,
  `tests/jobs_skill_miner.rs`, `tests/jobs_dreams.rs`, `tests/fixtures/jobs/{record.mjs,llm/*.json,golden/*.json}`,
  `tests/fixtures/prompts/hashes.json`
- Modify: `src/lib.rs`, `docs/engine-stores.md` (`run-state.json`, history, the afterthought state file), `docs/dreams.md`
  (which steps the engine performs; unchanged scheduler)
- Test: the six Rust test files and the fixtures

## Interfaces

**Consumes:** RE-01 `JobRegistry`, `JobSpec`, `JobRun`, `JobOutcome`, `JobTrigger`, `JobCost`, `LlmPort`, `LlmParams`,
`LlmResult`; RE-02 `Store`, `LlmResultCache`, `JsonlLedger`, `StateFile`, `JobLock`; RE-04 `recall()` (jobs that recall);
RE-05 capture internals (`dynamics`, `episodes`, `reconsolidate`, pending rows); RE-07 ops (`forget`, `share`).

**Produces:**

```rust
// src/jobs/registry.rs
pub struct Registry; impl JobRegistry for Registry { /* list, run, history as RE-01 */ }
pub trait JobBody: Send + Sync { fn spec(&self) -> JobSpec; fn run(&self, ctx: &JobContext, cancel: &Cancel) -> Result<JobReport, EngineError>; }
pub struct JobContext<'a> { pub agent: &'a AgentId, pub trigger: JobTrigger, pub dry_run: bool, pub deps: &'a EngineDeps<'a>, pub llm: Option<&'a dyn LlmPort>, pub cache: &'a LlmResultCache, pub now_ms: i64 }
pub struct RunWindow; // run-state.json keyed (job, agent, window start); CP-6: a second run inside an active window answers skipped/already-running

// src/prompt/layout.rs — CP-3b; every job prompt is built through this
pub struct Layout { pub stable: Vec<Segment>, pub volatile: Vec<Segment> }
impl Layout { pub fn render(&self) -> Rendered; }   // Rendered { text, breakpoints: Vec<usize> /* exactly one */, stable_hash: String }
pub struct Template { pub name: &'static str, pub version: &'static str, pub text: &'static str } // include_str! from templates/
pub fn template(name: &str) -> &'static Template;

// src/prompt/params.rs — CP-1 ceilings live here, per purpose
pub fn params_for(purpose: Purpose) -> LlmParams;  // max_tokens: the Node value after 7.18.23 (450 / 24 where it raised them), reasoning: None except where the Node engine sets it, cache_breakpoints from Layout
pub enum Purpose { Afterthought, Consolidation, ImportanceRefine, EmotionRefine, Classify, RemDream, LightDream, SkillMine, SkillSupersede, MetaReflect, PersonaEvolve, Proactive, FeedbackReport, ChunkDecide, RecallPrefilter /* … one per LLM call site */ }

// src/jobs/bodies/skill_miner/decision_cache.rs — CP-7
pub struct DecisionCache; impl DecisionCache { pub fn get(&self, fp: &ClusterFingerprint, now: i64) -> Option<Decision>;
    pub fn put_definitive(&self, fp: &ClusterFingerprint, d: Decision, now: i64) -> Result<(), EngineError>;  // TTL 7 days, CACHE_VERSION 2
    pub fn skip_retryable(&self, fp: &ClusterFingerprint, err: &LlmFailure); }  // writes nothing
pub fn cluster_fingerprint(cluster: &[MemoryRow]) -> ClusterFingerprint;  // permutation-invariant
```

## Tasks

### T0 — Go/no-go (no code; the controller records the decision in the README status table)

- [ ] RE-09's parity report shows every scenario of RE-04, RE-05 and RE-07 green on the current heads; `tests/system`
  passes with `PLUR1BUS_ENGINE_IMPL=rust` except the suites that need jobs (`dreams.test.ts`, the job parts of
  `model-discovery.test.ts`).
- [ ] The owner confirms the port of the LLM-driven jobs (RE-D5); otherwise the Rust engine stays opt-in with jobs
  reported `not-implemented` and this brief waits.

### T1 — Registry, run state, locks, history; every job listed (one pull request)

- [ ] **Step 1: failing tests** `tests/jobs_registry.rs`: `list_names_all_nineteen_jobs_with_the_node_specs` (golden
  `record.mjs --specs`: `needsLlm`, `singleton`, `defaultSchedule`, `phase` per job), `an_unported_job_is_listed_unavailable_and_run_refuses_it`,
  `two_concurrent_runs_of_one_job_produce_one_run_record_and_one_skipped` (CP-6), `history_returns_runs_newest_first_with_the_filter`,
  `a_run_record_has_every_field_of_the_node_job_run` (round-trip against `record.mjs --run`), `dry_run_writes_nothing_but_a_run_record`.
- [ ] **Step 2: implement** `registry.rs`, `run_state.rs` (`run-state.json` shape from the Node file — RE-02 `StateFile`),
  `window.rs`, `history.rs` (where the Node engine keeps history — read `job-registry.js`; same file, same shape),
  `outcome.rs` (`completed | skipped | incomplete | failed | abandoned` and `reason`), the `JobBody` trait and a
  `NotImplemented` body for every name until its task lands.
- [ ] **Step 3: commit** `RE-06/T1: job registry, run state, history`.

### T2 — Prompt layer and LLM parameters (one pull request)

- [ ] **Step 1: extract.** For every LLM call site in the job files, copy the prompt text into
  `src/prompt/templates/<purpose>.v<N>.txt` with the version the Node code carries (skill-miner: `"3"`, CP-7; others:
  `"1"` unless the file names one). `tests/fixtures/prompts/hashes.json` holds `sha256` per template, recorded from the
  Node strings by `record.mjs --prompts` (the recorder renders each Node prompt with empty volatile input).
- [ ] **Step 2: failing tests** `tests/prompt_layout.rs`: `every_template_hash_equals_the_recorded_node_prompt`,
  `render_emits_exactly_one_breakpoint_between_stable_and_volatile`, `the_stable_hash_is_identical_across_two_different_transcripts`
  (CP-3b), `params_for_each_purpose_match_the_table` (a table test with the CP-1 values: the purposes whose ceilings
  moved to 450 and 24 tokens — read `lib/llm-router.js` on `v7.18.31` to assign them — and `maxChars / 2` for the summary
  budget), `no_purpose_sets_reasoning_except_the_node_ones`, `result_cache_key_includes_purpose_model_template_version_and_input_hash`.
- [ ] **Step 3: implement** `layout.rs`, `templates.rs`, `params.rs`, `llm/router_requirements.rs` (the engine states
  purpose, class and ceilings; routing stays the host's).
- [ ] **Step 4: commit** `RE-06/T2: prompt layer, parameters, result-cache keys`.

### T3 — Maintenance group (one pull request)

Jobs: `consolidate-daily`, `auto-accept-stale`, `embedding-drain`, `gc-run`, `episodes-rebuild`, `classify-recent`,
`discover-semantic-links`, `skill-benefit-backfill`.

- [ ] **Step 1: goldens** per job from `record.mjs --job <name>`: the store delta (rows added/patched/deleted by id and
  column), the ledger lines, the `JobRun` counts, on a prepared fixture store with recorded LLM answers where the job
  needs them.
- [ ] **Step 2: failing tests** `tests/jobs_maintenance.rs`: one `…_matches_the_golden_delta` per job plus
  `gc_run_never_touches_a_row_with_never_forget`, `consolidate_daily_respects_the_knowledge_update_budget`,
  `discover_semantic_links_is_bounded_by_the_configured_limit`.
- [ ] **Step 3: implement** one body per job; the `semantic-link-discoverer` port covers only the link discovery, not
  the vault writing (that is RE-07 T7's optional bridge).
- [ ] **Step 4: commit** `RE-06/T3: maintenance jobs`.

### T4 — Reflection group (one pull request)

Jobs: `afterthought` (CP-3), `meta-reflect`, `persona-evolve`, `emotion-refine`, `post-turn-refine`, `feedback-report`,
`proactive-check`, `reminder-dispatch`.

- [ ] **Step 1: failing tests** `tests/jobs_reflection.rs`: the CP-3 state machine
  (`no_run_at_14_59_quiet`, `run_at_15_00_quiet`, `no_run_at_120_01_quiet`, `no_second_run_in_the_same_window`,
  `the_daily_cap_holds`, `request_summary_window_and_chunk_limits_are_60000_12000_16000_32000`), `afterthought_state_file_is_the_node_shape`
  (`.afterthought-reflection.json`), `post_turn_refine_finalises_pending_rows_and_only_those`, `reminder_dispatch_marks_dispatched_and_counts_attempts`
  (`dispatchCount`, `lastDispatchAttemptAt`, `nextDispatchAttemptAt`), and one golden-delta test per remaining job.
- [ ] **Step 2: implement** the bodies; `afterthought/quiet_window.rs` with the constants as `const` (MIN 15 min, MAX
  120 min, REQUEST 60 000, SUMMARY 12 000, RECENT 16 000, CHUNK 32 000).
- [ ] **Step 3: commit** `RE-06/T4: reflection jobs`.

### T5 — Skill-miner (one pull request)

- [ ] **Step 1: failing tests** `tests/jobs_skill_miner.rs`: `a_retryable_failure_leaves_no_cache_row`,
  `a_definitive_decision_is_served_for_seven_days_and_gone_after`, `a_version_1_cache_row_is_ignored`,
  `cluster_fingerprint_is_permutation_invariant`, `the_prompt_sees_only_related_skills` (catalogue selection golden),
  `supersede_chain_a_a1_a2_leaves_one_active_skill_with_links`, `the_extraction_prompt_is_version_3_and_matches_its_hash`,
  `evidence_groups_equal_the_golden`.
- [ ] **Step 2: implement** from the plugin-line files (`v7.18.31`: `lib/jobs/skill-miner.js`, `candidate-matching.js`)
  — they supersede `main`'s version for this job.
- [ ] **Step 3: commit** `RE-06/T5: skill-miner with decision cache v2`.

### T6 — Dreams (one pull request)

- [ ] **Step 1: failing tests** `tests/jobs_dreams.rs`: `rem_dream_writes_the_narrative_and_diary_as_the_golden`
  (recorded LLM answers), `a_run_without_a_narrative_is_not_marked_complete` (f.3), `light_dream_respects_diary_from_user_chats`,
  `dreams_run_only_with_trigger_harness_or_manual` (never self-scheduled), `diary_entries_are_readable_by_the_core_reader`
  (`packages/core/src/dreams/` reads the diary — keep its format).
- [ ] **Step 2: implement** `dreams/{rem,light,narrative,diary}.rs`; status through `dreaming-status-provider.js`'s shape.
- [ ] **Step 3: commit** `RE-06/T6: dreams`.

### T7 — Parity report and docs (folded into T6's pull request)

- [ ] RE-09 scenario set `jobs/*` recorded and green; `docs/dreams.md` and `docs/engine-stores.md` updated; the
  README status table shows RE-06 complete with the owner's go decision date.

## Acceptance

- `list()` returns nineteen specs equal to the Node specs; no `not-implemented` entry remains after T6.
- Every golden-delta test green; every template hash equal to its Node prompt; CP-1, CP-3, CP-6, CP-7 tests green.
- `tests/system/dreams.test.ts` and `model-discovery.test.ts` pass with `PLUR1BUS_ENGINE_IMPL=rust`.

## Out of scope

The scheduler (harness, ADR-009; moves in RE-10); the Obsidian vault writers (RE-07 T7, optional); model routing
(host); the push buttons (adapter).

## Hand-off

T0 is a controller decision, not a PR. T1 and T2 first (T2 is consumed by every body); T3–T6 can run in parallel on
separate branches once T2 merged. Each body PR carries its golden recorder invocation in the description.
