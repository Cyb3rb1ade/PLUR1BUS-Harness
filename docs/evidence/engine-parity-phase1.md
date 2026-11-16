# Engine parity at the end of Phase 1

| Scenario | Node | Rust |
| --- | --- | --- |
| capture/one-turn | pass | pass |
| jobs/run-default-trigger | pass | pass |
| jobs/run | pass | pass |
| ops/admin-migrate-empty | pass | pass |
| ops/admin-migrate | pass | pass |
| ops/checkpoint | pass | pass |
| ops/correct | pass | pass |
| ops/import-unimport | pass | pass |
| ops/list-show-forget | pass | pass |
| ops/rebind-unbind-link | pass | pass |
| ops/share-propose | pass | pass |
| recall/plain | pass | pass |
| recall/temporal | pass | pass |
| recall/warm-only | pass | pass |
| recall/weak-hit-refined | pass | pass |

15/15 scenarios passed in the selected mode.

## RY-B local status

Harness base `053c26afbe`, Node engine pin `9f34008c143c5da87b2194b5a28442b407ff8ba7`.
The offline run used Node 24.21.0, the staged tokenizer files, and the local Rust engine binary.

| Check | Command | Passed | Failed | Skipped | Finding |
| --- | --- | ---: | ---: | ---: | --- |
| Offline Node and Rust | `pnpm parity --check tests/engine-parity/scenarios --report docs/evidence/engine-parity-phase1.md` | 15/15 per engine | 0 | 0 | Deterministic scenarios above |
| Core transcripts | `node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning --test --test-concurrency=1 tests/core-parity/*.test.ts` | 37 | 0 | 0 | Re-recorded for engine RPC 1.27 |
| Rust system suites except the separate kill soak | `PLUR1BUS_ENGINE_IMPL=rust node --experimental-strip-types --test --test-concurrency=2 --test-timeout=180000 <tests/system/*.test.ts files except kill-soak.test.ts>` | 86 | 0 | 0 | macOS arm64 with native debug binaries and signed extension fixtures |
| Rust kill soak before parallel replay | `PLUR1BUS_ENGINE_IMPL=rust PLUR1BUS_SOAK_SEED=3624877480 node --experimental-strip-types --test --test-timeout=600000 tests/system/kill-soak.test.ts` | 1 | 1 | 0 | The journal drain timed out with 89 lines present when the budget was set. A diagnostic rerun measured roughly one line per 2.3 seconds in that phase |
| Rust kill soak with parallel replay and an optimized Engine crate | Same test and seed, using an Engine built with `cargo build --locked --profile fast-soak --config 'profile.fast-soak.package.plur1bus-engine.opt-level=2' -p plur1bus-engine --bin plur1bus-engine` (`fast-soak` inherits `dev`) | 2 | 0 | 0 | 89 lines drained in 53.8 seconds against a 91-second budget. Both engine startup refusal counters and duplicate count were zero. The same engine profile failed the drain deadline with serial replay |
| Rust kill soak with parallel replay and the default debug build | Same test and seed with the default debug build, run in isolation | 1 | 1 | 0 | Journal drain timed out with a backlog of 89 lines at the end of the turns. The previous concurrent workspace run failed at supervisor adoption |
| Rust kill soak with parallel replay and native release binaries | `cargo build --locked --release -p plur1bus-engine -p plur1bus -p plur1bus-tools`, then the same test and seed with those binaries | 2 | 0 | 0 | 85 lines drained in 44.0 seconds against an 87.9-second budget. Both engine startup refusal counters and duplicate count were zero |
| Same Rust kill soak at `053c26afbe` | Same command against binaries and Core built from the base | 2 | 0 | 0 | The replay drained in 27.7 seconds after the last turn |
| Rust owner, recall and memory operations | `PLUR1BUS_ENGINE_IMPL=rust node --experimental-strip-types --test --test-concurrency=1 --test-timeout=120000 tests/system/{rust-job-ownership,two-session-recall,memory-ops}.test.ts` | 3 | 0 | 0 | Live two-person grants, private diary, CLI user scope and journal replay after a Core kill |
| Node recall and memory operations | `PLUR1BUS_ENGINE_IMPL=node node --experimental-strip-types --test --test-timeout=120000 tests/system/{two-session-recall,memory-ops}.test.ts` | 2 | 0 | 0 | Same public recall and memory operations |
| Setup | `PLUR1BUS_ENGINE_IMPL=<engine> node --experimental-strip-types --test --test-timeout=180000 tests/system/setup.test.ts` | 2 per engine | 0 | 0 | The latest direct download succeeded. An earlier download failed twice per engine before startup; a verified local mirror of the pinned archive passed 2/2 on each |
| Import preflights (B6) | `PLUR1BUS_ENGINE_IMPL=<engine> node --experimental-strip-types --test --test-timeout=180000 tests/system/import.test.ts` | 7 per engine | 0 | 0 | No Rust gaps in this suite |
| Re-embedding (B1) | `PLUR1BUS_ENGINE_IMPL=rust node --experimental-strip-types --test --test-timeout=180000 tests/system/reembed.test.ts` | 6 | 0 | 0 | Native plan, run, switch and rollback through the real Core |
| Local embedding parity (macOS arm64) | `cargo test --locked -p plur1bus-engine --features real-models --test embedding_parity -- --skip jina_vectors_and_reranking_match_live_node_without_repository_goldens --nocapture` | 3 | 0 | 1 filtered | E5, EmbeddingGemma 2 and BGE. BGE maximum score delta 0. Jina requires separate consent |
| System recall with real models (macOS arm64, debug binaries) | `PLUR1BUS_ENGINE_IMPL=rust PLUR1BUS_REAL_MODELS=1 node --experimental-strip-types --test --test-timeout=300000 tests/system/two-session-recall.test.ts` | 0 | 1 | 0 | Model warm-up passed with the pinned `ORT_DYLIB_PATH`. Both the base and this branch exceeded the 600 ms deadline. A branch rerun with the 3,000 ms shared-runner budget also timed out |
| System recall with real models (macOS arm64, release binaries), before `495a2fac1b` | Same test with native release binaries and the same model and runtime files | 0 | 1 | 0 | Model warm-up passed. The Core cut the first CLI recall off at the 600 ms hard budget (612 ms wall time). With the budgets widened to 5,000 ms the recall took 1,546 ms in the median of ten runs (Node: 87 ms), almost all of it in the rerank phase: the embedder and the reranker shared one ONNX session slot, so every recall loaded the reranker from disk |
| System recall with real models (macOS arm64, release binaries), from `495a2fac1b` | `PLUR1BUS_ENGINE_IMPL=rust PLUR1BUS_REAL_MODELS=1 ORT_DYLIB_PATH=<pinned 1.30.0 library> PLUR1BUS_TOKENIZER_DIR=<staged tokenizers> node --experimental-strip-types --test --test-timeout=300000 tests/system/two-session-recall.test.ts`, default 400/600 ms budgets | 1 | 0 | 0 | First recall 102 ms wall. Six runs per engine: first recall Rust 90 ms median (80 to 104), Node 82 ms (77 to 89); rerank phase Rust about 28 ms, Node about 21 ms; recall after a restart Rust 94 ms, Node 104 ms; models warm Rust 3.0 s, Node 2.2 s. First capture Rust 574 ms median, Node 118 ms |
| Rust kill soak, native release binaries, twelve runs in a row at `a1cd2e7640` | `PLUR1BUS_ENGINE_IMPL=rust PLUR1BUS_SOAK_TURNS=200 node --experimental-strip-types --test --test-timeout=600000 tests/system/kill-soak.test.ts`, three runs with seed 3642284123 and nine with random seeds | 24 | 0 | 0 | 63 to 173 journal lines after the last turn, drained in 30.8 to 68.4 seconds (0.37 to 0.51 seconds per line against a budget of 1 second per line). No duplicate, both engine startup counters zero. One run of an earlier series the same morning (seed 3642284123, 87 lines) ran into the drain deadline; three reruns with that seed passed and the cause was not found (the machine was shut down minutes later, its logs are gone) |
| Workspace | `cargo test --locked --workspace --no-fail-fast` | 5,922 | 0 | 11 | All suites completed on macOS arm64. Earlier `code_cli` and `sandbox_limits` timing failures also occurred on the base |
| Capture | `cargo test --locked -p plur1bus-engine --test capture` | 184 | 0 | 0 | Includes independent mood state for proved local people and an exact legacy-binding check |
| Curation (RE-10 T6) | `node --experimental-strip-types --conditions=source --test --test-concurrency=1 --test-timeout=120000 packages/core/test/memory-curation.test.ts` | 7 | 0 | 0 | Existing Core-to-engine handler and native Keep/Drop across restart |

