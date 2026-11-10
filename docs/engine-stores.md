# Engine stores

RE-02 preserves the files written by the Node engine pinned at `9f34008c143c5da87b2194b5a28442b407ff8ba7`.
The persisted representation, including legacy column names and JavaScript string escapes, is the compatibility
contract. Store operations do not run a migration or change `STORE_SCHEMA_VERSION` (`"1"`). A missing `_schema.json`
reports legacy version `"0"`; an unreadable or unsupported marker is an error.

| File or table | Rust owner | Persisted representation and compatibility rule |
|---|---|---|
| `memories` | `store::lance`, `store::row` | 69 ordered nullable Arrow columns; numbers are Float64, `confirmed` is Boolean, `vector` is FixedSizeList of Float32. Names, types and child nullability come from the recorded Node store. Existing Node-promoted LargeUtf8 string columns remain readable and retain their type on writes. |
| `_embedding_identity` | `store::lance` | One row with `identity` (canonical Node JSON) and its SHA-256 `identityId`. A writable open refuses a different identity; a read-only open reports the mismatch. |
| `_schema.json` | `store::schema_version` | Node JSON schema marker; no implicit migration on open. |
| `embeddings` | `store::sqlite` | Verbatim Node SQLite DDL; NUL-separated v2 key material and JSON vector BLOBs. Text normalization uses JavaScript trim/lowercase. |
| `llm_results` | `store::sqlite` | Verbatim Node SQLite DDL, absolute expiry, nullable usage fields and byte counts. |
| `speaker_mappings` | `store::sqlite` | Verbatim Node DDL including its legacy camelCase columns. |
| `vectors.<gen>.f32`, `vector-index.json` | `store::neo_files` | Little-endian Float32 vectors; the index names the generation and records byte offsets, lengths and dimensions. The index is the commit point. |
| `turn-journal.jsonl`, `record-index.json` | `store::neo_files`, `store::ledger_types` | Actual Node turn records retain `content`; the reader does not invent a `statement` field. |
| `candidate-index.jsonl` | `neo::index`, `neo::candidate_index` | Vector-free latest-candidate metadata. Native projection preserves every D130 binding/contradiction field (RE-D61), including canonical origin bindings and root workspace aliases/aclBindings. Duplicate fields and malformed origins cannot be projected into access grants. Projection alone neither authorizes sources nor publishes an index. |
| `conflict-log.jsonl`, `conflict-resolved.jsonl`, `memory-candidates.jsonl`, `destructive-ops.jsonl` | `store::ledger`, `store::ledger_types` | Typed records through tolerant JSON; a lone UTF-16 surrogate stays an escaped surrogate when serialized. |
| `behavior-cards.jsonl`, `retrieval-ledger.jsonl`, `reply-outcomes.jsonl`, `reconsolidation-events.jsonl`, `reaction-ledger.jsonl` | `store::ledger`, `store::ledger_types` | Node JSONL record shapes. |
| `run-state.json`, `snapshot.json`, `.emotional-state.json`, `semantic-lens-index.json`, `hook-state.json`, re-embedding state | `store::state_file` | Tolerant JSON load and atomic replace. Invalid state remains a distinct failure; only an absent file returns no state. |
| `workspaces/<canonical>/native-hook-state-<binding-sha256>.json` | `neo::session_store` | Native S2 checkpoint extension (RE-D60): exact ownership proof plus `agentEnd` session state. Principal/physical-workspace-bound, with held filesystem identities checked inside the envelope. Replacement/restore identity changes require explicit rebinding; they never silently reset progress. 4 MiB maximum, atomic fsync/replace. Never adopts ownerless Node `hook-state.json` implicitly. |
| `workspaces/<canonical>/native-capture-pending-<binding-sha256>.json` | `neo::capture_journal` | Native frozen capture plan (RE-D62): physical root/workspace identities and canonical principal proof, plus the exact five journal batches. Atomic fsync before record writes; empty settled plan after journals and both indices are durable. Recovery reauthorizes the original principal; restore/replacement requires explicit rebinding. 64 MiB and 50,000 planned records maximum. |
| `workspaces/<canonical>/native-episode-pending-<binding-sha256>.json` | `neo::episode_store` | RE-D64 frozen episode rows, source/predecessor digests, session key and exact previous/next checkpoint. Same physical ownership proof as capture. Empty settlement only after durable episode publication and checkpoint commit; pending work is never evicted. |
| `workspaces/<canonical>/native-embedding-pending-<binding-sha256>.json` | `neo::embedding_drain` | RE-D66 original caller, exact old/new queue and source revisions, vector manifest and binary prefix SHA256/suffix. Retained until durable publication and index refresh; recovered without provider inference. |
| `workspaces/<canonical>/native-vector-space.json` | `neo::embedding_drain` | Private physical-workspace/model identity binding for the shared Node Float32 sidecar. Nonempty unbound legacy files require explicit migration; dimension alone does not establish model compatibility. |
| `workspaces/<canonical>/.native-capture-leases/workspace.lock` | shared native kernel lease | Persistent kernel-held workspace lease plus the actual Node `.neo-write.lock`. Caller cancellation and a 300-second ceiling bound a call; every mutation rechecks both leases, physical identity, current host mapping and capture policy. |
| `workspaces/<canonical>/.native-hook-leases/<state-file>.lock` | shared native kernel lease | Persistent inode; kernel-held exclusive lock, cancellation while waiting, no TTL takeover or unlink on release. Process death releases ownership. |
| `.neo-write.lock/owner.json` | `store::lock` (private `neo_lock` implementation) | The existing Node directory-lock layout, with its own orphan grace and liveness rules below. |
| Registry and job `.lock` files | `store::lock`, `plur1bus_rpc::process` | Exclusive creation and the Node nonce/process-incarnation ownership protocol described below. |

Lance queries keep the backend's default L2 metric. Its `_distance` is **squared** Euclidean distance: orthogonal
unit vectors return 2 and opposite unit vectors return 4. Phase 1 retains the Node score `1 / (1 + distance)`.
The store does not build a lexical index; RE-10 owns the derived `_lexical` table and its index. A round trip checks
that an additional derived table does not alter the Node reader's `memories` or identity view.

`store::routes::StoreRoutes` supplies an ordered read plan without fetching memory rows.
Each `StoreRoute` retains its namespace label, shared `Arc<StorePool>`, missing-table policy
and trusted directory pins. `lease(agent_id)` returns `Option<Arc<Store>>`: a missing read-only
legacy table returns `None` without creating files; path replacements and other failures remain
errors. Holding the `Arc` prevents pool eviction while a child runs. `recall::namespaces::NamespaceStores`
builds these private routes from the namespace configuration and exposes the active writer
separately through `write_store`. Read ordering is configuration ordering, never worker completion
ordering; fan-out uses at most eight workers per request and settles all children before selecting
its first required error. Shared/optional sources and strict single-source timeout policy remain
T6/RE-07 work; with T4's private routes the first route is the first private canonical source.

`StoreRoute::lease_existing` and `NamespaceStores::existing_write_store` preserve the
configured route mode and identity while refusing implicit table creation. The native
`ops::private_routes::PrivateMemoryStores` adapter reuses those same pools for private reads,
mutation previews, import and rebinding; only explicit writable acquisition can create a table.
It supplies neither shared routes nor row authority. Missing sources are skipped only after
physical root validation; corruption, root replacement and identity mismatch remain errors.

Pools pin their base when present, or immediately before the first explicit creation. Leased
stores retain the base and all configured namespace ancestor pins even after the pool drops.
Every data operation rechecks these pins, so moving the original agent/namespace directory
back beneath a replacement root cannot silently adopt the replacement. This adds directory
handles and metadata checks; it does not provide atomic exclusion against an unrelated writer
changing paths during a backend operation.

`store::shared_pool::SharedPool` routes authenticated workspace and user identities to
`.plur1bus-shared/workspaces/<w-key>` and `.plur1bus-shared/users/<u-key>` under the configured
base. Keys use the existing context helpers; user pools are shared only across that user's
agents/workspaces. Read leases neither create stores nor migrate schemas. Explicit writable
leases add only missing provenance columns, retaining old target identities for provider
selection. A partial shared schema requires the explicit `Store::open_shared_write` recovery
path; ordinary readers reject it. Remaining columns and row values survive that migration. Missing origin values remain unknown:
Unimport refuses a live unknown origin ID or a matching ID without its source agent; it never
treats migration defaults as proof that no shared copy exists. Deleted copies and unrelated known
origin IDs do not block that check.

`ops::routes::MemoryStores` combines private routes followed by workspace/user sources and
supplies the same physical pools to sharing and Unimport's readonly reference check. Acquisition
errors propagate instead of silently returning empty shared sources. Row ACL and authenticated
operation context remain mandatory; construction does not activate ProcessEngine capabilities.

Each writable shared lease checks base ownership and owner-only shared-root permissions
(including cached leases). Existing loose permissions are refused, never repaired. Unix uses
UID/mode checks; Windows uses owner SID and strict DACL inspection, permitting the current user,
SYSTEM and Administrators on the private root. Windows native behavior is not established by the
macOS tests. Root replacement taints the router until restart. Leased stores retain all directory
pins, and idle-only cache eviction never invalidates an outstanding handle. RE-D127's SHA-bound
fixture marker documents stricter partial-schema reads, tainted reads and repeated permission
checks against the actual Node observations. The cost is held directory handles and additional
metadata/ACL checks; no atomic exclusion of an unrelated process during a backend call is claimed.

Every T4 route resolves an expected identity for its namespace and agent through
`store::routes::StoreIdentityResolver`. `NamespaceStores::open` uses the active identity as the
production fallback for **all** routes, including read-only legacy routes;
`open_with_identity_resolver` accepts configured per-route/per-agent expectations. A stored
mismatch refuses the complete recall before any provider call, merge or ledger write. This is
the pin's `identityForStore`/`MemoryDB.init` policy, not a writer-only rule. The later facade
reports `degraded:error` without a memories block; it does not fuse the remaining active hits.
The low-level RE-02 read-only inspection API still exposes mismatch metadata; T4 applies the
stricter production policy at its lease boundary.

Tables without persisted identity metadata inherit their route expectation in the request's
identity accounting and provider selection, without stamping a read-only table. When explicit
routes correctly declare different spaces, T4 selects each matching provider, coalesces each
original query, merges/fuses the results and optionally reranks globally. Only a declared,
matching space whose provider is unavailable or returns an invalid query vector degrades with
`embedding-unavailable`. The existing RE-03 provider API is unchanged; RE-08 connects configuration
to the resolver port for all routes, while T4 already enforces its policy.

After multi-identity fusion, the existing CP-5.5 provider opt-in also applies: a successful
response with no valid indices and `empty_result_is_valid() == true` selects no memories and
writes an empty selection without degradation, whether fallback is enabled or disabled. The
older identity wrapper lacks that check; this deliberately carries the required CP-5 contract
into the fused path. Provider errors and undeclared empty responses retain fallback/error behavior.

RE-04/T4 namespace recalls apply the global tier budget after merge/rerank and append a single
retrieval record from the final selection, through
`store::ledger::JsonlLedger<RetrievalLedgerLine>`. The persisted shape matches Node's
`lib/memory-dynamics.js::createRetrievalLedgerEntry`: `id` (UUID), `agentId` and `workspaceKey`
(nullable strings), `queryHash` (SHA-256 of the UTF-8 query, or null for an empty query),
`resultsCount`, ordered `selectedIds` (null for an absent id), and `timestamp` (epoch milliseconds).
The typed record serializes those fields in Node order; tests compare the persisted JSONL text
with actual Node output after replacing only its generated UUID. Neither the query
text nor memory text enters this line. Canonical sections do not count toward `resultsCount`.
Child pipelines do not write ledger entries; a required table failure writes none. An absent
read-only legacy table is skipped without creating its directory. As in Node, a failed ledger
delivery does not replace successful recall results; `NamespaceOutput.ledger_error` retains
the bounded delivery diagnostic for the runtime caller.

RE-04/T6's foreground `recall::runtime::run` suppresses the child-wrapper ledger callback and
appends the same typed final-selection record only after rendering while the request token is live.
A hard timeout or caller cancellation preserves authorized partial blocks but clears maintenance
intents and appends no retrieval line. A soft-budget fast path may append its completed selection.
The separate T5 warm-only path has no ledger writer and performs no persistent recall maintenance.

All store paths reject symlinks, including Windows junctions. `TrustedDirectory` holds the namespace directory
handle for the lifetime of the Lance connection. Unix namespace children use descriptor-relative `openat` with
`O_NOFOLLOW`; Lance receives a verified `/proc/self/fd` or `/dev/fd` alias where available. On hosts without a working
descriptor alias, including the pin's Darwin/Windows fallback, the held identity is checked against the physical
path before use. Replacing a pathname refuses later operations. Newly created private directories receive POSIX mode
0700 or the existing RPC helper's inheritable user-and-SYSTEM Windows DACL. The path checks reuse the RPC trust
rules where their directory-owner policy applies. Named namespace identifiers follow the existing engine pattern
`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`.

An atomic replacement uses a unique sibling temporary file, flushes its bytes, renames it, and flushes the parent
directory on Unix. Windows has no corresponding directory fsync; transient sharing/access failures receive the
same bounded retry policy as the pinned Node writers. The existing token-calibration writer keeps its stricter
rollback contract: its tests require a fixed staging name and rename as the final fallible operation. Moving it to
the shared writer needs a separate, explicit behavior decision; RE-02 leaves those tests and that writer unchanged.

Rust reads Node JSON files through `text::json`, preserving lone UTF-16 surrogates. Ordinary serde records implement the `JsonRecord`
codec directly; records containing `JsString` implement the codec explicitly. The parser accepts at most 128 nested
containers and returns a distinct depth-limit error before descending into level 129. This is a deliberate bounded
parser deviation: Node has no fixed JSON depth limit, while these engine files are only a few levels deep.

## Local model artifacts and runtime (RE-03)

The artifact catalogue in `embedding::artifacts` reproduces the Node pin's model, revision, dtype, source-file
mapping, byte length and SHA-256. The cache uses the Node layout:

```text
<model-cache>/<logical-model-repository>/<revision>/<artifact-path>
<model-cache>/intfloat/multilingual-e5-small/614241f622f53c4eeff9890bdc4f31cfecc418b3/tokenizer.json
```

The logical model name remains the directory name when an ONNX conversion comes from another repository.
`artifactRepository`, `artifactRevision` and `sourcePath` identify its download source; they do not change this
cache layout. Gemma q8, q4 and fp32 select separate pinned files and vector-space identities. Both the Node-filled
cache and a host-prepared cache can be read by Rust. `resolve`/`resolve_dtype` only read and verify regular files;
they do not fetch, repair or write model artifacts. Missing or non-regular files, wrong sizes and wrong digests fail
explicitly. The host owns downloads, durable preparation state, licence confirmation and selecting a trusted cache
root. The Rust factory supplies `<HostServices.state_dir()>/models` only when the host omitted a local cache path;
it does not reproduce legacy plugin-home discovery or environment-based credential fallback.

The lazy local providers validate the profile, revision, width, prefixes and noncommercial consent at construction.
The first inference verifies the files and loads the runtime. e5 uses the tokenizer's 512-token cap; Gemma and jina
use their configured cap, default 512. Tokenization adds special tokens first and then cuts the completed IDs and
attention mask, so an over-cap input loses its closing special token. Gemma uses its profile prompts and bounded
sub-batches; jina v3 supplies the purpose's `task_id`, and jina v5 selects the last attended token independently of
padding side. The process has one active CPU inference session, serialized behind a mutex, with thread limits
derived from the CPUs available to the process. These implementations and synthetic-runtime tests do not establish
real-model parity by themselves.

`embedding::service::Service` implements the RE-01 embedding and model-readiness ports. Successful probes are
memoized; concurrent probes coalesce, refresh queues one new probe, and cancellation ends one caller's wait.
`ServiceOptions::from_config` carries top-level `embeddingBatchSize` (default 8), cache entry/TTL policy and scope
into the facade. Its bounded memory cache uses RE-02 `EmbeddingCache` for optional SQLite persistence. Concurrent
misses coalesce per key in an owned shared worker, independently of the initiating caller's cancellation or deadline.
Every caller waits with its own cancellation budget; an expired initiator cannot poison an active waiter. Provider
computation releases the memory lock, so an unrelated warm hit can return within its own budget. Overlapping batches
publish their owned keys before waiting on another caller's keys, and completed
errors are observed across the batch. SQLite cache read/write failures are best effort and do not reject otherwise
valid provider results. Keys retain
the complete Node v2 tuple and JS trim/lowercase text hash. Local model keys include `:query`/`:passage`; Gemma
includes `@dtype` before the purpose. A missing envelope space still uses the provider's canonical default identity.
New entries start their TTL at compute completion; a hit preserves the original expiry. Serving returns the identity envelope;
the RE-08 host owns RPC listeners and transport tokens. `FlatEmbedder::new(width, cold)` and explicit
`bind_identity` support the configured-width test seam; RE-08 remains responsible for its environment guard.

For RE-08 production integration, construct remote providers with `build_embedding_owned` and
`build_reranker_owned`, passing `Arc<dyn HostServices>`. These retain live host ports and honor cancellation while
waiting for policy, DNS, credentials, TLS, headers and response bodies. Cancellation/deadline shuts down the active
socket. All hops and retries keep the same absolute deadline.

The original `build_embedding(&EngineConfig, &dyn HostServices) -> Result<Box<dyn EmbeddingProvider>, EngineError>`
and corresponding `build_reranker` signature remain available for lazy local providers and disabled rerankers.
They return a structured invalid-configuration error naming the owned factory for an active remote configuration,
including a remote primary with a local fallback. The current contract allows only disabled/local fallbacks;
unsupported remote fallbacks fail configuration deserialization.

This is an explicit ownership correction to the brief's host-borrowing remote mapping, not a claim that the
borrowed path satisfies f.6. Arbitrary blocking synchronous borrowed gate/secret callbacks cannot safely be
preempted without owning their lifetime. Direct borrowed client/provider constructors remain cooperative
compatibility and test interfaces; their docs state that restriction. No unsafe lifetime widening or leaked
borrowed worker is used. Current K and L sources have no production call to migrate; the RE-08 service wiring
must select the owned factories.

Remote providers share `transport::guarded` and named host secret ports. The host forwards `egress.changed` through
`Service::invalidate_egress` to discard decisions in every embedding/reranker client. The Cargo `log` facade has
the compile-time `max_level_debug` feature because `ureq-proto` 0.6.4's TRACE writer can serialize complete HTTP
bytes, including Authorization; marking header values sensitive protects Debug formatting but does not protect
that TRACE writer. A real diagnostic-leak regression test covers this boundary. The tradeoff is global to the
co-built users of the `log` facade: their TRACE macros are disabled too. This feature does not itself disable events
from the separate `tracing` facade.

### Dynamic ONNX Runtime

The crate pins `ort =2.0.0-rc.14` with only `load-dynamic`. It neither downloads a runtime during a Cargo build nor
statically links one. Production supplies an absolute **file** path through `ORT_DYLIB_PATH`, or calls
`embedding::local_ort::initialize_runtime` with a host-verified path. The runtime version is **1.30.0**, matching
`onnxruntime-node` in the Node pin. Distribution and the production installation path remain host/RE-08 concerns.

The test helper [`tests/common/onnx_runtime.rs`](../crates/plur1bus-engine/tests/common/onnx_runtime.rs) invokes
[`setup-onnx-runtime.mjs`](../crates/plur1bus-engine/tests/common/setup-onnx-runtime.mjs) only when its cached CPU
library is absent or invalid. It verifies archive size, SHA-256 and npm SHA-512 integrity, then the selected regular
file's size and SHA-256. The archive SHA-256 is
`6e3390d6b783e7be946fad629292799da28d0b42f84856e50d2c1b0383291e75`. No binary is committed. The test cache is
`<target-directory>/ort/1.30.0/<target>/<filename>`:

| Target | Filename | Extracted file SHA-256 |
|---|---|---|
| `linux-x64` | `libonnxruntime.so.1` | `ffb75a925ba05e47b235bb66e3e3911714a80b328a9c9425539feb204aa32a23` |
| `linux-arm64` | `libonnxruntime.so.1` | `1f549d46250b005580b597f4164984aaf75b3bcb9f3aeb07c7f8a8fe60b23c76` |
| `darwin-arm64` | `libonnxruntime.1.30.0.dylib` | `685d2be5dba1309c89d3a5324b7fd06a5c42f1a61bfea32d14c4cc28d072121d` |
| `win32-x64` | `onnxruntime.dll` | `508c362f5673483dd3a086379c392795b2e42d10d5e6f3f90ebd7ac21c97af67` |
| `win32-arm64` | `onnxruntime.dll` | `6c3a2abf5c6aca11c48a0d338a91af309f2266f25ce2e4084e6a87bbcb0fbfd0` |

For example, prepare the Linux x64 test library with Node 24.21:

```sh
node --use-env-proxy crates/plur1bus-engine/tests/common/setup-onnx-runtime.mjs --target-directory target --target linux-x64
cargo test -p plur1bus-engine --features real-models --lib embedding::local_ort::session::tests
```

The Rust helper passes the verified path directly to initialization and does not mutate process environment
variables. The tiny graphs in these tests exercise real CPU inference, shapes, mutex waiting and native-run
cancellation without any Hugging Face model files.

