# Module map of the Node engine (`main` @ `98dfe2f`) → Rust briefs

Generated on 2026-10-23 from the import closure of `engine/create-engine.js` in `Cyb3rb1ade/openclaw-plur1bus-memory` at commit `98dfe2f` (the harness pin): every `.js` file the engine process can load, resolved through relative `import`/`require` specifiers. **This is the completeness check the briefs are measured against:** a brief is finished when every row it owns has a Rust module, a fold target or a recorded drop. The dispositions are the coordinator's proposal; an implementer who disagrees changes the row in the same pull request as the code and says why.

| Disposition | Meaning |
|---|---|
| `port` | behaviour the Rust engine must reproduce; parity goldens apply (RE-09) |
| `fold` | a Node utility that becomes a Rust idiom or an existing harness crate; the note names the target, and any constants or rules the file holds move with it |
| `decide` | owner decision pending (RE-07 T7b: Obsidian vault writers and policies) |
| `drop` | not ported: adapter surface, Node plumbing, or reachable only through adapter files |

Regenerate: walk the relative import closure from `engine/create-engine.js` (regex `from|import\(|require\(` + `'./…'`), count lines, mark files reachable without entering the adapter set (`engine/commands/`, `lib/telegram-commands/`, `lib/obsidian-control-room.js`, `lib/control-plane-*`, `lib/dashboard-*`, `engine/tools/memory-tools.js`, `lib/wiki-command.js`), and compare the file list against this table; a new file without a row fails the check. The plan's §1 counts (323 files / 101,408 lines) included `openclaw.plugin.json` and the adapter entry; this closure has 322 files / 100,593 lines.

## Totals by owner

| Owner | Files | Lines | port | fold | decide | drop |
|---|---:|---:|---:|---:|---:|---:|
| RE-01 | 13 | 5,707 | 11 | 2 | 0 | 0 |
| RE-02 | 29 | 10,318 | 22 | 7 | 0 | 0 |
| RE-03 | 22 | 5,165 | 21 | 1 | 0 | 0 |
| RE-04 | 40 | 15,541 | 39 | 1 | 0 | 0 |
| RE-05 | 45 | 15,854 | 42 | 3 | 0 | 0 |
| RE-06 | 32 | 8,452 | 31 | 1 | 0 | 0 |
| RE-07 | 47 | 14,171 | 32 | 0 | 15 | 0 |
| RE-08 | 10 | 1,598 | 0 | 10 | 0 | 0 |
| — | 84 | 23,787 | 0 | 0 | 0 | 84 |
| **all** | 322 | 100,593 | 198 | 25 | 15 | 84 |

## Files that exist only on the OpenClaw plugin line (`v7.18.31`)

Not in the `main` closure; the change packages of plan §3 carry them.

| File | Lines (v7.18.31) | Package | Owner |
|---|---:|---|---|
| `lib/afterthought-hooks.js`, `lib/afterthought-host.js`, `lib/afterthought-reflection.js` | 40 + 281 + 311 | CP-3 | RE-06 T4 |
| `lib/jev-recall-filter.js` | 87 | CP-4a | RE-04 T3 |
| `lib/model-catalog-reconcile.js` | 73 | CP-4b | RE-07 T4 (models) |
| `lib/recall-comparison.js` | 69 | CP-4c | RE-09 (reporter) |
| `lib/jobs/skill-miner/candidate-matching.js` | 151 | CP-7 | RE-06 T5 |

## Rows

