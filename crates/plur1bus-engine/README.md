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

## Licence decisions

The Lance closure brings licences outside today's `deny.toml` allow-list (BSL-1.0, Zlib, MPL-2.0, 0BSD). The owner
decides them in the RE-00 pull request; this section records the decision once it is applied. Decision pending.