### Tokenizers, recordings and the outstanding parity gate

Normal `cargo test -p plur1bus-engine` includes `embedding_tokens`, which requires the genuine recorded
`tests/fixtures/vectors/token-ids.json` and the pinned e5/Gemma tokenizer files. Missing inputs fail; they are not
skipped. The existing RE-14 downloader also reads the embedding tokenizer manifest. It writes
`<PLUR1BUS_TOKENIZER_DIR>/embedding-e5-small/tokenizer.json` and
`<PLUR1BUS_TOKENIZER_DIR>/embeddinggemma-2/tokenizer.json`, with SHA-256 verification and no ONNX download:

```sh
export PLUR1BUS_TOKENIZER_DIR=/absolute/external/tokenizer-cache
node --use-env-proxy scripts/tokens/setup-tokenizers.mjs --directory "$PLUR1BUS_TOKENIZER_DIR"
cargo test -p plur1bus-engine --test embedding_tokens
```

The Node recorder resolves the exact engine package from `packages/core` with `createRequire`, checks commit
`9f34008c143c5da87b2194b5a28442b407ff8ba7`, and resolves its Transformers.js **4.3.1**. `--sentences` writes only
the 25 German, 25 English and three additional inputs. Vector modes run one input at a time, disable the provider
cache, and explicitly set Gemma's `maxBatchSize` to 1. `--token-ids` prepares only pinned tokenizer metadata and
encodes with special tokens before cutting IDs and masks. Model downloads reuse the Node artifact verifier in
the external cache:

```sh
export PLUR1BUS_MODELS_CACHE=/absolute/external/model-cache
node --experimental-strip-types --conditions=source crates/plur1bus-engine/tests/fixtures/vectors/record.mjs --sentences
node --use-env-proxy --experimental-strip-types --conditions=source crates/plur1bus-engine/tests/fixtures/vectors/record.mjs --e5
node --use-env-proxy --experimental-strip-types --conditions=source crates/plur1bus-engine/tests/fixtures/vectors/record.mjs --gemma
node --use-env-proxy --experimental-strip-types --conditions=source crates/plur1bus-engine/tests/fixtures/vectors/record.mjs --token-ids
node --test crates/plur1bus-engine/tests/fixtures/vectors/model-recording.test.mjs
```

Embedding recordings reference sentence IDs and store query/passage Float32 vectors using short decimals that
round trip to the same Float32. Each file stays below 1 MB; large recordings use `*-extra-N.json` parts and a
`*.index.json` manifest. Recordings are generated by the pinned provider, never filled in or edited by hand.
`--gemma` preserves T1's identity cases and writes a separate runtime identity/token record.

Vector and reranker parity are isolated in the **required-feature** test target `embedding_parity`; the feature is
`real-models`. They require the pinned ONNX files in `PLUR1BUS_MODELS_CACHE`, the verified runtime, and genuine Node
recordings. For example:

```sh
cargo test -p plur1bus-engine --features real-models --test embedding_parity e5_vectors_match_the_node_engine -- --nocapture
cargo test -p plur1bus-engine --features real-models --test embedding_parity gemma_vectors_match_the_node_engine -- --nocapture
cargo test -p plur1bus-engine --features real-models --test embedding_parity bge_scores_order_matches_the_node_engine -- --nocapture
```

