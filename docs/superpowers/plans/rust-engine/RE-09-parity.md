# RE-09 — Parity harness, golden vectors, CI job

**Package.** The one runner that drives the Node engine and the Rust engine through the same scenario files, records
goldens from the Node side, diffs the Rust side against them under a stated tolerance, reports side by side (CP-4c),
and runs in CI — first advisory, then as a dependency of `ci-gate`. It is the exit gate of Phase 1 and the regression
suite afterwards. Size M, continuous (every brief adds scenarios).

**Depends on.** RE-01 (scenario format uses the contract types), RE-08 T2 (the Rust side runs as a process).
**Enables.** Phase 1 exit; RE-06 T0 (go/no-go) reads its report.

**Assumes.** RE-D1 (the Rust side is a process; the runner talks RPC to it).

**Read first.**
- Plan §2.3 (phase gates), RE-9 in §4, §3.5 (CP-4c), §5.2 (LLM non-determinism → recorded fixtures), RE-R1.
- `docs/ci.md` (the `changes` plan, `ci-gate`, the `UNGATED` and `ADVISORY` lists, the promotion rule: add to `needs`,
  remove from `UNGATED`, the workflow contract test must agree), `scripts/ci/changes.mjs` (outputs `rust`, `ts-core`,
  `web`, `python`, `docs-only`, `workflows`, `engine-pin`, `documents`, `proceed`), `scripts/ci/gate.mjs` (`UNGATED`,
  `ADVISORY`, `selections`, `evaluateGate`), `scripts/ci/gate.test.mjs`, `scripts/ci/workflow-contract.test.mjs`,
  `.github/workflows/ci.yml` (the `unit` job's install steps with `GH_ENGINE_READ_TOKEN`, the `system` job's real-model
  setup and `PLUR1BUS_CI_RECALL_HARD_MS`), `tests/system/helpers.ts`, AGENTS.md "Tests lokal" and the env var list,
  `packages/core/src/bin.ts` (how the Node engine is constructed with `testInternals`), `tests/system/redaction-everywhere.test.ts`
  (the secret markers).
- The engine repository's golden tests (`tests/recall-golden*.test.js`) — the first scenarios translate them.

**Rules that apply.** A golden is recorded from the Node engine by the runner, never written by hand; a golden diff
in a PR cites a CP id or a decision id in the commit body (RE-R1). The runner never skips silently: a missing engine
package, binary or model cache fails with the command that fixes it. No network: LLM answers are recorded fixtures keyed
by prompt hash (so prompt drift surfaces as a missing fixture, not a different answer).

## Files

- Create: `tests/engine-parity/README.md`, `tests/engine-parity/run.ts`, `tests/engine-parity/lib/{scenario,node-side,
  rust-side,diff,report,fixtures}.ts`, `tests/engine-parity/scenarios/<area>/*.json`, `tests/engine-parity/golden/<area>/*.json`,
  `tests/engine-parity/llm/*.json`, `tests/engine-parity/run.test.ts` (unit tests of the diff and tolerance logic)
- Modify: `.github/workflows/ci.yml` (job `engine-parity`; later a second `system` matrix leg with `engine: rust`),
  `scripts/ci/gate.mjs` (`UNGATED` first, then `needs`), `scripts/ci/gate.test.mjs`, `scripts/ci/workflow-contract.test.mjs`,
  `docs/ci.md`, `tests/system/helpers.ts` (`PLUR1BUS_ENGINE_IMPL`), `package.json` (`"parity": "node --experimental-strip-types tests/engine-parity/run.ts"`)
- Test: `tests/engine-parity/run.test.ts`; the scenarios themselves

## Interfaces

