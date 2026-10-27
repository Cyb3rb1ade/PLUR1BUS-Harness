# RE-14/T3 usage calibration implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development for the cohesive Rust task and an independent review. Steps use checkbox syntax.

**Goal:** Learn an affine full-prompt estimate from reported inclusive usage, keyed by route, tokenizer family and the underlying counting method (RE-D27).

**Architecture:** Keep T2's raw item/prefix counts unchanged. A separate full-prompt count sums the raw items and applies one learned slope and one intercept. A bounded, versioned store lives under the supplied engine state directory; observations write at the explicit boundary and prediction uses memory only.

**Tech stack:** Rust 1.95, existing serde/serde_json and standard-library filesystem/locking primitives; no dependency changes.

**Spec:** [RE-14 brief](rust-engine/RE-14-token-counter.md), T3, and [rewrite plan](2026-10-23-rust-engine-rewrite.md) §2.6 rule 5; the user's ordered C package is the execution authority.

## Global constraints

- B #788 has actual `merged_at: 2026-10-27T01:55:34Z`; default `main` contains T2. Branch starts at `dabbf6a1b7a17bca528f0f886c5fc304bec5c696`.
- Only C: no T4 RPC, T5/Core consumers, runtime behavior changes, D work, provider endpoints or tokenizer license decisions.
- Tests first; no skipped, weakened or newly ignored tests. Existing engine parity and token goldens remain unchanged (RE-R1).
- One PR, normal commits/push only; author and committer `Cyb3rb1ade <cyb3rblade@me.com>`. No force-push/rebase/amend or merging. No active CI queries.
- The engine never parses provider wire fields. Normalized inclusive input is authoritative, and absent counts remain `None`, never synthetic zero.

## Review focus

- Already-normalized Anthropic totals must not receive cache reads/writes twice; table-based arithmetic is a separate explicitly typed numeric conversion.
- A full prompt composed of many items gets its affine intercept once; message/prefix memoization stays raw.
- Route/provider/platform/wire/model, family and underlying method changes must miss the old fit; calibrated predictions must not feed back as base estimates.
- Missing/zero inputs, insufficient or degenerate observations, outliers and extrapolation must retain honest method/bounds and finite arithmetic.
- A restart restores observations; malformed/newer/oversized state, concurrent writers and failed persistence must not silently discard or invent learned state.

## Design decisions

Provider adapters already expose inclusive `Usage.inputTokens`. `TokenObservation.reported` therefore accepts a small library-only `NormalizedTokenUsage` with optional `input_total`, `cache_read`, `cache_write` (not raw provider JSON). Missing input totals are not accepted observations. A separate `ProfileUsage` plus `normalize_profile_usage(&CacheUsageMap, &ProfileUsage)` converts host-extracted numeric parts: inclusive input passes through; exclusive input requires all disjoint parts known and uses checked addition. Callers choose the resolved profile/gateway usage map before conversion. They never run this conversion on normalized usage.

T2 `TokenCounter::count()` and `families()` keep their raw semantics. `count_prompt(&CountRequest, &CalibrationStore)` returns the raw `base: CountResult` and one `total: TokenBounds`, `method`, `calibration`. It sums base item counts before applying the affine fit. Without a route or usable fit it returns the unmodified summed base estimate. In particular an unobserved estimator family stays `heuristic`.

The fit uses a deterministic robust median of pairwise slopes and a median intercept on a bounded recent observation window. It needs at least six observations and at least two distinct base counts. Nonpositive/degenerate fits remain uncalibrated. Prediction bounds use robust residual dispersion, outward rounding and widening outside the observed range; these are empirical uncertainty intervals, not a provider guarantee. Raw `exact` and `tokenizer-text` counts remain raw; the full-prompt wrapper can be `calibrated`.

State is a closed version-1 JSON format under `<engine-state>/token-calibration.json`, containing numeric observations and route keys, never prompt text or credentials. Use an exclusive store lock, private temp file, sync and same-directory atomic replacement; a failed save leaves memory and prior state unchanged. Bound route keys, per-key observations and input file size explicitly. Unknown versions and corrupt state fail with typed errors. Base counting version 1 is the only accepted estimator version; `calibrated` observations are rejected to prevent feedback.

### Task 1: Calibration library with regression tests

**Files:** create focused `crates/plur1bus-engine/src/tokens/calibration*.rs` modules and `tests/token_calibration.rs`; modify `tokens/{mod,types}.rs` only as needed for the public library seam. No manifest/lock/schema changes.