e5 and EmbeddingGemma 2 vectors, the Gemma runtime identity and token IDs (`e5-small.json`,
`embeddinggemma-2*.json`, `identity-embeddinggemma-2-runtime.json`, `token-ids.json`, `token-ids-gemma.json`) are
genuine recordings of the pinned Node engine; e5 is MIT, EmbeddingGemma 2 Apache-2.0 at their pinned model cards.
The BGE conversion `woxpas-ai/bge-reranker-v2-m3-onnx@c44ebc43de724ae8816668bb44d2e728e17faa18` ships no LICENSE
file of its own; by the owner's decision of 2026-10-29 the licence of the original `BAAI/bge-reranker-v2-m3`
(Apache-2.0 at `953dc6f6f85a1b2dbfca4c34a2796e7dde08d41e`) applies. `record.mjs --bge` writes `bge-scores.json` and
`token-ids-bge.json` only against the exact receipt `tests/fixtures/vectors/licences/bge-reranker-v2-m3.json` (the
conversion pin, the original's model card by size and SHA-256, the byte-exact licence text); `NOTICE-bge.md` carries
the attribution. The BGE tokenizer is part of the pinned tokenizer manifest that `setup-tokenizers.mjs` fetches.

jina v3, v5-nano and the jina reranker are CC-BY-NC-4.0. By the owner's decision of 2026-10-29 nothing derived from
them (vectors, token IDs, scores, goldens) enters the repository, CI artefacts, logs or pull request texts; only the
model name, revision and summary figures do. Their parity test therefore records jina vectors, token IDs, task IDs,
prefix checks, padding cases, identities, reranker scores and Node's own batched vectors live into a system-temporary
directory outside the repository and compares against them there. The quantized jina conversions are not
padding-invariant in Node either, so the batched check compares a Rust batch with Node's batch, while e5 and
EmbeddingGemma 2 batches must match their one-by-one goldens. Both `PLUR1BUS_ALLOW_TEST_INTERNALS=1` and
`PLUR1BUS_TEST_ACCEPT_NC_MODELS=1` must be deliberately set before `record.mjs --jina --output-dir <temp-dir>` or the
jina parity test runs; the recorder refuses before any NC model access when either is absent. These are explicit test
consent gates, not production licence records: production still requires the host's persisted model/revision
confirmation and explicit `modelPreparation.acceptNonCommercialLicense`, and possession of model files grants no
consent. The full `embedding_parity` target includes jina and therefore also requires these gates.

### Release build measurement

The [2026-10-28 release measurement](handoffs/2026-10-28-re03-release-measurement.md) compares fresh Cargo targets
for baseline `f56f1bcf` and reviewed RE-03 `c2b2dd21`, with identical release flags and toolchain. Cargo reported
29m 49s / 1,391,488 executable bytes versus 29m 26s / 1,391,120 bytes: observed differences of -23 s and -368 bytes.
This single sample does not establish a speedup; source/OS caches were shared and compile-time variance remains.
The unchanged placeholder entry point also allows unused inference code to be discarded. The report records
binary digests, process evidence, monitoring limitations and why RE-00 dev timings cannot be used as release
comparators. No binary or model payload is committed.

## Native Neo append bounds (RX6 N1 / RE-D125)

The native writer resolves `neo.maxRecords` (40,000) and the independent
`neo.appendDedupeTailRecords` (5,000) from configuration, never process environment.
`neo.retention.days` (90) and `neo.retention.softMaxRecords` (5,000) describe future
RY-A maintenance; append performs no age/value retention. These keys carry
`x-restart: core` and `x-tier: advanced`. The existing 64 MiB acquisition and
50,000-entry index budgets remain separate limits; reaching them refuses work.

Under the existing workspace leases, a completed append bounds the eleven Neo
journals. Active capture, episode, embedding and operation receipts must settle
before their source evidence can be removed. Sources must belong to the current
caller; a required cap involving foreign owners is refused. A held source descriptor,
modification time and SHA-256 bind the exact bytes checked for ownership to the
archive publication. Read-side correction idempotency checks do not compact files.

Removed prefixes are first published as private, synced gzip chunks at
`workspaces/<canonical>/archives/<journal>.cap-<source-revision-sha256>.gz`.
Only then is the live file replaced through the held directory. The key distinguishes
later physical source revisions even when their prefixes contain identical bytes;
retrying one interrupted publication reuses its verified chunk. Archive failure
preserves the live journal and blocks new append admission after pending work has
settled. Native emergency chunks deliberately differ from the release's monthly
archive append; RY-A's value-based monthly archive remains separate work.

`native-append-history.json` retains bounded ownership/deduplication evidence after
live truncation. It is not a data grant. Without that native evidence, content dedupe
uses the configured tail while complete live ID collisions are still checked. Native
plans never derive permission from the ownerless Node compatibility index. Private
`.native-neo-cap-<uuid>.tmp` files may survive a killed process; 128 such remnants
or 50,000 directory entries refuse further staging rather than deleting unknown work.

Canonical workspace names with a matching `<key>--<hash>` resolve to themselves.
Injected recall/system context yields no derived reaction or Behavior-Card. The
release timestamp helper interprets numeric values below 1e12 as seconds; existing
C4 recall ordering remains unchanged. The original Node golden and the SHA-bound
`neo-n1-native-exceptions.json` record the stricter native behavior, including the
strict cap instead of Node's hysteresis and private 0600 archives.

## Locks

The public `Lock` type supports both existing Node layouts; callers select the appropriate acquisition API.
The registry layout creates the file with exclusive-create semantics (`wx` in Node) and writes
`{nonce,pid,host,procStart:{mono,boot},acquiredAt}`. Acquisition age comes from the file mtime. A lock is eligible for
recovery only after `staleMs`; then invalid metadata, a dead holder, a demonstrably earlier incarnation of this same
process, or the 10× hard ceiling can make it stale. A different host uses the configured ceiling clamped between
1× and 10×. `JobLock` additionally prevents reacquisition of a path already held by this process.

Recovery moves the candidate aside, verifies its file identity and content again, and either removes that exact
candidate or puts it back without replacing a new holder. Release follows the same move/check/put-back protocol and
only removes the releasing owner's nonce. Windows transient sharing failures have bounded acquisition and release
retries. There is no heartbeat: rewriting the lock would move the mtime and change how Node judges its acquisition
age.

`Lock::try_acquire_neo` uses the actual Neo directory lock: creating `.neo-write.lock`, then writing its
`owner.json`. An ownerless directory has a 15-second orphan grace. A dead same-host owner or a demonstrably earlier
incarnation of this process can be recovered immediately; a live or foreign holder remains protected until the
10× Neo stale ceiling. Recovery and release rename the directory, reverify its identity and the exact owner bytes,
and put it back if ownership changed. Owner JSON is decoded with Node's lossy UTF-8 semantics and its PID number
coercion; raw bytes remain authoritative for reverification. Short protocol mutations are serialized between Rust
threads, matching synchronous Node mutations within one isolate. The mutex is released before retries and waits;
this does not change the inherited protocol between separate processes. Tests hold the real Node writer's critical
section and exercise both acquisition directions, dead holders and competing recoverers.

`LockGuard::is_neo_owned()` is the additive mutation check: the retained directory identity and exact own
owner-record bytes must still match. It reads at most the known owner-record length plus one byte and refuses links,
changed paths or released guards. It does not renew the Node stale ceiling. Registry `is_owned()` remains separate.

`TrustedDirectory::append_jsonl_durable` gives new Neo writers a bounded ordered-JSON append through a held
directory, with ordinary single-link file identity checked before and after the write. Unix uses no-follow openat,
0600 creation and file/directory fsync. Windows rejects reparse leaves and syncs the file under the existing private
parent policy; native Windows durability acceptance remains required. The caller supplies authorization, a writer
lease and WAL recovery. An append error after writing does not promise rollback. Existing JsonlLedger behavior is
unchanged.

The pin already fixes host-contract f.5: `job-lock.js` explicitly records that mtime alone used to be sufficient,
while the current registry protocol also checks holder liveness/incarnation. Rust deliberately treats EPERM /
Windows access denied as another user's process, hence no valid holder of this owner's private home (f.4). The
supervisor retains its existing behavior, where another user's existing process counts as present. Both use the
shared RPC process module for liveness and zombie detection; the supervisor keeps its pidfd/Windows handle pinning.
The shared location avoids a new crate or dependency line and keeps process identity available to both consumers.

## APIs and scope

`MemoryRow`, `RowPatch` and `RowFilter` preserve the persisted column names and the Node filter grammar. A NULL
column reads as the default of the pin's `normalizeEntryForTable`, or for `text`, `importance` and `category`, which
have none there, as Node's common read fallbacks (`""`, `0.5`, `""`); `createdAt` reads as 0, Node's "unknown". Only a
row without `id` or `vector` is corrupt. Like Node's scans, the filters `status = active` and `memoryKind = memory`
also match NULL and empty values. `Store::delete` refuses an ID that is not a UUID before deleting anything, as Node's
`MemoryDB.delete` throws for one, and deletes every ID, in lists of at most 100. Updates use
native partial Lance updates, so concurrent changes to different columns do not overwrite each other. Content writes
and content patches consult the actual tombstone registry; legacy rows with blank agent metadata use the physical
namespace solely for this guard. Stored fields remain unchanged. Registry repair only quarantines and truncates an
incomplete final record under the shared lock; complete corrupt records fail closed. Table compaction runs only
through the capture compactor (`Store::optimize_fragments` under its per-table busy claim, RE-D161); expiry purge preserves `neverForget` and core rows, with the existing
five-minute per-database throttle. `StorePool` (the Node agent-pool counterpart) retains leased handles and
evicts only idle least-recently-used entries after its soft bound.

The eleven ledger types expose fixture-derived known fields and nested shapes, including `JsString` for fields that
can retain lone surrogates. Their tolerant codec preserves unknown fields, historical optional shapes, object order
and unedited numeric lexemes. `JsonlLedger::append` is one `O_APPEND` write, like Node's `appendFileSync`, and never
replaces the file: Node appends to several of these files without any lock, so Rust and Node appenders must keep each
other's lines. Like Node's, the append is not fsynced. State and ledger IO primitives do not implement the downstream
knowledge-curation, rebind, recall or capture workflows; the concrete fold boundaries are recorded in
[`MODULE-MAP.md`](superpowers/plans/rust-engine/MODULE-MAP.md).

Several assumptions in the brief/audit differ from the pinned writer. There is no `generation.json`: `generation()` and
`write_generation()` operate on `vector-index.json`, and the filename `vectors.<n>.f32` supplies the generation.
No extra generation file is introduced. The journal field is `content`; the genuine lone-surrogate example belongs
to `memory-candidates.jsonl`'s `normalizedStatement`. The audit's claim that Neo used the registry-file lock was also
incorrect: both existing lock layouts are implemented without replacement or migration. Finally, the pinned
`checkpoint-store.js` is an in-memory checkpoint map. `store::checkpoint` preserves its timestamp and digest behavior;
it introduces no persisted checkpoint file. Existing file-based hook/re-embedding states use `StateFile` as above.

## Recall rendering and maintenance (RE-04/T5)

T5 receives already selected rows through `SelectedRecallPipeline`; it does not depend on the
separate T4 branch. `assemble_context` forwards `recall.maxPromptMemories` (default 12, bounded
1–100) and numeric `summaryMaxWords` (default 150, including decimal/exponent encodings). Rendering returns the original `neo`, `start`,
`memories`, `time`, `temporal` and `reminder` blocks with UTF-16 `chars`. The inner memories cap
runs before the aggregate host plan; callers join using `inject_budget::plan` so the original
block array is not capped twice. `tokensEstimate` is absent, matching Node.

The renderer writes no store, session, reminder, Neo or ledger files. `RenderEffects` carries
caller-owned presentation intents; CA5 supplies `NeoPrelude`, and RE-08 supplies the selected
pipeline and maintenance composition. `maintenance::record_retrieval` checks the canonical
request and patches only `retrievalCount` and `lastRetrievedAt`. Its warm mode returns before
opening a row. `WarmRecall` exposes only existing read-only leases and forwards memory-only
embedding/no-ledger/no-summary/no-emotion flags. Tests also run a native read-only vector query
and compare every database file, row and existing ledger byte. RE-08 must honor these flags for
every embedding identity; T5 does not wire the persistent provider service itself.

Semantic Lens hydration checks each raw row with the same T1 `check_access` as CRR hydration,
before quotas or projection. Rejected rows generate no prompt text, ledger data, log or counter.
This is the sole controller-authorized exception to the Node pin, documented in the
[stop report](superpowers/plans/rust-engine/RE-04-T5-semantic-lens-acl-stop.md) and marked only
on the four affected runtime cases in the [T5 fixture README](../crates/plur1bus-engine/tests/fixtures/recall/golden/render/README.md).
Node itself is unchanged. Full trace normalization, timing, deadlines and degraded orchestration
remain RE-04/T6; durable reminder/session workflows remain with their owning RE-05/RE-06/RE-07 tasks.

The [T5 review rulings](superpowers/plans/rust-engine/RE-04-T5-review-rulings.md) record
the single fix pass, remaining owning-task boundaries and the protected T0 zero-word follow-up.

## Fixtures and upgrades

Run from the repository root with Node 24.21, pnpm 10 and Rust 1.95 available:

```sh
pnpm test:prep
node crates/plur1bus-engine/tests/fixtures/store-v1/make.mjs
node crates/plur1bus-engine/tests/fixtures/store-v1/make.mjs --surrogate
node crates/plur1bus-engine/tests/fixtures/store-v1/make.mjs --dump
node crates/plur1bus-engine/tests/fixtures/sqlite/make.mjs
node crates/plur1bus-engine/tests/fixtures/neo-v1/make.mjs
cargo test -p plur1bus-engine
```

Each recorder resolves the pinned package through `createRequire` from `packages/core`, verifies the exact manifest
and frozen lockfile, and refuses a linked override. Lance's UUID filenames and manifests make binary directories
nondeterministic. Regeneration equality therefore compares the ordered JSON row dump without vectors and the neutral
schema text; it does not compare binary file diffs. Do not regenerate Lance fixtures without a semantic change.
The composite 12-row fixture contains real captures from two agents, two workspace rows, two user rows, a row passed
through `memory.forget` (Node persists `deleted`/`invalidated`) and a reminder. The separate surrogate fixture records
Node's U+FFFD replacement at the Arrow UTF-8 boundary. Each fixture directory stays below 1 MB.

The committed fixture directories, including their recorder sources, contain:

| Fixture | Bytes |
|---|---:|
| `store-v1` | 404,991 |
| `store-surrogate` | 60,567 |
| `sqlite` | 77,026 |
| `neo-v1` | 37,550 |

Every change to the exact `lancedb`/Lance pin must repeat both directions of the Lance, SQLite, neo and lock round
trips against the Node package still in use. Compare storage-version, manifest-path and index options as well as
rows and `identityStatus`. A difference stops the upgrade: it needs an owner-approved migration and an explicit
`STORE_SCHEMA_VERSION` decision, never an implicit compatibility repair. Keep Arrow, Lance, Tokio and SQLite on one
dependency line. The Linux proof is local; macOS and Windows run the same tests in the labeled CI legs.

## Native maintenance authority and explicit marker migration (RX / F7)

The productive Core calls `engine.admin.migrate` and reembedding `plan`, `apply`, `resume`, `status`, and `validate` after its system-scope Owner/Admin RBAC check. Their native replacement uses `MaintenanceOps` with a `MaintenanceGrant` issued only after authenticating that Core connection. The grant is neither a person nor a Principal; disconnect revokes it. The wire schema and RPC version do not change. The legacy Principal-bearing administrative migration traits remain unavailable. Native service composition is completed in RX8; the grant alone does not enable a maintenance method.

`ops::migrate::SchemaMigrator` records a durable maintenance audit before mutation, with the wire method, Core-link instance, schema target and `actor: core-maintenance`. It never records an operation payload or derives an owner from a fallback name. Audit failure rejects the operation. A nonce-owned `_schema-migrate.lock` fences competing Rust migrations, and cancellation/ownership are checked again before atomic marker replacement.

The pinned Node `0 -> 1` migration only writes `_schema.json`; Rust preserves that behavior and the marker bytes. It does **not** add legacy Lance columns, upgrade shared-memory metadata, migrate identity tables, rewrite vectors or remove existing rows. These transformations are separate work: a marker must not be treated as proof that they ran. Unknown versions and downgrades are rejected. After a successful `migrate("0", "1")`, another call with the stale source `"0"` returns conflict; `migrate("1", "1")` returns `applied: false` without rewriting the marker. Leading-zero version strings retain the Node comparison and persistence semantics.

## Committed tombstones after restore (RX4 / S5b)

`ops::tombstone_reapply::reapply` reads the original store's sibling `_tombstones` registry and operates on an explicitly selected physical generation. It applies only committed entries, sets `status=deleted` and `epistemicStatus=invalidated`, and leaves text, vectors and timestamps intact. It then independently checks every addressed row, including rows whose update failed. Storage errors, corrupt registry lines and rows still active make `ReapplyReport::failed()` true; callers must retain the restore marker and refuse to treat recovery as complete.

`GenerationReapplyTarget` uses a bounded existing-table pool. Neither inspection nor applying to a missing table creates a replacement table. A missing agent is reported as not found; an existing agent with an unreadable or missing table fails verification. Dry-run opens readonly, does not repair registry tails and reports active rows without changing them. Applying may repair a torn tail. Repetition leaves already deleted rows untouched and creates no new Lance version. The original generation and opaque registry metadata remain unchanged.

The 24 S5 Node/Lance fixtures in `tests/fixtures/ops/golden/reapply.json` cover apply/preview, missing stores/rows, duplicate commits, torn/corrupt registries and injected write/verification failures. They were recorded twice from the immutable S5 source identified in `s5-sources.json`, with network disabled. Native tests additionally cover selected-generation routing, unchanged lossless registry bytes, cancellation and non-creation of missing tables. This is the internal generation service: startup-marker consumption, full configured-route composition, snapshot/restore journals, process-crash recovery and deferred pre-restore retention remain RX4/RX8 integration work. The Node Core fallback is unchanged.

## Engine snapshot verification (RX4)

`ops::snapshot::verify_snapshot` reads `plur1bus.snapshot/1` directories and returns Node's `id`, `files` and `bytes` fields. Every regular payload must be listed and match its recorded byte length and SHA-256. The verifier does not modify files or repair malformed input. Unknown metadata, duplicate JSON members and duplicate file paths retain Node's last-value semantics; non-path entries count toward the reported manifest length but are ignored as in Node. The total `bytes` field retains Node's numeric coercion and is diagnostic metadata, not a substitute for the individual size checks.

RE-D40 keeps the existing Rust filesystem boundary: manifest traversal and nonportable paths are refused before any payload read, and manifests cannot be symlinks. Reads are relative to held directory capabilities with no-follow ordinary-file opens; special files cannot block hashing. Manifests are limited to 64 MiB and parse errors contain no input text. The actual Node acceptance of a `../outside` synthetic sibling and a colon-bearing filename remains in the recorded vectors, with precisely those two native exceptions. Twenty-eight verifier cases were recorded twice from the frozen C7 source; separate native tests cover links, FIFOs, oversized manifests and unchanged input bytes. Snapshot creation, cross-language create/verify round trips and restore-journal integration are still pending.


The internal snapshot payload copier now handles plain trees and consistent Lance table copies: data/index/deletion/transaction entries precede `_versions`; the newest source manifest must remain byte-identical and match the copied head; every protobuf data/transaction reference found by the Node scanner must exist. Inconsistent or vanished table files retry up to three times, discarding the earlier table tree and file index. Decimal version ordering preserves arbitrary-width v1 and inverted 20-digit v2 filenames without a new dependency. The final file index follows JavaScript UTF-16 ordering.

Capability-relative `mkdirat`/exclusive file creation on Unix protects private staging files; the verified-path Windows fallback never overwrites a leaf. Cancellation is checked between entries and every 64 KiB, and overlapping source/staging roots are refused. Child links and special files are skipped as in Node. The exact `store/llm-result-cache-v1` subtree is omitted per C8/GP5; similarly named ordinary paths remain. RE-D41 records this explicit correction to C7, with the original Node result retained. Twenty-one actual C7 copier cases were recorded twice, including two real synthetic Node/Lance tables. Five native tests cover that matrix plus cancellation, cleanup, path overlap, links and private file modes. This internal module does not yet publish snapshots: host authority (F9), manifest publication, retention, full create/verify round trips and restore recovery remain pending.

## Native model requirements (RX3 / Controller F8)

`ops::models::inventory` and the additive `ModelInventory` trait report the actual constructed embedding provider, primary reranker and enabled fallback in runtime order. `Service` and `ProcessEngine` implement the trait in-process; `Engine::models()` still returns the unchanged readiness/warm service. Provider metadata comes from the same instances that perform inference, including inferred remote model defaults and host-selected local caches, instead of reimplementing configuration resolution. Custom providers without metadata are explicitly unresolved.

Each requirement includes role, provider, model, selected local revision/dtype, catalogue licence (when declared), expected artifact count/bytes and read-only artifact status. Missing files/caches report `missing`; absent cache selection, unknown catalogue identity and unsafe paths report `unresolved`; mismatched lengths/digests report `invalid`; other read failures report `unavailable`. `verified` means every pinned local file matched its size/SHA-256, not that ONNX Runtime or a provider is ready. Remote models report `remote`, without an inferred local licence. No cache paths, URLs or credential references are serialized.

Inspection neither prepares nor downloads models and does not warm/probe the readiness service. File reads use trusted directory capabilities; cancellation is checked between files and every 64 KiB. Full artifact hashing can take time and is intentionally explicit. A closed service refuses the native operation. RE-D42 corrects the old plan's conflicting `Engine::models()` list signature; no protected RPC, EngineClient, schema or TS changes are part of this operation.

## Reembedding confirmation primitive (RX5)

`ops::reembedding::confirmation` implements the C2 confirmation encoding, domain-separated SHA-256 proof/plan binding, closed persisted envelope and strict expiry. Production creation uses 32 bytes from OS entropy; only tests can supply deterministic entropy. The operator proof has explicit exposure and redacted Debug, but no Serialize implementation. The separately serializable persisted envelope contains schema version, proof hash, plan digest and expiry, matching Node exactly. Verification accepts the same JavaScript-safe integer semantics, rejects unknown fields and uses constant-time digest equality. Binding verification intentionally omits TTL for the coordinator's explicit-resume flow; normal verification requires `now < expiresAt`.

Twelve creation and 31 binding/expiry vectors were recorded twice from the frozen #266 C2 source. Goldens store proof digests, persisted metadata and synthetic entropy inputs, never literal operator proofs. This primitive does not consume a confirmation or grant maintenance authority: F7 audit/authorization, atomic one-time state transitions, batch copying, validation, switch and rollback remain coordinator work.

### Native Neo capture publication (RX6 / RE-D62)

`CaptureJournal` consumes the existing role/content TurnRecord and explicit expected RequestContext.
It creates no files for incognito, cancelled or policy-denied capture. Newly captured turns, candidates,
reactions, behavior and embedding-queue entries carry canonical ownership and agent-private visibility;
a workspace association does not authorize sharing. Same-ID foreign or ownerless records are refused,
and candidate-content deduplication is restricted to the proved owner/agent/workspace.

A frozen plan retains original timestamps across interruption. Complete JSONL records are individually
fsynced; only an incomplete final line may be truncated during recovery under both writer leases.
Malformed complete lines fail closed. The candidate index preserves older global history and chooses
the newer revision before projection; the Node-compatible record index retains historical deduplication
keys. Only after both indices are published is the pending plan settled. This is recoverable publication,
not atomic multi-file visibility to concurrent readers. Reads/preflight refuse journals above 64 MiB or
50,000 complete lines; no automatic retention or eviction of pending work is implied.

The macOS tests include a killed process after one durable row, concurrent writers, revoked policy,
physical replacement, corrupted plans, links and exact recorded Node file projections with declared
D130 stamps. Native Windows durability acceptance remains pending. Runtime capture-hook activation,
open-time enumeration of other pending principals, retention, embedding drain and episode/checkpoint
coupling are separate remaining composition work.

`neo::episodes` provides the deterministic C4 ordinary-capture builder and stable chronological
grouping. IDs and time are explicit, topic/voice classification uses recorded Node Unicode17
algorithm data, and speaker labels are display metadata only. No model, workspace file or journal
is accessed. This constructor does not itself grant authority, continue an open episode, publish
episodes or advance a checkpoint. Its timestamp boundary accepts ISO/RFC3339 strings and numeric
epochs; nonstandard V8 date strings are not silently interpreted.

`turn_batch::from_messages_since` selects episode work at a raw-message watermark after
normalizing the complete prefix (RE-D63). This keeps repeated-content ordinals, assistant reply
links and display positions identical to the full journal. A compacted history shorter than its
watermark restarts selection at zero. Persistence must still look up the selected actual source
rows under current authority and retain their durable timestamps; selection alone advances no state.

### Native episode/checkpoint publication (RX6 / RE-D64)

`EpisodeStore` composes the actual capture journal, shared EmotionalPool and principal-bound
SessionStore. Selected RE-D63 IDs resolve to real durable turn rows and timestamps. Every source
(including open-episode snapshots) must still belong to the actual owner/agent/workspace and
remain private and visible. Source changes, missing history and unexpected predecessor revisions
fail closed before a new publication plan is recorded. Participant labels currently use the
deterministic fallback; USER.md/IDENTITY.md resolution and narrative enrichment remain separate.

Lock order is native capture kernel lease, interoperable Neo writer lock, then principal hook
checkpoint lease. The pending plan freezes episode UUIDs/content, mood, source/predecessor
fingerprints and both checkpoint states. Each episode revision is fsynced before the complete
checkpoint is atomically replaced. Replay accepts only the exact previous or already-committed
next checkpoint and exact matching episode revisions; it cannot rebase over unrelated progress.
A killed partial JSONL tail is truncated under the writer leases and replayed from the frozen plan.
The checkpoint is not advanced by retry exhaustion. Once committed, absent episode rows are
corruption, not permission to regenerate an acknowledged episode. Readers can observe individual
rows during publication; this does not promise atomic batch visibility.

Open episodes and remembered turn IDs live in `agentEnd.episodeSessions`, keyed by the same
opaque prefixed session key as `sessionWatermarks`. Eviction follows the existing 500-session
map, the ID suffix remains 2,000, and the full private checkpoint retains its 4 MiB limit. The
episode journal and pending file retain 64 MiB / 50,000-row bounds with preflight refusal. No
implicit history retention or pending-plan deletion is introduced. The frozen Node role/content
digest shortcut is not an acknowledgement: native replay uses durable turn IDs and the exact
checkpoint, allowing distinct repeated turns without reusing an earlier ordinal.

Recovery here is on the next explicitly authorized operation for the bound owner/agent/workspace.
Host-wide startup enumeration/original-principal restoration, the full engine checkpoint digest,
embedding drain/generations, vault publication and process activation remain later composition.
`neo_episode_store` and `neo_episode_store_edges` exercise real files, concurrent writers, both
SIGKILL boundaries, revocation, source/checkpoint changes, links and torn tails. Existing session,
journal and Node episode parity tests remain unchanged. Native Windows execution is not claimed.

`NativeNeoCaptureHook` now implements the existing CapturePipeline trait with this actual
EpisodeStore. It freezes the same effective host config as the capture pipeline. Enabled Neo
records sources at the pre-store boundary; post-store foreground work publishes deterministic
episodes, while disabled Neo/background capture uses the same pending-safe transaction to
advance only session state. No new episode source files are created by disabled Neo. Incognito
remains side-effect free. CaptureRuntime retains its explicit unscheduled inline diagnostic for
`deferPostTurnLlm`; this hook creates neither a model job nor a scheduler. The integration test
`neo_capture_hook` runs CaptureRuntime, NativeCaptureClassifier, shared mood and actual Lance
writes in four offline modes, including the deferred request. ProcessEngine activation and
startup replay remain separate RX8/T6 gates.

### Original caller during Neo recovery (RX6 / S2a / RE-D65)

Private capture envelopes carry `caller: { principal, agent }`; episode plans carry the same
metadata inside `plan`. These are the original typed Principal/AgentContext, not a reconstruction
from ownerUserId. Caller JSON is bounded to 64 KiB, remains in the private fsynced plan and is
cleared on successful settlement. No transport credential or extra host metadata is added.

Recovery validates the original caller against current HostServices workspace resolution, the
plan's canonical/physical ownership proof and CapturePolicy. Every mutation rechecks both the
triggering request and original caller; a later allowed chat cannot revive a revoked original
chat's work. Episode checkpoint leasing also uses that original identity. Missing, malformed,
foreign and oversized original identity fail closed with the pending file preserved; there is
no inferred owner or broader fallback. Older settled capture envelopes need no caller, while
older active envelopes without one require explicit repair. Global startup enumeration remains
separate from this per-plan identity restoration.

### Opening the native capture hook

`NativeNeoCaptureHook::open` runs `EpisodeStore::recover_pending` before exposing the hook.
EpisodeStore's low-level `open` itself remains read-only. Recovery inventories only committed
`native-capture-pending-<sha256>.json` and `native-episode-pending-<sha256>.json` files. Each
active file must match the original caller's canonical workspace directory, logical filename,
physical ownership proof and current policy. The full read-only inventory precedes replay;
links, corrupt/unrestorable identities and misplaced active plans fail closed. Uncommitted
atomic-write temporary siblings are neither read as plans nor deleted.

The inventory is bounded to 50,000 directory/file entries and 512 distinct ownership bindings;
caller and file byte limits remain unchanged. Exceeding a bound refuses rather than truncates
or evicts. A pass shares one five-minute deadline and the existing writer/checkpoint leases,
reauthorizing the original caller at each mutation. No new TurnRecord, message, session count
or episode is synthesized. Captured rows replay from prepared journal plans; an already durable
episode can finish its prepared checkpoint with zero newly appended revisions. Repeated clean
opening writes nothing. Aggregate local counters contain no caller IDs or content.

This recovery covers prepared **Neo** publications. It does not replay the independent Lance
capture WAL, recreate an episode whose plan was never persisted, or activate ProcessEngine.
Whole-turn recovery and composition of engine checkpoint/drain remain explicit T6/RX8 work.
Eight real-file startup tests cover empty/read-only opening, prepared episodes, partial capture,
two original principals, denied policy, misplaced filenames, orphan temporary files and waiting
behind a held writer with a cancellation deadline. Existing real SIGKILL suites remain green.


### Native embedding publication (RX6 / RE-D66)

`EmbeddingDrain` performs synchronous, bounded Neo queue work through the existing
`EmbeddingProvider`, `EpisodeStore`, original principal, actual Host and CapturePolicy.
Both native kernel and actual Node Neo writer leases remain held through selection,
inference and publication. Current exact queue/source revision and private authority are
rechecked before each provider disclosure and before freezing the plan. Semantic revision
ordering prevents a later physical row with an older timestamp from replacing a current
source. Foreign queue entries are excluded before counts; inaccessible/deleted targets are
reported as missing without sending their content to the provider.

The caller chooses low/medium/high/critical/all impact. The default is low and 100 attempts;
zero also selects 100, and more than 1000 refuses. Failed attempts consume the bound, unlike
Node's success-only cap. Cancellation before plan persistence publishes no partial batch.
Provider error text is replaced by fixed reasons. Inputs with non-UTF8 text/IDs refuse rather
than silently embedding a lossy conversion. No LLM job or detached scheduler is created.

A private frozen plan saves original caller/proof, old/new target and queue revisions,
old/new model-space marker and manifest, complete binary prefix hash and exact appended
Float32 bytes. Replay first reauthorizes the original caller and validates every source,
metadata and binary precondition. It then resumes only an identical missing byte suffix,
fsyncs the file/directory, publishes model binding and Node manifest, appends target revisions,
then queue statuses, refreshes both indices, and clears the plan. Previously present complete
bytes/rows are fsynced again before acknowledgement because the previous process might have
died between write and sync. Vectors remain in Node's memory/behavior/turn grouping; existing
manifest entries retain insertion order and unchanged offsets. Repeated targets keep all
vector appends and only their final metadata revision. Old-manifest readers retain their
unchanged vector prefix; atomic batch visibility across journals is not promised.

The sidecar is workspace-wide. Another binding's open embedding plan blocks a new drain
until that publication settles, preserving its frozen prefix. Capture of a binding with an
open embedding plan waits for recovery. `EpisodeStore::recover_pending` now inventories and
replays embedding plans after prepared episode work; `NativeNeoCaptureHook::open` and
`EmbeddingDrain::new` finish that prepared work before admission without new inference.
The low-level EpisodeStore constructor remains read-only. This does not replay the Lance WAL,
recover unprepared capture work, activate ProcessEngine or perform legacy model-space
migration/compaction. The actual capture-hook scheduling boundary is described below.

Actual C4 Node recordings cover 32 scenarios twice. Native comparison checks 30 matching
rounds plus explicitly SHA-bound exceptions. Real SIGKILL tests interrupt before binary write,
after binary sync, after manifest, after target metadata and after queue append. Recovery is
checked for no new provider calls and no duplicate vectors/rows; separate tests cover partial
binary tails, source/plan corruption, model changes, revoked original chats, foreign principals,
links, cancellation and competing pending publications. These are process-death tests, not
physical power-loss or native Windows acceptance.


### Capture-hook automatic embedding drain

`NativeNeoCaptureHook::with_embedder` binds the composition's existing provider. It does not
construct a model or create a scheduler. Effective `neo.embeddingDrain` controls enabled,
impact and maximum attempts (Node auto-drain default: enabled/low/250; native maximum: 1000).
The internal optional `NeoCaptureHook::after_capture` runs only after successful Neo recording,
after primary capture has returned, including empty-turn/early-return paths. A failure is
reported through the existing content-free Neo diagnostic sink and cannot replace the
primary capture result. Main row/episode work therefore precedes maintenance.

The pipeline narrows the existing cancellation deadline to the configured capture budget
measured from worker start; it never grants a new budget after primary capture. The hook
then preserves Node's ten-second margin and requires at least three usable seconds. Missing
budget, exhausted time, incognito, disabled configuration or cancellation does not invoke
inference. Background episodes stay disabled as before; configured background Neo drain
still processes the authenticated queue. Direct hook calls without a deadline do not invent
one. No detached/LLM job is introduced, and ProcessEngine activation remains separate.

Real Runtime → classifier → Lance → Neo tests cover eight configurations, two normal turns,
empty following turns, provider failures retaining deferred work, and assertions that every
Neo embedding follows a real Lance commit and receives only the reduced remaining budget.

### Whole-capture admission recovery (RX6 / RE-D67)

`CapturePipeline` retains each admitted original TurnRecord, Principal, AgentContext and
CaptureOptions in a private `_capture-admissions/<sha256>.json` envelope before Neo or Lance
work. The plan binds the effective config, vector-space identity, original caller, canonical
workspace and physical workspace/admission directory. Its batch clock does not move on retry.
The Node-compatible `_capture-turns` row-ID WAL remains unchanged; its turn lease is always
acquired before the admission lease. Another authorized chat with the same Node replay key
cannot borrow the original capture's pending input or rollback rows.

`CaptureRuntime::new` first validates the bounded inventory and resumes original admissions
before accepting new turns. Primary recovery preflights every surviving planned row, including
its full fingerprint, before deleting any row. The final Lance delete compares every persisted
column and the whole Float32 vector against that exact row; a later edit prevents deletion.
The predicate is balanced to bound expression depth. Legacy ID-only WAL state has no original
messages or principal and is not autonomously replayed; explicit host redelivery retains its
existing narrower provenance checks.

Before WAL settlement the admission switches durably to post-store, retaining original row
order, fingerprints, counts and post-store reference time. A settled WAL therefore cannot
hide unfinished classifier/Neo work, and post-store recovery cannot create primary rows again.
Unknown effect implementations refuse crash reentry. The actual native classifier supplies
recoverable reminder effects; NativeNeoCaptureHook uses its source-bound journal/episode CAS.
Known partial primary outcomes retain their Node result/keep-partial behavior; recovery does
not silently turn `capture-incomplete` into a successful full capture.

Each selected-message reminder receipt freezes the chosen row, ID and deadline before its
upsert. On replay the original time and source are checked again. Existing original lifecycle
updates, including acknowledgement/cancellation, are retained without another insert. Changed
body/vector/authority/time, a missing previously existing target or a tombstone refuses replay.
The outer admission owns these receipts until classifier and Neo completion; there is no TTL
that drops receipts while their capture is still pending. Completion atomically clears private
payloads. An ordinary invocation that observes caller abort or timeout also clears its private
recovery payload without new effect work; existing committed rows and legacy WAL retry semantics
remain. The startup recovery budget is distinct: its expiry retains the original plan for retry. Pending work is never evicted. Limits are 512 active records, 64 MiB total inventory,
10,000 primary row fingerprints, eight reminder receipts per capture, JSON depth 128 and
50,000 directory entries. A shared capacity lease serializes admission growth.

Typed Lance reads and capture records now parse numeric lexemes with correctly rounded Rust
number conversion. The prior default JSON parser could turn `0.41733280085163044` into the
adjacent Float64 value, defeating an exact before-write fingerprint. The unchanged classifier
golden is read through the same exact numeric parser; no expected output bytes or tolerance
were changed. Duplicate typed JSON fields, non-finite numbers and unpaired UTF-16 are refused;
existing tolerant Node/Neo UTF-16 handling remains separate.

Real SIGKILL tests cover row planning, a committed first row, row settlement and both sides of
reminder publication. Reopening does not call `accept(turn)`. Tests also cover no run ID,
changed clock, acknowledged/cancelled reminders, different authorized chats, policy revocation,
changed config/model/physical workspace, edited rows, malformed/oversized records and links.
This composes the native CaptureRuntime, not ProcessEngine/Core startup. It does not establish
physical power-loss or native Windows acceptance, implement deferred dynamics/remaining T4
side effects, or complete RX6 checkpoint/ProcessEngine composition.


### Deferred reply-outcome dynamics (RX6 / RE-D68)

`capture::deferred_dynamics` provides the frozen Node queue's per-agent FIFO,
oldest-waiting eviction, first-options process singleton, fallback timer and explicit
kick/drain lifecycle. It is an in-memory queue of reinforcement callbacks, not a
capture WAL, persistent job queue or deferred LLM runner. The six existing actual
Node queue vectors remain unchanged. No database effect is authorized by its agent
key: productive callbacks must retain and revalidate their original caller, physical
store binding and policy at the effect boundary. ProcessEngine/RecallDeps composition
and the actual reply-outcome writer remain separate work.

Timers carry their lane generation. Automatic delivery is rejected after close or
a later timer registration. Spawn/handle registration and close share the queue
mutex; close cancels and joins timers, while queued and running callbacks remain
available to an explicit drain. An already active lane may continue queued callbacks,
as in Node. `kick_background` starts without waiting; `kick`/`drain` await completion;
`drain_with_cancel` stops waiting without releasing ownership of an unfinished callback.
An unwinding callback panic is counted and later callbacks continue. Queue diagnostics
omit callback contents; the process panic hook remains host-owned.

Native bounds deliberately replace Node's unbounded distinct agent lanes/Infinity:
twice available logical CPUs, clamped to 4–64 retained lanes; at most 1,024 waiting
callbacks per lane, 4,096 total, 128 bytes per agent key, and twice the lane limit for
each retained worker/timer handle collection. These count entries, not the opaque
callback capture bytes. Excess admission is refused without evicting another agent;
a full lane can still replace its own oldest callback. Finished handles are reaped.
Worker resource/spawn failure restores the original callback and explicit drain
reports unavailable for retry. Lanes retain insertion order and cumulative counters
until queue disposal, so exhausting the distinct-agent cap requires a new independent
queue; the process singleton remains closed once closed, matching Node.


### Contradiction detection boundary (RX6 / RE-D69)

`capture::contradiction::Detector` ports actual frozen Node meaning-overlay and
memory-text pair selection through the existing `LlmPort`. It retains input order,
same-target eligibility, the distinct pair-budget rules, summary-before-text selection,
exact two-message prompts and the trimmed/lowercased `yes` prefix decision. Ordinary
provider failures produce no conflict and a fixed content-free diagnostic; caller
cancellation remains an error before and after the provider call. No provider is
constructed, and the detector grants no source access or mutation authority.

The actual Node recorder verifies all seven imported module hashes at pin
`9f34008c143c5da87b2194b5a28442b407ff8ba7`, fixes only time and normalizes generated
record UUIDs. Fifty cases were recorded twice byte-identically; Rust compares all
results, call order, full messages and SHA-256 prompt bytes. New golden:
`crates/plur1bus-engine/tests/fixtures/capture/golden/contradictions.json`.

Native bounds are 512 input records, 1,000 model pairs and 65,536 UTF-16 units per
selected description. Inputs exceeding the record/description bounds refuse before
model egress; excessive configured pair counts are capped. An unpaired source UTF-16
unit refuses because the frozen LLM contract accepts UTF-8: source content is not
silently changed. This stage requires already authorized source snapshots from its
native caller. Contradiction-ledger persistence, current-authority rechecks around
productive effect composition, conflict resolution and complete T4 activation remain
separate work; a positive model result does not resolve or discard either memory.


### Native reconsolidation effects (RX6 / RE-D70)

`neo::correction_effects::NativeCorrectionEffects` implements the existing
`CorrectionEffects` port used by real `MemoryWriter::safe_update` and `correct`.
It captures the original Principal/AgentContext/Cancel, physical workspace and
registry directory. The supplied CaptureJournal owns the existing kernel workspace
lease, interoperable Neo lock and current policy adapter. Runtime composition must
supply the policy appropriate to the original operation; this does not activate Core
or turn an automatic-capture decision into a manual-operation grant.

Every operation rebuilds the original current context, compares the trait caller and
physical handles, and revalidates policy through the shared journal transaction.
Source and successor must actually exist in the private table, have matching private
owner/agent/workspace, satisfy the real predecessor/supersededBy linkage, and remain
untombstoned. Graph peers are independently checked in the actual table and registry;
a visible edge is never authority to access its other endpoint. Foreign, ownerless,
deleted or forgotten peers cannot be rewritten. Backend/read errors propagate rather
than masquerading as an ineligible peer.

The graph reader retains current revision/ACL-before-tail semantics and a 10,000-row
limit, including safe read-only legacy overlay. Writes stay canonical. Existing
identical full rewritten records are detected by SHA-256, so retrying a partially
completed effect does not duplicate anonymous edges. Event lookup is canonical-only,
filters current private authority before the last-1,000 bound, and never borrows a
legacy event receipt. Newly appended Node-shaped events additionally carry explicit
private owner/agent/workspace binding; conflicting nested authority is refused.

Appends are fsynced and bounded to 64 MiB / 50,000 rows per ledger and 1 MiB per new
record. Torn, malformed, symlinked or hardlinked files refuse without rewriting their
contents. The shared operation writer refuses unfinished automatic capture/episode/vector
plans; it never replays them under a manual correction policy (RE-D72). There is no new graph-effect WAL or
automatic repair of damaged effect journals. Lance commits and optional Neo effects
remain separate, best effort steps, as the existing Node safeUpdate port specifies.
Actual C4 reviseRecord/curation, conflict resolution and full process composition are
not supplied by this increment.


### C4 revision publication (RX6 / RE-D71)

`neo::revisions::RevisionStore` implements actual keep/drop and memory
promote/demote/prune/tombstone publication. It uses CaptureJournal's native
workspace lease and interoperable Neo lock, with the policy appropriate to the
human operation supplied by runtime composition. Its native request contains a
stable UUID and complete expected source revision. That snapshot is compared
against the actual latest row under lock; it never grants access or creates a
missing source. Behavior takes precedence over candidates before ACL checking.
A newer inaccessible behavior row cannot be hidden by falling back to a candidate.
Safe legacy metadata is read only; revisions stay in the canonical file of the
original record type.

Source authority must be explicit, consistent, currently accessible and bound to
the actual workspace. The transition preserves all source fields, including opaque
UTF-16 values, and does not broaden scope. `global_user` permits another agent of
exactly the same owner; source agent/scope/owner survive into its derived queue.
This adapter does not add cross-workspace discovery or broaden the existing
private-only embedding drain. Stale snapshots, backwards host clocks, changed
physical workspaces and revoked original callers fail closed. A changed revision
requires a fresh decision, unlike Node's permissive stale-hint fallback.

One private `native-revision-state.json` per workspace retains the pending or last
completed operation, original serialized caller and physical ownership proof,
action/time, and exact pre-append lengths/SHA-256 values. The source revision is
fsynced first, the mandatory private audit is fsynced next, and only then is the
embedding queue published. Keep/drop creates no queue entry, matching Node.
Audit fields follow the actual command source, plus operation ID and explicit
private actor authority. A preexisting pending queue entry is retained as Node
specifies, after authorization; the ownerless compatibility index grants nothing.
Both compatible indices are refreshed before the receipt is marked complete.

An identical retry or explicit same-caller `recover` uses the frozen operation
without another confidence/salience increase or a new timestamp. A retained last
receipt makes the immediate retry idempotent; older requests after a later
operation fail their exact source CAS. There is no unbounded receipt history.
Only a partial line matching the exact planned bytes after the matching frozen
prefix may be truncated and replayed. Unrelated appends before the planned one,
changed sources, corrupt plans, symlinks and hardlinks refuse without overwrite.
An audit failure leaves the private plan and blocks queue publication. The actual
EmbeddingDrain also refuses while a revision is pending, including startup replay
of prepared vector publication; it cannot bypass the audit through an older queue.

Limits: 8 MiB private receipt, 1 MiB new record, 64 MiB / 50,000 rows per journal,
1,024 UTF-16 units per source ID. No external provider or new dependency is needed.
Publication spans files and is not atomically visible to readers; no cross-store
transaction, OS power-loss test or Windows execution is claimed. Explicit recovery and native component Open-recovery are implemented (RE-D72);
ProcessEngine/Core activation and A1 confirmation/nonce composition remain separate
RX gates. Actual Node store/curation/audit primitives
from #274 produce the 24 twice-recorded `neo-revisions.json` scenarios; these
fixtures do not claim to execute the entire Node command runner.


### Original-caller C4 Open-recovery (RX6 / RE-D72)

`RevisionStore::open` calls `recover_pending` before returning the human-operation
component. The inventory is read only and checks every active original caller,
current policy, physical root/workspace proof, canonical location, actual source
and planned append prefixes before the first replay. Saved owner/agent strings do
not invent a Principal: the exact serialized caller must still be proved by the
current HostServices. Completed receipts need no recovery grant. The inventory
bounds directory entries at 50,000, active callers at 512 and actual
receipt bytes read in a pass, including JSON whitespace at 64 MiB; each receipt retains its 8 MiB limit. A
300-second recovery deadline does not rewrite original operation times. Corrupt,
wrongly placed, linked, physically rebound or currently revoked plans refuse.

Each resumed operation revalidates the original caller under its workspace locks,
so a later caller, a later chat or a changed policy cannot lend authority. Source
and audit/queue publication remain the same frozen RE-D71 operation. Five real
SIGKILL boundaries now reopen the component without a new request or explicitly
supplying the pending caller; two distinct workspace/owner/agent plans are also
recovered in one pass. This is not a global atomic transaction across workspaces.

Human revision/correction writers and automatic capture/episode/vector writers
hold the same kernel/Node Neo leases but have different recovery authority. The
operation writer refuses active automatic plans instead of replaying capture with
a human-operation policy. Automatic writers refuse a pending human revision and
cannot append behind its prepared publication. The appropriate original component
must settle the outstanding work first. Invalid mixed pending states require
explicit repair; neither policy is silently reused for the other operation type.
No new wire/brief interface is introduced. Runtime composition must still construct
the appropriate policy adapters and order component startup; ProcessEngine/Core
activation and A1 confirmation remain outstanding RX work.


### Authorized episode participant names (RX6 / RE-D73)

EpisodeStore now resolves descriptive participant names from the actual authorized
workspace's closed `USER.md` and `IDENTITY.md` paths. Original current policy is
checked before and after the read. Missing files retain the Node defaults; links,
hardlinks, changed physical identity and other I/O failures refuse publication.
Names never supply owner, workspace, agent or scope authority. Completed session
watermarks skip the read; prepared recovery retains the frozen participant names.

The exact case-sensitive Name marker, markdown removal, JavaScript whitespace,
first 4,000 UTF-16 units and 60-unit name limit follow the pinned Node function.
Each file read is capped at 16 KiB, enough to cover the entire relevant prefix,
including malformed UTF-8 replacement and a complete final code point. There is
no mtime-only cache: an in-place edit with preserved mtime is visible on the next
new episode. F3/RE-D17 drops a split trailing high surrogate; if this leaves no
name at the 4,000-unit input boundary, the normal role fallback is used.

`capture/golden/neo-names.json` contains 24 actual Node observations from verified
b097045b6f115275baa8b15016321c3ba080c812 sources, each recorded twice. A second
complete recording is byte-identical. The three native expectations in
`capture/neo-names-exceptions.json` bind to golden SHA-256
`ddbfe6f695f846b486f70a1c181e2d6c0b32b661536c796580d42225a0de37cc`:
two safe display cuts and the deliberately uncached same-mtime edit. The original
Node bytes, including isolated UTF-16 units and stale cache result, remain intact.

This is ordinary episode participant composition. Narrative-model enrichment,
vault publication and final ProcessEngine composition remain separate work.


### Offline-verified narrative enrichment primitive (RX6 / RE-D74)

The request-local `neo::narrative::enrich` preserves C4's newest-turn prompt budget
(600 UTF-16 units per turn, 6,000 for selected lines), exact German prompt,
500-token/temperature-zero call, tolerant fenced/prefixed JSON parsing and closed
narrative-arc set. Topic and mentioned-person cleanup, speaker exclusion, emotion
coercion, neutral cap and preservation of original source fields follow actual
Node. An LLM result cannot change episode ID, owner, scope, source IDs or opaque
source metadata. Provider errors return the original episode; cancellation propagates.

Fifty-nine actual pinned Node cases run twice, with a separate complete rerun
byte-identical. New `capture/golden/neo-narrative.json` has SHA-256
`840a2da4beac886c926254d3f1be34ca0fa12aab703f6064bbec6d9925ba4d93`.
`capture/neo-narrative-exceptions.json` retains four explicit native differences:
F3 safe display/prompt-budget cuts, refusal of malformed original UTF-16 at the
frozen UTF-8 LlmPort, and fallback for malformed model display text. Node originals
remain unchanged, including isolated UTF-16 units. Removing a half-pair from a
prompt cut does not reclaim budget or select another older turn.

Native resource bounds are 512 turns, 50,000 JSON nodes, depth 128, 1,048,576 input
UTF-16 units, 4,096 bytes per resolved role label, 65,536 final prompt UTF-16 units
and 64 KiB of response. Excessive source/prompt input refuses before provider
calls; malformed/oversized responses preserve the original episode. The shared
existing topic cleaner remains covered by the unchanged episode fixtures. No new
model, dependency, background job or consumed interface is introduced.

This primitive accepts already-authorized snapshots and an existing host-bound
provider. EpisodeStore and the actual capture hook now compose it as described
below (RE-D75); provider routing and ProcessEngine activation remain host work.
The primitive itself grants no source authority.


### Durable narrative capture composition (RX6 / RE-D75)

`EpisodeStore::with_narrative` and `NativeNeoCaptureHook::open_with_narrative` take
an existing composition-authorized LlmPort. Default construction remains
provider-free. The real CaptureRuntime/CapturePipeline path first writes primary
Lance rows, then enriches eligible ordinary episodes inline. Existing deferred
fallback diagnostics remain; no detached job, credential or model is constructed.
Disabled Neo, background captures, incognito and single-turn groups make no calls.

Every model group is selected from actual source IDs under the existing writer
and session leases. Original current policy and exact latest source revisions
are checked immediately before and after inference. Foreign/tombstoned/changed
sources refuse; provider-time revocation cannot publish its output. A continued
episode uses the original checkpoint's 600-unit snapshots after comparison with
the full authorized source. Only a proven cut-induced final half-pair is removed
at the external model boundary; the saved snapshot stays unchanged. Vividness
is recomputed from the enriched episode, matching Node's ordering.

The complete enriched episode enters the existing original-caller pending plan
before any episode append; source/predecessor preflight, durable append and
checkpoint-last publication remain unchanged. Prepared component-open recovery
needs neither a new provider nor new name-file reads. Concurrent duplicate
captures serialize and the completed watermark prevents repeated calls.

The inference itself is not exactly-once: interruption before durable preparation
may repeat a provider call. Recovery after preparation uses the frozen result.
Host-specific provider routing/authorization and ProcessEngine activation remain
open; this supplies the genuine capture hook path, not final RX activation.


## Actual-source conflict ledger (RX6 / RE-D76)

`ops::conflicts::ConflictLedger` binds an existing MemoryReader and CaptureJournal.
Its foreground record operation revalidates both actual committed Lance records,
including shared metadata, current owner/workspace, lifecycle and original caller
policy under the shared Node/native operation writer. The new row must belong
privately to this agent; the other row must be currently visible through real
sharing. Both rows remain unchanged. The private derived observation includes
real source IDs and the Node conflict fields; text cuts keep complete Unicode.
A stable caller-scoped UUID accepts an identical retry and rejects a changed pair.

The authoritative `.adaptive-learning/conflict-log.jsonl` is replaced through
a private fsynced sibling and atomic rename. Complete old bytes are preserved.
Bounds are 64 MiB, 50,000 nonblank records and 1 MiB per new record. Malformed or
torn records, links/hardlinks, unsafe cache paths and exceeded bounds refuse;
no automatic truncation or foreign-source cleanup occurs. Unix directory rights
are restricted through the held directory handle; new files use mode 0600.
Windows retains verified directory DACLs and has no directory-fsync claim.

A per-caller `native-conflict-review-summary-<scope hash>.json` is derived after
the primary commit. Failure at that stage may return an error with a durable
primary row; retry repairs the cache without duplicating it. Summary reads
recompute from the bounded authoritative log, filtering owner/agent/workspace
before counts and bytes; a forged or stale cache supplies no result. Summary
reads participate in the writer/pending fence and can create its lock metadata.
Legacy Node's global summary remains untouched. No cross-file transaction is
claimed; cost is O(log bytes) per operation plus repeated source validation.

Sixteen twice-recorded actual Node cases preserve row fields and document the
legacy summary behavior. Seven SHA-bound native expectations cover unordered
timestamp extrema, UTF-8 byte counts, epoch zero, malformed/torn refusal and
complete counting beyond Node's 1,000-line bootstrap. Existing goldens remain
unchanged. This is post-store observation: pending candidates, normal-store path
and merge-hook composition, confirmed resolution and ProcessEngine activation
remain open. Automatic resolver jobs stay in RE-06, outside RX's native primitive.


## Frozen interference plans (RX6 / RE-D77)

`capture::interference` separates the actual Node search shape from immutable
strength patches. Its pure planner preserves candidate order, self/core
exclusions, one captured clock, exponential decay, multiplier and 0.01 floor.
Each planned patch carries the exact pre-change candidate snapshot for later
revision checks. It neither reads nor writes stores and conveys no authority.

Native bounds are 64 affected rows, 65 candidates and 32,768 finite vector
components. Source and the aggregate candidate set each have a 50,000-node,
depth-128 and 1,048,576-unit input budget. Duplicate target IDs, invalid options
and empty vectors refuse. Twenty-four twice-recorded actual Node cases include
six SHA-bound native refusals and preserve Node's partial-error evidence: a
second update can fail after the first succeeded, while Node reports affected=0.
No rollback or durable replay is inferred from a successfully computed plan.
Actual authorized search, original-caller receipts, revision-checked application
and normal-store path composition remain separate unfinished work.


## Durable private interference (RX6 / RE-D78)

`ops::interference::NativeInterference` applies the frozen plan to actual Lance
rows. Foreground entry uses the shared OperationContext lifecycle/mutation gate,
original caller policy, physical workspace/base handles and native/Node Neo
writer leases. The actual committed source and every target must have explicit
matching private owner/agent/workspace fields and pass current lifecycle and
tombstone checks. Shared, foreign and core rows are never weakened. Search keeps
the Node limit/threshold and 1/(1+distance) conversion, with private predicates
before acquisition and actual row validation after it. No provider is invoked.

Before any patch, a private atomic receipt freezes original Principal/AgentContext,
physical ownership proof, operation UUID/options, source, and exact declared
before/after row plus sharing metadata. Only strength and dynamics timestamp
may differ; receipt validation recomputes every planned effect. Every retry
requires the same original caller and request. A pending target must equal its
before or after snapshot, so an already-written patch is skipped. A completed
receipt refuses a reset or later changed target instead of weakening it again.
Errors can follow partial durable writes; no cross-row transaction or rollback
is claimed. Reusing the original operation UUID is required.

`open` inventories saved original callers and preflights all pending requests
before applying the first. It then rechecks each request under its writer lease,
without host resubmission or a newly invented principal. Frozen timestamps survive
clock advancement. Inventory is bounded to 512 receipts, 8 MiB each, 64 MiB total,
50,000 entries per scan and a 300-second startup deadline; actual bytes are counted
on each scan, not just the initial inventory. Receipts are retained for idempotency;
reaching capacity refuses new work instead of deleting history. Corruption, unsafe
links, changed roots, revoked policy or changed sources prevent recovery.

A new interference operation cannot overtake a pending one. Automatic Neo writers
also refuse pending interference, while interference refuses automatic pending
work; the owning component must recover first. Three real SIGKILL boundaries
(prepared receipt, applied patch, completed receipt) reopen without duplicate
weakening. This is component recovery; ProcessEngine startup order, shared host
policy composition, receipt retention and the actual normal-store path hook remain
unfinished. Native foreground application replaces no Node background scheduling
until that explicit composition is complete.


## Actual-source resolution proposals (RX6 / RE-D79)

`ConflictLedger::propose_resolution` writes a recommendation for an already
durable owned conflict observation. Current source snapshots and original policy
are checked under the shared operation writer; the observation log is rechecked
before/after publication. Both Lance rows remain unchanged. The proposal keeps
Node's fields and adds private derived authority, source/decision fingerprints
and a stable proposal UUID. Four concurrent exact retries create one row; an
altered decision under the same UUID refuses.

`find_resolution` filters current owner/agent/workspace before reverse selection.
It requires the exact original observation still to exist and both source
snapshots still to match. Removed observations, changed/deleted sources or revoked
access refuse. A large foreign tail cannot displace an owned recommendation.
The strong-recommendation condition is recomputed; review-only entries are skipped.
Neither a recommendation nor the pure confirmation-shape helper grants apply
authority. Actual bound confirmation and safe reconsolidation remain separate.

Ten actual Node proposal shapes, eighteen selectors and five confirmation gates
are frozen through the recorder. Pure proposal JSONL is byte-exact; text selectors
retain original UTF-16 units. A SHA-bound native exception refuses confidence
outside [0,1]. The actual persistent writer uses the existing strict JSONL codec,
so isolated surrogate strings and malformed/torn records refuse without lossy
replacement or truncation. Bounds remain 64 MiB / 50,000 records / 1 MiB per new
record. No automatic model call, resolver schedule or source mutation is added.
The normal-store hook, confirmed application and ProcessEngine composition remain
open.

## Concrete conflict-application review plans (RX6 / RE-D80)

`ConflictLedger::prepare_application` selects and validates the exact current
proposal supplied by its caller under the existing lifecycle, mutation and
workspace writer leases. It freezes the existing-ID target, selected text,
replacement vector, active embedding identity, original principal and agent
context, timestamp and complete safeUpdate successor. A domain-separated
`conflict-apply` payload fingerprint binds all of these fields and both complete
source snapshots. The concrete review exposes the target, before/after text,
successor ID, provenance and semantic drift without an embedding vector.

The target must be an actual private source owned by the current agent in the
current user/workspace; read access to a foreign shared source does not grant
write access. SafeUpdate's existing authorization and drift calculation are
reused, with no drift override. The declared vector space must match both the
active provider and actual store. Nonfinite/wrong-dimension vectors, drift above
0.45, changed/withdrawn proposals, changed sources and successor-ID collisions
refuse. Text is limited to 1 MiB, vectors to 32,768 components and the complete
plan to 8 MiB. Mutation provenance accepts a string reason or the pinned empty
fallback; non-string reasons remain valid proposal data but refuse preparation.

`validate_application` rechecks the exact original principal (including chat and
account), agent context, fingerprint, current policy, model, proposal and actual
source snapshots. The plan has no public constructor or Deserialize path.
Neither preparation nor validation writes a memory, calls a model, persists an
approval or grants mutation authority. Preparation returns an in-memory review plan; RE-D81 below persists that exact
plan only after explicit verification and implements its primary-commit recovery.
The existing frozen selectors and safeUpdate row builder are reused unchanged;
no golden, dependency, RPC or HostServices contract change is introduced.

## Confirmed conflict primary commit and restart (RX6 / RE-D81)

`apply_application` requires a trusted native `ConfirmationVerifier` and an
explicit proof for the exact `conflict-apply` operation/fingerprint/original
principal and agent context. There is no default approval, RPC capability or
production proof adapter in this component. The host adapter must validate the
proof, purpose, binding and expiry, and make an identical grant retry idempotent
if receipt publication failed. It runs locally and bounded under the writer
leases. Neither a recommendation nor a fingerprint is a permission.

Before writing Lance, the component atomically saves the exact reviewed plan and
original physical workspace proof in a private `native-conflict-application-*.json`
receipt. The approval proof is never persisted. A fresh operation requires the
unchanged source and an absent successor; a missing receipt cannot be guessed
from a matching already-applied version chain. A confirmed operation stores the
frozen successor first, then supersedes its source, checks both complete rows
and finally completes the receipt. The other observed memory remains unchanged.
Every check retains current caller/policy/model/physical roots, source visibility,
tombstones and exact proposal/observation references. Changed or deleted targets
and successors refuse; an exact retry never recreates or overwrites them.

The safeUpdate successor is projected through the actual Arrow row codec before
fingerprinting. Lance Float64 columns therefore compare exactly with the frozen
expected row, including integral timestamps and reset counters. This does not
introduce a floating tolerance or change the frozen safeUpdate row builder.

`ConflictLedger::open` inventories all pending original callers and preflights all
plans before applying any. It reconstructs the successor from the frozen sources,
proposal, vector and time, verifies the complete result/fingerprint, and checks
current original authority. No model, new confirmation or new startup principal
is used. Four real SIGKILL cuts cover confirmed-plan publication, successor
commit, source supersede and completion. A fresh component retains the original
successor and timestamp. Automatic Neo writers and the other operation-writer
users wait for pending applications; the owning adapter also fences pending
interference, C4 and automatic work.

Limits are 512 retained receipts, 8 MiB per receipt, 64 MiB actual aggregate bytes,
50,000 entries per directory scan and a 300-second startup deadline. Capacity,
corruption, unsafe links and current authority changes refuse; history is not
silently pruned. A failure may follow a partial durable write, and recovery
requires the original receipt. This is not a cross-Lance/JSONL transaction or a
rollback/external-writer atomicity guarantee. Runtime composition must share its
operation lifecycle/generation ownership. The result acknowledges the primary
version chain only: optional Neo graph/reconsolidation effects, a real host
confirmation adapter, normal-store composition and ProcessEngine startup remain
open. No new golden, dependency or protected interface is introduced.

## Normal-store merge identity and source provenance (RX6 / RE-D82)

`capture::durable_merge` provides the exact ordered write-key JSON, source lineage
and epistemic metadata used by the pinned normal-store merge. Validity markers
are positive JavaScript-safe integers or zero. Text and JSON serialization retain
UTF-16 units, including isolated surrogates in the pure protocol. The replacement
ID uses Node's SHA-256 preimage and fixed UUID nibble layout; it is not produced
by an unrelated namespace-UUID algorithm. Merging new, unestablished text with a
trusted source does not inherit that trust: the merged status is `untrusted`,
except `disputed` and `invalidated` remain so, and previous status is retained.

The new recorder verifies 396 pinned sources and records 20 write keys,
17 lineages, 13 epistemic projections and 22 replacement identities. Thirteen
actual Node `withDurableMerge` executions additionally record archive/store/delete
order, stale-source checks, preparation refusal, failed store/delete/verification
and exact/colliding preexisting replacements. These execution recordings use an
offline map database port and actual temporary archive/audit files; they do not
claim real Lance integration or an implemented Rust merge writer. Both complete
recordings and an independent full rerun are byte-identical. Only the temporary
archive root is normalized. The recorder asserts its actual host archive path
before executing and checks success cases reached deletion and audit.

The Rust tests currently cover the pure byte-exact protocol and identifiers.
Inputs use the existing bounds of 50,000 JSON nodes, depth 128 and 1,048,576 units;
the serialized key is also limited to 1,048,576 UTF-16 units. Native identity
inputs require a safe agent and canonical 36-character UUID. Cancellation fails
without producing an identity. These helpers grant no read/write authorization.
Actual normal-store selection/model composition, durable archive/replacement/delete
and post-store hooks remain separate work. No frozen MemoryOps method or RPC is
added. The hygiene exception is limited to the two new fixture files' exact
verified test-host import and source-provenance lines; production rules remain.

### RX6 archived normal-store merge commits (RE-D83)

`ops::durable_merge::NativeMerge` consumes an already prepared native replacement;
model selection, lexical decisions and ordinary-store row construction remain above
this adapter. It creates no MemoryOps or RPC method. The exact source and replacement
must be private to the original caller, active, visible under current tombstones and
policy, and use the current provider/store identity. Replacement identity, lineage
and epistemic metadata must match RE-D82. The actual Arrow codec projects the saved
replacement before full-row comparison. The writer freezes the entire caller,
source, replacement, time and physical store/state/workspace bindings in a private
receipt before any archive or Lance mutation.

Durable stages are preparation, original archive, verified replacement, delete
intent, original deletion, audit and completion. Archive uses the complete original
known row. An exact existing replacement is accepted, while any collision refuses.
The original is deleted only after an exact readback of both rows and a persisted
delete intent. An absent original can be resumed only after that intent; missing
receipts never recreate authority. Archive/audit collisions, changed or deleted
completed rows and missing completed evidence refuse without repair. The mandatory
Node-shaped destructive audit is deduplicated by the original merge key and checked
in full, preserving unrelated JSONL rows. Each JSONL replacement is individually
atomic; there is no transaction spanning Lance, archive, audit and receipts.

Component `open` inventories and validates all pending original callers before any
replay, then checks them again under the shared writer leases. It never constructs a
startup principal or re-runs a provider. Pending merges fence automatic capture and
other operations; merge itself refuses pending automatic, revision, interference
or confirmed conflict work. Actual tests include concurrent retries, eleven injected
cuts, seven SIGKILL cuts, clock-advanced component reopen, revoked policy, changed
sources and filesystem collisions. These are real Lance tests; the earlier thirteen
Node map-port recordings remain reference evidence, not thirteen claimed Rust
workflow parity tests.

Bounds: 512 retained receipts, 8 MiB per receipt/serialized input row/archive,
64 MiB aggregate receipts, 50,000 directory entries per scan, 300-second startup,
1 MiB source/replacement text, 32,768 vector components. Audit has the existing
64 MiB/50,000-record bounds. Capacity refuses rather than deleting idempotency
history. This costs repeated full-row and bounded-file checks. The runtime must
share lifecycle/generation ownership and writer services; external uncoordinated
writers are not made atomic. Full normal-store composition, post-store effects,
retention policy and ProcessEngine activation remain open.

### RX6 normal-store merge decision (RE-D84)

`capture::merge_decision` calls the existing host LLM port with the actual pinned
single-user prompt, 2,000 UTF-16 units per fragment and a 300-token budget. It leaves
temperature absent and uses only the caller's selected optional model. The fixed
purpose is `merge-decision`; the frozen LlmParams has no purpose field, so it remains
the adapter stage. The Node host route likewise does not forward jsonMode. No direct
provider fallback, credentials or new result cache is introduced.

The route passes a cancellation deadline of at most 30 seconds to the host and
checks cancellation after return; host cooperation is still required to interrupt
a synchronous provider. Missing route returns no decision; provider failure remains
an error for the store caller's explicit no-merge handling. JSON syntax/type refusal
returns no decision. The required fields are boolean merge/string reason; true
requires a string mergedText, even if empty. Later lexical/length/validity guards
remain separate. Unknown fields survive. JSON duplicate keys follow last-value,
first-insertion-position semantics, integer property keys sort first, and numeric
spelling follows ECMAScript. Persistent receipt validators remain stricter.

The actual Node recorder verifies fifteen source files and records 35 host-route
requests/results twice, with an independent byte-equal complete rerun. Rust checks
all raw prompt bytes and results. Two separate SHA-bound F3/RE-D17 expectations omit
unpaired units from outward host strings only; pure Node prompts and the generated
golden remain unchanged. Responses are capped at 1 MiB before parsing; JSON uses
50,000-node/depth128/1,048,576-unit limits and bounded normalization. No source read
or write authority is granted by this primitive. Normal-store candidate selection,
row construction, original-caller provider preflight and post-store effects remain
composition work.


### RX6 canonical private normal-store merge preparation (RE-D85)

`capture::normal_store` assesses immutable private input before provider work and
builds the ordered merged row from an explicit decision/vector/source. Twenty-seven
actual pinned `storeMemoryFromToolParams` executions are recorded twice using offline
DB/model/embedding ports and real temporary archive/audit files; an independent
rerecord is byte-identical. The recorder verifies 396 source files and asserts the
resolved archive stays under its temporary root. Golden SHA-256:
`310e35ded7324daf22ce70cd0e986edf8ac756c83a1da7d1715e35ba173b621f`.

Comparison covers actual category/importance assessment, write keys, deterministic
replacement IDs, TTL, validity union/disjointness, summary/dynamics, epistemic fields,
provenance and refusal gates. Raw prepared row fields preserve Node ordering and
UTF-16 cuts. Separate SHA-bound exceptions retain the D130 original owner/workspace
(the Node private path writes empty fields), their consequent key/ID, existing C7
explicit core-importance/finite-TTL refusal and F3 outward complete-character cuts.
The raw key never reconstructs from the outward-projected provenance. Provider text
must already be valid Unicode. Schema defaults fill only at the typed store boundary;
provider vector numbers then become Float32 and must remain finite. The oracle uses
an offline DB port, not a Node Lance vector round-trip.

This component accepts already canonical safe-integer millisecond validity values,
private scope only and explicit caller-bound ownership. It does not authorize a
source snapshot or call a provider. Resource bounds include 1 MiB source/provider
text, 32,768 vector components and the shared bounded JSON limits. Native tests also
refuse foreign owner/workspace, inactive sources, invalid validity, malformed Unicode,
empty/nonfinite/oversized vectors and Float32 overflow. Narrow hygiene exceptions
permit only the recorder and its generated provenance manifest to name pinned host
modules; application code does not import them.

Actual source authorization and revalidation around provider calls, candidate
selection, ordinary-store fallback, post-store effects and ProcessEngine composition
remain open. No protected contract, dependency or existing golden changed.


### RX6 authorized normal-store host merge composition (RE-D86)

`NativeMerge::merge_normal` joins canonical private assessment, the actual host LLM
port, the reader's actual embedding provider and the durable RE-D83 Lance writer for
an already selected source ID. It derives ownership from the admitted principal and
agent; no ownership field from the input supplies authority. Before either provider,
and after both successes and failures, short shared writer leases reread the entire
source and current ACL/tombstone/policy, config and physical store/workspace/state
bindings. No writer lease spans inference. Pending automatic, interference, conflict
application or merge work fences admission. A final callback keeps config/physical
checks active through durable publication; RE-D83 owns source CAS after deletion
becomes legitimate.

The host route honors enabled/explicit autoApply, feature model, agent feature and
agent-default overrides, then global default. Missing host route or unavailable,
failed or malformed completion yields no merge; denied authority and cancellation
remain errors. Direct transport and thinking controls unsupported by frozen
LlmParams refuse instead of silently using the host route. The cooperative decision
budget is at most 30 seconds and can be shortened by configured timeout. Lexical,
length, fact-preservation and disjoint-validity checks precede the next disclosure
to the embedding provider. Exactly one finite vector in the actual store/provider
dimension is required. Initial assessment fixes TTL; final preparation time fixes
creation/provenance and the durable intent. No invented placeholder embedding is
used to reach the preparation gates.

Real Lance tests cover success, configuration/provider gates and model precedence,
current source/policy/config changes during either provider, cancellation, physical
workspace/state/store replacement, foreign/missing/inactive sources and committed
tombstones. Interrupted publication recovers the original vector and time without
another provider call. If its replacement has since expired, current visibility
refuses recovery before deleting the original; pending intent remains for explicit
repair rather than extending TTL or resurrecting data. Existing SIGKILL tests cover
the shared durable writer; this new composition adds deterministic interruption.

The raw provider/config snapshot is not persisted. Once the RE-D83 intent is durable,
recovery uses that exact original plan under current original-caller policy and
physical/model authority, without inference or a new configuration decision. Full
Core config-generation admission/draining remains a separate integration gate.
Candidate retrieval, score/duplicate selection, ordinary-store fallback and its
request admission, curation/knowledge-pending/interference effects, shared scopes,
raw date parsing and ProcessEngine activation remain unfinished. This internal
selected-candidate method is not an advertised engine RPC or complete store facade.
No new golden, dependency, TS change or protected-contract edit.


### RX6 normal-store candidate policy reference (RE-D87)

Twenty-four actual pinned candidate selections record `MemoryDB.findSimilar`,
`findMergeCandidate`, `vectorSearchActive` and the engine's safe-duplicate validity
selector over an offline preordered query port. Fixed SQL/query limits and actual
results are retained; this does not claim real Node Lance distance execution. The
recorder verifies pinned sources, asserts temporary host paths, records twice and
passes an independent byte-identical rerecord. Golden SHA-256:
`45a86a8f41786b723707a92ef6d7d63e8d2c143162cadaf5b2bd79f23af66e45`.

Pure `capture::normal_candidates::select` consumes already authorized active nearest
rows. It preserves the first-ten duplicate acquisition, exact text alternative,
inclusive duplicate threshold, first-five merge band with exclusive upper bound,
stable tie order and exact lexical/equivalent-normalized-validity duplicate gate.
Merge projections retain the actual Node fields/defaults; duplicate entries remain
raw. Legacy invalid/unknown validity normalizes to zero here, while normal-store
front-door canonical input validation remains separate. Native query evidence must
have finite nonnegative numeric distances, valid active status and no invalidated
source; bounded JSON, 1,024 input rows and finite nonnegative thresholds refuse misuse.

Two SHA-bound D130 exceptions record how applying authority after Node's 10/5 caps
can hide a valid duplicate or merge behind foreign rows. Expected native output is
an actual rerun of the same Node selectors on their own authorized source set;
unfiltered Node observations are preserved. This pure component does not query
Lance or grant access. Actual private query filtering, bounded acquisition, current
authority/source revalidation and the selection-to-writer bridge remain separate.
No existing golden, dependency or protected contract changed.


### RX6 actual private candidate acquisition and immutable merge admission (RE-D88)

`NativeMerge::select_normal` now embeds one authorized input and queries the actual
private Lance store. Fixed predicates bind agent, storedBy, owner, workspace and
private scope before nearest-neighbor acquisition. Query projection contains only
ID/vector/distance; full text is not bulk-loaded. The window grows from ten by four
until ten eligible rows or exhaustion, capped at 50,000 and a dimension-dependent
64 MiB estimate for projected vectors/IDs. Exceeding the bound refuses instead of
silently missing an authorized candidate. Full records are read individually;
current vectors must match their query projection, and current source authority,
expiry, tombstones and physical bindings are checked under shared writer leases.
Selected full snapshots have an aggregate 64 MiB bound. RE-D87 then applies the
unchanged 10/5 semantic budgets to this authorized ordered set.

An opaque `NormalCandidatePlan` holds original principal/agent, params, input vector,
assessment time, raw config, current source, Neo proof and physical store/workspace/
state/registry anchors. It is not serializable or accepted as a wire credential.
`merge_selected` verifies the original caller and current policy, config, full source,
registry and physical bindings before invoking the RE-D86 host-model/embedding/writer
path. Later chats cannot borrow it; a different reader registry cannot substitute
missing tombstones. Initial TTL survives selection/model delay, while creation and
provenance retain final preparation time. Duplicate and forgotten outcomes do not
invoke a model; a committed input fingerprint blocks before input embedding.

Actual Lance tests include one-input-vector duplicate refusal, input-plus-merged
vector success, 100 nearer foreign-agent/owner rows, 14 nearer committed tombstones,
input-policy/config drift, changed source/caller/config/policy after selection and
attempted registry substitution. Source text in the merge fixture differs from the
incoming text: actual Node treats exact text as a duplicate even below threshold.
A direct pinned MemoryDB probe also confirms that independent thresholds remain
legal when merge > duplicate: the merge band is empty but duplicates still work.
The unnecessary ordered-threshold restriction in the pure selector was removed;
existing goldens remain unchanged, with a dedicated regression test.

This composes actual private selection through durable merge. `Separate` still
requires the ordinary-store writer and its admission/recovery; no storage success is
reported for it. Curation/knowledge/interference post-effects, shared scopes/raw date
parsing and ProcessEngine/Core generation lifecycle remain separate. Query/window
and byte limits bound inputs and projected data, not a promise of a hard process RSS
limit or atomicity with uncoordinated external Lance writers. No new golden,
dependency, TS source or protected-interface changes.


### RX6 ordinary new-row preparation (RE-D89)

`AssessedStore::ordinary` prepares an unattributed private new card from the actual
input vector, an explicit original operation UUID and a frozen preparation time.
The original assessment fixes TTL; neither UUID nor time is regenerated by the row
builder. `PreparedStoreRow` holds the common ordered row/key projection and typed
schema-default/F3/Float32 boundary (`PreparedMerge` remains a compatibility alias).
Empty/oversized/nonfinite vectors, nil operation ID, invalid safe-integer clocks,
invalid encoding bounds and cancellation refuse. Preparation confers no storage or
recovery authority.

Thirty actual pinned `storeMemoryFromToolParams` executions with autoApply disabled
cover all categories, all origins, TTL, importance, validity, provenance, summaries,
dynamics and injected input. Offline DB/model/embedding ports, verified temporary
host path isolation, 396 pinned source hashes, twice plus independent byte-identical
rerecord. No model is called and exactly one actual hash embedding is used per case.
Golden SHA-256:
`e3420069cb1c0294b56292943b14ff3515cf372e5d4f828e108d46bc70cc2185`.

Separate SHA-bound exceptions retain the original D130 owner/workspace, the native
operation UUID in place of normalized actual Node random UUID, existing C7 explicit
core/finite-TTL refusal and F3 outward provenance cuts. The raw write key remains
Node-compatible with its owner binding and raw UTF-16 cuts. New rows carry no invented
source turn/role; they remain untrusted. Schema filling does not claim Node Lance
Float32 byte parity. A dedicated test separates initial TTL from later creation and
provenance time. No existing golden/dependency/protected contract changed.

This closes row preparation only. Actual ordinary-store durable admission/write/open
recovery, curation/knowledge-pending/interference effects and ProcessEngine/Core
lifecycle integration are still open; no `Separate` selection is reported stored.

## Original-caller Unimport graph cleanup (RX3 / RE-D129)

`NativeMemory` attaches canonical Neo graph cleanup to the same `Unimporter`,
private routes and operation generation. Admission captures the original
Principal/AgentContext, physical workspace/base and host configuration before
archive callbacks. The optional import request binding never becomes the cleanup
caller. No frozen trait or RPC changes are needed.

After card rollback and durable receipts, cleanup reopens the actual deleted,
invalidated private rows. Every removed graph revision needs explicit original
user/agent/workspace ownership; both endpoints must resolve to private rows of
that caller. An edge's visibility never grants access to its peer. Row fingerprints
are retained and rechecked before publication. User-shared/ownerless/ambiguous
rows and edges do not gain a destructive grant from their IDs.

The cleanup holds the existing kernel and interoperable Neo writer leases plus
pending-plan guards. It shrinks a journal without append-cap housekeeping: unknown
retained bytes must not be parsed as new append input. Only complete, unambiguous
JSON object lines with string endpoint IDs can be removed; malformed bytes, blank
lines, incomplete tails and duplicate-key objects remain byte-identical. Each
removed historical revision counts, matching the Node operation. Canonical graph
only is modified, as in Node; legacy aliases remain outside this cleanup.

Source reads retain an ordinary-file descriptor, identity, mtime and SHA. A private
synced staging file replaces the live graph only after checking the exact source
bytes/identity, original caller, configuration, policy, import lease and card
fingerprints again. Reads are bounded to 64 MiB and 50,000 physical lines. Only row
fingerprints, not all peer vectors, are retained in the cleanup evidence map.
Existing staging limits and directory pins apply. This is not an atomic CAS
against an uncoordinated external writer after the final check.

Card rollback is already committed when derived cleanup starts. A cleanup failure
increments `cleanupErrors`; rerunning the same rollback retries its already-deleted
cards. Blocked matching edges remain intact and contribute one graph cleanup
error. Mirror callbacks stay separate: the old Node vault confirmation binds
agent/workspace/vault but has no user principal, so it is not promoted to new
native user authority (controller question F14). No vault move, approval migration
or deferred RE-07 import task is activated here.

Reference: `tests/fixtures/ops/golden/unimport-graph.json`, six actual calls into
`createNeoStore().removeGraphEdgesTouching()` at pinned `9f34008c`, recorded twice
and independently repeated after verifying the full engine/lib source tree.
`unimport-graph-native-exceptions.json` binds SHA
`3e060b36afc57d06ac983f47dc970acd5936a4ba650374a1e7a155ad2a4e9afb`
to stricter authority, source fencing and byte-preservation behavior. Original
Node results—including ownerless deletion, numeric coercion and whitespace/tail
normalization—remain unchanged. Three vectors compare native counts/replay with
explicit native ownership stamping; separate real-Lance tests exercise owner,
policy, root, source, cancellation and lease failures.

Known native composition boundary: frozen import semantics store default
agent-private cards without user/workspace bindings. Their rollback can complete,
but this graph cleanup reports a failure and retains edges: even a correctly
stamped edge cannot supply missing card ownership. The facade test exercises this
refusal through the actual import/link/unimport path. This increment does not
silently change the pinned import-row format or claim those legacy cards have
full graph-cleanup coverage.

### Serialized graph endpoint claims (RX3 / RE-D130)

An edge may carry the Node `sourceOwnership`, `targetOwnership`, nested `ownership`
and `ownershipStatus` fields in addition to native outer visibility. When any of
those claims exists, cleanup requires all four endpoint tuples to be unambiguous,
version 1, `agent-private`, and equal to the original caller's exact agent, user
and workspace. A partial/null/unbound tuple or `needsRebuild` cannot be repaired
from the outer record. Duplicate tuple keys are preserved without deletion.
Actual private source rows and their late fingerprints are still required.

An actual-Lance regression first demonstrated that an outer owned record with a
foreign serialized source owner was removed. The additional check now preserves
it. The reference `ops/golden/graph-ownership.json` records six actual pinned
`isBoundGraphEdge`/`filterGraphEdgesForRequest` results; SHA
`96291be8c36ec14158fb060940aa5bdefb695c1aea17625cfd4ab25f4ef246b9`.
The Node agent-private filter accepts a different owner when the agent matches;
`graph-ownership-native-exceptions.json` explicitly binds the stricter native
private cleanup refusal. Existing recall ACL semantics are not changed. The
integration test consumes all six recorded inputs, binding synthetic
endpoint IDs and the original caller/workspace placeholders to the actual fixture;
foreign owners remain foreign. The older rollback fixture uses a v1 user, while
the pinned Node principal helper records a v2 user. Neither golden is changed.


### Automatic capture without Jev (RX6 / RE-D131, D125)

Automatic chunking without an explicitly composed decision model keeps the
existing whole-plus-parts (`beides`) fallback. `CapturePipeline::new` no longer
resolves a Jev secret or constructs its built-in external HTTP decision transport.
Available credentials do not authorize sending conversation content for that
purpose. Explicit native `CaptureChunkDecider` composition remains available;
this change installs no replacement model or ProcessEngine capability.

The frozen config keys and historical pure request/answer codec vectors remain
unchanged. `capture/d125-no-jev-native-exceptions.json` binds the existing rows
and chunk-decider golden SHA values. An additional actual CaptureRuntime/Lance
execution uses automatic mode with the unchanged recorded `chunking-both`
expectation. All 21 scenario executions assert zero secret lookups and zero
egress attempts, including an available synthetic secret and the explicitly
composed local whole-decision fixture. This is an explicit native policy
variation, not a new Node observation. The constructor regression first failed
with one secret lookup; after removal, all 29 tests in `capture_pipeline` and
`capture_rows` pass. No live external decision request is part of verification.


### Bound Neo graph source for namespace recall (RX2/RX6 / RE-D132)

`BoundGraphSource` holds the original canonical request and a trusted existing Neo
root. A configured `Pipeline.bound_graph` replaces the explicit preauthorized
in-memory edge input. The graph stage reads it after model callbacks, just before
traversal; a failed source never falls back. Metadata uses the existing latest
revision / ACL-before-tail reader, then validates all serialized endpoint tuples.
Each endpoint must match a real, live row in that physical namespace table,
including the valid-time window. Private endpoints additionally require the
original user and workspace (D130), even where the old matching-agent ACL would
accept another user's actual row. No request or table reuses another's row cache.

The source reads at most 5,000 authorized latest records, examines at most 400
records and loads at most 200 distinct endpoints. Cancellation surrounds bounded
reads; duplicate JSON keys, unrepresentable strings, non-scalar graph fields and
invalid strengths do not become traversal input. Root identity is checked again
following row reads. Normal stage endpoint/hydration ACL and lifecycle checks
remain in place. These observations do not form an atomic Neo/Lance snapshot
against independent writers, and this increment does not activate ProcessEngine.

`ops/recall-graph-native-exceptions.json` binds the unchanged six-case Node
`graph-ownership.json` reference, SHA
`96291be8c36ec14158fb060940aa5bdefb695c1aea17625cfd4ab25f4ef246b9`.
Tests map only original fixture identities to actual rows, retaining mismatching
claims. A real red test demonstrated matching-agent foreign private access before
the additional user/workspace gate. Further actual-file/Lance tests cover row
rebinding, deletion, valid time, distinct tables, duplicate claims, later hidden
revisions, 400-record cap, cancellation and root replacement during provider work.
Historical unbound graph stage vectors remain unchanged.


### ProcessEngine static supplement (RX3/RX8 / RE-D133)

The actual engine facade caches the existing Node-parity system supplement at
construction, with `neo.enabled !== false` as in the pin. This pure response stays
stable across host config changes until a new engine is constructed and remains
readable after close. It neither opens a store nor warms a provider. The process
regression compares the complete serialized response to the unchanged Node
`recall/golden/render/system-supplement.json` for disabled, enabled and default
Neo configuration. Dynamic recall/capture readiness remains independent.


### Copied-store inspection through ProcessEngine (RX3/RX8 / RE-D134)

`ProcessEngine.stores()` now exposes the existing `StoreAdopter`, sharing the
engine's actual `EmbeddingService`, complete identity and host platform checks.
Construction remains lazy. An explicit inspection reads copied physical tables
and may invoke that service for bounded passage-vector comparison. Engine close
cancels its inspection token before closing the shared embedding service.
Both `dryRun` values preserve all source bytes and configuration; adopting or
activating a live pool is still the host's separate responsibility. This does not
advertise full recall/capture readiness or change a capability flag.

The actual-facade regression creates a real Lance store and compares matching
and orthogonal stored vectors using the explicitly selected flat embedding seam.
It verifies complete source-tree hashes, unchanged config, no engine state-root
creation and rejection after close. The existing complete Node/Lance adoption
matrix continues to exercise the underlying inspector without golden changes.


### Request-bound patterns in recall rendering (RX2/RX6 / RE-D135)

`BoundPatternSource` uses the existing physical Neo metadata reader with the
original canonical request. Latest revision and requester ACL precede the same
100-record limit used by the pinned assembler. A configured runtime source
replaces any prepared pattern snapshot after namespace selection and before
rendering. An ordinary source failure is an error, not an empty success or a
fallback to that snapshot. Disabled pattern surfacing and optional phases past
the budget do not read this source; cancellation keeps the existing degraded
recall response without injecting unverified patterns.

Graph and pattern sources share a strict projection that refuses duplicate JSON
keys and unrepresentable UTF-16 without rewriting persisted files. The original
Neo limits (50,000 scanned lines, 64 MiB windows) still apply. This is a bounded
metadata snapshot, not an atomic transaction with Lance or external writers.
Legacy explicit renderer inputs remain available when no source is composed;
ProcessEngine recall activation remains separate.

`recall/pattern-source-native-exceptions.json` binds unchanged references:
`capture/golden/neo-merged.json` at C4 `b097045b` (SHA
`33e8caabe57d1469ad04623b0fd3ddfc39251b6fb85e44763d8e6274bdd50e81`)
and `recall/golden/render/render-plain.json` at pin `9f34008c` (SHA
`a169d71712ac7c3f179b29ff23eba8ac3726e9e09bcef8bddc8b8964c52e2dff`).
Their existing suites check actual Node metadata/render behavior. New synthetic
integration tests use real Neo files, Lance selection and the full renderer;
they are not new Node observations. Coverage includes foreign-tail starvation,
latest hidden revision, original context, root replacement, duplicate keys,
100-record limit, same-user cross-agent visibility, cross-user refusal, source
failure, disabled reads and cancellation after namespace selection.

### Process-owned store opening (RE-D136)

`ProcessEngine.open` initializes the actual active namespace writer using the same
resolved embedding identity as its embedding service. Construction is lazy; the
first open requires the host-resolved `baseDbPath`. Contract agent IDs pass the
stricter physical-store segment validation before any directory is created.
The namespace pools retain their existing identity and physical-root checks.

`status.agents` counts distinct explicitly opened agents without filesystem work
or waiting for the pool mutex. As in the pinned Node implementation, closing an
agent handle removes that agent from the opened set; it does not delete a table.
Repeated close of that same handle cannot unregister a subsequent reopen. Engine
close serializes with opening, drops its cached pools, clears the count and refuses
new opens. Handles do not retain the pools after engine shutdown. The native
exception marker binds the original Node source SHA; tests use synthetic real
ProcessEngine/Lance stores, not newly recorded Node outcomes.

An open table grants no row authority and does not establish startup recovery,
capture draining, or readiness. Recall/capture/memory activation remains pending
its original-caller and recovery composition.

### Shared service adapters for native pipelines (RE-D137)

`Service::pipeline_embedder` and optional `Service::pipeline_reranker` expose native
provider ports over the same service instance. They retain its identity, batching,
cache, vector/hit validation, cancellation and close checks. No provider, model or
cache is rebuilt. Model selection and egress invalidation reach the original
providers. The adapters grant no data authority or new cache scope.

An absent reranker remains absent. A configured reranker's empty-result policy is
retained, and invalid hits are rejected by the service before the pipeline receives
them. Error projection uses existing content-free native error variants; it does
not reconstruct provider details already removed by the service contract. These
ports prepare composition without enabling unfinished memory/capture/recall routes.

### Active namespace tombstone lookup (RE-D138)

`NamespaceGenerationLookup` reads the existing active writer from already resolved
`NamespaceStores`. It never selects a legacy recall table or creates a missing
agent table. Only row reads are invoked on those runtime leases. The flat
`ActiveGenerationLookup` also checks its held pool root before and after agent
existence checks, so a replaced root cannot masquerade as a missing agent.

All twelve unchanged Node recovery vectors from the frozen S5 head
`1878af0b6b7eeaeba657f9d98f01a7bae5da26d8` run against real namespace tables with
conflicting legacy status. Complete reports/registry records match and all table
bytes remain unchanged. The native exception marker binds the source manifest
and golden SHA. This recovery source grants no snapshot-restore authority; process startup
composition is described below.

### Process startup tombstone gate (RE-D139)

The first successful `ProcessEngine.open` runs S5 reconciliation through the same
active namespace pools, using the host clock and engine shutdown token. Only then
may it initialize/register the requested agent. Construction remains lazy. Row or
registry errors refuse opening; a later open retries on the retained pinned pools.
This deliberately replaces S5's historical background warning-only startup path.
Pending attempts, missing rows and the existing grace interval retain their
recorded S5 behavior. No new row or restore authority is created.

Engine shutdown cancels reconciliation before waiting for the opening operation.
Tests compare actual ProcessEngine/Lance/registry output with the unchanged Node
records, reject corrupt registries without creating the agent, retry after repair,
and cancel during the startup clock callback before registry publication. The
source/golden SHA marker records this native admission policy. Capture-WAL/Neo
startup and complete readiness remain separate unfinished composition.

### Process memory reads (RE-D140)

`engine.memory.list`, `show`, and `state` use the existing native reader under
the original caller's operation context. They reuse the process namespace
pools and embedding service. The shared pools sit under the resolved namespace
base, including when the configured path ends in the writer namespace. Reads
lease existing tables and leave an absent namespace root absent. The startup
tombstone gate runs before the first existing table is admitted.

Process close drains admitted memory operations before releasing their pools.
An explicit Re-Embedding generation uses its validated layout.

### Selected Re-Embedding generation (RE-D141)

The process checks the selected manifest against the configured model fingerprint
and vector width before opening private or shared stores. It retains physical
pins for the namespace base, generations directory and selected directory.
The writer and shared pools stay inside the selected generation, including when
its name equals the writer namespace. Tombstone reconciliation keeps the original
configured registry path and reads the selected writer. A missing or mismatched
manifest prevents admission until the configuration and manifest agree.

### Process memory deletion (RE-D142)

`engine.memory.forget` uses the native `MemoryWriter` with the same operation context and namespace pools as the
read path. A private deletion archives the active writer's row and commits its tombstone before returning.
Retries retain the committed receipt. The registry masks older copies from the read view, and their physical
tables stay untouched. A shared row can be retracted only by its original sharing agent. Shared leases also
retain the outer generation directory pins through the actual store operation.

The process parity run uses deterministic receipt IDs with its explicitly authorized fixture clock. Other
runs allocate UUIDs normally. The pinned Node recording for list/show/forget matches the Rust process, including
the receipt, post-delete visibility and the remaining ordered cards.

### Process schema maintenance (RE-D143)

The existing `engine.admin.migrate` wire method calls the native `SchemaMigrator` with an F7 grant. For each
maintenance call, the authenticated socket's kernel peer PID must match the trusted Core PID record. The
record can appear after EngineClient bootstraps. The grant carries the current Core instance and connection
lifetime. The migrator appends the projected audit entry to `state/engine-maintenance.jsonl` before changing
the schema marker. Re-embedding calls still return their explicit composition error while their process
service is pending.

### Read-only warm recall in the process (RE-D148)

`engine.recall` with `warmOnly: true` checks the workspace policy and the persisted
generation switch barrier before model or store work. Private leases are read-only
and never create a table. Shared leases still use the caller's workspace and user
bindings. The warm path reads the native Neo prelude when available and uses the
active embedding service's memory cache for Lance searches. It returns no prompt
blocks and does not deliver events or run activity, retrieval or recovery writes.

An optional reranker only receives live rows that pass the caller ACL and the
deletion registry checks. A warm request masks an interrupted deletion until
normal startup can reconcile it. The isolated warm path has no query LLM.

The comparison covers warm results at the Node pin. Warming the canonical and
graph stages, retained embedding identities and shared scheduler priority are
still part of recall composition. See the SHA-bound warm process marker. The
foreground recall path and its readiness gate remain pending.

### Foreground recall in the process (RE-D150)

`engine.recall` without `warmOnly` runs the native recall runtime over the
process writer pools after the same admission, workspace policy and startup
tombstone gate as the memory readers. A disabled workspace answers an empty
result and announces nothing. Internal turns and prompts under five UTF-16
units answer an empty result. The prompt's emotion (tier 1/2) is committed to
the owner-bound mood store before the store read; a foreign or corrupt mood
file is neither used nor overwritten. Bound Neo graph and pattern sources are
read when present.

After admission, cancellation, unavailable capabilities and invalid input stay
typed errors. Every other failure, including store opening and a Neo source
that exists but cannot be opened, answers no blocks with the degradation
`{reason: "error", capability: "recall"}` and the usual `recall.degraded` and
`recall.completed` events. A1 counts only the rendered cards of a successful,
undegraded recall. The result carries no decision trace, as at the pin. The
status reports ready once capture, journal, jobs and the schema marker are
composed as well (RE-D154, RE-D157). Start
notices, session time, persona and other prompt additions, reminders, the
retrieval ledger and the Neo prelude are not composed yet.

### Query refinement (RE-D151)

At the pin, query refinement is on by default and deterministic
(`lib/query-refiner.js`, SHA-256
`136e4aa6b2408bffbe6a02791b118818abb5ae4e1c3a25d1565b27373453c389` at
`9f34008c`). When no vector hit reaches the minimum score, the native stages
remove stopwords, add up to three fixed synonyms, embed the refined text and
search the same table again. Lifecycle and the `refined-acl` check apply to the
second result. The two result sets merge by id (the higher score wins, first
position kept) and sort by score. The stage records a `query-refinement` guard.
Cancellation stops the stage as before; any other embedding or read failure
keeps the original hits, as the pin's `catch` does. The tables and 49 recorded
inputs are bound in `tests/fixtures/recall/query-refiner.json`; the
`recall/weak-hit-refined` parity scenario covers a hit that only the refined
query finds. This replaces the RE-04 assumption that refinement stays off.

Parity exception: the pin reads `SYNONYM_MAP[w.toLowerCase()]` from a plain
object literal, so a word whose lower case names an inherited `Object.prototype`
member (in practice only `constructor`) "expands" to that member's source text
(`function Object() { [native code] }`). The native port gives such a word no
synonym. `tests/fixtures/recall/query-refiner-native-exceptions.json` records
Node's output next to the native expectation for four inputs
(`record-query-refiner-exceptions.mjs`, same SHA-checked source).

### Recall locale (RE-D152)

Foreground recall resolves its language the way the pin's
`resolveCommandLocaleRecall` does for `Engine.recall`: `resolveLocale` over the
event's single user message (`lib/i18n.js` at `9f34008c`, SHA-256
`f9846591fc0bb8ec21b66c6ec178c1d9be4ef6619d8d7e6fb09ed9923e81e148`). Two or
more German function words among the last three user texts select `de`,
otherwise `en`. The time and reminder blocks use it. The detection is
deterministic and reads nothing; `tests/fixtures/recall/locale.json` binds the
word list and 44 recorded cases. SOUL.md tone is not composed.

