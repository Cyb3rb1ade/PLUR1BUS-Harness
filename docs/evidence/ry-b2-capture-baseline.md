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

## Alternating capture diagnostics, 2026-11-16

Release binaries at `36dd2b3ced`, macOS arm64, Node 24.21.0, flat embedder,
fresh home per leg, two warm-ups and 20 pairs with the same facts on both legs.
Pi's workload continued. Each pair alternated captures. The 12:09–12:10 CET
repeat interleaved the two pair series in the same window, using a separate Rust
control home for each. Deltas are medians of paired differences.

| Pair | A, Rust with sync | B | Median A − B |
|---|---:|---:|---:|
| Rust versus Node pin, 12:02 CET | 530.3 ms | 55.8 ms | 473.3 ms |
| Rust with versus without sync, 12:02–12:03 CET | 534.7 ms | 315.9 ms | 210.5 ms |
| Rust versus Node pin, interleaved repeat | 563.5 ms | 57.8 ms | 503.6 ms |
| Rust with versus without sync, interleaved repeat | 558.8 ms | 336.3 ms | 220.3 ms |

The interleaved repeat attributed **43.7%** of the Rust–Node gap to synchronous
flushes. Resampling the 20 four-observation blocks gave a 95% bootstrap interval
of 41.2–47.1%. The first run gave 44.5%. Each measured capture stored one row and
advanced `memories.lance` by one version in both modes.

### Rust capture sections

The 12:07 CET A/B used a separate Release copy with elapsed-time probes. The
probes recorded both sync modes. “Pins” covers capture admission and Neo
workspace identity and path checks. Timings for pins, vector publication, and
notification overlap their parent sections. Table versions were counted from
the Lance manifests after every capture.

| Section | A, sync | B, sync bypassed | Commits per capture, A / B |
|---|---:|---:|---:|
| CLI start to Rust capture pipeline | 10.89 ms | 11.11 ms | |
| Capture turn WAL | 17.42 ms | 2.64 ms | |
| Neo journal, both calls | 205.99 ms | 117.21 ms | |
| Neo episode store and session checkpoint, outside the journal call | 27.81 ms | 28.28 ms | |
| Primary embedding, flat model | 0.073 ms | 0.072 ms | |
| Neo embedding drain | 241.01 ms | 108.50 ms | |
| Neo vector publication, within the drain | 33.36 ms | 8.27 ms | |
| Lance `capture-bench/memories.lance`, duplicate query, upsert and post-store read | 13.45 ms | 13.28 ms | 1 / 1 |
| Lance `capture-bench/_embedding_identity.lance` | 0 ms | 0 ms | 0 / 0 |
| Rust SQLite cache and speaker-store methods | 0 ms | 0 ms | |
| Node Core SQLite calls on the Rust route | 7.69 ms | 6.42 ms | |
| Admission and Neo workspace pins | 66.36 ms | 60.51 ms | |
| Rust `capture.done` notification enqueue | 0.012 ms | 0.011 ms | |
| Rust pipeline end to CLI response | 16.74 ms | 15.12 ms | |
| Rust capture pipeline | 633.08 ms | 308.45 ms | |
| CLI round trip with section probes | 669.50 ms | 338.62 ms | |

Core SQLite here includes the agent-lifecycle and admin databases, the dream
ledger, and the SQLite log writer lock. Neither the SQLite caches nor any other
Lance table had a measured operation in this warmed text-only fixture.

### Durability calls per capture

A temporary Darwin interposer covered the benchmark CLI, Core and engine
processes. It recorded the implementation reaching `fsync`, `fcntl(F_FULLFSYNC)`,
`fcntl(F_BARRIERFSYNC)`, `msync(MS_SYNC)` or `sync`. Leg A executed the calls.
Leg B acknowledged those calls inside the interposer. Both legs otherwise used
the same Release binaries and isolated synthetic homes. The operating system
could still perform ordinary asynchronous writeback in leg B.

The counts below are per-capture medians from the 12:02 Rust–Node pairs. The
Rust engine itself issued **57 `F_FULLFSYNC` calls** per capture. Including the
Core, Rust had **65 sync calls** per capture and Node had **33**. The engine-only
legacy counter of nine atomic replacements covered just one subset of these
calls. Individual medians can differ from the median total.

