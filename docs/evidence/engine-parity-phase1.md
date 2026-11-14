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
| Local embedding parity | `cargo test --locked -p plur1bus-engine --features real-models --test embedding_parity -- --skip jina_vectors_and_reranking_match_live_node_without_repository_goldens --nocapture` | 2 | 1 | 1 filtered | E5 and EmbeddingGemma 2 pass. BGE exceeds its existing tolerance. Jina requires separate consent |

## Open findings

- BGE pair 24 has a score delta of `0.019226390917741604` against the committed recording, above its `0.001` limit.
  A fresh BGE recording with the pinned Node engine on the same host reports `0.023955957995194396` for that pair.
  The committed Node recording reports `0.043182348912936`. The cause of the recording drift is unverified.
  BGE goldens and tolerances are unchanged.
- Linux system and Linux/Windows hop-budget jobs are advisory. Native hop results and the Windows workspace acceptance
  have yet to be verified. T4 requires the local gate and two weeks of green parity on `main` and every pull request.