### Tombstoned ids in recall (RE-D153)

The pin filters recall candidates only by lifecycle and ACL
(`lib/recall-pipeline.js` at `9f34008c`: vector search `:1701-1702`, refined
search `:1754-1761`, graph hydration `:1064-1065`, `:1102-1107`, `:1143-1148`)
and consults no tombstone registry. A card forgotten from the active writer can
therefore return through a retained legacy or cross-namespace copy, which the
native forget keeps on purpose (RE-D142). Native recall masks every row whose
owner's registry blocks its id. Foreground and warm recall use one predicate:
a committed deletion, or an attempt whose latest record is still `attempted`
(interrupted until S5 reconciles it). The mask runs after the ACL for vector
search in every namespace, the refined second search, graph endpoints and graph
hydration. Each owner's registry is resolved once per recall call, so every
source of that call sees one snapshot; right before rendering, the selected
rows are checked once more against a fresh resolution (one per owner, no
per-candidate I/O). A forget that commits after that second check yields an
answer linearized before the forget, as for list and show. A masked row appears
in the internal trace only as its id with the fixed reason `tombstoned`; it is
not rendered, counted by A1, counted in the prompt trace summary or announced.
An unreadable registry fails the recall, including on the refined second search
(whose read and embedding failures still keep the original hits), and the
process answers the degraded error result without data. Two intended
consequences: when the only hits at the minimum score are masked, refinement
runs where the pin would not; rows the pin reached only through the forgotten
card as a graph bridge are absent. Canonical knowledge sections have no memory
id and are not masked. Internal render and projection failures after admission
are store errors and answer the same degraded result, never a typed `invalid`.
See the SHA-bound marker
`tests/fixtures/recall/tombstone-recall-native-exceptions.json`.

