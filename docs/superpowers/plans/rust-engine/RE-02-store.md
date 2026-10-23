# RE-02 — Store layer, byte-compatible

**Package.** Every file the engine persists, read and written by Rust exactly as the Node engine reads and writes it:
the LanceDB table `memories` and `_embedding_identity`, the three SQLite caches, the neo working-memory files, the
JSON/JSONL ledgers and state files, and the locks. Size L. The acceptance is a round trip: a store the Node engine
wrote opens in Rust, Rust appends, the Node engine reads the result — on Linux, macOS and Windows.

**Depends on.** RE-01 (types: `MemoryRow` fields come from the schema; `VectorSpaceIdentity`; `StoreError` is RE-01's
variant shell, filled here). **Enables.** RE-03 (identity fixture), RE-04, RE-05, RE-07.

**Assumes.** RE-D3 (keep LanceDB at the Node package's Lance version; no migration). If the owner picks a different
store, T2–T3 are replaced by the migration brief the owner commissions; T4–T7 stay.

**Read first.**
- Plan §1.4 (stores and files), §2.4, RE-2 in §4, risk RE-R3.
- Engine at `98dfe2f`: `lib/db-adapter.js` (1,503 lines; `TABLE_NAME = "memories"` at line 42, the queries and filters
  the pipeline issues), `engine/store/memory-db.js` (1,639 lines; the seed row at line 772 that defines the 69 columns,
  `_embedding_identity` at 853, read-only and trusted-path rules), `engine/store/schema-version.js`
  (`STORE_SCHEMA_VERSION = "1"`, legacy `"0"`), `engine/store/agent-db-pool.js` (493; one connection per agent table),
  `engine/stores/adopt.js` (635; what `stores.adopt` checks), `lib/multi-namespace-pool.js` (576; the `namespaces`
  routes), `lib/embedding-cache.js:213`, `lib/llm-result-cache.js:381`, `lib/speaker-mapping-store.js:45` (the three
  DDLs), `lib/neo-arch.js:2748-2945` (`vectors.<gen>.f32`, `vector-index.json`, generations) and its
  `turn-journal.jsonl` writer, `lib/tombstone.js` (595), `lib/job-lock.js` (76 — the mtime lock this brief replaces),
  `lib/epistemic-status.js` and `lib/valid-time.js` (the meaning of `epistemicStatus`, `validFrom`, `validUntil`).
- Harness: `crates/plur1bus/src/supervisor/adopt.rs` (`Peer`: the pid-plus-start-time identity rule, ADR-012 §10.2),
  `crates/plur1bus-rpc/src/acl.rs` (Windows ACL), the junction refusal the extension code uses (search
  `crates/plur1bus/src/ext` for the reparse-point check; reuse through a shared module, never copy),
  `docs/host-contract.md` (f.4, f.5, f.9, f.14, f.15).
- `lancedb` crate docs for the pinned version (RE-00 recorded it): `connect`, `open_table`, `create_table`,
  `vector_search`, `only_if`/filter syntax, `add`, `update`, `delete`, `count_rows`.

**Rules that apply.** The on-disk format is defined by what the Node engine wrote, never by this brief's prose: T1 reads
the schema from a real store. No format change, no new column, no new file in Phase 1. Writes are atomic (temp file +
rename, directory fsync) for every JSON/JSONL/state file. Paths pass the trusted-path check `memory-db.js` applies
(`_assertTrustedPath`).

**Modules added by the 2026-10-23 audit** (rows owned by RE-02 in [`MODULE-MAP.md`](MODULE-MAP.md); the brief is complete
when each has a Rust module, a fold target or a recorded drop): `lib/registry-lock.js` (496 — the one cross-process lock
behind `tombstone.js`, `neo-arch.js`, `import-lock.js`, `rebind-ledger.js`, `knowledge-pending.js` and `job-lock.js`: T6
ports it as the one `Lock` type), `lib/namespace-config.js` (185 — `NAMESPACE_PATTERN`, the namespace layout),
`lib/lancedb-optimize.js` (65 — the compaction policy → `Store::optimize`), `lib/tombstone-write-guard.js` (58),
`lib/sql-safety.js` (205 — LanceDB filter quoting → `RowFilter` rendering, T2), `lib/filter-parser.js` (305 — the list filter
grammar `db-adapter.js` uses → the `RowFilter` parser, T2), `lib/score.js` (distance → score), `engine/checkpoint/checkpoint-store.js`
(56). Folds: `lib/atomic-file.js`, `lib/atomic-json.js`, `lib/fsync-atomic.js` → one `atomic_write` (unique tmp, fsync, rename,
directory fsync); `lib/jsonl-utils.js` → `JsonlLedger`; `lib/bounded-cache.js`; `lib/directory-capability.js` (the probe at
store open); `lib/verified-path-directory.js` (397 — T3's trusted paths follow module-api `securePath`'s rules).

## Files

- Create: `src/store/{mod,lance,row,filter,sqlite,neo_files,ledger,state_file,lock,schema_version,paths}.rs`,
  `tests/fixtures/store-v1/` (the Node-written fixture, T1), `tests/fixtures/store-v1/make.mjs`, `tests/fixtures/store-v1/schema.txt`,
  `tests/fixtures/sqlite/{embeddings,llm_results,speaker_mappings}.sqlite` and `make.mjs`, `tests/fixtures/neo-v1/`,
  `tests/store_roundtrip.rs`, `tests/store_sqlite.rs`, `tests/store_neo.rs`, `tests/store_locks.rs`,
  `tests/node/roundtrip-check.mjs` (the Node side of the round trip), `docs/engine-stores.md`
- Modify: `crates/plur1bus-engine/Cargo.toml` (`arrow` at the version `lancedb` requires, `sha2` for digests if not
  already present), `AGENTS.md` ("Where things live" row: add the store module list), `docs/ci.md` only if the
  round-trip test needs a job change (it should not: `unit (ubuntu-24.04)` has the engine installed)
- Test: the four Rust test files, the fixtures

## Interfaces

**Consumes:** RE-01 types `MemoryRow` (generated from the schema's `MemoryRow` definition — write that definition in
RE-01 from the 69 seed-row columns; the `vector` column is `Vec<f32>`), `VectorSpaceIdentity`, `StoreError`,
`EngineConfig.namespaces`, `baseDbPath`.

**Produces:**

```rust
// src/store/lance.rs
pub enum OpenMode { ReadWrite, ReadOnly }
pub struct Store { /* connection, table, identity, schema_version, mode, path */ }
impl Store {
    /// Opens `<base>/<agentId>` (or a named namespace table). ReadWrite refuses an identity that differs from
    /// `expected` with StoreError::IdentityMismatch; ReadOnly opens regardless and reports it in identity_status().
    pub fn open(path: &Path, mode: OpenMode, expected: Option<&VectorSpaceIdentity>) -> Result<Store, StoreError>;
    pub fn create(path: &Path, identity: &VectorSpaceIdentity, dim: usize) -> Result<Store, StoreError>;
    pub fn identity(&self) -> Option<&VectorSpaceIdentity>;
    pub fn identity_status(&self) -> IdentityStatus;            // Verified | Missing | Mismatch { found }
    pub fn schema_version(&self) -> SchemaVersion;              // Legacy0 | V1
    pub fn search(&self, vector: &[f32], limit: usize, filter: &RowFilter) -> Result<Vec<Scored<MemoryRow>>, StoreError>;
    pub fn get(&self, id: &str) -> Result<Option<MemoryRow>, StoreError>;
    pub fn scan(&self, filter: &RowFilter, limit: usize) -> Result<Vec<MemoryRow>, StoreError>;
    pub fn count(&self, filter: &RowFilter) -> Result<usize, StoreError>;
    pub fn upsert(&self, rows: &[MemoryRow]) -> Result<(), StoreError>;    // visible only after the Lance commit
    pub fn patch(&self, id: &str, patch: &RowPatch) -> Result<(), StoreError>;
    pub fn delete(&self, ids: &[&str]) -> Result<usize, StoreError>;
}
pub struct Scored<T> { pub row: T, pub distance: f32 }
pub struct RowFilter { pub agent_id: Option<String>, pub scope: Option<MemoryScope>, pub status: Option<String>,
    pub workspace_id: Option<String>, pub owner_user_id: Option<String>, pub memory_kind: Option<String>,
    pub valid_at: Option<i64>, pub ids: Option<Vec<String>>, pub since: Option<i64>, pub until: Option<i64> }
pub struct RowPatch { /* Option<T> per patchable column; None = unchanged */ }

// src/store/sqlite.rs — DDL strings copied verbatim from the three Node files
pub struct EmbeddingCache; impl EmbeddingCache { pub fn open(path: &Path) -> Result<Self, StoreError>;
    pub fn get(&self, key: &CacheKey) -> Result<Option<CachedVector>, StoreError>;
    pub fn put(&self, key: &CacheKey, vector: &[f32], expires_at: i64) -> Result<(), StoreError>;
    pub fn sweep_expired(&self, now: i64) -> Result<usize, StoreError>; }
pub struct LlmResultCache;  // open/get/put/sweep_expired over `llm_results`, key_hash + purpose + model
pub struct SpeakerMappings; // open/list(agent)/upsert/confirm over `speaker_mappings`

// src/store/neo_files.rs
pub struct NeoFiles; impl NeoFiles { pub fn open(dir: &Path) -> Result<Self, StoreError>;
    pub fn generation(&self) -> Result<Generation, StoreError>;                 // generation.json
    pub fn read_vectors(&self, gen: &Generation) -> Result<Vec<(String, Vec<f32>)>, StoreError>;  // vectors.<gen>.f32 + vector-index.json
    pub fn write_generation(&self, gen: &Generation, vectors: &[(String, Vec<f32>)]) -> Result<(), StoreError>;
    pub fn append_turn(&self, line: &TurnJournalLine) -> Result<(), StoreError>; }

// src/store/ledger.rs, state_file.rs
pub struct JsonlLedger<T>; // open(path), append(&T) (one line, fsync policy as Node), iter() -> impl Iterator<Item = Result<T>>
pub struct StateFile<T>;   // load(path) -> Option<T>, store(path, &T) atomic (temp + rename + dir fsync)

// src/store/lock.rs — fixes f.4 and f.5
pub struct JobLock; impl JobLock {
    /// Acquires `<dir>/<name>.lock`. The lock file holds { pid, startedAt, heartbeatAt, host }. A lock whose owner's
    /// pid+startedAt no longer identifies a live process is stale and taken over; one whose heartbeat is older than
    /// `stale_after` is stale too. Never "EPERM means alive" (f.4), never mtime alone (f.5).
    pub fn acquire(dir: &Path, name: &str, stale_after: Duration) -> Result<LockGuard, LockBusy>; }
```

## Tasks

### T1 — The fixture store and the pinned Arrow schema (one pull request)

- [ ] **Step 1: write `tests/fixtures/store-v1/make.mjs`.** From `packages/core` (engine installed), create a
  temporary home, run the pinned engine with the flat embedder (dimension 384, see `packages/core/src/bin.ts` for the
  `testInternals` shape; set `engine.duplicateThreshold = 1.01` so twelve distinct rows survive the duplicate check),
  capture twelve deterministic turns for two agents (`a1`: 6 agent-private, 2 workspace; `a2`: 2 user, 1 archived via
  `memory.forget`, 1 reminder kind with `remindAt` set), then copy `<home>/<lancedb dir>` to `tests/fixtures/store-v1/`.
  Print the Arrow schema with the Node SDK (`table.schema()`) to `schema.txt` and the identity row to `identity.json`.
  The script is deterministic (fixed texts, fixed timestamps through the engine's clock port) so a re-run produces the
  same rows. Keep the folder under 1 MB; print its size at the end.
- [ ] **Step 2: write the failing test** `tests/store_roundtrip.rs::the_fixture_opens_and_lists_twelve_rows`: opens the
  fixture read-only, asserts `schema_version() == V1`, `identity_status() == Verified` with `expected = identity.json`,
  `count(&RowFilter::default()) == 12`, and that the Arrow schema `Store::arrow_schema()` printed as text equals
  `schema.txt` (this pins the 69 columns and their Arrow types from the real file, not from a list).
- [ ] **Step 3: run** — FAIL (no module).
- [ ] **Step 4: implement `Store::open`/`arrow_schema`/`count`/`scan`/`get`** over `lancedb` (connect to the
  directory, open `memories`, read `_embedding_identity`), `MemoryRow` ↔ `RecordBatch` conversion generated from the
  schema in `schema.txt` (a `build.rs` step or a committed `row.rs` with a test that it matches `schema.txt` — pick the
  committed file plus test).
- [ ] **Step 5: run** — PASS. **Commit** `RE-02/T1: fixture store and pinned Arrow schema`.

### T2 — Search, filters, writes and the round trip (one pull request)

- [ ] **Step 1: failing tests:** `search_orders_by_distance_and_honours_the_filter` (flat vectors: the fixture's
  rows all share one vector, so add two rows with distinct vectors in the test through `upsert` and assert order),
  `a_write_is_visible_only_after_commit` (open a second `Store` handle, write through the first, the second sees the row
  only after `upsert` returns), `read_only_refuses_writes`, `an_identity_mismatch_refuses_read_write_and_allows_read_only`.
- [ ] **Step 2: implement** `search` (vector search with `limit`, `RowFilter` rendered to the Lance filter expression —
  the same predicates `lib/db-adapter.js` renders; copy its column names and comparison semantics, including
  `status = 'active'`, scope and owner, `validFrom <= t AND (validUntil = 0 OR validUntil > t)`), `upsert` (merge insert
  on `id`), `patch`, `delete`.
- [ ] **Step 3: the Node side.** `tests/node/roundtrip-check.mjs <store dir> <expected count>` opens the store with the
  pinned Node engine's `MemoryDB`/db-adapter (read how `engine/store/memory-db.js` opens an existing table) and prints
  `{ count, ids }`. `tests/store_roundtrip.rs::rust_appends_and_node_reads_them_back`: copy the fixture to a temp dir,
  `upsert` five rows from Rust, spawn `node tests/node/roundtrip-check.mjs <dir> 17` with `cwd = packages/core`, assert
  exit 0 and the five ids in its output. When the engine package is missing the test fails with
  "run pnpm test:prep (the engine package is not installed)".
- [ ] **Step 4: the other direction.** `make.mjs --append <dir>` appends five rows through the Node engine; the Rust
  test `node_appends_and_rust_reads_them_back` then counts 22. Both directions run in `unit (ubuntu-24.04)`; the
  macOS and Windows legs run them in `unit-os` (not gating, but read their result in the PR).
- [ ] **Step 5: commit** `RE-02/T2: search, filters, writes, Node round trip`.

### T3 — Identity table, schema version, trusted paths (one pull request)

- [ ] **Step 1: failing tests:** `create_writes_the_identity_row_the_node_engine_expects` (create a store from Rust,
  `roundtrip-check.mjs` reports `identityStatus: "verified"` for it), `a_legacy_store_without_version_reports_legacy0`,
  `a_symlinked_store_directory_is_refused` (Unix) / `a_junction_store_directory_is_refused` (Windows).
- [ ] **Step 2: implement** `create`, `schema_version` (the marker `schema-version.js` writes — read it), the
  trusted-path rule (`_assertTrustedPath` in `memory-db.js`: no symlink in the path, Windows junction counts as symlink,
  f.15), and the Windows ACL on created directories through `crates/plur1bus-rpc/src/acl.rs` (f.9).
- [ ] **Step 3: commit** `RE-02/T3: identity, schema version, trusted paths`.

### T4 — SQLite caches with identical DDL (one pull request)

- [ ] **Step 1: fixtures.** `tests/fixtures/sqlite/make.mjs` creates the three databases through the Node modules
  (`lib/embedding-cache.js`, `lib/llm-result-cache.js`, `lib/speaker-mapping-store.js`) with two rows each; commit the
  `.sqlite` files (a few KB).
- [ ] **Step 2: failing tests** `tests/store_sqlite.rs`: `rust_creates_the_same_tables_and_indexes` (`PRAGMA
  table_info` and `PRAGMA index_list` of a Rust-created database equal the fixture's, column by column, including the
  legacy camelCase columns of `speaker_mappings`), `rust_reads_node_rows_and_node_reads_rust_rows` (through
  `roundtrip-check.mjs --sqlite`), `sweep_expired_removes_only_expired_rows`.
- [ ] **Step 3: implement** with `rusqlite` (bundled), DDL strings copied verbatim, prepared statements cached per
  connection, `key_hash` computed exactly as the Node code computes it (read `embedding-cache.js`'s key function; the
  parity test uses a recorded key).
- [ ] **Step 4: commit** `RE-02/T4: SQLite caches`.

### T5 — neo files, ledgers, state files (one pull request)

- [ ] **Step 1: fixture** `tests/fixtures/neo-v1/` written by the Node engine (`make.mjs --neo`): one generation with
  three vectors, a `turn-journal.jsonl` with four lines, `record-index.json`, `generation.json`.
- [ ] **Step 2: failing tests** `tests/store_neo.rs`: `vectors_read_back_equal_the_json_sidecar`,
  `a_generation_written_by_rust_is_read_by_node` (through `roundtrip-check.mjs --neo`), `append_turn_adds_one_line_and_keeps_the_file_valid_jsonl`,
  `state_file_store_is_atomic` (kill the process between temp write and rename — simulate with a seam that returns
  before rename — and the old file is intact).
- [ ] **Step 3: implement** `NeoFiles`, `JsonlLedger<T>`, `StateFile<T>`; the ledger line shapes come from the
  fixture lines (define one serde struct per ledger file under `src/store/ledger_types.rs`, one test each that the
  fixture line round-trips).
- [ ] **Step 4: commit** `RE-02/T5: neo files, ledgers, state files`.

### T6 — Locks (one pull request)

- [ ] **Step 1: failing tests** `tests/store_locks.rs`: `a_second_acquire_in_the_same_process_is_busy`,
  `a_lock_of_a_dead_pid_is_taken_over`, `a_lock_of_a_live_pid_with_a_recycled_start_time_is_taken_over` (write a lock
  file naming the test's own pid with a wrong `startedAt`), `a_stale_heartbeat_is_taken_over_even_with_a_live_pid`,
  `the_heartbeat_advances_while_held`.
- [ ] **Step 2: implement `JobLock`** with the identity rule of `supervisor/adopt.rs` (expose that rule from a shared
  place — a small module in `crates/plur1bus-rpc` or a new `crates/plur1bus-proc` — rather than copying it; say which
  in the PR).
- [ ] **Step 3: commit** `RE-02/T6: job locks with process identity`.

### T7 — Documentation (folded into T6's pull request)

- [ ] `docs/engine-stores.md`: the table of plan §1.4 made normative (file, owner module, format, compatibility rule),
  the Lance upgrade rule (any bump of the `lancedb` crate repeats T2's round trip against the Node package still in use;
  a failure means a store migration and a `STORE_SCHEMA_VERSION` bump — never a silent upgrade), the fixture
  regeneration commands, the lock file format. Link it from `docs/engine-extraction.md`'s store section and from
  AGENTS.md's crate row.

## Acceptance

- All tests of this brief green on `unit (ubuntu-24.04)`; the `unit-os` legs' results read and quoted in the T2 PR.
- The fixture folder is under 1 MB and regenerable by the documented command; `schema.txt` has 69 columns plus the
  identity table's two.
- `docs/engine-stores.md` exists and `pnpm docs:check` (link check) is clean.
- No new licence finding (RE-00's gate re-run in T2's PR if `arrow` or `sha2` were added).

## Out of scope

Any recall or capture logic (RE-04, RE-05); `stores.adopt`'s report shape (RE-07, which uses `schema_version` and
`identity_status` from here); re-embedding generations (RE-07); the Lance version upgrade itself.

## Hand-off

Six PRs `RE-02/T1` … `RE-02/T6`. T1 and T2 first; T4–T6 can run in parallel with T3. The produced signatures are
consumed by RE-04/05/07 — a change after T2 merges needs the controller's agreement.
