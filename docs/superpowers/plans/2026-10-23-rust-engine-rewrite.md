# Rust engine rewrite (`plur1bus-engine`) — change packages 7.18.21–7.18.31 and implementation plan

**Goal.** Replace the Node memory engine (`@cyb3rb1ade/plur1bus-memory` 7.18.4, pinned to commit `9f34008c`, contract 1.17.0; that commit is the head of engine PR #275 on `feat/reembedding-validate`, i.e. `main` `98dfe2f0` plus `AdminOps.reembedding.validate` and a zod override)
with a Rust engine that serves the same `Engine` contract to the TypeScript core, behaviour-neutral at the contract
boundary; then move the memory-facing parts of the core into it; then retire the Node engine dependency. The deltas the
OpenClaw plugin line shipped as 7.18.21–7.18.31 enter the plan as **change packages** (acceptance criteria inside the
subsystem that owns them), not as work packages of their own (§0).

**Architecture.** A new workspace crate `crates/plur1bus-engine` (library plus binary `plur1bus-engine`) implements the
contract of the engine's `types/engine.d.ts` behind a Rust `Engine` trait. Stores stay byte-compatible: the LanceDB
table `memories` through the `lancedb` crate pinned to the Lance version the Node package embeds, the three SQLite
caches through `rusqlite`, the neo-arch vector files and the JSONL ledgers as they are. The engine runs as its own
supervised process — a new `engine` slot beside `core` and `api` (ADR-012 §10) — and speaks the harness RPC
(`x-server: "engine"`). The core gets an `EngineClient` that implements the TypeScript `Engine` interface over that RPC,
so the 27 engine methods the core calls today need no caller change. What the engine needs from the host (LLM
completions on a model role, egress decisions, secrets, events, workspace paths) are reverse RPC calls under an engine
delegation credential. A parity harness drives both engines through the same scenarios and diffs the results; it is
the exit gate of Phase 1.

**Status.** Plan written 2026-10-23. RE-00 merged 2026-10-24 (#759, merge `76b54e9d`); its MSVC `protoc` follow-up #769 merged 2026-10-25. RE-D11–RE-D14 were decided 2026-10-24, RE-D20 (a) on 2026-10-26. RE-D1–RE-D10, RE-D15–RE-D19 and RE-D21–RE-D29 are open (§6), and the briefs assume the recommendations. §2.5 (tokenization and text analysis) and §2.6 (provider prompt caching and token counting) were added 2026-10-25; the core prerequisites RE-14/P1–P4 merged 2026-10-26 (#781, #783, #784, #785). Nothing here changes the pinned engine.
CP-5 and CP-7 (§3) are correctness fixes worth forward-porting to the Node engine's `main` now, independent of the
rewrite (RE-12). The coding standard this plan assumes is [`docs/coding-standard.md`](../../coding-standard.md).

**Constraints.** JSON Schema stays the single source of types (AGENTS.md): every RPC addition carries `x-server`,
`x-stability: "experimental"`, `x-since` and closed params; the engine contract gets a schema of its own (RE-1) and both
languages generate from it. No store migration during the rewrite; no direct store writes from the harness (D28/T7).
No new dependency without the gate of [`docs/dependency-policy.md`](../../dependency-policy.md) and `deny.toml`. No
OpenClaw idiom in `crates/` — `scripts/lint-hygiene.mjs` scans the new crate too, so contract members named after the
OpenClaw home or runtime are not ported (§2.4). Test seams only behind `PLUR1BUS_ALLOW_TEST_INTERNALS=1`. Never skip,
disable or quarantine a test to get a job green. One pull request per work package; no CI polling; no history rewrite.

## 0. Are "change packages from the commits" the right approach?

Partly — the commits are the right **input**, and the wrong **unit of planning**:

- Right input. The OpenClaw plugin line (`v7.18.x`) and the harness engine (`main`) diverged on 2026-10-02
  (merge-base `9cc5f833`). Nothing from 7.18.21–7.18.31 is on `main`, so the commits are the only record of what the
  plugin line learned since. Reading them as a delta, deciding per commit "engine behaviour or adapter/UI?", and writing
  the engine behaviour down as a testable rule is exactly what §3 does — and it is needed for the Node engine on `main`
  just as much as for a Rust engine.
- Wrong unit. Four of the eleven releases in the range are adapter or dashboard work with no engine counterpart
  (§3.9). The seven that matter touch five different subsystems. A work package per commit would cut across the
  recall pipeline, the job runner and the LLM port and leave the other ninety-five percent of the engine unplanned.
  So the work packages (§4) are organised by subsystem and contract; each change package becomes acceptance criteria
  of the work package that owns its subsystem, with a golden vector or a property test that pins the rule.
- Standing rule. The plugin line will keep shipping. §3.10 fixes the triage every new `v7.18.x` release gets, so the
  delta never silently grows again.

## Review focus

1. A recall that overruns `hardMs` answers `degraded: { reason: "timeout" }` with the blocks it has — never an RPC
   error, never `reason: "aborted"` (2a-H3b-b) — and the extra process hop is inside the budget, not on top of it
   (RE-4, RE-8; `tests/system/two-session-recall.test.ts` with `PLUR1BUS_ENGINE_IMPL=rust`).
2. A store the Node engine wrote opens read-write in the Rust engine and back without `admin.migrate`; a different
   `_embedding_identity` refuses writes (`identityStatus`) instead of mixing vector spaces (RE-2 round-trip test).
3. ACL filtering runs before any provider sees a row: no reranker or decision-model call ever receives a row the caller
   may not see, and a high score never bypasses it (RE-4, rule CP-5.6).
4. Engine death mid-capture leaves no half-written row visible: `done` rejects, the journal replays, no duplicate after
   restart (`tests/system/kill-soak.test.ts` with `PLUR1BUS_ENGINE_IMPL=rust`, RE-5/RE-8).
5. No secret, token, prompt body or transcript reaches an engine log or decision trace; the trace carries ids, scores
   and reasons, texts only up to the configured cap (RE-1 `DecisionTrace` limits, the Rust log writer's redaction
   rules from `crates/plur1bus-log-schema`).

## Dependencies and order

```text
RE-12 forward-port CP-5/CP-7 to the Node engine `main` (now, independent)

RE-0 decisions + crate skeleton + dependency gate
  ├──► RE-1 contract schema + Rust types ──► RE-2 store layer ──► RE-3 embeddings/rerank ──► RE-4 recall ──► RE-5 capture/neo/journal
  │                                                                                     │
  │                                                                                     └──► RE-7 memory/admin ops
  ├──► RE-8 process, RPC, supervisor slot, EngineClient (starts after RE-1; needs RE-4 for the first end-to-end recall)
  ├──► RE-9 parity harness (scenario format after RE-1; golden recording as soon as RE-4 answers)
  └──► RE-4 T0 JS text semantics, the base of every lexical port and Node-file read (after RE-0; lands before RE-2 T5, RE-3 T6 and RE-4 T1; §2.5)
RE-6 jobs and dreaming (after RE-5 and RE-7; go/no-go gate on RE-9 results — RE-D5)
Phase 1 exit: RE-9 green on every scenario, system tests green with PLUR1BUS_ENGINE_IMPL=rust
RE-10 Phase 2: memory-facing core paths move into the engine; T7–T9 the three §1.6 behaviour changes; T8 also carries the lexical analyzer (RE-D15); T10 moves the legacy text helpers onto it (RE-D16); T11 runs only if RE-D18's gate opens
RE-13 Phase 2: harness surfaces for critical confirmations, skill proposals and the daily review (§1.7; parallel to RE-10)
RE-14 token counter + provider cache profiles (core prerequisites now; engine side after RE-1, RE-3, RE-8; consumers in RE-10; §2.6)
RE-11 Phase 3: retire the Node engine pin, docs and ADR
```

## 1. Starting point

### 1.1 Three lines of the engine

| Line | Head | Package / contract | Used by |
|---|---|---|---|
| `main` of `Cyb3rb1ade/openclaw-plur1bus-memory` | `98dfe2f0` | `@cyb3rb1ade/plur1bus-memory` 7.18.4, contract **1.16.0** | base of the harness pin (engine `main` had not moved by 2026-10-25) |
| `feat/reembedding-validate` (engine PR #275, unmerged) | `9f34008c` (harness pin since #776, 2026-10-25) | 7.18.4, contract **1.17.0** = 1.16.0 + `AdminOps.reembedding.validate`, plus a zod 4.6.6 override | the harness core (`packages/core/package.json:20`, exact commit) |
| OpenClaw plugin line | tag `v7.18.31` = `6419a60e` (2026-10-23) | plugin 7.18.31, diverged from `main` at `9cc5f833` (2026-10-02) | OpenClaw installations; source of the change packages in §3 |
| `codex/gp3-a1-curated-memory` (A1) | `9b935ce1`, unmerged | also labels itself 1.17.0. Contents: recall stats, the `knowledge-update` job, promotion receipts, curation keep/drop, and the capability flags `recallStats`, `knowledgePromotion`, `memoryCuration`; no memory-tree fields. It needs a new number when it merges | the harness feature-tests A1 and keeps those paths dormant on the pin (#604–#607, #609) |

### 1.2 Size of what is being replaced

- Import closure of `engine/create-engine.js`: **323 files, 101,408 lines** of JavaScript at `98dfe2f0` (101,415 at the pin `9f34008c`, which adds 7 lines to `engine/create-engine.js`; the whole repository is
  larger; the closure is what an engine port has to re-express). `lib/telegram-commands/`, `lib/obsidian-control-room/`
  and the i18n tables are adapter material inside that closure and are not ported (engine-extraction §a.3).
  [`rust-engine/MODULE-MAP.md`](rust-engine/MODULE-MAP.md) (audit 2026-10-23) lists every file of the `.js` closure (322
  files, 100,593 lines at `98dfe2f0`, 100,600 at the pin) with its owner brief and disposition: 234 ported, 26 folded into Rust idioms, 36 pending the
  Obsidian decision, 26 dropped (adapter surface and Node plumbing, each row saying which; reachability alone never
  drops a file — on `main` the job bodies are wired through the chat command module and are engine behaviour all the same).
- **615** test files under `tests/` plus 13 under `test/`. They encode behaviour that is documented nowhere else; porting
  the ones that test engine behaviour is part of the work (RE-9 counts them per subsystem).
- **57** top-level engine config keys (`engine/config/engine-config.schema.json`; the harness mirror is
  [`docs/config-engine-keys.md`](../../config-engine-keys.md); `openclaw.plugin.json#configSchema` on the same commit has 58 —
  `groupReasoningFilter` is manifest-only and adapter-facing; the plugin line has no `engine-config.schema.json`, only the
  manifest, whose one addition is `captureChunkingJev.apiKey` — RE-01 T3 handles both): `afterthought autoCapture autoRecall autoRecallMinScore
  baseDbPath captureChunking captureChunkingJev captureChunkingMode captureMaxChars chatModels continuityEngine
  contradictionDisclosure controlUi conversationReactivationRecall criticalPush dailyConsolidation dreamEcho dreaming
  duplicateThreshold embedding embeddingBatchSize emotion eveningReview featureCronSetup featuresConfirmedAt
  forgetThreshold gc healthWatch language llmRouter memoryDynamics merging metaCognition modelPreparation morningReview
  namespaces neo obsidianBridge personaVoice reactionNudge recall recallHedging recallMinScore reembedding reminders
  replyOutcomeTracking reranker runtime schicht15 security semanticLens setupProfile skillMiner styleDirective
  summaryMaxWords temporalContext timezone`.
- **19** jobs (`JobName`): `persona-evolve afterthought consolidate-daily auto-accept-stale embedding-drain emotion-refine
  post-turn-refine classify-recent rem-dream skill-miner discover-semantic-links gc-run reminder-dispatch
  feedback-report proactive-check meta-reflect skill-benefit-backfill episodes-rebuild light-dream`; triggers
  `cron | manual | harness | capture | unknown`.
- Dependencies that disappear from the Node payload with the rewrite: `@lancedb/lancedb`, `apache-arrow`, `openai`, and
  the engine's optional dependency on `@huggingface/transformers`. The closure itself (`@huggingface/tokenizers`,
  `onnxruntime-node`, `onnxruntime-web`, `sharp`) stays as an optional dependency of `packages/core`, because local
  Florence-2 captions import it (`packages/core/src/media-search/caption/local.ts:51-70`; RE-11 T2; §2.5). Moving
  captions onto ONNX Runtime outside Node would be core work (RE-D9).

### 1.3 The Phase 1 surface: what the core calls today

27 engine members, counted over `packages/core/src` (call sites in parentheses): `status` (9), `recall` (8), `models`
(5), `memory.import` (5), `jobs.list` (5), `jobs.run` (4), `capabilities` (4), `embedding.local` (3), `capture` (3),
`memory.list` (2), `jobs.history` (2), `embedding.serve` (2), `contract` (2), `close` (2), `checkpoint` (2),
`admin.reembedding` (2; called as `plan`/`apply`/`resume`/`status`/`validate`, `packages/core/src/embedding-migrate/engine-port.ts:55-70`, and `validate` only when the engine exposes it), `stores.adopt`, `open`, `memory.unimport`, `memory.unbind`, `memory.show`, `memory.rebind`,
`memory.link`, `embedding.probe`, `embedding.identities`, `admin.obsidian`, `admin.migrate` (1 each).

Besides the contract, the core deep-imports eight private modules (`packages/core/src/engine-shim.d.ts` declares
them): `lib/reembedding/runtime-config.js` (`embeddingFingerprintFromNormalizedConfig`, `embeddingConfigFromSelection`),
`lib/reembedding/fingerprint.js` (`embeddingFingerprintId`), `lib/providers/config-normalize.js`
(`normalizeEmbeddingConfig`, also imported by `engine.ts` and `engine-config.ts`), `lib/providers/local-model-artifacts.js` (`pinnedLocalModelProfile`, `EMBEDDING_PREPARATION_TARGETS`; used by `engine-config.ts` and `embedding-migrate/selection.ts`), `lib/snapshot/store-snapshot.js` (`createSnapshot`, `verifySnapshot`, `SnapshotError`),
`lib/tombstone-reapply.js`, `lib/memory-request-context.js`, `lib/group-reasoning-filter.js`, plus
`engine/config/engine-config.schema.json` and `engine/internals.js`. Every one of them becomes a contract method or a
schema in RE-1/RE-7; a private import is a defect of the current binding, not a feature to keep.

### 1.4 Stores and files the engine owns

| Store | Format today | Compatibility rule |
|---|---|---|
| `memories` table under `baseDbPath/<agentId>` (or the `namespaces` routes) | LanceDB; schema inferred by the Node SDK from a `__schema__` seed row with **69 columns** (`engine/store/memory-db.js:772`): `id type confirmed text summary origin vector importance category createdAt mergedFrom expiresAt agentId storedBy sourceTurnId sourceMessageRole sourceTimestamp sourceUrl evidenceQuote scope ownerUserId emotionalValence emotionalIntensity emotionalDominant moodContextAtCapture emotionStatus importanceStatus replayCount lastReplayed retrievalCount lastRetrievedAt memoryStrength halfLifeDays lastStrengthenedAt lastDynamicsAt memoryClass neverForget coreMemoryScore coreMemoryReason versionNumber previousVersion supersededBy updateSource updateEvidence reconsolidationConfidence status versionCreatedAt updatedAt workspaceId workspaceKey memoryKind reminderStatus remindAt remindedAt dispatchedAt acknowledgedAt cancelledAt reminderKey dispatchCount lastDispatchAttemptAt nextDispatchAttemptAt epistemicStatus epistemicStatusUpdatedAt epistemicStatusActor epistemicStatusReason previousEpistemicStatus validFrom validUntil chunkGroupId` | RE-2 pins the Arrow schema by **reading an existing store**, never from this list: the SDK's inference (numbers as `Float64`, the `vector` column as `FixedSizeList<Float32>[dim]`) is what is on disk |
| `_embedding_identity` table | one row `{ identity: <JSON of VectorSpaceIdentity>, identityId }` | the Rust `identity_id()` must reproduce the Node hash byte for byte (RE-3) |
| store schema version | `STORE_SCHEMA_VERSION = "1"` (`engine/store/schema-version.js`), legacy `"0"`; `stores.adopt` checks it | unchanged in Phase 1–2; a bump is a Phase 3+ decision (RE-D3) |
| `embeddings`, `llm_results`, `speaker_mappings` | SQLite via `node:sqlite` (`lib/embedding-cache.js:213`, `lib/llm-result-cache.js:381`, `lib/speaker-mapping-store.js:45`) | DDL copied verbatim; `PRAGMA table_info` parity test against fixtures created by the Node code |
| neo-arch | `vectors.<gen>.f32` (raw little-endian `f32`, vectors back to back), `vector-index.json` (byte offsets), `turn-journal.jsonl`, `record-index.json`, `generation.json` (`lib/neo-arch.js:2748`) | byte-compatible reader and writer |
| ledgers and state | `run-state.json`, `snapshot.json`, `conflict-log.jsonl`, `conflict-resolved.jsonl`, `memory-candidates.jsonl`, `destructive-ops.jsonl`, `behavior-cards.jsonl`, `retrieval-ledger.jsonl`, `reply-outcomes.jsonl`, `reconsolidation-events.jsonl`, `reaction-ledger.jsonl`, `.emotional-state.json`, `semantic-lens-index.json`, `hook-state.json` | one `JsonlLedger<T>`/`StateFile<T>` per file with the recorded line shape; append-only where the Node code appends |

### 1.5 Already decided or documented elsewhere

- [`docs/engine-extraction.md`](../../engine-extraction.md): the engine/adapter/UI map (a), the `HostServices` sketch
  (b.2), PR-01…PR-15 (c), risks R1–R8 (d), the two-repo recommendation (e). This plan supersedes (b.2) and (c) for the
  Rust engine and keeps (a), (d) and (e).
- [`docs/host-contract.md`](../../host-contract.md): time budgets (b), the embedding-owner IPC envelope
  `{ dimensions, fingerprintId, model, request, token }` and the single-dimension sites (d), defects f.1–f.15 (f). The
  Rust engine fixes f.1, f.4, f.5, f.6, f.9, f.11, f.14 and f.15 by construction (RE-2, RE-3, RE-4); f.2, f.7, f.8, f.10,
  f.12 and f.13 are adapter or script defects and vanish with the adapter.
- ADR-012 D7 (Rust for CLI, supervisor, installer, updater; TypeScript for the core; the engine is Node). RE-11 amends
  it with a new ADR ("ADR-018 — Rust engine").
- [`2026-10-20-memory-tree-relationships.md`](2026-10-20-memory-tree-relationships.md): WP1–WP3 define an additive
  engine contract for the memory tree: node table, placements, confidentiality levels, node summaries, KNOWLEDGE.md as
  root, and the tree mirror. That contract was planned as 1.17.0, but the harness pin now uses 1.17.0 for
  `reembedding.validate`, so the tree contract gets a new number when it merges. The Phase 1 parity baseline is the
  pin's contract 1.17.0 (1.16.0 + `admin.reembedding.validate`). A1 curated memory and the tree members are additive
  targets that the Rust engine implements natively (RE-D6).
  1.17.0 (node table, placements, confidentiality levels, node summaries, KNOWLEDGE.md as root, tree mirror). The Rust
  engine implements 1.17.0 directly (RE-D6); 1.16.0 is the Phase 1 parity baseline.

### 1.6 Behaviour the Phase 1 goldens encode on purpose

Phase 1 is behaviour-neutral (§2.3): a golden changes only with a CP id or a decision id in the commit body (RE-R1).
Three behaviours of the Node engine cost function, not only polish, and are still ported as they are, because changing
them in Phase 1 would make every parity run compare two different engines. Each has an owner decision in §6 and a
Phase 2 task in RE-10 (T7–T9). None of the three fixes needs a re-embedding: a re-embedding is due only when the
embedding model changes, and `plur1bus memory reembed` plus the import's adopt probe already cover that case. Line
numbers are `main` at `98dfe2f`. **Decided 2026-10-24:** all three fixes go ahead in Phase 2 as recommended
(RE-10 T7–T9).

Two facts the three rest on. The engine sets no `distanceType`, so Lance's default metric L2 applies, and the
`_distance` Lance returns for L2 is the **squared** Euclidean distance (`lance-linalg` takes no square root). Every
provider of the engine emits unit vectors (the local provider normalises, `lib/providers/embedding-local-transformers.js:30-33`,
`:805`; OpenAI, Cohere and Jina return normalised vectors), so `d = 2 − 2·cos ∈ [0, 4]`, and the L2 order equals the
cosine order row for row. A different metric would change numbers, never ranks; it is not one of the three.

| Id | Behaviour today | Evidence | Phase 1 | Fix (Phase 2, behind the decision) |
|---|---|---|---|---|
| RE-D11 | `distanceToScore(d) = 1/(1+d)` over that squared distance, so the score floor is 0.2. `minScore` (default 0.3, also the `search` default) drops only rows with cosine below −0.17, which real text pairs do not produce: the floor is inert. `forgetThreshold` (0.3) has no consumer in the closure but the dropped tool adapter. Query refinement fires only when every score is below `minScore` or nothing was found, so it is practically off. The stage-5 boosters are additive on this scale | `lib/score.js:15`, `lib/recall-pipeline.js:990`, `:1723`, `:1936-1950`, `lib/query-refiner.js:106-110`, `engine/store/memory-db.js:1045`, `engine/create-engine.js:427`; `KNOWN-ISSUES.md` "Recall observations" (its "cannot fall below 1/3" assumes an unsquared distance; the conclusion holds, the floor is 0.2) | RE-02 keeps the L2 default and never sets a metric; RE-04 ports score function, thresholds, refinement and boosters as they are; the goldens encode the `score` values | `score` becomes the cosine similarity itself (`1 − d/2` for unit vectors); `minScore` is calibrated per embedding profile from a golden set, as the engine's own note asks; the boosters are re-weighted to the new scale; `forgetThreshold` gets its consumer (`MemoryOps.forget` by text) or leaves the schema; refinement is re-gated or removed. The raw-stage order is unchanged by construction (a monotone transform); the post-booster order is not, so the task records an A/B on a frozen corpus before the default flips (engine-extraction R5) |
| RE-D12 | No exact-id or lexical retrieval path: the candidate sources are the vector search, graph spread and the neo prelude. A bare UUID, a file name or a rare token is not a semantic query. The engine authors list a hybrid path as their 7.5.1 candidate | `lib/recall-pipeline.js:1698`, `:1751`; `KNOWN-ISSUES.md` "Recall observations" | as it is; RE-02's rule "no new file in Phase 1" also excludes a full-text index | exact id and metadata lookup, a Lance full-text index (BM25) for lexical hits and the vector search feed one candidate pool, fused by reciprocal rank fusion before the existing ACL, budget, rerank and dedupe stages. The same fusion serves a store that holds two embedding identities after an import (host-contract d.3: scores of different models are not comparable). The index is built once over existing rows, no model call; RE-02's round trip proves the Node reader still opens a store that carries it |
| RE-D13 | `rem-dream`, `consolidate-daily` and `skill-miner` resolve their `workspace` and `user` partitions from the shared pools under `.plur1bus-shared/`, which only `/share` fills. A row captured into the agent's own table with `scope: workspace` or `scope: user` belongs to no partition: dreams, consolidation and the miner never read it (observed: three such rows, `rem-dream` answers `too_few_memories, count: 0`). The engine authors call the routing a design decision and left it | `KNOWN-ISSUES.md` "Deferred findings", last item; `lib/jobs/daily-consolidation.js:97-154` | RE-06 T3/T5/T6 port the routing as it is; the per-job golden deltas encode it | the agent's own partition reads every row of the agent table the job's principal may read (agent-private, and the workspace and user rows the agent itself wrote); the shared pools stay their own partitions; no row moves on disk. The alternative, migrating such rows into the pool, is rejected: it would share data without the owner's `/share`. The Rust counterpart of the engine's routing security test is re-derived in the same PR |


A fourth family of behaviour is also kept at parity, though it has no row of its own in this table: the engine's lexical
helpers. Examples:

- `lib/text-utils.js:12-21` `tokenize()` lowercases, applies NFKD and turns the combining marks into separators, so
  "Müller" reaches the recall Jaccard dedupe (`recall.dedupJaccard` 0.78) as `mu` + `ller`.
- `lib/memory-graph.js:601` extracts topics with an ASCII-only capitalisation regex, so "Köln" is lost and "Straße"
  becomes `stra`.
- `lib/neo-arch.js:2297-2299` keeps only `a-z0-9äöüß_-`, so "café" becomes `caf`.
- JS `\b`, `\w` and `\d` are ASCII.

Phase 1 ports every one of them byte-identically on the JS text layer of §2.5 (RE-04 T0). The fix is RE-D16 (RE-10 T10),
after the RE-D15 analyzer has landed. Like the three rows above, it needs no re-embedding.
### 1.7 Adapter functions the harness provides itself (RE-13)

Three functions the plugin delivered through Telegram and the Obsidian control room are dropped with the adapter
([`MODULE-MAP.md`](rust-engine/MODULE-MAP.md)) and had no harness counterpart. **Decided 2026-10-24:** the harness
provides them, as the Phase 2 work package [RE-13](rust-engine/RE-13-harness-surfaces.md), one task each. None of the
three changes a Phase 1 golden. Line numbers are `main` at `98dfe2f`.

| Function today (OpenClaw adapter) | Evidence | Harness surface (RE-13) |
|---|---|---|
| **Critical memories.** `classify-recent` marks a card critical and unconfirmed and pushes one Telegram message per card with Accept and Reject; `/plur1bus critical accept\|reject\|edit <ref>` decides; an unconfirmed card expires to a normal note (7.16.10) | `engine/jobs/internal-job-bodies.js:241-310`, `lib/critical-buttons.js`, `lib/critical-review.js`, `lib/db-adapter.js:1176`, `lib/jobs/auto-accept-stale-criticals.js:75` | T1: `engine.memory.critical.list\|decide`; inbox kind `memory-critical`, one entry per card, settled on decide or expiry; `plur1bus memory critical list\|accept\|reject` |
| **Skill-miner proposals.** Telegram buttons and commands approve, reject or retire a mined skill; approve renders `SKILL.md` into the workspace `skills/` folder and marks the evidence memories | `lib/telegram-commands/skill-commands.js:253,506,667`, `lib/jobs/skill-miner/proposal-writer.js` | T2: `engine.skills.proposals.{list,show,stage,activated,reject,retire}`; accept installs the staged folder through the X1 pipeline as an unsigned local skill, retire uninstalls it; inbox kind `skill-proposal`; `plur1bus skill proposals list\|show\|accept\|reject\|retire` |
| **Morning and evening review.** The control room assembles a review bundle (maintenance-light findings, change proposals, an adversarial-light check, a mood-aware narrative lead, the evening workspace status) into the vault and announces it; `applyMode` is always manual | `lib/obsidian-control-room.js:593-608`, `:1276-1600`, `lib/review-narrative-lead.js`, `lib/review-workspace-status.js`, manifest keys `morningReview`, `eveningReview` | T3: a twentieth engine job `daily-review` with `morning` and `evening` profiles, scheduled by the harness from the two config keys, written to `<state_dir>/reviews/<agentId>/`, inbox kind `review`, `plur1bus review list\|show`. The digest half is engine work; the vault-change half stays RE-07 T7b |

The two review helpers become `port` rows owned by RE-13; the Telegram and control-room files stay dropped and are
named as the behaviour reference.

## 2. Target architecture

### 2.1 Process and RPC (RE-D1, recommended)

```text
                 supervisor (plur1bus supervise) — slots: engine ──► core ──► api, modules
                                   │ spawn, health (engine.status), backoff, adoption
   ┌───────────────────────────────┴───────────────────────────────┐
   │ plur1bus-engine (Rust)                                        │   run/engine.{sock|pipe} + token, same ACL as run/
   │  Engine trait ─ recall ─ capture ─ jobs ─ memory ops ─ admin  │◄──── core: EngineClient (TS) implements `Engine`
   │  stores: lancedb 0.26.x · rusqlite · neo files · ledgers      │────► core: host.llm.complete / host.egress.decide /
   │  embeddings: ort + tokenizers (local) · ureq (remote)         │      host.secret.get / host.workspaceDir / host.event
   └───────────────────────────────────────────────────────────────┘      (engine delegation credential, RBAC-gated)
```

- One contract boundary, two sides: `crates/plur1bus-engine` serves `engine.*` over the harness RPC (RPC schema
  `x-server: "engine"`, the fourth server value after `core`, `supervisor`, `module`); `packages/core/src/engine/client.ts`
  implements the TypeScript `Engine` interface over `module-api`'s RPC client. `createEngine()` from the Node package
  and `new EngineClient()` are interchangeable at that interface — the core's 27 call sites stay as they are.
- Host services become reverse RPC: the engine holds a client connection to the core and calls `host.*` methods. The
  restriction to the engine is enforced where calls are dispatched, not where capabilities are listed: the connection
  that authenticated with the engine credential carries the principal kind `engine`, every `host.*` handler requires
  it, and the dispatcher answers any other connection with `E_DENIED` before a handler runs (the way the API's
  delegation credential is checked in `supervisor/api_transport.rs`; `rbac/guard.ts` adds the role rules on top).
  `fetch` is **not** proxied, and it is not a bare client either: the engine does its own HTTPS with `ureq`/`rustls`
  (already in the workspace) behind the same guard the harness HTTP client applies (`tools/web/`'s resolve-then-pin
  SSRF guard, `egress.request`): per hop — the first request and every redirect — it asks `host.egress.decide` for the
  exact `scheme`, `host` and `port`, resolves the name itself, checks every resolved address against the address rules
  the decision carries (loopback, private ranges, metadata endpoints), and pins the connection to the checked address
  so the DNS answer cannot change between check and connect. Decisions are cached per `(scheme, host, port)` with a
  short TTL and dropped on an `egress.changed` notification — the policy stays the core's, the bytes stay in the engine.
- Logging is direct: the engine writes its own JSONL through `crates/plur1bus-log-schema` (D111) with the catalogue's
  redaction rules; no log callback.
- No supervisor (ADR-012 §8 developer path, `plur1bus core run`): the core spawns `plur1bus-engine` itself, the way it
  runs `plur1bus-attest` as a child today; `PLUR1BUS_ENGINE_BIN` overrides the path like `PLUR1BUS_ATTEST_BIN`.
- Test seams: `PLUR1BUS_TEST_INTERNALS=flat-embedder|flat-embedder-cold` already exists as the environment counterpart
  of `--test-internals`; the engine process honours it with the same semantics as `packages/core/src/bin.ts` (a 384-d unit
  of `--test-internals`. The engine process honours it with the same semantics as `packages/core/src/bin.ts:64-84`:
  every text gets a unit vector e₀ of the configured embedding's width (384 only for the implicit e5-small default);
  the reranker is null; a flat `reembeddingTargetProvider` of the migration target's width means a re-embedding never
  loads a model; with `-cold`, the first two query embeddings of the process take 350 ms each, one after the other.
  The core's own `--test-internals` seam forwards the variant to the engine it spawns.
  vector e₀ for every text, null reranker; `-cold`: the first two query embeddings of the process take 350 ms each, one
  after the other). The core's own `--test-internals` seam forwards the variant to the engine it spawns.
- Distribution: one more binary in the release payload beside `plur1bus-attest` and `plur1bus-sandbox-limits`, for the
  five targets of `install/targets.rs` (`LinuxX64 LinuxArm64 DarwinArm64 WinX64 WinArm64`), in the container image and in
  the desktop bundle (RE-D10).

### 2.2 Why not N-API (the alternative)

A `napi-rs` binding (`@plur1bus/engine-native`, one `.node` file per target) would keep the engine in-process: no hop,
one process to supervise. It costs a second build matrix inside the Node build, a distribution mechanism the release
scripts do not have (no native module is assembled into the payload today), a panic across the FFI boundary that takes
the core with it, async host callbacks through `ThreadsafeFunction` for every LLM and fetch call, and a Phase 2 that
would have to introduce a process anyway to move memory logic out of the core. The hop costs tens to a few hundred
microseconds per call on a Unix socket or named pipe against a 400/600 ms recall budget (host-contract (b)); the harness
already supervises, adopts, health-checks and ACL-protects exactly this kind of child. Process + RPC is recommended;
N-API is recorded as the fallback if RE-8's budget measurement (§4, RE-8 step 7) fails.

### 2.3 Phases

| Phase | Outcome | Gate |
|---|---|---|
| **1 — behaviour-neutral engine** (RE-0…RE-9) | `plur1bus-engine` serves the pin's contract 1.17.0 at parity (1.16.0 + `admin.reembedding.validate`), then the A1 curated-memory and memory-tree members under the numbers the engine assigns them; the core selects it with `engine.implementation: "rust"` (`x-restart: "core"`, `x-tier: "advanced"`, default `"node"` until Phase 3) | RE-9 parity green; every `tests/system` suite green with `PLUR1BUS_ENGINE_IMPL=rust`; recall budgets met on reference hardware |
| **2 — memory-facing core paths move** (RE-10) | journal replay, restore re-apply, backup snapshot, re-embedding driver, media-search index hook, dream scheduler ledger and the `memory.curation.*` handlers run in the engine; the core keeps RBAC, policy, sessions, tools, channels; the three §1.6 behaviour changes land here (RE-D11…RE-D13, decided 2026-10-24, RE-10 T7–T9); RE-13 adds the harness surfaces for critical confirmations, skill proposals and the daily review (§1.7) | the moved paths' tests pass against the engine; `packages/core` loses the corresponding `node:sqlite` stores; every §1.6 golden a change touches is re-recorded with its decision id (RE-R1); the three RE-13 system tests green |
the exact-commit pin, `engine-shim.d.ts`, the engine's dependency on `@huggingface/transformers` and `GH_ENGINE_READ_TOKEN` are gone (`packages/core` keeps `@huggingface/transformers` as a direct optional dependency, for local Florence-2 captions only, §2.5);

A fourth phase — the rest of the TypeScript core (66,631 lines in 559 files: sessions, tools, MCP, channels, providers,
auth, policy, approvals, API) — is **not** in this plan. It is a programme of its own and is listed in §6 as RE-D9 so it
is decided, not drifted into.

### 2.4 Crate layout

```text
crates/plur1bus-engine/
  Cargo.toml                 lancedb = "=0.26.2" (lance =2.0.0 with `protoc`, arrow ^57.2), rusqlite 0.40 (bundled), jsonschema 0.26, ureq 3, serde, serde_json (RE-00); ort, tokenizers =0.23.2 (RE-03 T0; RE-D3b, RE-D19); fancy-regex 0.17, icu_normalizer, icu_collator (RE-04 T0); frostem (exact pin), unicode-segmentation (RE-10 T8)
  schema/engine-contract.schema.json   the contract (RE-1); engine-config.schema.json moves here in Phase 3
  src/lib.rs                 pub use contract::*; the `Engine` trait and `open_engine(host, config) -> Result<Box<dyn Engine>, EngineError>`
  src/contract/              generated types (typify) + hand-written traits: engine.rs, host.rs, jobs.rs, memory_ops.rs, admin_ops.rs
  src/config/                EngineConfig validation (same schema as today), tiering of engine keys, defaults
  src/store/                 lance.rs (table `memories`, `_embedding_identity`), sqlite.rs (three caches), neo_files.rs, ledger.rs, lock.rs, schema_version.rs, lexical.rs (the derived `_lexical` table; Phase 2, RE-D15)
  src/embedding/             identity.rs (VectorSpaceIdentity + identity_id), artifacts.rs (catalogue + licences), local_ort.rs, remote.rs, cache.rs, rerank/{local,cohere,remote,chained,signal}.rs
  src/recall/                pipeline.rs (12 stages), namespaces.rs (fan-out + merge), budget.rs, filter.rs (CandidateFilter), rerank.rs, knowledge.rs, graph.rs, temporal.rs, acl.rs, render.rs (six blocks), trace.rs
  src/capture/               pipeline.rs, chunking.rs, dedupe.rs, classify.rs, reconsolidate.rs, dynamics.rs, speaker.rs, epistemic.rs, valid_time.rs, journal.rs, checkpoint.rs
  src/text/                  js.rs (JS string and regex semantics, `JsString`; RE-04 T0), json.rs (tolerant reader/writer for Node-written JSON; RE-04 T0), legacy.rs (byte-identical Node splitters, Phase 1), analyzer.rs + stopwords/ (the DE/EN analyzer, `ANALYZER_ID`; Phase 2, RE-D15); see §2.5
  src/neo/                   the working-memory layer (lib/neo-arch.js)
  src/jobs/                  registry.rs, run_state.rs, lock.rs, one module per job (19), afterthought/, skill_miner/, dreams/{rem,light}.rs
  src/prompt/                layout.rs (stable prefix | volatile tail, cache breakpoints), templates/ (one file per prompt, versioned)
  src/ops/                   memory.rs (MemoryOps incl. curation), admin.rs, stores.rs (adopt), snapshot.rs, tombstones.rs, models.rs
  src/rpc/                   server.rs (engine.* over plur1bus-rpc), host_client.rs (host.*), seams.rs (PLUR1BUS_TEST_INTERNALS)
  src/main.rs                `plur1bus-engine serve --home <dir> [--lifeline stdin --instance <uuid>]`, exit codes per docs/errors.md
  tests/                     unit and integration tests; fixtures/store-v1/ (a small store the Node engine wrote), fixtures/sqlite/, fixtures/vectors/
tests/engine-parity/         scenarios/*.json, golden/*.json, run.ts (drives both engines), README.md          (RE-9)
packages/core/src/engine/    client.ts (EngineClient implements Engine), spawn.ts (no-supervisor child), select.ts (implementation flag)
```

Not ported, by rule: `HostServices.runtime` (the OpenClaw runtime shim), `HostPathOverrides.openclawHome`,
`HostCapabilities.pushCriticalButtons` (an adapter push), `mutateConfig` (the supervisor owns `config.json`, ADR-013 §5;
engine state such as `featuresConfirmedAt` becomes an engine state file), `lib/telegram-commands/`,
`lib/obsidian-control-room/`, the i18n tables, `scripts/`. The embedding-owner IPC (`lib/providers/scoped-embedding-ipc.js`,
720 lines) is replaced by `engine.embedding.*` RPC (RE-D4): with an engine process, the engine *is* the embedding owner.

### 2.5 Tokenization and text analysis (RE-D15…RE-D20)

In this system "tokenizer" names nine different jobs. The owner asked whether to adapt a well-known open-source tokenizer or to train our own for German and English. The answer differs by job:

- The tokenizers of the embedding and reranker models are **adopted unchanged**, because the model weights depend on them. That covers every profile a user can select, jina included.
- The lexical analyzer for hybrid retrieval is **ours, assembled from adopted permissive parts**.
- **No subword tokenizer is trained.** The only artefact this plan may ever train is a German decompounding frequency list, and only behind the measured gate of RE-D18.
- A vocabulary for a future own model is **adopted, not trained**, unless we train the model itself (J9, RE-D18).
- Token counting for LLM prompts, cache placement and budgets is implemented once, in Rust, inside the engine (`src/tokens/`, RE-14), and served to the core over `engine.tokens.*` (RE-D20, §2.6). It uses each provider's own tokenizer where one is public and licence-clean and a calibrated estimator otherwise. A project-trained vocabulary would be exact for no provider.

Engine line numbers below refer to the harness pin `9f34008c`. Every engine file cited here is identical at `98dfe2f0`, except `types/engine.d.ts`, which gained the 1.17.0 lines.

| Job | Fixed by | Choice | Licence | Phase, owner | Decision |
|---|---|---|---|---|---|
| J1 Embedding model input. multilingual-e5-small is the implicit default; EmbeddingGemma 2 is the wizard default since #771; jina v3 and v5-nano are selectable in the wizard and through `memory reembed --model` | the model weights | each artifact's own sha256-pinned `tokenizer.json`, loaded with `tokenizers =0.23.2`. Encode with special tokens and no truncation, then cut ids and mask to a per-profile `truncation_len`. Prefixes, task ids and pooling follow each runtime | crate Apache-2.0. Files keep their model's licence: e5 MIT, EmbeddingGemma 2 Apache-2.0, jina CC-BY-NC-4.0 (never bundled; the jina v3 ONNX repository `ldwformat/jina-embeddings-v3-Q8-onnx` carries no licence tag) | Phase 1, RE-03 T0/T3/T3b/T3c; jina goldens in RE-09 T3's real-model leg | RE-D19 |
| J2 Reranker pairs: bge-reranker-v2-m3 (default), jina-reranker-v2 (selectable) | the model weights | same loader; `text_pair` encoding, cut from the end at `truncation_len`, no `longest_first` | as J1. Hugging Face tags the `woxpas-ai` ONNX repository MIT (upstream `BAAI/bge-reranker-v2-m3` Apache-2.0); a licence file is confirmed in RE-03 T0 | Phase 1, RE-03 T4; jina goldens in RE-09 T3 | RE-D19 |
| J3 JS string semantics under every lexical port | ours | `src/text/js.rs`: JS `\s`; ASCII `\b`/`\w`/`\d`; UTF-16 length; `utf16_slice` returning a `JsString` that serialises as Node does for each target; lookarounds through `fancy-regex`; NFKD/NFC/NFKC through `icu_normalizer` with a pinned Unicode version; JS `trim`/`toLowerCase`; `localeCompare` through `icu_collator`. `src/text/json.rs`: a tolerant reader and writer for Node-written JSON | MIT, Unicode-3.0 | Phase 1, RE-04 T0 (also used by RE-02 T5) | RE-D17 |
| J4 Engine lexical helpers: at least 15 hand-written splitters with about 10 separate DE/EN stop lists (Jaccard dedupe, topics, fact quality, merge safety, query refiner, chunking, language guess, tier-1/tier-2 keywords, embedding-cache text normaliser) | ours | Phase 1: byte-identical ports on J3, German defects included. Phase 2: moved onto J5's `sets` profile | ours | Phase 1: the owner of each MODULE-MAP row. Phase 2: RE-10 T10 | RE-D16 |
| J5 Lexical analysis for hybrid retrieval (RE-D12) | ours | our own DE/EN analyzer assembled from adopted parts. Its terms live in the derived table `_lexical`, indexed by Lance BM25 with a pass-through `whitespace` tokenizer | BSD-3-Clause, MIT, Apache-2.0, Unicode-3.0 | Phase 2, RE-10 T8 | RE-D15 |
| J6 German compounds | ours | a word-internal 4-gram field `ng`, behind a gate; a frequency decompounding lexicon, behind two gates | ours; lexicon data derived from ODC-By and CC0/CC-BY text | Phase 2, RE-10 T8 (bake-off), T11 | RE-D15, RE-D18 |
| J7 Engine budgets and token figures | — | no tokenizer of its own. Ported verbatim: recall and context budgets (UTF-16 characters, whitespace words, memory counts), the chars-per-token heuristics and provider-reported usage. `tokensEstimate` and `JobCost.inputTokens`/`outputTokens` stay unfilled | — | Phase 1, RE-04 T5, RE-05, RE-06 (T2; `lib/llm-call.js`, `lib/llm-result-cache.js`) | — |
| J8 Token counting for LLM prompts, cache placement, context windows and token budgets | each provider's tokenizer | one counter in the engine (`src/tokens/`), families from the cache-profile table (§2.6): exact local tokenizer files where public (o200k for OpenAI models up to GPT-5.x, the Gemma 4 `tokenizer.json` for Gemini text, local models' own files), a calibrated estimator for Claude and every other unpublished tokenizer, provider count endpoints only for background calibration | per artifact, fetched through RE-3's catalogue after its licence decision (RE-D25) | service in Phase 1 (RE-14, unused by engine behaviour); consumers in Phase 2 (core, RE-10) | RE-D20 |
| J9 Vocabulary for a future own model, or a provider-neutral estimator proxy | the model it serves | adopt an existing permissive DE/EN vocabulary (shortlist below). Train one only if we train a model and the permissive options fail | Kolibri-1 repository Apache-2.0, but the grant may not cover `tokenizer.json`; OpenEuroLLM v1-256k and o200k Apache-2.0 | no task in this programme | RE-D18 |

Two further items are outside the programme. They are recorded here so they count as decided:

- The harness's SQLite FTS5 tables keep the built-in tokenizers, because `node:sqlite` cannot register custom ones.
- Florence-2 caption decoding keeps transformers.js (`packages/core/src/media-search/caption/local.ts:51-70`). `packages/core` therefore keeps the `@huggingface/transformers` closure (`@huggingface/tokenizers`, `onnxruntime-node`, `onnxruntime-web`, `sharp`, `pnpm-lock.yaml:2028-2038`) as its own optional dependency. RE-11 T2 declares it there. Phase 3 removes only the engine's dependency on it (§1.2, §2.3, §5.1). Moving captions onto ONNX Runtime outside Node would be core work and is not part of this programme (RE-D9).

**Where capture tokenizes (unchanged in Phase 1).** `engine/capture/capture-turn.js` handles each captured message in this order:

1. Text preparation: a summary or a cut to `captureMaxChars`.
2. The deterministic splitter `lib/memory-chunking.js` (`planChunks`). Fewer than 4 sentences: the message stays whole. Otherwise it proposes structural parts (lists, headings, paragraphs), or sentence parts from 8 sentences on.
3. Only when the splitter would cut, and `captureChunkingMode` is `automatisch` with a Jev key, Jev (`lib/jev-chunk-decider.js`, an external TypeSafe service) classifies the message as coherent, independent or mixed. Coherent at confidence ≥ 0.85 keeps the whole row only; independent keeps only the parts; mixed, low confidence, timeout and error keep both. Without Jev, `beides` (the default) keeps both and `geteilt` keeps only the parts. Jev judges the proposed cut; it does not cut.
4. Every kept row is embedded (J1): one vector per row, the parts linked by `chunkGroupId`.
5. Dedupe runs per row, by vector search, then the rows are stored.

So the model tokenizer runs once per kept row: a message stored as the whole plus three parts is tokenized and embedded four times. In Phase 2 the analyzer (J5) also runs once per kept row, when `_lexical` is written. Jev's input is cut at 60,000 characters because Jev accepts about 32k tokens (`JEV_MAX_STATE_CHARS`). That character cap is ported verbatim (J7); moving it to a count is a Phase 2 change under a decision id.

**What a project tokenizer cannot replace.**

- *Model input.* A model's input ids index its own embedding matrix, so a different vocabulary needs new input embeddings. Published methods keep the transformer body and predict or initialise that matrix (ZeTT, arXiv 2405.07883; FOCUS, arXiv 2305.14481; WECHSEL, arXiv 2112.06598). The result is still a changed model that must be re-validated and usually fine-tuned. None of these methods shows that retrieval quality survives for a contrastively trained embedder or a cross-encoder reranker.

  For the embedder the engine is stricter still. Each pinned `tokenizer.json`'s path and sha256 are part of the embedding identity (`lib/providers/embedding-identity.js:21-25`, `:36-37`; `lib/reembedding/runtime-config.js:48-70`), so changing even one byte forces a re-embedding of every store bound to that identity (`engine/store/memory-db.js:624-625`). A reranker change re-embeds nothing, because rerank scores are never stored, but it changes recall order and the parity goldens. Re-implementing the *same* tokenizer in Rust from the same file keeps the ids and the identity unchanged; that is what RE-03 does.
- *Provider counts.* Providers bill and enforce context windows in their own tokenizers, so a third vocabulary is never exact for any of them. Measured for this section (raw token counts, no calibration):
  - Three European-trained vocabularies (openeurollm-256k-v2, EuroLLM-22B, Teuken) are −8 % to +15 % off o200k on German and English prose, up to +23 % on German technical text, and up to +37 % on JSON and code.
  - o200k itself counts 2–8 % fewer tokens than Gemma and Mistral Tekken on text, and up to 16 % fewer than Gemma on code. As a budget proxy it therefore errs on the unsafe side.
  - The harness's `ceil(len/4)` (`packages/core/src/session/compaction.ts:29`) is within −5 % to +4 % of o200k, Gemma and Tekken on German technical prose (`docs/user/de`, the German sections of `AGENTS.md`). It overcounts German prose against o200k by 6–17 %. It undercounts code-dense German changelog text by 9–10 % against o200k, 14–16 % against Gemma and Tekken, and up to 26 % against EuroLLM.

  The counter of RE-D20 closes that gap with per-provider tokenizers and calibration; a project-trained vocabulary would not.
- *Engine budgets.* The engine runs no tokenizer to budget recall or prompt context. Its budgets are:
  - UTF-16 characters: `ContextBlock.chars = text.length` (`engine/recall/assemble-prompt-context.js:1249`) and `recall.globalInjectMaxChars`;
  - whitespace words: `semanticCompression.tokenBudget` (`lib/text-utils.js:122-184`);
  - memories: `lib/recall-budget.js:17-46`.

  `tokensEstimate` (`types/engine.d.ts:364-371`) has no producer. `JobCost.inputTokens`/`outputTokens` (`types/engine.d.ts:543-544`) are never filled: job runs record only `{ ms }` (`engine/jobs/job-registry.js:156`, `:315`). Token figures appear in three other places, none of them a context budget:
  - the local models' own tokenizers cut each input at a token count (J1, J2);
  - provider-reported usage is read from each LLM response and kept in the LLM result cache as avoided-token counters and columns (`lib/llm-call.js:72-84`, `lib/llm-result-cache.js:276-283`, `:386-388`);
  - chars-per-token heuristics size LLM output limits and the recall query cap: `CHARS_PER_TOKEN = 3` (`lib/knowledge-update-budget.js:13`), `maxTokens: maxChars / 3` (`engine/runtime/env-config.js:108`), and `EMBED_CHAR_LIMIT = 20000` characters, above which recall summarises the query before embedding it (`lib/recall-pipeline.js:1568-1571`).

  All of them are ported verbatim (J7).

**J9: if "tokenizer" means a vocabulary.** Read as "which subword vocabulary should a DE/EN model of ours use", the question has a measured answer. The research measured fertility (tokens per whitespace word, German / English) on FLORES-200 dev+devtest (2,009 parallel sentences):

| Vocabulary | German / English | Licence and note |
|---|---|---|
| Aleph Alpha Kolibri-1, 128k byte-level BPE (released 2026-10-03) | 1.379 / 1.238 | Close to a German-only tokenizer on German (dbmdz German GPT-2: 1.371) and close to o200k on English (1.223). The repository is Apache-2.0, but the card limits the grant to "weights and configuration files published in this repository". `tokenizer.json` is in the repository but not named, so Aleph Alpha must confirm in writing before we ship it. Three weeks old. |
| OpenEuroLLM tokenizer v1-256k | 1.469 / 1.253 | Apache-2.0, in a dedicated repository. The maintained v2 is worse on German (1.656). |
| o200k (`openai/gpt-oss-20b` `tokenizer.json`) | 1.605 / 1.223 | Apache-2.0. Also OpenAI's own encoding. |
| cl100k family (cl100k, Llama 3, Qwen2.5/3) | about 1.96 / 1.24 | — |

On a different text set (held-out FineWeb-2 and FineWeb documents, where o200k scored 1.657 / 1.265), our own byte-level BPE 64k reached 1.499 / 1.333. That is roughly 10 % fewer German tokens than o200k. Kolibri-1 is roughly 14 % fewer than o200k on FLORES. The two comparisons use different text sets, so they show direction only.

Verdict: a 128k DE/EN-targeted vocabulary already reaches about 1.38 / 1.24, so adopting beats training. We train a vocabulary only if we train a model and none of the permissive options fits it (RE-D18). As a budget-estimator proxy, any of these remains an estimate (see *Provider counts* above).

**Why no subword tokenizer for retrieval.** The research for this section measured BM25 (k1 1.2, b 0.75) MRR@10 on GermanQuAD-retrieval (474 passages, 2,204 queries). The scratch scripts are not committed; RE-10 T8 repeats the numbers on the frozen corpus. Brackets give the result with 5,000 German web distractors added:

| Analyzer | MRR@10 (with distractors) |
|---|---|
| own byte-level BPE 32k | 0.891 (0.854) |
| own Unigram 32k, whole numbers kept | 0.921 (0.879) |
| Snowball German stemming | 0.921 (0.897) |
| the shipped XLM-R vocabulary of e5 | 0.929 (0.899) |
| character 4-grams | 0.922 (0.894) |
| rank fusion of Snowball and 4-grams | 0.931 (0.903) |

A trained subword vocabulary never beat the untrained stemmer. Subword pieces also depend on context. The XLM-R vocabulary splits "Versicherung" as `▁Ver|sicherung` but "Krankenversicherung" as `▁Kranken|versicherung` (checked with SentencePiece 0.2.2 and transformers.js 4.3.1), so the word and the compound share no term.

**Why not Lance's built-in German analyzer.** In `lance-index 2.0.0` (`src/scalar/inverted/tokenizer.rs:285-317`) the filter chain is `RemoveLong → LowerCaser → Stemmer → StopWordFilter → AsciiFolding`. That has five consequences:

1. Stop words are matched after stemming, so 80 of the 231 Snowball German stop words survive (`für → fur`, `gegen → geg`). The list also has `daß` but not `dass`.
2. The stemmer is `rust-stemmers 1.2.0` from 2019, older than Snowball 3.0.0 (2025-05-08). `Mueller` and `Müller` therefore get different stems.
3. `RemoveLongFilter` silently drops tokens of 40 bytes or more (`tantivy-0.24.2/src/tokenizer/remove_long.rs:17-36`), and long compounds go with them.
4. An index has one language.
5. `base_tokenizer` is a closed match with no custom hook (`tokenizer.rs:334-395`).

There is a version risk as well. lance-index 6.0.0 moves analysis into `lance-tokenizer`, which keeps `rust-stemmers 1.2.0` through 10.0.0. From `lance-tokenizer` 11.0.0 (used by lance-index 11.0.0, 2026-08-30) the stemmer is `frostem ^1.20260804.0`. An index built with `stem = true` therefore changes meaning when an RE-D3 Lance upgrade crosses 11.0.0. Because that requirement is a caret range, a plain `cargo update` can change stems again within the same Lance version.

**The analyzer (RE-D15, RE-10 T8).** `src/text/analyzer.rs`, versioned by `ANALYZER_ID`. The same function runs on write and on query:

1. NFKC (`icu_normalizer`), then UAX #29 word segmentation (`unicode-segmentation`). An identifier run (`v1.2.3`, `memory_ops.rs`, `user@example.com`, a UUID, a CLI flag) is emitted whole and also as its parts.
2. Full Unicode case folding: `ß` and `ẞ` become `ss`.
3. Stop words are removed **before** stemming: the Snowball German list plus `dass`, and the Snowball English list.
4. Two fields:
   - `de`: diacritics stripped, then frostem German (Snowball 3, which includes the former german2 rules), so `Müller`, `Mueller` and `Muller` all become `mull`.
   - `en`: frostem English (Porter2).

   German folding never touches `en`: frostem German maps `blue → blu` and `Michael → michal`.
5. Numbers stay whole. A term longer than 128 bytes is dropped and counted in the trace.

Only the Rust writer runs the analyzer. Lance indexes the fields with:

- `base_tokenizer = "whitespace"`;
- `lower_case`, `stem`, `remove_stop_words` and `ascii_folding` all `false`;
- `max_token_length` unset;
- `with_position = false`.

The index never re-analyses, so the terms do not depend on the Lance version. They can also feed an SQLite FTS5 table unchanged if RE-D3 moves the store. The query is analysed by the same function and runs as one multi-field match over `de` and `en`. That match is one RRF source next to exact id and vector (RE-D12). T8 measures whether `summary` terms join the `text` terms or get their own field, and records the choice.

**The derived table `_lexical` (RE-D15).** One Lance table per agent store directory, next to `memories`: `{ id, analyzer_id, content_hash, de, en, ng? }`.

The Node engine opens only `memories` and `_embedding_identity`, by name (`engine/store/memory-db.js:615-616`). A re-embedding generation is created with exactly those two tables (`lib/reembedding/lance-backend.js:425-429`). So `_lexical` leaves the 69-column schema and RE-D3 untouched, and a fallback to `engine.implementation: "node"` cannot fail because of it.

Adding columns to `memories` is rejected for two reasons:

- The Node engine would never write them. Its insert path defaults most of the columns it knows and drops keys the table lacks (`memory-db.js:504-506`, `:574-579`). A Node write would therefore leave the terms empty or be refused; the engine's own comment records such a refusal for a missing `chunkGroupId` (`lib/safe-update.js:164-168`). A Node update of `text` would leave stale terms either way. Node does add missing columns, but only those on its own list: at open (`memory-db.js:653-758`) and before a shared insert (`lib/shared-memory.js:122-157`). It never fills a column it does not know.
- The re-embedding copy derives each generation's schema from the source table (`lance-backend.js:420-427`), so the columns would follow into every generation.

Rules for `_lexical`:

- **Write order.** Every `memories` write, update and delete is followed by the matching `_lexical` change in the same `Store` operation, always `memories` first and `_lexical` second. This includes forget, tombstone and erase. Lance has no cross-table transaction, so a crash between the two commits can leave `_lexical` behind; the open-time check repairs it. Old Lance versions of `_lexical` are cleaned up under the same policy as `memories`. The lexical terms of a forgotten row never outlive it.
- **Hits.** A lexical hit is only an id. It is hydrated from `memories` and passes the ACL like every other candidate (RE-04 T3), so a stale id simply drops out.
- **Content hash.** Each `_lexical` row carries `content_hash`, the sha256 over `text`, NUL, `summary`, NUL, `status`. A status change therefore counts as a change too: a tombstone sets `status: "deleted"`.
- **Watermark and repair at open.** `lexical-state.json` keeps a watermark: the `memories` table version and `analyzer_id`. When the table version at open differs from the watermark, the engine scans `(id, text, summary, status)` of `memories` and diffs the hashes:
  - changed rows are re-analysed;
  - missing rows are added;
  - rows gone from `memories`, or excluded by the recall status filter, are removed.

  The scan is O(n), about 20,000 rows at the T8 budget, and it runs only after a Node session or a crash. `updatedAt` cannot serve as the change signal, because Node does not maintain it. It defaults to 0 (`engine/store/memory-db.js:546`), and `MemoryDB.update()` (`:1253-1300`), `tombstone()` (`:1236-1242`) and direct `table.update` calls (`engine/memory-ops/shared.js:118`; `rebind.js:109` through `MemoryDB.update`) patch values without setting it. The default implementation stays `"node"` through Phase 2 (§2.3), so switching back and forth is the normal case, not an edge case.
- **Unindexed rows.** Rows not yet covered by the index are searched by flat scan, for match queries only (`lance-2.0.0/src/dataset/scanner.rs:2955-2968`; phrase queries see only indexed fragments). The flat path passes only the query terms (`lance-2.0.0/src/io/exec/fts.rs:465-471`). T8's queries therefore use only what it honours: operator `Or` (the default), boost 1.0 on every field, no fuzziness, and no phrase queries (`with_position = false`).
- **Rebuild.** A changed `analyzer_id`, a re-embedding switch, or a restore that lacks the table rebuilds `_lexical` from `text`/`summary`. No model call, no re-embedding.

Fallback (RE-D15 b). It is used in exactly one of three cases:

- the owner refuses a new table before Phase 3;
- RE-02's Node round trip fails with `_lexical` present;
- the analyzer misses its exit criteria.

The fallback is the Lance built-in index on `memories.text` and `summary`, with every parameter explicit and nothing language-specific: `simple`, `lower_case = true`, `ascii_folding = true`, `stem = false`, `remove_stop_words = false`, `max_token_length = 128`, and `with_position = true` on `text`. Measured MRR@10 is 0.885 (0.857 with distractors) against Snowball's 0.921 (0.897). That is acceptable for RE-D12's purpose of finding rare tokens. Its splitting and folding are still re-checked with golden term vectors on a Lance upgrade, because analysis moves into `lance-tokenizer` from lance-index 6.0.0.

**German compounds (RE-D15, RE-D18).** Every existing decompounding dictionary has a licence that `deny.toml` does not allow:

- hunspell `de_DE_frami`: GPL;
- `german-decompounder`: LGPL-3.0-or-later. It is embedded in `charabia`'s default `german-segmentation` feature, where cargo-deny cannot see it;
- `hyph_de`: LPPL/LGPL.

So the two steps below come first, and neither needs training:

1. The field `ng`: character 4-grams inside each folded word, never across spaces. Lance's own `ngram` tokenizer is not used, because it crosses whitespace and puts every gram at position 0. `ng` is adopted only if it passes the gate below.
2. Only if a gap remains: the lexicon of RE-D18.

Literature on CLEF 2002 German (Hollink, Kamps, Monz, de Rijke 2004), in MAP: words 0.3886, Snowball stemming 0.4171, compound splitting 0.4360, split plus stem 0.4816. Their splitter used no dictionary, only the collection's own words and frequencies, with minimum part lengths and a few linking elements.

**Training stance (RE-D18).** No subword tokenizer (BPE, Unigram or WordPiece) is trained for this engine. The one trainable artefact is the German decompounding lexicon, and it is built only when the T8 gate below triggers it (RE-10 T11).

- *Corpus.* 2–4 GB of German text:
  - FineWeb-2 `deu_Latn`, at least 80 %, with the dataset revision pinned. Licence ODC-By 1.0, also subject to the Common Crawl terms of use.
  - German Commons subsets, at most 20 %, filtered to `CC0-1.0`/`CC-BY-4.0` by their per-document SPDX field: court decisions, OpenLegalData, Bundestag Drucksachen and Plenarprotokolle, WikiNews. The filter excludes EuroVoc (EUPL) and the Reichstagsprotokolle (CC-BY-SA).

  Excluded: CC BY-SA (Wikipedia), OSCAR and CulturaX, historical OCR subsets, hunspell and hyphenation data, and every byte of owner data, because frequency lists leak their training data. A `RECIPE.json` records dataset ids, revisions, shards, byte ranges, the sha256 of the extracted text and the tool version. The corpus is deleted after the build (§44b(2) UrhG); only the manifest is kept.
- *Algorithm.*
  1. Count word forms after the analyzer's own normalisation: NFKC, case folding, German folding.
  2. Keep forms above a count threshold that T11 sets (estimate: ≥ 50).
  3. Split a word of at least 8 characters into parts of at least 4 characters, allowing the linkers `-s-`, `-es-`, `-n-`, `-en-` and `-e-`. Accept a split when the geometric mean of the part frequencies exceeds the word's own frequency (Koehn & Knight 2003).
  4. Emit the compound and its parts, in a deterministic order with a deterministic tie-break.

  The builder is an offline tool: a feature-gated example of `plur1bus-engine`, following the `make-fixtures` pattern, never linked into the shipped binary. Its output is an FST (`fst`, already in `Cargo.lock`) with a sha256. The FST is committed under `crates/plur1bus-engine/assets/lexicon/` together with `RECIPE.json` and an ODC-By `NOTICE`, and loaded with `include_bytes!`. Two runs must produce the same sha256. Adopting the lexicon bumps `ANALYZER_ID`. Its size is still to be measured.
- *Reopening the subword question* needs evidence, not preference. An own subword field fused by RRF must beat the shipped XLM-R vocabulary used the same way by at least 1.0 point of German MRR@10 (0.010 on the 0–1 scale), with no English loss on any bake-off corpus, the local store snapshot included. XLM-R's cost must be stated honestly too: under the EmbeddingGemma 2 default it means an extra 17 MB `tokenizer.json`, and it couples the index to the embedding choice.

**Bake-off and exit criteria (RE-10 T8).** The frozen corpus `tests/engine-parity/corpus/lexical-ab/` contains:

- GermanQuAD-retrieval. Its dataset card says CC BY 4.0, but the GermanQuAD paper scopes that licence to the annotations, and the passages are German Wikipedia paragraphs (CC BY-SA). It is therefore fetched at test time by pinned dataset revision, like the distractors, credited in an `ATTRIBUTION` file, and never committed;
- 5,000 FineWeb-2 distractors, plus any English set without a CC0/CC-BY licence. These are fetched at test time by pinned dataset revision with a sha256 `manifest.json` and are never committed;
- an English retrieval set under CC0 or CC-BY, chosen in T8;
- a hand-made identifier set (UUIDs, paths, versions, e-mail addresses, CLI flags, environment names) and 200 German compounds with gold split points, both written by us;
- the RE-10 T7 `recall-ab` corpus;
- a snapshot of the owner's store, run locally. Only aggregate numbers leave the machine, and the snapshot is never committed.

Arms: vector only; the fallback profile; the analyzer; analyzer + `ng`; analyzer + lexicon (only if the lexicon is built).

Metrics per language: lexical-only and hybrid MRR@10 and recall@10; identifier hit@1; added p95 recall latency; index build time and size at 20,000 rows.

The gate values below were chosen for this plan; they are not measurements. Deltas are in points: one point is 0.01 of MRR@10 or recall@10 on the 0–1 scale the tables above use.

| Gate | Passes when |
|---|---|
| the analyzer ships (otherwise the fallback) | German hybrid MRR@10 is at least the fallback's, on GermanQuAD with distractors and on the local snapshot; English is at most 0.5 points below the fallback; identifier hit@1 = 100 %; added p95 ≤ 10 ms; build ≤ 30 s |
| the `ng` field ships | at least +1.0 point of German MRR@10 over the analyzer alone, with the latency and build budgets still met |
| the lexicon is built (T11) | after analyzer (+ `ng`), recall@10 on the compound-query subset trails the non-compound subset by more than 10 points |
| the lexicon ships | at least +1.5 points of MRR@10 on the compound subset, an overall German loss of at most 0.3 points, budgets met |

**Phase 1 parity rules.**

- No analyzer, no `_lexical`, no full-text index and no new file in Phase 1 (RE-02).
- Model tokenization yields exactly the Node token ids. transformers.js 4.3.1 cuts the finished id array after the special tokens are added (`src/tokenization_utils.js:128-133`), so an over-cap text loses its closing `</s>`, `<eos>` or `<|end_of_text|>`. For jina v5 the pooled last token is then a content token. e5's cap is the tokenizer's `model_max_length`, 512 (`embedding-local-transformers.js:736`, `:805-813`), not the identity's `tokenCap`. The identity keeps `cfg.tokenCap ?? cfg.maxTokens` byte-identical inside the persisted identity.
- Every lexical helper is ported byte-identically on `text::js`, German defects included (§1.6, last paragraph).
- The embedding-cache key is ported whole. It is the sha256 of the NUL-separated tuple (provider, model, dimensions, scopeId, `v2`, identityHash, textHash) (`lib/embedding-cache.js:17`, `:58-61`).
  - `textHash` is the sha256 of the text after JS `trim()` and `toLowerCase()`, with no Unicode normalisation (`:34-36`).
  - `identityHash` is the embedding identity id or the literal `legacy` (`:658-666`).
  - The local provider appends the purpose to the model (`lib/providers/embedding-local-transformers.js:852-858`).

  JS `trim()` strips U+FEFF, which Rust's `str::trim` keeps, so the normaliser goes through `text::js`.
- The chars/3 and chars/4 heuristics stay verbatim, prompt wording included (`lib/knowledge-update-budget.js:13`, `engine/runtime/env-config.js:104-108`), because they enter the LLM result-cache key.
- **A slice cap that cuts inside a surrogate pair (RE-D17 a).** JS `.slice()` then leaves a lone surrogate, which a Rust `String` cannot hold. Cap sites:
  - capture 15,000;
  - fullText 2,000;
  - display 400;
  - neo `normalizeStatement` 4,000 and 1,000 (`lib/neo-arch.js:2258-2259`, `:2288`);
  - the env-config summary prompt's `text.slice(0, 60000)`.

  What Node writes depends on the target:
  - At a UTF-8 boundary (Lance through Arrow, SQLite, `createHash().update(string)`) the lone surrogate becomes U+FFFD.
  - In JSON text (`JSON.stringify`) it stays the six-character escape `\ud83d`. That covers the neo JSONL files (`lib/neo-arch.js:873`, `:2456`), ledgers, state files and RPC.
  - Hash material built from JSON hashes the escape: neo stable ids (sha256 of `JSON.stringify(["neo-stable-id-v1", ...parts])`, `lib/neo-arch.js:242-249`, used with the cut statement at `:1457`) and the LLM result-cache key (`stableSerialize` writes strings through `JSON.stringify`, `lib/llm-result-cache.js:126-129`, `:165-182`).

  `text::js::utf16_slice` therefore returns a `JsString` that keeps the UTF-16 result and serialises it per target, exactly as Node does. A U+FFFD everywhere would give different neo ids after an engine switch (duplicates) and LLM result-cache misses. serde_json rejects the escape on input ("lone leading surrogate in hex escape"), so every Node-written JSON or JSONL file is read through `text::json`, which keeps the escape and writes it back byte-identically (RE-02 T5).
- `localeCompare` without a locale is settled by RE-D17 (b).

Phase 2 golden changes carry RE-D15, RE-D16 or RE-D18 (RE-R1). Nothing in this section needs a re-embedding; an analyzer change costs a `_lexical` rebuild.

**Dependencies and data.**

| Component | Licence | Enters | Note |
|---|---|---|---|
| `tokenizers =0.23.2`, `default-features = false` | Apache-2.0 | RE-03 T0 | regex backend per RE-D19: `fancy-regex` (pure Rust; an implicit feature of the optional 0.17 dependency, which upstream enables only through `unstable_wasm`) or `onig` (the default; the C library Oniguruma) |
| `fancy-regex` 0.17.x | MIT | RE-04 T0 | direct dependency, on the line `tokenizers` uses; `jsonschema` keeps 0.14.0 |
| `icu_normalizer` 2.3.0 (in `Cargo.lock`), `icu_collator` (new), `icu_casemap` or `caseless` 0.2.2 | Unicode-3.0, MIT | RE-04 T0, RE-10 T8 | `icu_collator`'s binary-size delta is measured in the gate |
| `unicode-segmentation` 1.13.3 (in `Cargo.lock`) | MIT OR Apache-2.0 | RE-10 T8 | |
| `frostem`, features `german` and `english` | BSD-3-Clause | RE-10 T8 | `=` pin to the newest release that is at least 14 days old at the gate (on 2026-10-25: `1.20260821.7` of 2026-09-24). Its minor version is the Snowball algorithm date, so a bump changes stems. Fallback: `rust-stemmers 1.2.0`, already in `Cargo.lock` |
| Snowball stop lists | BSD-3-Clause | RE-10 T8 | vendored; listed in `THIRD_PARTY.md` |
| `fst` 0.4.7 (in `Cargo.lock`) | Unlicense/MIT | RE-10 T11 only | |

cargo-deny cannot see the licences of data files. RE-10 T8 therefore adds a "Data artefacts" section to `docs/dependency-policy.md`:

- every shipped data file carries a sha256, a licence, a `RECIPE.json` and a `NOTICE`, and is reviewed by hand;
- the corpus licence allow-list is ODC-By-1.0, CC0-1.0, CC-BY-4.0, and works without copyright under §5 UrhG;
- test corpora whose text licence is unclear or share-alike are fetched at test time by pinned revision, never committed;
- no personal data;
- named traps: `charabia`'s default `german-segmentation`, hunspell `de_DE_frami`, `hyph_de`, `german-decompounder`.

**Owners.**

- RE-02: T1 a Lance fixture row cut inside an emoji (confirms U+FFFD at the UTF-8 boundary); T5 the tolerant reader for every Node-written JSON/JSONL file, with a lone-surrogate fixture line.
- RE-03: J1, J2 and the cache key (T0, T3, T3b, T3c, T4, T6). The jina goldens run in RE-09 T3's real-model leg on files fetched with consent.
- RE-04:
  - T0 owns `text::js` (with `JsString`), `text::json` and `text::legacy::text_utils`.
  - RE-04, RE-05 and RE-06 own every other Phase 1 splitter, by MODULE-MAP owner.
  - RE-05 adds the golden for a neo `stableId` whose statement is cut inside an emoji.
  - RE-06 owns the provider-usage pass-through of `lib/llm-call.js` and `lib/llm-result-cache.js`, and an LLM result-cache key golden whose prompt is cut inside an emoji.
- RE-10: T8 owns the analyzer, `_lexical`, the index, `ng` and the bake-off; T10 moves the helpers onto the analyzer (RE-D16); T11 builds the lexicon, only if its gate opens.
- RE-11 T2: `@huggingface/transformers =4.3.1` becomes a direct optional dependency of `packages/core` before the pin goes. Florence-2 captions import it (`packages/core/src/media-search/caption/local.ts:51-70`) and today get it only through the engine's optional dependency. Whether that import resolves under pnpm's isolated layout is unverified.
- RE-14: the token counter and the provider cache-profile table (RE-D20, RE-D21; §2.6).

### 2.6 Provider prompt caching and token counting (RE-D20–RE-D29)

Owner rule (2026-10-25): the harness adopts each provider's prompt caching as that provider documents it. That covers at least Anthropic, OpenAI (API, ChatGPT plan, Codex), xAI, Moonshot, Google and OpenRouter. Token counting must be accurate enough to support this. This section fixes where that logic lives after the rewrite. It does not change the engine's Phase 1 behaviour (§2.3).

The provider facts were checked against vendor documentation on 2026-10-25 and are recorded, with sources, in [`rust-engine/provider-cache-profiles-2026-10-25.md`](rust-engine/provider-cache-profiles-2026-10-25.md). They move into a profile table (below), and `docs/provider-matrix.md` §3 is generated from that table.

**Starting point.**

- **Engine (pin `9f34008c`, plugin line up to v7.18.31).**
  - Every feature call goes through `lib/llm-router.js` and `engine/runtime/llm-calls.js` to OpenAI-compatible chat completions (`lib/llm-call.js:13-56`). The one exception is `lib/tier3-llm.js`, which builds its own client.
  - No version sets a cache marker or an affinity key. The engine reads one cache figure, `prompt_tokens_details.cached_tokens`, and it only feeds the result-cache counters. `callLlm` returns the text and nothing else (`llm-call.js:104`, `engine/runtime/llm-calls.js:35-36`).
  - Anthropic's OpenAI-compatible endpoint does not support prompt caching. An engine feature routed there is therefore never cached.
  - CP-3 (7.18.26) assumes that the host's Anthropic transport caches the system block. The harness has no such route for engine features today (`packages/core/src/composition/embedding-policy.ts:107-108`, `host.ts:30,38`).
- **Engine budgets are not token counts.**
  - `semanticCompression.tokenBudget` is a word count (`lib/text-utils.js:119,129`, default 240).
  - The recall caps are characters: 17,000, 12,000 and 2,000.
  - The knowledge update assumes three characters per token (`lib/knowledge-update-budget.js`).
  - The capture summary targets `maxChars/4` characters with `maxTokens: maxChars/3` (`engine/runtime/env-config.js`); CP-1 raises the ceiling to `maxChars/2`.
  - `contextBlock.tokensEstimate` is declared (`types/engine.d.ts:370`) but never filled.
- **Core (`fd22fb24`).**
  - The ADR-010 builder estimates tokens as `ceil(chars/4)` (`prompt/builder.ts:60-61`) and withholds every marker below a model's minimum (`builder.ts:157`).
  - The cache table covers only Anthropic, OpenAI and Gemini (`prompt/model-table.ts`).
  - Markers reach the wire only for `anthropic_messages` (`composition/http.ts:54`).
  - No affinity key (`session_id`, `prompt_cache_key`, `x-grok-conv-id`) is sent anywhere.
  - Compaction counts chars/4 times a per-model EWMA (`session/tokens.ts`).

**Provider classes.** The host assigns every route to one class. The engine never sees provider fields.

| Class | Providers (2026-10-25) | Host emits | Request with no expected reuse |
|---|---|---|---|
| explicit breakpoints | Anthropic (Claude API, Claude Platform on AWS, Foundry, Bedrock, Google Cloud; Bedrock InvokeModel and legacy Bedrock take block markers only, no top-level automatic caching); OpenAI GPT-5.6+ and GPT-6 (`prompt_cache_breakpoint`); Alibaba explicit cache; OpenRouter for Anthropic and Qwen | markers at the engine's `cache_after` boundaries that pass the margin rule, within the profile's breakpoint or write limit; TTL from the profile | no marker; on OpenAI 5.6+, `prompt_cache_options.mode: "explicit"` with no breakpoint, because implicit mode bills a 1.25× write |
| implicit with a TTL tier | Moonshot K3 (`prompt_cache_options.ttl` on Chat/Responses, top-level `cache_control.ttl` on Messages; `prompt_cache_breakpoint` returns 400) | the TTL tier; no marker | `5m` (write 1.0×); caching cannot be turned off |
| implicit with a routing key | xAI (`x-grok-conv-id` on Chat Completions, `prompt_cache_key` on Responses); OpenAI before 5.6 (`prompt_cache_key`); Mistral (`prompt_cache_key`); OpenRouter sticky routing (`session_id`) | a stable per-session key derived from the builder's sticky id | nothing to suppress |
| implicit, no control | DeepSeek, Gemini 2.5+ implicit, Z.ai, Alibaba implicit, Moonshot K2 | stable prefix only | nothing |
| local KV prefix cache | llama.cpp `llama-server` (also Ollama for GGUF), vLLM, SGLang, LM Studio | stable prefix only; `id_slot` per session on `llama-server` | nothing |

Gemini's explicit `cachedContents` is not used by this plan. It exists only on the legacy `generateContent`, not in the Interactions API and not on Gemini 4 Argon or later, and its storage is billed per token-hour.

**Rules.**

1. **One counter, one table, one emitter.**
   - Token counting is implemented once, in the engine (`src/tokens/`), and served to the core (RE-D20).
   - Provider cache facts live in one versioned JSON table owned by `packages/providers` (RE-D21).
   - Only the core writes provider markers, TTL fields and affinity keys. It does so through one emitter that serves both chat turns and `host.llm.complete` (RE-D22).
   - The Node engine's direct client in `lib/tier3-llm.js` is not ported.
2. **The engine states intent; the host acts on it.**
   - An engine prompt is a `Layout` of role-tagged segments with `cache_after` boundaries, plus a `CacheIntent` (reuse class, TTL hint, affinity scope).
   - The engine never names a provider field and never parses provider usage.
   - The host returns normalised usage and the resolved route in `LlmResult`.
3. **Parity first.**
   - Phase 1 keeps every engine budget, estimator and prompt text byte-identical (RE-D23 budgets, RE-D24 prompt order).
   - The counter and `engine.tokens.*` exist in Phase 1, but nothing in the engine's Phase 1 behaviour reads them.
   - The core keeps chars/4 unless `prompt.tokenCounting` is `"engine"` (`x-restart: "core"`, `x-tier: "advanced"`, default `"heuristic"`).
4. **Margin near minimums (RE-D26).** Every count carries `lower`, `upper` and a method.
   - The host places a marker when `upper ≥ floor` if the profile documents a below-minimum marker as silent. Anthropic, for example: the request is "processed without caching, and no error is returned".
   - The host requires `lower ≥ floor` where a below-minimum marker is an error (Gemini explicit caches) or the behaviour is unverified.
   - R2's `prompt.below-minimum` fires when `lower < floor`.
   - Budget reservations, compaction triggers and context-window checks use `upper`.
   - A near-minimum prefix (`lower < floor ≤ upper`) is confirmed from the next usage report. The outcome is remembered per (profile, prefix hash).
   - A family with no observations keeps today's chars/4 rule.
5. **Calibration from usage (RE-D27).**
   - Per (route, tokenizer family, method), the engine fits reported prompt totals against its own counts: a slope for tokenizer mismatch and an intercept for chat-template framing and hidden preambles.
   - Observations come from the engine's own `LlmResult.usage` and from the core through `engine.tokens.observe`.
   - Totals are normalised first. OpenAI-shaped `prompt_tokens`/`input_tokens` include cached tokens; Anthropic-shaped `input_tokens` exclude reads and writes. An absent field is `None`, never 0.

**Interfaces.**

RE-1 (`LlmPort`, RE-01-contract.md:112) gains the fields that RE-6 and RE-8 need. The shapes below are a proposal; the schema itself belongs to RE-1:

```rust
pub struct LlmParams {
    pub purpose: Purpose,
    pub messages: Vec<LlmMessage>,      // role-tagged; Rendered keeps the flat text and stable hash for the goldens
    pub max_tokens: u32,                // CP-1 ceilings
    pub reasoning: Option<Reasoning>,
    pub json_mode: bool,
    pub cache: CacheIntent,
}
pub struct LlmMessage { pub role: Role, pub segments: Vec<Segment> }
pub struct Segment { pub text: String, pub cache_after: bool }
pub struct CacheIntent { pub reuse: Reuse, pub ttl_hint: Option<TtlHint>, pub affinity: Option<AffinityScope> }
pub enum Reuse { OneShot, Batch { expected_calls: u32 }, Session }
pub struct LlmResult { pub text: String, pub usage: Option<NormalizedUsage>, pub route: RouteInfo }
pub struct NormalizedUsage { pub input_total: u64, pub cache_read: Option<u64>, pub cache_write: Option<u64>,
                             pub cache_write_by_ttl: BTreeMap<String, u64>, pub output: u64, pub reasoning: Option<u64> }
pub struct RouteInfo { pub provider: String, pub platform: String, pub wire: String, pub model: String,
                       pub profile_id: String, pub tokenizer_family: String }
```

RE-6 (RE-06-jobs.md:99-107):
- `Layout { stable, volatile }` keeps `render() -> Rendered { text, breakpoints, stable_hash }` for the goldens and adds `to_messages() -> Vec<LlmMessage>`. Segments carry their role, so CP-3's system/user split survives.
- `params_for(purpose)` adds a reuse class:
  - `Batch` for loops that reuse a prefix within one run: skill-miner over one run's clusters, the REM and compaction loops, and the encoding backfill.
  - `OneShot` for once-a-day jobs.
  - `Session` for afterthought reflection.

RE-8 (the engine's RPC minor, `x-server: "engine"`, `x-stability: "experimental"`, closed params):

| Method | Params | Result |
|---|---|---|
| `engine.tokens.count` | `{ route: { provider, platform, wire, model } \| family, items: [{ id, text \| messages \| tools }], cumulative? }` | `{ family, method: "exact" \| "tokenizer-text" \| "calibrated" \| "heuristic", calibration: { version, observations }, items: [{ id, tokens, lower, upper }], cumulative? }` |
| `engine.tokens.observe` | `{ observations: [{ route, family, estimated: { tokens, method, version }, reported: NormalizedUsage }] }` | `{ accepted }` |
| `engine.tokens.families` | `{}` | each family's method, artifact state (present, missing, licence pending) and sha256 |

How the core calls `engine.tokens.count`:
- It calls from `composition/`, before the pure builder runs, so the builder stays free of I/O (ADR-010 L3, B9).
- It makes one batched call per turn, covering only the segments it has not yet memoised by (segment hash, family).
- Stable zones are counted once per zone hash. Conversation messages are counted once, when appended.
- Items end at message boundaries, where special tokens stop BPE merges. Running totals inside a message come from `cumulative`.

**Profile table.**

- **Files.** `packages/providers/schema/cache-profiles.json` with `cache-profiles.schema.json`. `packages/core/src/prompt/model-table.ts` becomes the table's loader.
- **Rust side.** The engine reads the table with `include_str!` and checks it against TypeScript-generated lookup vectors (`fixtures/cache-profile-vectors.json`). This is the same pattern as `packages/log-schema` ↔ `crates/plur1bus-log-schema`.
- **Row key.** Gateway (direct or OpenRouter), provider, platform (first-party, Bedrock, legacy Bedrock, Google managed, Vertex), wire and model family.
- **Row fields:**
  - `mechanism`
  - `minTokens`, plus what it counts (the cumulative prefix; visible input only for OpenAI 5.6+)
  - `belowMinimum`: silent, error or unverified
  - `maxBreakpoints` / `maxWrites`
  - `lookbackPositions`
  - TTLs with their write and read multipliers, and where the TTL field goes
  - the affinity key (field or header, length limit)
  - the usage-field map, with inclusive or exclusive arithmetic
  - the prompt-affecting parameters to hold constant within a cached conversation
  - how to suppress a write
  - the tokenizer family
  - `source`, `verified` date and `status` (verified, unverified, conflict)
- **Alias normaliser.** It sits beside the table and covers:
  - OpenRouter slugs (`anthropic/`, `openai/`, `google/`, `x-ai/`, `moonshotai/`, `deepseek/`, `qwen/`, `~anthropic/…`)
  - Bedrock ids (`anthropic.`, the `us.`/`global.` prefixes, `-v1:0`)
  - Google `@date` ids
  - served-model aliases: Gemini 3.5 and 3.7 Flash are routed to 3.6 and 3.8 Flash since 2026-10-08, and `gemini-3-pro-preview` points to 3.1 Pro.

**Phases.**

| Phase | Engine | Core |
|---|---|---|
| prerequisite (now, core only) | — | table as JSON; refreshed rows; markers, TTLs and affinity keys on every wire; `cache_write_tokens` and DeepSeek `prompt_cache_hit_tokens` parsed; Anthropic tool-loop breakpoint mapping and wire tool order fixed |
| 1 (RE-0…RE-9) | `src/tokens/` with parity vectors; `engine.tokens.*`; `LlmParams`/`LlmResult` as above; budgets and prompt text byte-identical | `host.llm.complete` runs through the shared emitter; `prompt.tokenCounting: "heuristic"` |
| 2 (RE-10) | `tokensEstimate` filled and labelled with its method (optional tokenizer family in `RecallOptions`); job prompts reordered per purpose where the class is `Batch` or `Session`; engine budgets may move to counts, each with a decision id and re-recorded goldens (RE-R1) | `prompt.tokenCounting: "engine"` after a B5 measurement; budget admission and compaction use `upper`; usage-anchored compaction (last reported prompt total plus the counted delta); `token_calibration` retired |
| 3 (RE-11) | the counter is the only implementation | chars/4 only when the engine is not up |

**Tasks.**

Prerequisites in the core. These are not engine work and do not wait for RE-1; one PR each:
- [ ] Write the failing test first: an Anthropic tool loop keeps its conversation breakpoints from round 2 on (`composition/http.ts` `anthropicBreakpoints` against an assistant tool-call message with null content). Then fix it.
- [ ] Move `CACHE_PROFILES` into the JSON table.
  - Add rows for Claude Haiku 5.5 (512), Opus 4.8 (1,024), Sonnet 5.5 (512) and Sonnet 4 (1,024), and put the GPT-6 family in the GPT-5.6+ class.
  - Add rows for xAI, Moonshot, DeepSeek, Alibaba, Z.ai, Mistral, OpenRouter and the local servers.
  - Add the alias normaliser; `CacheTtl` gains `12h`.
  - Add platform rows where floors differ: Opus 4.7 is 4,096 on Bedrock per AWS, and Vertex has 6,144 rows.
- [ ] Emitters:
  - OpenAI GPT-5.6+ breakpoints go on developer input messages (top-level `instructions` cannot hold one).
  - Kimi: the TTL tier.
  - OpenRouter: `cache_control` on text parts and tools, plus `session_id`.
  - xAI: `x-grok-conv-id`/`prompt_cache_key` per session.
  - Read `modelProfiles.*.cache` and call `chooseCacheTtl`.
  - Keep the wire tool block sorted and stable.
- [ ] Usage: parse `cache_write_tokens` (OpenAI 5.6+, OpenRouter, Kimi) and DeepSeek's `prompt_cache_hit_tokens`/`prompt_cache_miss_tokens`.

Engine work packages:
- [ ] **RE-1:** add `LlmParams`, `LlmResult`, `CacheIntent`, `NormalizedUsage` and `RouteInfo` to `engine-contract.schema.json`, with serde round-trip tests.
- [ ] **RE-3:** register tokenizer artifacts in `ArtifactCatalogue` (sha256 pin, licence ledger), fetched on first use (RE-D25).
- [ ] **RE-6:**
  - `Layout::to_messages`.
  - A reuse class per purpose, checked by a table test beside CP-1's `max_tokens` test.
  - The `LlmResultCache` key includes `RouteInfo.profile_id`. RE-06-jobs.md:150 drops endpoint and credential, but through OpenRouter one model id can resolve to different providers.
  - Phase 1 template text stays byte-identical.
- [ ] **RE-8:**
  - `host.llm.complete` runs through `composition/` with the shared emitter.
  - Serve `engine.tokens.*`.
  - For each provider class, a fixture wire (the `tests/system/fixtures/turn-core.mjs` pattern) receives the expected marker, TTL or affinity key.
  - A `OneShot` request to an OpenAI 5.6+ fixture carries `mode: "explicit"` with no breakpoint.
  - B9's assertion still sees 0 syscalls inside assembly.
- [ ] **RE-14** ([`RE-14-token-counter.md`](rust-engine/RE-14-token-counter.md)): `src/tokens/`, with families from the table, the four methods, a calibration store under the engine's state directory, and the `engine.tokens.*` handlers.
- [ ] **RE-9:**
  - Count goldens (fixture texts × family → count), recorded from the reference implementations.
  - Usage-normalisation fixtures per wire: inclusive versus exclusive totals, and absent fields.
- [ ] **RE-10:** the Phase 2 row of the table above.

**Acceptance (Phase 1).**
- The engine's goldens are unchanged with the counter linked.
- `engine.tokens.count` returns `exact`, and matches the recorded goldens, for every family whose artifact is present.
- Every count satisfies `lower ≤ tokens ≤ upper`.
- RE-8's fixture-wire tests pass for all five classes.
- `pnpm docs:gen` regenerates `docs/provider-matrix.md` §3 from the table, and `docs:check` fails when it drifts.

**Not in scope.**
- Money in budgets: budgets are token limits only since #601. The table's multipliers are used for TTL and write decisions, not for cost.
- Gemini explicit `cachedContents`.
- OpenRouter's response cache (`X-OpenRouter-Cache`). It is an exact-replay layer, not prompt caching.
- Choosing tokenizer crates: §2.5 (RE-D19).

## 3. Change packages from 7.18.21–7.18.31

Range `v7.18.20..v7.18.31` on the plugin line: 12 commits, +5,043/−202 lines in 91 files. Engine-relevant releases
become CP-1…CP-7; the rest is §3.9. The earlier plugin-line releases since the divergence (7.18.5–7.18.20) are already on
`main`: for each of those commits at least 90 % of its added engine lines exist at `98dfe2f` (measured 2026-10-23), so the
range starts at 7.18.21. The per-commit measurement also attributes two side changes of 7.18.25 to CP-3c (§3.3) and to
RE-5 (the chunk decider's key precedence and log hygiene), and puts the provider-ACL-before-rerank line and
`emptyResultIsValid` in 7.18.27 (`318197ce`) rather than 7.18.28.

| CP | Release(s) | Rule in one line | Owning WP | Pin |
|---|---|---|---|---|
| CP-1 | 7.18.23 `dd051ee1` | Haiku routes run without thinking; three tight output ceilings raised | RE-6 (prompts), host routing | table test on `LlmParams` per purpose |
| CP-2 | 7.18.24 `c3c1cb44` | a session reset never tears the runtime down; only the process lifetime does | RE-1, RE-8 | warm-embedder test over 1,000 `session-end` checkpoints |
| CP-3 | 7.18.25 `0ee6a59b`, 7.18.26 `e71dd9fe` | afterthought runs after conversation quiet, within bounds, once per quiet window; every job prompt has a cacheable stable prefix | RE-6 | quiet-window state machine; prefix-hash equality |
| CP-3c | 7.18.25 `0ee6a59b` | internal turns (heartbeat, cron, background, dreaming, promotion, subagent) are never feedback for persona evolution or the proactive governor; the chunk decider takes its key by name and never logs a transport error body | RE-6, RE-5, RE-1 | two outcome-filter tests; a log-hygiene test; a config-held key is rejected |
| CP-4a | 7.18.27 `318197ce` | decision-model prefilter removes only `irrelevant` ≥ 0.95, bounded, fail-soft; an empty reranker result can be valid | RE-4 | fixture-LLM filter test |
| CP-4b | 7.18.27 | model catalogue reconciles by provider and keeps referenced models | host (D112 discovery); RE-7 `models()` | `models()` lists exactly the engine's identities |
| CP-4c | 7.18.27 | recall comparison tooling | RE-9 reporter | n/a |
| CP-5 | 7.18.28 `8d2ca911` | reranker order survives namespace merge and tier budget; reranker input bounded; empty result valid only when declared; ACL before rerank; failed knowledge section not cached; graph-only hits excluded and traced | RE-4 | golden vectors G-RERANK-1…8 + order property |
| CP-6 | 7.18.30 `f1e57913` | (adapter) stale cron RPCs retried — engine lesson: `jobs.run` idempotent per window | RE-6 | concurrent `jobs.run` test |
| CP-7 | 7.18.31 `6419a60e` | skill-miner decision cache v2 (7 d TTL) never caches a retryable failure; stable cluster fingerprint; related-skills-only catalogue; prompt v3; supersede the base skill | RE-6 | cache, fingerprint and supersede tests |

### 3.1 CP-1 — LLM router: no thinking on Haiku routes, ceilings raised (7.18.23)

`lib/llm-router.js`: `NO_THINKING_BY_DEFAULT_MODEL = /^anthropic\/claude-haiku-/i`; `resolveHostReasoning(route,
callOptions)` returns `"off"` for a matching route unless the call asks for reasoning explicitly, otherwise `undefined`
(host default). The small-output ceilings rise from 300 to 450 and from 16 to 24 max tokens, the summary character
budget from `maxChars/3` to `maxChars/2`.

Rust engine: the engine does not route. It states **requirements** per call — `LlmParams { purpose, max_tokens,
reasoning: Option<Reasoning::Off>, cache_breakpoints, … }` — and the host routes on its `modelProfiles` (the F5 model
routing plan, `docs/decision-service.md`). The Haiku rule therefore belongs in the host's routing table, the ceilings in
the engine's prompt templates (RE-6). Acceptance: a table-driven test asserts `max_tokens` per purpose (450/24 where the
Node engine now has them) and that no engine purpose sets `reasoning` except where the Node engine does.

### 3.2 CP-2 — a session reset is not a runtime shutdown (7.18.24)

`lib/runtime-shutdown.js`: `isSessionScopedRuntimeCleanup(context)` is true for reason `reset`/`delete` or when a
`sessionKey` is present; such a cleanup must not stop the embedder, the neo worker or the job runner.

Rust engine: runtime lifetime is the engine process's lifetime (`open`/`close`); `checkpoint(agent, "session-end")` is
the only session-scoped call and touches state, never runtime. There is no API to tear a provider down per session.
Acceptance (RE-1/RE-8): after 1,000 `checkpoint(…, CheckpointReason::SessionEnd)` calls the embedder is still warm —
with the seam, the embed call count is unchanged; with the real model, the next embed stays under 50 ms.

### 3.3 CP-3 — afterthought after conversation quiet; stable prefix cached separately (7.18.25, 7.18.26)

`lib/afterthought-reflection.js` and `lib/afterthought-host.js`: `observeAfterthoughtActivity(agentId, at)` records the
last activity; `runConversationAfterthoughtJob` runs when the quiet time is ≥ `MIN_DELAY` (15 min) and ≤ `MAX_DELAY`
(120 min), once per quiet window, under a daily cap; request ≤ 60,000 chars, summary ≤ 12,000, recent window 16,000,
chunks of 32,000; state in `.afterthought-reflection.json`. 7.18.26 lays the prompt out as a stable prefix
(instructions, persona) followed by the volatile tail (the transcript window) so the provider's prompt cache hits.

Rust engine (RE-6): `jobs::afterthought::{QuietWindow, AfterthoughtState}` with the constants above as `const`s;
`prompt::Layout { stable: Vec<Segment>, volatile: Vec<Segment> }` is the shape of **every** job prompt (ADR-010 zones;
the harness builder already has breakpoints). Acceptance: boundary tests at 14:59 (no run), 15:00 (run), 120:01 (no
run), a second call in the same window (no run), the daily cap; `sha256(layout.stable)` is identical across two runs
with different transcripts; `LlmParams.cache_breakpoints` carries exactly one boundary.

**CP-3c (same commit, found by the 2026-10-23 audit).** `lib/persona-voice.js` gains `isInternalOutcome`: heartbeat, cron,
background, dreaming, promotion and subagent turns (session key, origin/trigger metadata, prompts starting `[cron:`,
`/plur1bus internal` or `__openclaw_memory_core_*`, the HEARTBEAT.md prompts) are excluded from persona-evolution evidence
and, through `lib/proactive-governor.js`, from the proactive governor's budget adjustments. `lib/jev-chunk-decider.js` gains
`resolveJevApiKey` (`captureChunkingJev.apiKey` before `apiKeyEnv`, default `TYPESAFE_API_KEY`) and stops logging the
transport error text of a failed request (it may echo the bearer key). Rust engine: the outcome filter keys on the
structured `TurnOrigin` and the job trigger, never on prompt text (RE-6 T4); the chunk decider's key comes from `SecretPort`
by name and a failure logs only `timeout`/`request failed` (RE-5 T2); a config-held key is rejected (RE-1 T3). The same
commit's `control-plane-projection.js` change (`jevKeySource`) is dashboard code.

### 3.4 CP-4a — decision-model recall prefilter seam (7.18.27)

`lib/jev-recall-filter.js`: `createJevRecallFilter({ apiKey, model, timeoutMs = 2500, maxStateChars = 60000 })` asks the
decision model (OpenClaw's "Jev"; in the harness the decision role) to classify candidates and removes **only** those
judged `irrelevant` with confidence ≥ 0.95; at most 100 candidates per call, query ≤ 10,000 chars; on timeout or error
the unfiltered list goes on. `createFilteredReranker(reranker, filter)` wraps a reranker and declares
`emptyResultIsValid: true`. The same commit adds the provider-ACL filter immediately before rerank
(`filterRecallCandidatesByAcl(…, "provider-acl")`) and honours `emptyResultIsValid` in the pipeline — the two rules CP-5
lists under 7.18.28 start here.

Rust engine (RE-4): `recall::filter::CandidateFilter` is a trait slot between budget allocation and rerank;
`DecisionRoleFilter` implements it through `HostServices::llm()` with purpose `recall-prefilter`; `Reranker::
empty_result_is_valid() -> bool`. Acceptance: with a fixture LLM, exactly the rows at ≥ 0.95 `irrelevant` disappear; a
timeout keeps all; with 150 candidates only the first 100 are judged and the other 50 pass; the filter is **off** unless
`recall.prefilter.enabled` is set (the Node seam ships disabled).

### 3.5 CP-4b/4c — model catalogue reconcile; recall comparison (7.18.27)

`lib/model-catalog-reconcile.js`: `reconcileModelCatalog(hostConfig, inventories, { referencedModels })` groups model
choices by provider, keeps a referenced model that an inventory no longer lists (flagged), stable order. In the harness
the catalogue is D112's (`packages/core/src/discovery/`); the engine only reports its own needs. Acceptance (RE-7):
`Engine::models()` lists exactly the configured embedding and reranker identities with licence id and artifact status.
The recall comparison script becomes a reporter mode of the parity runner (RE-9), not engine code. The same commit's
`groupModelChoices`/`describeModel` in `lib/featureModels.js` group the dashboard's model picker by provider — adapter UI, not
ported.

### 3.6 CP-5 — recall core: reranker order, bounded input, cache and graph hygiene (7.18.28)

`lib/recall-pipeline.js`, `lib/recall-budget.js`; eight rules, one golden vector each (`G-RERANK-n`, recorded from the
Node code path with a fixture reranker and the flat embedder):

1. `applyRecallBudget(…, { preserveOrder: true })`: the tier budget keeps the reranker's order; without the flag it sorts
   by score as before.
2. The namespace merge keeps the reranker's order: the global merge never re-sorts reranked rows by raw score.
3. Bounded reranker input: `rerankCap = normalizeRecallLimit(rerankCandidates, 0)`;
   `rerankInput = boosted.slice(0, max(topN, rerankCap))` — at least `topN`, at most the configured ceiling.
4. A reranker that returns the same index twice counts it once (`seenRerankIndices`).
5. An empty reranker result is a valid "nothing relevant" (`ordered = []`) only when `reranker.emptyResultIsValid ===
   true`; otherwise it falls back to the unreranked order.
6. The provider-ACL filter runs **before** rerank: no reranker call carries a row the caller may not see.
7. The knowledge-section cache is not written when a section failed, so a transient failure is retried next time rather
   than cached as empty.
8. Graph-only hits — rows reached through graph spread that fail hydration or eligibility — are excluded and the
   rejection is traced.

Property (RE-4): for every reranker permutation `p` of the input, the merged output restricted to reranked ids equals
`p`. Rule 6 is also review-focus item 3.

### 3.7 CP-6 — jobs are retry-safe (7.18.30, lesson only)

The release retries stale feature-cron RPCs across plugin reloads — adapter code. The engine property it relies on:
`jobs.run(name)` is idempotent per run window (`run-state.json` keyed by job and window); a second `run` while the first
is active answers `skipped: "already-running"` and never starts a second body. Acceptance (RE-6): two concurrent
`jobs.run("consolidate-daily")` produce one run record.

### 3.8 CP-7 — skill-miner: retryable decisions, catalogue selection, supersede (7.18.31)

`SKILL_DECISION_CACHE_VERSION = 2`, decision TTL 7 days; a decision that failed for a retryable reason (timeout,
provider error, rate limit) is **not** cached as negative; `clusterFingerprint(cluster)` is stable under reordering;
`selectSkillCatalogue`/`relevantSkillCatalogue`/`findRelatedSkill` give the prompt only the related skills;
`prepareSkillEvidenceGroups`; `SKILL_EXTRACTION_PROMPT_VERSION = "3"`; `supersedeBase`: a mined skill that extends an
existing one supersedes its base version instead of adding a sibling; workflow extensions are versioned.

Rust engine (RE-6, `jobs::skill_miner::{DecisionCache, cluster_fingerprint, catalogue, evidence, supersede}`).
Acceptance: a retryable failure leaves no cache row; a definitive decision is present for 7 days and gone after; a v1
row is ignored; `cluster_fingerprint` is permutation-invariant; a supersede chain A → A' → A'' leaves one active skill
with `supersededBy` links; the prompt template is versioned `"3"` and its hash is a golden value.

### 3.9 Releases without an engine counterpart

7.18.21 (`52385fd0`, review health check accepts `mode=apply`), 7.18.22 (`083d20fe`, readable policy refusal, review
cron reports errors), 7.18.29 (`8f623b71`, credential presence and source in the dashboard) and the adapter half of
7.18.25/7.18.30 are OpenClaw adapter or dashboard work. The harness has its own surfaces for them (`1staid check`, the
inbox, the web UI). Nothing to port.

### 3.10 Standing rule: one triage per plugin-line release

Every new `v7.18.x` tag gets a triage comment in the harness repository (issue label `engine-delta`) within a week,
using this template; the owner decides whether it becomes an engine `main` PR, a Rust acceptance criterion, or nothing.

```text
CP-<n> — <release(s)> <hash(es)>
Rule: <one sentence, testable>
Source: <file:line(s) on the plugin line>
Engine-relevant: yes | no (adapter/UI) — why
Destination: engine main (Node, now) | Rust engine WP RE-<k> | none
Pin: <golden vector | property | table test>
```

## 4. Work packages

Sizes are relative (S < M < L < XL); an XL is a multi-week package even with several agents in parallel. Every package
ends with the standard's PR checklist (coding-standard.md §11): `pnpm lint`, `cargo clippy --workspace --all-targets --
-D warnings`, `cargo fmt --all -- --check`, the package's tests, `pnpm docs:gen` where a schema or clap tree changed.

**Hand-off briefs.** Each package has a self-contained brief for an implementer who has not read this plan, under
[`rust-engine/`](rust-engine/README.md): files, interfaces consumed and produced, tasks (one pull request each) with
their failing tests first, acceptance, out of scope. The README there lists the working assumptions (the recommended
answer to every RE-D decision below) and the status table the controller keeps. [`rust-engine/MODULE-MAP.md`](rust-engine/MODULE-MAP.md)
is the completeness check: every file of the engine closure with its owner brief and disposition; a brief is finished when each
of its rows has a Rust module, a fold target or a recorded drop. The summaries below stay the overview; the briefs are the work.

### RE-0 — Decisions, crate skeleton, dependency gate (S)

**Files:** create `crates/plur1bus-engine/Cargo.toml`, `src/lib.rs`, `src/main.rs`; modify `Cargo.toml` (workspace
member), `deny.toml` / `docs/dependency-exceptions.json` (only with an owner-approved exception), `.github/workflows/ci.yml`
(`changes` plan path `crates/plur1bus-engine/**`), `docs/ci.md`.

- [ ] Record the owner's answers to RE-D1–RE-D10 (§6) at the top of this plan.
- [ ] Add the crate with `lancedb = "=0.26.2"` (verify the exact version the engine's committed lockfile resolves for
- [ ] Add the crate with `lancedb = "=0.26.2"`, the version the engine's committed lockfile resolves for
      `@lancedb/lancedb` (the Rust crate and the Node package of the same version embed the same `lance`), plus
      `rusqlite` with `bundled`, `jsonschema`, `ureq` and `serde` from the workspace. Done in #759; the MSVC `protoc`
      link fix is #769. `ort` and `tokenizers` are not RE-0 dependencies: they arrive with RE-03 T0 (RE-D3b, RE-D19).
      `@lancedb/lancedb`; the Rust crate and the Node package of the same version embed the same `lance`), `rusqlite`
      with `bundled`, `ort = "=2.0.0-rc.15"` with the feature decision from RE-3, `tokenizers`, `ureq` and `serde` from
      the workspace.
- [ ] Run `cargo deny check` and `node scripts/audit-deps.mjs` on the new closure. Lance brings DataFusion and Arrow;
      expect licences outside today's `deny.toml` list (`Zlib`, `BSL-1.0`, `Unicode-DFS-2016`, `MPL-2.0` are likely).
      Every addition to the allow-list or `dependency-exceptions.json` is an owner decision recorded in the PR; no
      silent widening.
- [ ] Measure the cold and warm build time of the workspace with the crate (`unit (ubuntu-24.04)` budget in
      `docs/ci.md`); record the numbers; decide `[profile.dev.package.*]` opt-levels for `lance*`, `datafusion*`, `ort`
      the way `sha2` is handled in the root `Cargo.toml`.
- [ ] Add `[workspace.lints]` per coding-standard.md §10 (CS-1) so the new crate starts clean.
- [ ] `plur1bus-engine --version` prints the workspace version; `cargo test -p plur1bus-engine` runs one test.

### RE-1 — Contract schema and Rust types (M)

**Files:** create `crates/plur1bus-engine/schema/engine-contract.schema.json`, `src/contract/{mod,engine,host,jobs,
memory_ops,admin_ops,errors}.rs`, `src/config/{mod,validate,tier}.rs`; modify `scripts/gen-docs.mjs` (a new generated
doc `docs/engine-contract.md`), `packages/core/src/engine-shim.d.ts` (deleted in RE-11, narrowed here).

**Interfaces (produced):**

```rust
pub trait Engine: Send + Sync {
    fn contract(&self) -> ContractVersion;                       // "1.17.0"
    fn capabilities(&self) -> &Capabilities;
    fn open(&self) -> Result<(), EngineError>;
    fn close(&self) -> Result<(), EngineError>;
    fn status(&self) -> EngineStatus;
    fn system_supplement(&self, agent: &AgentContext) -> Result<Option<String>, EngineError>;
    fn recall(&self, query: RecallQuery, options: RecallOptions, cancel: &Cancel) -> Result<RecallResult, EngineError>;
    fn capture(&self, turn: TurnRecord, options: CaptureOptions) -> Result<CaptureHandle, EngineError>;
    fn checkpoint(&self, agent: &AgentId, reason: CheckpointReason) -> Result<CheckpointResult, EngineError>;
    fn jobs(&self) -> &dyn JobRegistry;          // list(), run(name, trigger, cancel), history(filter)
    fn embedding(&self) -> &dyn EmbeddingService; // embed, rerank, probe, identities, serve, local
    fn models(&self) -> Vec<ModelInfo>;
    fn memory(&self) -> &dyn MemoryOps;           // list show forget correct share state propose proposals import rebind unbind unimport link + curation
    fn admin(&self) -> &dyn AdminOps;             // share forget reembedding workspace_policy obsidian migrate
    fn stores(&self) -> &dyn StoreOps;            // adopt
    fn events(&self) -> EventReceiver;
}

pub trait HostServices: Send + Sync {
    fn state_dir(&self) -> &Path;
    fn config(&self) -> EngineConfig;
    fn workspace_dir(&self, agent: &AgentId) -> Result<Option<PathBuf>, HostError>;
    fn llm(&self) -> Option<&dyn LlmPort>;        // complete(LlmParams) -> Result<LlmResult, HostError>
    fn secrets(&self) -> Option<&dyn SecretPort>;
    fn egress(&self) -> &dyn EgressGate;          // decide(&Target { scheme, host, port }) -> Decision; Allow carries the address rules the transport checks after resolving
    fn emit(&self, event: &str, payload: serde_json::Value);
    fn now_ms(&self) -> i64;
    fn platform(&self) -> &PlatformCapabilities;
    fn journal_backlog(&self) -> Option<JournalBacklog>;
}
```

`Cancel` replaces `AbortSignal` (a deadline plus a cancellation flag, checked at every stage boundary — defect f.1
fixed by construction). `Degraded`, `Deferral`, `ContextBlock`, `RecallTiming`, `CaptureResult`, `JobTrigger`,
`CheckpointReason`, `VectorSpaceIdentity` and the `PerCallDiagnostic` union are closed `enum`s/structs with
`#[serde(rename_all = "camelCase", deny_unknown_fields)]`; `DecisionTrace` keeps its open map but caps text fields
(review-focus 5).

- [ ] Write `engine-contract.schema.json` from `types/engine.d.ts` (1,289 lines at the pin `9f34008c`): every interface,
      every union, every doc comment. `x-since` follows the engine changelog: up to `"1.16.0"` for today's members,
      `"1.17.0"` for `AdminOps.reembedding.validate`, and, for the A1 and memory-tree members, the version the engine
      assigns them on merge.
- [ ] Generate the Rust types with `typify` the way `crates/plur1bus-rpc` generates from `rpc.schema.json`; generate a
      TypeScript `engine-contract.d.ts` for the core and diff it against the engine's `types/engine.d.ts` — the diff is
      the list of deliberate drops (§2.4) and nothing else.
- [ ] Port `engine-config.schema.json` validation (57 keys) to `config::validate`; parity vectors: 30 valid and 30
      invalid configurations recorded from the Node validator produce the same accept/reject decision.
- [ ] Tests: round-trip every contract type through serde with the Node engine's own example payloads (recorded in
      RE-9's scenario format); the 1,000-checkpoint warm test of CP-2 against a `FakeHost`.
- [ ] `pnpm docs:gen` writes `docs/engine-contract.md`; `pnpm docs:check` passes.

### RE-2 — Store layer, byte-compatible (L)

**Files:** create `src/store/{mod,lance,sqlite,neo_files,ledger,lock,schema_version}.rs`,
`tests/fixtures/store-v1/` (a 12-row store the Node engine wrote with the flat embedder, dim 384, < 1 MB),
`tests/fixtures/sqlite/{embeddings,llm_results,speaker_mappings}.sqlite`, `tests/store_roundtrip.rs`.

**Interfaces (produced):** `Store::open(path: &Path, mode: OpenMode) -> Result<Store, StoreError>`;
`Store::identity() -> Option<VectorSpaceIdentity>`; `Store::schema_version() -> SchemaVersion`;
`MemoryRow` (69 fields, `#[serde(rename_all = "camelCase")]`); `Store::search(vector: &[f32], limit: usize, filter:
&RowFilter) -> Result<Vec<Scored<MemoryRow>>, StoreError>`; `Store::upsert(rows: &[MemoryRow])`;
`EmbeddingCache`, `LlmResultCache`, `SpeakerMappings`; `NeoFiles::{read_generation, append_turn, vectors}`;
`JsonlLedger<T>::append`, `StateFile<T>::{load, store}`; `JobLock::acquire(name, ttl) -> Result<Guard, Busy>`.

- [ ] Open `fixtures/store-v1` with `lancedb` 0.26.2 and print the Arrow schema; commit it as
      `tests/fixtures/store-v1/schema.txt`; the `MemoryRow` ↔ Arrow mapping is generated from it, never typed by hand.
- [ ] Round-trip test: Rust appends 5 rows → the parity runner (RE-9) opens the store with the Node engine and lists 17
      rows; Node appends 5 → Rust lists 22. Both directions on Linux, macOS and Windows runners.
- [ ] `_embedding_identity` mismatch → `OpenMode::ReadWrite` fails with `StoreError::IdentityMismatch`; `ReadOnly` opens
      (review-focus 2).
- [ ] SQLite: `PRAGMA table_info` and `PRAGMA index_list` of a database the Rust code creates equal the committed Node
      fixtures, column for column (`key_hash … expires_at`; `speaker_mappings` keeps its legacy camelCase columns).
- [ ] neo files: read `vectors.<gen>.f32` + `vector-index.json` from the fixture and compare each vector to the JSON
      sidecar; write one generation and read it back with the Node code path in the parity runner.
- [ ] Locks: `JobLock` uses the supervisor's pid-plus-start-time identity rule (ADR-012 §10.2) and a heartbeat, never
      mtime alone and never `kill(pid, 0)` with `EPERM` as "alive" (f.4, f.5); Windows paths refuse junctions as well as
      symlinks (f.15) and set the `run/`-style ACL (f.9) through `crates/plur1bus-rpc/src/acl.rs`.
- [ ] Record the Lance upgrade rule in `docs/engine-stores.md` (new): any bump of the `lancedb` crate repeats the
      round-trip test against the Node package still in use; a failure means a store migration and a
      `STORE_SCHEMA_VERSION` bump, never a silent upgrade.

### RE-3 — Embeddings and rerankers (L)

**Files:** create `src/embedding/{mod,identity,artifacts,local_ort,remote,cache,batch}.rs`,
`src/embedding/rerank/{mod,local,cohere,remote,chained,signal}.rs`, `tests/embedding_parity.rs`,
`tests/fixtures/vectors/{sentences.json,e5-small.json,embeddinggemma-2.json,bge-reranker.json,token-ids.json}` (50 sentences, vectors, scores and exact token ids recorded
from the Node engine with the real models).

**Interfaces (produced):** `EmbeddingProvider::{embed_query, embed_passage, embed_batch} -> Result<Vec<Vec<f32>>,
EmbedError>`; `Reranker::{rerank(query, docs, cancel) -> Result<Vec<Ranked>, RerankError>, empty_result_is_valid()}`;
`identity_id(&VectorSpaceIdentity) -> String` (byte-identical to the Node `identityId()`; test vector from the fixture
store); `ArtifactCatalogue::{resolve(model) -> Artifact { files: Vec<(path, sha256)>, licence: LicenceId }}` including
the `CC-BY-NC-4.0` entries the harness NC gate (`packages/core/src/licences`) must see.

- [ ] `identity_id` reproduces the fixture store's `_embedding_identity.identityId` — the first test of the package;
      everything else depends on identical identities (a different id would force `admin.reembed` on every store).
- [ ] Local provider: an `ort` session over the **same** ONNX files (same sha256) that the Node engine downloads.
      - Tokenizer: each pinned artifact's `tokenizer.json`, loaded through `tokenizers =0.23.2` (RE-D19).
      - Truncation: encode with special tokens and no truncation, then cut ids and mask to a per-profile
        `truncation_len`, as transformers.js does (§2.5). For e5 that length is the tokenizer's `model_max_length`
        512, not the identity's `tokenCap`.
      - e5: prefixes `query: `/`passage: `, mean pooling and L2 normalisation.
      - EmbeddingGemma 2 (the wizard default since #771): its own prompts and pooling.
      - jina v3/v5-nano and the jina reranker follow in RE-03 T3c/T4, with goldens in RE-09 T3's real-model leg
        (CC-BY-NC; files fetched with consent).
      - Parity: exact token ids for every pinned tokenizer file, including an over-cap passage; cosine ≥ 0.9999 and
        max |Δ| ≤ 1e-4 per dimension against the recorded vectors; the reranker's score order equals the recorded
        order on all 50 pairs.
      `tokenizers` with the same `tokenizer.json`; e5 prefixes `query: `/`passage: `, mean pooling, L2 normalisation.
      Parity: cosine ≥ 0.9999 and max |Δ| ≤ 1e-4 per dimension against the recorded vectors; the reranker's score order
      equals the recorded order on all 50 pairs.
- [ ] Decide and implement the `ort` binary strategy (RE-D3b): `load-dynamic` with a `libonnxruntime` shipped in the
      payload per target, or `download-binaries` vendored for offline CI. Document in `docs/engine-stores.md`.
- [ ] Remote providers through `ureq` behind one guarded transport (`transport::guarded`, the §2.1 rules):
      `EgressGate::decide(&Target)` per hop, redirects included, then resolve-and-pin with the address rules the
      decision carries; one deadline per call (f.6: no second timer). Tests with a resolver seam: a name that answers a
      public address on the first lookup and `127.0.0.1` on the second (rebinding) is refused; a redirect to the same
      host on a port the policy does not list is refused although the host was allowed a moment before; a cached
      decision is dropped on `egress.changed`. `rerank-signal`, `chained` and `remote` keep their Node contracts
      (recorded request and response fixtures, no network in tests).
- [ ] `EmbeddingService::serve` replaces the bespoke IPC: `engine.embedding.embed` over RPC with the envelope fields
      `{ dimensions, fingerprintId, model }` preserved in the result so `plur1bus admin embedding serve` keeps its
      `--json` shape (host-contract (d.2)).
- [ ] Multi-identity from the start: every call carries its `VectorSpaceIdentity`; no single-dimension assumption
      (host-contract (d.3)).

### RE-4 — Recall pipeline (XL)

**Files:** create `src/recall/{mod,pipeline,namespaces,budget,filter,rerank,knowledge,graph,temporal,acl,dedupe,
render,trace,boosts}.rs`, `tests/recall_golden.rs`, `tests/fixtures/recall/G-*.json`.

**Interfaces (produced):** `recall::run(store, providers, host, query: RecallQuery, options, cancel) ->
Result<RecallResult, EngineError>`; stage trait `Stage::apply(&mut Candidates, &mut Trace, &Cancel) -> StageOutcome`;
`CandidateFilter` (CP-4a); `Budget::allocate(candidates, tiers, preserve_order: bool)` (CP-5.1);
`render::blocks(selected, cap_chars) -> (Vec<ContextBlock>, Vec<Deferral>)` for the six blocks
`neo | start | memories | time | temporal | reminder`.

- [ ] T0 first: the JS text layer `src/text/{js,json,legacy}.rs`, with vectors recorded on Node 24.21. It provides:
      JS `\s`; ASCII `\b`/`\w`/`\d`; UTF-16 length and slice; `JsString`, which serialises a cut surrogate as
      Node does per target; a tolerant reader for Node-written JSON; lookarounds through `fancy-regex`; pinned
      NFKD/NFC; and `localeCompare` through `icu_collator`. Every lexical helper of RE-03…RE-06 is ported on it
      byte-identically, German defects included (§1.6, last paragraph; §2.5; RE-D17).
- [ ] The twelve stages of `docs/recall-architecture.md` in the engine repository, with one deliberate change of
      order: the ACL filter runs **before** every provider-backed stage. Order: embedding → vector search → refinement
      seam (off) → temporal filter → canonical KNOWLEDGE.md search → score and status → graph spread and hydration →
      ACL filtering (agent, workspace, user-owner and scope; a row the caller may not see leaves the pipeline here) →
      budget allocation → prefilter (CP-4a) → optional rerank → deduplication → finalisation, which re-asserts the ACL
      on the final set (a check that costs nothing and turns a regression into a refusal); then the namespace fan-out
      and the global merge (one pipeline per table, settle all, one merge, one ledger entry). The architecture
      document's ACL position after rerank is the pre-7.18.28 order; CP-5.6 moved the provider-side check ahead of
      rerank, and the Rust engine has no stage after which an unauthorised row could still reach a reranker or a
      decision model.
- [ ] Budget: `RecallBudget { soft_ms, hard_ms, cap_chars }` from the query, the harness's `core.recall.*` keys mapped
      as `engine-config.ts` maps them today; overrun → `Degraded { reason: "timeout" }` with the blocks on hand; a caller
      cancel → `"aborted"`; `timing.phases` per stage, `namespacePhases` per table (review-focus 1).
- [ ] CP-5: golden vectors G-RERANK-1…8 and the permutation property; CP-4a: the fixture-LLM filter tests; ACL before
      rerank (review-focus 3) as an explicit test with a reranker that records what it saw.
- [ ] ACL denials are logged by default (f.11) as a catalogue event with ids only.
- [ ] Golden parity: the RE-9 recall scenarios (flat embedder, fixture reranker) produce identical ordered ids and
      block texts to the Node engine; timing and trace compared structurally.
- [ ] Reference hardware: `tests/system/two-session-recall.test.ts` with `PLUR1BUS_ENGINE_IMPL=rust` meets 400 ms
      `timing.totalMs` and 600 ms CLI wall (host-contract (b)); numbers recorded in the PR.

### RE-5 — Capture, neo, journal, checkpoint (XL)

**Files:** create `src/capture/{mod,pipeline,chunking,dedupe,classify,reconsolidate,dynamics,speaker,epistemic,
valid_time,journal,checkpoint}.rs`, `src/neo/{mod,working_memory,episodes,files}.rs`, `tests/capture_golden.rs`.

**Interfaces (produced):** `capture::accept(turn: TurnRecord, options) -> CaptureHandle { id, accepted_at, done:
Receiver<CaptureResult>, abort }`; `chunking::split(messages, mode, max_chars) -> Vec<Chunk>`; `dedupe::is_duplicate(
candidate, neighbours, threshold) -> bool` (cosine ≥ `duplicateThreshold`); `reconsolidate::apply(existing, update) ->
Versioned` (`versionNumber`, `previousVersion`, `supersededBy`, conflict log); `checkpoint::write(agent, reason) ->
CheckpointResult { digest, written }`.

- [ ] Capture pipeline at parity: chunking modes (`captureChunking*`, `captureMaxChars`), duplicate check, importance
      and emotion classification through `LlmPort` with `defer_post_turn_llm` → diagnostic
      `post-turn-refine-unscheduled`, speaker mapping, epistemic status (`""` = legacy, never trusted), bi-temporal
      `validFrom`/`validUntil` (`0` = no bound), memory dynamics (strength, half-life), tombstones.
- [ ] Neo working-memory layer (`lib/neo-arch.js`, about 3,000 lines): generations, the `turn-journal.jsonl`, the
      `neo` block; byte-compatible with RE-2's reader.
- [ ] Crash consistency: a row is visible only after the Lance commit; the journal replays an accepted-but-uncommitted
      capture on the next start; `kill-soak` passes (review-focus 4).
- [ ] Golden parity: the RE-9 capture scenarios (fixture LLM answers) produce identical rows minus timestamps.

### RE-6 — Jobs, dreaming, afterthought, skill-miner (XL; go/no-go after RE-9's first results, RE-D5)

**Files:** create `src/jobs/{mod,registry,run_state,lock,history}.rs`, one module per job (19), `src/jobs/afterthought/`,
`src/jobs/skill_miner/{mod,decision_cache,fingerprint,catalogue,evidence,supersede}.rs`, `src/jobs/dreams/{rem,light}.rs`,
`src/prompt/{layout,templates}.rs`, `tests/jobs_*.rs`.

**Interfaces (produced):** `JobRegistry::{list() -> Vec<JobSpec>, run(name, trigger, cancel) -> RunOutcome,
history(filter) -> Vec<RunRecord>}`; `prompt::Layout` (CP-3); `LlmParams` with the CP-1 ceilings;
`DecisionCache::{get, put_definitive, skip_retryable}` (CP-7).

- [ ] Registry, `run-state.json`, locks and history first; `run` idempotent per window (CP-6 test).
- [ ] Jobs in three groups, each its own PR: maintenance (`consolidate-daily auto-accept-stale embedding-drain gc-run
      episodes-rebuild classify-recent discover-semantic-links skill-benefit-backfill`), reflection (`afterthought
      meta-reflect persona-evolve emotion-refine post-turn-refine feedback-report proactive-check reminder-dispatch`),
      dreams (`rem-dream light-dream`; the harness scheduler of ADR-009 triggers them, "never a host cron") and
      `skill-miner`.
- [ ] Every prompt is a versioned template file with a golden hash; every job prompt has a `Layout` with one cache
      breakpoint (CP-3); `LlmResultCache` keys = hash(purpose, model, template version, normalised input).
- [ ] CP-1, CP-3, CP-7 acceptance tests as written in §3; a job that is not ported yet is reported by `jobs.list` as
      `available: false, reason: "not-implemented"` and refused by `run` with `E_NOT_AVAILABLE` — never silently skipped.
- [ ] Parity: job scenarios with recorded LLM fixtures produce the same store deltas and ledger lines.

### RE-7 — Memory and admin operations (L)

**Files:** create `src/ops/{mod,memory,curation,admin,stores,snapshot,tombstones,models,reembedding}.rs`,
`tests/ops_*.rs`.

**Interfaces (produced):** `MemoryOps` (13 methods + `curation_{list,keep,drop}`), `AdminOps`, `StoreOps::adopt(path,
expected_schema) -> AdoptReport`, `snapshot::{create, verify}` (today `lib/snapshot/store-snapshot.js`, used by
`packages/core/src/backup-ops.ts`), `tombstones::reapply` (today `lib/tombstone-reapply.js`), `reembedding::{plan, apply,
resume, validate, status, rollback, switch}` (the engine's `AdminOps.reembedding` at 1.17.0; the core's `admin.reembed.{plan,run,status,abort}` stays the front door) with `fingerprint_id(normalized) -> String` and `normalize_embedding_config(raw) -> Normalized` (the
private imports of §1.3 become `engine.embedding.fingerprint` and `engine.config.normalizeEmbedding`).

- [ ] Every `memory.*` CLI test in `crates/plur1bus/tests` and `tests/system/memory-ops.test.ts` passes against the
      Rust engine; `--json` shapes unchanged (ruling R13 — the raw RPC value is printed).
- [ ] `admin.backup.snapshot`, `backup verify|restore` and `restore-reapply` work against the engine's snapshot and
      tombstone methods; `tests/system/backup.test.ts` and `portable-backup.test.ts` pass.
- [ ] `tests/system/reembed.test.ts` passes; the fingerprint id of every configuration in `docs/embedding-migration.md`'s
      examples equals the Node value (vectors recorded).
- [ ] A1 curated memory: `memory.curation.*`, recall stats, promotion and the `knowledge-update` job, served behind the capability flags `recallStats`, `knowledgePromotion` and `memoryCuration`. The pin's 1.17.0 has none of them. The harness tests that feature-test A1 (#604–#607, #609) run green against the Rust engine.

### RE-8 — Process, RPC, supervisor slot, EngineClient (L)

**Files:** create `src/rpc/{server,host_client,seams}.rs`, `src/main.rs`; `packages/core/src/engine/{client,spawn,
select}.ts`; modify `packages/rpc-schema/schema/rpc.schema.json` (the next RPC minor after `x-rpc-version` 1.6.0. Six methods and one notification, plus two shared `$defs` types, already carry `x-since: "1.7.0"` while the header still says 1.6.0, so the number is agreed with whichever PR bumps the header first. Contents: `x-server: "engine"`, methods
`engine.*`, reverse methods `host.*` on the core, notifications `engine.event`, `engine.capture.done`),
`packages/module-api/src/capabilities.ts` and `crates/plur1bus-rpc/src/capabilities.rs` (filter the fourth server),
`crates/plur1bus/src/supervisor/{state,child,mod}.rs` (`RoleKind::Engine`, `engine_spec`, start order engine → core),
`crates/plur1bus/src/commands/core.rs` (no-supervisor spawn), `packages/config-schema/schema/config.schema.json`
(`engine.implementation`), `docs/rpc.md`, `docs/cli.md`, `docs/config.md` via `pnpm docs:gen`.

**Interfaces (produced):** `engine.auth` handshake like `module.auth`; `engine.capture` returns `{ id, acceptedAt }`
at once and `engine.capture.done` notifies, `engine.capture.wait { id }` long-polls; `host.llm.complete`,
`host.egress.decide`, `host.secret.get`, `host.workspaceDir`, `host.event`, `host.journalBacklog` callable only with
the engine credential; `EngineClient implements Engine` in `packages/core/src/engine/client.ts`.

- [ ] Schema first, `pnpm gen`, then both servers; `engine.auth` lists only `engine.*`; `core.auth` omits `host.*` for
      every caller but the engine (a listing check, not the guard).
- [ ] Dispatch guard: the shared RPC server (`packages/module-api`'s server core) learns a connection principal kind;
      `host.*` handlers are registered as `requires: "engine"` and the dispatcher answers every other connection with
      `E_DENIED` before the handler runs, whatever `x-server` says and whatever the capability list advertised. Tests:
      an ordinary authenticated client calls `host.secret.get` and `host.llm.complete` by name → `E_DENIED`, and the spy
      secret store and LLM port record no call; the engine connection succeeds; the listing test stays beside them.
- [ ] Supervisor: health poll `engine.status`, the core's restart policy, adoption of a running engine by peer
      credentials (`adopt.rs`); `daemon status` shows the slot; `1staid check` gains `engine.process` and `engine.store`
      checks (`1staid.check/1` ids are append-only, ADR-016).
- [ ] Windows: named pipe with the DACL of `crates/plur1bus-rpc/src/win.rs`; the pid identity rule applies to the
      engine child too (ADR-012 §10.7).
- [ ] Seams: `PLUR1BUS_TEST_INTERNALS` honoured in `rpc::seams` only with `PLUR1BUS_ALLOW_TEST_INTERNALS=1`; the core
      forwards its `--test-internals` variant to the child it spawns.
- [ ] `engine.implementation: "node" | "rust"` (`x-restart: "core"`, `x-tier: "advanced"`, default `"node"`);
      `select.ts` picks `createEngine()` or `EngineClient`.
- [ ] Budget measurement: 10,000 `engine.status` round trips and 1,000 `engine.recall` calls with the flat embedder on
      Linux, macOS and Windows runners; p99 hop overhead recorded in `docs/engine-stores.md`. Over 5 ms p99 on any
      platform re-opens RE-D1 (N-API fallback, §2.2).

### RE-9 — Parity harness and golden tests (M, continuous)

**Files:** create `tests/engine-parity/{README.md,run.ts,scenarios/*.json,golden/*.json}`; modify
`.github/workflows/ci.yml` (job `engine-parity`, selected by the `changes` plan for `crates/plur1bus-engine/**`,
`packages/core/src/engine/**`, `tests/engine-parity/**`; advisory first, then a dependency of `ci-gate` — `docs/ci.md`
documents the promotion), `tests/system/helpers.ts` (`PLUR1BUS_ENGINE_IMPL`).

**Scenario format:** `{ store: <fixture>, config: <engine config>, seams: { embedder: "flat", llm: <recorded answers> },
steps: [ { op: "capture" | "recall" | "jobs.run" | "memory.*" | "checkpoint", args, expect: "golden" | <inline> } ] }`.
The runner drives the Node engine in-process and the Rust engine over RPC, records both, and compares with a tolerance
policy: ordered ids exact, block texts exact, timestamps and timing ignored, traces compared by key set and by the
numeric fields the scenario names.

- [ ] Scenario set per subsystem, with the count of Node test files it stands in for (recall, capture, ops, jobs);
      recorded goldens committed; a golden changes only with a CP or a documented decision in the PR.
- [ ] Every `tests/system` suite runs twice in CI, `PLUR1BUS_ENGINE_IMPL=node` and `rust`, once RE-8 lands.
- [ ] The CP-4c comparison report: `run.ts --compare <scenario>` prints both engines' recall side by side.
- [ ] Phase 1 exit report: a table scenario × engine × outcome, attached to the RE-11 PR.

### RE-10 — Phase 2: memory-facing core paths move into the engine (L)

**Files:** modify/remove in `packages/core/src`: `replay.ts` (journal replay), `restore-reapply.ts`, `backup-ops.ts`
(snapshot), `embedding-migrate/*` (driver, state checkpoint, switch), `media-search/` index hook, `dreams/{scheduler,
store}.ts` (the ledger `dream_run`/`dream_schedule`/`dream_candidate` → `rusqlite` in `src/jobs/dreams/ledger.rs`),
the `memory.curation.*` handlers; create the engine counterparts under `src/ops/` and `src/jobs/dreams/`.

- [ ] One PR per moved path, each with the existing tests re-pointed at the engine and the core's store file removed
      in the same PR (`docs/dreams.md`, `docs/embedding-migration.md` updated).
- [ ] The core stays the front door: `memory.*`/`dreams.*`/`admin.reembed.*` keep their `x-server: "core"` entries,
      run the RBAC guard, and forward; no CLI or API client ever connects to the engine endpoint directly.
- [ ] ADR-009's rule holds: the engine's dream ledger is driven by the harness scheduler's triggers, never a host cron.
- [ ] T7–T9, each only after its decision in §6 is recorded: the three behaviour changes of §1.6 — cosine score and
      calibrated thresholds (RE-D11), hybrid retrieval with rank fusion (RE-D12), the agent partition reading its own
      scoped rows (RE-D13). One PR each; the goldens the change touches are re-recorded in that PR with the decision id
      in the commit body (RE-R1); RE-D11's PR carries its A/B on a frozen corpus. None needs a re-embedding.
- [ ] T8 also carries the lexical analyzer of §2.5 (RE-D15): its terms go to the derived table `_lexical`, which
      is repaired at open by a content-hash diff. Lance gets a pass-through BM25 index. T8 runs the bake-off on
      `tests/engine-parity/corpus/lexical-ab/` against the exit criteria of §2.5, and ships the fallback profile
      only if the analyzer misses them.
- [ ] T10 (RE-D16, after T8): the legacy lexical helpers move onto the analyzer, one consumer group per PR,
      memory-graph last with a graph rebuild.
- [ ] T11 (RE-D18): the German decompounding lexicon, only if T8's compound-gap gate triggers it.

### RE-11 — Phase 3: retire the Node engine (M)

**Files:** modify `packages/core/package.json` (remove the pin), delete `packages/core/src/engine-shim.d.ts`, move the
`engine-config.ts` translation into `src/config/`, re-point `scripts/gen-engine-keys.mjs` at
`crates/plur1bus-engine/schema/engine-config.schema.json`, remove `GH_ENGINE_READ_TOKEN` from every workflow,
`docs/engine-extraction.md` (status note), create `docs/adr/ADR-018-rust-engine.md`, flip the default of
`engine.implementation`, update `docs/architecture.md`, `docs/milestones.md` (Track RE), `AGENTS.md` ("Where things
live" row for the crate).

- [ ] One release ships both implementations with `"rust"` as default; the next removes `"node"` and the pin.
- [ ] `pnpm test:prep` no longer needs a private package; `docs/ci.md` and AGENTS.md "Tests lokal" updated.
- [ ] Before the pin goes, make `@huggingface/transformers =4.3.1` a direct optional dependency of `packages/core`.
      The Florence-2 caption loader imports it (`packages/core/src/media-search/caption/local.ts:51-70`), and today
      it reaches the core only through the engine's optional dependency. Add a test that the import resolves from
      `packages/core` (§2.5).
- [ ] The engine repository's `main` is archived or kept for the OpenClaw plugin line only (RE-D7).

### RE-12 — Forward-port CP-5 and CP-7 to the Node engine now (S, independent)

**Files:** in `Cyb3rb1ade/openclaw-plur1bus-memory` on `main`: `lib/recall-pipeline.js`, `lib/recall-budget.js`,
`lib/jobs/skill-miner*.js` and their tests; in the harness: `packages/core/package.json` (new exact commit),
`pnpm docs:gen` (`docs/config-engine-keys.md`).

- [ ] Cherry-pick 8d2ca911 (CP-5) and 6419a60e (CP-7) onto `main` after engine PR #275 (`9f34008c`) has merged there, or onto `9f34008c` itself, so the new pin keeps `AdminOps.reembedding.validate` (`packages/core/test/engine-contract.test.ts` checks it); resolve against the host-neutral tree, run the
      engine's test suite; one PR each.
- [ ] Bump the harness pin; `tests/system/two-session-recall.test.ts` and `memory-ops.test.ts` green; record the
      goldens G-RERANK-1…8 from this pin for RE-4.

### RE-13 — Harness surfaces for three dropped adapter functions (M, Phase 2)

**Files:** create `crates/plur1bus-engine/src/ops/{critical,skill_proposals}.rs`, `src/jobs/bodies/daily_review.rs`,
`src/jobs/review/{lead,workspace_status,render}.rs`; the core's forwarders and inbox producers under
`packages/core/src/engine/`; CLI `crates/plur1bus/src/commands/{memory_critical,skill_proposals,review}.rs`; the schema
methods and the inbox kinds `memory-critical`, `skill-proposal`, `review`. Brief: [RE-13](rust-engine/RE-13-harness-surfaces.md).

- [ ] T1 critical-memory confirmation: engine ops over RE-05's state; `classify-recent` emits an event where the Node
      body pushed Telegram buttons; one inbox entry per card, settled on decide or expiry; CLI.
- [ ] T2 skill-proposal acceptance: engine ops over RE-06's ledger; accept installs the staged `SKILL.md` through the X1
      pipeline as an unsigned local skill, retire uninstalls; one inbox entry per proposal; CLI.
- [ ] T3 daily review: a twentieth job with `morning` and `evening` profiles, the narrative lead and the workspace
      status ported, scheduled by the harness from `morningReview` and `eveningReview`, written to
      `<state_dir>/reviews/<agentId>/`, inbox entry, CLI.
- [ ] Rules: every decision through the core's RBAC; previews never carry a secret or a hidden type; the review never
      applies; no Phase 1 golden changes; RE-06's job count becomes twenty in T3's PR.

### RE-14 — Token counter and provider cache profiles (M; service in Phase 1, consumers in Phase 2)

Brief: [`rust-engine/RE-14-token-counter.md`](rust-engine/RE-14-token-counter.md). Design in §2.5 (J8) and §2.6; decisions RE-D20–RE-D29.

- [ ] Core prerequisites, one PR each, independent of the engine (§2.6 Tasks): the Anthropic tool-loop breakpoints, the cache-profile table as JSON, emitters for every provider class, cached-token usage fields.
- [ ] `packages/providers/schema/cache-profiles.json` with its schema; `packages/core/src/prompt/model-table.ts` becomes its loader; lookup vectors for the Rust side.
- [ ] `src/tokens/`: families from the table, the methods `exact`, `tokenizer-text`, `calibrated` and `heuristic`, `lower ≤ tokens ≤ upper`, count goldens recorded from the reference tokenizers.
- [ ] A calibration store under the engine's state directory, fed by `LlmResult.usage` and `engine.tokens.observe`.
- [ ] `engine.tokens.count`, `engine.tokens.observe` and `engine.tokens.families`, served through RE-8.
- [ ] Phase 2: the core reads engine counts behind `prompt.tokenCounting: "engine"` after a B5 measurement (RE-10).

## 5. Pros and cons of the rewrite

### 5.1 For

| Gain | Why it is real here |
|---|---|
| One language for memory and harness | the owner's stated direction; the supervisor, CLI, installer, updater, log schema, config and RPC crates are Rust already — the engine is the last large Node component besides the core |
| Smaller, simpler distribution | the Node payload loses `@lancedb/lancedb`, `apache-arrow` and `openai`. Embeddings and reranking no longer go through `@huggingface/transformers`. The transformers closure (`onnxruntime-node`, `onnxruntime-web`, `sharp`) stays as `packages/core`'s optional dependency, for local Florence-2 captions only (§2.5). The engine ships as one binary per target, like `plur1bus-attest`. The private-package pin and `GH_ENGINE_READ_TOKEN` disappear (Phase 3) |
| Predictable latency | no JIT warm-up for the 400/600 ms recall budgets; scoring, dedupe, graph spread and JSON handling run natively (LanceDB's search itself is Rust already in the Node SDK and does not get faster) |
| Types that cannot lie | `Degraded`, `JobTrigger`, `CheckpointReason`, the diagnostics union and every RPC param are closed types; `deny_unknown_fields` replaces `any` at the boundary |
| Defects fixed by construction | f.1 (dropped abort), f.4/f.5 (locks), f.6 (two timers), f.9 (`chmod` on Windows), f.11 (ACL logging default-off), f.14/f.15 (Windows routing and junctions) — host-contract (f) |
| Crash isolation and supervision | the engine is a supervised slot: health, backoff, adoption, `1staid` checks, Windows pipe ACLs — all existing machinery |
| Contract additions once, natively | A1 curated memory and the memory tree (M3+) are implemented in the Rust engine instead of landing in Node first and being ported later |
| A permanent parity asset | RE-9's scenarios and goldens remain the engine's behavioural regression suite after the Node engine is gone |

### 5.2 Against

| Cost or risk | Mitigation (WP) |
|---|---|
| Size: 101,408 lines of JavaScript in the closure plus 615 test files; a multi-month programme | subsystem order with parity gates (RE-4 before RE-5 before RE-6); the deterministic core first, LLM-driven jobs behind a go/no-go (RE-D5) |
| LLM-driven paths are not reproducible | parity on recorded LLM fixtures only; prompts are versioned templates with golden hashes; the cache keys include the template version (RE-6) |
| Lance version lock-in: compatibility pins the crate to the Node package's Lance | the upgrade rule and round-trip test (RE-2); the store strategy after Phase 3 is an explicit decision (RE-D3) |
| Build time and binary size: Lance brings DataFusion and Arrow; `ort` brings ONNX Runtime | measured in RE-0; dev opt-levels per crate; `load-dynamic` or vendored binaries (RE-3); a separate binary keeps `plur1bus` itself small |
| Licence closure review: Lance/DataFusion dependencies likely exceed today's `deny.toml` list | the gate runs first (RE-0); every allow-list change is an owner decision in the PR |
| Release-candidate dependencies: `ort` 2.0.0-rc. `tokenizers` stays on `=0.23.2` until the 1.x line is final (RE-D19). The 1.0 release candidates have no `Tokenizer::from_file` (absent since rc.2; upstream lists it as returning before 1.0) and read only the 2.0 format, so every legacy `tokenizer.json` needs `tk-convert` | exact pins; parity vectors plus exact token-id goldens for every pinned `tokenizer.json` catch a behavioural change on a bump |
| Windows ARM64: ONNX Runtime and Lance on `windows-11-arm` are experimental in CI today | the target keeps `continue-on-error` until its first green run, like the Hermes Windows leg |
| Two engines during the transition: every fix lands twice until Phase 3 | §3.10 triage keeps the list explicit; RE-12 keeps the Node engine correct now; Phase 1 is time-boxed by the parity gate |
| The OpenClaw plugin line keeps evolving in JavaScript; after the rewrite its deltas are re-implemented, not merged | that is already true since 2026-10-02; the triage template (§3.10) is the process |
| Scope creep into the TypeScript core | §2.3: the core rewrite is RE-D9, a separate decision |
| Opportunity cost: M3+ memory tree, M5+, Track F compete for the same people and agents | RE-D6: implement the A1 and memory-tree contract additions in the Rust engine instead of twice; everything else keeps its place in `docs/milestones.md` |

### 5.3 Variants

- **A — full port** (RE-0…RE-11 as written): the owner's goal; the largest risk is RE-6's LLM-driven jobs.
- **B — staged (recommended)**: A, with a go/no-go after RE-9's first results on the deterministic core (RE-1…RE-5,
  RE-7, RE-8). Not a runtime hybrid — two engines never share a live store; until RE-6 is complete the Rust engine is
  opt-in and reports unported jobs as `not-implemented`.
- **C — no rewrite**: pin the A1 and memory-tree contract once the engine merges them, forward-port CP-5/CP-7 (RE-12), and
  keep the Node engine. Cheapest. It keeps the private pin, the engine's `transformers`-based embedding and reranking
  path, and the host-contract defects that need the adapter's shape to be fixed.

## 6. Open owner decisions

| Id | Question | Recommendation |
|---|---|---|
| RE-D1 | Integration: supervised process + RPC, or N-API in-process | process + RPC (§2.1); N-API only if RE-8's hop measurement fails |
| RE-D2 | Location: crate in this workspace, or a separate repository | this workspace (`deny.toml` allows git dependencies only from this repository; one CI, one release) |
| RE-D3 | Store strategy: keep LanceDB at the Node package's Lance version through Phase 2; after Phase 3 upgrade Lance with a migration, or move to SQLite + a vector index | keep and pin now; decide the Phase 3+ strategy on RE-2's numbers |
| RE-D3b | `ort` binaries: `load-dynamic` with a shipped runtime, or vendored `download-binaries` | `load-dynamic`; the payload already ships platform binaries per target |
| RE-D4 | Drop the embedding-owner IPC in favour of `engine.embedding.*` RPC | yes |
| RE-D5 | Jobs: full port in one go, or go/no-go after the deterministic core | go/no-go (variant B) |
| RE-D6 | Contract target: the pin's 1.17.0 (1.16.0 + `admin.reembedding.validate`) at parity, plus two additive targets: A1 curated memory (`codex/gp3-a1-curated-memory` @ `9b935ce1`, which also labels itself 1.17.0) and the memory-tree WP1 members | parity on 1.17.0; A1 and the tree implemented natively once the engine has assigned their numbers; the harness already feature-tests A1 |
| RE-D7 | The engine repository after Phase 3: archive `main`, keep for the OpenClaw plugin line | keep for the plugin line; the harness no longer depends on it |
| RE-D8 | Forward-port CP-5/CP-7 to the Node engine now (RE-12) | yes, before anything else |
| RE-D9 | A later rewrite of the TypeScript core | separate decision and plan; not implied by this one |
| RE-D10 | The engine binary joins the container image and the desktop bundle | yes; `container.yml` paths and `apps/desktop` bundle scripts in RE-8 |
| RE-D11 | Recall score: keep `1/(1+d)` over the squared-L2 distance with the inert `minScore` 0.3, or move to the cosine similarity with thresholds calibrated per embedding profile (§1.6) | **Decided 2026-10-24: fix.** Kept in Phase 1; cosine score and calibrated thresholds in Phase 2 (RE-10 T7) with an A/B on a frozen corpus before the default flips; no re-embedding |
| RE-D12 | Retrieval: vector search only, or a hybrid pool (exact id and metadata, full-text index, vector) fused by reciprocal rank fusion (§1.6) | **Decided 2026-10-24: fix.** Kept in Phase 1; hybrid retrieval with rank fusion in Phase 2 (RE-10 T8); the same fusion covers two embedding identities in one store |
| RE-D13 | Job partitions: `workspace`/`user` partitions from the shared pools only, or the agent's own partition also reads the scoped rows of its own table (§1.6) | **Decided 2026-10-24: fix.** Kept in Phase 1; the agent partition reads its scoped rows in Phase 2 (RE-10 T9); no row moves on disk |
| RE-D14 | Advisories inside the pinned Lance closure: `tantivy 0.24.2` (non-optional under `lance-index 2.0.0`) pins `lru 0.12`, which carries RUSTSEC-2026-0002 and RUSTSEC-2026-0253 and blocks the `quality` advisory gate; an owner exception in the audit allow-list (renewed every 90 days), or a fork of tantivy at its tag 0.24.2 with only `lru 0.18.2` applied, consumed through `[patch.crates-io]` | **Decided 2026-10-24: fork.** `Cyb3rb1ade/tantivy`, branch `plur1bus/0.24.2-lru-0.18.2`, commit `038215a5` (one changed line in its `Cargo.toml`, `lru = "0.18.2"`, resolved to 0.18.5 in the harness lock), pinned by `rev` because the session proxy refuses tag pushes (the annotated tag `v0.24.2-plur1bus.1` exists in the local clone; once the owner pushes it the patch may name the tag instead); the root `Cargo.toml` patch and the `deny.toml` `[sources]` entry land with RE-00 (PR #759). The same rule applies to the next such advisory: a fork at the pinned tag with only the fix, never an exception. Exit: the patch goes when the Lance pin (RE-D3) moves to a tantivy with `lru >= 0.18.2` or to no tantivy at all. **Exception granted 2026-10-26:** RUSTSEC-2026-0391 and -0395 to -0406 (zstd 0.13.3, zstd-safe 7.3.0, through `arrow-ipc` 57.3.1, `lance-encoding` 2.0.0 and `tantivy-sstable` 0.5.0) are fixed only in zstd 0.14.3, a major step that a one-line fork cannot take, and they blocked `quality` on `main`. The owner allowed a time-limited audit exception until 2026-11-25 (#784, `3c5875e7`) while forks of tantivy, arrow-rs and lance move to zstd 0.14.3; the exception goes when they land |
| RE-D15 | Lexical analyzer for RE-10 T8, and where its terms live. It refines RE-D12's "Lance full-text index over `text` and `summary`" (§2.5). Options: (a) our own DE/EN analyzer, built from adopted permissive parts (NFKC, UAX #29 words, full case folding, stop words removed before stemming, frostem Snowball 3 German and English); its terms go to a derived per-store table `_lexical` that Lance BM25 indexes with a pass-through `whitespace` tokenizer; (b) the Lance built-in analyzer on `memories.text` and `summary`; (c) an SQLite FTS5 sidecar fed by (a) | (a). It ships directly in T8 if it meets the exit criteria of §2.5. It carries `ANALYZER_ID` and a per-row `content_hash` (text, summary, status). Every `memories` write and delete, forget, tombstone and erase included, is followed by the matching `_lexical` change in the same `Store` operation (`memories` first). At open, a content-hash diff repairs whatever the Node engine changed while it was selected, and a crash between the two commits; Node does not maintain `updatedAt`, so that field is not used. The word-internal 4-gram field `ng` ships only at ≥ +1.0 point (0.010) of German MRR@10. (b) is only the fallback, and only in its language-neutral profile (`simple`, lowercase, ASCII folding, no stemming, no stop words, `max_token_length` 128). Never Lance's German profile: it removes stop words after stemming, its stems predate Snowball 3, it drops tokens of 40 bytes or more, and its stems change once an RE-D3 Lance upgrade crosses 11.0.0, where `lance-tokenizer` replaces `rust-stemmers` with `frostem`. (c) not now, because two stores would have to stay consistent; it stays the target if RE-D3 moves the store to SQLite, fed with the same terms |
| RE-D16 | Phase 2: move the engine's legacy lexical helpers onto the shared analyzer. Today `lib/text-utils.js` `tokenize()` splits "Müller" into `mu` + `ller`, `lib/memory-graph.js` extracts topics with ASCII-only regexes, `lib/neo-arch.js` turns "café" into `caf`, and there are about 10 separate DE/EN stop lists (§1.6, last paragraph) | Yes, as RE-10 T10 after T8 has landed: one consumer group per PR, goldens re-recorded under this id. The helpers move onto the analyzer's `sets` profile (NFKC, case fold, diacritic strip; no stemming, no stop words). This keeps the meaning of `recall.dedupJaccard` 0.78 and of the 0.8/0.9 merge thresholds; each threshold is re-checked on the frozen corpus. Order: recall dedupe and boosters, then neo scoring, then fact quality and merge safety after an A/B, and memory-graph topics last, together with a graph rebuild |
| RE-D17 | Two JS string behaviours Rust cannot copy directly. (a) A JS `.slice()` cap (capture 15,000, fullText 2,000, display 400, neo `normalizeStatement` 4,000/1,000, the env-config summary prompt's 60,000) can cut inside a surrogate pair and leave a lone surrogate, which a Rust `String` cannot hold. Node then writes U+FFFD at UTF-8 boundaries (Lance through Arrow, SQLite, `createHash().update(string)`) but the escape `\ud83d` in JSON text (`JSON.stringify`: neo JSONL, ledgers, state files, RPC). Neo stable ids (`lib/neo-arch.js:242-249`) and the LLM result-cache key (`lib/llm-result-cache.js:126-129`, `:165-182`) hash that JSON text. serde_json rejects the escape on input. (b) `localeCompare` called without a locale follows the process default locale | (a) Mirror Node per target, through `text::js::JsString`, the UTF-16 value every slice-cap result keeps. It serialises as `JSON.stringify` does (the `\udXXX` escape) in JSON text and in hash material built from JSON, and as U+FFFD at UTF-8 boundaries (Lance, SQLite, the sha256 of a raw string such as the embedding-cache `textHash`). Every Node-written JSON or JSONL file is read through `text::json`, which keeps the escape and writes it back byte-identically. Goldens: RE-02 T1 a Lance row cut inside an emoji (confirms U+FFFD); RE-02 T5 a JSONL line with the escape; RE-04 T0 the serialisation vectors; RE-05 a neo `stableId` whose statement is cut at 4,000 inside an emoji; RE-06 an LLM result-cache key whose prompt is cut inside an emoji. U+FFFD everywhere is rejected: after an engine switch it would duplicate neo records under new ids and miss the result cache. (b) Use `icu_collator` with the locale Node 24.21 resolves under the CI locale (`new Intl.Collator().resolvedOptions().locale`), recorded as vectors. Under Node, a host with a different default locale may order ties differently; the recorded CI order is accepted as the parity baseline |
| RE-D18 | Train our own tokenizer: a subword vocabulary (BPE, Unigram or WordPiece), a German decompounding lexicon, or nothing | No subword tokenizer for this engine. Measured BM25 MRR@10 on GermanQuAD: own BPE 32k 0.891, own Unigram 32k 0.921, untrained Snowball 0.921, shipped XLM-R 0.929. A model's vocabulary cannot change without changing the model (new input embeddings and re-validation; for the embedder also a re-embedding of its stores), and provider counts need the providers' own tokenizers. The decompounding frequency lexicon is built only if T8's compound-gap gate triggers it, and ships only if it passes its adoption gate (RE-10 T11, §2.5): 2–4 GB of ODC-By and CC0/CC-BY German text, an offline builder, and an FST with sha256, `RECIPE.json` and `NOTICE`. It is never trained on owner data. For a future own model's vocabulary (J9) the verdict is the same: adopt an existing permissive DE/EN vocabulary from the §2.5 shortlist, with Kolibri-1 only after Aleph Alpha confirms in writing that the grant covers its `tokenizer.json`, and train one only if we train a model and those fail. Reopening the retrieval subword question needs a measured win of ≥ +1.0 point (0.010) of German MRR@10 over the XLM-R field, with no English loss on any corpus |
| RE-D19 | `tokenizers` line and regex backend for RE-03 (§5.2 assumed `1.0.0-rc`) | Pin `=0.23.2` with `default-features = false`. Use the `fancy-regex` backend if the token-id goldens of every pinned tokenizer file pass on it in T0. It is pure Rust and covers e5's `Replace(' {2,}')` normalizer and jina-v5's `\s+(?!\S)` lookahead. Otherwise use `onig` (Oniguruma, a C library) and prove the Windows MSVC build the way #769 did for protobuf. Not 1.0.0-rc.3: it was released 2026-10-19, inside the two-week window. Like rc.2 it has no `Tokenizer` type and no `Tokenizer::from_file` (upstream lists them as returning before 1.0), only a slim reader of the 2.0 format, so every pinned `tokenizer.json` must pass `tk-convert` first. A probe loaded e5 and EmbeddingGemma 2 that way with the `regex` feature (e5 fails without it); several byte-fallback BPE files were still refused. Move to 1.x only at its final release, gated by the token-id goldens. The goldens for the CC-BY-NC jina files are committed only if the owner agrees that ids derived from them may live in the repository. Otherwise they run in RE-09 T3's real-model leg, on files fetched with consent. **Decided 2026-10-28 (jina goldens):** committed, like the other families' goldens. `NOTICE-jina.md` beside them names, per model, the Hugging Face repository and pinned revision and the licence CC-BY-NC-4.0, says that the files are computed from the repository's own test sets and hold no model weights, and cites this decision. Normal CI checks the token ids against the jina tokenizer files, fetched by SHA-256 pin and never committed; vectors and scores need the ONNX models and stay in the `real-models` target. The models themselves load only with consent, through the harness's NC mechanism |
| RE-D20 | Token counting (§2.5 J8, §2.6): (a) one Rust implementation in the engine (`src/tokens/`, RE-14), served to the core as `engine.tokens.count` / `engine.tokens.observe`; (b) a WebAssembly build of that same code, loaded into the core; (c) a separate counter in the core, in TypeScript | **Decided 2026-10-26: (a).** Following the owner's direction of 2026-10-25: one implementation, in Rust. Per family: exact local tokenizer files where public and licence-clean (o200k from `openai/gpt-oss-20b` `tokenizer.json`, Apache-2.0, for OpenAI models up to GPT-5.x; the Gemma 4 `tokenizer.json` for Gemini text; local models' own files), a calibrated estimator for Claude, GPT-6, grok-4.x and every other unpublished tokenizer, provider count endpoints only as background calibration (RE-D27). The core calls it from `composition/` before the pure builder runs, so B9 still sees 0 syscalls inside assembly; it memoises counts per (segment hash, family) and makes one batched call per turn. With the Node engine, or with no engine up, the core falls back to today's chars/4, labelled `heuristic`. This is a service the engine offers, not a rewrite of the core, so RE-D9 stands. Use (b) only if RE-8's hop measurement or the turn-latency budget fails |
| RE-D21 | Provider cache profiles: keep `packages/core/src/prompt/model-table.ts` in TypeScript with a hand-kept Rust copy, or move to one versioned JSON table with a schema | One table: `packages/providers/schema/cache-profiles.json` plus a schema, owned by the providers package, because that package owns the wires that emit markers and parse usage. `model-table.ts` becomes a loader. The engine reads the table with `include_str!` and runs a parity test against lookup vectors generated on the TypeScript side (the log-schema pattern). Rows are keyed by gateway, provider, platform, wire and model family, never by model id alone. Each row carries `source`, a `verified` date and a `status` |
| RE-D22 | Who places provider cache markers, TTL fields and affinity keys | The core only, through one emitter that serves both chat turns and `host.llm.complete`. The engine states role-tagged segments, `cache_after` boundaries and a reuse class (`OneShot`, `Batch`, `Session`) per purpose, and never names a provider field. The Node engine's direct `lib/tier3-llm.js` client is not ported |
| RE-D23 | Engine budgets and estimators in Phase 1 | Byte-identical. `semanticCompression.tokenBudget` stays a word count. The recall caps stay in characters (17,000 / 12,000 / 2,000). The three-characters-per-token knowledge-update estimate stays, and so do the capture summary's `maxChars/4` target and its ceiling (`maxChars/3` at the pin, `maxChars/2` after CP-1). `contextBlock.tokensEstimate` stays unset. Moving any of these to the counter is a Phase 2 change, each with a decision id and re-recorded goldens (RE-R1) |
| RE-D24 | Job prompt order for caching. At the pin most job prompts put volatile data inside the system message or between the instructions and the output schema | Phase 1: template text stays byte-identical to the pin, plus CP-3's afterthought order. The `Layout` boundary sits at the end of the existing static prefix, even where that prefix is below every provider's minimum. Phase 2: reorder per purpose (instructions, rules and schema first, volatile data last), only for purposes classified `Batch` or `Session`. Each reorder bumps the template version and comes with a measured hit rate |
| RE-D25 | Tokenizer vocabulary files: bundle them in the payload, or fetch them on first use | Fetch through RE-3's `ArtifactCatalogue` (sha256 pin, licence ledger), and count with the estimator until the file is present. An artifact under a non-OSI or conditional licence needs an owner decision before it is listed: Grok-2 (xAI Community License), Gemma 3 (Gemma Terms; whether the tokenizer file alone is covered is unverified), Kimi K3 (keep the notice). **Decided 2026-10-28:** fetch on first use, never bundle; the owner approved all three, Kimi K3, Grok-2 and Gemma 3, with each licence's conditions in the licence ledger |
| RE-D26 | Safety margin near cache minimums | Every count carries `lower`, `upper` and a method. Place a marker when `upper` ≥ the minimum where the profile documents a below-minimum marker as silent (Anthropic, OpenAI 5.6+). Require `lower` ≥ the minimum where it is an error (Gemini explicit caches) or unverified. Fire R2's `prompt.below-minimum` warning when `lower` < the minimum. Budget reservations and compaction triggers use `upper`. Confirm a near-minimum prefix from the next usage report and remember the outcome per (profile, prefix hash). A family with no calibration observations keeps today's chars/4 rule |
| RE-D27 | Calibration of estimated families (Claude, GPT-6, grok-4.x, Gemini 4 Argon and 3.6–3.8 Flash, unpublished tokenizers) | In the engine: an affine fit per (route, tokenizer family, method), against inclusive prompt totals. The slope corrects tokenizer mismatch; the intercept covers chat-template framing and hidden preambles. It is fed by the engine's own `LlmResult.usage` and by the core through `engine.tokens.observe`. It replaces the core's `token_calibration` EWMA once the core consumes engine counts (Phase 2). Provider count endpoints (Anthropic `count_tokens`, OpenAI `input_tokens`, Gemini `countTokens`, xAI `tokenize-text`, Kimi `estimate-token-count`) serve only as background calibration, never on the critical path (ADR-010 L3) |
| RE-D28 | OpenRouter | A route-level profile resolves the upstream family from the slug. Emit only the marker forms OpenRouter documents (Chat: `cache_control` on text parts and tools; Responses: top-level `cache_control` or `prompt_cache_breakpoint`). Send TTLs only to upstreams that accept them natively, because translation drops them. Always send `session_id`, set to the builder's sticky id. Never set `provider.order` except to pin a single provider. Take per-endpoint prices from the Endpoints API. Parse `cache_write_tokens` inline, because `/api/v1/generation` has no write field |
| RE-D29 | Weight of cache reads in the token-only budget (#601) | Owner decision. Phase 1 keeps full weight, as today, and records reads and writes separately (the usage store already has `cache_write_tokens`; RE-14/P4 fills it on every wire), so either rule can be applied later. RE-14/P5 makes the weight a budget setting with default 1.0, shows fresh input, reads, writes and output apart, and corrects the budget README, which says cache tokens are not counted: they are, inside `inputTokens`. The owner said on 2026-10-28 to decide once P5's split view shows real numbers; until then full weight stays |

## 7. Risks (beyond §5.2)

| Id | Risk | Signal | Response |
|---|---|---|---|
| RE-R1 | Parity drift: goldens edited to make a test pass | a golden changes without a CP or decision reference in the PR | review rule: a golden diff needs a §3.10 CP id or a decision id in the commit body |
| RE-R2 | Hop overhead on Windows named pipes exceeds the budget | RE-8 p99 > 5 ms | N-API fallback (§2.2) for Windows only, or request batching in `EngineClient` |
| RE-R3 | A Node SDK store written after a `@lancedb/lancedb` bump in the engine repository no longer opens in the pinned Rust crate | RE-2 round-trip fails on a pin bump | the harness pin stays until the Rust crate moves in step; the upgrade rule in `docs/engine-stores.md` |
| RE-R4 | Model artifact drift: a re-download yields different ONNX bytes | `ArtifactCatalogue` sha256 mismatch | refuse to load; `1staid check` `models.cache` reports it (existing id) |
| RE-R5 | The `host.*` reverse channel becomes a privilege path | a `host.*` call from a non-engine connection reaches a handler | the dispatch guard and its negative invocation tests in RE-8; the capability listing is a UX check, never the guard |
| RE-R6 | CI time: the Rust build of Lance + DataFusion pushes `unit` past its budget | RE-0 measurement (2026-10-24): `unit (ubuntu-24.04)` 20 min 45 s on `main` → 36 min 08 s on RE-00's first run and 35 min 17 s on its second, inside the 65-minute job ceiling (`rust-cache` did not shorten the Rust steps between the two runs, so these are working figures, not a cold-cache outlier); its `cargo test --workspace` step took 16 min 26 s and 16 min 06 s against a 20-minute step budget (7 min 54 s on `main`), `cargo clippy` 7 min 39 s and 7 min 25 s (1 min 24 s on `main`); locally the debug closure builds in 9 min 44 s cold | RE-00 raises the `cargo test` step budget to 30 minutes (`docs/ci.md`); per-crate opt-levels (RE-00 measured them: no gain while no engine code runs in tests, so none were added), `rust-cache`, the engine crate's tests in their own job selected by the `changes` plan; re-measure after RE-02, the first code that links Lance |
| RE-R7 | JS↔Rust text-semantics drift silently changes tokens, dedupe decisions, chunk boundaries, graph edges or stored ids. Sources: the Unicode version (V8's ICU under Node 24.21 versus ICU4X data); Rust's Unicode `\b`/`\w`/`\d` versus JS's ASCII ones; the JS `\s` set (U+FEFF in, U+0085 out); lookarounds the Rust `regex` crate lacks; UTF-16 lengths and slices; a lone surrogate written as U+FFFD where Node writes the JSON escape (neo stable ids, the LLM result-cache key) or the reverse; a locale-dependent `localeCompare` | a legacy-helper golden fails; a neo `stableId` or LLM-cache-key golden fails; a Node-written JSON/JSONL line fails to parse; RE-04 T0's Unicode-version test fails after a dependency bump; a helper passes its fixtures but differs on real data in RE-09 | RE-04 T0 lands before RE-02 T5, RE-03 T6 and RE-04 T1, with vectors recorded on Node 24.21 under the CI locale; review rejects any engine regex, slice or Node-file read not built through `text::js`/`text::json`; `JsString` serialises per target (RE-D17); a Unicode-data bump is a reviewed change with re-recorded vectors |
| RE-R8 | Model-tokenizer ids differ: the Rust `tokenizers` crate (with `fancy-regex` or `onig`) and the JS `@huggingface/tokenizers` 0.2.0 the Node engine uses disagree on German, NFD or emoji text, or truncation keeps a different last token (for jina v5 also the pooled token). Vectors then drift while the identity looks unchanged | a token-id golden of RE-03 T3/T3b/T3c/T4 fails; cosine passes while the ids differ | exact token-id goldens for every pinned `tokenizer.json`, an over-cap passage included (the jina ones in RE-09 T3's real-model leg); encode first, then cut ids and mask by hand; switch the regex backend (RE-D19); if the JS side is the odd one out, parity reproduces it unless a decision id says otherwise |
| RE-R9 | Analyzer drift: a `frostem`, segmentation or ICU bump changes the query terms but not the stored ones, so lexical recall degrades without any error | the analyzer's golden term vectors fail; `analyzer_id` differs at open | exact `=` pins; `ANALYZER_ID` stored with `_lexical`; a mismatch rebuilds `_lexical` from text with no model call; if `frostem` fails its gate, fall back to `rust-stemmers 1.2.0` (already in `Cargo.lock`) |
| RE-R10 | `_lexical` falls out of step with `memories`. Either the terms of a forgotten, tombstoned or erased row survive (a retention defect), or rows the Node engine wrote or changed while it was selected are missing or stale. Node does not maintain `updatedAt`, and Lance has no cross-table transaction, so neither can be detected by timestamp | a forgotten or tombstoned row's id is still in `_lexical`; a stored `content_hash` differs from the one recomputed at open; the watermark differs | write order `memories` first, then `_lexical`; forget, tombstone and erase change `_lexical` in the same `Store` operation; at open, a content-hash diff over (id, text, summary, status) repairs a Node session and a crash between the two commits; old `_lexical` versions are cleaned up under the `memories` policy; lexical hits are only ids, hydrated from `memories` and ACL-checked; rebuild after a re-embedding switch or a restore; covered by RE-10 T8's tests |
| RE-R11 | A vendor changes its caching contract between releases. Recent examples: OpenAI explicit caching (2026-07-09) and its 12 h TTL (2026-10-20); Kimi K3 write billing (between 2026-09-07 and 2026-09-28, from secondary sources); Gemini explicit caching now legacy-only | The B5 hit ratio drops on a route; a 400 names a cache field; `prompt.unknown-model` events appear; a row's `verified` date is older than the review interval | Rows carry `source`, `verified` and `status`, so a table change needs no code change. Add a §3.10-style triage of vendor changelogs for every provider in the table |
| RE-R12 | The official docs contradict themselves and the table encodes the wrong side. Known cases: OpenAI 12 h on Chat Completions and per-breakpoint `ttl`; Opus 4.7 minimum 2,048 (Anthropic) vs 4,096 (AWS); Gemini 3.8 Flash 4,096 (Developer API) vs 6,144 (Vertex); Mistral's "multiple of 64" vs an example of 1008; whether xAI counts reasoning tokens in output | No cache write near a minimum; a 400 on a field; billed output disagrees with xAI `cost_in_usd_ticks` | Encode the conservative value with `status: unverified`. Add an opt-in live-probe suite (real keys, never part of `ci-gate`) with one probe per contradiction |
| RE-R13 | Counting puts an RPC on the turn's critical path (ADR-010 L3/B9) | RE-8 hop p99; the turn-latency bench; the B9 syscall assertion | Count outside prompt assembly. Memoise per segment hash. Count recall blocks and captured turns where they are produced. Make one batched call per turn. Keep the WebAssembly fallback of RE-D20 |
| RE-R14 | Under-counting withholds cache markers or under-reserves the budget. Causes: chars/4 against Claude 4.7+ tokenizers (about 30% more tokens) and against CJK text | The calibration slope is above 1 for a family; settle overages (`budget/calls.ts:236`) | Place markers and reserve budget on the upper bound (RE-D26); calibrate from every response |
| RE-R15 | The cached prefix is invalidated by inputs other than prompt text: the Anthropic beta-header set, `context_management`, thinking or effort, `tool_choice`; DeepSeek's reasoning effort (rendered at token 0) and its tools (appended to the system message); Qwen's tools (serialised into the system message); xAI encrypted reasoning that is not resent; the core's wire tool order, which changes per turn | Anthropic `diagnostics` and OpenAI `prompt_cache_diagnostics` miss reasons; cache writes roughly equal the whole prompt on every turn | The profile lists the prefix-affecting parameters per provider. The core holds them constant per session and sorts the wire tool block. Diagnostics feed telemetry |
| RE-R16 | Anthropic's preserved-thinking prefix check turns an edited prefix into a 400 instead of a cache miss. It applies to accounts created on or after 2026-08-31, on Fable 5.1, Opus 5.5, Sonnet 5.5 and Haiku 5.5 | A `prefix_mismatch` 400 after a compaction or a change to the tool set | Compaction and tool changes either drop earlier thinking blocks or set `prefix_mismatch_behavior: drop_block` deliberately. Moving markers is not an edit |
| RE-R17 | No usable tokenizer for a family: none public for Claude 3+, grok-4.x, GPT-6, Gemini 4 Argon and 3.6–3.8 Flash, qwen3.7-plus or Mistral Large 4; Kimi K3.1 Pro weights not yet released; licence conditions on the Grok-2 and Gemma 3 files | A family stays `calibrated` or `heuristic`; licence review blocks an artifact | Calibrated estimator families are first-class. No artifact enters the catalogue without its licence decision |
| RE-R18 | Usage arithmetic is normalised wrongly. Inclusive OpenAI-shaped totals vs exclusive Anthropic-shaped `input_tokens`; vLLM's Anthropic shape subtracts both cached and created tokens; vLLM and SGLang omit the cached field without their flags; DeepSeek reports a hit/miss pair; Mistral's field is missing from its OpenAPI spec | A calibration slope far from the family's other routes; a hit ratio of 0 on a provider that does cache | The table holds a usage-field map per wire, backed by fixture tests. An absent field is `None`, never 0 |
| RE-R19 | OpenRouter routing defeats the cache: `provider.order` disables sticky routing; open-weight models are spread over many third-party endpoints, each with its own cache and price; TTLs are dropped in marker translation | Hit ratio per route; `openrouter_metadata` shows the provider changing | Always send `session_id`. Pin a single provider where TTL semantics matter (Kimi 1 h, Anthropic 1 h). Take prices from the Endpoints API |
| RE-R20 | Local servers lose the cache silently: Ollama reloads on an option change or after `keep_alive` (default 5 min); `llama-server` clears idle slots from device KV; vLLM and SGLang report no cached count without their flags; some chat templates inject the date or strip reasoning | Ollama `prompt_eval_cached_count` is 0 or absent alongside a large `load_duration`; the `LLAMA_SERVER_SLOTS_DEBUG=1` first-mismatch log | Pin runner options. Set `keep_alive` above the idle gap. Use `id_slot` per session on `llama-server`. Pass `chat_template_kwargs` (for example a fixed `date_string`). Document the server flags in `docs/provider-matrix.md` |
re-measure after RE-02, the first code that links Lance. Windows: RE-00's `protoc` build broke `unit (windows-2025)` (LNK2038, run 40133657878) until #769 moved protobuf to the DLL C runtime (`.cargo/config.toml`, `crates/plur1bus-engine/cmake/protobuf-msvc-crt.cmake`, `tests/msvc_crt.rs`). The workaround can go once protobuf is ≥ 35 or the `protoc` feature is no longer used. Windows Rust step times are not measured yet |

## 8. Glossary

- **Jev** — the OpenClaw plugin's decision-model persona; in the harness, the decision role of `docs/decision-service.md`.
- **neo** — the working-memory layer of `lib/neo-arch.js` and the `neo` context block.
- **CP** — change package (§3); **RE** — a work package of this plan; **G-\*** — a golden vector recorded from the Node
  engine; **f.n** — a defect id of `docs/host-contract.md` (f).