### Capture in the process (RE-D154)

`engine.capture` runs the RE-05 `CaptureRuntime` over the native
`CapturePipeline`, `NativeCaptureClassifier` and, when Neo is enabled,
`NativeNeoCaptureHook`. The runtime is composed once, behind the same S5 startup
tombstone gate as the memory readers, and writes through the active writer
route's own `StorePool` (the same pins and fixed identity as a route lease), so
forget, import, rebind and capture share one writer handle per agent store. The
re-embedding switching gate is part of the capture policy, as for recall; an
unreadable migration state counts as switching.

Composition runs on the first `Engine.open` of an agent or the first capture,
outside the capture state lock; concurrent callers wait for it. It takes an
inventory of durable admissions (`_capture-admissions`) and prepared Neo plans
and recovers nothing itself; recovery runs behind it, one owner at a time, and
is joined by that owner's own next turn (RE-D162). A killed turn is completed
exactly once, also when it was killed after its first row, and a replay of that
turn by its owner waits for it. Recovery is bound to the engine's shutdown
signal and handles every owner's retained admissions and prepared Neo plans on
their own, each owner with its own budget (RE-D156, RE-D159). Only shutdown, the
admission directory or the Neo root itself can fail the composition. Work that
stays (maintenance, a transient failure, an exhausted budget) is retried before
that owner's own next turn, under its own budget; it delays another owner's turn
only within the bounds of the wait graph in RE-D162 and never aborts it
(RE-D163). While such work waits or is being recovered, or
an unattributable file is kept, capture is served and the status reports
`{reason: "capture-recovery-deferred", capability: "capture"}` without touching
`ready`. A failed composition reports `startup-recovery-incomplete` and a
configuration the composition rejects `composition-invalid`. `Engine.open`
itself does not fail on a capture recovery failure. The status reflects capture
only after the first open or capture.

