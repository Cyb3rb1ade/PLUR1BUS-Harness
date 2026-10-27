# RE-14/T2 implementation plan

The owner-authorized package B adds an unused token-counting library to the Rust engine (RE-D20(a), RE-R1).
PR #786 has `merged_at: 2026-10-26T21:50:33Z`; default branch `main` contains T1 at `0058ae70`.
T3 remains gated on this package's merge. RPC, Core consumers, calibration, and package D are outside this work.

## Execution

- [x] Confirm the actual predecessor merge, default-branch contents, and absence of another T2 PR/branch/job.
- [x] Create the isolated `codex/re-14-t2-token-counter` worktree from current `origin/main`.
- [x] Add failing bounds, family-selection, message-boundary, cumulative-prefix, artifact-integrity, and Golden tests.
- [x] Implement the library in `crates/plur1bus-engine/src/tokens/`, using the cache table's family names.
- [x] Pin `tokenizers =0.23.2` with the pure-Rust regex backend; audit its dependency licenses and notices.
- [x] Record independent reference counts for original DE/EN/code/JSON/Unicode texts; commit the recorder and counts.
- [x] Fetch only pinned, permissively licensed artifacts into an external cache; never bundle tokenizer files.
- [x] Require Golden artifacts in CI with `PLUR1BUS_TOKENIZER_FILES_REQUIRED=1`; test missing/corrupt cache failures.
- [ ] Verify Rust formatting, Clippy, tests and unchanged engine behavior; report per-family deviations and 200-item time.
- [ ] Review the final diff, commit with the owner's identity, and open exactly one T2 PR. No automatic merge.

## Contracts and decisions

The public library accepts exactly one family or route selector and a batch of items. Raw text with a matching
verified artifact can be `exact`; visible messages/tools are `tokenizer-text`, without a provider chat-template claim.
Absent, corrupt, unavailable or unapproved artifacts use the explicitly labelled `heuristic` method. Uncalibrated
estimates retain the Core's UTF-16 `ceil(chars / 4)` rule and conservative bounds. No `calibrated` method is implemented
in T2. Prefix counts re-encode each prefix within a message because BPE counts are not additive across segments.

Grok-2 and Gemma 3 never receive license approval here. Conditional or non-OSI artifacts require the owner's explicit
decision before listing; an accessible file alone is not approval. Artifacts record immutable source revisions, hashes,
and license evidence. Source-based o200k conversion must use genuine tiktoken ranks and independent reference counts.

The environment's enforced network policy permits GitHub/package registries but currently blocks Hugging Face.
No alternate proxy or mirror is used to bypass that restriction. Only genuine o200k ranks have an admitted source
and exact reference Goldens in this package; thirteen other table families remain explicitly heuristic.
Missing artifact access is an acceptance limitation,
not permission to invent pins, substitute another family's tokenizer, or skip required tests.

The generic ChatGPT-plan cache row also matches GPT-6. T2 conservatively consults the same table's first-party
lookup for those routes and preserves its `openai-unpublished` family instead of reporting an exact o200k estimate
as GPT-6's own tokenizer (RE-D20). The cache table and T1's parity vectors remain unchanged.

New Cargo dependencies use the existing permissive license policy. For attribution generation on Linux,
`node scripts/release/third-party.mjs --reuse-npm` preserves the existing native npm evidence only when
`pnpm-lock.yaml` is unchanged, validates its notice hashes, and recollects both locked Cargo graphs. The default
native generator and native CI drift gate remain unchanged; this does not claim a native macOS run.

## Validation and measurements

All new T2 Rust tests pass: four unit tests and ten integration tests, including fourteen independent o200k count
and token-ID Goldens, required-file failure, artifact integrity, message boundaries and the GPT-6 plan safeguard.
The Python recorder's four tests pass; its independent token-ID comparison covers 3,014 cases. Formatting,
workspace Clippy (`--all-targets -- -D warnings`), `pnpm test:prep`, `pnpm lint`, `pnpm docs:check`, and the dependency
license/source/bans gate pass. The existing advisory-policy wrapper reports zero blocking findings or collection
errors, without changing owner exceptions. The combined Node tooling checks pass 174 tests with three existing
TODOs, no failures and no skips. Independent review found no blocking code issue.

Full workspace acceptance is still open. `cargo test --offline --locked --workspace --no-fail-fast` reports 2,611
passed, three failed and three existing ignored tests. These unchanged host tests fail here:

- CPU tree discovery requires `CONFIG_PROC_CHILDREN`; this kernel has it disabled.
- Supervisor child cleanup observes an orphan zombie because PID 1 is `tail -f /dev/null` rather than a reaping init.
- The CPU-affinity test expects five available CPUs, while the cgroup quota is four (`400000 100000`).

All three existing ignored tests were also explicitly run with `-- --ignored`: the fuzz test passed; the documented
whitespace-only login-key and Docker private-address gaps failed. No test was newly ignored or weakened. The new
library remains unused by the runtime, and the cache table, T1 vectors, existing engine behavior and Core are unchanged.
This package is not declared fully accepted.

The following local Linux debug-build measurements use the committed texts cyclically, one warm-up batch and one
measured batch of exactly 200 items per family. Artifact construction is excluded from batch time; loading and
validating the table plus o200k artifact took 2,582.710 ms. These are observations, not performance gates or RPC timings.
Reproduce with `cargo run --offline --locked -p plur1bus-engine --example token_count_measure` and the prepared cache.

| Family | Method | 200 items (ms) | Maximum absolute Golden deviation (tokens) |
|---|---|---:|---:|
| claude-v1 | heuristic | 0.896 | no admitted reference |
| claude-v2 | heuristic | 0.592 | no admitted reference |
| deepseek-v4 | heuristic | 0.500 | no admitted reference |
| gemini-unpublished | heuristic | 0.518 | no admitted reference |
| gemma3 | heuristic | 0.808 | license pending |
| gemma4 | heuristic | 0.871 | no admitted reference |
| glm | heuristic | 0.614 | no admitted reference |
| grok-unpublished | heuristic | 0.790 | no admitted reference |
| kimi | heuristic | 0.838 | no admitted reference |
| local-model | heuristic | 0.528 | model-specific source pending |
| o200k | exact | 42.839 | 0 |
| openai-unpublished | heuristic | 0.543 | no admitted reference |
| qwen3-8 | heuristic | 0.680 | no admitted reference |
| tekken | heuristic | 0.564 | no admitted reference |

Mean absolute o200k deviation is also zero tokens. No numeric accuracy is claimed for families without independent
reference counts; they remain labeled estimators. Original HF artifacts for Gemma 4, DeepSeek V4, Qwen 3.8 and GLM
still require network access and license/source verification before they can be admitted and measured.
