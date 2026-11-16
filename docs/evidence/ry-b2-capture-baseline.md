# RY-B2 capture baseline

Apple Silicon, macOS, Release binaries, Node 24.21.0. Each engine used a fresh home
and the flat embedder. CLI timing starts just before launching `memory add` and
ends once the CLI returns a stored result. Two captures warm each engine before
the 20-sample median.

| Measurement | Local time (CET) | Host load | Node | Rust | Rust / Node |
|---|---|---|---:|---:|---:|
| Earlier single capture | — | — | 107 ms | 486 ms | 4.54× |
| First RY-B2 benchmark, 20-sample median | 2026-11-16 03:12:02 (result file timestamp) | Concurrent host load | 76.3 ms | 704.7 ms | 9.24× |
| Quiet repeat, 20-sample median | 2026-11-16 11:13:19–11:13:35 | No concurrent Cargo, rustc or Node workload detected | 51.7 ms | 490.3 ms | 9.49× |
| RE-D233/234, 20-sample median | 2026-11-16 11:21:52–11:22:08 | No concurrent Cargo, rustc or Node workload detected | 50.7 ms | 485.2 ms | 9.58× |
| RE-D233–235, 20-sample median | 2026-11-16 11:26:33–11:26:49 | No concurrent Cargo, rustc or Node workload detected | 49.5 ms | 493.0 ms | 9.97× |
| RE-D233–236, 20-sample median | 2026-11-16 11:32:31–11:32:46 | No concurrent Cargo, rustc or Node workload detected | 46.2 ms | 468.4 ms | 10.13× |

The earlier flat-embedder measurement timed one capture.
[Phase 1 evidence](engine-parity-phase1.md#open-findings)

The optimization uses the quiet repeat as its reference. The final run measured
4.5% lower Rust latency and a higher Rust / Node ratio. Variation between runs
limits attribution to a specific change. The 1.5× gate on macOS and Linux and the
ten-run 200-turn kill soak remain open.

## Capture changes

- RE-D233. A Neo source group whose planned rows were all newly appended reuses
  the append's file and Unix directory sync. The separate group-end sync stays
  whenever replay observed a planned row on disk, including mixed groups. Such
  a row may be visible after a crash before its first sync. The durable plan
  precedes source mutations and is cleared only after publication. A regression
  test checks both the fresh append and the recovery of a visible row.
- RE-D234. Capture post-store reads the planned Lance rows in a batch. It checks
  the admission and each row's digest in `row_order` before starting any
  post-store effects.
- RE-D235. When Neo work is outstanding, one admission replacement records
  both the classifier outcome and Neo's start before Neo runs. If interrupted
  before that replacement, recovery sees the classifier's start and its durable
  reminder plans. If interrupted after it, recovery skips the finished
  classifier and resumes Neo. A classifier finishing after Neo already completed
  still saves separately.
- RE-D236. Embedding publication and episode replay reuse the append sync when
  every planned row in a target file is freshly written. They sync the target
  separately when any row was already visible. For episodes this happens before
  committing the session checkpoint. For embedding publication it happens
  before publishing the derived indices and clearing the recovery plan.

Capture reads the mood snapshot, so the deferred mood commit used by recall
(RE-D230) has no corresponding capture write to overlap.

A separate 8-second, 1 ms sampling profile of the Rust leg put 1,171 of 3,294
capture-worker samples in Neo journal recording and 1,088 in the synchronous
embedding drain. File syncs accounted for 958 samples and host RPC for 398.
The profiled leg is outside the latency comparison above.

On macOS, 101 capture unit tests and 188 Neo integration tests passed, including
the journal recovery and five embedding publication SIGKILL boundaries. Engine
Clippy passed for all targets with the `real-models` feature.

Run from the repository root with a built Core and the release `plur1bus`,
`plur1bus-tools` and `plur1bus-engine` binaries in the same directory:

```sh
PLUR1BUS_BIN=<absolute-path-to-release-plur1bus> node --experimental-strip-types scripts/bench/engine-capture.mjs
cargo test --locked -p plur1bus-engine --lib capture_reports_its_explicit_durability_barriers -- --nocapture
```

The second command counts explicit engine sync calls in a separate warmed capture
fixture, across worker threads. It reported 10 atomic file syncs, 10 atomic
directory syncs, and one trusted-directory sync at baseline. With RE-D235 it
reported 9 atomic file syncs, 9 atomic directory syncs, and one trusted-directory
sync. Lance and SQLite perform their own syncs outside this probe.
