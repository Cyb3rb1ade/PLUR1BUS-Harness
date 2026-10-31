# R-2b Budget RPC Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** Expose the existing cache-read weight through RPC and add separate fresh-input and counted-token totals, with an explicit handoff for the Rust CLI.

**Architecture:** Reuse the existing budget setting, ledger and exact millionth arithmetic. Extend the closed RPC shapes additively. Keep existing raw counts and limits unchanged when no weight is supplied; apply the active weight to status at query time.

**Tech Stack:** Node 24.21.0, pnpm 10.28.0, TypeScript, SQLite, JSON Schema. Rust changes are restricted to mechanical RPC fixtures/tests.

**Spec:** Owner's R-2b instruction in this chat (2026-10-31), `docs/budgets.md` follow-up 6, and `AGENTS.md`.

## Global Constraints

- No Rust CLI logic. A Claude agent implements that in a separate PR.
- No new dependency, store migration, price or money dimension.
- No skipped/disabled/quarantined tests; no rebase, amend, force push or merge.
- Keep `budget.status/1`, `budget.set/1` and all existing response fields.
- RPC 1.10.0 remains reserved for #820. Use the next unallocated minor after checking main; record the allocation in the PR.
- Documentation is English; the PR text is German and includes `Übergabe Rust-CLI`.
- R-2b precedes V1 because both edit RPC and budget integration files. V1 does not wait for R-2b's Rust CLI.

## Review Focus

- Explicit zero must set the weight; omitted weight must preserve it.
- Bad combined settings must not leave partial persisted changes.
- Round counted tokens once per requested aggregate, including agents with several models.
- Inconsistent provider cache counters must not create negative fresh-input totals or change legacy raw counters.
- Older responses without additive fields and existing authorization rules must remain valid.

### Task 1: Budget status breakdown

**Files:** `packages/core/src/budget/service.ts`, `packages/core/test/budget/status-breakdown.test.ts`, existing service expectations.

**Interfaces:** `BudgetStatus.cacheReadWeight: number`; each existing usage total gains `freshInputTokens: number` and `countedTokens: number`. Raw `inputTokens`, `cacheReadTokens`, `cacheWriteTokens`, output and media counts retain their meanings.

- [x] Write and run failing tests for 1,000 input / 900 cache reads / 50 cache writes / 100 output: fresh input 50; counted total 1,100 at weight 1, 290 at 0.1, 200 at 0.
- [x] Test per-model, per-agent, filtered and empty aggregates; two models with one cached token each count one token at weight 0.1 when grouped together.
- [x] Test per-event fresh-input clamping: `max(0, input - reads - writes)` before aggregation; raw counters are retained.
- [x] Implement SQL aggregates and exact counted-token totals using existing `countedTokens` arithmetic.
- [x] Run all budget service/call tests, updating only expectations affected by the additive fields.

### Task 2: RPC schema and settings

**Files:** RPC schema/fixtures/tests, `packages/core/src/rpc/methods.ts`, budget service settings, `packages/core/test/budget-rpc.test.ts`.

**Interfaces:** `budget.set` accepts optional `cacheReadWeight: number` in [0,1]; `budget.set` and `budget.status` return the active weight. Additive result properties remain optional in the schema for older producers. Method introduction versions remain 1.5.0; additions document their new minor.

- [x] Write failing schema and RPC tests for 0/1, fractional normalization, invalid/unknown fields, persistence, omission preserving settings and limits, and combined invalid settings leaving state untouched.
- [x] Expose the existing setting without duplicating weighting logic; apply a combined settings change in one transaction.
- [x] Bump the unallocated RPC minor; regenerate source types, Python metadata and docs. Update only mechanical Rust RPC assertions/fixtures as needed.
- [x] Run schema, budget RPC and existing authorization regressions.

### Task 3: Documentation, handoff and verification

**Files:** Budget module README, `docs/budgets.md`, generated RPC docs, PR body.

- [x] Document raw input versus fresh input and counted totals, active weight, compatibility and rounding.
- [x] Write `Übergabe Rust-CLI`: commands/options, RPC methods and generated schema/type names, human and raw JSON outputs, existing exit codes/errors and required tests. Mark the CLI as pending rather than advertising an implemented flag.
- [x] Run `pnpm lint`, affected package tests and `pnpm docs:check`; if RPC Rust files change, run format, RPC Clippy and RPC tests.
- [ ] Commit the reviewed change with the owner's identity, push normally, open a ready PR and attach it to this chat.
- [ ] Proceed directly to V1 in an isolated branch; record this ordering in its PR text.
