# Fuzz and property tests (E1)

## In CI (deterministic, no framework)

| Where | What |
|---|---|
| `crates/plur1bus-rpc/tests/fuzz_lines.rs` (unix) | Seeded splitmix64 generator sends hostile response lines to the real `Client`: random bytes, truncated UTF-8, nesting past the parser limit, duplicate keys, huge numbers, batches, responses without id, the exact 4 MiB boundary, an endless line. Invariant: `Ok` or a typed `RpcError`, no panic, no hang, read bounded by `MAX_LINE + 1`. |
| `packages/module-api/test/framing-fuzz.test.ts` | Seeded mulberry32 generator against `LineDecoder` (any chunking, every UTF-8 cut point, the limit, encode/decode round trip) and a real control server (hostile lines get a typed JSON-RPC error, a batch and a response-shaped message are `-32600`, an over-long line is `line-too-long`, the server keeps serving). |

`PLUR1BUS_FUZZ_SEED=<n>` and `PLUR1BUS_FUZZ_CASES=<n>` change seed and case count in both suites; a failing assertion
names the case and the seed, so a failure replays with the same two variables.

## Manual: cargo-fuzz (not in CI)

`fuzz/` is its own Cargo workspace (excluded from the root one). It needs a nightly toolchain and `cargo install cargo-fuzz`.

```bash
cd fuzz
cargo +nightly fuzz run client_response_line -- -max_len=5000000 -rss_limit_mb=1024 -timeout=10
```

Corpus and artifacts land under `fuzz/corpus/` and `fuzz/artifacts/` (git-ignored). A crash input replays with
`cargo +nightly fuzz run client_response_line fuzz/artifacts/client_response_line/<file>`; turn a real finding into a
case in `tests/fuzz_lines.rs`.