## Foreground recall latency (2026-11-15)

Base `670e5ad4d7`, macOS arm64 (Apple M5 Pro, 18 logical processors), native release binaries, Node 24.21.0, the
pinned ONNX Runtime 1.30.0 library, `intfloat/multilingual-e5-small` and `woxpas-ai/bge-reranker-v2-m3-onnx` (q8).
The machine carried other load during all runs (load average 7 to 13). Every comparison below is therefore
interleaved: each round runs every configuration once, and a figure is the median over the rounds of the per-run
medians.

Steady state: one agent with six facts, then `plur1bus memory recall --agent … --session … --joined <one of six
questions>` through the real Core, three warm-up recalls and twenty measured ones per run, four rounds. "Wall" is the
CLI process from start to exit; the other columns are the engine's own timing (`timing.totalMs` and namespace phases).

| Engine | Wall ms | `totalMs` | Rerank | Graph | Vector search |
|---|---:|---:|---:|---:|---:|
| Node engine, base | 100.0 | 89.5 | 52.5 | 9.5 | 6.0 |
| Rust engine, base | 126.5 | 112.0 | 60.2 | 13.4 | 5.5 |
| Node engine, same rounds as the next row | 93.0 | 83.0 | 52.0 | 10.0 | 6.0 |
| Rust engine with RE-D230 to RE-D232 | 79.5 | 65.2 | 43.2 | 5.5 | 5.8 |

