# RE-04 — Recall pipeline

**Package.** `Engine::recall` end to end: the request context and ACL, the twelve stages, the namespace fan-out and
merge, the time and character budgets, the decision trace, and the rendering of the six context blocks — at parity
with the Node engine on the recorded scenarios, with the 7.18.28 rules (CP-5) and the prefilter seam (CP-4a) built in.
Size XL; six tasks, each one pull request.

**Depends on.** RE-02 (`Store`, `RowFilter`, `patch`), RE-03 (`EmbeddingProvider`, `Reranker`, `EmbeddingCache`),
RE-01 (types, `Cancel`, `HostServices`). **Enables.** RE-05 (shares `src/context.rs`), RE-08 (the first end-to-end
recall), RE-09 (goldens).

**Assumes.** Nothing beyond RE-D3/RE-D4. The prefilter (CP-4a) is wired but has no configuration key in Phase 1 (see T3);
it becomes configurable when the engine-config schema moves into this crate (RE-11).

**Read first.**
- Plan §3.4 (CP-4a), §3.6 (CP-5, eight rules), RE-4 in §4, review-focus items 1 and 3, the engine repository's
  `docs/recall-architecture.md` (the stage list; note the ACL position differs here, see T3).
- Engine at `98dfe2f`, in reading order:

| File | Lines | Holds |
|---|---|---|
| `lib/recall-pipeline.js` | 2,225 | the stages, candidate budget, scoring, graph hydration, rerank, dedupe, finalisation |
| `lib/recall-budget.js` | 152 | `applyRecallBudget` (tiers; `preserveOrder` is the 7.18.28 addition on the plugin line) |
| `engine/recall/namespace-recall.js` | 285 | fan-out over tables, settle-all, global merge, provenance labels |
| `lib/multi-namespace-pool.js` | 576 | the `namespaces` routes (which tables a recall reads) |
| `engine/recall/assemble-prompt-context.js` | 1,338 | the six blocks, caps, deferrals, boosters, diagnostics |
| `engine/recall/recall-params.js`, `recall-result.js`, `neo-prelude.js`, `system-supplement.js`, `warm-recall-path.js` (169), `minimal-maintenance.js` (154) | — | parameters, result shape, the `neo` block, `systemSupplement`, the warm-only path |
| `lib/recall-decision-trace.js` | 548 | the capped trace helpers; `recall.decisionTrace` |
| `lib/memory-graph.js`, `lib/graph-index.js` | 1,078 + 78 | associative spread and hydration |
| `lib/acl-middleware.js` | 240 | agent, workspace, user-owner, scope checks; denial logging (default off today — f.11) |
| `lib/memory-request-context.js` | 1,482 | principal and agent → `ownerUserId`, workspace ids, scope filter; `:332-334` the principal hash `packages/core/src/principal.ts` mirrors |
| `lib/temporal-parser.js`, `lib/temporal-filter.js`, `lib/temporal-context.js`, `lib/temporal-provenance.js` | 184 + 92 + 163 + 323 | time expressions, the temporal filter and block |
| `lib/conversation-reactivation-recall.js` | 962 | the reactivation booster (additive caller stage) |
| `lib/contradiction-disclosure.js`, `lib/drop-injected-conflicts.js`, `lib/memory-text-contradiction.js` | 58 + 114 + 69 | contradiction handling in the result |
| `engine/knowledge/knowledge-pending.js`, `lib/knowledge-update-budget.js`, `lib/knowledge-pending-prune.js` | 281 + 74 + 51 | canonical KNOWLEDGE.md chunks and their cache |
| `lib/semantic-lens-index.js` | 245 | the `semanticLens` index consulted during recall |
| `lib/emotional-state.js`, `lib/mood-style-directive.js`, `lib/persona-voice.js` | 607 + 131 + 698 | mood and persona text that enters the `start` block |
| plugin line `v7.18.31`: `lib/jev-recall-filter.js`, `lib/recall-pipeline.js` + `lib/recall-budget.js` diff `98dfe2f..v7.18.31` | — | CP-4a and CP-5 |

