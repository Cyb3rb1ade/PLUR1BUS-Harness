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
| Same Rust kill soak at `053c26afbe` | Same command against binaries and Core built from the base | 2 | 0 | 0 | The replay drained in 27.7 seconds after the last turn |
| Rust owner, recall and memory operations | `PLUR1BUS_ENGINE_IMPL=rust node --experimental-strip-types --test --test-concurrency=1 --test-timeout=120000 tests/system/{rust-job-ownership,two-session-recall,memory-ops}.test.ts` | 3 | 0 | 0 | Live two-person grants, private diary, CLI user scope and journal replay after a Core kill |
| Node recall and memory operations | `PLUR1BUS_ENGINE_IMPL=node node --experimental-strip-types --test --test-timeout=120000 tests/system/{two-session-recall,memory-ops}.test.ts` | 2 | 0 | 0 | Same public recall and memory operations |
| Setup | `PLUR1BUS_ENGINE_IMPL=<engine> node --experimental-strip-types --test --test-timeout=180000 tests/system/setup.test.ts` | 2 per engine | 0 | 0 | The latest direct download succeeded. An earlier download failed twice per engine before startup; a verified local mirror of the pinned archive passed 2/2 on each |
| Import preflights (B6) | `PLUR1BUS_ENGINE_IMPL=<engine> node --experimental-strip-types --test --test-timeout=180000 tests/system/import.test.ts` | 7 per engine | 0 | 0 | No Rust gaps in this suite |
| Re-embedding (B1) | `PLUR1BUS_ENGINE_IMPL=rust node --experimental-strip-types --test --test-timeout=180000 tests/system/reembed.test.ts` | 6 | 0 | 0 | Native plan, run, switch and rollback through the real Core |
| Local embedding parity (macOS arm64) | `cargo test --locked -p plur1bus-engine --features real-models --test embedding_parity -- --skip jina_vectors_and_reranking_match_live_node_without_repository_goldens --nocapture` | 3 | 0 | 1 filtered | E5, EmbeddingGemma 2 and BGE. BGE maximum score delta 0. Jina requires separate consent |
| System recall with real models (macOS arm64, debug binaries) | `PLUR1BUS_ENGINE_IMPL=rust PLUR1BUS_REAL_MODELS=1 node --experimental-strip-types --test --test-timeout=300000 tests/system/two-session-recall.test.ts` | 0 | 1 | 0 | Model warm-up passed with the pinned `ORT_DYLIB_PATH`. Both the base and this branch exceeded the 600 ms deadline. A branch rerun with the 3,000 ms shared-runner budget also timed out |
| Workspace | `cargo test --locked --workspace --no-fail-fast` | 5,917 | 4 | 11 | Run before the subsequent mood and partition fixes. Three `code_cli` connection-count failures and one macOS `sandbox_limits` fork-count failure. The base `code_cli` rerun reproduced one connection-count failure |
| Capture | `cargo test --locked -p plur1bus-engine --test capture` | 184 | 0 | 0 | Includes independent mood state for proved local people and an exact legacy-binding check |
| Curation (RE-10 T6) | `node --experimental-strip-types --conditions=source --test --test-concurrency=1 --test-timeout=120000 packages/core/test/memory-curation.test.ts` | 7 | 0 | 0 | Existing Core-to-engine handler and native Keep/Drop across restart |

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
- Native media index RPC (T4), the frozen A/B recall corpus and per-model cosine thresholds (T7), and the lexical index, rank fusion and bake-off (T8) remain open.
- `gc-run` inherits the pinned top-level-only `maxDbSizeMb` count (B9 F3). The calculation is outside this milestone by Controller decision.
