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
| Rust system suites | `PLUR1BUS_ENGINE_IMPL=rust node --experimental-strip-types --test --test-concurrency=2 --test-timeout=180000 tests/system/*.test.ts` | 85 | 2 | 0 | Both failures are in `setup.test.ts`. The connection reset before the Node archive download completed |
| Node setup comparison | `PLUR1BUS_ENGINE_IMPL=node node --experimental-strip-types --test --test-timeout=180000 tests/system/setup.test.ts` | 0 | 2 | 0 | Same download failure as Rust, before either engine started |
| Setup using the pinned Node archive on a local mirror | `PLUR1BUS_ENGINE_IMPL=<engine> PLUR1BUS_NODE_MIRROR=<dir> node --experimental-strip-types --test --test-timeout=180000 <temporary setup fixture>` | 2 per engine | 0 | 0 | The temporary fixture retained the mirror variable. Ran once with `rust` and once with `node`. The installer verified the original archive against the unchanged SHA-256 pin |
| Local embedding parity | `cargo test --locked -p plur1bus-engine --features real-models --test embedding_parity -- --skip jina_vectors_and_reranking_match_live_node_without_repository_goldens --nocapture` | 2 | 1 | 1 filtered | E5 and EmbeddingGemma 2 pass. BGE exceeds its existing tolerance. Jina requires separate consent |

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

The test selects the native Node recording for its platform and checks its runtime, CPU provider and artifact digests. Score tolerance remains 0.001, with exact ranking comparisons. Recorder: `node crates/plur1bus-engine/tests/fixtures/vectors/record.mjs --bge --output-dir <temp-dir>`.

## Open findings

- Linux system and Linux/Windows hop-budget jobs are advisory. Native hop results and the Windows workspace acceptance have yet to be verified. Gate promotion is a follow-up after two weeks of green parity on `main` and every pull request (RE-09 T4).
