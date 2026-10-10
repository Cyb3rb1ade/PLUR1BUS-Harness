# Fuzz and property tests (E1)

## In CI (deterministic, no framework)

| Where | What |
|---|---|
| `crates/plur1bus-rpc/tests/fuzz_lines.rs` (unix) | Seeded splitmix64 generator sends hostile response lines to the real `Client`: random bytes, truncated UTF-8, nesting past the parser limit, duplicate keys, huge numbers, batches, responses without id, the exact 4 MiB boundary, an endless line. Invariant: `Ok` or a typed `RpcError`, no panic, no hang, read bounded by `MAX_LINE + 1`. |
| `packages/module-api/test/framing-fuzz.test.ts` | Seeded mulberry32 generator against `LineDecoder` (any chunking, every UTF-8 cut point, the limit, encode/decode round trip) and a real control server (hostile lines get a typed JSON-RPC error, a batch and a response-shaped message are `-32600`, an over-long line is `line-too-long`, the server keeps serving). |

`PLUR1BUS_FUZZ_SEED=<n>` and `PLUR1BUS_FUZZ_CASES=<n>` change seed and case count in both suites; a failing assertion
names the case and the seed, so a failure replays with the same two variables.

## cargo-fuzz targets (nightly workflow, manual runs)

`fuzz/` is its own Cargo workspace (excluded from the root one, with a committed `Cargo.lock`). A target body is a plain
function `plur1bus_fuzz::<name>::run(&[u8])` in `fuzz/src/`; `fuzz/fuzz_targets/<name>.rs` only wraps it in
`fuzz_target!`. Every target must never panic and asserts the invariant named below.

| Target | Code under test | Input | Invariants |
|---|---|---|---|
| `client_response_line` | `plur1bus_rpc::Client` against a unix-socket server replying with the input (Unix only) | raw reply bytes | `Ok` or typed `RpcError`; no panic, no hang, memory bounded by `MAX_LINE` |
| `rpc_message` | generated wire types of `plur1bus-rpc` (`Request`, `Response`, `Notification`, `ErrorObject`, `Id`, `Capabilities`, `JournalLine`, `CoreStatus`, `ExtInspection`), `RpcError`, `capabilities()` | selector byte + JSON | parse then serialise then parse is a fixed point |
| `config_parse` | `plur1bus-config` `parse` / `validate` / `serialize` / `revision` / `get` / `set` / `restart_plan` / tier helpers | `config.json` text, NUL, `key`, NUL, JSON value | a parsed config validates and round-trips; `set` never returns an invalid config |
| `backup_manifest` | `backup/manifest.rs` (`Manifest`, `validate`, `safe_rel`, `target_kind`, ...) and `backup/archive.rs` (`verify`: the tar.gz reader) | mode byte + raw manifest, raw file, gzip-wrapped tar, or a structured manifest and matching tar built with `arbitrary` | `safe_rel` never holds for an absolute, `..`, `.`, backslash, colon or NUL path; a validated manifest names only safe paths and round-trips; a verified archive yields a validated manifest |
| `install_manifest` | `install/manifest.rs` (`parse_install`, `parse_release`: the release manifest is what `update --check` reads) and `install/pins.rs` lookups | selector byte + JSON | an install manifest that parses round-trips |
| `ext_manifest` | `plur1bus-ext`: `parse_manifest`, `check_kind`, `check_compat`, `parse_skill_md`, `harness_req`, `url_host`, naming rules, `audit_zip` (central-directory parser) with `hash_entry` / `read_entry` | mode byte + manifest JSON, `SKILL.md`, text, or ZIP bytes | a manifest that parses round-trips; an audited ZIP lists only relative, non-traversing entry names within the limits |
| `log_record` | `plur1bus-log-schema` `validate_line` and `validate_audit_line` | mode byte + a line, or a catalogue example mutated by the rest of the input | an accepted line names a catalogue event, in the stream of the validator that accepted it |

The `plur1bus` crate is a binary without a lib target, so the backup and install parsers are compiled into the fuzz
crate by `#[path]` includes (`fuzz/src/backup.rs`, `fuzz/src/install.rs`): the real source files, unmodified, with
small stand-ins for `crate::audit::create_private`, `crate::paths::Layout` and `BackupError` (copied from
`backup/mod.rs`; if that type gains a field the include fails to compile, which is the signal to update the copy).
The update module exposes no parser that takes bytes (everything takes a `Layout`), so there is no separate update
target: the release manifest parser `update --check` uses is covered by `install_manifest`.

### Without nightly: `cargo test --manifest-path fuzz/Cargo.toml --test seeds --locked`

`fuzz/tests/seeds.rs` runs every target body over its seed corpus and 24 deterministic mutations of each seed
(seeded xorshift: bit flips, byte replacement, truncation, deletion, splices from another seed). It needs only the
stable toolchain and runs in the `seeds` job of the fuzz workflow. A mutant that panics is written to the temp
directory and named in the failure message.

### Running locally

Needs `rustup toolchain install nightly` and `cargo install cargo-fuzz --locked`. `rust-toolchain.toml` pins 1.95, so name the
toolchain explicitly:

```bash
cd fuzz
cargo +nightly fuzz run --locked config_parse corpus/config_parse seeds/config_parse -- \
  -dict=dicts/config_parse.dict -max_len=65536 -rss_limit_mb=2048 -timeout=10 -max_total_time=300
cargo +nightly fuzz run --locked client_response_line -- -max_len=5000000 -rss_limit_mb=1024 -timeout=10
```

`-s none` skips AddressSanitizer: these targets are safe Rust, and the instrumented build needs more disk.
A crash replays with `cargo +nightly fuzz run --locked <target> fuzz/artifacts/<target>/<file>`.

### Nightly workflow

`.github/workflows/fuzz.yml` runs at 02:43 UTC and on `workflow_dispatch` (input `seconds`, default 300): a `seeds`
job (stable, the test above), then one matrix job per target (`cargo +nightly fuzz run <target> -- -max_total_time=300`).
A crash fails that matrix leg and uploads `fuzz/artifacts/<target>/` as the artifact `fuzz-crash-<target>`.
The workflow is not a merge gate.

### Corpus policy

- `fuzz/seeds/<target>/` is committed: small (a few KiB each), hand-built or generated from real fixtures and
  catalogue examples, one file per behaviour (valid, hostile, truncated). The first byte of most inputs is the mode
  selector described in the source of each target. Keep the directory under about 500 KiB in total.
- `fuzz/dicts/<target>.dict` holds libFuzzer dictionary tokens.
- `fuzz/corpus/` (the evolving corpus) and `fuzz/artifacts/` are git-ignored and not cached between nightly runs: each
  run starts from the seeds. Add an input to `seeds/` only when it reaches code the existing seeds do not (check with
  `cargo +nightly fuzz coverage --locked`), and minimise it first with `cargo +nightly fuzz tmin --locked`.

### Handling a finding

1. Download the `fuzz-crash-<target>` artifact (or take `fuzz/artifacts/<target>/crash-*`), replay it, and minimise it
   with `cargo +nightly fuzz tmin --locked <target> <file>`.
2. Add a minimal regression test to the owning crate's tests directory, `#[ignore]`d and commented
   `// FUZZ FINDING: <what panics or which invariant breaks>`, so the repro is committed before the fix and the fix
   removes the `#[ignore]`.
3. Copy the minimised input into `fuzz/seeds/<target>/` once the fix has landed.
4. Fix the parser in a separate change. The fuzz package itself never changes parser logic.