**Consumes:** the Node engine from `packages/core/node_modules` (`createEngine`, `testInternals`), the Rust engine
binary (`target/debug/plur1bus-engine` or `PLUR1BUS_ENGINE_BIN`) over RPC (RE-08's `EngineClient` is reused as the
client), RE-01 types for the scenario schema, the fixtures each brief records (`tests/fixtures/**/record.mjs` write
goldens into this folder's layout).

**Produces:**

```text
Scenario file (tests/engine-parity/scenarios/<area>/<name>.json):
{ "schema": "engine-parity.scenario/1",
  "store": "store-v1" | "store-v1-scored" | "empty",
  "config": { …engine config overrides… },
  "seams": { "embedder": "flat" | "hash" | "real", "reranker": "none" | "fixture:<file>" | "real", "llm": "fixture:<file>" | "none", "clock": <ms> },
  "steps": [ { "op": "capture" | "recall" | "checkpoint" | "jobs.run" | "memory.<op>" | "admin.<op>" | "snapshot" | "adopt",
               "args": { … }, "expect": "golden" | { …inline… }, "tolerance": "default" | { …overrides… } } ] }

Golden file (golden/<area>/<name>.json): { "schema": "engine-parity.golden/1", "recordedFrom": { "engine": "node", "commit": "<pin>", "at": "<iso>" },
  "steps": [ { "result": <normalised result>, "trace": <normalised trace> } ] }

Tolerance (default): ordered ids exact; block names and texts exact; deferrals exact; counts exact; timestamps,
  durations, `timing.*`, run ids ignored; floats (scores) |Δ| ≤ 1e-6 unless the step says otherwise; trace compared by key
  set and by the numeric fields the scenario lists under "trace.compare".

CLI: run.ts --record <scenario|dir> (Node side → golden), --check <scenario|dir> (both sides → diff, exit 1 on any),
     --compare <scenario> (both sides side by side, CP-4c reporter), --report <out.md> (the Phase 1 exit table)
Env:  PLUR1BUS_ENGINE_BIN, PLUR1BUS_MODELS_CACHE (for "real" seams), PLUR1BUS_ALLOW_TEST_INTERNALS=1 (seams)
```

## Tasks

### T1 — Runner, format, tolerance, first scenarios (one pull request)

- [ ] **Step 1: failing tests** `tests/engine-parity/run.test.ts`: `the diff ignores timestamps and timings but not ids`,
  `a float within tolerance passes and one outside fails with the path named`, `a missing golden fails with the record
  command`, `a missing llm fixture fails with the prompt hash and the prompt's first 80 characters`, `a secret marker in
  any result fails the run` (the markers of `redaction-everywhere.test.ts`).
- [ ] **Step 2: implement** `run.ts` and `lib/*`: the Node side constructs the engine exactly as `bin.ts` does (same
  `testInternals` for `flat`, a `hash` embedder identical to RE-04's `HashEmbedder`), the Rust side starts
  `plur1bus-engine serve` on a copy of the fixture store with the same seams through env, both run the steps, results
  are normalised (sorted keys, volatile fields removed), diffed, reported.
- [ ] **Step 3: scenarios** `recall/plain`, `recall/temporal`, `capture/one-turn`, `ops/list-show-forget` recorded with
  `--record`; `--check` passes trivially for the Node side against itself (a self-check mode `--check --node-only`).
- [ ] **Step 4: commit** `RE-09/T1: parity runner, scenario format, first scenarios`.

### T2 — CI job, advisory (one pull request)

- [ ] **Step 1: failing tests** in `scripts/ci/gate.test.mjs` and `workflow-contract.test.mjs`: `engine-parity is
  selected when rust, ts-core or engine-pin is true and is UNGATED`.
- [ ] **Step 2: implement** the `engine-parity` job in `ci.yml` (ubuntu-24.04; the `unit` job's install steps; `cargo
  build -p plur1bus-engine`; `pnpm parity -- --check tests/engine-parity/scenarios --report $RUNNER_TEMP/parity.md`;
  upload the report as an artifact), `UNGATED` entry, `docs/ci.md` row with the promotion criterion: two weeks green on
  `main` and every PR, then move to `ci-gate` `needs`.
- [ ] **Step 3: commit** `RE-09/T2: engine-parity CI job (advisory)`.

### T3 — The real-model leg and the system matrix (one pull request, after RE-08 T5)

- [ ] **Step 1:** a second `engine-parity` matrix entry with `seams.embedder: real` for the RE-03 parity scenarios
  (`PLUR1BUS_MODELS_CACHE` restored from the actions cache the `system` job uses; the leg is `continue-on-error` until
  its first green run, like the Hermes Windows leg), and a `system` matrix leg `engine: rust` that sets
  `PLUR1BUS_ENGINE_IMPL=rust` for the existing system suites.
  `PLUR1BUS_ENGINE_IMPL=rust` for the existing system suites. The real-model entry also runs the jina goldens of
  RE-03 T3c and T4, on files fetched only where the owner's consent covers the download (CC-BY-NC-4.0, RE-D19). The T5
  exit report states their result.
- [ ] **Step 2:** `docs/ci.md` and AGENTS.md (the env var) updated. **Commit** `RE-09/T3: real-model parity leg and
  system matrix on the Rust engine`.

### T4 — Promotion to the gate (one pull request, when the criterion is met)

- [ ] Move `engine-parity` from `UNGATED` to `ci-gate`'s `needs`; `gate.test.mjs`, `workflow-contract.test.mjs`,
  `docs/ci.md` and CLAUDE.md's gate description updated in the same PR. **Commit** `RE-09/T4: engine-parity gates`.

### T5 — The Phase 1 exit report (no code)

- [ ] `pnpm parity -- --check tests/engine-parity/scenarios --report docs/evidence/engine-parity-phase1.md` on the
  heads of the last RE-04…RE-08 PRs; the controller attaches it to the README status table and to RE-06 T0.

## Acceptance

- `pnpm parity -- --check` green for every committed scenario on `main`; the report lists scenario × engine × outcome.
- The job runs on PRs that touch `crates/plur1bus-engine/**`, `packages/core/src/engine/**`, `tests/engine-parity/**`
  or the engine pin; it is advisory until T4 and gating after.
- Every brief's `record.mjs` writes into this folder's layout (RE-02…RE-07 reference it).

## Out of scope

Performance benchmarking beyond the hop budget (RE-08 T5) and the reference-hardware recall acceptance
(`tests/system/two-session-recall.test.ts`, unchanged); a UI for the report.

## Hand-off

Four PRs plus the report. T1 and T2 can start as soon as RE-01's types exist (the Node side alone); the Rust side is
exercised once RE-08 T2 merges. Keep `run.ts` under 600 lines by keeping the per-side adapters in `lib/`.