Where the base spent the difference, from a sampled profile of the engine process and a direct measurement of the
writes:

- The mood update before retrieval replaced two files atomically, each with a file and a directory `F_FULLFSYNC`:
  8.0 ms per replacement on this disk (median of 40; 4.0 ms with the file sync only, 0.16 ms without any), so about
  16 ms per recall. The pin writes both files with a plain `writeFileSync`. RE-D230 keeps the durable writes and runs
  them beside retrieval.
- The graph stage read each endpoint row with its own table query: 13.4 ms for the six facts and their edges.
  RE-D231 reads each endpoint set in one query (5.5 ms).
- The rerank ran on a pool of 18 threads without spinning. The same rerank under other pool shapes, same method
  (medians of four rounds):

| Pool threads | Spinning | Rerank ms |
|---:|---|---:|
| 18 | no | 60.2 |
| 12 | no | 59.9 |
| 9 | no | 63.6 |
| 18 | yes | 80.4 |
| 16 | yes | 55.3 |
| 14 | yes | 44.2 |
| 12 | yes | 43.2 and 44.5 (two series) |
| 10 | yes | 46.6 |
| 9 | yes | 49.6 |
| runtime default | yes | 50.6 |

  The Node engine runs the runtime's default shape (52 ms). RE-D232 takes two thirds of the processors with spinning
  from eight processors up; smaller machines are unchanged and not measured.

`tests/system/two-session-recall.test.ts` with real models, seven runs per engine (one with the default 400/600 ms
budgets, six with wide budgets), medians: first recall Rust 53 ms wall and 38 ms `totalMs` (49 to 54 ms wall), Node
82 ms and 71 ms (76 to 97); recall after a restart Rust 62 ms (59 to 67), Node 97 ms (92 to 111). Models warm: Rust
3.0 s, Node 2.0 to 2.9 s. The first capture is unchanged by this work: Rust 483 ms median, Node 105 ms (open finding
below).

Checks after the change: the engine crate's tests (lib 536, bundles and RPC suites, all passing), the local embedding
parity suite with the new pool shape (BGE maximum score delta 0, E5 maximum absolute delta 1.8e-7, EmbeddingGemma 2
3.3e-7, minimum cosine 1.0 for both), `pnpm parity` 15/15 per engine, and the Rust system suites
`rust-job-ownership`, `two-session-recall` and `memory-ops`. An idle engine after ten recalls used 0.23 CPU seconds
in 20 seconds (Node engine: 0.07).