- Engine tests to translate into scenarios: the 29 `tests/recall-*.test.js` files, in particular
  `recall-golden-set*.test.js`, `recall-golden.test.js`, `recall-pipeline-budget.test.js`, `recall-pipeline-soft-budget.test.js`,
  `recall-pipeline-timeout.test.js`, `recall-cap-after-rerank.test.js`, `recall-pipeline-graph-hydration-relevance.test.js`,
  `recall-decision-trace*.test.js`, `recall-pipeline-read-only.test.js`.
- Harness: `packages/core/src/rpc/methods.ts` (how `memory.recall` maps the hard budget to `degraded.reason:
  "timeout"` vs `"aborted"`, 2a-H3b-b), `packages/core/src/principal.ts` (the principal hash), `docs/host-contract.md` (b)
  (400 ms `timing.totalMs`, 600 ms CLI wall), AGENTS.md on `PLUR1BUS_CI_RECALL_HARD_MS`.

**Rules that apply.** The ACL runs before any provider sees a row (review-focus 3) — no exception for "just a rerank".
Every stage checks `cancel` at its boundary; an overrun answers `degraded`, never an error. Texts never enter the
trace beyond the configured cap; secrets and tokens never.

## Files

- Create: `src/context.rs`, `src/recall/{mod,pipeline,stages,candidates,acl,temporal,knowledge,score,graph,budget,
  filter,rerank,dedupe,namespaces,merge,render,blocks,boosters,trace,timing,degraded}.rs`, `tests/recall_context.rs`,
  `tests/recall_acl.rs`, `tests/recall_stages.rs`, `tests/recall_rerank.rs`, `tests/recall_namespaces.rs`,
  `tests/recall_render.rs`, `tests/recall_budget.rs`, `tests/fixtures/recall/{record.mjs,scenarios/*.json,golden/*.json}`
- Modify: `src/lib.rs` (module wiring), `docs/engine-stores.md` (the retrieval ledger line shape)
- Test: the seven Rust test files; the scenario and golden fixtures

## Interfaces

**Consumes:** RE-01 `RecallQuery`, `RecallOptions`, `RecallResult`, `ContextBlock`, `Deferral`, `Degraded`,
`RecallTiming`, `DecisionTrace`, `PerCallDiagnostic`, `Principal`, `AgentContext`, `Cancel`, `HostServices`;
RE-02 `Store::{search, get, scan, patch}`, `RowFilter`, `JsonlLedger`; RE-03 `EmbeddingProvider`, `Reranker`,
`EmbeddingCache`.

**Produces:**

