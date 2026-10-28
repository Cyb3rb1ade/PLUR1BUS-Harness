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
