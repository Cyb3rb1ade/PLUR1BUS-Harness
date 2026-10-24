# plur1bus-engine

The PLUR1BUS memory engine in Rust: the stores (LanceDB table `memories`, the SQLite caches, the working-memory files
and the ledgers), the embedding and rerank providers, the recall and capture pipelines and the background jobs, run as
one process under the harness supervisor (plan `docs/superpowers/plans/2026-10-23-rust-engine-rewrite.md` §2, briefs in
`docs/superpowers/plans/rust-engine/`). It replaces the pinned Node engine package step by step; until Phase 3 the
Node engine stays the default.

**State: RE-00 skeleton.** The crate declares its dependency set and the lint policy and implements no engine
behaviour. The modules of plan §2.4 arrive with RE-01 onwards.

## Targets

| Target | Name | What it is |
|---|---|---|
| library | `plur1bus_engine` | `CRATE_VERSION` only, for now |
| binary | `plur1bus-engine` | `--version`; the hidden placeholder `serve`, which RE-08 fills (`plur1bus-engine serve --home <dir> ...`). Today `serve` exits 2 with `E_NOT_AVAILABLE reason=not-implemented`; a usage error exits 2 (clap), as `docs/errors.md` says |

## Build and test

From the repository root, with the toolchain of `AGENTS.md` (Rust 1.95):

```bash
cargo build -p plur1bus-engine
cargo test -p plur1bus-engine
cargo clippy -p plur1bus-engine --all-targets -- -D warnings
```

The build needs **cmake and a C++ compiler**: `lance` is named with its `protoc` feature, which compiles the protobuf
compiler (`protobuf-src`) that lance-encoding, lance-file, lance-index and lance-table need in their build scripts,
so no `protoc` has to be installed. The first build compiles the Lance, DataFusion and Arrow closure (about 340
crates more than the rest of the workspace); the RE-00 pull request records the cold and warm times.

## Dependencies

| Crate | Version | Why |
|---|---|---|
| `lancedb` | `=0.26.2` | the store; the version the Node engine's committed lockfile resolves for `@lancedb/lancedb` (RE-D3), so both read and write the same Lance format (`lance` 2.0.0) |
| `lance` | `=2.0.0` | not used in code; named only for its `protoc` feature (see above) |
| `rusqlite` | `0.40`, `bundled` | the three SQLite caches (plan §1.4) |
| `jsonschema` | `0.26`, no default features | config and contract validation, the same validator `plur1bus-config` uses |
| `ureq` | `3`, `rustls` + `platform-verifier` | remote providers; the same HTTP client policy as `crates/plur1bus` |
| `serde`, `serde_json`, `clap` | workspace | data and the command line |

`ort` and `tokenizers` are added by RE-03 with their own gate step.

## Lints

The crate inherits the workspace lint table of `docs/coding-standard.md` §10 (`[lints] workspace = true`) and adds
`missing_docs`, `clippy::print_stdout` and `clippy::print_stderr` in `lib.rs`.

## Dependency decisions (PR #759)

Decided on 2026-10-24 in the RE-00 pull request (#759): the controller's recommendation, not objected to by the owner;
the owner can still veto any line in review.

### Licences

- **BSL-1.0**: allowed in `deny.toml` and `docs/dependency-policy.md` (OSI-approved, permissive; `xxhash-rust` via
  lance-encoding).
- **Zlib**: allowed in both (OSI-approved, permissive; `foldhash` 0.1.5 and 0.2.0, `zlib-rs`).
- **MIT-0**: allowed in both (MIT without the attribution requirement; `borrow-or-share` via jsonschema).
- **CDLA-Permissive-2.0**: allowed in both (permissive data licence of the Mozilla CA bundle; `webpki-roots`,
  `webpki-root-certs` via ureq).
- **0BSD**: added to `deny.toml`; `docs/dependency-policy.md` already listed it (`mock_instant` via lance-core).
- **MPL-2.0**: not allowed globally in `deny.toml`; one per-crate exception for `option-ext` (dirs-sys → dirs 6 →
  lance-index), matching the policy's "MPL-2.0 only unmodified" rule.

No entry in `docs/dependency-exceptions.json` or `audit-allowlist.json`.

### tantivy patch

`lance-index` 2.0.0 (pinned through `lancedb` 0.26.2, RE-D3) depends on `tantivy` 0.24.2, which pins `lru` 0.12; `lru`
0.12.5 carries two unsoundness advisories (RUSTSEC-2026-0002, RUSTSEC-2026-0253) with no 0.12.x fix, and the release
dependency audit blocks on them. The owner chose a fork over an advisory exception: `Cyb3rb1ade/tantivy`, branch
`plur1bus/0.24.2-lru-0.18.2`, commit `038215a5`, is upstream tag 0.24.2 with one changed line (`lru = "0.18.2"`);
tantivy's own version stays 0.24.2, and its store tests pass against lru 0.18. The root `Cargo.toml` replaces tantivy
with it through `[patch.crates-io]` (pinned by `rev`), and `deny.toml` allows the fork as a git source. **Exit
condition:** remove the patch when the Lance pin moves to a tantivy with lru >= 0.18.2 or to no tantivy at all.

### protoc

`lance` is named with its `protoc` feature, which builds the protobuf compiler from source (`protobuf-src`, cmake and a
C++ compiler), so no machine needs `protoc` installed. Cost: about six minutes of a cold build (the `protobuf-src` build
script ran 361 s, on the critical path). **Alternative, open as a follow-up:** install `protobuf-compiler` (apt, and its
equivalents on macOS and Windows) in every workspace-wide CI job, then drop the feature.

### Measured cost

- Local, 4 cores: cold `cargo build -p plur1bus-engine` 9 min 44 s (slowest: `protobuf-src` build script 361 s,
  `lance` 78.5 s, `datafusion` 42.0 s); warm rebuild after touching `lib.rs` 0.87 s. `opt-level = 3` for the heaviest
  lance, datafusion and arrow crates made their rebuild slower (854 s against 536 s), so no `[profile.dev.package.*]`
  entry exists.
- CI: `unit (ubuntu-24.04)` 20 min 45 s on `main` → 36 min 08 s on the PR's first run with a cold cache for the
  closure; its `cargo test --workspace` step 7 min 54 s → 16 min 26 s, which is why that step now has 30 minutes
  (`docs/ci.md`, "Core sharding and job budgets"; RE-R6).