| Destination or operation | Rust `F_FULLFSYNC` | Rust `fsync` | Node `F_FULLFSYNC` | Node `fsync` |
|---|---:|---:|---:|---:|
| Rust capture admission | 13 | 0 | 0 | 0 |
| Capture turn WAL, including directory | 4 | 0 | 2 | 0 |
| Neo journal files and derived indices | 11 | 0 | 0 | 0 |
| Neo embedding files | 9 | 0 | 0 | 0 |
| Neo workspace directory, across journal and drain | 20 | 0 | 0 | 0 |
| Neo episode and session files | 0 | 0 | 0 | 0 |
| Lance table paths, including manifests | 0 | 0 | 0 | 0 |
| SQLite dream ledger WAL | 0 | 1 | 0 | 1 |
| SQLite Core log writer lock journal | 0 | 4 | 0 | 20 |
| Core log file and parent directory | 1 | 2 | 0 | 10 |
| Whole capture | 58 | 7 | 2 | 31 |

The Node pin wrote Neo journal, episode, and embedding queue files in the
fixture. Its capture turn WAL called the Node `fsyncSync` API twice per capture
and Darwin executed `F_FULLFSYNC` for those calls. The Rust and Node Lance paths
each published a manifest version with zero explicit syncs observed for their
table files. `F_BARRIERFSYNC`, synchronous `msync` and `sync` had zero observations.

Targeted macOS System Trace independently saw the Rust control's 57
`F_FULLFSYNC` syscalls and zero sync syscalls in the bypassed Rust process for
the paired capture. The companion Core control trace included SQLite `fsync`.
The bypassed Core trace had zero sync syscalls while its interposer recorded
four requested `fsync` calls. A synthetic control verified both `fsync` and
`F_FULLFSYNC` against their kernel probes.

The sync bypass lives entirely in the temporary measurement tooling. The
section probes were compiled under a separate binary name in a disposable source
copy. The repository changes for this diagnostic are limited to these findings.

## B2-4 follow-up in the controller's order, 2026-11-16

### 1. Work outside sync calls

All follow-up comparisons alternate one sample from each leg after two warm-ups,
20 pairs per run. The scale probe used the same Release binary without sync calls
in both legs. The populated home added 1,000 synthetic turns, 1,000 candidates
and 2,000 already-completed queue rows using the fixture's workspace and owner.
This exercises Neo history and indices with the same Lance capture workload.

| Median before the changes, sync bypassed | Fresh home | Home with 4,000 added rows |
|---|---:|---:|
| Neo journal | 125.9 ms | 1,234.2 ms |
| File caps across Neo transactions | 49.4 ms | 616.4 ms |
| Journal preflight | 10.0 ms | 207.0 ms |
| Append-history projection | 9.6 ms | 131.3 ms |
| Record-index projections | 9.7 ms | 171.5 ms |
| Embedding drain | 112.6 ms | 770.6 ms |
| Embedding preflight | 24.8 ms | 315.8 ms |
| Embedding plan and indices | 29.1 + 10.9 ms | 313.2 + 220.7 ms |
| Admission saves | 18.3 ms | 19.0 ms |
| Admission and Neo workspace pins | 63.0 ms | 74.0 ms |
| Episode store and session checkpoint | 28.8 ms | 142.0 ms |
| CLI round trip | 350.4 ms | 2,236.7 ms |

Rows within a parent stage overlap. Neo caps repeatedly read, hash and parse
source files. The journal and drain preflights parsed or read the same files
multiple times to check records, byte limits and live IDs. Candidate, record
and append-history projections read and serialize complete indexes. Episode
completion shares the Neo cap and verifies source history. Admission and pin
checks are driven principally by the number of publications. The preflight
probes also exposed repeated host workspace resolution for the same binding.

RE-D237 uses the same trusted bytes for parsing and byte bounds, reuses cap JSON
validation for byte-identical reads inside the same held writer lease, and
updates record-index statuses by ID in the existing serialization order. It
uses the host path that resolved the identity for the directory proof,
rechecks the live pin, and reuses the live writer guard for an exact match to
the embedding plan's saved caller. Admission serializes each save once.

The first-pass A/B used sync bypass in both legs and still requested 57
`F_FULLFSYNC` calls per Rust-engine capture in each. The paired CLI saving was
74.6 ms in the fresh home (leg medians 491.1 → 400.8 ms) and 249.0 ms in the
populated home (2,207.9 → 1,943.8 ms). In the populated home the journal went
from 1,217.9 to 1,105.4 ms and the drain from 756.9 to 663.3 ms. These checks
preceded the sync changes. The final build also rechecks the pinned workspace
directory after the policy callback.

### 2. Directory syncs after a publication

