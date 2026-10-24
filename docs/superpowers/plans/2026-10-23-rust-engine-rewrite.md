# Rust engine rewrite (`plur1bus-engine`) — change packages 7.18.21–7.18.31 and implementation plan

**Goal.** Replace the Node memory engine (`@cyb3rb1ade/plur1bus-memory`, pinned to commit `98dfe2f`, contract 1.16.0)
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

**Status.** Plan only (2026-10-23). Owner decisions RE-D1–RE-D10 open (§8). Nothing here changes the pinned engine.
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
  └──► RE-9 parity harness (scenario format after RE-1; golden recording as soon as RE-4 answers)
RE-6 jobs and dreaming (after RE-5 and RE-7; go/no-go gate on RE-9 results — RE-D5)
Phase 1 exit: RE-9 green on every scenario, system tests green with PLUR1BUS_ENGINE_IMPL=rust
RE-10 Phase 2: memory-facing core paths move into the engine; T7–T9 the three §1.6 behaviour changes
RE-13 Phase 2: harness surfaces for critical confirmations, skill proposals and the daily review (§1.7; parallel to RE-10)
RE-11 Phase 3: retire the Node engine pin, docs and ADR
```

## 1. Starting point

### 1.1 Three lines of the engine

| Line | Head | Package / contract | Used by |
|---|---|---|---|
| `main` of `Cyb3rb1ade/openclaw-plur1bus-memory` | `98dfe2f` (harness pin) | `@cyb3rb1ade/plur1bus-memory` 7.18.4, contract **1.16.0** | the harness core (`packages/core/package.json`, exact commit) |
| OpenClaw plugin line | tag `v7.18.31` = `6419a60e` (2026-10-23) | plugin 7.18.31, diverged from `main` at `9cc5f833` (2026-10-02) | OpenClaw installations; source of the change packages in §3 |
| `codex/gp3-a1-curated-memory` | `9b935ce`, unmerged | contract **1.17.0** (curated memory, the memory-tree fields of the M3+ plan) | nothing yet; the harness side of 1.17 is implemented and waits for the pin (#604–#607, #609) |

### 1.2 Size of what is being replaced

- Import closure of `engine/create-engine.js`: **323 files, 101,408 lines** of JavaScript (the whole repository is
  larger; the closure is what an engine port has to re-express). `lib/telegram-commands/`, `lib/obsidian-control-room/`
  and the i18n tables are adapter material inside that closure and are not ported (engine-extraction §a.3).
  [`rust-engine/MODULE-MAP.md`](rust-engine/MODULE-MAP.md) (audit 2026-10-23) lists every file of the `.js` closure (322
  files, 100,593 lines) with its owner brief and disposition: 234 ported, 26 folded into Rust idioms, 36 pending the
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
- Dependencies that disappear from the Node payload with the rewrite: `@lancedb/lancedb`, `apache-arrow`, `openai`, the
  optional `@huggingface/transformers` closure (`onnxruntime-node`, `sharp`).

### 1.3 The Phase 1 surface: what the core calls today

27 engine members, counted over `packages/core/src` (call sites in parentheses): `status` (9), `recall` (8), `models`
(5), `memory.import` (5), `jobs.list` (5), `jobs.run` (4), `capabilities` (4), `embedding.local` (3), `capture` (3),
`memory.list` (2), `jobs.history` (2), `embedding.serve` (2), `contract` (2), `close` (2), `checkpoint` (2),
`admin.reembedding` (2), `stores.adopt`, `open`, `memory.unimport`, `memory.unbind`, `memory.show`, `memory.rebind`,
`memory.link`, `embedding.probe`, `embedding.identities`, `admin.obsidian`, `admin.migrate` (1 each).

Besides the contract, the core deep-imports seven private modules (`packages/core/src/engine-shim.d.ts` declares
them): `lib/reembedding/runtime-config.js` (`embeddingFingerprintFromNormalizedConfig`, `embeddingConfigFromSelection`),
`lib/reembedding/fingerprint.js` (`embeddingFingerprintId`), `lib/providers/config-normalize.js`
(`normalizeEmbeddingConfig`), `lib/snapshot/store-snapshot.js` (`createSnapshot`, `verifySnapshot`, `SnapshotError`),
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
- [`2026-10-20-memory-tree-relationships.md`](2026-10-20-memory-tree-relationships.md): WP1–WP3 define engine contract
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
| **1 — behaviour-neutral engine** (RE-0…RE-9) | `plur1bus-engine` serves contract 1.17.0 (1.16.0 subset at parity); the core selects it with `engine.implementation: "rust"` (`x-restart: "core"`, `x-tier: "advanced"`, default `"node"` until Phase 3) | RE-9 parity green; every `tests/system` suite green with `PLUR1BUS_ENGINE_IMPL=rust`; recall budgets met on reference hardware |
| **2 — memory-facing core paths move** (RE-10) | journal replay, restore re-apply, backup snapshot, re-embedding driver, media-search index hook, dream scheduler ledger and the `memory.curation.*` handlers run in the engine; the core keeps RBAC, policy, sessions, tools, channels; the three §1.6 behaviour changes land here (RE-D11…RE-D13, decided 2026-10-24, RE-10 T7–T9); RE-13 adds the harness surfaces for critical confirmations, skill proposals and the daily review (§1.7) | the moved paths' tests pass against the engine; `packages/core` loses the corresponding `node:sqlite` stores; every §1.6 golden a change touches is re-recorded with its decision id (RE-R1); the three RE-13 system tests green |
| **3 — retire the Node engine** (RE-11) | the exact-commit pin, `engine-shim.d.ts`, the `@huggingface/transformers` closure and `GH_ENGINE_READ_TOKEN` are gone; `docs/config-engine-keys.md` generates from the Rust crate's schema; ADR-018 | default `engine.implementation` flips to `"rust"`; one release with both, then removal |

A fourth phase — the rest of the TypeScript core (66,631 lines in 559 files: sessions, tools, MCP, channels, providers,
auth, policy, approvals, API) — is **not** in this plan. It is a programme of its own and is listed in §6 as RE-D9 so it
is decided, not drifted into.

### 2.4 Crate layout

```text
crates/plur1bus-engine/
  Cargo.toml                 lancedb = "=0.26.2" (lance =2.0.0, arrow ^57.2), rusqlite (bundled), ort, tokenizers, ureq, serde, serde_json
  schema/engine-contract.schema.json   the contract (RE-1); engine-config.schema.json moves here in Phase 3
  src/lib.rs                 pub use contract::*; the `Engine` trait and `open_engine(host, config) -> Result<Box<dyn Engine>, EngineError>`
  src/contract/              generated types (typify) + hand-written traits: engine.rs, host.rs, jobs.rs, memory_ops.rs, admin_ops.rs
  src/config/                EngineConfig validation (same schema as today), tiering of engine keys, defaults
  src/store/                 lance.rs (table `memories`, `_embedding_identity`), sqlite.rs (three caches), neo_files.rs, ledger.rs, lock.rs, schema_version.rs
  src/embedding/             identity.rs (VectorSpaceIdentity + identity_id), artifacts.rs (catalogue + licences), local_ort.rs, remote.rs, cache.rs, rerank/{local,cohere,remote,chained,signal}.rs
  src/recall/                pipeline.rs (12 stages), namespaces.rs (fan-out + merge), budget.rs, filter.rs (CandidateFilter), rerank.rs, knowledge.rs, graph.rs, temporal.rs, acl.rs, render.rs (six blocks), trace.rs
  src/capture/               pipeline.rs, chunking.rs, dedupe.rs, classify.rs, reconsolidate.rs, dynamics.rs, speaker.rs, epistemic.rs, valid_time.rs, journal.rs, checkpoint.rs
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

