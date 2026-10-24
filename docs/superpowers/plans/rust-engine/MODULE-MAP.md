# Module map of the Node engine (`main` @ `98dfe2f`) → Rust briefs

Generated on 2026-10-23 from the import closure of `engine/create-engine.js` in `Cyb3rb1ade/openclaw-plur1bus-memory` at commit `98dfe2f` (the harness pin): every `.js` file the engine process can load, resolved through relative `import`/`require` specifiers. **This is the completeness check the briefs are measured against:** a brief is finished when every row it owns has a Rust module, a fold target or a recorded drop. The dispositions are the coordinator's proposal; an implementer who disagrees changes the row in the same pull request as the code and says why.

| Disposition | Meaning |
|---|---|
| `port` | behaviour the Rust engine must reproduce; parity goldens apply (RE-09) |
| `fold` | a Node utility that becomes a Rust idiom or an existing harness crate; the note names the target, and any constants or rules the file holds move with it |
| `decide` | owner decision pending (RE-07 T7b: Obsidian vault writers and policies) |
| `drop` | not ported: adapter surface (chat commands, dashboard, control room, push buttons) or Node plumbing — each row says which |
| `review` | named in no brief and, on `main`, reachable only through adapter files; the owning brief's first PR confirms port or drop |

How a row gets its disposition, in order: the adapter set (`engine/commands/`, `lib/telegram-commands/`, `lib/obsidian-control-room.js`, `lib/control-plane-*`, `lib/dashboard-*`, `engine/tools/memory-tools.js`, `lib/wiki-command.js`) and the explicitly named drops → the folds → the Obsidian rows (`decide`) → the two review helpers RE-13 T3 ports (`lib/review-narrative-lead.js`, `lib/review-workspace-status.js`: `port`, owner RE-13) → everything a brief names, everything under a brief-owned directory (`engine/jobs/`, `lib/jobs/`, `engine/capture/`, …) and everything reachable from `create-engine.js` without entering the adapter set (`port`) → the rest (`review`). Reachability alone never drops a file: on `main` the job bodies (`engine/jobs/internal-job-bodies.js`) are wired through the chat command module, and they are engine behaviour all the same.

Regenerate: walk the relative import closure from `engine/create-engine.js` (regex `from|import\(|require\(` + `'./…'`), count lines, apply the rules above, and compare the file list against this table; a new file without a row fails the check. The plan's §1 counts (323 files / 101,408 lines) included `openclaw.plugin.json` and the adapter entry; this closure has 322 files / 100,593 lines.

## Totals by owner

| Owner | Files | Lines | port | fold | decide | drop | review |
|---|---:|---:|---:|---:|---:|---:|---:|
| RE-01 | 13 | 5,707 | 11 | 2 | 0 | 0 | 0 |
| RE-02 | 29 | 10,267 | 22 | 7 | 0 | 0 | 0 |
| RE-03 | 25 | 5,808 | 23 | 2 | 0 | 0 | 0 |
| RE-04 | 43 | 15,780 | 42 | 1 | 0 | 0 | 0 |
| RE-05 | 46 | 16,177 | 43 | 3 | 0 | 0 | 0 |
| RE-06 | 59 | 16,424 | 58 | 1 | 0 | 0 | 0 |
| RE-07 | 69 | 16,380 | 33 | 0 | 36 | 0 | 0 |
| RE-08 | 10 | 1,598 | 0 | 10 | 0 | 0 | 0 |
| RE-13 | 2 | 262 | 2 | 0 | 0 | 0 | 0 |
| — | 26 | 12,190 | 0 | 0 | 0 | 26 | 0 |
| **all** | 322 | 100,593 | 234 | 26 | 36 | 26 | 0 |

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
| `lib/abort.js` | 141 | fold | RE-08 | Throw when an operation's cancellation signal has been aborted. | `Cancel` |
| `lib/with-timeout.js` | 54 | fold | RE-08 | Race a promise against a timeout. | `Cancel` deadlines |
| `engine/create-engine.js` | 3991 | port | RE-01, RE-05, plan | the one construction path (spec 3.1, owner decision A). |  |
| `lib/setup/feature-profiles.js` | 607 | port | RE-01 | explicit PLUR1BUS feature profiles. | `setupProfile` → feature flags, read by recall and create-engine (RE-01 T3 config) |
| `lib/setup/config-contract.js` | 324 | port | RE-01 | profile config contract (key lists per setup profile; no header comment) | profile config contract: which keys a setup profile sets (RE-01 T3) |
| `engine/runtime/env-config.js` | 158 | port | RE-01 | environment-variable and config resolution, summaries and small command helpers. |  |
| `engine/lifecycle/close-resources.js` | 129 | port | RE-01, RE-08 | the engine's close path (spec 3.1). |  |
| `lib/input-limits.js` | 91 | port | RE-01, RE-08 | Centralized input validation with clear error messages. | limits are contract constants (RE-01) |
| `engine/config/live-config.js` | 68 | port | RE-01 | the engine's one host-neutral re-read of its |  |
| `engine/runtime/debug-log.js` | 66 | port | — | the module-level debug logger (`dbg`), the purge throttle and the speaker-proposal pipeline. |  |
| `engine/runtime/constants.js` | 32 | port | — | module-level constants shared by the recall, capture and command paths. |  |
| `engine/events.js` | 24 | port | RE-01 | The single path engine code uses to tell the host something happened |  |
| `engine/internals.js` | 22 | port | plan | the adapter's transitional window into EngineInternals. |  |

### RE-02

