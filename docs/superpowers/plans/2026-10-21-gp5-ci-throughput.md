# GP5 CI throughput implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. Progress is recorded below; the user already authorized execution and one PR per phase.

**Goal:** Measure CI throughput, select affected suites without losing required coverage, and document cancellation and merge-queue readiness.

**Architecture:** Read-only bounded Actions snapshots provide the baseline. A dependency-free changes classifier selects jobs, while an independent fail-closed gate validates every selected job result. Existing macOS policy, browser partition verification and full main/nightly runs remain in force.

**Tech Stack:** Node 24.21, Git, GitHub Actions YAML, node:test, actionlint.

**Spec:** Owner's “Codex-Großpaket 5”, 21 October 2026, phases P1–P6; subsequent parts Q–U remain separate phase PRs.

## Global constraints

- One PR per phase; ready except real stacks. No merge, rebase, amend, force-push, stash or CI polling.
- Identity: Cyb3rb1ade <cyb3rblade@me.com>; keep trailers.
- No Engine pin or pnpm-lock.yaml changes in P phases. No new dependencies.
- Actions use 40-character commit SHAs. Main and nightly retain full coverage.
- Existing installation behavior changes require an Owner decision.

## Review focus

- Missing or malformed classifier outputs must fail the gate rather than accept skips.
- A cancelled required job must fail even if another job was intentionally omitted.
- Renames must classify both old and new paths; unknown paths run all suites.
- Pending runs and missing timestamps must not become zero-duration performance claims.
- Cancellation cause cannot be inferred reliably from the API; distinguish observed cancellation from supersession candidates.

### P1 — Actions measurement

Files: scripts/ci/timings.mjs, scripts/ci/timings.test.mjs, docs/handoffs/2026-10-21-ci-baseline.md, docs/ci.md.
Interface: collectSnapshot({repo, workflow, count, api?}) → Promise<snapshot>; summarize(snapshot) → summary; renderMarkdown(summary) → Markdown.

- [x] Write percentile, censoring, cancellation, pagination and API-error tests; observe failure before implementation.
- [x] Implement explicit-attempt pagination and nearest-rank timing summaries without dependencies.
- [x] Collect the last 50 ci.yml runs once, document denominator and unavailable data.
- [x] Run Node tests and hygiene; report unrelated baseline failures explicitly. Open ready P1 PR.

### P2 — Affected suites and fail-closed gate

Files: scripts/ci/changes.mjs, changes.test.mjs, gate.mjs, gate.test.mjs, .github/workflows/ci.yml, docs/ci.md.
Interfaces: classify({event, files, enginePinChanged}) → boolean category outputs; evaluateGate({changesResult, selections, results}) → errors[].

- [ ] Refresh origin/main and open PR inventory. Read existing combined Rust/TS unit job before splitting steps.
- [ ] Table-test docs-only, each category, shared schemas, lock/workflow/pin changes, unknown paths and renames.
- [ ] Table-test gate success/failure/cancelled/skipped/missing for selected and omitted jobs.
- [ ] Add changes job and docs/hygiene path; keep required Rust/TS checks and full main/nightly matrix.
- [ ] Validate YAML with actionlint, run script suites, record exact local evidence; open phase PR.

### P3 — Cancellation evidence

- [ ] Refresh main and PR inventory; compare existing concurrency in CI, desktop, Hermes, nightly, container and release workflows.
- [ ] Preserve the already implemented PR-only cancellation; document evidence rather than duplicate it. Add regression coverage where missing.
- [ ] Run relevant offline tests/actionlint; open separate phase PR.

### P4–P6 — Follow-up

- [ ] P4: inventory existing pnpm/Rust/browser caches; add only missing successful-save caches with lock/toolchain/OS keys.
- [ ] P5: use measured core file durations for 2–4 Ubuntu shards, prove exact file partition, inventory job timeouts and slowest 20 files.
- [ ] P6: add merge_group trigger and document Owner-only required-check/queue settings; repeat baseline once P2–P5 can be measured.

## Execution ledger

P1: 45 script tests passed, 1 existing audit-policy TODO, hygiene/actionlint/doc links passed. Fresh review found synthetic queued start timestamps; regression failed before the fix and now passes. Handoff regenerated from the same snapshot, with no additional CI queries.

2026-10-21: origin/main 1dae60f2ae; #655 action pin hygiene and #665 recovery merged. #662/#664 still open. Existing main already has PR-only concurrency, browser shards, test timing reporter and several caches. Changes will account for these instead of recreating them.