**Interfaces:** `CalibrationStore::open(&Path)`, public observation/result/fit shapes, `TokenCounter::observe(&self, &mut CalibrationStore, &[TokenObservation])`, `TokenCounter::count_prompt(&CountRequest, &CalibrationStore)`, and numeric `normalize_profile_usage(&CacheUsageMap, &ProfileUsage)`. Plain inputs derive closed camelCase serde shapes and preserve `Option` fields.

- [x] Write tests before production code: synthetic `reported = 2 * estimated + 7` recovers slope/intercept and predicts 207 for raw 100; full-prompt multi-item aggregation applies +7 once and leaves raw/cumulative outputs unchanged.
- [x] Prove route/family/method/version isolation, no-data/insufficient/constant-x fallback, no calibrated feedback and missing-vs-explicit-zero observations.
- [x] Prove table-selected inclusive/exclusive conversion, no normalized double-count, missing parts stay unknown and overflow fails.
- [x] Prove gross outliers (including high-leverage x), noisy samples and extrapolation preserve robust fit and `lower <= tokens <= upper`.
- [x] Prove restart persistence, bounded retention, malformed/unknown-version/oversized input refusal, writer contention and failed-save rollback with real scratch filesystem operations.
- [x] Run the focused suite and record RED before implementing the missing behavior; retain log paths in the execution ledger.
- [x] Implement only the library behavior needed by those tests; run focused tests and `cargo test --offline --locked -p plur1bus-engine` GREEN (0 skipped/ignored).
- [x] Review the cohesive diff against the spec and code quality, fix verified findings, and record results.

### Task 2: Documentation and acceptance

**Files:** update `crates/plur1bus-engine/README.md`, RE-14 brief/controller status as appropriate and this plan's evidence. Do not claim T3 merged while its PR is open.

- [x] Document typed usage boundaries, single full-prompt intercept, fit sufficiency/limits, storage path/ownership/restart behavior and empirical uncertainty semantics.
- [ ] Verify `cargo fmt --all -- --check`, workspace Clippy with `-D warnings`, workspace tests with `--no-fail-fast`, and explicitly execute pre-existing ignored tests so no ignored test silently disappears from the report. Do not change unrelated failures.
- [x] Verify `pnpm lint`, `pnpm docs:check`, token goldens and table parity; no regenerated golden changes.
- [ ] Independent whole-branch review, normal owner-identity commit(s), one PR titled `RE-14/T3: calibration from reported usage`; draft if required acceptance remains red. Report concrete evidence and new limitations honestly.
- [ ] Record the resulting PR in the existing automation prompt; wait for its actual merge before pausing the automation. Never auto-merge.

## Evidence

- Initial `pnpm test:prep`: passed; pinned Node 24.21.0 / pnpm 10.28.0 / Cargo 1.95.0.
- Initial engine crate suite: passed, including installed o200k goldens; full log `/workspace/re-14-t3-baseline-engine.log`.
- Read-only contract audit: `/workspace/re-14-t3-contract-audit.md` (execution artifact).

### Final local verification (2026-10-27)

- 20 new calibration regressions; engine crate suite: 46 passed, 0 failed/ignored, including the installed pinned o200k count/ID goldens and table parity.
- `cargo fmt --all -- --check`, workspace all-targets Clippy with `-D warnings`, `pnpm lint`, `pnpm docs:check`, final source hygiene/doc links and toolchain checks: exit 0. Lint has 155 passing tests, 3 pre-existing Laya TODOs, 0 skips.
- `CARGO_INCREMENTAL=0 cargo test --offline --locked --workspace --no-fail-fast -- --include-ignored`: **2,632 passed, 5 failed, 0 ignored** across 130 targets, exit 101. This explicitly executed every pre-existing ignored test, including the passing 20-second fuzz run.
- The five unchanged failures are `supervisor::cpu::tests::bind_reaches_every_thread_of_a_tree_and_of_a_separate_root`, `whitespace_only_keys_are_refused_before_any_connection`, `stopping_the_daemon_leaves_no_process_of_the_cores_tree_running`, `a_supervisor_started_on_one_cpu_detects_every_core_and_widens_without_a_limit`, and `docker_connection_address_is_a_private_ip_like_apple`. Their source and behavior are outside C; no test was changed to conceal them. Full acceptance remains open and delivery is a draft PR.
- Independent review: spec compliant, no Critical/Important findings. The README incorporates the minor durability/lock-file clarification. No native macOS/Windows run, power-cut durability or real-provider statistical coverage is claimed.
- Source/package graph, provider table, generated vectors, token/engine goldens and licenses are unchanged. No T4/T5/D work or runtime integration.