## BGE model parity

The [original RE-03 report](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/pull/809) records an exact match on Linux x86_64 with ONNX Runtime 1.30.0. A new [native Linux x64 recording](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/actions/runs/43549074480) on AMD EPYC 9V45 reproduced the original file's data exactly, including 50 pair scores, full pair order and both multi-document rankings. A second native macOS arm64 recording reproduced the first local macOS recording byte for byte.

All fresh recordings used Node 24.21.0, Transformers 4.3.1, ONNX Runtime 1.30.0, CPUExecutionProvider, engine pin `9f34008c143c5da87b2194b5a28442b407ff8ba7` and q8 revision `c44ebc43de724ae8816668bb44d2e728e17faa18`. All four recorded model-artifact digests match across the platforms.

| Recording | Pair 24 | First ranking (indices) | Pair scores more than 0.001 from original |
|---|---:|---|---:|
| Original | 0.043182348912936 | 0, 4, 1 | 0 |
| Native Linux x64 | 0.043182348912936 | 0, 4, 1 | 0 |
| Native macOS arm64 | 0.023955957995194396 | 0, 2, 4 | 1 |
| Linux x64 userspace under emulation | 0.033151406913686336 | 0, 4, 2 | 1 |
| Linux arm64 comparison | 0.023955957995194396 | 0, 1, 2 | 1 |

The second multi-document ranking was 0, 2, 1 in every recording. Pair 24 uses the empty query from the frozen corpus. The platform-specific variation is reproduced within Node itself and Rust matched the same-machine Node recording. A controlled session-option probe also shifted the quantized score when ORT graph optimization changed, with the model bytes and provider held fixed. The recordings establish variation in the runtime/CPU inference path. They do not identify a single ORT kernel as the sole source of that variation.

The test selects the native Node recording for its platform and checks its runtime, CPU provider and artifact digests. Score tolerance remains 0.001, with exact ranking comparisons. The second Linux x64 run reproduced the new Linux file byte for byte. The Rust model test with final file selection ran on macOS arm64. [Second native Linux recording](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/actions/runs/43550219970)

Recorder command `node crates/plur1bus-engine/tests/fixtures/vectors/record.mjs --bge --output-dir <temp-dir>`.

## Open findings