Capture's classifier and recall share one owner-bound mood pool (RE-D51 binding
unchanged) and one bounded set of per-owner emotion engines (256 bindings,
least recently used evicted first), keyed by agent, owner, logical workspace and
canonical workspace directory. Capture only reads the mood; a second owner of
the same agent neither reads nor overwrites the first owner's mood file. With
the opt-in inline tier 3 the owner's engine stays locked through the bounded
completion call. Tier 3 uses the host's guarded completion port only when the
effective configuration enables it; deferred mode makes no call at capture. No
pressure sampler, narrative provider or post-turn job is composed
(`scheduled = false`, so `deferPostTurnLlm` reports the existing inline
fallback). The pin's chunk decider is the Jev HTTP model route
(`lib/jev-chunk-decider.js`), not deterministic; D125 keeps whole-plus-parts.
As at the pin, Neo state exists only when Neo is enabled; the root is created on
the first composition. With Neo switched off an existing root is only looked at
for the age bound of plans an earlier run left prepared (RE-D163).

The native Neo journal binds only user-owned callers with a logical workspace
key and a host workspace directory. For any other owner the composition skips
Neo's pre-store work and closes the post-store step with the terminal refusal
`neo-owner-not-applicable` (RE-D155). KNOWN-GAP for RY-A: the pin writes Neo for
every owner; whether such owners get an agent-private Neo is an open decision.
A host failure while resolving the workspace is transient for this check, never
"not applicable".