| File | Lines | Disposition | Named in | Purpose | Note |
|---|---:|---|---|---|---|
| `lib/verified-path-directory.js` | 397 | fold | RE-02 | verified-path directories (ADR 0001, | trusted paths: the rules of module-api `securePath` |
| `lib/atomic-file.js` | 224 | fold | RE-02 | shared atomic JSON/text file IO helpers. | one `atomic_write` (unique tmp, fsync, rename, dir fsync) |
| `lib/directory-capability.js` | 195 | fold | RE-02 | closeSync, | directory probe at store open |
| `lib/bounded-cache.js` | 134 | fold | RE-02 | refCount-aware bounded cache with soft limit. | bounded cache in the store layer |
| `lib/jsonl-utils.js` | 114 | fold | RE-02 | zentrale JSONL-Lesehilfe. | `JsonlLedger<T>` |
| `lib/fsync-atomic.js` | 65 | fold | RE-02 | unique tmp + fsync + rename + directory fsync. | `atomic_write` |
| `lib/atomic-json.js` | 52 | fold | RE-02 | Atomic read-modify-write for JSON files with | `atomic_write` + `StateFile<T>` |
| `engine/store/memory-db.js` | 1639 | port | RE-02, plan | the per-agent LanceDB store (`MemoryDB`) and the epistemic-status / valid-time write helpers. |  |
| `lib/db-adapter.js` | 1503 | port | RE-02 | dünner Wrapper um LanceDB für Telegram-Commands. |  |
| `lib/embedding-cache.js` | 925 | port | RE-02, RE-03, plan | v2 embedding cache: in-memory LRU+TTL plus optional persistent SQLite backend, |  |
| `lib/llm-result-cache.js` | 690 | port | RE-02, RE-06, plan | Exact, purpose-allowlisted LLM result cache with absolute TTL and LRU |  |
| `lib/tombstone.js` | 595 | port | RE-02, RE-05, RE-07 | kanonischer Tombstone-Vertrag für PLUR1BUS. |  |
| `lib/multi-namespace-pool.js` | 576 | port | RE-02, RE-04 | "mode", |  |
| `lib/registry-lock.js` | 496 | port | RE-02 | synchroner, prozessübergreifender Lock für die | the one cross-process lock behind tombstone, neo-arch, import-lock, rebind-ledger, knowledge-pending and job-lock → one `Lock` type (RE-02 T6) |
| `engine/store/agent-db-pool.js` | 493 | port | RE-02 | the per-agent `MemoryDB` pool (`AgentDbPool`). |  |
| `lib/filter-parser.js` | 305 | port | RE-02 | Parses intuitive filter expressions from /memory command input | list filter grammar used by `db-adapter.js` → `RowFilter` parser (RE-02 T2) |
| `lib/speaker-mapping-store.js` | 295 | port | RE-02, RE-05, plan | PLUR1BUS bridge to OpenClaw's diarization SQLite DB for speaker mappings. |  |
| `engine/store/fragment-compactor.js` | 247 | port | — | bounded LanceDB fragment compaction |  |
| `lib/epistemic-status.js` | 226 | port | RE-02, RE-05 | Explicit Trust State (Phase 1). |  |
| `lib/valid-time.js` | 210 | port | RE-02, RE-05 | Bi-Temporal Memory (Phase 2). |  |
| `lib/sql-safety.js` | 205 | port | RE-02 | Defense-in-depth Helpers für LanceDB-SQL-Strings. | LanceDB filter quoting → `RowFilter` rendering (RE-02 T2) |
| `lib/namespace-config.js` | 185 | port | RE-02 | "activeWriteNamespace", |  |
| `engine/store/schema-version.js` | 147 | port | RE-02, RE-07, plan | store schema version marker and migrator |  |
| `engine/store/lancedb-loader.js` | 78 | port | — | lazy loaders for the LanceDB and OpenAI packages (direct import, plugin node_modules, legacy stock path). |  |
| `lib/job-lock.js` | 76 | port | RE-02, RE-06 | prozessübergreifender Try-once-Lock für Cron-Jobs und |  |
| `lib/lancedb-optimize.js` | 65 | port | RE-02 | optimize.js (7.12.31) |  |
| `lib/tombstone-write-guard.js` | 58 | port | RE-02 | shared pre-write tombstone check. |  |
| `engine/checkpoint/checkpoint-store.js` | 56 | port | RE-02 | PR-15. |  |
| `lib/score.js` | 16 | port | RE-02 | Distance→Score-Konvertierung für LanceDB-Vektorsuche. |  |

### RE-03

| File | Lines | Disposition | Named in | Purpose | Note |
|---|---:|---|---|---|---|
| `lib/host-network.js` | 203 | fold | RE-03 | the engine's outbound-HTTP and secret ports | `transport::guarded` + `SecretPort` (keep its address rules) |
| `lib/fetch-with-timeout.js` | 72 | fold | RE-03 | Fetch wrapper with timeout, cleanup, and | `transport::guarded` |
| `lib/providers/embedding-local-transformers.js` | 894 | port | RE-03 | EMBEDDINGGEMMA2_EMBEDDING_PROFILE, |  |
| `lib/providers/local-model-artifacts.js` | 629 | port | RE-03 | path, |  |
| `lib/model-preparation/coordinator.js` | 393 | port | RE-03, RE-07 | ensurePinnedModelArtifacts, |  |
| `lib/providers/reranker-remote.js` | 363 | port | RE-03 | configurable remote (HTTP) reranker. |  |
| `lib/providers/reranker-local-transformers.js` | 355 | port | RE-03 | BGE_RERANKER_PROFILE, |  |
| `engine/providers/embedding-service.js` | 328 | port | RE-03 | EmbeddingService.probe() (E3 Task 3) |  |
| `lib/providers/embedding-openai.js` | 306 | port | RE-03 | SECRET_PURPOSES, |  |
| `lib/providers/local-transformers-shared-pool.js` | 294 | port | RE-03 | "@cyb3rb1ade/plur1bus-memory/shared-local-transformers-model-pool", |  |
| `lib/providers/config-normalize.js` | 256 | port | RE-03, RE-07, plan | DEFAULT_COHERE_RERANK_MODEL, |  |
| `lib/providers/legacy-provider-migration.js` | 233 | port | RE-03 | DEFAULT_LOCAL_EMBEDDINGGEMMA2_DIMENSIONS, |  |
| `lib/providers/dimensions.js` | 190 | port | RE-03 | Pinned optional multilingual local embedding model. */ |  |
| `lib/reembedding/runtime-config.js` | 181 | port | RE-03, RE-07, plan | if (!value \|\| typeof value !== "object" \|\| Array.isArray(value)) throw new Error("invalid embedding Secret |  |
| `lib/model-preparation/state-store.js` | 178 | port | RE-03, RE-07 | closeSync, |  |
| `lib/reembedding/fingerprint.js` | 157 | port | RE-03, RE-07, plan | "provider", |  |
| `engine/providers/model-readiness.js` | 148 | port | RE-03 | reranker readiness probe, pure |  |
| `lib/provider-error.js` | 135 | port | RE-03 | Content-free errors for provider HTTP failures (N2 leak audit I-6). A |  |
| `lib/providers/env.js` | 117 | port | RE-03 | COHERE_API_KEY: () => process.env.COHERE_API_KEY, |  |
| `lib/providers/embedding-identity.js` | 106 | port | RE-03 | Canonical vector-space identity; credentials and transport are excluded. */ |  |
| `lib/providers/secret-input.js` | 97 | port | RE-03 | "COHERE_API_KEY", |  |
| `engine/providers/runtime-reranker.js` | 76 | port | RE-03 | the runtime reranker provider factory. |  |
| `lib/providers/reranker-chained.js` | 60 | port | RE-03 | Chained Reranker mit Fallback. |  |
| `lib/providers/rerank-signal.js` | 20 | port | RE-03 | the single owner of a rerank timeout (PR-09). |  |
| `lib/providers/reranker-cohere.js` | 17 | port | RE-03 | the Cohere preset of the remote reranker. |  |

### RE-04

| File | Lines | Disposition | Named in | Purpose | Note |
|---|---:|---|---|---|---|
| `lib/recall-phase-timer.js` | 137 | fold | RE-04 | lightweight per-recall phase timer. | `timing.*` in T6 |
| `lib/recall-pipeline.js` | 2225 | port | RE-04, RE-12, plan | komplette Recall-Pipeline als orchestrator. |  |
| `lib/i18n-dictionary.js` | 2218 | port | RE-04 | PLUR1BUS translations. | port only the strings the engine renders (block labels, hedging, deferral notes, job texts); adapter UI strings stay; de/en completeness checked the way `scripts/check-i18n.mjs` does |
| `lib/memory-request-context.js` | 1482 | port | RE-04, plan | Canonical, immutable identity context for every memory data boundary. |  |
| `engine/recall/assemble-prompt-context.js` | 1338 | port | RE-04 | The per-turn recall assembly (was index.js:12261-13327): identity, Neo |  |
| `lib/memory-graph.js` | 1078 | port | RE-04 | Graph-Engine für assoziative Memory-Verknüpfung. |  |
| `lib/conversation-reactivation-recall.js` | 962 | port | RE-04 | Conversation Reactivation Recall (CRR) — additive post-recall hook. |  |
| `lib/emotional-state.js` | 607 | port | RE-04, RE-05 | Emotional State Tracker für PLUR1BUS. |  |
| `lib/recall-decision-trace.js` | 548 | port | RE-04 | Recall Decision Trace helpers. |  |
| `lib/relevant-memory-context.js` | 504 | port | RE-04 | Formats the <relevant-memories> prompt block injected before each agent turn. |  |
| `lib/interpretation-overlay.js` | 414 | port | RE-04, RE-06 | Interpretation overlays (append-only, idempotent). |  |
| `lib/temporal-provenance.js` | 323 | port | RE-04, RE-05 | P5 Temporal Provenance + Operational Action Guard. |  |
| `engine/recall/namespace-recall.js` | 285 | port | RE-04 | the merged multi-namespace recall and its budget helpers. |  |
| `engine/knowledge/knowledge-pending.js` | 281 | port | RE-02, RE-04 | the KNOWLEDGE.md pending-queue, lock and update helpers, and the curation log they append to. |  |
| `lib/semantic-lens-index.js` | 245 | port | RE-04 | Opt-out like every other PLUR1BUS feature. |  |
| `lib/inject-budget.js` | 244 | port | RE-04 | aggregate char cap across prepend blocks. |  |
| `lib/acl-middleware.js` | 240 | port | RE-04 | Differentiated ACL for PLUR1BUS Memory System (v6). |  |
| `lib/pattern-surface.js` | 187 | port | RE-04 | Pattern surfacing with normalized overlap scoring. |  |
| `lib/temporal-parser.js` | 184 | port | RE-04 | Extrahiert Zeit-Anchor aus natürlichsprachigen Queries. |  |
| `lib/text-utils.js` | 184 | port | RE-04 | pure Text-Helpers (Tokenisierung, Similarity, Summary). | tokenisation, similarity and summary helpers — parity-relevant, shared by recall and capture |
| `lib/i18n.js` | 181 | port | RE-04 | Global i18n + SOUL.MD tone for PLUR1BUS. | the lookup and tone helpers behind the engine-rendered strings; see `lib/i18n-dictionary.js` |
| `lib/query-refiner.js` | 170 | port | RE-04 | Query-Verfeinerung für Recall-Pipeline. |  |
| `engine/recall/warm-recall-path.js` | 169 | port | RE-04 | the warm-only recall (E5 Task 9). |  |
| `lib/temporal-context.js` | 163 | port | RE-04 | Temporal continuity context for prompts. |  |
| `lib/recall-budget.js` | 152 | port | RE-04, RE-12, plan | Pure functions for adaptive recall budget resolution and memory tier allocation. |  |
| `engine/identity/principal.js` | 137 | port | RE-04 | PR-06 (spec 3.4). | the canonical principal hash (RE-04 T1); the plan cites `memory-request-context.js:332`, which uses it |
| `lib/mood-style-directive.js` | 131 | port | RE-04 | Mood-Stil-Direktive statt Label. |  |
| `engine/recall/recall-params.js` | 114 | port | RE-04 | the automatic recall's pipeline parameters. |  |
| `lib/drop-injected-conflicts.js` | 114 | port | RE-04 | bulk-demote injected behavior conflicts. | on `main` reached only through the chat command module; engine behaviour all the same |
| `lib/temporal-filter.js` | 92 | port | RE-04 | Filtert Memory-Results nach temporalem Range |  |
| `lib/graph-index.js` | 78 | port | RE-04 | In-memory Index für Memory-Graph-Edges. |  |
| `lib/knowledge-update-budget.js` | 74 | port | RE-04 | Budget und Schutz fuer die KNOWLEDGE.md-Beförderung. | on `main` reached only through the chat command module; engine behaviour all the same |
| `lib/memory-text-contradiction.js` | 69 | port | RE-04 | Pure helpers for resolving contradictions between factual memory texts. |  |
| `engine/recall/neo-prelude.js` | 68 | port | RE-04 | the read half of the recall's neo prelude. |  |
| `lib/recall-confidence-framing.js` | 65 | port | RE-04 | Unsicherheits-Hedging nach Recall-Score. |  |
| `lib/contradiction-disclosure.js` | 58 | port | RE-04 | formatContradictionDisclosure(pairs, opts) -> string \| null |  |
| `lib/frontmatter.js` | 55 | port | RE-04 | YAML-Frontmatter Parser/Builder für KNOWLEDGE.md. |  |
| `engine/recall/recall-result.js` | 54 | port | RE-01, RE-04 | Value helpers for the recall contract (types/engine.d.ts, target 1.4.1): |  |
| `lib/knowledge-pending-prune.js` | 51 | port | RE-04 | Stale-entry detection for the KNOWLEDGE.md promotion queue | on `main` reached only through the chat command module; engine behaviour all the same |
| `engine/recall/system-supplement.js` | 30 | port | RE-04, RE-07 | The static system-prompt supplement (was index.js:7082-7087): the recall |  |
| `lib/memory-context-sanitize.js` | 26 | port | RE-04 | Sanitizers for memory context attributes and prompt text. |  |
| `lib/importance-status.js` | 23 | port | RE-04 | Wartezustaende der Importance-Klaerung. |  |
| `lib/prompt-memory-fields.js` | 20 | port | RE-04 | render-time status/epistemic/age labels. |  |

### RE-05

| File | Lines | Disposition | Named in | Purpose | Note |
|---|---:|---|---|---|---|
| `lib/neo-worker-runtime.js` | 338 | fold | RE-05 | if (error instanceof Error) return error; | a Rust task instead of a worker thread |
| `lib/bounded-operation-queue.js` | 78 | fold | RE-05 | depth-bounded queue that sheds oldest | post-turn queue depth bound |
| `lib/runtime-pressure-gate.js` | 68 | fold | RE-05 | runtime memory pressure classification. | port the thresholds into turn admission |
| `lib/neo-arch.js` | 3687 | port | RE-02, RE-05, plan | "project_fact", |  |
| `engine/capture/capture-turn.js` | 1271 | port | RE-05 | The per-turn auto-capture pipeline (was index.js:10357-11305): fail-closed |  |
| `lib/episodes.js` | 925 | port | RE-05, RE-06 | Episoden-Engine für PLUR1BUS. |  |
| `lib/runtime-scheduler.js` | 687 | port | RE-04, RE-05 | recallTimeoutMs: 45_000, | turn admission: background/internal turn detection, priorities, pressure skip (RE-05 T1, RE-04 T1) |
| `lib/memory-fact-quality.js` | 523 | port | RE-05 | deterministic, testable fact-quality classifier. |  |
| `lib/memory-dynamics.js` | 517 | port | RE-05 | Phase 7 - Memory Dynamics: pure helpers for strength decay, reinforcement, |  |
| `lib/safe-update.js` | 510 | port | RE-05 | Phase 8A — Safe Reconsolidation: Non-destructive memory updates with versioning. |  |
| `lib/shared-memory-pool.js` | 446 | port | RE-05, RE-07 |  |  |
| `lib/critical-review.js` | 445 | port | RE-05 | UX-Vertrag, Datenschutz und Kurzreferenzen für |  |
| `lib/contradiction-detector.js` | 436 | port | RE-05 | return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback; |  |
| `lib/tier1-lexicon.js` | 410 | port | RE-05 | Tier-1 lexicon-based emotion classifier. |  |
| `lib/shared-memory.js` | 386 | port | RE-05, RE-07 | Kollaboratives Memory (verkleinert) |  |
| `lib/memory-chunking.js` | 346 | port | RE-05 | entscheidet, ob eine Erinnerung als ein Vektor |  |
| `lib/emotion-engine.js` | 340 | port | RE-05 | Core emotion analysis engine. |  |
| `lib/continuity-gate.js` | 322 | port | RE-05 | Taste gate that prevents PLUR1BUS from surfacing spontaneous memory associations |  |
| `lib/speaker-segment-schema.js` | 313 | port | RE-01, RE-05 | Canonical speaker-segment schema shared between PLUR1BUS and OpenClaw. | canonical speaker-segment schema shared with OpenClaw → also a contract type (RE-01) |
| `lib/emotion.js` | 283 | port | RE-05 | Emotions-Inferenz für PLUR1BUS Memories. |  |
| `lib/encoding-llm.js` | 283 | port | RE-05 | LLM-Einstiegspunkt für Emotion UND Bedeutung in einem Call. | on `main` reached only through the chat command module; engine behaviour all the same |
| `engine/capture/turn-replay-guard.js` | 274 | port | RE-05 | Q3 (E4 Task 5): a replayed turn never |  |
| `lib/memory-merge-safety.js` | 274 | port | RE-05 | "node", "nodejs", "node.js", "react", "vue", "angular", "svelte", |  |
| `engine/capture/post-turn-work.js` | 241 | port | RE-05 | Light-Traum and episode extraction |  |
| `lib/tier2-transformer.js` | 224 | port | RE-03, RE-05 | Tier-2 transformer-based emotion classifier. |  |
| `lib/emotion-score.js` | 223 | port | RE-05 | Universal emotion representation for PLUR1BUS. |  |
| `lib/emotion-blends.js` | 221 | port | RE-05 | Emotional blend detection for PLUR1BUS. |  |
| `lib/categorize.js` | 195 | port | RE-05 | Kategorie-Taxonomie + Auto-Kategorisierung. |  |
| `lib/workspace-policy.js` | 194 | port | RE-05, RE-07 | Durable, canonical per-agent/per-workspace PLUR1BUS enablement policy. */ |  |
| `lib/tier3-llm.js` | 185 | port | RE-05 | Tier-3 LLM-based emotion classifier. |  |
| `lib/reminder-store.js` | 171 | port | RE-05 | CRUD für Reminders als vollwertige LanceDB-Memories. |  |
| `lib/post-turn-queue.js` | 169 | port | RE-05 | post-turn LLM work, queued for the |  |
| `lib/epistemic-cutoff.js` | 145 | port | RE-05 | restore-safe cutoff for explicit epistemic writes. |  |
| `lib/deferred-dynamics-queue.js` | 143 | port | RE-05 | queue.js (7.12.30) |  |
| `lib/workspace-policy-guard.js` | 114 | port | RE-05, RE-07 | Common policy boundary for PLUR1BUS workspace operations. */ |  |
| `lib/reminder-extraction.js` | 102 | port | RE-05 | Gate-Logik für die Reminder-Extraktion aus Auto-Capture-Items. |  |
| `lib/reminder-parser.js` | 101 | port | RE-05 | Parst zeitliche Aussagen aus DE/EN-Text zu remindAt (epoch ms). |  |
| `lib/jev-chunk-decider.js` | 99 | port | RE-05, plan | decides per captured message whether splitting |  |
| `lib/critical-push-classifier.js` | 96 | port | RE-05 | critical-push-classifier — entscheidet, ob eine neue Memory-Card | classification only (RE-05 T4); delivery stays dropped |
| `lib/speaker-proposer.js` | 87 | port | RE-05 | Contextual speaker-name proposer for D4. |  |
| `lib/episode-watermark.js` | 85 | port | RE-05 | Entscheidungslogik für das agent_end-Watermark. |  |
| `lib/reminder-pending.js` | 73 | port | RE-05 | Atomische Pending-Queue für Reminders pro Workspace+Agent. |  |
| `lib/retroactive-interference.js` | 45 | port | RE-05 | Weakens older similar non-core memories after a new memory is stored. |  |
| `lib/reminder-nudge.js` | 39 | port | RE-05 | Formats due reminders into a prependContext nudge string. |  |
| `lib/epistemic-capture.js` | 36 | port | RE-05 | decide observed vs untrusted for new writes. |  |
| `lib/post-turn-detach.js` | 27 | port | RE-05 | Post-turn work (capture, episodes, insights, light dream) is enqueued from |  |

### RE-06

| File | Lines | Disposition | Named in | Purpose | Note |
|---|---:|---|---|---|---|
| `lib/llm-call.js` | 105 | fold | RE-06 | if (!Number.isFinite(parsed) \|\| parsed <= 0) return DEFAULT_LLM_TIMEOUT_MS; | `LlmPort` call wrapper, 30 s default timeout |
| `lib/jobs/memory-compaction.js` | 1550 | port | RE-06 | LanceDB Memory Compaction. | `consolidate-daily` body part (RE-06 T3) |
| `lib/dreaming/rem-dream.js` | 1534 | port | RE-06 | REM Dream Engine. |  |
| `engine/jobs/internal-job-bodies.js` | 993 | port | RE-06 | the 18 internal job runners (PR-07). | on `main` the bodies are wired by `engine/commands/plur1bus-command.js` (adapter); the Rust registry wires them itself (RE-06 T1) |
| `lib/jobs/skill-miner.js` | 849 | port | RE-06, RE-12 | Phase 6 — Skill Miner Orchestrator. | on `main` reached only through the chat command module; engine behaviour all the same |
| `lib/persona-voice.js` | 698 | port | RE-04, RE-06, plan | Idiolekt pro Agent: Seed + Datei + Direktive. |  |
| `engine/jobs/job-registry.js` | 635 | port | RE-06 | PR-07/PR-08 (spec 3.3). |  |
| `lib/dreaming/light-dream.js` | 635 | port | RE-06 | Nach-Session-Reflexion (Light Dreaming). |  |
| `lib/jobs/daily-consolidation.js` | 580 | port | RE-06 | Phase 6 — stille tägliche Konsolidierung. | on `main` reached only through the chat command module; engine behaviour all the same |
| `lib/jobs/memory-dynamics-maintenance.js` | 559 | port | RE-06 | Phase 7 - Memory Dynamics Maintenance. | on `main` reached only through the chat command module; engine behaviour all the same |
| `lib/llm-router.js` | 517 | port | RE-06, plan | Immutable route kinds returned by the feature LLM resolver. */ |  |
| `lib/meta-cognition.js` | 380 | port | RE-06 | Meta-Kognition / Selbst-Reflexion (Feature 7). |  |
| `lib/reply-outcome-tracking.js` | 362 | port | RE-06 | automatic reply-based outcome signals. | feedback signals; CP-3c internal outcomes (RE-06 T4) |
| `lib/dreaming/dream-narrative.js` | 339 | port | RE-06 | Menschenähnliche Traum-Narrative. |  |
| `lib/jobs/skill-miner/evidence-aggregator.js` | 338 | port | RE-06 | Extracts keywords from memory objects, clusters them by Jaccard keyword | on `main` reached only through the chat command module; engine behaviour all the same |
| `lib/jobs/critical-classifier.js` | 325 | port | RE-06 | Phase 5 Task 5.2 — klassifiziert frisch erstellte Memory-Cards der | on `main` reached only through the chat command module; engine behaviour all the same |
| `lib/proactive-governor.js` | 312 | port | RE-06, plan | adaptiver Frequenzregler für proaktive |  |
| `lib/overlay-generator.js` | 296 | port | RE-04, RE-06 | Defensive overlay generator. Decides whether a recalled memory deserves an |  |
| `lib/jobs/conflict-resolver.js` | 292 | port | RE-06 | Automatische Konflikt-Auflösung. | on `main` reached only through the chat command module; engine behaviour all the same |
| `lib/feedback-log.js` | 264 | port | RE-06 | Feedback-Log für kontinuierliches Lernen (Phase 1b). |  |
| `lib/featureModels.js` | 248 | port | RE-06, plan | LLM tasks, their dashboard cards, and existing feature-local fallback config. */ |  |
| `lib/jobs/gc-job.js` | 241 | port | RE-06 | Hintergrund-Job für Garbage Collection. | on `main` reached only through the chat command module; engine behaviour all the same |
| `lib/dreaming/dream-diary.js` | 206 | port | RE-06 | Dream diary bridge. |  |
| `lib/feature-cron-specs.js` | 205 | port | RE-06 | host-neutral feature-cron job specs. | the 12 default schedules → `JobSpec.default_schedule` (RE-06 T1) |
| `lib/jobs/proactive-check.js` | 205 | port | RE-06 | Hintergrund-Job für proaktive Nudges. | on `main` reached only through the chat command module; engine behaviour all the same |
| `lib/pattern-detector-embedding.js` | 205 | port | RE-06 | Embedding-basierte Pattern-Erkennung. | on `main` reached only through the chat command module; engine behaviour all the same |
| `lib/pattern-detector.js` | 202 | port | RE-06 | Pattern-Erkennung im Turn-Journal. | on `main` reached only through the chat command module; engine behaviour all the same |
| `lib/afterthought.js` | 191 | port | RE-06 | Nachgedanken: seltene, verzögerte Follow-ups. | the `main` afterthought body; CP-3 (`afterthought-reflection.js`, plugin line) extends it (RE-06 T4) |
| `lib/garbage-collector.js` | 184 | port | RE-06 | Garbage Collection für das PLUR1BUS Memory-System (v6). | on `main` reached only through the chat command module; engine behaviour all the same |
| `lib/dreaming/dreaming-status-provider.js` | 175 | port | RE-06 | Meldet OpenClaws Gedaechtnisseite, wie PLUR1BUS tatsaechlich traeumt. |  |
| `lib/proactive-nudge.js` | 156 | port | RE-06 | Generiert proaktive Nudges aus erkannten Patterns. | on `main` reached only through the chat command module; engine behaviour all the same |
| `lib/local-model-generation.js` | 155 | port | RE-06 | local-model ownership across OpenClaw |  |
| `lib/jobs/reminder-dispatch.js` | 142 | port | RE-06 | Cron-Job: prüft fällige Reminders, schreibt Pending-Queue, optional Delivery. | on `main` reached only through the chat command module; engine behaviour all the same |
| `engine/jobs/job-ledger.js` | 122 | port | RE-06 | the append-only run ledger (PR-08, spec 3.3). |  |
| `lib/jobs/reflection-job.js` | 122 | port | RE-06 | Hintergrund-Job für Meta-Reflexion. |  |
| `lib/jobs/schicht15-tracker.js` | 120 | port | RE-06 | Schicht 1.5 KNOWLEDGE.md Promotion Tracking. | on `main` reached only through the chat command module; engine behaviour all the same |
| `lib/llm-failure.js` | 120 | port | RE-06 | Stable failure reasons safe for logs, results, and persisted records. */ | stable failure reasons, logged and persisted → parity |
| `lib/jobs/skill-miner/llm-extractor.js` | 118 | port | RE-06 | Given an evidence group, builds an LLM prompt and parses the JSON response | on `main` reached only through the chat command module; engine behaviour all the same |
| `lib/jobs/skill-miner/benefit-backfill.js` | 117 | port | RE-06 | 7.12.49: Nutzen-Satz fuer Altvorschlaege nachtragen. | on `main` reached only through the chat command module; engine behaviour all the same |
| `lib/jobs/auto-accept-stale-criticals.js` | 115 | port | RE-06 | Phase 5 Task 5.3 — täglich 03:1x, akzeptiert critical cards die seit | on `main` reached only through the chat command module; engine behaviour all the same |
| `lib/jobs/skill-miner/proposal-writer.js` | 115 | port | RE-06 | Read/write skill-proposals.jsonl, deduplicate by skillName, track rejections. |  |
| `lib/open-threads.js` | 115 | port | RE-06 | Pure helpers for open-thread detection. |  |
| `lib/dream-echo.js` | 113 | port | RE-06 | Traum-Echos: macht nächtliches Dreaming sichtbar. |  |
| `lib/time-window.js` | 111 | port | RE-06 | Timezone-bewusste Stunden- und Ruhezeiten-Helfer. |  |
| `lib/jobs/consolidation-report.js` | 107 | port | RE-06 | Wöchentlicher Consolidation-Report. | on `main` reached only through the chat command module; engine behaviour all the same |
| `lib/reaction-directive.js` | 106 | port | RE-06 | Reaktions-Neigung (Humanization F6). |  |
| `engine/runtime/llm-calls.js` | 96 | port | RE-06 | the feature LLM call wrappers (`callLlm`, deterministic context, merge check). |  |
| `engine/jobs/run-state-migration.js` | 89 | port | RE-06 | PR-08 part 3 (spec 3.3 "Migration"). | on `main` reached only through the chat command module; engine behaviour all the same |
| `lib/session-time.js` | 88 | port | RE-06 | Persistent session time tracking in run-state.json. |  |
| `engine/runtime/semantic-discovery.js` | 85 | port | RE-06 | semantic-link discovery batching and its per-run statistics. |  |
| `lib/jobs/apply-conflict-resolution.js` | 76 | port | RE-06 | confirm-gated safeUpdate apply. | on `main` reached only through the chat command module; engine behaviour all the same |
| `lib/job-rate-limit.js` | 64 | port | RE-06 | Persistentes Rate-Limiting für teure Hintergrund-Jobs. | on `main` reached only through the chat command module; engine behaviour all the same |
| `engine/jobs/rem-outcome.js` | 60 | port | RE-06 | REM run semantics over the ledger (PR-08). | on `main` reached only through the chat command module; engine behaviour all the same |
| `engine/jobs/job-specs.js` | 58 | port | RE-06 | the 19 engine-owned jobs (spec 3.3, contract JobName). |  |
| `lib/jobs/skill-miner/skill-md-renderer.js` | 58 | port | RE-06 | Render a proposal into an OpenClaw-compatible SKILL.md string. | on `main` reached only through the chat command module; engine behaviour all the same |
| `lib/setup/skill-workshop-dashboard.js` | 55 | port | RE-06 | 7.12.48: Sammelt die geminten Skills aller Agenten fuer den PLUR1BUS-Reiter. | skill-miner summary across agents; verify its reachability path before porting |
| `lib/memory-maintenance-gate.js` | 50 | port | RE-06 | Create the fail-closed gate used for an atomic writer-generation switch. */ |  |
| `lib/jobs/feedback-analyzer.js` | 36 | port | RE-06 | Observierender Feedback-Analyzer Job. | on `main` reached only through the chat command module; engine behaviour all the same |
| `lib/jobs/skill-miner/nudge-renderer.js` | 30 | port | RE-06 | Render a skill-proposal reminder nudge in the user's language and |  |

### RE-07

| File | Lines | Disposition | Named in | Purpose | Note |
|---|---:|---|---|---|---|
| `lib/obsidian-bridge.js` | 2359 | decide | RE-07 | PLUR1BUS <-> Obsidian bridge. | T7b vault writers and policies, owner-gated |
| `lib/obsidian/semantic-link-discoverer.js` | 987 | decide | RE-06 |  | RE-06 `discover-semantic-links` body writes vault link suggestions (T7b gate) |
| `lib/obsidian-mutation-policy.js` | 396 | decide | RE-07 | Parse Obsidian commands once and carry one immutable, fail-closed write policy | T7b vault writers and policies, owner-gated |
| `lib/obsidian/memory-note-writer.js` | 345 | decide | — | memory-note-writer: Write vault mirror notes for LanceDB memory records. | T7b vault writers and policies, owner-gated |
| `lib/obsidian/graph-link-writer.js` | 340 | decide | — | graph-link-writer: Wikilink injection for record notes | T7b vault writers and policies, owner-gated |
| `lib/obsidian-semantic-discovery-flow.js` | 231 | decide | — | One-time, identity/scope/digest-bound Semantic Discovery confirmation flow. | T7b vault writers and policies, owner-gated |
| `lib/obsidian-review-authority.js` | 220 | decide | RE-07 | Protected Obsidian review authority. | T7b vault writers and policies, owner-gated |
| `lib/obsidian/archive-rotation.js` | 191 | decide | — | for (const ext of ARCHIVE_EXTS) { | T7b vault writers and policies, owner-gated |
| `lib/obsidian/safe-paths.js` | 174 | decide | — | if (text === "~") return homedir(); | T7b vault writers and policies, owner-gated |
| `lib/obsidian-vault-confirmation-flow.js` | 151 | decide | RE-07 | One-time identity- and vault-bound confirmation for protected vault receipts. */ | T7a `admin.obsidian.confirm` uses it; the vault writes behind it are T7b |
| `lib/obsidian-vault-authority.js` | 136 | decide | RE-07 | Protected, owner-partitioned vault confirmation receipts. */ | T7b vault writers and policies, owner-gated |
| `lib/obsidian/record-index.js` | 126 | decide | RE-02 | "sources", | T7b vault writers and policies, owner-gated |
| `lib/obsidian/semantic-duplicate-scan.js` | 112 | decide | — | return new Set(String(text \|\| "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((part) => part.length > 2)); | T7b vault writers and policies, owner-gated |
| `lib/obsidian/dashboard-generator.js` | 104 | decide | — | ["index.md", "source", "PLUR1BUS Living Dashboard", "sources"], | T7b vault writers and policies, owner-gated |
| `lib/obsidian/record-schema.js` | 97 | decide | — | "memory_candidate": "memory-candidates", | T7b vault writers and policies, owner-gated |
| `lib/obsidian/record-writer.js` | 73 | decide | — | `# ${title}`, | T7b vault writers and policies, owner-gated |
| `lib/obsidian/weekly-synthesis.js` | 71 | decide | — | d.setUTCDate(d.getUTCDate() + 4 - day); | T7b vault writers and policies, owner-gated |
| `lib/obsidian/bases-generator.js` | 69 | decide | — | ["memory-candidates.base", "memory_candidate", "Memory Candidates"], | T7b vault writers and policies, owner-gated |
| `lib/obsidian/frontmatter.js` | 67 | decide | RE-04 | if (value === null \|\| value === undefined) return ""; | T7b vault writers and policies, owner-gated |
| `lib/obsidian/maintenance-deep.js` | 66 | decide | — | Remove missing-<field>-<uuid>.md task files whose source record now has all required fields. | T7b vault writers and policies, owner-gated |
| `lib/obsidian/project-hub-builder.js` | 56 | decide | — | return [`## ${title}`, "", rows.length ? rows.map((row) => `- ${row}`).join("\n") : "- None generated.", ""].j | T7b vault writers and policies, owner-gated |
| `lib/obsidian/tasks-generator.js` | 51 | decide | — | if (priority === "high") return "priority: high"; | T7b vault writers and policies, owner-gated |
| `lib/obsidian/managed-blocks.js` | 50 | decide | — | return createHash("sha256").update(String(value \|\| ""), "utf8").digest("hex"); | T7b vault writers and policies, owner-gated |
| `lib/obsidian/adversarial-deep.js` | 49 | decide | — | ignore\s+(all\s+)?(previous\|system\|developer\|higher-priority)\s+(instructions\|messages\|rules)/i, | T7b vault writers and policies, owner-gated |
| `lib/obsidian/link-index.js` | 48 | decide | — | return "sha256:" + createHash("sha256").update(raw, "utf8").digest("hex"); | T7b vault writers and policies, owner-gated |
| `lib/obsidian/semantic-conflict-graph.js` | 42 | decide | — | return String(record.statement \|\| record.summary \|\| record.text \|\| record.title \|\| "").toLowerCase().r | T7b vault writers and policies, owner-gated |
| `lib/obsidian/memory-explain-builder.js` | 39 | decide | — | if (!mutationAllowed(options.mutationPolicy, "vault_write")) { | T7b vault writers and policies, owner-gated |
| `lib/obsidian/link-suggestions.js` | 37 | decide | — | if (!mutationAllowed(options.mutationPolicy, "vault_write")) { | T7b vault writers and policies, owner-gated |
| `lib/obsidian/conflict-collector.js` | 34 | decide | — | for (const record of index.records) { | T7b vault writers and policies, owner-gated |
| `lib/obsidian/impact-analysis.js` | 32 | decide | — | if (!mutationAllowed(options.mutationPolicy, "vault_write")) { | T7b vault writers and policies, owner-gated |
| `lib/obsidian/provenance-graph.js` | 27 | decide | — | if (!mutationAllowed(options.mutationPolicy, "vault_write")) { | T7b vault writers and policies, owner-gated |
| `lib/obsidian/property-normalizer.js` | 24 | decide | — | "plur1bus_type", | T7b vault writers and policies, owner-gated |
| `lib/obsidian/conflict-report.js` | 23 | decide | — | if (!mutationAllowed(options.mutationPolicy, "vault_write")) { | T7b vault writers and policies, owner-gated |
| `lib/obsidian/evidence-scorer.js` | 16 | decide | — | if (/user\|tool\|system\|curated/.test(trust)) score += 0.25; | T7b vault writers and policies, owner-gated |
| `lib/obsidian/dataview-generator.js` | 13 | decide | — | if (where) filters.push(where); | T7b vault writers and policies, owner-gated |
| `lib/obsidian/link-hygiene.js` | 9 | decide | — | return index.records | T7b vault writers and policies, owner-gated |
| `lib/shared-memory-migration.js` | 1174 | port | RE-07 | closeSync, | ported as far as `admin.migrate` needs (RE-07 T2/T4); list what is left out in the PR |
| `engine/stores/adopt.js` | 635 | port | RE-02, RE-07 | `Engine.stores.adopt` (contract 1.11.0). |  |
| `engine/memory-ops/unimport.js` | 621 | port | RE-07 | `MemoryOps.unimport` (contract 1.13.0). |  |
| `engine/memory-ops/import.js` | 603 | port | RE-07 | `MemoryOps.import` (contract 1.11.0). |  |
| `lib/reembedding/lance-backend.js` | 559 | port | RE-07 | existsSync, |  |
| `engine/memory-ops/rebind-ledger.js` | 475 | port | RE-02, RE-07 | sidecar JSONL for `memory.rebind` |  |
| `engine/memory-ops/proposals.js` | 418 | port | RE-07 | E2 Tasks 5 and 6 (spec decision D31): |  |
| `lib/reembedding/coordinator.js` | 364 | port | RE-03, RE-07 | verifyMigrationConfirmation, |  |
| `engine/memory-ops/rebind.js` | 352 | port | RE-07 | `MemoryOps.rebind` / `unbind` (contract 1.12.0). |  |
| `lib/reembedding/state-store.js` | 331 | port | RE-03, RE-07 | closeSync, |  |
| `engine/memory-ops/read.js` | 329 | port | RE-07 | E1 Task 4: typed MemoryOps `list` and `show`. |  |
| `engine/memory-ops/write.js` | 302 | port | RE-07 | E1 Task 5: typed MemoryOps `forget` and `correct`. |  |
| `engine/admin/obsidian.js` | 301 | port | RE-07 | E2 Task 7: AdminOps.obsidian, explicit paths, no host runtime. |  |
| `lib/health-watch.js` | 274 | port | RE-07 | Health watch: two signal sources the Memory Health scan cannot see. | two signal sources the health scan cannot see → `engine.status` (RE-07 T4) |
| `engine/memory-ops/proposal-store.js` | 243 | port | RE-07 | E2 Task 5 (spec decision D31): the |  |
| `engine/memory-ops/link.js` | 237 | port | RE-07 | `MemoryOps.link` (contract 1.16.0). |  |
| `lib/reembedding/switch-runtime.js` | 230 | port | RE-07 | return Object.freeze({ |  |
| `engine/memory-ops/import-ledger.js` | 226 | port | RE-07 | sidecar JSONL for `memory.import` |  |
| `engine/memory-ops/shared.js` | 220 | port | RE-07 | E2 Task 4 (spec decision D31): shared copies. |  |
| `engine/memory-ops/import-lock.js` | 213 | port | RE-02, RE-07 | per-agent writer lock for the apply path |  |
| `engine/memory-ops/link-ledger.js` | 201 | port | RE-07 | sidecar JSONL for `memory.link` |  |
| `engine/memory-ops/unimport-ledger.js` | 198 | port | RE-07 | write-ahead audit sidecar for |  |
| `lib/reembedding/planner.js` | 197 | port | RE-07 | compareEmbeddingFingerprints, |  |
| `engine/status/status-reporter.js` | 168 | port | RE-07 | assembles `EngineStatus` (types/engine.d.ts, |  |
| `lib/reembedding/runtime-probe.js` | 121 | port | RE-07 | if ( |  |
| `engine/store/control-health.js` | 107 | port | RE-07 | control-plane health constants and the partition/row inspectors. |  |
| `engine/memory-ops/context.js` | 85 | port | RE-07 | Binds MemoryOps calls to the host: Principal → memory request context, plus the fail-closed guards. |  |
| `lib/reembedding/generation-layout.js` | 85 | port | RE-07 | if (typeof value !== "string" \|\| !GENERATION_RE.test(value)) throw new Error("invalid active embedding gener |  |
| `lib/reembedding/confirmation.js` | 75 | port | RE-07 | return createHash("sha256") |  |
| `engine/memory-ops/import-digest.js` | 68 | port | — | per-group row digests recorded on |  |
| `engine/memory-ops/import-id.js` | 49 | port | — | deterministic card ids for `memory.import` |  |
| `engine/memory-ops/errors.js` | 27 | port | — | "not-found", "denied", "invalid-input", "approval-required", |  |
| `lib/curation-resolve.js` | 27 | port | RE-07 | human keep/drop for neo conflict records. | on `main` reached only through the chat command module; engine behaviour all the same |

### RE-08

| File | Lines | Disposition | Named in | Purpose | Note |
|---|---:|---|---|---|---|
| `lib/platform.js` | 453 | fold | RE-08 | the four platform decisions, in one place. | `platform.rs`: the four platform decisions as a table |
| `lib/safe-logging.js` | 421 | fold | RE-08 | Safe error logging helpers. | engine logs through `plur1bus-log-schema`; carry missing redaction patterns into `packages/log-schema` |
| `lib/log-redact.js` | 216 | fold | RE-08 | Content-free descriptors for log lines. Logs may carry ids, lengths, counts | redaction patterns → `packages/log-schema/schema/redaction.json` |
| `lib/windows-acl-parse.js` | 119 | fold | RE-08 | Strict, locale-independent parsers for the Windows ACL fast path. | `plur1bus-rpc` `acl.rs` |
| `lib/metrics-debounce.js` | 88 | fold | RE-08 | In-memory accumulator + debounced flush for metrics writes. | `engine.status` counters |
| `lib/metrics.js` | 83 | fold | RE-08 | Lightweight metrics accumulator for /zustand and Doctor. | `engine.status` counters |
| `lib/peercred.js` | 68 | fold | RE-08 | optional Linux SO_PEERCRED (uid of the socket peer). | `plur1bus-rpc` peer credentials |
| `lib/event-loop-lag-snapshot.js` | 63 | fold | RE-08 | cheap event-loop lag snapshot. | not applicable (no event loop); report scheduler lag instead |
| `lib/private-fs.js` | 57 | fold | RE-08 | Owner-only file and directory modes for sidecar files that hold message text | `plur1bus-rpc`/supervisor file modes |
| `lib/process-singleton.js` | 30 | fold | RE-08 | singleton.js (7.12.36) | supervisor lock identity |

### RE-13

| File | Lines | Disposition | Named in | Purpose | Note |
|---|---:|---|---|---|---|
| `lib/review-workspace-status.js` | 167 | port | RE-13 | what the agent's workspace last wrote, for | the evening profile of `daily-review` (RE-13 T3, Phase 2); golden from `collectReviewWorkspaceStatus` |
| `lib/review-narrative-lead.js` | 95 | port | RE-13 | Deterministic, fail-open prose lead for PLUR1BUS reviews (morning/evening). | the lead of `daily-review` (RE-13 T3, Phase 2); golden per mood from `buildReviewNarrativeLead` |

### Dropped (no owner)

| File | Lines | Disposition | Named in | Purpose | Note |
|---|---:|---|---|---|---|
| `lib/obsidian-control-room.js` | 4006 | drop | RE-07, RE-13 | PLUR1BUS Obsidian Bridge control-room layer. | adapter surface: OpenClaw chat commands, dashboard projection, control room; the review digest (`:1276-1600`) is the behaviour reference of RE-13 T3, the vault-change proposals and apply flows are RE-07 T7b |
| `engine/commands/plur1bus-command.js` | 1227 | drop | — | The /plur1bus chat command (was index.js:7271-9055), including the 17 | adapter surface: OpenClaw chat commands, dashboard projection, control room |
| `lib/providers/scoped-embedding-ipc.js` | 1109 | drop | RE-03, plan | closeSync, | RE-D4: `engine.embedding.*` RPC replaces the IPC |
| `engine/tools/memory-tools.js` | 957 | drop | RE-07 | The five model-facing memory tools — `memory_recall`, `memory_search`, | adapter surface: OpenClaw chat commands, dashboard projection, control room |
| `lib/telegram-commands/skill-commands.js` | 831 | drop | RE-13 | Telegram command handlers for skill-miner proposals. | adapter surface; the activate, reject and retire semantics (`:253`, `:506`, `:667`) are the behaviour reference of RE-13 T2 |
| `lib/telegram-commands/memory-edit.js` | 649 | drop | — | /forget + /correct — direct user intervention in the Memory Store. | adapter surface: OpenClaw chat commands, dashboard projection, control room |
| `lib/control-plane-health.js` | 520 | drop | — | Number.isSafeInteger(value) && value >= 0 ? value : null | adapter surface: OpenClaw chat commands, dashboard projection, control room |
| `lib/telegram-commands/memory-query.js` | 515 | drop | — | /memory — Inspection command. | adapter surface: OpenClaw chat commands, dashboard projection, control room |
| `engine/commands/command-helpers.js` | 436 | drop | — | command helpers: maintenance nudges, JSON/skill formatting, the direct-cron guard, the Neo/conflict-summary he | adapter surface: OpenClaw chat commands, dashboard projection, control room |
| `lib/memory-doctor.js` | 292 | drop | RE-07 | Diagnostic helper for interpretation overlays. | the `/plur1bus doctor` chat report; the harness has `1staid check` and `engine.status` (RE-07 T4) — reachable only through the chat commands |
| `lib/telegram-commands/feature-toggle.js` | 254 | drop | — | /enable + /disable — Feature toggle. | adapter surface: OpenClaw chat commands, dashboard projection, control room |
| `lib/security.js` | 183 | drop | RE-07 | Telegram/Chat Auth & ACL for PLUR1BUS. | chat auth/ACL; the owner gate is the core RBAC (docs/rbac.md), the engine receives the caller principal |
| `lib/native/sharp-unavailable.js` | 176 | drop | — | probe `sharp`, and when it cannot load | transformers.js workaround |
| `lib/overlay-commands.js` | 144 | drop | — | return JSON.stringify(value, null, 2); | chat commands for interpretation overlays; the overlay data itself is RE-04 (read) and RE-06 (writer) |
| `lib/critical-buttons.js` | 122 | drop | RE-05, RE-13 | Critical Push mit Telegram-Knöpfen (7.16.10). | push-button delivery; `pushCriticalButtons` is dropped; the inbox entry of RE-13 T1 replaces the message per card |
| `lib/feature-crons-hint.js` | 116 | drop | RE-06 | the feature-cron setup marker path, the | OpenClaw cron registration marker; `JobSpec.default_schedule` carries the schedules |
| `lib/install/soul-patcher.js` | 102 | drop | — | return [ | patches the OpenClaw SOUL.md |
| `lib/control-plane-storage.js` | 90 | drop | — | Deckel gegen unbegrenzte Laeufe: so viele Eintraege werden hoechstens besucht. */ | adapter surface: OpenClaw chat commands, dashboard projection, control room |
| `lib/llm-warmth.js` | 89 | drop | RE-06 | Cold-start guard for plugin LLM calls under OpenClaw 2026.9.7. | OpenClaw 2026.9.7 cold-start workaround |
| `lib/critical-push-state.js` | 85 | drop | RE-13 | critical-push-state — Datei-basierte Tageszähler pro Agent. | push delivery budget; `pushCriticalButtons` is dropped; the inbox dedupe per card (RE-13 T1) replaces the daily counter |
| `lib/temperament-command.js` | 82 | drop | — | Pure Helpers für /plur1bus temperament. | chat command |
| `lib/internal-cron-reply.js` | 72 | drop | RE-06 | Convert an Afterthought job result into a direct OpenClaw cron reply. | OpenClaw cron reply protocol (`NO_REPLY`) |
| `lib/host-paths.js` | 49 | drop | RE-08 | path defaults for lib/ modules on the engine graph. | Node module plumbing |
| `lib/native/sharp-stub.js` | 43 | drop | — | callable stand-in for `sharp` when the native | transformers.js workaround |
| `lib/host-sdk-loader.js` | 24 | drop | RE-08 | the one seam lib/ uses to reach a host SDK module | Node module plumbing |
| `lib/plugin-meta.js` | 17 | drop | RE-08 | the plugin's root directory and version, read once. | Node module plumbing |
