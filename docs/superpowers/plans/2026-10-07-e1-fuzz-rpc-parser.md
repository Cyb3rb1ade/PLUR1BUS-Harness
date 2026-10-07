# E1: fuzz and property tests for the line protocol and the JSON-RPC parsers

## Scope
No new fuzz framework in CI. Two seeded, deterministic generators (no new dependency):

- Rust, `crates/plur1bus-rpc/tests/fuzz_lines.rs`: a splitmix64 generator drives hostile response lines into the real `Client`
  over a Unix socket (random bytes, truncated UTF-8, deep nesting, duplicate keys, huge numbers, batches, responses
  without id, 4 MiB boundary). Invariant: `Client::call` returns `Ok` or a typed `RpcError`, never panics, never hangs.
  Memory bound: an endless line makes the client stop reading after `MAX_LINE + 1` bytes.
- TypeScript, `packages/module-api/test/framing-fuzz.test.ts`: a mulberry32 generator drives `LineDecoder`
  (arbitrary chunking, truncated UTF-8, depth, duplicate keys, huge numbers, 4 MiB limit) and the control server
  (batch, response-shaped input without id, garbage): never an uncaught exception, every bad line answered with a
  typed `error/-326xx` reply or a clean close.
- `fuzz/` + `docs/fuzzing.md`: a manually started `cargo-fuzz` entry (own workspace, not in CI) with one target
  that feeds bytes through the same line-and-JSON path the client uses.

`PLUR1BUS_FUZZ_SEED` / `PLUR1BUS_FUZZ_CASES` override seed and case count; the seed is printed on failure.

## Rulings
See the PR description.