```rust
// src/context.rs — shared with RE-05 and RE-07
pub struct RequestContext { pub agent_id: AgentId, pub workspace_id: String, pub workspace_key: String,
    pub owner_user_id: String, pub visible_scopes: Vec<MemoryScope>, pub principal_key: String }
impl RequestContext { pub fn build(p: &Principal, a: &AgentContext, host: &dyn HostServices) -> Result<Self, EngineError>; }
pub fn principal_key(channel: &str, account_id: &str, user_id: &str) -> String; // sha256 hex of JSON.stringify([channel, accountId, userId]), as principal.ts

// src/recall/mod.rs
pub struct RecallDeps<'a> { pub stores: &'a dyn StoreRoutes /* tables for this agent, RE-02 + namespaces */,
    pub embedder: &'a dyn EmbeddingProvider, pub reranker: Option<&'a dyn Reranker>, pub cache: &'a EmbeddingCache,
    pub host: &'a dyn HostServices, pub filter: Option<&'a dyn CandidateFilter>, pub denials: &'a dyn DenialSink }
pub fn recall(deps: &RecallDeps, query: RecallQuery, options: RecallOptions, cancel: &Cancel) -> Result<RecallResult, EngineError>;

// src/recall/stages.rs
pub trait Stage { fn name(&self) -> &'static str; fn apply(&self, c: &mut Candidates, t: &mut Trace, cancel: &Cancel) -> Result<StageOutcome, EngineError>; }
pub struct Candidates { /* Vec<Candidate { row: MemoryRow, score: f64, distance: f32, origin: Origin, flags }> plus the knowledge chunks */ }

// src/recall/filter.rs — CP-4a
pub trait CandidateFilter: Send + Sync { fn filter(&self, query: &str, c: &[Candidate], cancel: &Cancel) -> FilterOutcome; }
pub struct DecisionRoleFilter { /* LlmPort, confidence threshold 0.95, max 100 candidates, query cap 10_000 chars, timeout 2_500 ms */ }

// src/recall/budget.rs — CP-5.1
pub fn allocate(c: Vec<Candidate>, tiers: &Tiers, top_n: usize, preserve_order: bool) -> Vec<Candidate>;

// src/recall/render.rs
pub fn blocks(selected: &Selected, caps: &Caps, ctx: &RenderContext) -> (Vec<ContextBlock>, Vec<Deferral>);
// names exactly: "neo" | "start" | "memories" | "time" | "temporal" | "reminder"; deferral kinds "clipped" | "dropped",
// reasons "global-cap" | "memories-cap"

// src/recall/acl.rs
pub trait DenialSink { fn denied(&self, row_id: &str, rule: &'static str, ctx: &RequestContext); }  // RE-08 logs it as a catalogue event
```

## Tasks

### T1 — Request context and ACL (one pull request)

- [ ] **Step 1: failing tests** `tests/recall_context.rs`: `principal_key_equals_the_core_and_the_node_engine`
  (vectors recorded by `record.mjs --principals`: ten `(channel, accountId, userId)` triples and their hashes from
  `lib/memory-request-context.js`), `build_resolves_workspace_ids_the_way_the_node_engine_does` (recorded for three
  agents, with and without a workspace dir), and `tests/recall_acl.rs`: one test per rule of `lib/acl-middleware.js`
  (agent-private seen only by its agent; workspace rows by the workspace; user rows by the owner; scope filters;
  `incognito` never recalls), `a_denial_reaches_the_sink_with_the_rule_name`.
- [ ] **Step 2: implement** `src/context.rs` (port `memory-request-context.js`'s pure parts; the host supplies
  `workspace_dir`), `src/recall/acl.rs` (`allowed(row, ctx) -> Result<(), Rule>`), the sink with a recording test impl.
  Denials are reported by default (f.11): the sink is always called; RE-08 decides the log level.
- [ ] **Step 3: commit** `RE-04/T1: request context and ACL`.

### T2 — Stages 1–7: embed, search, temporal, knowledge, score, graph (one pull request)

- [ ] **Step 1: scenarios and goldens.** `tests/fixtures/recall/record.mjs` runs the Node engine on the RE-02 fixture
  store (flat embedder → every memory shares one vector; for scoring and graph tests the recorder adds a second store
  `store-v1-scored` with per-row vectors written by a deterministic fake embedder that hashes the text to a unit
  vector — the same fake is implemented in Rust under `embedding::seam::HashEmbedder` so both sides agree) with
  `recall.decisionTrace.enabled = true`, and writes per scenario `{ query, config, trace, result }`. Scenarios for T2:
  `plain`, `temporal-last-week`, `knowledge-section-hit`, `knowledge-section-failed-not-cached` (CP-5.7: the recorder
  makes the section throw once; the second run must re-read it), `graph-spread-adds-neighbours`,
  `graph-only-hit-excluded` (CP-5.8), `archived-rows-never-return`, `epistemic-untrusted-rows-ineligible`,
  `valid-time-window`.
- [ ] **Step 2: failing tests** `tests/recall_stages.rs`: one test per scenario asserting the ordered candidate ids
  after stage 7 equal the golden's trace at that stage, and the trace's rejection entries for CP-5.8 match.
