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
incomplete final record under the shared lock; complete corrupt records fail closed. `Store::optimize` keeps the
Node compaction and 24-hour pruning policy; expiry purge preserves `neverForget` and core rows, with the existing
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
unchanged. This is post-store observation: pending candidates, MemoryOps.store
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
and MemoryOps.store composition remain separate unfinished work.
