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
| `conflict-log.jsonl`, `conflict-resolved.jsonl`, `memory-candidates.jsonl`, `destructive-ops.jsonl` | `store::ledger`, `store::ledger_types` | Typed records through tolerant JSON; a lone UTF-16 surrogate stays an escaped surrogate when serialized. |
| `behavior-cards.jsonl`, `retrieval-ledger.jsonl`, `reply-outcomes.jsonl`, `reconsolidation-events.jsonl`, `reaction-ledger.jsonl` | `store::ledger`, `store::ledger_types` | Node JSONL record shapes. |
| `run-state.json`, `snapshot.json`, `.emotional-state.json`, `semantic-lens-index.json`, `hook-state.json`, re-embedding state | `store::state_file` | Tolerant JSON load and atomic replace. Invalid state remains a distinct failure; only an absent file returns no state. |
| `.neo-write.lock/owner.json` | `store::lock` (private `neo_lock` implementation) | The existing Node directory-lock layout, with its own orphan grace and liveness rules below. |
| Registry and job `.lock` files | `store::lock`, `plur1bus_rpc::process` | Exclusive creation and the Node nonce/process-incarnation ownership protocol described below. |

Lance queries keep the backend's default L2 metric. Its `_distance` is **squared** Euclidean distance: orthogonal
unit vectors return 2 and opposite unit vectors return 4. Phase 1 retains the Node score `1 / (1 + distance)`.
The store does not build a lexical index; RE-10 owns the derived `_lexical` table and its index. A round trip checks
that an additional derived table does not alter the Node reader's `memories` or identity view.

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
```

This work package records jina vectors, token IDs, task IDs, prefix checks, padding cases, identities and reranker
scores live into an explicitly named system-temporary directory outside the repository. The RE-D19 owner decision
of 2026-10-28 permits separately reviewed goldens with `NOTICE-jina.md`; the current package retains its explicit
live-temporary scope and does not generate repository goldens. Both `PLUR1BUS_ALLOW_TEST_INTERNALS=1`
and `PLUR1BUS_TEST_ACCEPT_NC_MODELS=1` must be deliberately set before `record.mjs --jina --output-dir <temp-dir>`
or the jina parity test runs. The recorder refuses before any NC fetch when either is absent. These are explicit
test consent gates, not production licence records. Production still requires the host's persisted model/revision
confirmation and explicit `modelPreparation.acceptNonCommercialLicense`; possession of model files grants no
consent. The full `embedding_parity` target includes jina and therefore also requires these gates.

For this package's pinned local parity runs, the owner explicitly granted noncommercial test consent on
2026-10-28. The two test variables were set only on those test processes. The consented recorder passed its
consent check, then failed at the enforced HTTP proxy with CONNECT 403 before acquiring model artifacts.
This test authorization does not populate production licence records or permit committing the temporary output.

**Open prerequisites:** the implementation environment's Hugging Face requests returned proxy HTTP 403 for
`--e5`, `--gemma` and `--token-ids`. Consequently their genuine model/token recordings and measured HF parity are
still outstanding. BGE's `woxpas-ai/bge-reranker-v2-m3-onnx` conversion at
`c44ebc43de724ae8816668bb44d2e728e17faa18` also lacks a verified pinned repository LICENSE/receipt.
`--bge` refuses to produce derived goldens until that evidence exists; the normal tokenizer recorder records its
explicit exclusion. No BGE or jina goldens are approved for commit by this implementation. Synthetic graph tests,
catalogue/identity fixtures and recorder unit tests do not close these prerequisites or establish RE-03 completion.

The official pinned model cards corroborate e5's [MIT declaration](https://huggingface.co/intfloat/multilingual-e5-small/blob/614241f622f53c4eeff9890bdc4f31cfecc418b3/README.md)
and Gemma's [Apache-2.0 declaration and licence link](https://huggingface.co/onnx-community/embeddinggemma-2-ONNX/blob/daa72c51243991dfcaf9f9137d2c573d8f7790c0/README.md).
BGE's [conversion README at its exact pin](https://huggingface.co/woxpas-ai/bge-reranker-v2-m3-onnx/blob/c44ebc43de724ae8816668bb44d2e728e17faa18/README.md)
claims inherited MIT, but the [upstream model card](https://huggingface.co/BAAI/bge-reranker-v2-m3/blob/953dc6f6f85a1b2dbfca4c34a2796e7dde08d41e/README.md)
declares Apache-2.0. The [pinned conversion tree](https://huggingface.co/woxpas-ai/bge-reranker-v2-m3-onnx/tree/c44ebc43de724ae8816668bb44d2e728e17faa18)
contains no LICENSE file in its root or ONNX directory. That mismatch does not establish the required licence
receipt and does not authorize BGE-derived goldens. The local cache inventory found only RE-14's o200k tokenizer,
with no pinned e5/Gemma tokenizer or ONNX payload to reuse.

After the owner reported a Hugging Face allowlist update, actual pinned tokenizer GETs were repeated at
2026-10-28 23:58:47 CET (Europe/Berlin) for
`https://huggingface.co/intfloat/multilingual-e5-small/resolve/614241f622f53c4eeff9890bdc4f31cfecc418b3/tokenizer.json`
and at 23:59:07 CET for
`https://huggingface.co/ldwformat/jina-embeddings-v3-Q8-onnx/resolve/68ed94909d564380f954be27ae2e133214c1adc9/tokenizer.json`.
Both still returned `curl: (56) CONNECT tunnel failed, response 403`, with the proxy's first response
`HTTP/1.1 403 Forbidden` (`server: envoy`), before any Hugging Face redirect. No redirected download host was
reached. Local Jina test consent remains granted; Jina parity remains open because artifact access still fails.

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
