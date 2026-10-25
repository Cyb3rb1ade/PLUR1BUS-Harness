# RE-05 — Capture pipeline, neo working memory, journal, checkpoint

**Package.** `Engine::capture`, `Engine::checkpoint` and the working-memory layer: accepting a turn, chunking,
duplicate check, row construction, classification (importance, emotion, speaker), reminders, reconsolidation and
contradiction handling, memory dynamics, the neo generations and turn journal, crash consistency and the checkpoint
digest — at parity with the Node engine on recorded scenarios. Size XL; six tasks, one pull request each.

**Depends on.** RE-02 (`Store`, caches, `NeoFiles`, ledgers, `JobLock`), RE-03 (`EmbeddingProvider`, cache), RE-04 T1
(`RequestContext`) and T5 (`NeoPrelude` trait). **Enables.** RE-06 (jobs operate on what capture wrote), RE-07
(ops read the same rows), RE-09 (kill-soak with the Rust engine).

**Assumes.** RE-D3 (same store), RE-D4.

**Read first.**
- Plan §1.4, §3.2 (CP-2), RE-5 in §4, review-focus item 4.
- Engine at `98dfe2f`:

| File | Lines | Holds |
|---|---|---|
| `engine/capture/capture-turn.js` | 1,271 | the capture flow: what is extracted from a turn, when, with which LLM calls |
| `engine/capture/turn-replay-guard.js` | 274 | idempotency per turn (`runId`, `sessionKey`), replay after a crash |
| `engine/capture/post-turn-work.js` | 241 | the deferred part (`deferPostTurnLlm`, `post-turn-refine`) |
| `lib/memory-chunking.js`, `lib/jev-chunk-decider.js` | 346 + 99 | `captureChunking`, `captureChunkingMode`, `captureMaxChars`; the decision-model chunk decider (`captureChunkingJev`) |
| `lib/safe-update.js`, `lib/memory-merge-safety.js`, `lib/memory-history.js` | 510 + 274 + 95 | reconsolidation: versions, `supersededBy`, merge safety, history |
| `lib/contradiction-detector.js`, `lib/continuity-gate.js` | 436 + 322 | contradictions at capture, the continuity gate (`continuityEngine`) |
| `lib/memory-dynamics.js`, `lib/deferred-dynamics-queue.js` | 517 + 143 | `memoryStrength`, `halfLifeDays`, `lastStrengthenedAt`, the deferred queue |
| `lib/emotion.js`, `lib/emotion-engine.js`, `lib/emotion-score.js`, `lib/emotion-blends.js`, `lib/emotional-state.js` | 283 + 340 + 223 + 221 + 607 | emotion classification, blends, `.emotional-state.json` |
| `lib/epistemic-status.js`, `lib/valid-time.js`, `lib/temporal-provenance.js` | 226 + 210 + 323 | `epistemicStatus` (`""` = legacy, never trusted), `validFrom`/`validUntil` (`0` = no bound), provenance |
| `lib/speaker-mapping-store.js` | 295 | speaker labels → display names (RE-02 `SpeakerMappings`) |
| `lib/reminder-extraction.js`, `lib/reminder-parser.js`, `lib/reminder-store.js`, `lib/reminder-pending.js` | 102 + 101 + 171 + 73 | reminder rows (`memoryKind: "reminder"`, `remindAt`, …) |
| `lib/critical-review.js` | 445 | critical memories and their `confirmed` state (the push buttons are adapter: `lib/critical-buttons.js`, `critical-button-delivery.js`, `critical-push-*.js` are **not** ported; the harness surface for accept and reject is RE-13 T1, Phase 2) |
| `lib/shared-memory.js`, `lib/shared-memory-pool.js`, `lib/workspace-policy.js`, `lib/workspace-policy-guard.js` | 386 + 446 + 194 + 114 | what may be written to `workspace`/`user` scope at capture time |
| `lib/neo-arch.js` | 3,687 | the working-memory layer: generations, turn journal, prelude, its own lock (f.4) |
| `lib/episodes.js`, `lib/episode-watermark.js` | 925 + 85 | episodes derived from turns (rebuilt by a job in RE-06) |
| `lib/tombstone.js` | 595 | tombstones: a forgotten id never returns, including after replay |
| `engine/create-engine.js` (search `checkpoint`, `journal`, `replay`) | — | the checkpoint digest and the start-up replay |