- [ ] **Step 3: implement** `stages.rs` with `Embed` (cache first, `EmbedKind::Query`), `VectorSearch` (candidate
  budget from config, `RowFilter` from the context), `Refinement` (present, always off, traced as skipped), `Temporal`
  (`temporal-parser.js` + `temporal-filter.js`), `Knowledge` (chunks of the workspace KNOWLEDGE.md; cache written only
  after success), `Score` (normalisation, quality, importance, age, status, epistemic eligibility exactly as
  `recall-pipeline.js` — copy the constants with their names), `Graph` (`memory-graph.js` spread with the configured
  bound, hydration through `Store::get`, exclusion + trace of hydration failures).
- [ ] **Step 4: commit** `RE-04/T2: recall stages 1-7 at parity`.

### T3 — ACL, budget, prefilter, rerank, dedupe, finalisation (one pull request)

- [ ] **Step 1: goldens G-RERANK-1…8** recorded from the plugin line: `record.mjs --rerank` runs `v7.18.31`'s
  `lib/recall-pipeline.js` + `lib/recall-budget.js` (check them out beside `main`; the recorder loads the two files from a
  path argument) with a scripted fake reranker (returns a permutation, duplicates, an empty list, as each rule needs)
  and writes the ordered ids per rule. Also `G-ACL-BEFORE-RERANK`: a reranker that records what it saw.
- [ ] **Step 2: failing tests** `tests/recall_rerank.rs`: `rule_1_tier_budget_preserves_reranker_order_when_asked`,
  `rule_1b_tier_budget_sorts_by_score_otherwise`, `rule_3_reranker_input_is_bounded_by_max_of_top_n_and_cap`,
  `rule_4_a_duplicate_index_counts_once`, `rule_5_empty_result_is_valid_only_when_declared`,
  `rule_6_the_reranker_never_sees_a_row_the_caller_may_not_see`, `prefilter_removes_only_irrelevant_at_or_above_0_95`,
  `prefilter_timeout_keeps_every_candidate`, `prefilter_judges_at_most_100_candidates`, `dedupe_collapses_near_duplicates_after_rerank`,
  `finalisation_reasserts_the_acl` (inject a stage that leaks a foreign row; finalisation refuses with
  `EngineError::Invalid` and the trace names it).
- [ ] **Step 3: implement** in this order inside the pipeline: `Acl` (T1) → `Budget::allocate` (CP-5.1, tiers from
  `recall-budget.js`) → `Prefilter` (only when `deps.filter` is `Some`; no config key yet — the engine builder passes
  `None` in Phase 1; `DecisionRoleFilter` is built and tested but not wired) → `Rerank` (CP-5.3, 5.4, 5.5; the
  reranker call shares the recall deadline) → `Dedupe` (Jaccard as configured) → `Finalise` (limits, ACL re-assert).
- [ ] **Step 4: commit** `RE-04/T3: ACL-first ordering, budget, prefilter, rerank, dedupe`.

### T4 — Namespaces: fan-out and merge (one pull request)

- [ ] **Step 1: goldens** `namespaces-two-tables`, `namespaces-legacy-table-missing-is-skipped`,
  `namespaces-second-table-error-rejects-the-whole-recall`, `namespaces-merge-keeps-reranker-order` (CP-5.2).
- [ ] **Step 2: failing tests** `tests/recall_namespaces.rs` for the four goldens plus the property
  `for_every_permutation_the_merged_order_restricted_to_reranked_ids_equals_it` (proptest-free: enumerate the 24
  permutations of four ids).