- Linux system and Linux/Windows hop-budget jobs are advisory. Native hop results and the Windows workspace acceptance have yet to be verified. Gate promotion is a follow-up after two weeks of green parity on `main` and every pull request (RE-09 T4).
- The CLI fallback journal still needs Core-side replay when the Rust engine is down (RE-10 T1). The re-embedding orchestration checkpoint and the Dream Scheduler's phase ledger and candidate gates still live in Core (RE-10 T3 and T5).
- RE-08 T6 (distribution) is half done: the release payload, the container image and the desktop bundle carry the `plur1bus-engine` binary, but not the ONNX Runtime library the engine loads, and nothing sets `ORT_DYLIB_PATH` (or `PLUR1BUS_TOKENIZER_DIR`) for it; both are only inherited from the environment. An installation that selects the Rust engine therefore has no local embedding or reranking model until the operator sets the path by hand. The plan's test (`the payload for every target contains plur1bus-engine and the ONNX runtime library`) and the `ORT_DYLIB_PATH` of the engine's specification are owed before the cut (RY-B2).
- Linux x64, first system leg on the Rust engine (CI run 43631205132): 47 of 47 tests of the first step, the job-ownership test, the cold two-session recall and the kill soak passed (200 turns, 147 journal lines drained in 42.8 seconds). The leg stays advisory until RE-09 T4.
- Windows, third CI run: `core_run_engine` 12 passed and 1 failed, the engine library 506 and 4 (the three of the first run and `a_slow_owners_startup_recovery_never_refuses_another_owners_turn`, a capture under a 1,500 ms test budget that passed in the first run), the `capture` bundle 182 and 0; the step again ran into its 30-minute limit, this time before `ops`.
- RE-10 T2 (backup and tombstone re-apply): done in this PR (`748999254d`, `ce92c4db1b`). The engine stages a snapshot natively, with an optional label, and re-applies the latest tombstones at its start, with the writer lock held and before its endpoint is published; a failed re-apply keeps the marker and stops the start (checked in the review). With the Node engine the Core's `restore-reapply.ts` still runs; that path goes with the cut (RY-C).
- RE-10 T6 (curation): done, see the Curation row above.
- RE-10 T9 (RE-D13): done in this PR (`fd04ae1016`). The jobs' agent partition reads the rows of the physical agent table whatever their scope, bound to the agent, the workspace and the owner (`jobs/lance_scope.rs`: `agent_rows`, `owns_agent_row`); no row moves (checked in the review).
- Native media index RPC (T4), the frozen A/B recall corpus and per-model cosine thresholds (T7), and the lexical index, rank fusion and bake-off (T8) remain open.
- `gc-run` inherits the pinned top-level-only `maxDbSizeMb` count (B9 F3). The calculation is outside this milestone by Controller decision.
- `gc.maxCount` is a cap per person, not per agent table: each person's `gc-run` counts and archives that person's rows only, so a table shared by N people holds up to N times `maxCount` rows. `maxDbSizeMb` stays a bound of the table. Controller ruling of 2026-11-14 (review finding m5); the runs of two people may overlap, their row sets are disjoint and each archive is conditional on the row read.
- **RY-B2-4 / RY-B4, named RE-09 T4 exception:** the 1.5× capture latency
  target on macOS and Linux moves to [RY-B4](../superpowers/plans/rust-engine/RY-B4-capture-latency.md),
  after RY-B2 and before RY-C and RE-11. In the macOS arm64 Release A/B under
  load, adding 4,000 completed-history Neo rows changed the Rust median from
  527.5 to 2,304.6 ms and the Node pin median from 58.8 to 64.1 ms. The Neo
  journal, drain and their projections account for most of the increase in
  the section probes. Users who switch to Rust before RY-B4 may see captures
  grow slower with their corpus. The prior reference measurements, sync counts
  and paired comparison are in the [capture baseline](ry-b2-capture-baseline.md).
  All ten 200-turn Release kill soaks passed on macOS arm64 with zero
  duplicates and zero losses. The Linux capture comparison remains open.
- **RY-B2-5 / RY-B3, named RE-09 T4 exception:** Core's `buildEngineConfig` passes through `engine.dailyConsolidation`,
  `engine.merging` and `engine.llmRouter`. At pin `9f34008c`, `engine/jobs/internal-job-bodies.js` binds the selected
  Lance table, Neo store, exact caller and partition, workspace, decay mode, embeddings and the optional
  `memory-compaction` / `conflict-resolution` routes. It does not supply a compaction `autoApply` flag or an
  owner-bound private proposal sink. Step 3 scans recent Lance rows and reads the Neo compaction run state. Without
  an LLM it still computes duplicate, redundancy and conflict proposals and can append them to
  `.adaptive-learning/merge-proposals.jsonl` where that output is allowed. The daily default does not apply them to
  Lance. Step 4 runs only with a route and a workspace authorized for output: it reads
  `.adaptive-learning/conflict-log.jsonl` plus `conflict-resolved.jsonl` and appends recommendations to the latter.
  It does not mutate Lance or grant permission to apply a resolution. Rust TTL, decay, graph prune, journal
  retention and table optimize preserve these Node sidecars; the actual port is
  [RY-B3](../superpowers/plans/rust-engine/RY-B3-daily-consolidation.md), after RY-B2 and before RY-C/RE-11.
- Windows (`unit (windows-2025)`, first CI run of #914): the CLI `backup` tests pass; still failing are 1 test of `core_run_engine` (a grandchild holding the engine's stdout), 3 of the engine library (`neo::append_cap` archive reuse, one job deadline, one `Access is denied` in the shared-memory status test) and 21 of the `ops` bundle (4 root-replacement tests with `Access is denied` when a directory in use is moved, 3 share oracles, 12 unimport graph tests with `input validation failed` in the fixture setup, 2 unimport oracles). The step ran into its 30-minute limit before `capture` and `neo`. Moved to RY-B2.