Columns: owner brief · disposition · named in (briefs that cite the file today; `plan` = the plan document) · purpose (first line of the file's header comment, verbatim) · note.


### RE-01

| File | Lines | Disposition | Named in | Purpose | Note |
|---|---:|---|---|---|---|
| `lib/abort.js` | 141 | fold | — | Throw when an operation's cancellation signal has been aborted. | `Cancel` |
| `lib/with-timeout.js` | 54 | fold | — | Race a promise against a timeout. | `Cancel` deadlines |
| `engine/create-engine.js` | 3991 | port | RE-01, RE-05, plan | the one construction path (spec 3.1, owner decision A). |  |
| `lib/setup/feature-profiles.js` | 607 | port | — | explicit PLUR1BUS feature profiles. | `setupProfile` → feature flags, read by recall and create-engine (RE-01 T3 config) |
| `lib/setup/config-contract.js` | 324 | port | — | profile config contract (key lists per setup profile; no header comment) | profile config contract: which keys a setup profile sets (RE-01 T3) |
| `engine/runtime/env-config.js` | 158 | port | — | environment-variable and config resolution, summaries and small command helpers. |  |
| `engine/lifecycle/close-resources.js` | 129 | port | — | the engine's close path (spec 3.1). |  |
| `lib/input-limits.js` | 91 | port | — | Centralized input validation with clear error messages. | limits are contract constants (RE-01) |
| `engine/config/live-config.js` | 68 | port | — | the engine's one host-neutral re-read of its |  |
| `engine/runtime/debug-log.js` | 66 | port | — | the module-level debug logger (`dbg`), the purge throttle and the speaker-proposal pipeline. |  |
| `engine/runtime/constants.js` | 32 | port | — | module-level constants shared by the recall, capture and command paths. |  |
| `engine/events.js` | 24 | port | — | The single path engine code uses to tell the host something happened |  |
| `engine/internals.js` | 22 | port | plan | the adapter's transitional window into EngineInternals. |  |

### RE-02

| File | Lines | Disposition | Named in | Purpose | Note |
|---|---:|---|---|---|---|
| `lib/verified-path-directory.js` | 397 | fold | — | verified-path directories (ADR 0001, | trusted paths: the rules of module-api `securePath` |
| `lib/atomic-file.js` | 224 | fold | — | shared atomic JSON/text file IO helpers. | one `atomic_write` (unique tmp, fsync, rename, dir fsync) |
| `lib/directory-capability.js` | 195 | fold | — | closeSync, | directory probe at store open |
| `lib/bounded-cache.js` | 134 | fold | — | refCount-aware bounded cache with soft limit. | bounded cache in the store layer |
| `lib/jsonl-utils.js` | 114 | fold | — | zentrale JSONL-Lesehilfe. | `JsonlLedger<T>` |
| `lib/fsync-atomic.js` | 65 | fold | — | unique tmp + fsync + rename + directory fsync. | `atomic_write` |
| `lib/atomic-json.js` | 52 | fold | — | Atomic read-modify-write for JSON files with | `atomic_write` + `StateFile<T>` |
| `engine/store/memory-db.js` | 1639 | port | RE-02, plan | the per-agent LanceDB store (`MemoryDB`) and the epistemic-status / valid-time write helpers. |  |
| `lib/db-adapter.js` | 1503 | port | RE-02 | dünner Wrapper um LanceDB für Telegram-Commands. |  |
| `lib/embedding-cache.js` | 925 | port | RE-02, RE-03, plan | v2 embedding cache: in-memory LRU+TTL plus optional persistent SQLite backend, |  |
| `lib/llm-result-cache.js` | 690 | port | RE-02, RE-06, plan | Exact, purpose-allowlisted LLM result cache with absolute TTL and LRU |  |
| `lib/tombstone.js` | 595 | port | RE-02, RE-05, RE-07 | kanonischer Tombstone-Vertrag für PLUR1BUS. |  |
| `lib/multi-namespace-pool.js` | 576 | port | RE-02, RE-04 | "mode", |  |
| `lib/registry-lock.js` | 496 | port | — | synchroner, prozessübergreifender Lock für die | the one cross-process lock behind tombstone, neo-arch, import-lock, rebind-ledger, knowledge-pending and job-lock → one `Lock` type (RE-02 T6) |
| `engine/store/agent-db-pool.js` | 493 | port | RE-02 | the per-agent `MemoryDB` pool (`AgentDbPool`). |  |
| `lib/filter-parser.js` | 305 | port | — | Parses intuitive filter expressions from /memory command input | list filter grammar used by `db-adapter.js` → `RowFilter` parser (RE-02 T2) |
| `lib/speaker-mapping-store.js` | 295 | port | RE-02, RE-05, plan | PLUR1BUS bridge to OpenClaw's diarization SQLite DB for speaker mappings. |  |
| `engine/store/fragment-compactor.js` | 247 | port | — | bounded LanceDB fragment compaction |  |
| `lib/epistemic-status.js` | 226 | port | RE-02, RE-05 | Explicit Trust State (Phase 1). |  |
| `lib/valid-time.js` | 210 | port | RE-02, RE-05 | Bi-Temporal Memory (Phase 2). |  |
| `lib/sql-safety.js` | 205 | port | — | Defense-in-depth Helpers für LanceDB-SQL-Strings. | LanceDB filter quoting → `RowFilter` rendering (RE-02 T2) |
| `lib/namespace-config.js` | 185 | port | — | "activeWriteNamespace", |  |
| `engine/store/schema-version.js` | 147 | port | RE-02, plan | store schema version marker and migrator |  |
| `engine/store/control-health.js` | 107 | port | — | control-plane health constants and the partition/row inspectors. |  |
| `engine/store/lancedb-loader.js` | 78 | port | — | lazy loaders for the LanceDB and OpenAI packages (direct import, plugin node_modules, legacy stock path). |  |
| `lib/job-lock.js` | 76 | port | RE-02, RE-06 | prozessübergreifender Try-once-Lock für Cron-Jobs und |  |
| `lib/lancedb-optimize.js` | 65 | port | — | optimize.js (7.12.31) |  |
| `lib/tombstone-write-guard.js` | 58 | port | — | shared pre-write tombstone check. |  |
| `lib/score.js` | 16 | port | — | Distance→Score-Konvertierung für LanceDB-Vektorsuche. |  |

### RE-03

| File | Lines | Disposition | Named in | Purpose | Note |
|---|---:|---|---|---|---|
| `lib/host-network.js` | 203 | fold | — | the engine's outbound-HTTP and secret ports | `transport::guarded` + `SecretPort` (keep its address rules) |
| `lib/providers/embedding-local-transformers.js` | 894 | port | RE-03 | EMBEDDINGGEMMA2_EMBEDDING_PROFILE, |  |
| `lib/providers/local-model-artifacts.js` | 629 | port | RE-03 | path, |  |
| `lib/providers/reranker-remote.js` | 363 | port | RE-03 | configurable remote (HTTP) reranker. |  |
| `lib/providers/reranker-local-transformers.js` | 355 | port | RE-03 | BGE_RERANKER_PROFILE, |  |
| `engine/providers/embedding-service.js` | 328 | port | RE-03 | EmbeddingService.probe() (E3 Task 3) |  |
| `lib/providers/embedding-openai.js` | 306 | port | RE-03 | SECRET_PURPOSES, |  |
| `lib/providers/local-transformers-shared-pool.js` | 294 | port | RE-03 | "@cyb3rb1ade/plur1bus-memory/shared-local-transformers-model-pool", |  |
| `lib/providers/config-normalize.js` | 256 | port | RE-03, RE-07, plan | DEFAULT_COHERE_RERANK_MODEL, |  |
| `lib/providers/legacy-provider-migration.js` | 233 | port | — | DEFAULT_LOCAL_EMBEDDINGGEMMA2_DIMENSIONS, |  |
| `lib/providers/dimensions.js` | 190 | port | RE-03 | Pinned optional multilingual local embedding model. */ |  |
| `lib/reembedding/runtime-config.js` | 181 | port | RE-03, RE-07, plan | if (!value \|\| typeof value !== "object" \|\| Array.isArray(value)) throw new Error("invalid embedding Secret |  |
| `lib/reembedding/fingerprint.js` | 157 | port | RE-03, RE-07, plan | "provider", |  |
| `engine/providers/model-readiness.js` | 148 | port | RE-03 | reranker readiness probe, pure |  |
| `lib/provider-error.js` | 135 | port | — | Content-free errors for provider HTTP failures (N2 leak audit I-6). A |  |
| `lib/providers/env.js` | 117 | port | RE-03 | COHERE_API_KEY: () => process.env.COHERE_API_KEY, |  |
| `lib/providers/embedding-identity.js` | 106 | port | RE-03 | Canonical vector-space identity; credentials and transport are excluded. */ |  |
| `lib/providers/secret-input.js` | 97 | port | RE-03 | "COHERE_API_KEY", |  |
| `engine/providers/runtime-reranker.js` | 76 | port | — | the runtime reranker provider factory. |  |
| `lib/providers/reranker-chained.js` | 60 | port | RE-03 | Chained Reranker mit Fallback. |  |
| `lib/providers/rerank-signal.js` | 20 | port | RE-03 | the single owner of a rerank timeout (PR-09). |  |
| `lib/providers/reranker-cohere.js` | 17 | port | RE-03 | the Cohere preset of the remote reranker. |  |

### RE-04

| File | Lines | Disposition | Named in | Purpose | Note |
|---|---:|---|---|---|---|
| `lib/recall-phase-timer.js` | 137 | fold | — | lightweight per-recall phase timer. | `timing.*` in T6 |
| `lib/recall-pipeline.js` | 2225 | port | RE-04, RE-12, plan | komplette Recall-Pipeline als orchestrator. |  |
| `lib/i18n-dictionary.js` | 2218 | port | — | PLUR1BUS translations. | port only the strings the engine renders (block labels, hedging, deferral notes, job texts); adapter UI strings stay; de/en completeness checked the way `scripts/check-i18n.mjs` does |
| `lib/memory-request-context.js` | 1482 | port | RE-04, plan | Canonical, immutable identity context for every memory data boundary. |  |
| `engine/recall/assemble-prompt-context.js` | 1338 | port | RE-04 | The per-turn recall assembly (was index.js:12261-13327): identity, Neo |  |
| `lib/memory-graph.js` | 1078 | port | RE-04 | Graph-Engine für assoziative Memory-Verknüpfung. |  |
| `lib/conversation-reactivation-recall.js` | 962 | port | RE-04 | Conversation Reactivation Recall (CRR) — additive post-recall hook. |  |
| `lib/emotional-state.js` | 607 | port | RE-04, RE-05 | Emotional State Tracker für PLUR1BUS. |  |
| `lib/recall-decision-trace.js` | 548 | port | RE-04 | Recall Decision Trace helpers. |  |
| `lib/relevant-memory-context.js` | 504 | port | — | Formats the <relevant-memories> prompt block injected before each agent turn. |  |
| `lib/interpretation-overlay.js` | 414 | port | — | Interpretation overlays (append-only, idempotent). |  |
| `lib/temporal-provenance.js` | 323 | port | RE-04, RE-05 | P5 Temporal Provenance + Operational Action Guard. |  |
| `engine/recall/namespace-recall.js` | 285 | port | RE-04 | the merged multi-namespace recall and its budget helpers. |  |
| `engine/knowledge/knowledge-pending.js` | 281 | port | RE-04 | the KNOWLEDGE.md pending-queue, lock and update helpers, and the curation log they append to. |  |
| `lib/semantic-lens-index.js` | 245 | port | RE-04 | Opt-out like every other PLUR1BUS feature. |  |
| `lib/inject-budget.js` | 244 | port | — | aggregate char cap across prepend blocks. |  |
| `lib/acl-middleware.js` | 240 | port | RE-04 | Differentiated ACL for PLUR1BUS Memory System (v6). |  |
| `lib/pattern-surface.js` | 187 | port | — | Pattern surfacing with normalized overlap scoring. |  |
| `lib/temporal-parser.js` | 184 | port | RE-04 | Extrahiert Zeit-Anchor aus natürlichsprachigen Queries. |  |
| `lib/text-utils.js` | 184 | port | — | pure Text-Helpers (Tokenisierung, Similarity, Summary). | tokenisation, similarity and summary helpers — parity-relevant, shared by recall and capture |
| `lib/i18n.js` | 181 | port | — | Global i18n + SOUL.MD tone for PLUR1BUS. | the lookup and tone helpers behind the engine-rendered strings; see `lib/i18n-dictionary.js` |
| `lib/query-refiner.js` | 170 | port | — | Query-Verfeinerung für Recall-Pipeline. |  |
| `engine/recall/warm-recall-path.js` | 169 | port | RE-04 | the warm-only recall (E5 Task 9). |  |
| `lib/temporal-context.js` | 163 | port | RE-04 | Temporal continuity context for prompts. |  |
| `lib/recall-budget.js` | 152 | port | RE-04, RE-12, plan | Pure functions for adaptive recall budget resolution and memory tier allocation. |  |
| `engine/identity/principal.js` | 137 | port | — | PR-06 (spec 3.4). | the canonical principal hash (RE-04 T1); the plan cites `memory-request-context.js:332`, which uses it |
| `lib/mood-style-directive.js` | 131 | port | RE-04 | Mood-Stil-Direktive statt Label. |  |
| `engine/recall/recall-params.js` | 114 | port | RE-04 | the automatic recall's pipeline parameters. |  |
| `lib/temporal-filter.js` | 92 | port | RE-04 | Filtert Memory-Results nach temporalem Range |  |
| `lib/graph-index.js` | 78 | port | RE-04 | In-memory Index für Memory-Graph-Edges. |  |
| `lib/memory-text-contradiction.js` | 69 | port | RE-04 | Pure helpers for resolving contradictions between factual memory texts. |  |
| `engine/recall/neo-prelude.js` | 68 | port | RE-04 | the read half of the recall's neo prelude. |  |
| `lib/recall-confidence-framing.js` | 65 | port | — | Unsicherheits-Hedging nach Recall-Score. |  |
| `lib/contradiction-disclosure.js` | 58 | port | RE-04 | formatContradictionDisclosure(pairs, opts) -> string \| null |  |
| `lib/frontmatter.js` | 55 | port | — | YAML-Frontmatter Parser/Builder für KNOWLEDGE.md. |  |
| `engine/recall/recall-result.js` | 54 | port | RE-04 | Value helpers for the recall contract (types/engine.d.ts, target 1.4.1): |  |
| `engine/recall/system-supplement.js` | 30 | port | RE-04, RE-07 | The static system-prompt supplement (was index.js:7082-7087): the recall |  |
| `lib/memory-context-sanitize.js` | 26 | port | — | Sanitizers for memory context attributes and prompt text. |  |
| `lib/importance-status.js` | 23 | port | — | Wartezustaende der Importance-Klaerung. |  |
| `lib/prompt-memory-fields.js` | 20 | port | — | render-time status/epistemic/age labels. |  |

### RE-05

| File | Lines | Disposition | Named in | Purpose | Note |
|---|---:|---|---|---|---|
| `lib/neo-worker-runtime.js` | 338 | fold | — | if (error instanceof Error) return error; | a Rust task instead of a worker thread |
| `lib/bounded-operation-queue.js` | 78 | fold | — | depth-bounded queue that sheds oldest | post-turn queue depth bound |
| `lib/runtime-pressure-gate.js` | 68 | fold | — | runtime memory pressure classification. | port the thresholds into turn admission |
| `lib/neo-arch.js` | 3687 | port | RE-02, RE-05, plan | "project_fact", |  |
| `engine/capture/capture-turn.js` | 1271 | port | RE-05 | The per-turn auto-capture pipeline (was index.js:10357-11305): fail-closed |  |
| `lib/episodes.js` | 925 | port | RE-05, RE-06 | Episoden-Engine für PLUR1BUS. |  |
| `lib/runtime-scheduler.js` | 687 | port | — | recallTimeoutMs: 45_000, | turn admission: background/internal turn detection, priorities, pressure skip (RE-05 T1, RE-04 T1) |
| `lib/memory-fact-quality.js` | 523 | port | — | deterministic, testable fact-quality classifier. |  |
| `lib/memory-dynamics.js` | 517 | port | RE-05 | Phase 7 - Memory Dynamics: pure helpers for strength decay, reinforcement, |  |
| `lib/safe-update.js` | 510 | port | RE-05 | Phase 8A — Safe Reconsolidation: Non-destructive memory updates with versioning. |  |
| `lib/shared-memory-pool.js` | 446 | port | RE-05, RE-07 |  |  |
| `lib/critical-review.js` | 445 | port | RE-05 | UX-Vertrag, Datenschutz und Kurzreferenzen für |  |
| `lib/contradiction-detector.js` | 436 | port | RE-05 | return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback; |  |
| `lib/tier1-lexicon.js` | 410 | port | — | Tier-1 lexicon-based emotion classifier. |  |
| `lib/shared-memory.js` | 386 | port | RE-05, RE-07 | Kollaboratives Memory (verkleinert) |  |
| `lib/memory-chunking.js` | 346 | port | RE-05 | entscheidet, ob eine Erinnerung als ein Vektor |  |
| `lib/emotion-engine.js` | 340 | port | RE-05 | Core emotion analysis engine. |  |
| `lib/continuity-gate.js` | 322 | port | RE-05 | Taste gate that prevents PLUR1BUS from surfacing spontaneous memory associations |  |
| `lib/speaker-segment-schema.js` | 313 | port | — | Canonical speaker-segment schema shared between PLUR1BUS and OpenClaw. | canonical speaker-segment schema shared with OpenClaw → also a contract type (RE-01) |
| `lib/emotion.js` | 283 | port | RE-05 | Emotions-Inferenz für PLUR1BUS Memories. |  |
| `engine/capture/turn-replay-guard.js` | 274 | port | RE-05 | Q3 (E4 Task 5): a replayed turn never |  |
| `lib/memory-merge-safety.js` | 274 | port | RE-05 | "node", "nodejs", "node.js", "react", "vue", "angular", "svelte", |  |
| `engine/capture/post-turn-work.js` | 241 | port | RE-05 | Light-Traum and episode extraction |  |
| `lib/tier2-transformer.js` | 224 | port | — | Tier-2 transformer-based emotion classifier. |  |
| `lib/emotion-score.js` | 223 | port | RE-05 | Universal emotion representation for PLUR1BUS. |  |
| `lib/emotion-blends.js` | 221 | port | RE-05 | Emotional blend detection for PLUR1BUS. |  |
| `lib/categorize.js` | 195 | port | — | Kategorie-Taxonomie + Auto-Kategorisierung. |  |
| `lib/workspace-policy.js` | 194 | port | RE-05, RE-07 | Durable, canonical per-agent/per-workspace PLUR1BUS enablement policy. */ |  |
| `lib/tier3-llm.js` | 185 | port | — | Tier-3 LLM-based emotion classifier. |  |
| `lib/reminder-store.js` | 171 | port | RE-05 | CRUD für Reminders als vollwertige LanceDB-Memories. |  |
| `lib/post-turn-queue.js` | 169 | port | — | post-turn LLM work, queued for the |  |
| `lib/epistemic-cutoff.js` | 145 | port | — | restore-safe cutoff for explicit epistemic writes. |  |
| `lib/deferred-dynamics-queue.js` | 143 | port | RE-05 | queue.js (7.12.30) |  |
| `lib/workspace-policy-guard.js` | 114 | port | RE-05, RE-07 | Common policy boundary for PLUR1BUS workspace operations. */ |  |
| `lib/reminder-extraction.js` | 102 | port | RE-05 | Gate-Logik für die Reminder-Extraktion aus Auto-Capture-Items. |  |
| `lib/reminder-parser.js` | 101 | port | RE-05 | Parst zeitliche Aussagen aus DE/EN-Text zu remindAt (epoch ms). |  |
| `lib/jev-chunk-decider.js` | 99 | port | RE-05 | decides per captured message whether splitting |  |
| `lib/speaker-proposer.js` | 87 | port | — | Contextual speaker-name proposer for D4. |  |
| `lib/episode-watermark.js` | 85 | port | RE-05 | Entscheidungslogik für das agent_end-Watermark. |  |
| `lib/reminder-pending.js` | 73 | port | RE-05 | Atomische Pending-Queue für Reminders pro Workspace+Agent. |  |
| `engine/checkpoint/checkpoint-store.js` | 56 | port | — | PR-15. |  |
| `lib/retroactive-interference.js` | 45 | port | — | Weakens older similar non-core memories after a new memory is stored. |  |
| `lib/reminder-nudge.js` | 39 | port | — | Formats due reminders into a prependContext nudge string. |  |
| `lib/epistemic-capture.js` | 36 | port | — | decide observed vs untrusted for new writes. |  |
| `lib/post-turn-detach.js` | 27 | port | — | Post-turn work (capture, episodes, insights, light dream) is enqueued from |  |

### RE-06

| File | Lines | Disposition | Named in | Purpose | Note |
|---|---:|---|---|---|---|
| `lib/llm-call.js` | 105 | fold | — | if (!Number.isFinite(parsed) \|\| parsed <= 0) return DEFAULT_LLM_TIMEOUT_MS; | `LlmPort` call wrapper, 30 s default timeout |
| `lib/dreaming/rem-dream.js` | 1534 | port | RE-06 | REM Dream Engine. |  |
| `lib/persona-voice.js` | 698 | port | RE-04, RE-06 | Idiolekt pro Agent: Seed + Datei + Direktive. |  |
| `engine/jobs/job-registry.js` | 635 | port | RE-06 | PR-07/PR-08 (spec 3.3). |  |
| `lib/dreaming/light-dream.js` | 635 | port | RE-06 | Nach-Session-Reflexion (Light Dreaming). |  |
| `lib/llm-router.js` | 517 | port | RE-06, plan | Immutable route kinds returned by the feature LLM resolver. */ |  |
| `lib/meta-cognition.js` | 380 | port | RE-06 | Meta-Kognition / Selbst-Reflexion (Feature 7). |  |
| `lib/reply-outcome-tracking.js` | 362 | port | — | automatic reply-based outcome signals. | feedback signals; CP-3b internal outcomes (RE-06 T4) |
| `lib/dreaming/dream-narrative.js` | 339 | port | RE-06 | Menschenähnliche Traum-Narrative. |  |
| `lib/proactive-governor.js` | 312 | port | RE-06 | adaptiver Frequenzregler für proaktive |  |
| `lib/overlay-generator.js` | 296 | port | — | Defensive overlay generator. Decides whether a recalled memory deserves an |  |
| `lib/feedback-log.js` | 264 | port | RE-06 | Feedback-Log für kontinuierliches Lernen (Phase 1b). |  |
| `lib/featureModels.js` | 248 | port | RE-06 | LLM tasks, their dashboard cards, and existing feature-local fallback config. */ |  |
| `lib/dreaming/dream-diary.js` | 206 | port | RE-06 | Dream diary bridge. |  |
| `lib/feature-cron-specs.js` | 205 | port | — | host-neutral feature-cron job specs. | the 12 default schedules → `JobSpec.default_schedule` (RE-06 T1) |
| `lib/dreaming/dreaming-status-provider.js` | 175 | port | RE-06 | Meldet OpenClaws Gedaechtnisseite, wie PLUR1BUS tatsaechlich traeumt. |  |
| `lib/local-model-generation.js` | 155 | port | RE-06 | local-model ownership across OpenClaw |  |
| `engine/jobs/job-ledger.js` | 122 | port | — | the append-only run ledger (PR-08, spec 3.3). |  |
| `lib/jobs/reflection-job.js` | 122 | port | RE-06 | Hintergrund-Job für Meta-Reflexion. |  |
| `lib/llm-failure.js` | 120 | port | — | Stable failure reasons safe for logs, results, and persisted records. */ | stable failure reasons, logged and persisted → parity |
| `lib/jobs/skill-miner/proposal-writer.js` | 115 | port | — | Read/write skill-proposals.jsonl, deduplicate by skillName, track rejections. |  |
| `lib/open-threads.js` | 115 | port | — | Pure helpers for open-thread detection. |  |
| `lib/dream-echo.js` | 113 | port | — | Traum-Echos: macht nächtliches Dreaming sichtbar. |  |
| `lib/time-window.js` | 111 | port | — | Timezone-bewusste Stunden- und Ruhezeiten-Helfer. |  |
| `lib/reaction-directive.js` | 106 | port | — | Reaktions-Neigung (Humanization F6). |  |
| `engine/runtime/llm-calls.js` | 96 | port | RE-06 | the feature LLM call wrappers (`callLlm`, deterministic context, merge check). |  |
| `lib/session-time.js` | 88 | port | — | Persistent session time tracking in run-state.json. |  |
| `engine/runtime/semantic-discovery.js` | 85 | port | RE-06 | semantic-link discovery batching and its per-run statistics. |  |
| `engine/jobs/job-specs.js` | 58 | port | — | the 19 engine-owned jobs (spec 3.3, contract JobName). |  |
| `lib/setup/skill-workshop-dashboard.js` | 55 | port | — | 7.12.48: Sammelt die geminten Skills aller Agenten fuer den PLUR1BUS-Reiter. | skill-miner summary across agents; verify its reachability path before porting |
| `lib/memory-maintenance-gate.js` | 50 | port | — | Create the fail-closed gate used for an atomic writer-generation switch. */ |  |
| `lib/jobs/skill-miner/nudge-renderer.js` | 30 | port | — | Render a skill-proposal reminder nudge in the user's language and |  |

### RE-07

| File | Lines | Disposition | Named in | Purpose | Note |
|---|---:|---|---|---|---|
| `lib/obsidian-bridge.js` | 2359 | decide | — | PLUR1BUS <-> Obsidian bridge. | T7b vault writers and policies, owner-gated |
| `lib/obsidian/semantic-link-discoverer.js` | 987 | decide | RE-06 |  | RE-06 `discover-semantic-links` body writes vault link suggestions (T7b gate) |
| `lib/obsidian-mutation-policy.js` | 396 | decide | — | Parse Obsidian commands once and carry one immutable, fail-closed write policy | T7b vault writers and policies, owner-gated |
| `lib/obsidian/memory-note-writer.js` | 345 | decide | — | memory-note-writer: Write vault mirror notes for LanceDB memory records. | T7b vault writers and policies, owner-gated |
| `lib/obsidian/graph-link-writer.js` | 340 | decide | — | graph-link-writer: Wikilink injection for record notes | T7b vault writers and policies, owner-gated |
| `lib/obsidian/safe-paths.js` | 174 | decide | — | if (text === "~") return homedir(); | T7b vault writers and policies, owner-gated |
| `lib/obsidian-vault-confirmation-flow.js` | 151 | decide | — | One-time identity- and vault-bound confirmation for protected vault receipts. */ | T7a `admin.obsidian.confirm` uses it; the vault writes behind it are T7b |
| `lib/obsidian-vault-authority.js` | 136 | decide | — | Protected, owner-partitioned vault confirmation receipts. */ | T7b vault writers and policies, owner-gated |
| `lib/obsidian/record-index.js` | 126 | decide | RE-02 | "sources", | T7b vault writers and policies, owner-gated |
| `lib/obsidian/dashboard-generator.js` | 104 | decide | — | ["index.md", "source", "PLUR1BUS Living Dashboard", "sources"], | T7b vault writers and policies, owner-gated |
| `lib/obsidian/record-schema.js` | 97 | decide | — | "memory_candidate": "memory-candidates", | T7b vault writers and policies, owner-gated |
| `lib/obsidian/frontmatter.js` | 67 | decide | — | if (value === null \|\| value === undefined) return ""; | T7b vault writers and policies, owner-gated |
| `lib/obsidian/managed-blocks.js` | 50 | decide | — | return createHash("sha256").update(String(value \|\| ""), "utf8").digest("hex"); | T7b vault writers and policies, owner-gated |
| `lib/obsidian/link-index.js` | 48 | decide | — | return "sha256:" + createHash("sha256").update(raw, "utf8").digest("hex"); | T7b vault writers and policies, owner-gated |
| `lib/obsidian/dataview-generator.js` | 13 | decide | — | if (where) filters.push(where); | T7b vault writers and policies, owner-gated |
| `engine/stores/adopt.js` | 635 | port | RE-02, RE-07 | `Engine.stores.adopt` (contract 1.11.0). |  |
| `engine/memory-ops/unimport.js` | 621 | port | RE-07 | `MemoryOps.unimport` (contract 1.13.0). |  |
| `engine/memory-ops/import.js` | 603 | port | RE-07 | `MemoryOps.import` (contract 1.11.0). |  |
| `lib/reembedding/lance-backend.js` | 559 | port | RE-07 | existsSync, |  |
| `engine/memory-ops/rebind-ledger.js` | 475 | port | RE-07 | sidecar JSONL for `memory.rebind` |  |
| `engine/memory-ops/proposals.js` | 418 | port | RE-07 | E2 Tasks 5 and 6 (spec decision D31): |  |
| `lib/model-preparation/coordinator.js` | 393 | port | RE-07 | ensurePinnedModelArtifacts, |  |
| `lib/reembedding/coordinator.js` | 364 | port | RE-07 | verifyMigrationConfirmation, |  |
| `engine/memory-ops/rebind.js` | 352 | port | RE-07 | `MemoryOps.rebind` / `unbind` (contract 1.12.0). |  |
| `lib/reembedding/state-store.js` | 331 | port | RE-07 | closeSync, |  |
| `engine/memory-ops/read.js` | 329 | port | RE-07 | E1 Task 4: typed MemoryOps `list` and `show`. |  |
| `engine/memory-ops/write.js` | 302 | port | RE-07 | E1 Task 5: typed MemoryOps `forget` and `correct`. |  |
| `engine/admin/obsidian.js` | 301 | port | RE-07 | E2 Task 7: AdminOps.obsidian, explicit paths, no host runtime. |  |
| `lib/health-watch.js` | 274 | port | — | Health watch: two signal sources the Memory Health scan cannot see. | two signal sources the health scan cannot see → `engine.status` (RE-07 T4) |
| `engine/memory-ops/proposal-store.js` | 243 | port | RE-07 | E2 Task 5 (spec decision D31): the |  |
| `engine/memory-ops/link.js` | 237 | port | RE-07 | `MemoryOps.link` (contract 1.16.0). |  |
| `lib/reembedding/switch-runtime.js` | 230 | port | RE-07 | return Object.freeze({ |  |
| `engine/memory-ops/import-ledger.js` | 226 | port | RE-07 | sidecar JSONL for `memory.import` |  |
| `engine/memory-ops/shared.js` | 220 | port | RE-07 | E2 Task 4 (spec decision D31): shared copies. |  |
| `engine/memory-ops/import-lock.js` | 213 | port | RE-07 | per-agent writer lock for the apply path |  |
| `engine/memory-ops/link-ledger.js` | 201 | port | RE-07 | sidecar JSONL for `memory.link` |  |
| `engine/memory-ops/unimport-ledger.js` | 198 | port | RE-07 | write-ahead audit sidecar for |  |
| `lib/reembedding/planner.js` | 197 | port | RE-07 | compareEmbeddingFingerprints, |  |
| `lib/model-preparation/state-store.js` | 178 | port | RE-07 | closeSync, |  |
| `engine/status/status-reporter.js` | 168 | port | RE-07 | assembles `EngineStatus` (types/engine.d.ts, |  |
| `lib/reembedding/runtime-probe.js` | 121 | port | RE-07 | if ( |  |
| `engine/memory-ops/context.js` | 85 | port | — | Binds MemoryOps calls to the host: Principal → memory request context, plus the fail-closed guards. |  |
| `lib/reembedding/generation-layout.js` | 85 | port | RE-07 | if (typeof value !== "string" \|\| !GENERATION_RE.test(value)) throw new Error("invalid active embedding gener |  |
| `lib/reembedding/confirmation.js` | 75 | port | RE-07 | return createHash("sha256") |  |
| `engine/memory-ops/import-digest.js` | 68 | port | — | per-group row digests recorded on |  |
| `engine/memory-ops/import-id.js` | 49 | port | — | deterministic card ids for `memory.import` |  |
| `engine/memory-ops/errors.js` | 27 | port | — | "not-found", "denied", "invalid-input", "approval-required", |  |

### RE-08

| File | Lines | Disposition | Named in | Purpose | Note |
|---|---:|---|---|---|---|
| `lib/platform.js` | 453 | fold | — | the four platform decisions, in one place. | `platform.rs`: the four platform decisions as a table |
| `lib/safe-logging.js` | 421 | fold | — | Safe error logging helpers. | engine logs through `plur1bus-log-schema`; carry missing redaction patterns into `packages/log-schema` |
| `lib/log-redact.js` | 216 | fold | — | Content-free descriptors for log lines. Logs may carry ids, lengths, counts | redaction patterns → `packages/log-schema/schema/redaction.json` |
| `lib/windows-acl-parse.js` | 119 | fold | — | Strict, locale-independent parsers for the Windows ACL fast path. | `plur1bus-rpc` `acl.rs` |
| `lib/metrics-debounce.js` | 88 | fold | — | In-memory accumulator + debounced flush for metrics writes. | `engine.status` counters |
| `lib/metrics.js` | 83 | fold | — | Lightweight metrics accumulator for /zustand and Doctor. | `engine.status` counters |
| `lib/peercred.js` | 68 | fold | — | optional Linux SO_PEERCRED (uid of the socket peer). | `plur1bus-rpc` peer credentials |
| `lib/event-loop-lag-snapshot.js` | 63 | fold | — | cheap event-loop lag snapshot. | not applicable (no event loop); report scheduler lag instead |
| `lib/private-fs.js` | 57 | fold | — | Owner-only file and directory modes for sidecar files that hold message text | `plur1bus-rpc`/supervisor file modes |
| `lib/process-singleton.js` | 30 | fold | — | singleton.js (7.12.36) | supervisor lock identity |

### Dropped (no owner)

| File | Lines | Disposition | Named in | Purpose | Note |
|---|---:|---|---|---|---|
| `lib/obsidian-control-room.js` | 4006 | drop | — | PLUR1BUS Obsidian Bridge control-room layer. | adapter surface: OpenClaw chat commands, dashboard projection, control room |
| `lib/jobs/memory-compaction.js` | 1550 | drop | RE-06 | LanceDB Memory Compaction. | reachable only through adapter files |
| `engine/commands/plur1bus-command.js` | 1227 | drop | — | The /plur1bus chat command (was index.js:7271-9055), including the 17 | adapter surface: OpenClaw chat commands, dashboard projection, control room |
| `lib/shared-memory-migration.js` | 1174 | drop | RE-07 | closeSync, | reachable only through adapter files |
| `lib/providers/scoped-embedding-ipc.js` | 1109 | drop | RE-03, plan | closeSync, | RE-D4: `engine.embedding.*` RPC replaces the IPC |
| `engine/jobs/internal-job-bodies.js` | 993 | drop | RE-06 | the 18 internal job runners (PR-07). | reachable only through adapter files |
| `engine/tools/memory-tools.js` | 957 | drop | RE-07 | The five model-facing memory tools — `memory_recall`, `memory_search`, | adapter surface: OpenClaw chat commands, dashboard projection, control room |
| `lib/jobs/skill-miner.js` | 849 | drop | RE-06, RE-12 | Phase 6 — Skill Miner Orchestrator. | reachable only through adapter files |
| `lib/telegram-commands/skill-commands.js` | 831 | drop | — | Telegram command handlers for skill-miner proposals. | adapter surface: OpenClaw chat commands, dashboard projection, control room |
| `lib/telegram-commands/memory-edit.js` | 649 | drop | — | /forget + /correct — direct user intervention in the Memory Store. | adapter surface: OpenClaw chat commands, dashboard projection, control room |
| `lib/jobs/daily-consolidation.js` | 580 | drop | RE-06 | Phase 6 — stille tägliche Konsolidierung. | reachable only through adapter files |
| `lib/jobs/memory-dynamics-maintenance.js` | 559 | drop | RE-06 | Phase 7 - Memory Dynamics Maintenance. | reachable only through adapter files |
| `lib/control-plane-health.js` | 520 | drop | — | Number.isSafeInteger(value) && value >= 0 ? value : null | adapter surface: OpenClaw chat commands, dashboard projection, control room |
| `lib/telegram-commands/memory-query.js` | 515 | drop | — | /memory — Inspection command. | adapter surface: OpenClaw chat commands, dashboard projection, control room |
| `engine/commands/command-helpers.js` | 436 | drop | — | command helpers: maintenance nudges, JSON/skill formatting, the direct-cron guard, the Neo/conflict-summary he | adapter surface: OpenClaw chat commands, dashboard projection, control room |
| `lib/jobs/skill-miner/evidence-aggregator.js` | 338 | drop | — | Extracts keywords from memory objects, clusters them by Jaccard keyword | reachable only through adapter files |
| `lib/jobs/critical-classifier.js` | 325 | drop | RE-06 | Phase 5 Task 5.2 — klassifiziert frisch erstellte Memory-Cards der | reachable only through adapter files |
| `lib/jobs/conflict-resolver.js` | 292 | drop | RE-06 | Automatische Konflikt-Auflösung. | reachable only through adapter files |
| `lib/memory-doctor.js` | 292 | drop | — | Diagnostic helper for interpretation overlays. | reachable only through adapter files |
| `lib/encoding-llm.js` | 283 | drop | — | LLM-Einstiegspunkt für Emotion UND Bedeutung in einem Call. | reachable only through adapter files |
| `lib/telegram-commands/feature-toggle.js` | 254 | drop | — | /enable + /disable — Feature toggle. | adapter surface: OpenClaw chat commands, dashboard projection, control room |
| `lib/jobs/gc-job.js` | 241 | drop | RE-06 | Hintergrund-Job für Garbage Collection. | reachable only through adapter files |
| `lib/obsidian-semantic-discovery-flow.js` | 231 | drop | — | One-time, identity/scope/digest-bound Semantic Discovery confirmation flow. | reachable only through adapter files |
| `lib/obsidian-review-authority.js` | 220 | drop | — | Protected Obsidian review authority. | reachable only through adapter files |
| `lib/jobs/proactive-check.js` | 205 | drop | RE-06 | Hintergrund-Job für proaktive Nudges. | reachable only through adapter files |
| `lib/pattern-detector-embedding.js` | 205 | drop | — | Embedding-basierte Pattern-Erkennung. | reachable only through adapter files |
| `lib/pattern-detector.js` | 202 | drop | — | Pattern-Erkennung im Turn-Journal. | reachable only through adapter files |
| `lib/afterthought.js` | 191 | drop | RE-06 | Nachgedanken: seltene, verzögerte Follow-ups. | reachable only through adapter files |
| `lib/obsidian/archive-rotation.js` | 191 | drop | — | for (const ext of ARCHIVE_EXTS) { | reachable only through adapter files |
| `lib/garbage-collector.js` | 184 | drop | — | Garbage Collection für das PLUR1BUS Memory-System (v6). | reachable only through adapter files |
| `lib/security.js` | 183 | drop | — | Telegram/Chat Auth & ACL for PLUR1BUS. | chat auth/ACL; the owner gate is the core RBAC (docs/rbac.md), the engine receives the caller principal |
| `lib/native/sharp-unavailable.js` | 176 | drop | — | probe `sharp`, and when it cannot load | transformers.js workaround |
| `lib/review-workspace-status.js` | 167 | drop | — | what the agent's workspace last wrote, for | reachable only through adapter files |
| `lib/proactive-nudge.js` | 156 | drop | RE-06 | Generiert proaktive Nudges aus erkannten Patterns. | reachable only through adapter files |
| `lib/overlay-commands.js` | 144 | drop | — | return JSON.stringify(value, null, 2); | reachable only through adapter files |
| `lib/jobs/reminder-dispatch.js` | 142 | drop | RE-06 | Cron-Job: prüft fällige Reminders, schreibt Pending-Queue, optional Delivery. | reachable only through adapter files |
| `lib/critical-buttons.js` | 122 | drop | RE-05 | Critical Push mit Telegram-Knöpfen (7.16.10). | reachable only through adapter files |
| `lib/jobs/schicht15-tracker.js` | 120 | drop | RE-06 | Schicht 1.5 KNOWLEDGE.md Promotion Tracking. | reachable only through adapter files |
| `lib/jobs/skill-miner/llm-extractor.js` | 118 | drop | — | Given an evidence group, builds an LLM prompt and parses the JSON response | reachable only through adapter files |
| `lib/jobs/skill-miner/benefit-backfill.js` | 117 | drop | — | 7.12.49: Nutzen-Satz fuer Altvorschlaege nachtragen. | reachable only through adapter files |
| `lib/feature-crons-hint.js` | 116 | drop | — | the feature-cron setup marker path, the | OpenClaw cron registration marker; `JobSpec.default_schedule` carries the schedules |
| `lib/jobs/auto-accept-stale-criticals.js` | 115 | drop | RE-06 | Phase 5 Task 5.3 — täglich 03:1x, akzeptiert critical cards die seit | reachable only through adapter files |
| `lib/drop-injected-conflicts.js` | 114 | drop | RE-04 | bulk-demote injected behavior conflicts. | reachable only through adapter files |
| `lib/obsidian/semantic-duplicate-scan.js` | 112 | drop | — | return new Set(String(text \|\| "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((part) => part.length > 2)); | reachable only through adapter files |
| `lib/jobs/consolidation-report.js` | 107 | drop | RE-06 | Wöchentlicher Consolidation-Report. | reachable only through adapter files |
| `lib/install/soul-patcher.js` | 102 | drop | — | return [ | patches the OpenClaw SOUL.md |
| `lib/critical-push-classifier.js` | 96 | drop | — | critical-push-classifier — entscheidet, ob eine neue Memory-Card | reachable only through adapter files |
| `lib/review-narrative-lead.js` | 95 | drop | — | Deterministic, fail-open prose lead for PLUR1BUS reviews (morning/evening). | reachable only through adapter files |
| `lib/control-plane-storage.js` | 90 | drop | — | Deckel gegen unbegrenzte Laeufe: so viele Eintraege werden hoechstens besucht. */ | adapter surface: OpenClaw chat commands, dashboard projection, control room |
| `engine/jobs/run-state-migration.js` | 89 | drop | — | PR-08 part 3 (spec 3.3 "Migration"). | reachable only through adapter files |
| `lib/llm-warmth.js` | 89 | drop | — | Cold-start guard for plugin LLM calls under OpenClaw 2026.9.7. | OpenClaw 2026.9.7 cold-start workaround |
| `lib/critical-push-state.js` | 85 | drop | — | critical-push-state — Datei-basierte Tageszähler pro Agent. | push delivery budget; `pushCriticalButtons` is dropped |
| `lib/temperament-command.js` | 82 | drop | — | Pure Helpers für /plur1bus temperament. | reachable only through adapter files |
| `lib/jobs/apply-conflict-resolution.js` | 76 | drop | RE-06 | confirm-gated safeUpdate apply. | reachable only through adapter files |
| `lib/knowledge-update-budget.js` | 74 | drop | RE-04 | Budget und Schutz fuer die KNOWLEDGE.md-Beförderung. | reachable only through adapter files |
| `lib/obsidian/record-writer.js` | 73 | drop | — | `# ${title}`, | reachable only through adapter files |
| `lib/fetch-with-timeout.js` | 72 | drop | — | Fetch wrapper with timeout, cleanup, and | reachable only through adapter files |
| `lib/internal-cron-reply.js` | 72 | drop | — | Convert an Afterthought job result into a direct OpenClaw cron reply. | OpenClaw cron reply protocol (`NO_REPLY`) |
| `lib/obsidian/weekly-synthesis.js` | 71 | drop | — | d.setUTCDate(d.getUTCDate() + 4 - day); | reachable only through adapter files |
| `lib/obsidian/bases-generator.js` | 69 | drop | — | ["memory-candidates.base", "memory_candidate", "Memory Candidates"], | reachable only through adapter files |
| `lib/obsidian/maintenance-deep.js` | 66 | drop | — | Remove missing-<field>-<uuid>.md task files whose source record now has all required fields. | reachable only through adapter files |
| `lib/job-rate-limit.js` | 64 | drop | — | Persistentes Rate-Limiting für teure Hintergrund-Jobs. | reachable only through adapter files |
| `engine/jobs/rem-outcome.js` | 60 | drop | — | REM run semantics over the ledger (PR-08). | reachable only through adapter files |
| `lib/jobs/skill-miner/skill-md-renderer.js` | 58 | drop | — | Render a proposal into an OpenClaw-compatible SKILL.md string. | reachable only through adapter files |
| `lib/obsidian/project-hub-builder.js` | 56 | drop | — | return [`## ${title}`, "", rows.length ? rows.map((row) => `- ${row}`).join("\n") : "- None generated.", ""].j | reachable only through adapter files |
| `lib/knowledge-pending-prune.js` | 51 | drop | RE-04 | Stale-entry detection for the KNOWLEDGE.md promotion queue | reachable only through adapter files |
| `lib/obsidian/tasks-generator.js` | 51 | drop | — | if (priority === "high") return "priority: high"; | reachable only through adapter files |
| `lib/host-paths.js` | 49 | drop | — | path defaults for lib/ modules on the engine graph. | Node module plumbing |
| `lib/obsidian/adversarial-deep.js` | 49 | drop | — | ignore\s+(all\s+)?(previous\|system\|developer\|higher-priority)\s+(instructions\|messages\|rules)/i, | reachable only through adapter files |
| `lib/native/sharp-stub.js` | 43 | drop | — | callable stand-in for `sharp` when the native | transformers.js workaround |
| `lib/obsidian/semantic-conflict-graph.js` | 42 | drop | — | return String(record.statement \|\| record.summary \|\| record.text \|\| record.title \|\| "").toLowerCase().r | reachable only through adapter files |
| `lib/obsidian/memory-explain-builder.js` | 39 | drop | — | if (!mutationAllowed(options.mutationPolicy, "vault_write")) { | reachable only through adapter files |
| `lib/obsidian/link-suggestions.js` | 37 | drop | — | if (!mutationAllowed(options.mutationPolicy, "vault_write")) { | reachable only through adapter files |
| `lib/jobs/feedback-analyzer.js` | 36 | drop | RE-06 | Observierender Feedback-Analyzer Job. | reachable only through adapter files |
| `lib/obsidian/conflict-collector.js` | 34 | drop | — | for (const record of index.records) { | reachable only through adapter files |
| `lib/obsidian/impact-analysis.js` | 32 | drop | — | if (!mutationAllowed(options.mutationPolicy, "vault_write")) { | reachable only through adapter files |
| `lib/curation-resolve.js` | 27 | drop | — | human keep/drop for neo conflict records. | reachable only through adapter files |
| `lib/obsidian/provenance-graph.js` | 27 | drop | — | if (!mutationAllowed(options.mutationPolicy, "vault_write")) { | reachable only through adapter files |
| `lib/host-sdk-loader.js` | 24 | drop | — | the one seam lib/ uses to reach a host SDK module | Node module plumbing |
| `lib/obsidian/property-normalizer.js` | 24 | drop | — | "plur1bus_type", | reachable only through adapter files |
| `lib/obsidian/conflict-report.js` | 23 | drop | — | if (!mutationAllowed(options.mutationPolicy, "vault_write")) { | reachable only through adapter files |
| `lib/plugin-meta.js` | 17 | drop | — | the plugin's root directory and version, read once. | Node module plumbing |
| `lib/obsidian/evidence-scorer.js` | 16 | drop | — | if (/user\|tool\|system\|curated/.test(trust)) score += 0.25; | reachable only through adapter files |
| `lib/obsidian/link-hygiene.js` | 9 | drop | — | return index.records | reachable only through adapter files |
