# M8 backup / restore (`plur1bus backup create|verify|restore`)

**Goal.** One consistent, checksummed, private archive of a PLUR1BUS installation, and a restore that is atomic per
unit, keeps what it replaces, and leaves the old state untouched when it fails. Source: `docs/milestones.md` §M8
(scope: "Backup/restore with dry-run, **stores first** then config, users, sessions, then the dream ledger";
acceptance 4), D78 / ADR-001 amendment (snapshot → migrate → health gate), ADR-005 (no plaintext secrets in backups),
ADR-009 §11 (backup order: stores first, then the dream ledger).

**Effort.** 2–4 ad.

## Findings that shape the design

1. **The pinned engine (`6868b7b`, contract 1.12) has no snapshot method on `Engine.admin`.** What exists is the
   engine package's own Node module `lib/snapshot/store-snapshot.js` (HM1-R8: `createSnapshot`, `verifySnapshot`,
   `listSnapshots`; `node:` builtins only; shipped in the package's `files`; a LanceDB-aware copy that re-checks the newest
   table manifest and retries three times, then `source-busy`). The task asked for "engine snapshots via `admin.*`";
   the *harness* surface for that is new: **`admin.backup.snapshot`** (RPC, `x-server: core`, experimental), a thin core
   binding of that module. Nothing copies LanceDB files in Rust. See ruling R1.
2. The harness owns **no durable SQLite database** at this commit (`state/core.lock` is a lock, not data). The SQLite
   backup API (`node:sqlite` `backup()`) therefore lives in the same core handler and is exercised by a fixture
   database in tests; the day a harness DB appears under `state/`, it is picked up without a format change (R6).
3. **Users, sessions, vault** do not exist as harness state yet (M4/M5). The **dream ledger** and the engine's memory
   run state live under `state/memory/` and are captured by the engine snapshot. The manifest lists every unit it
   includes *and every known unit that was absent*, so adding units later never changes the format's meaning (R8).
4. Restore needs the core **stopped**; the core's SQLite lock (`state/core.lock`) and the supervisor/core probes are the
   existing truth for that (`supervisor::adopt::probe_core`).

## Archive format `plur1bus.backup/1`

A `tar.gz`; the first entry is `manifest.json`, then `data/<archive-path>` entries. Manifest:

```json
{ "schema": "plur1bus.backup/1", "createdAtMs": 1791298800000, "harness": { "version": "…" }, "platform": { "os": "…", "arch": "…" },
  "engine": { "contract": "1.12.0", "storeSchema": "1" }, "storeTarget": "state/lancedb",
  "units": [ { "archive": "store", "target": "state/lancedb", "kind": "dir" }, … ],
  "absent": [ "state/memory/run-state.json" ], "dirs": [ "agents/bernd/workspace" ], "skipped": [],
  "files": [ { "path": "store/…", "bytes": 12, "sha256": "…" }, … ],
  "secrets": { "included": false, "note": "…" } }
```

Units (allow-list; nothing else can enter an archive or be written by a restore): `config.json`, `agents/`, `skills/`,
`modules/`, `extensions/`, `catalog/`, `state/journal/`, `state/system-jobs/`, `state/lancedb/` (← engine `store/`),
`state/memory/{_archive,run-state.json,merge-proposals.jsonl}` (← engine snapshot), `state/**/*.sqlite|db|sqlite3`
(← SQLite backup API). Never: `run/` (tokens, sockets), `logs/`, `runtime/`, `models/`, `backups/`, `state/core.lock`.

## Commands

- `backup create [--out <file>] [--dry-run]` — needs a running core (`admin.backup.snapshot`); stages the engine/SQLite
  parts in `<home>/state/backup-staging/<id>` (core) and the plain units by point-in-time copy (CLI, per-file retry on
  change), hashes while packing, writes the archive private (0600 / user+SYSTEM DACL via `audit::create_private`),
  re-verifies it, removes staging. Default `--out`: `<home>/backups/plur1bus-backup-<UTC>.tar.gz`.