- Engine tests to translate: `tests/neo-*.test.js` (17), `tests/memory-*.test.js` (31), `tests/importance-*.test.js`,
  `tests/speaker-*.test.js`, `tests/reminder-*.test.js`, `tests/contradiction-*.test.js`, `tests/tombstone-*.test.js` (9),
  `tests/critical-*.test.js` (the non-push parts), `tests/post-turn-queue.test.js`.
- Harness: `packages/core/src/replay.ts` (the harness journal that replays `memory.capture` calls after a core
  restart — distinct from the engine's turn journal; both must agree on idempotency keys), `packages/core/src/session/
  turn-loop.ts` (one capture after each turn), `tests/system/kill-soak.test.ts` (the acceptance), AGENTS.md on
  `flat-embedder` and `duplicateThreshold`.

**Rules that apply.** A row is visible only after the Lance commit; the journal line is written before the commit and
removed/marked after it, so a crash between the two is replayed, never duplicated. `incognito: true` stores nothing
and writes no journal line. LLM calls go through `HostServices::llm()` with `Cancel`; with `deferPostTurnLlm` or no
LLM port the row is stored with `importanceStatus`/`emotionStatus = "pending"` and the diagnostic
`post-turn-refine-unscheduled` is returned — never a blocking wait.

Every word splitter this package ports goes through RE-04 T0's `text::js`/`text::legacy`, byte-identically and with the
German defects included (plan §1.6, last paragraph; §2.5):
- `lib/memory-fact-quality.js`: the lookaround phrase matching at `:94-108`; it is NFC/NFD-sensitive as in Node.
- `lib/memory-merge-safety.js`: written with `[0-9]`, never Unicode `\d`; the one-rule stemmer and the Jaccard 0.8/0.9
  thresholds.
- `lib/memory-chunking.js`: the lookbehind sentence splits at `:57-70` and `:166-179`.
- `lib/tier1-lexicon.js`, `lib/categorize.js` and `lib/critical-classifier.js`.
- `lib/episodes.js`: the `localeCompare` tie-break at `:230`, through RE-D17's collator.

Cut sites (RE-D17):
- `captureMaxChars` cuts with `text::js::utf16_slice`.
- The neo cuts of `normalizeStatement` (`lib/neo-arch.js:2258-2259`, 4,000) and `normalizeBehaviorStatement` (`:2288`,
  1,000) yield a `JsString`.
- `stableId` hashes the `JSON.stringify` text of its parts (`:242-249`), escape included.
- Golden `a_neo_stable_id_with_a_statement_cut_inside_an_emoji_matches_node` (the `stableId("mem", turn.id, category,
  normalizedStatement)` of `:1457`).

The fix of these splitters is RE-D16 (RE-10 T10).

**Modules added by the 2026-10-23 audit** (rows owned by RE-05 in [`MODULE-MAP.md`](MODULE-MAP.md)). T1: `lib/runtime-scheduler.js`
(687 — turn admission: `isBackgroundTurn`, `shouldSkipAutoCaptureForInternalTurn`, `createBackgroundMemoryScheduler` with
priorities, timeouts and the pressure skip; the thresholds of `lib/runtime-pressure-gate.js` and the depth bound of
`lib/bounded-operation-queue.js` come with it), `lib/post-turn-queue.js` + `lib/post-turn-detach.js` (the post-turn work queue),
`lib/epistemic-capture.js` + `lib/epistemic-cutoff.js` (observed vs untrusted; the restore-safe cutoff). T3: `lib/memory-fact-quality.js`
(523 — the deterministic fact-quality classifier, also used by import), `lib/categorize.js` (195), `lib/tier1-lexicon.js` (410),
`lib/tier2-transformer.js` (224 — its model is an RE-03 artifact), `lib/tier3-llm.js` (185), `lib/encoding-llm.js` (283 — emotion and
meaning in one call), `lib/speaker-segment-schema.js` (313 — a contract type, RE-01), `lib/speaker-proposer.js` (87),
`lib/reminder-nudge.js`. T4: `lib/retroactive-interference.js` (45), `lib/critical-push-classifier.js` (96 — classification only;
the push delivery stays dropped). T5: `lib/neo-worker-runtime.js` (338 — a Rust task, not a worker thread). **7.18.25 in the chunk
decider** (`lib/jev-chunk-decider.js`, the CP-3 commit `0ee6a59b`, plan §3.3 CP-3c): `resolveJevApiKey` reads `captureChunkingJev.apiKey`
before `apiKeyEnv` (default `TYPESAFE_API_KEY`) — here the key comes from `SecretPort` by name only (RE-01 T3 rejects a
config-held key); and a failed Jev request logs `timeout` or `request failed`, never the transport error text, which may echo
the bearer key. Test in T2: `a_failed_chunk_decider_request_never_logs_the_error_body`.

## Files

- Create: `src/capture/{mod,accept,queue,replay_guard,chunking,chunk_decider,dedupe,row_builder,classify,emotion,
  speaker,reminders,reconsolidate,contradiction,continuity,dynamics,critical,shared_scope,checkpoint,journal}.rs`,
  `src/neo/{mod,working_memory,generations,prelude,episodes}.rs`, `tests/capture_accept.rs`, `tests/capture_rows.rs`,
  `tests/capture_classify.rs`, `tests/capture_reconsolidate.rs`, `tests/neo.rs`, `tests/capture_crash.rs`,
  `tests/fixtures/capture/{record.mjs,scenarios/*.json,golden/*.json,llm/*.json}`
- Modify: `src/lib.rs`, `src/recall/blocks.rs` (bind `NeoPrelude` to `neo::prelude`), `docs/engine-stores.md`
  (journal and ledger lines capture writes)
- Test: the six Rust test files and the fixtures

## Interfaces

**Consumes:** RE-01 `TurnRecord`, `Message`, `CaptureOptions`, `CaptureResult`, `CaptureHandle`, `CheckpointReason`,
`CheckpointResult`, `PerCallDiagnostic`, `LlmPort`, `LlmParams`; RE-02 `Store::{search, upsert, patch, get}`,
`EmbeddingCache`, `SpeakerMappings`, `NeoFiles`, `JsonlLedger`, `StateFile`, `JobLock`; RE-03 `EmbeddingProvider`;
RE-04 `RequestContext`, `NeoPrelude`.

**Produces:**

```rust
// src/capture/mod.rs
pub struct CaptureDeps<'a> { pub stores: &'a dyn StoreRoutes, pub embedder: &'a dyn EmbeddingProvider, pub cache: &'a EmbeddingCache,
    pub host: &'a dyn HostServices, pub neo: &'a Neo, pub journal: &'a TurnJournal, pub clock: &'a dyn Clock }
pub fn accept(deps: &CaptureDeps, turn: TurnRecord, options: CaptureOptions) -> Result<CaptureHandle, EngineError>;
// CaptureHandle { id, accepted_at, done: Receiver<CaptureResult>, abort: Box<dyn Fn(Option<String>)> } — RE-01's type

// src/capture/journal.rs — the engine's turn journal (lib/neo-arch.js turn-journal.jsonl), replayed on open()
pub struct TurnJournal; impl TurnJournal { pub fn begin(&self, key: &IdempotencyKey, turn: &TurnRecord) -> Result<JournalTicket, EngineError>;
    pub fn commit(&self, t: JournalTicket) -> Result<(), EngineError>; pub fn pending(&self) -> Result<Vec<PendingTurn>, EngineError>; }
pub struct IdempotencyKey(String);  // derived exactly as turn-replay-guard.js derives it from runId / sessionKey / message hash

// src/capture/checkpoint.rs
pub fn checkpoint(deps: &CaptureDeps, agent: &AgentId, reason: CheckpointReason) -> Result<CheckpointResult, EngineError>;
// digest: the same bytes the Node engine hashes (read create-engine.js), hex; written == true only when state changed

// src/neo/mod.rs
pub struct Neo; impl Neo { pub fn open(dir: &Path, lock: JobLock) -> Result<Neo, EngineError>;
    pub fn record_turn(&self, turn: &TurnRecord, ctx: &RequestContext) -> Result<(), EngineError>;
    pub fn prelude(&self, ctx: &RequestContext, cap_chars: usize) -> Result<Option<String>, EngineError>; } // implements RE-04's NeoPrelude
```

## Tasks

### T1 — Accept, queue, idempotency, incognito (one pull request)

- [ ] **Step 1: failing tests** `tests/capture_accept.rs`: `accept_returns_at_once_and_done_resolves_with_counts`,
  `the_same_run_id_twice_stores_once` (idempotency key parity: `record.mjs --keys` records ten keys from
  `turn-replay-guard.js`), `incognito_stores_nothing_and_writes_no_journal_line`, `abort_before_the_commit_stores_nothing_and_resolves_aborted`,
  `two_captures_for_one_agent_run_in_order` (the Node queue is per agent; read `post-turn-work.js`).
- [ ] **Step 2: implement** `accept.rs`, `queue.rs` (one worker thread per engine; per-agent ordering; the admission rules of
  `lib/runtime-scheduler.js` — background and internal turns, priorities, the pressure skip), `replay_guard.rs`,
  `journal.rs` (`begin` before any write, `commit` after the Lance commit).
- [ ] **Step 3: commit** `RE-05/T1: capture acceptance, queue, idempotency, journal`.

### T2 — Chunking, duplicate check, row construction (one pull request)

- [ ] **Step 1: goldens** `record.mjs --rows`: for eight scenario turns (one message, long message over `captureMaxChars`,
  chunking mode each, a turn whose chunk decider says "one memory", a duplicate of an existing row, a workspace-scope
  write allowed by policy, one refused) the rows the Node engine wrote (all 69 columns) minus timestamps and ids.
- [ ] **Step 2: failing tests** `tests/capture_rows.rs`: one per scenario (`rows_equal_the_golden_minus_volatile_columns`),
  `a_duplicate_at_or_above_the_threshold_is_skipped_and_counted`, `the_flat_embedder_makes_every_text_a_duplicate_unless_the_threshold_exceeds_one`
  (the AGENTS.md rule), `every_new_row_has_the_seed_row_defaults_for_untouched_columns`.
- [ ] **Step 3: implement** `chunking.rs`, `chunk_decider.rs` (decision role through `LlmPort`, fixture answers in tests),
  `dedupe.rs` (cosine against the nearest neighbours from `Store::search`), `row_builder.rs` (defaults from the seed row;
  `ownerUserId`, `workspaceId`, `workspaceKey` from `RequestContext`; `epistemicStatus = ""`; `validFrom = validUntil = 0`;
  `chunkGroupId`), `shared_scope.rs` (workspace policy and guard).
- [ ] **Step 4: commit** `RE-05/T2: chunking, duplicate check, row construction`.

### T3 — Classification, emotion, speaker, reminders, dynamics (one pull request)

- [ ] **Step 1: fixtures.** `tests/fixtures/capture/llm/*.json`: recorded decision-model answers (importance, emotion,
  speaker attribution, reminder extraction) keyed by the prompt hash, so the Rust engine's prompt must equal the Node
  prompt to find its answer — this is the prompt-parity check.
- [ ] **Step 2: failing tests** `tests/capture_classify.rs`: `importance_and_emotion_land_as_final_when_the_llm_answers`,
  `defer_post_turn_llm_stores_pending_and_returns_the_unscheduled_diagnostic`, `no_llm_port_behaves_like_defer`,
  `speaker_labels_map_through_the_store_and_new_ones_are_proposed`, `a_reminder_sentence_yields_a_reminder_row_with_remind_at`,
  `dynamics_initialise_strength_and_half_life_as_the_node_engine`, `emotional_state_file_updates_atomically`.
- [ ] **Step 3: implement** `classify.rs`, `emotion.rs` (`.emotional-state.json` via `StateFile`), `speaker.rs`,
  `reminders.rs`, `dynamics.rs` (+ the deferred queue the `post-turn-refine` job drains in RE-06), and `tier2.rs`. `tier2.rs`
  ports `lib/tier2-transformer.js` as what it is, a keyword-density scorer with no model: `:105-113` sets `_session = null`,
  `:141` takes `\p{L}+` words, and `:80-91` guesses German at ≥ 3 marker hits. Softmax and confidence are byte-identical,
  with a golden of their own.
- [ ] **Step 4: commit** `RE-05/T3: classification, emotion, speaker, reminders, dynamics`.

### T4 — Reconsolidation, contradictions, continuity, critical (one pull request)

- [ ] **Step 1: goldens** `record.mjs --reconsolidate`: an update to an existing fact (version chain), a contradiction
  (conflict ledger lines), a merge the safety check refuses, a critical memory awaiting confirmation.
- [ ] **Step 2: failing tests** `tests/capture_reconsolidate.rs`: `an_update_creates_version_2_and_supersedes_version_1`,
  `a_contradiction_writes_conflict_log_and_keeps_both_until_resolved`, `merge_safety_refuses_the_golden_case`,
  `the_continuity_gate_blocks_the_golden_case`, `a_critical_memory_is_stored_unconfirmed_and_never_recalled_as_confirmed`,
  `ledger_lines_equal_the_golden_shapes` (`conflict-log.jsonl`, `conflict-resolved.jsonl`, `reconsolidation-events.jsonl`,
  `memory-candidates.jsonl`).
- [ ] **Step 3: implement** `reconsolidate.rs`, `contradiction.rs`, `continuity.rs`, `critical.rs` (state only; no push).
- [ ] **Step 4: commit** `RE-05/T4: reconsolidation, contradictions, continuity, critical state`.

### T5 — Neo working memory and episodes (one pull request)

- [ ] **Step 1: goldens** `record.mjs --neo`: five turns → the generation files, the journal lines, the prelude text
  for a following recall (through RE-04's render golden `render-neo-prelude`), the episodes derived.
- [ ] **Step 2: failing tests** `tests/neo.rs`: `record_turn_appends_the_journal_and_updates_the_generation_as_the_golden`,
  `prelude_text_is_byte_identical_to_the_node_prelude`, `a_second_engine_on_the_same_dir_waits_for_the_lock_and_never_corrupts_a_generation`,
  `episodes_equal_the_golden_after_five_turns`.
- [ ] **Step 3: implement** `src/neo/*` over RE-02's `NeoFiles` and `JobLock`; `prelude` implements RE-04's `NeoPrelude`.
- [ ] **Step 4: commit** `RE-05/T5: neo working memory and episodes`.

### T6 — Checkpoint, replay on open, crash consistency (one pull request)

- [ ] **Step 1: failing tests** `tests/capture_crash.rs`: `checkpoint_digest_equals_the_node_digest_for_the_golden_state`
  (`record.mjs --checkpoint`), `checkpoint_written_is_false_when_nothing_changed`, `a_pending_journal_line_is_replayed_on_open_exactly_once`,
  `a_kill_between_journal_begin_and_commit_leaves_no_half_row` (a seam that aborts the process after `begin`; a second
  engine opens, replays, the row exists once), `one_thousand_session_end_checkpoints_leave_the_embedder_warm` (CP-2:
  the embed call count of the `FlatEmbedder` does not change across the loop; with the real model the next embed
  stays under 50 ms — the second assertion runs only where `PLUR1BUS_MODELS_CACHE` is set).
- [ ] **Step 2: implement** `checkpoint.rs` and the `open()` replay in the engine builder (RE-08 calls it).
- [ ] **Step 3: commit** `RE-05/T6: checkpoint, replay, crash consistency`.

## Acceptance

- All six test files green; goldens byte-identical minus the volatile columns the recorder names.
- After RE-08: `tests/system/kill-soak.test.ts` with `PLUR1BUS_ENGINE_IMPL=rust` passes with the default 200 turns
  (review-focus 4), and `tests/system/memory-ops.test.ts` sees the rows capture wrote.
- `docs/engine-stores.md` lists every ledger line capture writes with its owner module.

## Out of scope

The jobs that refine pending rows (RE-06 `post-turn-refine`, `emotion-refine`, `classify-recent`); shares and
proposals initiated by a person (RE-07); the critical push buttons (adapter, not ported); the harness journal
(`packages/core/src/replay.ts`, which keeps working unchanged and moves in RE-10).

## Hand-off

Six PRs `RE-05/T1` … `RE-05/T6`, in order (T5 can start after T1). The capture goldens are the richest parity asset
of Phase 1: record them once per scenario and extend them only through `record.mjs`.