`close()` raises the shutdown signal and cancels store opening, refuses new
turns, waits for a running composition and drains admitted capture work, all
within the caller's budget (30 seconds when none is given, as the pin's
`closeEngine`; an explicit zero is honored, unlike the pin). A composition that
finishes after close never admits a turn and its retained input is recovered by
the next open. When capture work is still settling past the budget, `close()`
completes the rest and reports `not-available/capture-drain-incomplete`. The
status is described in RE-D157 and its priority in RE-D159.

### Terminal post-store refusals close the admission (RE-D155)

A capture admission stays on disk until its classifier and Neo post-store steps
are done, so a restart can finish them. Before this decision a step that failed
deterministically (for example `speaker-media-authority-unavailable`, F11: a
media ID without proven host provenance) kept its admission open forever; every
later recovery refused it and open entries counted against the 512 pending
admissions. `CapturePipeline` closes such a step, records its fixed reason (no
content) in the admission's `postSkipped` until the admission completes, logs the
content-free capture warning and lets the other steps run. The stored rows
remain. RE-D156 generalizes which failures are terminal.

### Isolated admissions, failure classes and bounded retries (RE-D156)

Every retained admission is assessed on its own. The admission inventory checks
only the structure of each file (version, file name, key, size, link safety); a
malformed file is kept untouched, reported in the status and never recovered.
Another record's policy, configuration or workspace never decides a new
admission (capacity and file layout: RE-D159). Recovery then checks each record
against the current state:

- Revoked workspace policy (the owner switched capture off): the record is
  closed terminally and its retained turn content is discarded; rows written
  before stay, as at the pin. The same happens when the policy is revoked
  mid-turn (`not_captured`).
- Maintenance (re-embedding switching): the record stays pending without
  affecting anyone and is completed before the owner's next turn after the
  maintenance ends, or by the next open. The policy,
  including maintenance, is checked again before every row write, because each
  write saves the admission first.
- Another capture-semantic configuration (the projection in RE-D162) or vector
  space: closed (`config-changed`); the library cannot prove the remaining steps
  idempotent under a new configuration. Another workspace or root identity: closed
  (`workspace-identity-changed`), never written into another workspace. Another
  caller resolution: closed (`caller-changed`).

Failures are terminal unless they are on an explicit transient list
(`capture::failure::classify`, exhaustive matches without wildcard arms):
filesystem I/O, an unavailable or busy store, cancellation and shutdown, an
unavailable or failing host or embedding provider, a lost or busy lease and
maintenance. A transient failure keeps the work pending; everything else closes
the affected post-store step with a fixed reason, or closes a record whose
primary work cannot continue (for example a row a human edited since). Two
consequences follow from that: a terminal failure in the primary phase (such as
a stale row that was edited, shared or rebound since) keeps the rows already
written and drops the rest of the turn; a missing or edited row in the
post-store preflight closes both post-store steps (classifier with reminders,
and the Neo episode) for all rows of the turn. A reminder refused for its
content (an out-of-range time, empty text, an invalidated or foreign key match,
a tombstone) drops only that reminder; the turn stays. Each recovery attempt is
counted durably in the record before anything else runs (`recoveryAttempts`,
RE-D159); after five unsuccessful attempts the record is closed
(`recovery-exhausted`). The replay WAL is described in RE-D159.

`postSkipped` and `recoveryAttempts` are new record fields. An older binary reads
such a record as malformed; rolling back across this change is not supported
while such records are pending.

### Engine status in the process (RE-D157)

With a configured store base, `engine.status` is the library `StatusReporter`
over the process's own sources, as the pin's `createStatusReporter`:

- `journal`: the host's `journalBacklog` (reverse `host.journalBacklog`), waited
  for at most 50 ms with one callback in flight; a slow, failing or invalid
  answer is `null`, as at the pin.
- `jobs`: the registry's ledger-derived health (RE-D158).
- `storeSchema.current`: `<base>/_schema.json` (`schemaVersion`); a missing
  marker is `"0"`, an untrusted or malformed one `null`. `expected` stays `"1"`.
- `models`, `agents`: the RE-03 readiness snapshot and the opened namespaces.
  `sharedMemory` keeps `{supported:false, mode:"unavailable"}`: sharing is not
  served in RX.

Status reads only; it creates no directory or file, takes no lease, binds or
closes no registry and does not wait for a job session or a capture
composition. After `close()` it asks no source: no host callback, no ledger read
(RE-D160).

`ready` is true, and model warming or failure degrades as at the pin
(`models-warming`/`model-failed`), except in these process states, which report
`ready: false`: closed (`closed/engine`); capture not served
(`startup-recovery-incomplete` or `composition-invalid` with `capture`, RE-D154
and RE-D156); the jobs root cannot be bound (`composition-invalid/jobs`); a base
schema marker every store open refuses (`schema-unsupported/store`, RE-D160).
One agent's failed job session start is not a status state (RE-D160). Which
degradation is reported follows the RE-D159 priority. A ledger
that only cannot be read reports `jobs.ledger: "unavailable"` and keeps `ready`,
as at the pin. A host without a backlog (`journal: null`) keeps `ready`, as at
the pin. Without a store base the frozen `{composition-pending, recall}` status
is unchanged.

### Job registry in the process (RE-D158)

`engine.jobs.*` is served by the native `jobs::registry::Registry` over
`<base>/_jobs` (the pin's `jobsRoot`). `list` is the frozen catalog of all 20
jobs. `history` reads an agent's ledger and returns nothing for an absent root;
it creates nothing. Runs emit the host event `job.run`, as at the pin.

Authority follows F13. `jobs::authority::JobScope` classifies every catalog job:
all non-LLM jobs read or write private owner or workspace rows (memories, Neo,
reminders, proposals, knowledge, including `knowledge-update`), and RX has no
binding source. The cron context, an agent ID or a row owner never grants one.
Such a job answers `E_NOT_AVAILABLE` with the fixed reason
`job-authority-unbound`; LLM jobs (RE-06 T2–T7) answer `not-implemented`. The
refusal comes before any file is created. `dryRun` keeps the registry's
`skipped/dry_run_unsupported` answer for installed bodies and creates nothing,
also no `_jobs` (RE-D160).

The only installed body is `embedding-drain` when Neo is disabled in the
effective configuration. It is the pin's early exit
(`internal-job-bodies.js`: `jobCtx.skip("neo_disabled")`): it opens no Neo store
and reads no row, and its run is recorded in the ledger like any other. With Neo
enabled the drain reads private Neo rows and refuses like the others.

The first run of an agent starts its registry session: the kernel lease, orphan
marker recovery and the configured legacy migration (`Registry::prepare`). The
start has a fixed budget and ends on shutdown or when its caller is cancelled
(RE-D160), so `close()` never waits for it and stays within its budget; nothing
is held across it but the agent's own slot. A failed start concerns only that
agent's runs and is retried by its next run (RE-D160). The process configures no legacy REM
state roots: the pin migrates them inside the `rem-dream` body from owner-bound
Neo stores, which RX cannot bind (F13; KNOWN-GAP for RY-A).

Health follows the pin's `health()`: every safe agent directory under the root
plus every agent with a run in flight, the latest finished run per job (by
`finishedAt`), the in-flight jobs (from the durable marker until the run is
finished), the rem/deep breaker for the current UTC sweep (limit 3, in-flight
sessions included) and the unreadable line count. A ledger is re-read only when
its length, modification time, inode or change time changed (RE-D160). A latest row that does not fit the
frozen `JobLastRun` is left out (the pin would project it as is).

### Owner-isolated capture recovery, bounded retained state and status priority (RE-D159)

Principle: an open admission or an open Neo plan of one owner never affects
another owner's capture, and nothing stays open or grows without bound.

Admissions (`_capture-admissions`):

- A file is named by `scope`, a 16-hex digest of agent and owner, and `hash`, the
  digest of agent and turn key (`<scope>-<hash>.json` here; `<scope>/<hash>.json`
  since RE-D162). Leases are per scope (`.leases/<scope>.lock`), so lease files
  are bounded by the number of owners.
- Completed and abandoned records are removed (unlink, directory sync) instead of
  being rewritten as `{"record":null}`. Idempotency of a run does not rest on that
  file: a closed envelope read as "fresh" already; the replay WAL
  (`_capture-turns`) keeps a delivered turn from being captured twice.
- `begin` and `save` never open another file. Only the caller's own scope
  counts: at most 512 open records and 64 MiB per scope, so a full scope refuses
  only its own owner. What they list, and when another owner's record with the
  same agent and turn key refuses an admission, is described in RE-D162.
- The startup inventory classifies the directory by scope from names alone. A
  file that no scope can be attributed to is kept, reported and never read; it
  counts against nobody's capacity. An operator removes or moves such a file out
  of `_capture-admissions`; the status clears at the next open, when the
  inventory is computed again. The old 50 000-entry ceiling is gone. Files of
  earlier formats: RE-D162.

Recovery per owner:

- Each scope, and each Neo plan binding, gets its own budget
  (`runtime.captureTimeoutMs` for admissions; for Neo plans see RE-D162). A scope
  that runs out of it is deferred; only shutdown ends the recovery as a whole.
- Before a turn, only that caller's own deferred scope is retried, under its own
  budget and the engine's shutdown signal. A retry failure or abort never refuses
  or aborts the turn; the scope stays deferred until a retry ends without
  failure. Where the retry runs and what it holds: RE-D162.
- Every attempt is counted durably before anything else runs, including the
  host, policy and workspace checks; maintenance gives the counted attempt back,
  also when it starts between the check and the attempt. After five attempts the
  record or plan is closed (`recovery-exhausted`). A crash between counting and
  giving back costs one attempt.
- Failure classes are refined: an embedding provider's client error (4xx other
  than 408 and 429) is terminal; a workspace policy that needs a workspace
  identity the caller lacks, or an invalid request, is terminal (`invalid-input`);
  an unreadable policy state stays transient and is counted. A host that answers
  with an unclassified error (`HostError::Failed`, for example an internal error
  of the reverse call) stays transient: it says nothing about the turn's content,
  and the attempt bound limits it.
- Neo plans (`native-{capture,episode,embedding}-pending-*.json`) follow the same
  rules per owner binding: revoked policy, a changed workspace, directory or
  binding, five attempts or a terminal failure remove the binding's plan files
  (journals written before stay); maintenance and transient failures keep them.
  A plan file that cannot be read is kept and reported. Attempt counts live in
  `<neoRoot>/.native-recovery-attempts/`.

Revocation discards retained plaintext: the admission file is removed by the
recovery after the next open, at a retry of that owner, or mid-turn; the
binding's Neo plans by the recovery after the next open or at that owner's next
turn (RE-D162).
For an unfinished primary turn the replay WAL entry is released as at the pin's
`onRowsKept` (no row is deleted), only when every pending row ID belongs to that
record. The process serves no native workspace-policy path in RX
(`workspace_policy` answers `not-available`), so there is no immediate discard
on a policy change. Pending WAL entries now expire after the same seven days as
settled ones (`REPLAY_GUARD_TTL_MS`, pin `turn-replay-guard.js` `fresh`; vector
`wal-failures.json` `expired-pending`), which ends the former Rust retention
exception. The WAL holds content hashes, never plaintext.

Status priority (first match wins): `closed/engine` > `composition-invalid`
(capture or jobs) > `schema-unsupported/store` (RE-D160) >
`model-failed/embedding` > capture not served
(`startup-recovery-incomplete`) > `models-warming/embedding` >
`model-failed/reranker` > `models-warming/reranker` >
`capture-recovery-deferred/capture` > the frozen `composition-pending/recall`.
The pin's model order (`types/engine.d.ts`, `status-reporter.js`
`degradedFromModels`) stays a subsequence. `degraded.reason` is a free string in
the frozen schema (`engine-contract.schema.json`, `Degraded.reason`), so
`capture-recovery-deferred` is a new value. It means: capture is served, some
owner's retained work waits (maintenance, a transient failure, its budget) or a
file cannot be attributed; it does not change `ready` and clears once the work
is done. `startup-recovery-deadline` is no longer reported.

### Truthful readiness, bounded job sessions and per-agent isolation (RE-D160)

Principle: `ready: true` only when recall and capture do not fail for a normal
caller on a state that is already known and lasting, and one agent's jobs never
affect another agent or the engine as a whole.

- Store schema: status reads `<base>/_schema.json` through the same reader every
  store open uses (`store::schema_version::read_base`). An unsupported version
  (for example `"2"`), a malformed, untrusted or unreadable marker makes every
  store open fail with `Corrupt`; status then reports `ready: false` with the
  fixed `schema-unsupported/store`, ranked directly after `composition-invalid`.
  A missing marker on a store not created yet is legacy `"0"`, as at the pin, and
  keeps `ready`. `storeSchema.current` keeps the lenient pin projection.
