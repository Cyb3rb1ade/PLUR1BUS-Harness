# ADR-006: Embedding and reranking service

**Status:** Proposed · **Date:** 2026-09-22 · **Deciders:** Christian (owner) · **Inputs:** `docs/phase0/brief.md` D2, D6, D9 · `docs/phase0/auftrag-original-2026-09-21.md` §6, §6.2, §10, §11 · `docs/phase0/research/providers-embedding-rerank.md` (all) · `docs/phase0/research/plur1bus-crons-embedding-portability.md` §2 (and §3 for `/share`) · `docs/phase0/research/platform-binaries-and-startup.md` (binaries table) · PLUR1BUS checkout `/home/claude/refs/openclaw-plur1bus-memory` @ `89148f9`

## Context

D9 makes embedding **and** reranking mandatory core capabilities and names the owner: the PLUR1BUS engine, in-process (Transformers.js/ONNX) and remote. §6.2 adds the operating rules — one load per local model, `embed()`/`rerank()` offered to the rest of the harness with purpose-bound quotas, harness supplies provider profiles, secret leases, model catalogue and UI, new adapters land as PRs in the PLUR1BUS repo so the OpenClaw plugin gets them too.

What exists today, verified in the checkout at `89148f9`:

- Two embedding providers (OpenAI SDK, local ONNX via `@huggingface/transformers`) and two rerankers (Cohere HTTP, local ONNX) behind one factory (`lib/providers/factory.js:9-27`, `:29-67`).
- **Timeouts confirmed:** embed 15 s (`lib/providers/config-normalize.js:63`, `DEFAULT_EMBEDDING_REQUEST_TIMEOUT_MS = 15_000`), rerank 5 s (`config-normalize.js:158`, `timeoutMs = raw.timeoutMs ?? 5000`). SDK retries are already disabled in the hot path (`lib/providers/embedding-openai.js:117-129`, `maxRetries: 0`).
- **Local models are pinned by revision and per-artifact SHA-256**, downloaded from `https://huggingface.co/{repo}/resolve/{revision}/{path}` with streaming hash verification and re-verification of existing files (`lib/providers/local-model-artifacts.js:18-113`, `:207-236`, `:255-256`, `:290-315`).
- **Non-commercial licences are already gated** by an explicit flag (`assertPinnedModelLicenseAccepted(profile, acceptNonCommercialLicense)`, `local-model-artifacts.js:158`, `:458`, `:468`; recorded in normalized config at `config-normalize.js:107`).
- **A single `vectorDim` scalar is threaded through every pool** — `new MultiNamespacePool(namespaceLayout, vectorDim, …)` and `new SharedMemoryPool(…, vectorDim, …)` at `index.js:5594-5595` — so one uniform dimension is assumed across private, workspace and user tables.
- **`/share` already re-embeds** rather than copying the stored vector: `const vector = await embeddings.embed(card.text || card.summary, { agentId: sourceAgent });` (`lib/telegram-commands/memory-edit.js:508`).
- **The embedding owner is a separate process reached over a Unix domain socket** at `<stateRoot>/control/embedding-ipc/owner.sock` (`lib/providers/scoped-embedding-ipc.js:284`, listen + `chmod 0o600` at `:434-435`), with a clean newline-JSON envelope `{dimensions, fingerprintId, model, request, token}`, `operation ∈ {query, passage, batch}`, caps `MAX_EMBED_TEXTS 64` / `MAX_REQUEST_BYTES 256 KiB`, and a `timingSafeEqual` token plus model/dimension/fingerprint binding (`:21`, `:24`, `:61-93`, `:199`, `:376-390`).
- **The host has no reranking concept at all** — "OpenClaw has no reranking concept; PLUR1BUS supplies it entirely" (`KNOWN-ISSUES.md:56`).

## Decision

**The engine owns `embed()` and `rerank()` and offers them as an internal service with purpose-bound quotas; the harness supplies profiles, leases, catalogue and UI.** Local models run in-process via `@huggingface/transformers` / `onnxruntime-node`, one load per process, behind the existing embedding-owner IPC — whose transport gains a Windows named-pipe branch while the wire protocol stays byte-identical. Every stored vector carries an **embedding identity**; identities are never mixed, and every change goes through the re-embedding migration. Rerankers are switchable at runtime without migration. The installer's default embedding model moves to a permissively licensed model — recommended, flagged as an owner decision below.