Apple describes `fsync` as moving file data into the device cache,
`F_BARRIERFSYNC` as ordering device I/O, and `F_FULLFSYNC` as requesting a drive
cache flush. The [macOS fcntl manual](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/fcntl.2.html)
and [Apple's APFS presentation](https://developer.apple.com/videos/play/wwdc2019/419/?time=1104)
describe those mechanisms. A queued I/O predecessor needs an ordering fence
when ordering alone is the requirement. Our prepared plans need the durable
predecessor before effects become visible. Apple's drive-cache description is
evidence about buffered data on that device. It leaves the required
cross-file and directory publication contract across the engine's supported
filesystems unproven. This change keeps full syncs at the boundaries below.

- RE-D238. A capture source append used to sync its file and then the parent
  directory for every source. Each append or recovered visible row still syncs
  its file. After all source files are pinned and synced, the parent sync runs
  once, before derived indexes and before clearing the already-durable plan.
  A crash before that parent sync can leave a new name absent, a torn tail or
  an already-visible row. The retained plan completes any of them exactly
  once. This is covered by
  `replay_syncs_a_visible_row_from_an_interrupted_append` and
  `sigkill_after_first_durable_row_releases_both_leases_and_recovers`.
- RE-D239. Embedding publication applies the same parent sync after its
  target and queue appends. Vector data and its metadata precede these
  appends. The prepared plan persists across a crash between files and is
  cleared after the derived indexes. The test
  `sigkill_at_five_publication_boundaries_recovers_exactly_once` covers the
  interrupted publication. `publication_syncs_the_parent_once_after_all_source_files`
  checks the shared boundary and
  `publication_refuses_a_source_replaced_before_the_parent_sync` verifies that
  file identity checks cover it.

### 3. Section timings after both changes

The 13:15 CET A/B compares the previous and updated instrumented Release builds
in freshly warmed homes, with actual sync calls on both legs. The replacement
checks were active in the updated build. Values are medians in milliseconds.
Pins and admission checks overlap the stages that invoke them.

| Section | Before | After |
|---|---:|---:|
| Capture turn WAL | 17.5 | 19.2 |
| Neo journal | 244.2 | 226.3 |
| Episode store and session checkpoint | 39.8 | 36.8 |
| Primary embedding, flat model | 0.075 | 0.075 |
| Neo embedding drain | 244.4 | 206.9 |
| Vector publication, within the drain | 36.0 | 34.2 |
| Admission saves | 81.6 | 77.2 |
| Admission and Neo workspace pins | 127.6 | 120.3 |
| Lance `memories.lance`, one commit on both legs | 15.1 | 15.1 |
| Lance `_embedding_identity.lance`, zero timed commits | 0 | 0 |
| Rust SQLite cache and speaker store | 0 | 0 |
| Core SQLite calls serving the Rust route | 9.7 | 7.2 |
| Rust `capture.done` notification enqueue | 0.013 | 0.012 |
| Rust pipeline end to CLI response | 13.1 | 16.6 |
| CLI round trip with probes | 712.6 | 657.7 |

The median paired round-trip saving was 61.5 ms. The Rust process issued
**57 → 51 `F_FULLFSYNC` calls** per capture, with **20 → 14** of those targeting
the Neo workspace directory. This test saw one Lance manifest commit per turn
and the same per-file sync counts for the source publications. In this A/B the
whole-path median changed from 61 to 55 sync calls, including Core.

The uninstrumented Release comparison at 13:18–13:19 CET ran after our Cargo
jobs finished, while Pi's work continued. It alternated 20 Rust–Node pairs and
20 Rust sync–bypass pairs in the same window.

| Pair | A, Rust with sync | B | Median paired difference |
|---|---:|---:|---:|
| Rust versus Node pin | 462.6 ms | 51.5 ms | 408.3 ms |
| Rust sync versus bypass | 460.0 ms | 287.0 ms | 177.6 ms |

Rust was **8.97×** the Node median. The sync bypass accounted for about 43.5%
of the paired gap. The remaining round trip was 287.0 ms even in the bypass
leg. The section probes place the largest remaining blocks in the Neo journal,
drain and workspace checks. The populated-home runs still put the Neo journal
and drain above 1.7 seconds combined before syncs. The controller's 1.5× gate
ends this optimization pass. The Linux measurement and ten 200-turn release
kill soaks remain open.

The macOS checks passed 101 capture unit tests, five publication unit tests,
188 Neo integration tests and Engine Clippy with `real-models`. Those suites
include source journal SIGKILL recovery and the five embedding publication
boundaries. The populated-home fixture is synthetic and keeps the primary
Lance workload constant across the density comparison.

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