- [ ] **Step 3: implement** `namespaces.rs` (routes from `EngineConfig.namespaces` through RE-02's `StoreRoutes`),
  `merge.rs` (stable sort by score for unreranked rows, order preserved for reranked, duplicate ids keep the higher
  copy, canonical dedupe by heading + text, `canonical.len() + memories.len() <= top_n`, provenance labels on cloned
  wrappers, child traces replayed into one master trace), one retrieval-ledger line per recall (RE-02 `JsonlLedger`).
- [ ] **Step 4: commit** `RE-04/T4: namespace fan-out and merge`.

### T5 — Rendering the six blocks, boosters, system supplement (one pull request)

- [ ] **Step 1: goldens** `render-plain`, `render-memories-cap-clips`, `render-global-cap-drops`, `render-neo-prelude`,
  `render-temporal-block`, `render-reminder-block`, `render-reactivation-boost`, `render-contradiction-disclosure`,
  `render-confidence-framing`, `warm-only-path`, `system-supplement`: block names, texts and deferrals byte-identical to
  the Node result.
- [ ] **Step 2: failing tests** `tests/recall_render.rs`, one per golden; `block_texts_are_byte_identical` is the
  assertion for all.
- [ ] **Step 3: implement** `render.rs`/`blocks.rs` (port `assemble-prompt-context.js`: `capChars`, `maxPromptMemories`,
  `memoriesMaxChars`, clip and drop order, `tokensEstimate`), `boosters.rs` (`conversation-reactivation-recall.js`,
  confidence framing, contradiction disclosure and `drop-injected-conflicts.js`), `neo` prelude from RE-05's working
  memory (until RE-05 lands, a `NeoPrelude` trait with a fixture impl), `system_supplement`, the warm-only path and
  minimal maintenance (`warm-recall-path.js`, `minimal-maintenance.js`: what a recall may touch — `retrievalCount`,
  `lastRetrievedAt` through `Store::patch`, nothing else).
- [ ] **Step 4: commit** `RE-04/T5: context blocks, boosters, system supplement`.

### T6 — Budgets, timing, degraded, trace, diagnostics (one pull request)

- [ ] **Step 1: failing tests** `tests/recall_budget.rs`: `an_overrun_of_hard_ms_answers_degraded_timeout_with_the_blocks_on_hand`
  (a stage seam that sleeps past the deadline), `a_caller_cancel_answers_degraded_aborted`, `soft_ms_switches_to_the_fast_path_and_is_traced`,
  `timing_has_one_phase_per_stage_and_namespace_phases_per_table`, `no_reranker_configured_yields_the_reranker_not_configured_diagnostic`,
  `trace_texts_are_capped_at_the_configured_length` (review-focus 5), `trace_never_contains_a_secret_marker`
  (feed `tests/system/redaction-everywhere.test.ts`'s marker strings through a memory and assert absence).
- [ ] **Step 2: implement** `budget.rs` (`RecallBudget { soft_ms, hard_ms, cap_chars }` from the query's `budget`
  with the config defaults), `timing.rs`, `degraded.rs`, `trace.rs` (port the capped helpers of
  `recall-decision-trace.js`).
- [ ] **Step 3: commit** `RE-04/T6: budgets, timing, degraded, trace`.

## Acceptance

- Every golden scenario of T2–T5 passes byte-identically; the eight CP-5 rules and the CP-4a tests are green.
- `tests/recall_budget.rs` green; `cargo test -p plur1bus-engine recall` under 60 s on a laptop.
- After RE-08: `tests/system/two-session-recall.test.ts` with `PLUR1BUS_ENGINE_IMPL=rust` meets the budgets on the
  reference hardware (host-contract (b)); numbers quoted in the T6 PR or, if RE-08 is not merged yet, in RE-09's report.
- `docs/engine-stores.md` documents the retrieval-ledger line.

## Out of scope

Capture-side writes (RE-05) except the two counters a recall touches; the `neo` content itself (RE-05 T5, consumed
through `NeoPrelude`); the configuration key for the prefilter (RE-11); the recall comparison tooling (RE-09).

## Hand-off

Six PRs `RE-04/T1` … `RE-04/T6`, in order; T4 and T5 can run in parallel after T3. `src/context.rs` is consumed by
RE-05 and RE-07 — a change after T1 merges needs the controller's agreement.