- [ ] Record the owner's answers to RE-D1–RE-D10 (§8) at the top of this plan.
- [ ] Add the crate with `lancedb = "=0.26.2"` (verify the exact version the engine's committed lockfile resolves for
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

- [ ] Write `engine-contract.schema.json` from `types/engine.d.ts` (1,285 lines): every interface, every union, every
      doc comment; `x-since: "1.16.0"` on today's members, `"1.17.0"` on the memory-tree additions (plan WP1).
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
`tests/fixtures/vectors/{sentences.json,e5-small.json,bge-reranker.json}` (50 sentences, vectors and scores recorded
from the Node engine with the real models).

**Interfaces (produced):** `EmbeddingProvider::{embed_query, embed_passage, embed_batch} -> Result<Vec<Vec<f32>>,
EmbedError>`; `Reranker::{rerank(query, docs, cancel) -> Result<Vec<Ranked>, RerankError>, empty_result_is_valid()}`;
`identity_id(&VectorSpaceIdentity) -> String` (byte-identical to the Node `identityId()`; test vector from the fixture
store); `ArtifactCatalogue::{resolve(model) -> Artifact { files: Vec<(path, sha256)>, licence: LicenceId }}` including
the `CC-BY-NC-4.0` entries the harness NC gate (`packages/core/src/licences`) must see.

- [ ] `identity_id` reproduces the fixture store's `_embedding_identity.identityId` — the first test of the package;
      everything else depends on identical identities (a different id would force `admin.reembed` on every store).
- [ ] Local provider: `ort` session over the **same** ONNX files (same sha256) the Node engine downloads; tokenizer via
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
`packages/core/src/backup-ops.ts`), `tombstones::reapply` (today `lib/tombstone-reapply.js`), `reembedding::{plan, run,
status, abort}` with `fingerprint_id(normalized) -> String` and `normalize_embedding_config(raw) -> Normalized` (the
private imports of §1.3 become `engine.embedding.fingerprint` and `engine.config.normalizeEmbedding`).

