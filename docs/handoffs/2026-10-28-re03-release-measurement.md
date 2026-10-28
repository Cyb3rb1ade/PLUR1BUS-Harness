# RE-03 release build measurement

Across 2026-10-28/29 (Europe/Berlin), the RE-02 baseline and the reviewed RE-03 implementation were built
sequentially on the same Linux x86_64 host, using separate initially empty Cargo target directories:

```sh
CARGO_TARGET_DIR=<fresh-target> cargo build --offline --locked --release -p plur1bus-engine --timings -j2
```

Both builds used Rust/Cargo 1.95.0, `CARGO_INCREMENTAL=0`, the unchanged release profile and no custom
`RUSTFLAGS`, C/C++ compiler flags or linker flags. The host was an AMD EPYC 9V74 with a four-CPU cgroup quota,
CPU affinity 0-4 and a 16 GiB memory limit. Cargo registry/source caches were shared; the operating-system page
cache was not cleared between runs. No other Rust build or model download ran concurrently.

| Snapshot | Source commit | Cargo-reported release duration | Executable bytes | Executable SHA-256 |
|---|---|---|---|---|
| RE-02 baseline | `f56f1bcf0fc424164f91b5ed922168fc02ce1e16` | 29m 49s (1789 s) | 1,391,488 | `d273ffca07a3498f2b84c2ab72c460125180b4e696d557088b20fc1920e5b51f` |
| Reviewed RE-03 | `c2b2dd210c10c0e6e9298fa4b27e09d8f073135a` | 29m 26s (1766 s) | 1,391,120 | `99ef17fc3b04b5b993fc3b960c1d536c9e828bc9c5df6a41fbe64b742cdc292c` |

The observed single-sample differences are **-23 seconds (-1.29%)** and **-368 bytes (-0.026%)**. These observations
do not establish a build speedup or a statistically reliable dependency cost: compilation variance and shared
source/page caches remain. RE-00's 9m 44s cold / 0.87s warm figures used the **dev** profile and cannot be subtracted
from either release measurement.

`crates/plur1bus-engine/src/main.rs` is identical in these snapshots and still contains the RE-00
version/placeholder entry point.
The linker can discard uncalled embedding/reranking library code. This executable-size comparison therefore does
not measure the eventual linked production inference service or externally supplied model/ONNX Runtime files.

Both Cargo logs end in `Finished release profile [optimized]`, and both preserved executables return
`plur1bus-engine 0.1.0` with exit code 0 for `--version`. The RE-03 build's actual process exit code was 0 and its
source worktree stayed clean. The baseline monitor was interrupted by an execution-session reset; its original
process exit status was unavailable, so success is corroborated by the Cargo completion line and executable,
not presented as an observed `waitpid` result. Cargo's own reported durations above are unaffected by monitoring.

The build scratch was limited to 10 GiB with a 1 GiB free-space floor. Sampled allocated target sizes reached
4,859,645,952 bytes for the baseline and 4,871,241,728 bytes for RE-03. Baseline sampling had gaps of approximately
204.5 s and 18.9 s during monitor recovery, so its sampled peak is a lower bound. The minimum sampled free space
was 6,264,365,056 and 6,169,030,656 bytes respectively. No sampled value reached a safety limit.

Raw Cargo logs, timing HTML, measurement JSON and the verified executables were retained outside the repository
under `/workspace/k-measurements/base/` and `/workspace/k-measurements/final/`. Only generated baseline scratch
was removed after preservation. No executable, runtime or model payload is committed. These build measurements
do not close the separately documented real-model/tokenizer, BGE licence or native-platform acceptance gates.
