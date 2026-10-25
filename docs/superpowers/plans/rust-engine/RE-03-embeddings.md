# RE-03 — Embedding identities, local ONNX providers, remote providers, guarded transport

**Package.** Everything that turns text into vectors and scores: the vector-space identity and its id (byte-identical
to the Node engine's, or every store re-embeds), the model artifact catalogue with licences, the local e5, EmbeddingGemma 2 and jina embedders and the
bge and jina rerankers on ONNX Runtime, the remote providers, the chained and signal rerankers, the flat-embedder test seam, and
the one guarded HTTPS transport every remote call uses. Size L.

**Depends on.** RE-01 (types, `EgressGate`, `Decision`), RE-02 (the fixture store's `identity.json`; `EmbeddingCache`).
**Enables.** RE-04, RE-05, RE-07 (fingerprint), RE-08 (seam wiring).

**Assumes.** RE-D3b (`ort` with `load-dynamic`), RE-D4 (the embedding-owner IPC is not ported).

**Read first.**
- Plan §2.1 (the egress rule, as corrected after review: per-hop decision on scheme/host/port, resolve-and-pin), §3.4
  (CP-4a's reranker flag), RE-3 in §4, risk RE-R4.
- Engine at `98dfe2f`, `lib/providers/`: `embedding-identity.js` (106; `identityId()` — the hash this brief must
  reproduce), `config-normalize.js` (256; `normalizeEmbeddingConfig`, one of the core's private imports),
  `dimensions.js` (190) and `dimension-guard.js` (58), `local-model-artifacts.js` (629; the catalogue, the
  `CC-BY-NC-4.0` entries at lines 52 and 81, sha256 per file), `embedding-local-transformers.js` (894; prefixes, pooling,
  normalisation, batch shape, dtype), `local-transformers-shared-pool.js` (294; one model instance per process),
  `reranker-local-transformers.js` (355), `embedding-openai.js` (306), `reranker-remote.js` (363), `reranker-cohere.js`
  (17), `reranker-chained.js` (60), `rerank-signal.js` (20), `factory.js` (72; which config picks which provider),
  `env.js`, `secret-input.js` (how a key is read — by name, never from config), `lib/reembedding/fingerprint.js` (157;
  `embeddingFingerprintId`), `lib/reembedding/runtime-config.js` (181), `engine/providers/embedding-service.js` (328),
  `engine/providers/model-readiness.js` (148; `ModelsService.status/warm`), `lib/embedding-cache.js` (925; key
  function and TTL). Not ported: `scoped-embedding-ipc.js` (1,109), `openclaw-memory-embedding-adapters.js` (410).
- Harness: `packages/core/src/engine-config.ts` (`E5_SMALL = "intfloat/multilingual-e5-small"`, dimensions 384,
  `BGE_RERANKER = "woxpas-ai/bge-reranker-v2-m3-onnx"`, cache dir `l.models`, the privacy/local-only policy that picks
  local or remote; e5-small applies only while `engine.embedding.local.model` is unset; since #771 the first-run
  wizard writes `google/embeddinggemma-2`, 768 dimensions, q8), `packages/core/src/bin.ts:64-84` (the flat-embedder seam:
  every text gets a unit vector `e₀` of the configured embedding's width, and a flat `reembeddingTargetProvider` uses the
  migration target's width; null reranker; `-cold`: the first two query embeddings of the process take 350 ms each, serialised),
  `packages/core/src/licences/` (the NC-licence gate that must see the catalogue's licence ids),
  `packages/core/src/tools/web/` (the resolve-then-pin SSRF guard this transport mirrors), `docs/host-contract.md` (d),
  (f.6).
- `ort` 2.0.0-rc crate docs: `Session::builder`, `load-dynamic` (`ORT_DYLIB_PATH`), input/output tensor shapes;
  `tokenizers` 0.23.2 crate docs: `Tokenizer::from_file`, and `encode` with `add_special_tokens`. Truncation is done by
  hand after encoding (T3), never through `TruncationParams`, which cannot reproduce transformers.js. See plan §2.5 and RE-D19.

**Rules that apply.** Secrets by name through `SecretPort`, never in config or logs. Every remote call goes through
`transport::guarded` — no second HTTP client in the crate. One deadline per call (f.6). Model files are verified by
sha256 before loading (RE-R4). The seam is honoured only with `PLUR1BUS_ALLOW_TEST_INTERNALS=1` (RE-08 owns the env
check; this brief exposes the provider).

**Modules added by the 2026-10-23 audit** (rows owned by RE-03 in [`MODULE-MAP.md`](MODULE-MAP.md)): `lib/host-network.js`
(203 — the engine's outbound-HTTP and secret ports; folds into `transport::guarded` and `SecretPort`, its address rules
kept), `lib/provider-error.js` (135 — the error taxonomy behind `EmbedError`/`ProviderError`), `engine/providers/runtime-reranker.js`
(76 — the reranker factory, T4/T6), `lib/fetch-with-timeout.js` (fold), `lib/model-preparation/coordinator.js` + `state-store.js`
(393 + 178 — model download and preparation state → T2's artifact catalogue), `lib/providers/legacy-provider-migration.js`
(233 — legacy config → current provider config, T1). `lib/tier2-transformer.js` loads no model: `loadModel()` sets
`_session = null` (`:105-113`). It is a keyword-density scorer, ported in RE-05 T3, not a T2 artifact. Not ported:
`lib/native/sharp-*.js` (transformers.js workarounds).

## Files

- Create: `src/embedding/{mod,identity,fingerprint,normalize,artifacts,local_ort,local_rerank,remote_openai,cache,batch,
  readiness,service,seam}.rs`, `src/embedding/rerank/{mod,remote,cohere,chained,signal}.rs`, `src/transport/{mod,guarded,
  resolve,target}.rs`, `tests/embedding_identity.rs`, `tests/embedding_parity.rs`, `tests/transport_guard.rs`,
  `tests/rerank_providers.rs`, `tests/fixtures/vectors/{sentences.json,e5-small.json,embeddinggemma-2.json,bge-reranker.json,token-ids.json,identity-e5.json,identity-embeddinggemma-2.json,record.mjs}` (the jina goldens of T3c and T4 are not committed unless the owner agrees under RE-D19),
  `tests/fixtures/http/{openai-embeddings,cohere-rerank,remote-rerank}/*.json`
- Modify: `crates/plur1bus-engine/Cargo.toml` (`ort = "=2.0.0-rc.15"` with `default-features = false, features =
  ["load-dynamic", "ndarray"]` or the minimal set that compiles, `tokenizers = "=0.23.2"` with `default-features = false` and the regex backend RE-D19 picks (`fancy-regex` or `onig`), `ndarray` if needed, `sha2`),
  `deny.toml`/`docs/dependency-policy.md` only with the owner's decision (the T0 gate), `docs/engine-stores.md`
  (artifact cache layout and the `libonnxruntime` location per target)
- Test: the four Rust test files; fixtures recorded by `record.mjs`

## Interfaces

**Consumes:** RE-01 `EmbeddingService`, `ModelsService`, `EmbeddingIdentity`, `VectorSpaceIdentity`, `RerankHit`,
`EmbeddingProbeResult`, `EgressGate`/`Decision`/`AddressRules`, `SecretPort`, `Cancel`; RE-02 `EmbeddingCache`.

**Produces:**

```rust
// src/embedding/identity.rs
pub fn identity_id(identity: &VectorSpaceIdentity) -> String;          // == Node identityId(), byte for byte
pub fn fingerprint_id(normalized: &NormalizedEmbeddingConfig) -> String; // == Node embeddingFingerprintId()
pub fn normalize_embedding_config(raw: &serde_json::Value) -> Result<NormalizedEmbeddingConfig, ConfigError>;

// src/embedding/artifacts.rs
pub struct Artifact { pub repo: String, pub revision: String, pub files: Vec<ArtifactFile /* path, sha256, bytes */>,
    pub licence: LicenceId /* "MIT" | "Apache-2.0" | "CC-BY-NC-4.0" | … as the Node catalogue spells them */ }
pub fn catalogue() -> &'static [Artifact];                                 // verbatim from local-model-artifacts.js
pub fn resolve(model: &str, cache_dir: &Path) -> Result<ResolvedArtifact, ArtifactError>; // verifies every sha256

// src/embedding/mod.rs — the provider port RE-04/05 call through EmbeddingService
pub trait EmbeddingProvider: Send + Sync {
    fn identity(&self) -> &VectorSpaceIdentity;
    fn embed(&self, texts: &[String], kind: EmbedKind, cancel: &Cancel) -> Result<Vec<Vec<f32>>, EmbedError>;
}
pub trait Reranker: Send + Sync {
    fn rerank(&self, query: &str, docs: &[String], top_n: usize, cancel: &Cancel) -> Result<Vec<RerankHit>, RerankError>;
    fn empty_result_is_valid(&self) -> bool;                                // CP-4a / CP-5.5
}
pub fn build_embedding(config: &EngineConfig, host: &dyn HostServices) -> Result<Box<dyn EmbeddingProvider>, EngineError>;
pub fn build_reranker(config: &EngineConfig, host: &dyn HostServices) -> Result<Option<Box<dyn Reranker>>, EngineError>;

// src/embedding/seam.rs — the flat embedder (plan §2.1); RE-08 decides when it is used
pub struct FlatEmbedder { /* dim 384, cold_calls: AtomicUsize, serialised 350 ms delay */ }
impl FlatEmbedder { pub fn new(cold: bool) -> Self; }     // cold: the first two query embeds of the process take 350 ms each, one after the other
pub struct FlatEmbedder { /* width: the configured embedding's (384 only for the implicit e5 default), cold_calls: AtomicUsize, serialised 350 ms delay */ }
impl FlatEmbedder { pub fn new(width: usize, cold: bool) -> Self; }     // cold: the first two query embeds of the process take 350 ms each, one after the other; the flat re-embedding target provider uses the target's width

// src/transport/guarded.rs — the only HTTP client (RE-08's host client is RPC, not HTTP)
pub struct Target { pub scheme: Scheme, pub host: String, pub port: u16 }
pub struct GuardedClient { /* ureq agent, gate, resolver seam, decision cache keyed by Target with TTL */ }
impl GuardedClient {
    pub fn new(gate: &dyn EgressGate, resolver: Box<dyn Resolver>) -> Self;  // Resolver seam for tests
    pub fn request(&self, req: HttpRequest, deadline: Instant) -> Result<HttpResponse, TransportError>;
    pub fn invalidate(&self);                                                  // on `egress.changed`
}
// Per hop (first request and every redirect): gate.decide(&Target) → resolve the name → check every address against
// AddressRules → connect to the checked address only (pinned) → the redirect target starts the loop again.
```

## Tasks

### T0 — Dependency gate for `ort` and `tokenizers` (one pull request, first)

- [ ] Add the two crates with exact pins; `cargo deny check` and `node scripts/audit-deps.mjs --only cargo` as in
  RE-00 T3; the licence table in the PR; the owner decides; document the `libonnxruntime` strategy
  (`load-dynamic`: the dynamic library is found through `ORT_DYLIB_PATH`; RE-08 ships it per target and sets the
  variable in `engine_spec`; the test suite points it at a downloaded copy under `target/` through a `tests/common`
  helper). Record the build-time delta against RE-00's numbers.
- [ ] `tokenizers` (RE-D19): first build `=0.23.2` with `default-features = false` and the implicit `fancy-regex`
  feature. That build is pure Rust: `cargo tree -e features` must show neither `onig` nor the `cpp` feature of
  `esaxx-rs`. The token-id goldens of T3, T3b, T3c and T4 decide the backend. If any pinned tokenizer file yields a
  different id, switch to `onig` and prove the `windows-2025` build the way #769 did for protobuf. Do not use
  1.0.0-rc.3: it was released 2026-10-19, inside the two-week window; like rc.2 it has no `Tokenizer::from_file`, and
  every legacy `tokenizer.json` would need `tk-convert`.
- [ ] The licence table also covers the tokenizer and model files:
  - e5: MIT.
  - EmbeddingGemma 2: Apache-2.0.
  - The jina files: CC-BY-NC-4.0. They are never bundled and are downloaded only on consent, through the harness NC
    gate.
  - `woxpas-ai/bge-reranker-v2-m3-onnx`: the catalogue records no licence. Hugging Face tags it MIT; upstream
    `BAAI/bge-reranker-v2-m3` is Apache-2.0. Verify a licence file before its token-id golden is committed.
  - jina v3: the artifacts come from `ldwformat/jina-embeddings-v3-Q8-onnx`, which carries no licence tag at all.
    Record that next to the upstream CC-BY-NC-4.0.

### T1 — Identity and fingerprint parity (one pull request)

- [ ] **Step 1: record vectors.** `tests/fixtures/vectors/record.mjs --identity` prints `identityId()` and
  `embeddingFingerprintId()` for: the fixture store's identity (RE-02 `identity.json`), the e5-small local identity the
  harness configures by default (build it with `normalizeEmbeddingConfig` over `buildEngineConfig`'s default block —
  read `engine-config.ts`), an OpenAI `text-embedding-3-small` remote identity, and five hand-written variants (dtype,
  prefix scheme, instruction, token cap, artifacts list). Commit as `identity-e5.json` with `{ identity, identityId,
  normalized, fingerprintId }` per case.
- [ ] **Step 2: failing tests** `tests/embedding_identity.rs`: `identity_id_matches_the_node_engine_for_every_recorded_case`,
  `fingerprint_id_matches_the_node_engine_for_every_recorded_case`, `normalize_rejects_a_config_without_a_provider`.
- [ ] **Step 3: implement** `identity_id` (read `embedding-identity.js` for the canonical form: key order, how `artifacts`
  and `null`/`undefined` are serialised, the hash function and its encoding), `fingerprint_id`, `normalize_embedding_config`.
- [ ] **Step 4: commit** `RE-03/T1: identity and fingerprint ids at parity`.

### T2 — Artifact catalogue, verification, licences (one pull request)

- [ ] **Step 1: failing tests:** `the_catalogue_lists_every_node_entry_with_the_same_sha256_and_licence` (a JSON
  export of the Node catalogue recorded by `record.mjs --catalogue`), `resolve_refuses_a_file_with_the_wrong_digest`,
  `resolve_reports_the_nc_licence_id_for_the_two_nc_entries`.
- [ ] **Step 2: implement** `catalogue()` (a `const` table, generated from the recorded JSON by a small script or
  typed by hand with the test as guard), `resolve` (looks in `cache_dir` the way the Node code lays it out — read
  `local-model-artifacts.js` for the directory shape so a cache the Node engine filled is reused — and verifies sha256;
  no download in this crate: downloads stay a host concern until RE-08 decides; `ArtifactError::Missing { repo, file }`
  names what to fetch).
- [ ] **Step 3: commit** `RE-03/T2: artifact catalogue and verification`.

### T3 — Local e5 embedder on ONNX Runtime (one pull request)

- [ ] **Step 1: record parity vectors** with the real model: `record.mjs --e5` embeds the 50 sentences of
  `sentences.json` (25 German, 25 English, lengths 3–400 tokens, one empty string, one with emoji) as queries and as
  passages with the pinned Node engine (`PLUR1BUS_REAL_MODELS=1`-style setup: let the Node provider download into
  `PLUR1BUS_MODELS_CACHE`) and writes `e5-small.json` (`{ sentence, query: [384 f32], passage: [384 f32] }`). About
  200 KB; commit it.
  200 KB; commit it. Add three sentences to `sentences.json`: one passage longer than every cap (memory cards reach
  `captureMaxChars` 15,000), one NFD-normalised German sentence and one German compound sentence.
  `record.mjs --token-ids` writes `token-ids.json`: the exact `input_ids` after the Node cut, for every sentence and
  every pinned tokenizer file whose licence allows committing the result. That covers e5 and EmbeddingGemma 2, and
  bge once T0 has verified its repository licence. The CC-BY-NC jina files are covered only after the owner's answer
  under RE-D19; otherwise RE-09 T3's real-model leg runs them.
- [ ] **Step 2: failing test** `tests/embedding_parity.rs::e5_vectors_match_the_node_engine`: for every sentence, cosine
  ≥ 0.9999 and max |Δ| ≤ 1e-4 against the recorded query and passage vectors; the empty string and the emoji sentence
  included. The test needs the model files: it resolves them from `PLUR1BUS_MODELS_CACHE` and **fails** with a clear
  message when they are absent (the CI job that runs it sets the cache the way `tests/system/two-session-recall.test.ts`'s
  real-model mode does; see RE-09 for the job).
  real-model mode does; see RE-09 for the job). Also add `token_ids_match_the_node_engine_for_every_committed_tokenizer` and
  `an_over_cap_passage_loses_the_closing_special_token_as_in_node`. These two need only the tokenizer files, not the
  ONNX models.
- [ ] **Step 3: implement `local_ort.rs`:** `Session` over the same ONNX file the Node provider uses (same artifact
  entry, same dtype), tokenizer from the artifact's `tokenizer.json` (sha256 verified), and the `query: `/`passage: `
  prefixes. Encode with special tokens and **without** truncation, then cut `input_ids` and `attention_mask` to the
  profile's `truncation_len`. transformers.js 4.3.1's `truncateHelper` cuts the finished id array, so the closing `</s>`
  is lost. For e5 the length is the tokenizer_config `model_max_length` 512 (`embedding-local-transformers.js:736`,
  `:805-813`), not the identity's `tokenCap`; the identity keeps `cfg.tokenCap ?? cfg.maxTokens` byte-identical. Then
  mean pooling over the attention mask, L2 normalisation, batching by
  `embeddingBatchSize`; one session per process behind a `Mutex` (the Node shared pool serialises too).
- [ ] **Step 4: commit** `RE-03/T3: local e5 embedder`.

### T3b — Local EmbeddingGemma 2 embedder (one pull request)

Since #771 the first-run wizard writes `google/embeddinggemma-2` (768 dimensions, q8). e5-small applies only while
`engine.embedding.local.model` is unset.

- [ ] **Step 1: record.** `record.mjs --gemma` uses the pinned q8 artifact (`lib/providers/local-model-artifacts.js:92-134`,
  `tokenizer.json` sha256 `4d777ef5…`). It writes the query and passage vectors for `sentences.json` to
  `embeddinggemma-2.json`, the identity to `identity-embeddinggemma-2.json`, and the token ids to `token-ids.json`.
- [ ] **Step 2: failing tests** `gemma_vectors_match_the_node_engine` (T3's tolerance), `gemma_token_ids_match_the_node_engine`,
  `gemma_refuses_a_non_profile_prefix` (`embedding-local-transformers.js:556-563`).
- [ ] **Step 3: implement** the runtime in `local_ort.rs`:
  - the prompts `task: search result | query: ` / `title: none | text: `;
  - the `<bos> A <eos>` template of its `tokenizer.json`;
  - the cut to the configured `maxTokens` (default `profile.maxTokens ?? 512`, `embedding-local-transformers.js:577-581`);
  - the `sentence_embedding` output or masked mean (`:355-377`);
  - Matryoshka slicing and re-normalisation;
  - sub-batches of `maxBatchSize` (default 16, range 1..64, `:582-593`).
- [ ] **Step 4: commit** `RE-03/T3b: local EmbeddingGemma 2 embedder`.

### T3c — Local jina v3 and v5-nano embedders (one pull request)

The first-run wizard offers both (`packages/web/src/pages/setup/licences.ts:16-17`), and `memory reembed --model`
accepts them. Both are CC-BY-NC-4.0. Their files are fetched only with the owner's consent, and their goldens are
not committed unless the owner agrees under RE-D19; otherwise they run in RE-09 T3's real-model leg. Until this task
merges, the Rust engine answers `E_NOT_AVAILABLE reason=not-implemented` for a jina profile. The RE-09 T5 exit report
states the jina parity result, so a user who chose jina knows whether `engine.implementation: "rust"` serves them.

- [ ] **Step 1: record** (locally, or in the real-model leg). `record.mjs --jina` writes the vectors, identities and
  token ids for `sentences.json` of both profiles.
- [ ] **Step 2: failing tests:**
  - `jina_v3_vectors_and_token_ids_match_the_node_engine`;
  - `jina_v3_passes_the_task_id_of_the_purpose` (`embedding-local-transformers.js:174-186`);
  - `jina_v5_vectors_and_token_ids_match_the_node_engine`;
  - `jina_v5_refuses_a_non_profile_prefix` (`:556-563`);
  - `jina_v5_pools_the_last_attended_token_for_either_padding_side` (`:243-262` scans the mask instead of assuming a
    side);
  - `an_over_cap_jina_v5_input_pools_a_content_token_as_in_node` (the cut drops the closing `<|end_of_text|>`).
- [ ] **Step 3: implement** in `local_ort.rs`:
  - jina v3: empty prefixes (`local-model-artifacts.js:50-51`); the `task_id` tensor, which is the index of
    `retrieval.query`/`retrieval.passage` in the model's `taskAdaptations` (`embedding-local-transformers.js:174-186`);
    the cut at `maxTokens` (`:181-185`); then mean pooling, the Matryoshka slice and L2 normalisation (`:96-115`).
  - jina v5-nano: the prompts `Query: `/`Document: ` (`local-model-artifacts.js:79-80`); the `A <|end_of_text|>`
    template; the Llama-3-style pre-tokenizer with the lookahead `\s+(?!\S)`, which is why RE-D19 needs `fancy-regex`
    or `onig`; the cut at `maxTokens` (`:318-322`); then the `sentence_embedding` output, or last-token pooling over
    the last attended position (`:323-331`, `:243-262`).
- [ ] **Step 4: commit** `RE-03/T3c: local jina v3 and v5-nano embedders`.

### T4 — Local reranker (one pull request)

- [ ] Same shape as T3: `record.mjs --bge` scores 50 (query, doc) pairs; `bge_scores_order_matches_the_node_engine`
  asserts the same ranking and |Δscore| ≤ 1e-3; implement `local_rerank.rs` (pairs tokenised as the Node provider does,
  logits to scores as it does, `top_n`), `empty_result_is_valid() == false`.
  - Pairs are encoded with `text_pair` and cut from the end at the profile's `truncation_len`, never with
    `longest_first`. The length comes from each `tokenizer_config.json`'s `model_max_length`: bge 8192, jina
    reranker 1024 (`reranker-local-transformers.js:112-118`).
  - The documents are the summaries the pipeline passes (`summaryMaxWords` 150).
  - Add `bge_token_ids_match_the_node_engine` for the pairs.
  - The same tests cover jina-reranker-v2 (`jinaai/jina-reranker-v2-base-multilingual`, which uses the same
    `tokenizer.json` as jina v3, sha256 `3a56def2…`): `jina_rerank_order_and_token_ids_match_the_node_engine`, recorded
    and run in RE-09 T3's real-model leg (CC-BY-NC, files fetched with consent).

### T5 — Guarded transport and remote providers (one pull request)

- [ ] **Step 1: failing tests** `tests/transport_guard.rs` with a `Resolver` seam and a local HTTP stub server:
  `a_denied_target_is_never_connected` (the stub sees no connection), `a_redirect_to_the_same_host_on_a_port_the_gate_denies_is_refused`,
  `dns_rebinding_is_refused` (the seam answers a public address on the first lookup and `127.0.0.1` on the second;
  the connection goes to the first, checked address or is refused — never to loopback when `allow_loopback` is false),
  `the_decision_cache_is_dropped_on_invalidate`, `one_deadline_covers_the_whole_call_including_redirects` (f.6).
- [ ] **Step 2: implement `transport::guarded`** over `ureq` with a custom resolver/connector that connects to the
  pinned address and sets SNI/Host to the name; cache per `Target` with a 60 s TTL; `invalidate()`.
- [ ] **Step 3: providers** with recorded request/response fixtures (no network): `remote_openai.rs`
  (`/v1/embeddings`, batch, dimensions check through `dimension-guard` semantics), `rerank/remote.rs`
  (`reranker-remote.js`'s request shape), `rerank/cohere.rs`, `rerank/chained.rs` (first success wins; a timeout of
  one member does not consume the others' budget beyond the shared deadline), `rerank/signal.rs`. Tests
  `tests/rerank_providers.rs`: one request-shape test and one error-mapping test per provider (`ProviderError`
  taxonomy as `packages/providers` names it: `auth`, `rate-limit`, `timeout`, `invalid-response`).
- [ ] **Step 4: commit** `RE-03/T5: guarded transport and remote providers`.

### T6 — Service facade, readiness, cache, seam (one pull request)

- [ ] **Step 1: failing tests:** `embed_uses_the_cache_on_the_second_call` (RE-02 `EmbeddingCache`; key = the Node key
  function), `probe_reports_dimension_mismatch_for_a_vector_of_the_wrong_length`, `warm_moves_state_from_loading_to_ready`,
  `the_flat_embedder_returns_e0_for_every_text`, `the_cold_flat_embedder_delays_the_first_two_query_embeds_by_350ms_each_serially`
  (measure: two concurrent calls finish at ≈350 and ≈700 ms; the third at once).
  (measure: two concurrent calls finish at ≈350 and ≈700 ms; the third at once), and `the_cache_key_matches_node`,
  whose vectors cover the whole key:
  - the key is the sha256 of the NUL-separated tuple (provider, model, dimensions, scopeId, `v2`, identityHash,
    textHash) (`lib/embedding-cache.js:17`, `:58-61`);
  - `textHash` is the sha256 of the text after the JS `trim()` whitespace set (U+FEFF included) and `toLowerCase()`,
    computed through RE-04 T0's `text::js` (`:34-36`); a raw-string hash, so a cut surrogate hashes as U+FFFD
    (RE-D17);
  - `identityHash` is the identity id or `legacy` (`:658-666`);
  - the local provider passes `model:purpose` (`lib/providers/embedding-local-transformers.js:852-858`).

  At parity, "Apple" and "apple" share an entry for the same provider, model, dimensions, scope, identity and purpose.
- [ ] **Step 2: implement** `service.rs` (`EmbeddingService` over a provider + reranker + cache + `ModelsService`
  readiness with `warming`/`ready`/`failed`; `serve` returns the identity envelope `{ model, dimensions, fingerprintId }`
  and `address: None`, `tokenPath: None` — RE-08 serves it over RPC), `build_embedding`/`build_reranker` (the `factory.js`
  mapping: `local-transformers` → T3/T4, `openai`/OpenAI-compatible → T5, chained/remote/cohere rerankers), `seam.rs`.
- [ ] **Step 3: commit** `RE-03/T6: embedding service, readiness, cache, flat-embedder seam`.

## Acceptance

- T1's parity tests green without any model; T3/T4's parity tests green on the job that has the models (RE-09 names
  it; until then the implementer runs them locally with `PLUR1BUS_MODELS_CACHE` and quotes the output in the PR).
- `tests/transport_guard.rs` green on Linux, macOS and Windows runners.
- `cargo tree -p plur1bus-engine -e features | grep -c ureq` shows one `ureq` dependency path owned by `transport`.
- No `openclaw` string (the adapter file is not ported); licence table for `ort`/`tokenizers` decided by the owner.
- `token-ids.json` is green on every runner for every committed tokenizer file. The jina goldens are green in RE-09
  T3's real-model leg, or the T5 exit report says why not. Under `tokenizers`, `cargo tree -p plur1bus-engine -e features`
  shows exactly one of `onig` and `fancy-regex` (RE-D19).

## Out of scope

Downloading model files (host concern; RE-08 may add `engine.models.fetch` later); the embedding-owner IPC; the LLM
port (`LlmPort` is a host callback, RE-08); the recall and capture pipelines that call these providers.

## Hand-off

Nine PRs: `RE-03/T0` … `RE-03/T6` plus `RE-03/T3b` and `RE-03/T3c`. T0 and T1 first (T1 unblocks RE-07's fingerprint work); T6 needs RE-04 T0 (`text::js`); T3c's and T4's jina goldens run in RE-09 T3's real-model leg; T3/T3b/T3c/T4 need the model
download once; T5 is independent of T3/T4 and can run in parallel.
