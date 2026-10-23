# RE-03 — Embedding identities, local ONNX providers, remote providers, guarded transport

**Package.** Everything that turns text into vectors and scores: the vector-space identity and its id (byte-identical
to the Node engine's, or every store re-embeds), the model artifact catalogue with licences, the local e5 embedder and
bge reranker on ONNX Runtime, the remote providers, the chained and signal rerankers, the flat-embedder test seam, and
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
  local or remote), `packages/core/src/bin.ts:60-80` (the flat-embedder seam: 384-d unit vector `e₀` for every text,
  null reranker; `-cold`: the first two query embeddings of the process take 350 ms each, serialised),
  `packages/core/src/licences/` (the NC-licence gate that must see the catalogue's licence ids),
  `packages/core/src/tools/web/` (the resolve-then-pin SSRF guard this transport mirrors), `docs/host-contract.md` (d),
  (f.6).
- `ort` 2.0.0-rc crate docs: `Session::builder`, `load-dynamic` (`ORT_DYLIB_PATH`), input/output tensor shapes;
  `tokenizers` crate docs: `Tokenizer::from_file`, padding and truncation.

**Rules that apply.** Secrets by name through `SecretPort`, never in config or logs. Every remote call goes through
`transport::guarded` — no second HTTP client in the crate. One deadline per call (f.6). Model files are verified by
sha256 before loading (RE-R4). The seam is honoured only with `PLUR1BUS_ALLOW_TEST_INTERNALS=1` (RE-08 owns the env
check; this brief exposes the provider).

**Modules added by the 2026-10-23 audit** (rows owned by RE-03 in [`MODULE-MAP.md`](MODULE-MAP.md)): `lib/host-network.js`
(203 — the engine's outbound-HTTP and secret ports; folds into `transport::guarded` and `SecretPort`, its address rules
kept), `lib/provider-error.js` (135 — the error taxonomy behind `EmbedError`/`ProviderError`), `engine/providers/runtime-reranker.js`
(76 — the reranker factory, T4/T6), `lib/fetch-with-timeout.js` (fold), `lib/model-preparation/coordinator.js` + `state-store.js`
(393 + 178 — model download and preparation state → T2's artifact catalogue), `lib/providers/legacy-provider-migration.js`
(233 — legacy config → current provider config, T1). The tier-2 emotion classifier's model (`lib/tier2-transformer.js`, RE-05 T3)
is a T2 artifact. Not ported: `lib/native/sharp-*.js` (transformers.js workarounds).

## Files

- Create: `src/embedding/{mod,identity,fingerprint,normalize,artifacts,local_ort,local_rerank,remote_openai,cache,batch,
  readiness,service,seam}.rs`, `src/embedding/rerank/{mod,remote,cohere,chained,signal}.rs`, `src/transport/{mod,guarded,
  resolve,target}.rs`, `tests/embedding_identity.rs`, `tests/embedding_parity.rs`, `tests/transport_guard.rs`,
  `tests/rerank_providers.rs`, `tests/fixtures/vectors/{sentences.json,e5-small.json,bge-reranker.json,identity-e5.json,record.mjs}`,
  `tests/fixtures/http/{openai-embeddings,cohere-rerank,remote-rerank}/*.json`
- Modify: `crates/plur1bus-engine/Cargo.toml` (`ort = "=2.0.0-rc.15"` with `default-features = false, features =
  ["load-dynamic", "ndarray"]` or the minimal set that compiles, `tokenizers` exact pin, `ndarray` if needed, `sha2`),
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
- [ ] **Step 2: failing test** `tests/embedding_parity.rs::e5_vectors_match_the_node_engine`: for every sentence, cosine
  ≥ 0.9999 and max |Δ| ≤ 1e-4 against the recorded query and passage vectors; the empty string and the emoji sentence
  included. The test needs the model files: it resolves them from `PLUR1BUS_MODELS_CACHE` and **fails** with a clear
  message when they are absent (the CI job that runs it sets the cache the way `tests/system/two-session-recall.test.ts`'s
  real-model mode does; see RE-09 for the job).
- [ ] **Step 3: implement `local_ort.rs`:** `Session` over the same ONNX file the Node provider uses (same artifact
  entry, same dtype), tokenizer from the artifact's `tokenizer.json`, the `query: `/`passage: ` prefixes, truncation at
  the catalogue's `tokenCap`, mean pooling over the attention mask, L2 normalisation, batching by
  `embeddingBatchSize`; one session per process behind a `Mutex` (the Node shared pool serialises too).
- [ ] **Step 4: commit** `RE-03/T3: local e5 embedder`.

### T4 — Local reranker (one pull request)

- [ ] Same shape as T3: `record.mjs --bge` scores 50 (query, doc) pairs; `bge_scores_order_matches_the_node_engine`
  asserts the same ranking and |Δscore| ≤ 1e-3; implement `local_rerank.rs` (pairs tokenised as the Node provider does,
  logits to scores as it does, `top_n`), `empty_result_is_valid() == false`.

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

## Out of scope

Downloading model files (host concern; RE-08 may add `engine.models.fetch` later); the embedding-owner IPC; the LLM
port (`LlmPort` is a host callback, RE-08); the recall and capture pipelines that call these providers.

## Hand-off

Seven PRs `RE-03/T0` … `RE-03/T6`. T0 and T1 first (T1 unblocks RE-07's fingerprint work); T3/T4 need the model
download once; T5 is independent of T3/T4 and can run in parallel.