- Job session start: lease wait, orphan recovery and legacy migration get
  `SESSION_START_BUDGET` = 5 s, the library's comparable bounded waits
  (`store/tombstone.rs` `LOCK_TIMEOUT`, `store/sqlite.rs` `BUSY_TIMEOUT`, the
  registry's 5 s settle budget). An earlier request deadline narrows it. RPC
  requests carry no deadline: the server cancels a request's token only when its
  connection closes, so for an RPC caller the bound is the budget, or the
  closed connection, or engine shutdown, whichever comes first. Expiry answers
  `E_NOT_AVAILABLE` with the fixed reason `job-session-busy`; nothing is recorded
  and the agent's slot stays unstarted, so the next call simply tries again.
  `engine.jobs.history` never waits for the agent's slot: while a start or run
  holds it, the ledger file is read directly (no lock).
- Isolation: a failed session start (for example an unreadable ledger) answers
  `startup-recovery-incomplete` for that agent's runs only and is retried on its
  next call; it is not a status state. The pin keeps `ready` too and reports the
  unreadable ledger only as `jobs.ledger: "unavailable"`.
- Status has no side effects: a replaced jobs root is reported
  (`composition-invalid/jobs`), not closed or rebound; the next run rebinds it.
  A root no run has bound yet is read through a temporary directory handle.
  After close, status asks no source (no `host.journalBacklog`, no ledger read).
- A dry run creates nothing, also no `_jobs`; without a bound registry its
  `skipped/dry_run_unsupported` run is built by `jobs::registry::dry_run_report`.
- The health cache key adds inode and change time (Unix) to length and
  modification time, so a same-length rewrite is re-read.

### Capture recovery outside the composition (RE-D162)

Principle: no owner and no agent can delay or fail another owner's capture, except
through the normal order of single write steps on the same agent table. Nothing
stays open or grows without bound, and no plaintext stays in an unfinished
admission record for more than seven days. RE-D163 extends the last part to
prepared Neo plans and to temporary files and names the conditions under which
the bounds hold.

Configuration digest. A retained record is closed as `config-changed` only when a
key differs that changes what a resumed turn stores or which of its steps run. The
record's `config` field is the digest of this projection of the effective
configuration (`capture::admission::CAPTURE_SEMANTICS`); a missing key counts as
its own value:

| Key | Why it is part of the digest |
|---|---|
| `duplicateThreshold` | decides which prepared items are stored at all |
| `captureChunking`, `captureChunkingMode` | decide into which rows a message is split |
| `captureMaxChars` | the length from which a message is summarized or truncated |
| `summaryMaxWords` | the stored row summary |
| `merging.enabled` | whether an over-long message is summarized or truncated |
| `emotion.tier`, `emotion.t2.enabled`, `emotion.t3.enabled`, `emotion.t3.onlyWhenProviderAvailable`, `emotion.t3.escalationConfidence`, `emotion.t3.captureMode`, `emotion.t3.refineImportanceMin` | the classifier tier and the emotion status written into each row |
| `emotion.moodInfluence`, `emotion.intensityHalfLifeFactor`, `emotion.temperaments` | the mood and dynamics values written into each row |
| `memoryDynamics.flashbulbEncoding`, `recall.halfLifeDaysMap` | the memory class, strength and half-life encoded at capture |
| `reminders.autoExtract` | whether the post-store step extracts reminders |
| `namespaces.activeWriteNamespace` | the store the rows are written to: the capture pipeline writes through the pool of the writer route (`NamespaceStores::writer_pool`), and that route is this key; rows written before are not visible in another one |

`neo.enabled` left the digest with RE-D163: a resumed record applies the switch as
it is now (`capture_inner` and the Neo hook read the current configuration), so
the entry only discarded rows that were still to be written in order to protect
a Neo step that is skipped anyway. A record written under the RE-D162 projection
is closed once (`config-changed`); like the earlier formats it only existed on
this unpublished branch.

Everything else is operational and never closes a record: all of `runtime`
(time budgets, queue sizes, caches, `deferPostTurnLlm`, which has no scheduled
path in RX), `embeddingBatchSize`, every `timeoutMs`, credentials, endpoints and
model names (`llmRouter`, `merging.model`, `emotion.t3.model`; a language model's
answer is not reproducible, so no step's idempotency rests on its name),
`neo.agentEndBudgetMs`, `neo.embeddingDrain` and the settings of recall,
reranking and jobs. The vector space stays the record's own `space` field. A
record written under the earlier whole-configuration digest is closed once
(`config-changed`); that format only existed on this unpublished branch.

Admission layout. A record is `_capture-admissions/<scope>/<hash>.json`: `scope`
is the 16-hex digest of agent and owner, `hash` the digest of agent and turn key.
This replaces the RE-D159 file name. Leases stay `.leases/<scope>.lock`. `begin`
and `save` list the caller's own scope directory only (names and sizes, no file
is opened; the cost test counts opened files and listed entries), so a turn's
cost depends on no other owner's records and on no top-level file. An empty
scope directory is kept; like the lease files, the directories are bounded by
the number of owners. Only a fresh admission that inherits rollback IDs from the
replay WAL (after a kill or an abort) looks into the other scope directories for
a record of the same agent and turn key and is refused if one exists (the Node
key excludes the owner). The scope is a 64-bit digest prefix: two owners with the
same prefix would share lease, capacity and budget, never content, because a
record is only accepted under the scope its full digests name. This is left as it
is; a chance collision is negligible and a targeted one needs about 2^64 tries.

Earlier formats. Top-level files named `<hash>.json` (RE-D156) or
`<scope>-<hash>.json` (RE-D159) are removed when the root is inventoried,
without migration and whatever they hold, with one directory sync at the end
instead of one per file. Both formats only ever existed on this unpublished
branch, so no installation holds a record worth migrating. Every other top-level
entry is left alone, counted and reported as `capture-recovery-deferred` until an
operator removes it; the count is taken again at the next open.

Age bound. A retained record whose admission time (`atMs`, host clock) is more
than seven days old is closed terminally (`recovery-expired`) and its plaintext
discarded; rows already written stay. A file with a record name in a scope
directory that is not a well-formed record of that scope defers and reports that
scope only, and is removed once its modification time is more than seven days
old. Seven days is the pin's pending TTL (`REPLAY_GUARD_TTL_MS`, inclusive like
the pin's `fresh`), so the replay entry of such a turn has expired as well.

Composition takes an inventory only. `Engine.open` and the first capture compose
the runtime. Until it is ready the composition lists `_capture-admissions` (owner
scope directories that hold a record file; earlier formats removed; everything
else counted) and the Neo workspace directories (prepared plan files per owner
binding; each plan file is read for its stored caller), and removes temporary
files that are more than an hour old (RE-D163). It asks the host for nothing
that concerns an owner (no `host.workspaceDir`; the configuration and the clock
are read, both local in the process host), calls no provider and waits for no
lease, so its duration depends on the number of directory entries and on the
number and size of the plan files, never on what any owner's work would do. The S5 tombstone gate before it is the one recall has. The result is the
pending set: owner scopes (admissions) and owner bindings (Neo plans,
`<workspace directory>/<binding digest>`). The library's
`CaptureRuntime::new` and `NativeNeoCaptureHook::open` still return after one
recovery pass; the process uses `CaptureRuntime::compose` and
`NativeNeoCaptureHook::open_deferred`.

Recovery runs behind the composition. A background pass
(`capture-recovery-pass`) goes through the pending set once, owner scopes first,
then Neo bindings, one after the other. Each attempt runs on its own thread
(`capture-recovery`, `neo-recovery`) under its own budget. The pass only waits for
it, at most the budget plus one second, and then goes on. An attempt's own host
calls run on a helper thread with the attempt's budget (RE-D163), so a host that
does not return ends the attempt with its budget and keeps no key busy. While an attempt
counts itself (`recoveryAttempts`), assesses the record (host, policy) or waits
for its own scope lease, it holds neither an admission ticket nor a queue slot.
A budget that runs out defers the key; the attempt was counted and the bound of
five stays. Budgets:

- An owner scope gets `runtime.captureTimeoutMs`, the budget of a turn's capture.
- A Neo binding gets `min(runtime.captureTimeoutMs, max(1000,
  neo.agentEndBudgetMs || 20000))`. This is the budget of a turn's own Neo step
  at the pin (`engine/create-engine.js` `neoAgentEndBudgetMs`, applied in
  `engine/capture/capture-turn.js` with `deriveBudgetedSignal`); a resumed binding
  is that same step and gets no more. The former fixed 300 seconds are gone.
  Closing a binding's plans (`discard_plans`) waits for the workspace lease and
  the Neo write lock under the same budget; a lock held elsewhere defers the
  binding.

One write step per record. The row work of a retained record is one job in its
agent's capture queue, as a turn's is. In that job the scope lease and the turn
lease are only tried; a busy lease defers the record (counted). The pin serializes
captures per agent, not per owner: `lib/runtime-scheduler.js` keys the capture
queue by agent (`enqueueCapture`, `agentId || "default"`) and runs
`maxConcurrentCapturePerAgent: 1` job at a time (`drainCapture`); a queued turn
whose caller gives up meanwhile is not captured. So a turn of another owner of
the same agent waits for one retained record exactly as it would wait for one
running turn of that owner, and for nothing else.

Before a turn. Only while something is pending or in flight does a turn resolve
its owner before admission. It parks its admission ticket (it keeps its place,
nobody waits behind it), resolves its identity with a deadline, and joins the
attempt of its own scope and its own binding, or starts it; a second attempt is
never started. It waits at most that key's budget and its own cancellation, and
never for another owner. Turns of one owner that waited for the same recovery go
on in their order. A lookup that gets no answer in time ends only that turn:
`aborted` when its caller cancelled, otherwise the result of a failed lookup (the
pin's `detailOf(error)`). The identity lookup of the admission itself has the
same deadline (the caller's, at most `runtime.captureTimeoutMs`). It starts
before the turn waits for its place in the agent's order (RE-D163); a host that
has not answered one second after that start no longer holds the agent's order,
the ticket is parked until the answer arrives. The second is counted per lookup
from its start, so it does not add up over turns in a row. At the pin that
lookup holds no agent-wide order at all (`engine/create-engine.js`,
`host.workspaceDir` inside `replayGuard.run`). The additional lookup before a
turn, made by every turn while any owner retains something, stays; it is bounded
by that second and by the places for outstanding lookups (RE-D163).

Mid-turn cleanup. When a turn is refused or revoked mid-turn, a failed discard of
its admission or a failed release of its replay entry is logged and the caller
still hears `not_captured`; the record then stays for its owner's next recovery.
The durable acknowledgements after committed rows (`settle`, `keep_partial`) wait
at most five seconds for the agent's WAL lease instead of without bound; past
that the turn stays replayable.

Age sweep. Once an hour of the host's clock the pass checks the pending scopes
against the age bound and discards what is older than seven days; it makes no
recovery attempt and counts none. Retained plaintext of an admission record is
therefore gone at most seven days and one hour after its admission while the
engine runs, and at the next open otherwise. This holds unless one of the
conditions listed in RE-D163 ("Known limits") applies. Neo plans and temporary
files are swept too (RE-D163).

Close. `close()` raises the shutdown signal, which ends every attempt at its next
check and the pass at once; no attempt starts afterwards. Close waits for the
queue, the admitted turns, the attempts in flight and the pass within its one
budget and reports `capture-drain-incomplete` when something is still settling
(for example a host lookup that is still out; its thread is left to finish).

Status. While a scope or binding waits or is being recovered, or a top-level file
is owned by nobody, the status is `capture-recovery-deferred` and `ready` stays
true; the priority of RE-D159 is unchanged.

Wait graph after RE-D162 and RE-D163. "Blocks another owner" means: can a turn of
another owner wait here because of this owner's retained work.

| Path | Waits for | Bound | Blocks another owner |
|---|---|---|---|
| Composition (`ProcessCapture::runtime`, `Slot::Composing`) | directory listings, plan files read for their caller, file times, one directory sync per directory with removals | number of entries, number and size of plan files | no |
| Composition, S5 tombstone gate (`recall_pools`) | store open | shutdown | no; not owner-related, same gate as recall |
| Pass, scope attempt (`CapturePipeline::recover_scope`): count, scope lease | `.leases/<scope>.lock` | `captureTimeoutMs` per scope | no; holds no ticket and no slot |
| Scope attempt, host callbacks (`asked`: assessment, identity before the job; helper thread `capture-recovery`) | host, policy | scope budget; one of the agent's two places | no; holds nothing. A host that never answers keeps the helper thread and its place, never the key |
| Scope attempt, record job (`recover_record`) | the agent's queue slot; leases tried only | `captureTimeoutMs` from the slot, cut by the scope budget | same agent, one record: as at the pin |
| Pass, binding attempt, workspace lookup (`EpisodeStore::resolved`; helper thread `neo-recovery`) | host | Neo budget; one of the agent's two places | no; asked before any lease |
| Binding attempt under workspace lease and `.neo-write.lock` (assessment, replay), also `discard_plans` | policy file, file system; no host callback | Neo budget | same workspace, one Neo write step: as at the pin, which has the same write lock |
| Sweep (`expire_retained`, hourly by the host's clock) | per pending scope its expire-only attempt, per expired binding its discard; directory listings for temporary files | per key its budget plus one second | no; holds nothing between keys |
| Turn before admission (`accept::execute`, ticket parked): identity lookup | host | caller, at most `captureTimeoutMs`; one of the agent's two places | no |
| Turn before admission: its own scope's and binding's attempt (`recover_owner`), Neo binding lookup (`neo-identity`) | the attempt in flight; host | the key's budget; Neo budget; caller; shutdown | no |
| Turn before admission: `OwnerGate::wait_front` | earlier turns of the same owner that waited for the same recovery | caller | no; own owner only |
| Turn admission, WAL leases (`CaptureWal::begin_mode`) | an identical turn (ticket released), the agent's WAL write | caller | no; a write step on the agent's WAL file |
| Turn admission, identity lookup (started before the wait for the agent's order) | host | caller, at most `captureTimeoutMs`; the agent's order for at most one second since the lookup started | no beyond that second, which does not add up over turns in a row |
| Turn job (queue slot, scope lease) | the running job of the same agent | `captureTimeoutMs` from the slot | same agent, one turn: the pin's order |
| Turn job, Neo steps (pre-store journal, post-store episodes): workspace lease, `.neo-write.lock` | a Neo write step of the same workspace | Neo budget per step | same workspace: at most the Neo budget per step, then the turn is stored and its Neo step deferred (`engine/capture/capture-turn.js:399`) |
| WAL acknowledgements (`settle`, `keep_partial`) | the agent's WAL lease | five seconds | no; a write step on the agent's WAL file |
| Turn, fragment compactor note (RE-D161) | the compactor's counters and queue (two short in-memory locks) | none needed: no I/O under them | no |
| Compactor worker, fragment count (RE-D161) | opening its own store handle and the stats read | five seconds for both, shutdown | no; never the pool handle of capture or recall |
| Compactor worker, optimize (RE-D161) | its own store handle: compact, prune, index; retry pauses | `runtime.lancedbCompaction.timeoutMs` (at least ten seconds per attempt), shutdown | no; other agents' checks wait behind it, as in the pin's one chain; turns and recall never |
| Close | queue, turns, attempts, pass, outstanding host lookups, compactor worker | close budget | - |

Neo attempt counts. A binding's attempt count
(`<neoRoot>/.native-recovery-attempts/`) is cleared when its plans are recovered
or closed, and also when its owner's own journal write replays a prepared plan
live and when a new plan is written for the binding. A count never outlives the
plan it was counted for, so a later kill of the same binding starts at zero. A
count that cannot be read allows exactly one more attempt (it stands for the
bound minus one): the plans are neither closed without an attempt nor retried
without bound. The inventory's bound of 50 000 scanned entries holds per
workspace directory, not for all directories together, so one owner's large
workspace never cuts short the scan of another owner's directory.

### Bounds that close the capture recovery (RE-D163)

Principle, extending RE-D162: nothing stays open or grows without bound, and no
plaintext stays for more than seven days in an unfinished record or plan that
Rust wrote.

Outstanding host lookups. A host lookup that runs on a thread of its own, because
the host may never answer, takes a place first (`capture::retained::HostCalls`):
two per agent and 32 in the process, the numbers of the ruling. The thread holds
its place until the host call returns, not until its waiter gives up. While a
lookup in the way is younger than one second, a new one waits for its place, so
a burst of turns on an answering host is never refused. Once every lookup in the
way is older, the next one is refused at once, without a thread: a turn then
ends as one whose lookup was not answered (`Error textLen=...`, the pin's
`detailOf(error)`), a recovery attempt as a transient host failure. A host that
hangs for one agent therefore leaves at most two threads behind for it, whatever
the number of turns, and takes at most two of the 32 places from everybody else.
After close no lookup starts; a turn still waiting for one then ends
`engine-closed`, as the closed queue would answer it. A turn whose admission
thread cannot be started ends alone, as an unanswered one; `accept` does not
fail for it. With an answering but slow host the two places limit how many
lookups of one agent run side by side.

Budget per host callback on a capture or recovery path:

| Host callback | Thread | Budget | When it runs out |
|---|---|---|---|
| Turn, identity before its owner's recovery (`accept::lookup`) | `capture-identity` | the caller's cancellation, at most `captureTimeoutMs`; shutdown | the turn ends as unanswered |
| Turn, identity for the admission (`accept::lookup`) | `capture-identity` | the same; the agent's order is held for at most one second since the lookup started | the turn ends as unanswered |
| Turn, Neo binding of its caller (`recover_owner`) | `neo-identity` | Neo budget, the caller's cancellation, shutdown | the turn joins no attempt and goes on |
| Scope attempt, assessment and identity (`CapturePipeline::asked`) | `capture-recovery` (helper) | the scope's budget (`captureTimeoutMs`), shutdown | the attempt ends; it was counted and the scope waits again |
| Binding attempt, workspace (`EpisodeStore::resolved`) | `neo-recovery` (helper) | Neo budget, shutdown | the attempt ends; it was counted and the binding waits again |
| Inside a queue job, of a turn or of a recovered record (ownership proof, policy, the Neo binding checks of a live step) | the job | `captureTimeoutMs` from the slot for the receipt | the receipt reports a timeout; the agent's slot is released when the job settles, as at the pin (`lib/runtime-scheduler.js`, `drainCapture`) |

No host callback under the Neo leases of an attempt. A binding's recovery attempt
asks the host once, before any lease: the workspace directory of the plan's
agent. Assessment and replay then run on a view of the store over that answer
(`ResolvedHost`), so under the workspace lease and the Neo write lock only the
file system and the policy file are read. Within one attempt (at most the Neo
budget) a change of the host's workspace mapping is therefore not noticed; the
directory identities on disk are still checked at every step. A live turn's own
Neo step asks the host as before; a host that does not return there holds the
workspace lease as a hanging turn does at the pin.

The wait of a Neo step. Every Neo step waits for the workspace lease and the Neo
write lock at most the Neo budget, `min(runtime.captureTimeoutMs, max(1000,
neo.agentEndBudgetMs || 20000))`, whatever its caller's own budget is. At the
pin this is the budget of a turn's whole Neo step (`engine/create-engine.js:867`
`neoAgentEndBudgetMs`, applied in `engine/capture/capture-turn.js:359` with
`deriveBudgetedSignal`), and a step that runs out of it is logged while the
capture goes on (`capture-turn.js:399`). Here a turn has two Neo steps, the
journal before the rows and the episodes after them; each waits at most that
budget. When the wait runs out the turn's rows are stored, its result is not
`aborted`, the Neo step stays open in the turn's admission record and is made up
by its owner's next recovery. Only the wait is bounded this way, not the work of
a step that has its leases.

Age bound of Neo plans. A binding's prepared plans are discarded
(`recovery-expired`) once the oldest plan file that holds content is more than
seven days old: its modification time against the host's clock, inclusive like
the admission bound. This happens whatever the attempt count is and counts no
attempt. The first pass applies it to the bindings the inventory found. The
hourly sweep reads the workspace directories again, so a plan that a failed turn
left behind while the engine ran is found too; only bindings past the bound get
an attempt then, and that attempt discards them. With Neo switched off nothing
of Neo is written or resumed, but an existing Neo root is still swept this way.
Journals already written stay. A plan file that cannot be read stays and is
reported, as before; it may be in the pin's format. A binding whose plan files
are all settled (a capture plan without rows, an episode or embedding file whose
plan is null) holds no turn content and no caller: it is counted and logged, not
listed, and nothing of a valid plan is lost by that. Discarded plans are logged
with the number of their files.

Temporary files. The atomic writer creates `.<name>.<process id>.<nonce>.tmp`
next to its target and renames it. A writer killed in between leaves the whole
record or plan under that name, which no inventory lists. Such files in the
owner scope directories and in the Neo workspace directories are removed once
their modification time is more than an hour before the host's clock: at the
inventory and by the hourly sweep, without a lease, because after an hour no
writer is between writing and renaming. Only regular files of exactly that name
pattern are removed; the number removed is logged.

Sweep and pass. The sweep is due when an hour of the host's clock has passed
since the last one (or the clock went back); the pass looks at the clock once a
minute. A panic in the first pass or in a sweep is caught and logged: the first
pass still counts as finished (so `CaptureRuntime::new` returns), the next sweep
still runs, and no key stays in flight, because an attempt's key returns when
its own thread ends. A turn that joined a sweep's attempt, which resumes
nothing, starts exactly one attempt of its own afterwards if its scope still
waits.

Time of a resumed turn. A record that is being recovered writes a new Neo
journal plan with the time of its admission (`atMs`), not with the time of the
recovery, so a later turn of the owner that was captured first stays the later
one in the journal. A plan that was already prepared keeps its own time. The
episodes of the post-store step still carry the time at which they are written.

Known limits. These are left as they are:

- A scope lease that another process holds without end: that owner's own records
  cannot be counted, closed or expired until the holder ends; nobody else is
  affected.
- A malformed file with a record name whose modification time cannot be read is
  never removed; its scope stays deferred and reported. A scope directory that
  cannot be opened is counted as owned by nobody and reported.
- A plan file that cannot be read is kept without a time limit (see above).
- A host call that never returns keeps its helper thread and its place (at most
  two per agent, 32 in the process); inside a live queue job it keeps the
  agent's slot until it returns, as at the pin.
- Plan and temporary file ages compare file times with the host's clock; a skew
  between the two shifts the bound by that skew.

### Fragment compaction after capture (RE-D161)

Every stored capture row is a new LanceDB fragment of the agent table. The pin
(`engine/store/fragment-compactor.js`, wired in `engine/create-engine.js:1574-1589`
and `engine/capture/capture-turn.js:768-772`) counts the stored rows per agent
and compacts the table once it has enough fragments; until RE-D161 the process
had an optimize entry but no caller, so fragments grew without bound and recall
slowed with every turn. `store::fragment_compactor` ports the compactor:

- Configuration as at the pin: `runtime.lancedbCompaction` (`enabled` true,
  `fragmentThreshold` 64, minimum 8; `checkEveryWrites` 16, minimum 1;
  `checkIntervalMs` 600 000, minimum 60 000; `timeoutMs` 60 000, minimum 10 000;
  a non-integer or out-of-range value takes the default). `enabled: false` is the
  only off switch. Versions older than
  `dailyConsolidation.lancedbOptimize.keepVersionsHours` (default 24, minimum 1)
  are pruned. Both keys are in the existing configuration schema; nothing in the
  schema changed.
- After the store loop of a turn with at least one stored row, the pipeline notes
  the rows for the turn's agent table (`CapturePipeline::capture_inner`, after
  the post-store admission is saved, before the post-store steps). A recovered
  turn notes its rows the same way. The note only counts; a due check is queued
  and the turn neither waits for it nor hears of its failure (the pin's
  `runInBackground`). A turn without a stored row notes nothing.
- A check is due when an agent's total writes cross a multiple of
  `checkEveryWrites` (several crossings in one turn: one check) and every
  `checkIntervalMs` for every agent with a write, in first-write order. It reads
  the fragment count (unknown: the writes since the last compaction stand in) and
  optimizes at `fragmentThreshold`: compact, prune, then optimize indices (the
  pin's `table.optimize`), up to three attempts against retryable commit
  conflicts with one and two seconds of pause, within `timeoutMs`. Success resets
  the writes since compaction and the conflict streak; busy, no table or shutdown
  skip; a conflict is logged at debug, from the fifth in a row at warn; any other
  failure is logged at warn and resets the streak. The next due point retries.
- One check per agent is queued or running at a time, and one worker thread runs
  all checks one after the other (the pin's FIFO chain). No status reason is
  added; log lines name the agent as the pin does (`fragment-compactor.js`
  FC:180,183,187) and carry fixed reason codes only (no path or backend text).
  After a compaction the worker does not count again: the pin reports that count
  only in the check's outcome, which the worker discards (fixtures keep it).
  The timer fires on time also while checks are queued (the pin's `setInterval`);
  its agents join the end of the queue.

Node vectors: `tests/fixtures/capture/fragment-compactor.json`, recorded twice
byte-identically by `record-fragment-compactor.mjs` from the SHA-checked pin
sources (27 settings, 21 retention inputs, 17 scripted scenarios with every port
call, timer, log kind and outcome). `tests/capture_fragment_compactor.rs` replays
them through the native counters.

Native bounds beyond the pin (RE-D161):

- The table work runs on its own store handle (its own runtime thread), never on
  the pool handle that capture, recall, forget and import of the agent share; a
  slow compaction therefore holds no turn and no recall of any owner. Concurrent
  commits are resolved by LanceDB's optimistic commits, as at the pin.
- A step past its budget or after the shutdown signal is dropped at its next
  await point. At the pin a timed-out `optimize()` keeps running inside LanceDB
  and `close()` waits for it without bound; here `close()` cancels it and waits
  for the worker within its one budget, reporting `capture-drain-incomplete` when
  the worker is still inside a call. A dropped compaction leaves at most
  unreferenced data files, which a prune removes once they are older than seven
  days (LanceDB's unverified-file threshold, `delete_unverified` unset);
  committed data is never touched.
- The fragment count opens the table and reads its stats on a short-lived
  thread within one five-second budget (the pin's `fragmentCount`,
  `lib/db-adapter.js:1020-1039`, bounds both) or until shutdown; a hung open
  holds the worker at most that long and counts as unknown. At most four such
  threads may be stuck at once; beyond that the count is unknown at once.
- The per-agent counters are bounded at 1024 agents; the agent whose last
  activity is oldest is forgotten first (it loses only its write counts). The pin
  keeps every agent it has seen. With more than 1024 agents rotating so that an
  agent is always forgotten between two of its own writes, that agent never
  reaches a due point and the timer does not see it either; its fragments then
  grow until it stays tracked long enough (accepted, M3).
- `Store::optimize`, an unused second entry without the busy claim and without
  the index step, is removed; compaction has one path.
- After close no check starts and no write is counted; the process-wide
  busy set per table path stands in for the pin's per-path optimize lock
  (`ifBusy: "skip"`).

Not ported: the pin's `compactNow` (forced run) has no caller in the capture
path, and consolidate-daily's own optimize belongs to the job work (RE-06).

### Bounded job admission, status reads and per-agent caches (RE-D164)

- Admission: after the session start, a run's admission window (the agent's slot,
  the durable start marker with the ledger writer lease, the snapshot) waits at
  most `SESSION_START_BUDGET` (5 s) or the caller's earlier deadline, and ends on
  a closed connection or shutdown (`Registry::run_admitted`); expiry answers
  `job-session-busy`. The body and its 5 s settle keep the caller's token. Every
  holder of an agent's slot is therefore bounded, so the blocking slot lock in
  the run guard's drop is bounded as well.
- The watcher of a budgeted wait ends on every exit of the wait, also a panic
  (drop guard), so its thread scope never waits for it.
- `history` reads the ledger directly while the slot is held; a read that
  overlaps an append (the reader sees the size change, `ledger/io.rs` `read`) is
  retried at most three times, 5 ms apart, within 250 ms, then answers as before.
  The overlap is reachable: the direct read happens exactly while a run of the
  same agent holds the slot to append its row.
- Per-agent bounds: a registry keeps at most 256 idle agent slots (each a started
  session with directory handle and lease; same bound as the shared emotion
  engines); the least recently used idle slot is released, a slot in use never.
  A health cache keeps at most 1024 ledger projections (the compactor's
  tracked-agent bound), least recently used first. A failed session start keeps
  `_jobs/<agent>/` and its lease file: removing them could race a parallel start
  in another process that holds or waits for the same lease file, so they stay
  (empty directory, empty lock file).
- Status reads: `_schema.json` is opened only as a regular file, without
  following a final link and without blocking on a FIFO or device, and read up to
  64 KiB (`store::schema_version::read_marker_text`, also used by every store
  open); anything else is `Corrupt`, so status reports `schema-unsupported/store`.
  A health read skips a ledger that is not a regular file (`ledger:
  "unavailable"`) and never holds the cache lock while it reads, so a slow ledger
  never holds another status caller.
- `job-session-busy` and the other job reasons are internal; on the wire they
  are `operation-unavailable` (`rpc/methods.rs`).
