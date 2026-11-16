# RY-B2 capture baseline

Apple Silicon, macOS, Release binaries, Node 24.21.0. Each engine used a fresh home
and the flat embedder. CLI timing starts just before launching `memory add` and
ends once the CLI returns a stored result. Two captures warm each engine before
the 20-sample median.

| Engine | Median |
|---|---:|
| Node | 76.3 ms |
| Rust | 704.7 ms |
| Rust / Node | 9.24× |

The 1.5× target has not been met. Linux and the ten-run 200-turn kill soak remain open.
No durability barriers were removed or combined.

Run from the repository root with a built Core and the release `plur1bus`,
`plur1bus-tools` and `plur1bus-engine` binaries in the same directory:

```sh
PLUR1BUS_BIN=<absolute-path-to-release-plur1bus> node --experimental-strip-types scripts/bench/engine-capture.mjs
cargo test --locked -p plur1bus-engine --lib capture_reports_its_explicit_durability_barriers -- --nocapture
```

The second command counts explicit engine sync calls in a separate warmed capture
fixture, across worker threads. It reported 10 atomic file syncs, 10 atomic
directory syncs, and one trusted-directory sync. It does not count syncs internal
to Lance or SQLite.
