# TM1 / PT-1: collaboration limits and concurrent children

Implementation of D124 PT-1. Specification: [PR #852](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/pull/852).
The branch is `codex/tm1-collaboration-concurrency`, stacked on
[PR #843](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/pull/843). Its integration base is `86510a60d9`.
The Controller owns merges; no CI checks were polled.

## Behavior

- Schema-owned read-helper, consult-pair, project-writer and task-class limits, with narrowing project settings.
- Per-delegation work allocation and deadlines, separate from per-call output limits and the bounded return envelope.
- Nonblocking `consult_agent` and `delegate_task`, turn-owned `await_delegations`, cancellation with partial results,
  card-bound child lifetime and trace completion after all registered children settle.
- Synchronous reservations before asynchronous preparation; rollback on preparation and storage failures; writer slots
  per project, reader and pair allowances per calling turn.
- CPU/RAM capacity facts and explicit overcommit warnings. The future provisioner-backed team scheduler enforces the
  configured positive disk floor; TM1 creates no worktrees. Read-only nesting cannot widen the caller's tool view;
  writer tools require both the contract and a trusted receiver view, otherwise the view is empty.
- Automatically joined results preserve peer provenance and untrusted-data tags, pass through redaction and size caps,
  and are persisted through a harness completion sink. Provider-reported results still cannot bypass a dispatcher.

`collaboration.fanoutEnabled` and `collaboration.teams.enabled` remain false by default.

## Owner's settings ruling, 2026-11-01

There is **no SQLite migration** and **no RPC schema change** in TM1. Versionless settings JSON treats exactly the old
defaults `maxDepth: 1`, `maxFanout: 3`, `maxPairPerTurn: 2`, `maxTurns: 25`, `timeoutMs: 300000`, `returnTokens: 2000`
as absent on read. Non-default values remain. The next project save writes normalized overrides with
`settingsVersion: 2`; new projects use that marker immediately. Marked settings are never normalized again, including
an intentionally saved fan-out of 3. Reopening and saving a second time is idempotent.

RPC 1.16.0 is reserved for the first TM RPC extension, expected in TM3. TM1 does not use that reservation. Later
collab migrations follow the Controller's order #843 → #820 → TM; neither prerequisite migration is changed here.

## Evidence

The initial five concurrency tests failed before implementation: `wait` was unknown, and all eight concurrent
preparations passed limits intended to admit only three starts or two pair slots. The barrier now admits four children
before any finishes, for both consult and delegate tools, with **maximum concurrency 4** and no sleep synchronization.
A separate barrier confirms four writers in each of two independent projects.

Additional red regressions covered nested authenticated identity, secret redaction of automatic joins, project-scoped
writer reservations, failed task insertion and running-status updates, and explicitly empty nested tool scopes.
The first full Core run reported two failures (project writer isolation and the unchanged dispatcher-only registry
getter guard); both were corrected without changing those protections.

The final focused group includes the 32-helper collection boundary, with a regression reproducing 75 KB of valid
envelopes exceeding the old 64 KiB tool cap. The collector now uses the existing 1 MiB hard ceiling; individual return
and model-context caps are unchanged. Failure diagnostics never truncate unredacted provider error bodies.

The final focused regression group passed **46 tests, zero failures and no skips or TODOs** after that boundary
correction. TypeScript checking also passed.
This includes class and budget enforcement, JSON settings normalization, injected timers, D109 dispatch, real session
persistence, scope isolation, storage-failure recovery and rejection of late starts after a turn closes.

Claude Code 2.1.296 (`claude-sonnet-5-5`) reviewed the implementation in five read-only passes. The first findings were
fixed and regression-tested; the final delta review found no remaining actionable issue. Claude did not run tests;
the implementation session ran them. The last pass covered the collection-size boundary and bounded error diagnostics;
earlier passes covered provenance, lifetime, permissions, budgets, settings and the broader implementation.

The mandatory local gates run in this order before publication:

| Command | Result | Existing exclusions retained |
| --- | --- | --- |
| `pnpm lint` | Passed, zero failures | 3 acceptance TODOs |
| `pnpm --filter @plur1bus/core test` | Passed, zero failures | 22 platform skips, 12 acceptance TODOs |
| `pnpm --filter @plur1bus/webmcp test` | Passed, zero failures | 56 acceptance TODOs |
| `pnpm docs:check` | Passed | None |

The config-schema package also passed its 129 tests. Existing platform skips and documented acceptance TODOs are
retained; none was introduced, removed or weakened by TM1. No Rust code or Engine pin changed.

## Remaining gates

- Merge #843 before this stack and obtain the Controller's integration review; no target-branch merge is performed here.
- PT-2 supplies model-quality, throughput and memory measurements; this patch proves concurrency, not quality gains.
- H3 steering is absent from this base. Add its waiting/steering integration test when that contract lands.
- TM3 needs #820's worktree data. TM4/TM5 need K1's `plur1bus-tools` foundation; team scheduling, reviews and merge
  execution remain in their respective later packages.
