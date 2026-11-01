# TM2 / PT-2: task and arm preparation, A2 fix round

This delivery updates #860 on `codex/tm2-team-eval`. Scope is Controller A2 only. #853 and #820 are owned by other
sessions and are unchanged by this work. Main is integrated by merge, never rebase. This remains preparation;
**PT-2 runtime, model-quality and throughput acceptance are not complete.**

## Current implementation

- Eighteen original MIT tasks, twelve decomposable and six coupled, across TypeScript/Python/Rust/Go. Four tasks now
  have four/five packages; the corpus has sixty package scopes plus eighteen integration scopes. For three seeds,
  self-tests grade 234 scopes on start and reference, plus isolated/partial implementations and ownership diffs.
- Neutral functional prompts and explicit runtime contracts. Public inputs contain only starting source, `TASK.md`
  and allowlisted metadata. Symbols, names, numeric literals and transport algorithms vary with the seed. All 108
  start/reference variants are materialized twice and byte-hashed; Git enforces LF.
- Real shared language modules and typed predecessor `Packet` state. Later coupled scopes include prefix cases using
  actual preceding implementations, plus stale/corrupt-state cases. Calendar slots, route summaries, document lookup
  records and log error-rate modules create larger interfaces. Difficulty remains subject to the K2 single-arm pilot;
  target roughly 40–80% resolution before freezing a baseline. Initial per-task caps are explicitly provisional.
- A caller-owned `{ family, params }` registry with canonical IDs, separate unknown/unbound-family errors, bounded
  JSON serialization matching K2 and no dead future-family types. Matched tokens/rounds/wall time come directly from
  the task; natural comparisons name complete allocations per canonical ID. Capabilities grant no tool authority.

## A2 review fixes and evidence

| Findings | Result |
| --- | --- |
| H1 | Exact macOS Go/Python workflow steps are covered by the workflow contract. The entire CI-script group is required before every push. |
| H2, M1 | Oracle/seed stay in the host; input-only stdin bridges run in private PID/filesystem namespaces. Linux acceptance proves oracle-path hiding and outside-write denial. The port owns process groups, TERM/KILL escalation, orphan cleanup, output bounds and one overall deadline. CLI termination cleans its snapshot. |
| M2 | Known-good language compile/run preflight; repository Rust channel; post-preflight errors, executable self-deletion and tampered public metadata remain candidate failures. |
| M3 | Every TASK.md states runtime, entry points, neighbor files and I/O; TS enum and Python neighbor solutions pass. |
| M4 | All twelve previously surviving mutants lose behavioral cases; NUL travels through stdin. Frame integrity and malformed predecessor states have dedicated cases. |
| M5, M6 | 3/4/5-package graphs, shared interfaces, real coupled prefixes, distinct provisional caps and neutral functional instructions. Live difficulty calibration remains a K2 gate. |
| M7, L6 | Registry and stable IDs; explicit extension errors; complete allocations tied to tasks. |
| L1 | Expensive language/task proofs are split into separate shardable files; weights use actual Linux measurements, with separate macOS provenance. Native Windows timings remain pending a Windows run. |
| L2–L5 | 108 deterministic variants, LF attributes, formatted/documented code, shared manifest parser, cleanup after failed traversal and seeded symbols/logic. |
| L7 | K2 #868 revision c25213ee supplies the recorded checker/report/environment contracts; no competing live report or model runner. |

The Linux acceptance runs as an ordinary user in a two-CPU Linux arm64 VM with Node 24.21.0, Rust 1.95.0,
Go 1.27.1 and Python 3.13.18. macOS uses Node 24.21.0, Rust 1.95.0, Go 1.27.1 and Python 3.13.13.
These are local test environments, not GitHub runner or model-performance claims. Windows follows the owner's K2/D123 Q6
ruling: typed `platform-unavailable`, no unisolated fallback, Job Object implementation deferred. Its materialization
and contract tests continue to run; process/live tests assert the refusal, with no platform skips.

The old `functional smoke (win-arm64)` failure was inspected once in run 41298748618. It exhausted the unchanged
60-second embedding-model warm-up budget (`models.warm`), before smoke acceptance. #860 does not change that workflow,
smoke test, warm-up helper, Engine pin or runtime entry graph. This is separate from the reproducible H1 workflow
contract failure, which this round fixes. No warm-up limit is weakened and no CI polling is used.

Long local tests write logs. Publication runs the required checks sequentially: `pnpm lint`, Core tests, WebMCP tests,
`pnpm docs:check`, then all `node --test scripts/ci/*.test.mjs`. The PR records the final results and read-only Claude
review. No new product dependencies, RPC/config schema changes, migrations or Engine pin changes are introduced.

## Remaining PT-2 gates

1. K2 #868 is open and absent from this main base. Its B1 runner, provisioner and public report remain the sole live
   path. Integrate the team adapter after K2 merges, replacing pinned contract metadata with direct K2 imports.
2. Pilot/calibrate task difficulty, then capture real paired model evidence and throughput at 1/2/4 concurrent local
   requests, peak memory and overcommit slowdown. No fixture result substitutes for these measurements.
3. Replace `fanout-eval.ts`, its test, `m5-fanout-eval.mjs`, `eval:m5`, the old timing entry and demo commands together
   with that B1-backed evaluation. Keep old replay JSON as historical wiring evidence.
4. Add executable `explore+single` last, after #853 is on main; merge that main first. `team` and `best-of-n` remain
   extension points. TM3/#820 and TM4–TM5/K1 dependencies are not advanced by this A2 round.
