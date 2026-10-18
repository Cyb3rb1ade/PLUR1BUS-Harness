# Performance budgets and HM4 Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. The owner already authorized execution in three separate branches and PRs.

**Goal:** Produce reproducible B1–B11 evidence and Hermes existing-harness/upgrade support without claiming unmeasured acceptance.

**Architecture:** Extend the existing benchmark using dependency-free Node scripts and fresh temporary homes. Keep new CI jobs separate from existing release jobs. Reuse client authentication and setup transaction primitives for HM4.

**Tech Stack:** Node 24.21, pnpm 10.28, Rust 1.95, Python standard library.

**Spec:** Owner's “Codex-Paket: Leistungsbudgets B1–B11 auf allen Targets und HM4 (16.10.2026)”; ADR-010, plugin-distribution spec and docs/milestones.md.

## Global Constraints

- Never change the primary checkout, backups, engine or Host-Addons repository.
- Three branches/PRs; merge origin/main normally between phases, never rebase/amend/force-push/stash.
- No new dependencies. No CI polling or merging PRs.
- At least 30 samples for p95, declared warmups, all outliers retained.
- B1 promotion requires three consecutive green CI runs and a separate justified commit.
- All changes and missing hardware evidence remain explicit in PRs.

## Review Focus

- Cold process is not cold OS cache: label cache state honestly.
- Spawn errors/timeouts must reap children before removing their temporary homes.
- Readiness includes successful RPC and a healthy engine; report the socket timestamp separately.
- Missing real models/hardware must be missing evidence, never a fabricated pass.
- HM4 must reject unapproved clients and preserve stores during upgrade failure.

### Task 1: Phase 1 startup evidence

Files: scripts/bench/{metrics,startup}.mjs, scripts/bench/metrics.test.mjs, tests/system/help-isolation.test.ts, .github/workflows/ci.yml, docs/reports/2026-10-16-perf-p1.md.

- [x] Read startup/CLI implementation and historical baseline.
- [x] Add nearest-rank raw-sample reports, repeated fresh-home starts, RPC health verification, bounded cleanup and B11 diagnostics.
- [x] Add an independent five-runner job, preserving existing job definitions.
- [x] Run local flat/real-model baselines; no production optimization justified by the measured local startup path.
- [x] Validate measurement tests, help isolation, typecheck and hygiene; record missing targets; create open PR.

### Task 2: Phase 2 budget catalogue and O6

Files: scripts/bench/reference-hardware.mjs, scripts/bench/budgets.mjs, docs/performance.md, docs/performance-reference-hardware.md.

- [x] Start codex/perf-p2-budgets-o6, merge origin/main normally.
- [x] Map every ADR budget to its owning measurement/test, policy and required runner; never use unit-test duration as a product benchmark.
- [x] Add a fresh-home, privacy-limited JSON/Markdown reference runner using available measurement paths; report unavailable probes explicitly.
- [x] Document owner instructions in German and English for macOS, Linux and Windows.
- [ ] Run affected tests, typecheck and hygiene; create open PR with known gaps.

### Task 3: Phase 3 HM4

Files: existing Python client/provider binding, Rust setup upgrade, additive hermes-host.yml job, catalog preparation, docs/milestones.md.

- [ ] Start codex/hm4-existing-harness from fresh origin/main, merge origin/main normally.
- [ ] Inspect existing device/client authorization, IPC discovery and coexistence contracts.
- [ ] Bind an approved restricted Hermes client to an existing full harness without core-token access.
- [ ] Add dry-run and transactional host-to-full upgrade using the existing store and rollback primitives.
- [ ] Prepare catalog submission files without submitting or including updater behavior.
- [ ] Verify fake-client attach/rejection, upgrade failure rollback and dry-run immutability on three OS in an additive job.
- [ ] Run affected Python/Rust tests, typecheck and hygiene; update milestone status with named evidence and owner gaps; create open PR.