- `backup verify <file>` — streams the whole archive: manifest schema, unsafe paths, entry set == manifest set, sizes,
  SHA-256 of every file. Any failure exits 1 with a reason (`archive-corrupt`, `manifest-invalid`, `checksum-mismatch`,
  `unexpected-entry`, `missing-entry`, `unsafe-path`, `unsupported-format`, `truncated`).
- `backup restore <file> [--dry-run] [--yes]` — verify → refuse when a core/supervisor answers or `state/core.lock` is
  held (`E_LOCKED reason=core-running`) → extract into `<home>/.restore-<id>/` (re-hashing while writing) → swap each
  unit by rename, the displaced tree going to `<home>/backups/pre-restore-<id>/` (the automatic pre-restore backup) →
  on any failure roll the already-swapped units back and report; the old state is intact. `--dry-run` prints the plan
  (units to replace / remove, versions) and touches nothing.

## Rulings (the owner can overturn any; each is also a `// RULING:` in code)

- **R1** Use the engine's `store-snapshot.js` via a new core RPC rather than a Rust copy; an engine PR adding
  `engine.admin.snapshot` would replace the deep import (Open point).
- **R2** The CLI (Rust) builds, verifies and restores the archive; the core only stages what needs Node/engine.
- **R3** Checksums detect corruption, **not tampering**: the archive is not signed or encrypted.
- **R4** No secrets in the archive. The allow-list excludes `run/` and every credential location; the keyring is not
  read; the encrypted fallback file does not exist yet, so nothing of it is included, and the CLI says so on create.
- **R5** The "pre-restore backup" is the displaced directory tree (zero-copy, atomic, same volume), not a second
  archive: with the core stopped there is no engine to snapshot through.
- **R6** SQLite databases under `state/` are backed up with the SQLite backup API in the core, never file-copied.
- **R7** `create` fails closed with `E_CORE_UNAVAILABLE` when no core runs (the snapshot needs the engine).
- **R8** A store whose base path is configured outside the home is refused (`store-outside-home`), not guessed.
- **R9** Restore refuses an archive of a newer format major; a different harness version is reported, not blocked
  (store migration remains `admin migrate`'s job, ADR-013/D78).

## Files

New: `crates/plur1bus/src/backup/{mod,manifest,archive,create,restore}.rs`, `crates/plur1bus/src/commands/backup.rs`,
`packages/core/src/backup-ops.ts`, `crates/plur1bus/tests/backup.rs`, `tests/system/backup.test.ts`,
`packages/core/test/backup-ops.test.ts`. Shared, minimal: `packages/rpc-schema/schema/rpc.schema.json` (one method),
`packages/core/src/core.ts` (wiring), `crates/plur1bus/src/{cli,main}.rs`, `commands/mod.rs`, `AGENTS.md`,
`docs/milestones.md` (status line), generated docs.

## Tasks → acceptance

| # | Task | Acceptance | Test |
|---|---|---|---|
| 1 | RPC `admin.backup.snapshot` + core handler (engine snapshot, SQLite backup API, verify) | a staging dir whose files match their digests; a fixture SQLite DB is backed up consistently; the call refuses while stopping | `packages/core/test/backup-ops.test.ts` |
| 2 | Archive writer/reader + manifest (checksums, private mode, safe paths) | verify accepts a good archive; refuses flipped byte, truncation, tampered manifest, extra/missing entry, `..`/absolute path, symlink entry | `crates/plur1bus/tests/backup.rs` (+ unit tests) |
| 3 | `backup create` | archive contains the units and no `run/` token; mode 0600; `--dry-run` writes nothing | `tests/backup.rs` |
| 4 | `backup restore` | refuses with a core up; dry-run touches nothing; success swaps units and keeps the pre-restore tree; injected failure at each step leaves the old state byte-identical | `tests/backup.rs` (`PLUR1BUS_TEST_BACKUP_FAIL_AT`) |
| 5 | Round trip on a real core | create → mutate → stop → restore → start gives identical recall results | `tests/system/backup.test.ts` |
| 6 | Docs | `docs/operations.md`/AGENTS.md rows, generated docs, milestones status | `pnpm docs:check` |
