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
| library | `plur1bus_engine` | `CRATE_VERSION`, the `cache_profiles` table reader (RE-14/T1), and the unused `tokens` counting service (RE-14/T2) |
| binary | `plur1bus-engine` | `--version`; the hidden placeholder `serve`, which RE-08 fills (`plur1bus-engine serve --home <dir> ...`). Today `serve` exits 2 with `E_NOT_AVAILABLE reason=not-implemented`; a usage error exits 2 (clap), as `docs/errors.md` says |

## Build and test

`cache_profiles::CacheProfileTable::bundled()` embeds the provider-owned JSON table and validates it against
`packages/providers/schema/cache-profiles.schema.json`. Its `normalize_model_ref`, `find_cache_profile` and
`cache_route_for_url` methods follow the TypeScript provider loader; `rows()` and `openrouter()` expose validated
metadata through shared references. `tests/cache_profiles_parity.rs` checks the TypeScript-generated
`packages/providers/fixtures/cache-profile-vectors.json`, including route overrides and URL routing. No engine
runtime behavior consumes this module in Phase 1 (RE-R1).

### Token counting (RE-14/T2)

`tokens::TokenCounter::heuristic()` exposes the table's tokenizer families without reading files.
`TokenCounter::from_directory(&path)` verifies the pinned files listed in `src/tokens/artifacts.json`, then loads
them once. `count(&CountRequest)` performs no file or network I/O. Missing or damaged artifacts remain explicit
family states and return `heuristic`; `families()` distinguishes missing, invalid, hash-mismatched, unconfigured,
and license-pending artifacts. Gemma 3 and Grok remain estimators without owner approval (RE-D25).

A request selects exactly one `family` or `route` and independent `items`, each with an `id` and exactly one of
`text`, `messages` or `tools`. The shared table resolves a route's model/platform to its tokenizer family.
For a `chatgpt-plan` route, its generic o200k cache row is checked against the same model's first-party row:
an `openai-unpublished` model (such as GPT-6) stays heuristic on the plan too (RE-D20). Explicitly selecting
`family: "o200k"` still requests the exact raw-text encoding of that family.
Every result exposes `family`, `method`, `calibration: { version: 1, observations: 0 }`, and
`items: [{ id, tokens, lower, upper }]`. The methods are:

- `exact`: raw-text tokenization with a SHA-verified artifact, without added special tokens, padding or truncation.
- `tokenizer-text`: visible message/tool text only; provider chat-template framing is unknown and is not counted as exact.
- `heuristic`: the existing Core estimate, `ceil(UTF-16 code units / 4)`, with conservative visible-text bounds
  from zero to the UTF-8 byte count. These bounds do not claim to include hidden provider framing.

Message boundaries stay independent. Adjacent segments within a message are joined before encoding; optional
`cumulative: true` returns a recount of each joined segment prefix, reset at the next message. Counts are not
assumed additive across BPE segment boundaries. Message inputs have the shape
`[{ role, segments: [{ text }] }]`; cumulative output is
`[{ id, message, counts: [{ tokens, lower, upper }] }]`, where `message` is the zero-based message index.
T3 adds calibration, T4 adds RPC, and T5 adds Core consumers;
none is implemented here, and the Phase 1 engine keeps its existing budgets and prompt behavior (RE-R1).

Install the separately fetched, pinned tokenizer files in a cache outside the checkout, then require them in tests:

```bash
export PLUR1BUS_TOKENIZER_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/plur1bus/tokenizers"
node scripts/tokens/setup-tokenizers.mjs
PLUR1BUS_TOKENIZER_FILES_REQUIRED=1 cargo test --locked -p plur1bus-engine
cargo run --locked -p plur1bus-engine --example token_count_measure
```