### Runtime and execution providers

| Target | Prebuilt EP to use | Source |
|---|---|---|
| macOS arm64 / x64 | **CoreML**, CPU fallback | `research/platform-binaries-and-startup.md` binaries table (onnxruntime-node 1.30.0 row); `research/providers-embedding-rerank.md` Q1 |
| Windows x64 / arm64 | **DirectML**, CPU fallback | ibid. |
| Linux x64 | **CUDA** (CUDA 12; CUDA 11 dropped since ORT 1.22) where a GPU exists, else CPU | ibid. |
| Linux arm64 | **CPU only** — WebGPU is explicitly not in the prebuilt binaries there | ibid. |

`@huggingface/transformers` 4.3.0 depends on `onnxruntime-node` 1.30.0 (and `onnxruntime-web`), and `onnxruntime-node` ships prebuilt binaries for all six targets in one tarball (`research/providers-embedding-rerank.md` Q1; `research/platform-binaries-and-startup.md`). EP selection is probed once, cached, and shown in the Models page; a failed EP degrades to CPU with a visible warning, never silently.

**Service API** (engine-internal, exposed to the harness over the core's JSON-RPC surface, never to the network):
`embed(texts[], {identity, inputType: "query"|"passage", purpose})` → vectors; `rerank(query, documents[], topN, {reranker, purpose})` → `[{index, score}]`. `purpose` ∈ `memory.capture | memory.recall | session.search | skill.retrieval | project.rag | semantic.links | migration | benchmark`, each with its own quota (rate, concurrency, daily token/cost cap) so a project-RAG job cannot starve recall. Quota state is per purpose × identity × agent.

### Model catalogue (in-process candidates)

| Model | HF id | Type | Dim | Max tok | Prefix / task scheme | Licence | ONNX | Source |
|---|---|---|---|---|---|---|---|---|
| multilingual-e5-small | `intfloat/multilingual-e5-small` | Embedding | 384 | 512 | `query: ` / `passage: ` (required) | **MIT** | Yes, `onnx/model.onnx` in repo | `research/providers-embedding-rerank.md` Q1 → [HF card](https://huggingface.co/intfloat/multilingual-e5-small) |
| Qwen3-Embedding-0.6B | `Qwen/Qwen3-Embedding-0.6B` | Embedding | ≤1024, selectable 32–1024 (MRL) | 32K | `Instruct: {task}\nQuery:{q}` for queries; documents unprefixed | **Apache-2.0** | Yes, `onnx-community/Qwen3-Embedding-0.6B-ONNX` | ibid. |
| Qwen3-Reranker-0.6B | `Qwen/Qwen3-Reranker-0.6B` | Reranker | – | 32,768 | default instruction, customisable | **Apache-2.0** | Yes, `onnx-community/Qwen3-Reranker-0.6B-ONNX`; raw logit-difference score, sigmoid optional | ibid. |
| BGE-reranker-v2-m3 | `BAAI/bge-reranker-v2-m3` | Reranker | – | 512 | query/document pair; `normalize=True` → sigmoid | **Apache-2.0** | **No ONNX in the official repo** (safetensors only) — PLUR1BUS therefore pins a third-party ONNX export: `woxpas-ai/bge-reranker-v2-m3-onnx` @ `c44ebc43…aa18` (`lib/providers/local-model-artifacts.js:105-106`; default at `lib/providers/dimensions.js:20`) | ibid. + checkout |
| Jina embeddings v3 | `jinaai/jina-embeddings-v3` | Embedding | 1024, MRL 32–1024 | 8192 | `task=` adapter (`retrieval.query`/`.passage`), empty prefixes | **CC BY-NC-4.0** | Yes; PLUR1BUS pins a re-export repo `ldwformat/jina-embeddings-v3-Q8-onnx` @ `68ed9490…adc9` | `research/providers-embedding-rerank.md` Q1 (licence re-verified on the card 2026-09-22); `local-model-artifacts.js:38,51` |
| Jina v5 Text Nano | `jinaai/jina-embeddings-v5-text-nano(-retrieval)` | Embedding | 768, MRL 32–768 | 8192 (card) / 32K (v5 family page) | `Query: ` / `Document: `, no task id | **CC BY-NC-4.0** | Yes, `onnx/` per task variant | ibid.; `local-model-artifacts.js:74,80`; `dimensions.js:13-17` |
| Jina reranker v2 base multilingual | `jinaai/jina-reranker-v2-base-multilingual` | Reranker | – | 1024 (sliding window) | pair | **CC BY-NC-4.0** | Yes | ibid.; `local-model-artifacts.js:94` |
| gte-multilingual-base (+reranker) | `Alibaba-NLP/gte-multilingual-base` | Embedding / Reranker | **unverified** | unverified | unverified | **Apache-2.0** | Yes, `onnx-community/*` mirrors | ibid. — candidate only, specs are a documented gap |
| nomic-embed-text-v2-moe | `nomic-ai/nomic-embed-text-v2-moe` | Embedding (MoE) | 768, MRL → 256 | 512 | `search_query: ` / `search_document: ` | **Apache-2.0** | **ONNX unconfirmed** (GGUF exists) | ibid. — candidate only |

Remote embedding: OpenAI `text-embedding-3-small/large` (`dimensions` param), Google `gemini-embedding-2`/`-001` (128–3072; `task_type` only on `-001`), Cohere `embed-v4.0` (details unverified, primary doc 404'd), Jina v5 family, Voyage `voyage-4` family, OpenRouter (pass-through — the identity is the **pinned upstream**), Ollama `/api/embed`. **Anthropic offers no embedding API and recommends Voyage** (`research/providers-embedding-rerank.md` Q2). Remote rerank: Cohere, Jina, Voyage; self-hosted TEI, vLLM, llama.cpp, oMLX, Infinity.

### Installer / wizard default — owner decision

§6.2 proposes Jina v5 Text Nano as the suggested default with a licence confirmation. Evidence gathered since: Jina v3, v5-text-nano and reranker v2 are all **CC BY-NC-4.0** (`research/providers-embedding-rerank.md` Q1; PLUR1BUS's own metadata agrees, `local-model-artifacts.js:50-51,79-80` carrying `commercialUse:false`), while Qwen3-Embedding-0.6B / Qwen3-Reranker-0.6B are **Apache-2.0 with maintained ONNX mirrors**, and the repo is MIT and public (D10).

| Default option | Licence | Pros | Cons |
|---|---|---|---|
| **A. E5-small (MIT), keyless** | MIT | Smallest, already the local default (`dimensions.js:4-5`), no licence dialog, 384-d keeps stores small | 512-token cap; weakest quality of the three |
| **B. Qwen3-Embedding-0.6B (Apache-2.0)** — *recommended* | Apache-2.0 | Permissive, 32K context, Matryoshka 32–1024, ONNX mirror, pairs with an Apache-2.0 reranker (Qwen3-Reranker-0.6B or BGE-v2-m3) | Larger download and RAM than E5; RAM figures are an open gap (`research/providers-embedding-rerank.md` Q1 Gaps) |
| C. Jina v5 Text Nano (as §6.2 suggested) | CC BY-NC-4.0 | Strong quality, 768-d with MRL, already pinned in PLUR1BUS | Non-commercial: every install needs an explicit owner confirmation, and any commercial user of an MIT harness is blocked by default |
| D. Hosted (OpenAI/Gemini/Voyage) | vendor terms | No local RAM/CPU cost | Needs a key at first run; sends memory content off-box; contradicts "works keyless out of the box" |

**Resolution (2026-09-22, replaces a single fixed default): ask a use-class question in the wizard.** The owner asked directly: *"if the user agrees and uses it for their own purpose?"* — CC BY-NC-4.0 does permit personal, non-commercial use, and the harness already has the mechanism for exactly that: the owner-only, audit-logged `acceptNonCommercialLicense` gate (`local-model-artifacts.js:158,458,468`). So instead of one option pre-selected for every install, the wizard asks **"Personal / non-commercial use?"** before offering an embedding model:
- **Yes:** **C. Jina v5 Text Nano** is pre-selected — §6.2's original suggestion, now correctly scoped to the use class it fits — with the explicit NC-licence confirmation still required and still audit-logged.
- **No / commercial / unsure:** **B. Qwen3-Embedding-0.6B (Apache-2.0)** is pre-selected, for the reasons in the table above.
- **Non-interactive install:** always **A. E5-small (MIT)**, unless an explicit flag or environment variable confirms the NC licence — never a silent acceptance either way.

**D (hosted)** stays an explicit, never-pre-selected alternative in both branches, per its cons above. This keeps §6.2's own suggestion available to the audience it was written for, while a commercial user of the MIT harness is never blocked by a licence dialog they cannot pass. Marked **owner decision** — the resolution is recorded under *Conflicts with the brief*, which no longer treats this as "drop Jina" but as "ask which audience is installing."

**Non-interactive install:** confirmation for an NC model only via an explicit flag or environment variable; otherwise fall back to E5 — **never a silent acceptance**. Only the Owner may confirm; the confirmation (who, when, which licence, which model+revision) goes to the audit log (§6.2, §11). The same procedure applies to NC rerankers.

### Embedding identity

**identity = model + revision/artifact hash + quantisation + dimension + prefix/task scheme + normalisation + token cap (+ pinned upstream for aggregators).** Stored per store **and per generation**, and part of **every** cache key. Today's cache key is `provider \x00 model \x00 dimensions \x00 scopeId \x00 cacheVersion \x00 textHash` (`lib/embedding-cache.js:57-58`) — correct under a dimension change but not under a revision, quantisation or prefix-scheme change; it must carry the full identity hash.

Rules:

1. **Never mix vector spaces.** A query vector is only ever compared against vectors of the same identity.
2. **Identity change only via re-embedding migration:** prepare target → dry-run (cost and duration estimate, rate limit, batch size) → copy into a **new generation** → separate switch → old generation retained for rollback. Per-store controllable in the UI, resumable. PLUR1BUS already has the gateway methods (`plur1bus.reembedding.{plan,apply,resume,rollback,status,switch}`, `research/plur1bus-host-contract.md` §7) and the state store; the harness drives them.
3. **Per-agent/per-store identities are allowed** (§5, §6.2). Consequences: `/share` copies text and **re-embeds in the target pool's identity** — PLUR1BUS already does exactly this (`lib/telegram-commands/memory-edit.js:508`), so what changes is removing the dimension-equality assumption around it (`lib/shared-memory.js:202-207`).
4. **Multi-identity recall:** embed the query **once per identity** present in the routed stores, then **fuse by rank** (RRF) or by a single reranker over the merged candidate set — never by raw score, because distances from different models are not comparable (`research/plur1bus-crons-embedding-portability.md` §2; today `1/(1+distance)` scores are compared directly across tables). Removing the single-dimension assumption is a **PR against the PLUR1BUS repo** (D3): the `vectorDim` scalar at `index.js:5594-5595` becomes a per-route/per-DB value, `MemoryDB` gains a per-DB dimension, the recall pipeline holds one vector per identity instead of a single `queryVector`, and fusion switches to rank-based.
5. **Failover only within one identity** — a second key or a second server serving the identical model/revision/quantisation/dimension.
6. **Compatibility probe before first use of an endpoint for an existing store:** embed a fixed probe set, compare against stored reference vectors (cosine within tolerance); on deviation, refuse the endpoint and say why. Reference vectors are written when the generation is created.
7. **RAM budget** across concurrently loaded local models: a configured cap, LRU unload of idle models, pinning for the always-hot ones, a warning when creating an agent with a new local model. Today the shared pool only calls `resource.dispose()` with no RSS accounting, and the known issue notes that loading a local embedding model exceeds the host's 1 GiB-per-window RSS growth heuristic *by design* (`lib/providers/local-transformers-shared-pool.js:138-141`; `KNOWN-ISSUES.md:57-62`).
8. **Outage behaviour:** capture writes to the journal and embeds later (reuse/extend the existing embedding queue drained by the `embedding-drain` cron, `index.js:8081-8095`); recall **degrades visibly** to lexical (SQLite FTS5) and recency ranking rather than blocking. The degraded state is shown in the UI, per §2.1's "operation without memory only as a visibly marked degraded state".

### Timeouts, thresholds, calibration

- **Embed 15 s, rerank 5 s** per request, as today (`config-normalize.js:63`, `:158`), **no SDK retries in the hot path** (`embedding-openai.js:117-129`). Two corrections to today's behaviour: the per-text serial fallback loop after a failed batch (`embedding-openai.js:159-196`) is a latency cliff inside a 15 s budget and must be bounded; and the rerank timeout is currently enforced twice, inside the Cohere provider and again as a `Promise.race` in the pipeline (`lib/providers/reranker-cohere.js:13-15`, `lib/recall-pipeline.js:1466`) — one owner for that timer.
- **Thresholds are bound to the identity:** duplicate 0.95, reserved band ≥ 0.96, semantic links 0.78 (§6.2). After any identity change a **calibration run** measures the noise band and margins on a sample, proposes new thresholds, and warns on a narrow similarity cone. Per-reranker thresholds are separate, or rank-based fusion is used instead.
- **Local models:** token cap default 512 against OOM, bounded CPU budget and parallelism (both displayed), warm-up at start so the first recall is not the slowest (D6), download manager with progress, resume and offline import, **SHA-256 pinning per artifact** — which PLUR1BUS already does and which is ported as-is (`local-model-artifacts.js:207-236,290-315`). Note the supply-chain caveat: two pinned artefacts come from third-party re-export repos (`ldwformat/…` for Jina v3, `woxpas-ai/…` for BGE), so an offline mirror bundle is part of the plan.

### Rerankers

Switchable at runtime, per installation default and per agent, **without data migration** (they touch no stored vector). Timeout 5 s with fallback to pure vector ranking — today's fallback is near-silent apart from one `logger.warn` plus a decision-trace guard (`lib/recall-pipeline.js:2021-2058`); the harness surfaces it in the recall explain view. Scores from different rerankers are not comparable (`research/providers-embedding-rerank.md` Q3/Q5, citing the score-calibration source), so thresholds are per reranker or fusion is rank-based.

**Normalised interface:** `rerank(query: string, documents: string[], topN?: number, model: string) => Promise<{index: number, score: number}[]>`.

| Wire format | Request | Response | Status |
|---|---|---|---|
| Cohere | `{model, query, documents[], top_n}` | `{results:[{index, relevance_score}]}` | Confirmed |
| Voyage | `{query, documents[], model, top_k, truncation}` | `{results:[{index, document, relevance_score}], total_tokens}` | Confirmed |
| Jina | `{model, query, documents[], top_n, return_documents}` | presumed Cohere-shaped — **unverified** | Request confirmed only |
| HF TEI | `{query, texts[], raw_scores}` — note `texts`, not `documents` | **unverified** | Request confirmed only |
| vLLM | Cohere-compatible `/v1/rerank` plus `/v1/score` | **unverified** | Endpoint confirmed |
| llama.cpp | `/v1/rerank` and `/rerank` behind `--reranking`, `query/documents/top_n` | **unverified** | Flag + endpoints confirmed |
| oMLX | `POST /v1/rerank` | **unverified** | Endpoint confirmed |
| Ollama | **none** — open issue #3368, unmerged PR #7219 | – | Confirmed absent |
| LM Studio | **none** — three open feature requests | – | Confirmed absent |

All from `research/providers-embedding-rerank.md` Q3–Q5. The five unverified response shapes are the single largest remaining gap for the adapter spec and are resolved by a live smoke test against each server, not by guessing.

### Embedding-owner IPC

Keep PLUR1BUS's envelope and token protocol unchanged — `{dimensions, fingerprintId, model, request, token}` with `operation ∈ {query, passage, batch}`, the size caps, the `timingSafeEqual` token check and the model/dimension/`embedding:v1:sha256:<64hex>` fingerprint binding (`scoped-embedding-ipc.js:61-93`, `:199`, `:376-390`). **Replace only the transport on Windows:** a named pipe `\\.\pipe\plur1bus-embedding-<sha256(stateRoot)[0:32]>` secured by a pipe ACL at creation instead of `owner.sock` + `chmod 0o600` (`:284`, `:434-435`); `lstatSync().isSocket()` checks give way to the existing connect-probe (`:174-195`), and the darwin 103-byte path guard at `:270-276` is the precedent for adding a `win32` branch in the same function. Owner election already falls back to an exclusive loopback TCP bind on non-Linux (`:207-216`); on Windows an exclusive named pipe is the better claim primitive (no firewall prompt). This is a **PR to the PLUR1BUS repo** (D3), not a harness workaround.

### Benchmark

Extend the existing `bench/` (`run.mjs`, `ingest.mjs`, `report.mjs`, `lib/`, `results/`, `analysis/`, `findings/`) into (a) a **CI regression gate** — real recall queries against a reference ranking, failing on a drop beyond a tolerance — and (b) a **decision aid in the UI**: when the operator considers a model change, run the benchmark on that store's own queries and show the delta in nDCG/recall@k, duration and estimated migration cost next to the migration button (§6.2 "Qualitätssicherung").

## Options considered

### Option A: Models in-process in the core (with the existing owner-IPC hop) — **recommended**
| Dimension | Assessment |
|---|---|
| Complexity | Medium — the IPC and the pinning already exist |
| Fit with brief D1–D11 | Full: D9's "owner is the engine, in-process", §6.2's "each local model loaded exactly once" |
| Cross-platform risk | Medium: `onnxruntime-node` prebuilds cover all six targets, but the socket transport needs the Windows branch above |
| Maintenance burden | Ours, but shared with the OpenClaw plugin via upstream PRs |
| Latency / token cost | Lowest — one process boundary at most, warm models, no HTTP |

**Pros:** warm-up under the core's control (D6); no extra runtime to install; the IPC already binds identity and authenticates. **Cons:** a model load spikes RSS in the process that also serves recall — documented today as `liveness warning` diagnostics (`KNOWN-ISSUES.md:57-62`); an ONNX crash is closer to the core.

### Option B: Sidecar model process per identity
| Dimension | Assessment |
|---|---|
| Complexity | Higher — lifecycle, supervision, health, restart-storm control |
| Fit with brief | Compatible; §4 already allows a separate process with token-secured IPC |
| Cross-platform risk | Same transport question, plus process management on three OSes |
| Maintenance burden | Higher |
| Latency / token cost | One extra hop per call; cold sidecar start on first use |

**Pros:** real memory isolation — an OOM or a native crash kills one identity, not the core; per-identity RAM caps are enforceable by the OS. **Cons:** more moving parts, slower first call, and the existing owner process already provides partial isolation.

**Chosen: A now, with B kept as a per-identity escalation** — the embedding owner is already a separate process, so "one owner per identity, supervised" is an incremental step if the RAM-budget work proves insufficient. The IPC envelope is transport- and process-agnostic, so this choice is reversible.

### Option C: Remote-only (hosted embeddings/rerank)
Rejected: contradicts D9 and §6.2's keyless fallback, sends memory content off-box by default, and makes recall depend on the network — the opposite of the fail-soft requirement in §2.1.

## Trade-off analysis

The expensive, irreversible decisions here are the **identity definition** and the **removal of the single-`vectorDim` assumption**; everything else (which model, which reranker, which EP) is configuration. Getting identity wrong is a silent-corruption class of bug: a revision or prefix-scheme change with an unchanged dimension passes today's only guard (`lib/providers/dimension-guard.js:1-40`, which compares Arrow `listSize`), so the harness would keep answering — with quietly worse recall. That argues for putting the full identity in the cache key and the generation record from day one, even before multi-identity recall ships. Conversely, the default-model question is cheap to revisit per install, which is why it is presented as an owner decision rather than settled unilaterally — except that the licence dimension is not reversible for downstream users of an MIT repo, which is what tips the recommendation to Apache-2.0.

## Consequences

- **Easier:** one owner for both capabilities, so quotas, caching and warm-up live in one place; per-agent/per-store model choice becomes expressible; migrations are auditable and reversible; the OpenClaw plugin benefits from every adapter because the work lands upstream; the default install needs no licence dialog and no API key.
- **Harder:** the single-dimension removal touches pool construction, `MemoryDB`, the recall pipeline and the share path (`index.js:5594-5595`, `lib/multi-namespace-pool.js:210-212,335-366`, `lib/recall-pipeline.js:1531,1670`, `lib/shared-memory.js:202-207`) — a behaviour-neutrality test burden; rank fusion replaces score comparison, so tuned thresholds must be recalibrated; a RAM budget with LRU unload can make a rarely used agent's first recall slow; five rerank wire formats still need live verification; two pinned artefacts depend on third-party re-export repos staying online.
- **Revisit when:** an official ONNX export of `BAAI/bge-reranker-v2-m3` appears (drops the third-party pin); Jina relicenses; a target platform loses its prebuilt EP; the benchmark shows the default model is materially worse on the owner's own corpus.

## Conflicts with the brief

**Finding.** §6.2 names the suggested installer default as *"Jina v5 Text Nano (CC BY-NC 4.0, nicht kommerziell — ausdrückliche Bestätigung nötig)"*. Research since shows all three Jina models in scope are CC BY-NC-4.0, while Apache-2.0 alternatives of comparable class with maintained ONNX mirrors now exist (Qwen3-Embedding-0.6B / Qwen3-Reranker-0.6B). Defaulting a public MIT product (D10) to a non-commercial model means the out-of-the-box path requires a licence acceptance that a commercial user cannot give.

**Source.** §6.2 vs. `research/providers-embedding-rerank.md` Q1 (licences quoted from the model cards, checked 2026-09-22: [jina-embeddings-v5-text-nano](https://huggingface.co/jinaai/jina-embeddings-v5-text-nano) `cc-by-nc-4.0`; [Qwen3-Embedding-0.6B](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B) and [Qwen3-Reranker-0.6B](https://huggingface.co/Qwen/Qwen3-Reranker-0.6B) `apache-2.0` with `onnx-community/*-ONNX` mirrors), corroborated by PLUR1BUS's own metadata `license: "CC-BY-NC-4.0", commercialUse: false` (`local-model-artifacts.js:50-51,79-80`).

**Options.** (i) Keep §6.2's suggestion and default to Jina v5 Text Nano with the confirmation dialog. (ii) Default to Qwen3-Embedding-0.6B (Apache-2.0), keep E5-small as the keyless fallback, and offer the Jina models as an explicit, never-pre-selected choice with the existing confirmation gate. (iii) Default to E5-small (MIT) and let the wizard recommend an upgrade after a benchmark run on the user's own data. **(iv) — added 2026-09-22, adopted:** don't pick one fixed default at all; ask a **use-class question** in the wizard ("Personal / non-commercial use?") and pre-select Jina v5 Text Nano on "yes" (with the explicit NC confirmation) or Qwen3-Embedding-0.6B on "no/commercial/unsure", with E5-small as the non-interactive default unless an explicit flag/env confirms the NC licence.

**Recommended resolution: (iv), superseding the earlier (ii).** The owner asked directly whether §6.2's Jina suggestion still applies "if the user agrees and uses it for their own purpose" — and CC BY-NC-4.0 does permit exactly that personal, non-commercial use, which the harness already has a mechanism for (the owner-only, audit-logged `acceptNonCommercialLicense` gate). (ii) resolved the conflict by dropping Jina to an offered-but-never-pre-selected option; (iv) resolves it instead by asking which audience is installing and pre-selecting the model that actually fits — so §6.2's own suggestion is not lost, it is correctly scoped. The wizard still *asks* and still shows the licence notice for Jina, exactly as §6.2 requires, and non-interactive installs still never silently accept an NC licence. **This is an owner decision** — if the owner prefers a single fixed default after all, (i), (ii) or (iii) each remain implementable unchanged, since the gate and both candidate models are already built.

A second, smaller divergence for the record: §6.2 names BGE-v2-m3 as the Apache-2.0 default reranker, but the official repo publishes **no ONNX weights**; PLUR1BUS therefore already pins a third-party ONNX export (`woxpas-ai/bge-reranker-v2-m3-onnx` @ `c44ebc43…`, `local-model-artifacts.js:105-106`). The model licence is unaffected, but the *artefact* provenance is a third party — stated here rather than left implicit, with Qwen3-Reranker-0.6B (first-party-adjacent `onnx-community` mirror) as the alternative. **The same use-class question extends to the reranker (2026-09-22):** BGE-v2-m3 is Apache-2.0 for every use class, so it needs no NC gate at all, but the wizard offers the parallel choice — personal use → Jina Reranker v2 (CC BY-NC-4.0, same NC confirmation) or BGE-v2-m3; commercial/unsure → BGE-v2-m3 or Qwen3-Reranker-0.6B. Because BGE-v2-m3 is permissive regardless of use class, it could be the single default for both branches if its quality is comparable to Qwen3-Reranker-0.6B — but that comparison has no source in the Phase 0 research, so it is **not asserted here** and is left **to be decided by the M1 retrieval benchmark**, with Qwen3-Reranker-0.6B kept as the permissive alternative either way.

## Open questions for the owner

1. **Default embedding model — resolved 2026-09-22 as a use-class question, not a single pick.** The wizard asks "Personal / non-commercial use?" and pre-selects Jina v5 Text Nano (yes) or Qwen3-Embedding-0.6B (no/commercial/unsure), with E5-small for non-interactive installs; see "Installer / wizard default" above and *Conflicts with the brief* option (iv). If the owner wants one fixed default instead, say so and (i)/(ii)/(iii) apply unchanged.
2. **Default reranker** — BGE-v2-m3 (status quo, Apache-2.0, usable by both use classes) vs. Qwen3-Reranker-0.6B via `onnx-community` vs. Jina Reranker v2 for the personal/NC branch: **left to the M1 retrieval benchmark to decide with real numbers**, not asserted here without a quality source.
3. **RAM budget default** — what cap per installation, and does exceeding it block creating a new agent with a new local model or only warn? (No measured RAM figures exist yet; see action item 2.)
4. **Multi-identity recall in v0.1 or v0.2?** It is the largest engine PR here. A defensible interim is: allow per-store identities, but restrict a single recall to one identity until the fusion work lands.
5. Should the benchmark run automatically after every migration switch (cost, minutes) or only on request?

## Action items

1. [ ] Write the identity spec (`docs/embedding-identity.md`): field list, canonical serialisation, hash, where it is stored (generation record, store metadata, cache key) — then change `lib/embedding-cache.js:57-58` to key on the identity hash instead of `model+dimensions`.
2. [ ] Measure RAM (int8 vs fp32) and cold/warm latency for E5-small, Qwen3-Embedding-0.6B, Qwen3-Reranker-0.6B and BGE-v2-m3 on all five CI targets; the research note records this as a full gap.
3. [ ] Live smoke test to capture the exact rerank request/response JSON for Jina, TEI, vLLM, llama.cpp and oMLX; only then freeze the adapter field-mapping table.
4. [ ] PLUR1BUS PR: Windows named-pipe transport in `scoped-embedding-ipc.js` (protocol untouched) plus a `securePath()` helper replacing the `chmod 0o600/0o700` sites.
5. [ ] PLUR1BUS PR: per-route/per-DB dimension replacing the `vectorDim` scalar (`index.js:5594-5595` and the pool/`MemoryDB` chain), one query vector per identity in the recall pipeline, RRF fusion, and removal of the dimension-equality check in the share path.
6. [ ] Implement the compatibility probe (fixed probe set + stored reference vectors per generation) and a contract test that a wrong model is rejected.
7. [ ] Implement the calibration run (noise band, margins, proposed thresholds, narrow-cone warning) and wire it into the migration switch.
8. [ ] Bound the per-text fallback loop in `embedding-openai.js:159-196` against the 15 s budget; make the 5 s rerank timeout single-owned.
9. [ ] Extend `bench/` into a CI regression gate and a UI decision aid; check a 20-query golden set into the repo.
10. [ ] Offline model bundle (mirror of the pinned artefacts with their SHA-256 manifest) so an install does not depend on third-party re-export repos remaining online.
