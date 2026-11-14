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

## Open findings

- The original BGE recording has model/revision/quantization metadata. Its runtime, execution provider and platform are unknown. The two fresh recordings used Node 24.21.0, Transformers 4.3.1, ONNX Runtime 1.30.0, CPUExecutionProvider, engine pin `9f34008c143c5da87b2194b5a28442b407ff8ba7`, q8 revision `c44ebc43de724ae8816668bb44d2e728e17faa18` and matching recorded SHA-256 values for all four model artifacts.
  The lockfiles at the original recording commit and at the RY-B base both resolve Transformers 4.3.1 and ONNX Runtime 1.30.0. This records the repository pins; it does not establish the environment that generated the original file.
  The Linux x64 test environment was a Linux/amd64 container on Apple Silicon with x64 userspace emulation. It is distinct from native Linux x64. Pair 24 and the first multi-document ordering were:

  | Recording | Pair 24 | First ranking (indices) |
  |---|---:|---|
  | Original | 0.043182348912936 | 0, 4, 1 |
  | macOS arm64 | 0.023955957995194396 | 0, 2, 4 |
  | Linux x64 under emulation | 0.033151406913686336 | 0, 4, 2 |
  | Linux arm64 comparison | 0.023955957995194396 | 0, 1, 2 |

  Exactly one pair exceeded 0.001 in each of the Mac–original, Linux x64–original and Mac–Linux x64 comparisons. The second multi-document ranking was 0, 2, 1 in all four. A diagnostic Rust run against fresh Node on macOS matched 50 scores and both rankings, maximum score delta zero. The old score was not reproduced. The committed BGE reference and tolerance remain unchanged. The local official BGE test remains red. Recorder: `node crates/plur1bus-engine/tests/fixtures/vectors/record.mjs --bge --output-dir <temp-dir>`.
- Linux system and Linux/Windows hop-budget jobs are advisory. Native hop results and the Windows workspace acceptance
  have yet to be verified. Gate promotion is a follow-up after two weeks of green parity on `main` and every pull request (RE-09 T4).