CI sets `PLUR1BUS_TOKENIZER_FILES_REQUIRED=1`; a missing, corrupt or incompatible listed artifact fails its Golden
test instead of silently omitting the reference count. The setup verifies source and output hashes on download and
re-verifies cached files. It never grants license approval. The committed count and token-ID Goldens, original
DE/EN/code/JSON/Unicode texts, recorder, source pins and license evidence are documented in
[`tests/engine-parity/goldens/tokens/README.md`](../../tests/engine-parity/goldens/tokens/README.md).

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
| `regex` | `1` | compiled cache-profile model and host patterns; reuses the locked workspace dependency (MIT OR Apache-2.0) |
| `url` | `2` | WHATWG URL hostname parsing for provider-route parity; reuses the locked workspace dependency (MIT OR Apache-2.0) |
| `tokenizers` | `=0.23.2`, no default features, `fancy-regex` | raw-text tokenization (Apache-2.0), with the pure-Rust regex backend (RE-D19); reference token IDs gate compatibility |
| `sha2` | `0.10` | artifact integrity before tokenizer loading; reuses the locked MIT OR Apache-2.0 dependency |
| `ureq` | `3`, `rustls` + `platform-verifier` | remote providers; the same HTTP client policy as `crates/plur1bus` |
| `serde`, `serde_json`, `clap` | workspace | data and the command line |

`ort` is added by RE-03 with its own gate step; RE-03 reuses the pinned tokenizer implementation and adds its
embedding/reranker-specific token-ID gates.

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

**Windows (MSVC).** `protobuf-src` 2.1.1+27.1 vendors protobuf 27.2, whose CMake build compiles protobuf, upb,
utf8_range and `protoc` against the static C runtime (`protobuf_MSVC_STATIC_RUNTIME`, default ON) and the bundled abseil
against the DLL runtime (abseil's own `ABSL_MSVC_STATIC_RUNTIME`, default OFF), so `protoc.exe` did not link: LNK2038
(`RuntimeLibrary` mismatch, `MDd_DynamicDebug` against `MTd_StaticDebug`) and unresolved `__imp_*` CRT symbols in
`unit (windows-2025)` (run 40133657878, PR #766). No `protobuf-src` release fixes it (2.1.1 is the latest). The
repository's `.cargo/config.toml` sets `CMAKE_TOOLCHAIN_FILE_x86_64_pc_windows_msvc` and
`CMAKE_TOOLCHAIN_FILE_aarch64_pc_windows_msvc`, which the `cmake` crate passes on as `-DCMAKE_TOOLCHAIN_FILE`, to
[`cmake/protobuf-msvc-crt.cmake`](cmake/protobuf-msvc-crt.cmake); that file sets only
`protobuf_MSVC_STATIC_RUNTIME=OFF`, so every target uses the DLL runtime (`/MDd` in Debug, `/MD` in Release), the one
the `cmake` crate asks for (`-MD`). A build for any other target never reads these two variables, and the lockfile does
not change; `tests/msvc_crt.rs` keeps both entries and the file intact on runners that never build for Windows. A fork
of `protobuf-src` with the same `.define` in its `build.rs` would work too, but it would move the crate to a git source
on every platform (lockfile, `deny.toml`, third-party notices) and add a repository to maintain. CMake takes a
toolchain file only when it first configures a build tree, so a tree left by an earlier Windows build without the file
keeps failing: run `cargo clean -p protobuf-src` once. **Exit condition:** remove the file, both entries and the test
when the vendored protobuf passes its choice on to abseil itself, or when the feature goes.

### Measured cost

- Local, 4 cores: cold `cargo build -p plur1bus-engine` 9 min 44 s (slowest: `protobuf-src` build script 361 s,
  `lance` 78.5 s, `datafusion` 42.0 s); warm rebuild after touching `lib.rs` 0.87 s. `opt-level = 3` for the heaviest
  lance, datafusion and arrow crates made their rebuild slower (854 s against 536 s), so no `[profile.dev.package.*]`
  entry exists.
- CI: `unit (ubuntu-24.04)` 20 min 45 s on `main` → 36 min 08 s on the PR's first run with a cold cache for the
  closure; its `cargo test --workspace` step 7 min 54 s → 16 min 26 s, which is why that step now has 30 minutes
  (`docs/ci.md`, "Core sharding and job budgets"; RE-R6).