- [ ] Every `memory.*` CLI test in `crates/plur1bus/tests` and `tests/system/memory-ops.test.ts` passes against the
      Rust engine; `--json` shapes unchanged (ruling R13 — the raw RPC value is printed).
- [ ] `admin.backup.snapshot`, `backup verify|restore` and `restore-reapply` work against the engine's snapshot and
      tombstone methods; `tests/system/backup.test.ts` and `portable-backup.test.ts` pass.
- [ ] `tests/system/reembed.test.ts` passes; the fingerprint id of every configuration in `docs/embedding-migration.md`'s
      examples equals the Node value (vectors recorded).
- [ ] Contract 1.17.0: `memory.curation.*` served; the harness tests that wait for the pin (#604–#607, #609) run green.

### RE-8 — Process, RPC, supervisor slot, EngineClient (L)

**Files:** create `src/rpc/{server,host_client,seams}.rs`, `src/main.rs`; `packages/core/src/engine/{client,spawn,
select}.ts`; modify `packages/rpc-schema/schema/rpc.schema.json` (RPC schema 1.5.0: `x-server: "engine"`, methods
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

### RE-11 — Phase 3: retire the Node engine (M)

**Files:** modify `packages/core/package.json` (remove the pin), delete `packages/core/src/engine-shim.d.ts`, move the
`engine-config.ts` translation into `src/config/`, re-point `scripts/gen-engine-keys.mjs` at
`crates/plur1bus-engine/schema/engine-config.schema.json`, remove `GH_ENGINE_READ_TOKEN` from every workflow,
`docs/engine-extraction.md` (status note), create `docs/adr/ADR-018-rust-engine.md`, flip the default of
`engine.implementation`, update `docs/architecture.md`, `docs/milestones.md` (Track RE), `AGENTS.md` ("Where things
live" row for the crate).

- [ ] One release ships both implementations with `"rust"` as default; the next removes `"node"` and the pin.
- [ ] `pnpm test:prep` no longer needs a private package; `docs/ci.md` and AGENTS.md "Tests lokal" updated.
- [ ] The engine repository's `main` is archived or kept for the OpenClaw plugin line only (RE-D7).

### RE-12 — Forward-port CP-5 and CP-7 to the Node engine now (S, independent)

**Files:** in `Cyb3rb1ade/openclaw-plur1bus-memory` on `main`: `lib/recall-pipeline.js`, `lib/recall-budget.js`,
`lib/jobs/skill-miner*.js` and their tests; in the harness: `packages/core/package.json` (new exact commit),
`pnpm docs:gen` (`docs/config-engine-keys.md`).

- [ ] Cherry-pick 8d2ca911 (CP-5) and 6419a60e (CP-7) onto `main`, resolve against the host-neutral tree, run the
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

## 5. Pros and cons of the rewrite

### 5.1 For

| Gain | Why it is real here |
|---|---|
| One language for memory and harness | the owner's stated direction; the supervisor, CLI, installer, updater, log schema, config and RPC crates are Rust already — the engine is the last large Node component besides the core |
| Smaller, simpler distribution | the Node payload loses `@lancedb/lancedb`, `apache-arrow`, `openai` and the `@huggingface/transformers` closure; the engine ships as one binary per target like `plur1bus-attest`; the private-package pin and `GH_ENGINE_READ_TOKEN` disappear (Phase 3) |
| Predictable latency | no JIT warm-up for the 400/600 ms recall budgets; scoring, dedupe, graph spread and JSON handling run natively (LanceDB's search itself is Rust already in the Node SDK and does not get faster) |
| Types that cannot lie | `Degraded`, `JobTrigger`, `CheckpointReason`, the diagnostics union and every RPC param are closed types; `deny_unknown_fields` replaces `any` at the boundary |
| Defects fixed by construction | f.1 (dropped abort), f.4/f.5 (locks), f.6 (two timers), f.9 (`chmod` on Windows), f.11 (ACL logging default-off), f.14/f.15 (Windows routing and junctions) — host-contract (f) |
| Crash isolation and supervision | the engine is a supervised slot: health, backoff, adoption, `1staid` checks, Windows pipe ACLs — all existing machinery |
| Contract 1.17.0 once, natively | the memory tree (M3+) is implemented in the Rust engine instead of landing in Node first and being ported later |
| A permanent parity asset | RE-9's scenarios and goldens remain the engine's behavioural regression suite after the Node engine is gone |

### 5.2 Against

| Cost or risk | Mitigation (WP) |
|---|---|
| Size: 101,408 lines of JavaScript in the closure plus 615 test files; a multi-month programme | subsystem order with parity gates (RE-4 before RE-5 before RE-6); the deterministic core first, LLM-driven jobs behind a go/no-go (RE-D5) |
| LLM-driven paths are not reproducible | parity on recorded LLM fixtures only; prompts are versioned templates with golden hashes; the cache keys include the template version (RE-6) |
| Lance version lock-in: compatibility pins the crate to the Node package's Lance | the upgrade rule and round-trip test (RE-2); the store strategy after Phase 3 is an explicit decision (RE-D3) |
| Build time and binary size: Lance brings DataFusion and Arrow; `ort` brings ONNX Runtime | measured in RE-0; dev opt-levels per crate; `load-dynamic` or vendored binaries (RE-3); a separate binary keeps `plur1bus` itself small |
| Licence closure review: Lance/DataFusion dependencies likely exceed today's `deny.toml` list | the gate runs first (RE-0); every allow-list change is an owner decision in the PR |
| Release-candidate dependencies: `ort` 2.0.0-rc, `tokenizers` 1.0.0-rc | exact pins; parity vectors catch a behavioural change on bump |
| Windows ARM64: ONNX Runtime and Lance on `windows-11-arm` are experimental in CI today | the target keeps `continue-on-error` until its first green run, like the Hermes Windows leg |
| Two engines during the transition: every fix lands twice until Phase 3 | §3.10 triage keeps the list explicit; RE-12 keeps the Node engine correct now; Phase 1 is time-boxed by the parity gate |
| The OpenClaw plugin line keeps evolving in JavaScript; after the rewrite its deltas are re-implemented, not merged | that is already true since 2026-10-02; the triage template (§3.10) is the process |
| Scope creep into the TypeScript core | §2.3: the core rewrite is RE-D9, a separate decision |
| Opportunity cost: M3+ memory tree, M5+, Track F compete for the same people and agents | RE-D6: implement 1.17.0 in the Rust engine instead of twice; everything else keeps its place in `docs/milestones.md` |

### 5.3 Variants

- **A — full port** (RE-0…RE-11 as written): the owner's goal; the largest risk is RE-6's LLM-driven jobs.
- **B — staged (recommended)**: A, with a go/no-go after RE-9's first results on the deterministic core (RE-1…RE-5,
  RE-7, RE-8). Not a runtime hybrid — two engines never share a live store; until RE-6 is complete the Rust engine is
  opt-in and reports unported jobs as `not-implemented`.
- **C — no rewrite**: pin contract 1.17.0, forward-port CP-5/CP-7 (RE-12), keep the Node engine. Cheapest; keeps the
  private pin, the `transformers` closure, and the host-contract defects that need the adapter's shape to be fixed.

## 6. Open owner decisions

| Id | Question | Recommendation |
|---|---|---|
| RE-D1 | Integration: supervised process + RPC, or N-API in-process | process + RPC (§2.1); N-API only if RE-8's hop measurement fails |
| RE-D2 | Location: crate in this workspace, or a separate repository | this workspace (`deny.toml` allows git dependencies only from this repository; one CI, one release) |
| RE-D3 | Store strategy: keep LanceDB at the Node package's Lance version through Phase 2; after Phase 3 upgrade Lance with a migration, or move to SQLite + a vector index | keep and pin now; decide the Phase 3+ strategy on RE-2's numbers |
| RE-D3b | `ort` binaries: `load-dynamic` with a shipped runtime, or vendored `download-binaries` | `load-dynamic`; the payload already ships platform binaries per target |
| RE-D4 | Drop the embedding-owner IPC in favour of `engine.embedding.*` RPC | yes |
| RE-D5 | Jobs: full port in one go, or go/no-go after the deterministic core | go/no-go (variant B) |
| RE-D6 | Contract target: 1.17.0 from the start (merge or pin `codex/gp3-a1-curated-memory` as the spec) | 1.17.0; the harness side already expects it |
| RE-D7 | The engine repository after Phase 3: archive `main`, keep for the OpenClaw plugin line | keep for the plugin line; the harness no longer depends on it |
| RE-D8 | Forward-port CP-5/CP-7 to the Node engine now (RE-12) | yes, before anything else |
| RE-D9 | A later rewrite of the TypeScript core | separate decision and plan; not implied by this one |
| RE-D10 | The engine binary joins the container image and the desktop bundle | yes; `container.yml` paths and `apps/desktop` bundle scripts in RE-8 |
| RE-D11 | Recall score: keep `1/(1+d)` over the squared-L2 distance with the inert `minScore` 0.3, or move to the cosine similarity with thresholds calibrated per embedding profile (§1.6) | **Decided 2026-10-24: fix.** Kept in Phase 1; cosine score and calibrated thresholds in Phase 2 (RE-10 T7) with an A/B on a frozen corpus before the default flips; no re-embedding |
| RE-D12 | Retrieval: vector search only, or a hybrid pool (exact id and metadata, full-text index, vector) fused by reciprocal rank fusion (§1.6) | **Decided 2026-10-24: fix.** Kept in Phase 1; hybrid retrieval with rank fusion in Phase 2 (RE-10 T8); the same fusion covers two embedding identities in one store |
| RE-D13 | Job partitions: `workspace`/`user` partitions from the shared pools only, or the agent's own partition also reads the scoped rows of its own table (§1.6) | **Decided 2026-10-24: fix.** Kept in Phase 1; the agent partition reads its scoped rows in Phase 2 (RE-10 T9); no row moves on disk |
| RE-D14 | Advisories inside the pinned Lance closure: `tantivy 0.24.2` (non-optional under `lance-index 2.0.0`) pins `lru 0.12`, which carries RUSTSEC-2026-0002 and RUSTSEC-2026-0253 and blocks the `quality` advisory gate; an owner exception in the audit allow-list (renewed every 90 days), or a fork of tantivy at its tag 0.24.2 with only `lru 0.18.2` applied, consumed through `[patch.crates-io]` | **Decided 2026-10-24: fork.** `Cyb3rb1ade/tantivy`, branch `plur1bus/0.24.2-lru-0.18.2`, commit `038215a5` (one changed line in its `Cargo.toml`, `lru = "0.18.2"`, resolved to 0.18.5 in the harness lock), pinned by `rev` because the session proxy refuses tag pushes (the annotated tag `v0.24.2-plur1bus.1` exists in the local clone; once the owner pushes it the patch may name the tag instead); the root `Cargo.toml` patch and the `deny.toml` `[sources]` entry land with RE-00 (PR #759). The same rule applies to the next such advisory: a fork at the pinned tag with only the fix, never an exception. Exit: the patch goes when the Lance pin (RE-D3) moves to a tantivy with `lru >= 0.18.2` or to no tantivy at all |

## 7. Risks (beyond §5.2)

| Id | Risk | Signal | Response |
|---|---|---|---|
| RE-R1 | Parity drift: goldens edited to make a test pass | a golden changes without a CP or decision reference in the PR | review rule: a golden diff needs a §3.10 CP id or a decision id in the commit body |
| RE-R2 | Hop overhead on Windows named pipes exceeds the budget | RE-8 p99 > 5 ms | N-API fallback (§2.2) for Windows only, or request batching in `EngineClient` |
| RE-R3 | A Node SDK store written after a `@lancedb/lancedb` bump in the engine repository no longer opens in the pinned Rust crate | RE-2 round-trip fails on a pin bump | the harness pin stays until the Rust crate moves in step; the upgrade rule in `docs/engine-stores.md` |
| RE-R4 | Model artifact drift: a re-download yields different ONNX bytes | `ArtifactCatalogue` sha256 mismatch | refuse to load; `1staid check` `models.cache` reports it (existing id) |
| RE-R5 | The `host.*` reverse channel becomes a privilege path | a `host.*` call from a non-engine connection reaches a handler | the dispatch guard and its negative invocation tests in RE-8; the capability listing is a UX check, never the guard |
| RE-R6 | CI time: the Rust build of Lance + DataFusion pushes `unit` past its budget | RE-0 measurement (2026-10-24): `unit (ubuntu-24.04)` 20 min 45 s on `main` → 36 min 08 s on RE-00's first run with a cold cache for the Lance closure, inside the 65-minute job ceiling; its `cargo test --workspace` step took 16 min 26 s of a 20-minute step budget (7 min 54 s on `main`), `cargo clippy` 7 min 39 s (1 min 24 s on `main`); locally the debug closure builds in 9 min 44 s cold | RE-00 raises the `cargo test` step budget to 30 minutes (`docs/ci.md`); per-crate opt-levels (RE-00 measured them: no gain while no engine code runs in tests, so none were added), `rust-cache`, the engine crate's tests in their own job selected by the `changes` plan; re-measure after RE-02, the first code that links Lance |

## 8. Glossary

- **Jev** — the OpenClaw plugin's decision-model persona; in the harness, the decision role of `docs/decision-service.md`.
- **neo** — the working-memory layer of `lib/neo-arch.js` and the `neo` context block.
- **CP** — change package (§3); **RE** — a work package of this plan; **G-\*** — a golden vector recorded from the Node
  engine; **f.n** — a defect id of `docs/host-contract.md` (f).
