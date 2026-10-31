# Parallel agent teams — implementation plan

**Goal.** Replace the constant fan-out guardrails by limits governed by budget and capacity, make delegations started in
one step run concurrently, and build a coding team mode that does what the controller does with external agents today:
a lead plans work packages with dependencies and file ownership, one writer per worktree and branch, a fresh-context
reviewer per package with capped fix rounds, a merge queue with a fixed order, stacks retargeted by merge, CI gates and a
merge only a person confirms, resumable after a restart. Add best-of-N, a router that learns between single agent, team
and best-of-N as a local contextual bandit, and an evaluation that decides the defaults. Specified in
[`2026-11-01-parallel-agent-teams-design.md`](../specs/2026-11-01-parallel-agent-teams-design.md), cited as "spec §n";
register entry D124, proposed (Q1).

**Architecture.** Orchestration extends the TypeScript `collab/` module: the scheduler drives TypeScript turns, the D109
dispatcher, the call budget and the collab store, and the merge queue extends PR #820's provisioner, the single git
implementation D115 §6.5 asks for; this is ADR-019 (3) ("changes to existing TypeScript code that are not new components
stay TypeScript", D120 §13), argued in spec §6.3. The new pure components, the plan checker and the router, are Rust in
`plur1bus-tools` behind `x-server: "tools"` (ADR-019 (1)).

**Status.** Plan only, no product code. Owner intents of 2026-11-01 are binding (spec §2); Q1–Q20 are open (spec §16).
None blocks PT-1 or PT-2: they ship with the recommended defaults behind configuration. PT-6 and PT-7 wait for Q6, PT-7
also for Q18, PT-12 for Q13 and Q14, PT-14 for Q15.

**Constraints.**
- **RPC.** JSON Schema is the single source: closed params, `x-stability: "experimental"`, `x-since` set to the next free
  minor **at implementation time** (1.11–1.14 are taken by open PRs #835, #843, #838 and #820). No new RPC error codes;
  new reason strings go into `docs/errors.md`. **Every human-only method goes into `FORBIDDEN_EXACT` in
  `packages/webmcp/src/provider.ts`**; `packages/core/test/protocols/exposure-matrix.test.ts` enforces it.
- **Config.** Every new key has `x-restart` and `x-tier` (ADR-013); project overrides may only narrow (D115 S3).
- **Security.** Only a person approves, grants or merges (D109); an agent message is never an approval; no history rewrite,
  force, reset or rebase by the core; secrets never in briefs, logs or `plur1bus-tools` (D120 §5).
- **Tests.** TDD, red test first. No `sleep` synchronisation (barriers, readiness signals, injected clocks). No network in
  tests. Never skip, disable or quarantine a test to get green.
- **Measurement.** Every package that changes behaviour attaches its delta against the PT-2 baseline; no default flips
  without an owner decision (the D120 delta rule).
- **Executor.** Every Rust package is done by a Claude agent, never Codex unless the owner makes an explicit exception.
  TypeScript packages: the controller's choice (Sonnet-suitable unless marked Opus).
- **Process.** One branch and one ready PR per package. No CI polling: push, open the PR, report the number, stop. No
  force-push, rebase, amend or stash. Commits carry the owner's identity.

## Work packages

| WP | Scope | Files | Language | Executor | Estimate (agent days) | Depends on |
|---|---|---|---|---|---|---|
| **PT-0** | Register entry D124, the ADR-003 guardrail table and the removal of the "proposed amendment" note, a milestones row; after the owner's answers | `docs/superpowers/specs/2026-09-24-m1b-2a-core-daemon-cli-design.md` §2, `docs/adr/ADR-003-agent-model-and-collaboration.md`, `docs/milestones.md` | docs | Claude | 0.5 | owner decisions |
| **PT-1** | Limits by class from one source; work budget separated from the return cap; per-delegation deadlines by task class; read-only depth 2; `wait: false` and `await_delegations`; structured concurrency; the start-slot race closed; the concurrency proof | `packages/core/src/collab/{limits.ts (new),defaults.ts,guardrails.ts,types.ts,service.ts,store.ts,migrations.ts}`, `packages/core/src/tools/collaboration.ts`, `packages/core/src/composition/{collaboration.ts,provider.ts}`, `packages/config-schema/schema/config.schema.json`, `packages/core/test/collab/{concurrency.test.ts (new),guardrails.test.ts,tools.test.ts,project-store.test.ts}`, `docs/collaboration.md`, generated `docs/config.md` | TypeScript | Sonnet or Opus | 2.5 | — |
| **PT-2** | Evaluation: team tier (12 decomposable, 6 coupled tasks), arms and budgets of spec §11, MAST tags, nightly advisory job, baseline; replaces `fanout-eval.ts` | `tests/bench/coding/team/<id>/` (new), `packages/core/src/toolcall/coding-bench.ts` (D120 B1's runner), `packages/core/src/collab/team-eval.ts` (new; `fanout-eval.ts` and its test removed), `scripts/eval/team-eval.ts` (new; `scripts/m5-fanout-eval.mjs` removed), `.github/workflows/nightly.yml`, `docs/evals/2026-11-baseline-team-eval.md` (new), `docs/turn-eval.md`, `docs/ci.md`, `docs/collaboration.md` | TypeScript and fixtures | Sonnet | 5 (4–6) | PT-1; D120 B1 runner (or builds it, see PT-2) |
| **PT-3a** | Team data model, plan schema, core RPC (run, plan and package methods), roles and events | `packages/core/src/collab/{migrations.ts,types.ts}`, `packages/core/src/collab/team/{store.ts,plan.ts}` (new), `packages/core/src/collab/schemas/teamplan.schema.json` (new), `packages/rpc-schema/schema/rpc.schema.json` and fixtures, `packages/core/src/rpc/collab-surface.ts`, `packages/core/src/rbac/{guard.ts,policy.ts}`, `packages/webmcp/src/provider.ts`, `docs/errors.md`, generated `docs/rpc.md` | TypeScript and schema | Sonnet | 3 | PT-1; PR #820 merged (migration order) |
| **PT-3b** | Plan checker in Rust: DAG, ownership disjointness by glob intersection, merge order against dependencies, overlap prediction, diff against ownership | `crates/plur1bus-tools/src/team/` (new), `tools.team.check` and `tools.team.diffcheck` in the schema with fixtures, `crates/plur1bus-tools/tests/team_*.rs` | Rust | Claude agent | 2 | D120 H1-1; PT-3a (plan schema) |
| **PT-4** | Scheduler: admission (spec §7.4), call-budget scopes `team` and `package` (call schema 3), card worktrees per package with stacks, writer briefs, native writers, lead turns, team agent tools, pause, cancel, steering hooks, failure handling, resumability and the kill test | `packages/core/src/collab/team/{scheduler.ts,admission.ts,brief.ts,resume.ts}` (new), `packages/core/src/budget/calls.ts`, `packages/core/src/tools/collaboration.ts`, `packages/core/src/composition/{index.ts,collaboration.ts}`, `packages/log-schema/schema/catalogue.json`, `docs/budgets.md`, `docs/collaboration.md` | TypeScript | Opus | 6 (5–7) | PT-1, PT-3a, PT-3b, #820 merged; its PR carries the PT-2 delta |
| **PT-5** | Review loop: D98 checks before review, fresh-context reviewer per round, findings with severity, fix rounds capped at 5, repetition detector, adjudication, ownership and interface checks | `packages/core/src/collab/team/review.ts` (new), `packages/core/src/collab/coding-surface.ts`, `packages/core/src/tools/collaboration.ts` | TypeScript | Sonnet or Opus | 3 | PT-4 |
| **PT-6** | Merge queue, local sink: fixed order, retarget by merge, merge preview, gate on the exact tree, `team.merge.confirm`, merge commit; provisioner `mergePreview`/`merge`/`revert` to D115 §6.5, prune and orphan detection | `packages/core/src/external-agents/provisioner.ts` (#820), `packages/core/src/collab/coding-surface.ts` (provisioner interface), `packages/core/src/collab/team/merge-queue.ts` (new), schema and handlers for `team.merge.*`, `packages/webmcp/src/provider.ts` | TypeScript | Opus | 4 | PT-5; Q6 |
| **PT-7** | Forge sink: push the run's `p1b/` branches under a task-scoped grant, stacked pull requests, required checks as the CI gate, merge by the person on the forge or by API after `team.merge.confirm`, retarget dependents after an upstream merge | `packages/core/src/collab/team/forge.ts` (new), grant capability rows, `docs/collaboration.md` | TypeScript | Sonnet | 3 | PT-6; the GitHub credential profile (D115 WP4b); Q6, Q18 |
| **PT-8** | External workers: ACP CLIs as writers (session per package, `cwd` = package worktree, approvals to the team panel, resume through `session/load` where supported, else the resume brief); A2A peers as read helpers and reviewers | `packages/core/src/external-agents/delegation.ts` (#820), `packages/core/src/collab/team/workers.ts` (new) | TypeScript | Sonnet | 2.5 | PT-4; #820 merged (D123 SB-5 later swaps containment underneath) |
| **PT-9a** | Web team view: lanes per package, rounds, token burn against allocation, wall time, findings, merge queue order and reorder, one approvals panel, router explanation; de and en | `packages/web/src/pages/projects/{team-view.ts (new),page.ts,rpc-types.ts}`, i18n catalogues | TypeScript | Sonnet | 3 | PT-4; PT-6 for the queue lane |
| **PT-9b** | CLI `plur1bus project team status\|approve\|pause\|resume\|cancel\|merge` | `crates/plur1bus/src/commands/{project.rs,project_team.rs (new)}`, `crates/plur1bus/tests/cli_surface.rs` | Rust | Claude agent | 1.5 | PT-3a |
| **PT-10** | Best-of-N: N attempts in worktrees, tests-first selection, pairwise tournament judge, early stop, optional distill-refine, budget caps, evaluation arm | `packages/core/src/collab/team/best-of-n.ts` (new), `packages/core/src/collab/verifier.ts` (oracle run) | TypeScript | Sonnet or Opus | 3.5 | PT-4, PT-2 |
| **PT-11** | Router, heuristic stage: features, rules and hard masks of spec §8.3, overrides, explanation records | `crates/plur1bus-tools/src/router/{features,heuristic,explain}.rs` (new), `packages/core/src/collab/team/route.ts` (new; collects features), `tools.router.decide`/`explain`, `team.route.explain` | Rust and TypeScript | Claude agent | 2.5 | H1-1, PT-2, PT-3b |
| **PT-12** | Router, contextual bandit: linear Thompson sampling, rewards and delayed updates, propensities, shadow mode, exploration cap, decay, store, reset | `crates/plur1bus-tools/src/router/{bandit,reward,store}.rs` (new), `tools.router.outcome`/`reset`, `team.route.reset` | Rust | Claude agent | 3 | PT-11; outcome signals from PT-5 and PT-6; Q13, Q14 |
| | **Total** | | | | **45** | |

**Follow-ups** (not in the total):

| WP | Scope | Files | Language | Executor | Estimate | Depends on |
|---|---|---|---|---|---|---|
| PT-13 | Selective verification gate at three decision points (spec §10), off by default | `packages/core/src/collab/team/verify-gate.ts` (new) | TypeScript | Sonnet | 2.5 | PT-10, PT-2; Q17 |
| PT-14 | Local-only external benchmark runner: SWE-bench Verified and Terminal-Bench subsets fetched at run time, never vendored, never in CI, aggregate report | `scripts/eval/external-bench.ts` (new) | TypeScript | Sonnet | 2.5 | PT-2, PT-10; Q15 |

```text
 PT-1 limits + async delegation + concurrency proof ─┬─► PT-2 evaluation + baseline (GATE for PT-4 merge) ─────────────┐
                                                     └─► PT-3a data model + RPC ─┬─► PT-9b CLI                        │
 D120 H1-1 (plur1bus-tools skeleton) ───────────────────► PT-3b plan checker ◄───┘                                    │
 #820 merged ─────────────────────────────────────────────────► PT-4 scheduler + writers + resume ◄──────────────────────┤
                                                                  ├─► PT-5 review loop ─► PT-6 merge queue (local) ─► PT-7 forge sink
                                                                  ├─► PT-8 ACP and A2A workers
                                                                  ├─► PT-9a web team view
                                                                  └─► PT-10 best-of-N ─► PT-13 verification gate (later)
 PT-2 + PT-3b + H1-1 ─► PT-11 router heuristic ─► PT-12 contextual bandit (needs PT-5/PT-6 outcomes)
 PT-0 docs: after the owner's answers, alongside; gates nothing
```

## What can start now

- **PT-1** has no dependency and no pending owner answer (it ships the recommended defaults behind configuration).
- **PT-2's task authoring** (the 18 team-tier tasks with checkers and seeds) can start at once in parallel; its runner
  waits for PT-1 only if B1's runner is missing (see PT-2).
- **D120 H1-1** gates three Rust packages here (PT-3b, PT-11, PT-12) as it gates D123's SB-4; pulling it forward, as D123
  Q11 recommends, unblocks both.
- **#820** gates PT-3a's migration order, PT-4 and PT-8.

## Best first package: PT-1

PT-1 is small, independent and useful on its own: it removes the hard-coded limits from five files, lets a person raise
them by configuration, makes `delegate_task` asynchronous as ADR-003 describes it, closes the start-slot race, and proves
with a barrier test that delegations started in one step overlap. Every later package builds on its `CollabLimits` and its
concurrency.

## PT-0 — Register entry, ADR-003 and milestones (0.5 agent days; Claude, docs)

After the owner answers spec §16: enter D124 in the core spec's register; replace ADR-003's guardrail table with the
accepted limits and remove the "Proposed amendment (D124, pending owner decision)" note; add the D124 row to
`docs/milestones.md` with the accepted WPs. Checks: `node scripts/check-doc-links.mjs`, `node scripts/lint-hygiene.mjs`.

## PT-1 — Limits by budget and concurrency proof (2.5 agent days; Sonnet or Opus, TypeScript)

**Language:** TypeScript; it changes existing `collab/` and tool code (ADR-019 (3)).

- **One source.** `collab/limits.ts` resolves `CollabLimits` from `collaboration.limits.*` (read helpers per turn 8,
  ceiling 32 enforced by the schema's `maximum`; read-only depth 2; writers per project 4; per-pair consult limit 4; task
  classes of spec §7.2) and the project's narrowing overrides. `guardrails.ts` takes a call class (`read`, `write`,
  `review`); `tools/collaboration.ts` drops its constants (`:45`, `:49-50`, `:59`), `service.ts` drops the 300,000 ms cap
  (`:267`) and the chain-wide timer becomes a per-delegation deadline.
- **Work budget.** `composition/collaboration.ts:51` takes the delegation's token allocation instead of `budget.tokens`,
  and the delegated turn gets the class's round limit through a per-request round limit in place of the turn-wide
  default of 25 (`composition/provider.ts:738`); `returnContract.maxTokens` stays at most 2,000.
- **Depth by class.** A read-only delegation (scope tools all `read` effect) may start one more read-only delegation; a
  nested writer is refused with `depth`.
- **Concurrency.** `wait: false` on `consult_agent` and `delegate_task` returns `{ taskId }`; `await_delegations { taskIds,
  timeoutMs }` returns finished envelopes and the running ids; at the end of a turn unbound children are awaited up to
  their deadlines, then cancelled with partial results. The start slot is reserved before the first `await`.
- **Settings migration (Q20).** One collab-store migration drops stored project settings equal to the old defaults
  (`store.ts:87-91` wrote them in full).
- **Tests (red first):** the barrier test of spec §7.5 (four delegations, each blocked on a barrier released only when all
  four started; red on main because the second never starts; green after, maximum concurrency 4); a race test that issues
  starts concurrently against a limit of 3 and asserts exactly 3 admitted; class limits and ceilings; depth 2 read-only
  allowed, nested writer refused; a delegation running past 5 minutes on an injected clock is not killed by the old chain
  timer; the migration keeps a non-default value and drops a default one; a steer arriving during `await_delegations`
  (U13, coordinated with D120 H3-1 if it has landed).
- **Docs:** `docs/collaboration.md` guardrail table; `pnpm docs:gen` for `docs/config.md`.
- **Acceptance:** no collaboration limit constant remains in `tools/collaboration.ts`, `service.ts` or
  `composition/collaboration.ts`, and delegated turns no longer stop at the turn-wide 25 rounds;
  the barrier test passes; `collab/*.test.ts` stay green with the recommended defaults.

## PT-2 — Evaluation and baseline (5 agent days, range 4–6; Sonnet, TypeScript and fixtures)

**Language:** TypeScript; it extends D120 B1's runner (`coding-bench.ts`), which is TypeScript in the D120 plan.

- **Runner.** If D120 B1 has landed, PT-2 adds a team mode to its runner. If it has not, PT-2 builds B1's runner exactly as
  the D120 plan specifies (same file, same report schema, same nightly secret pattern), and B1 then only adds its 24
  tasks; there is never a second runner.
- **Team tier.** 12 decomposable tasks (3–5 packages each, a checker per package and an end-to-end checker; Rust,
  TypeScript, Python, Go) and 6 sequential or tightly coupled tasks, under `tests/bench/coding/team/`, MIT, seeded
  variants, hidden checkers (the D120 Q21 rules).
- **Arms and budgets** of spec §11: `single`, `single` at the highest effort, `single+review`, `explore+single` now;
  `team` joins with PT-4, `best-of-n` with PT-10. Matched and natural budgets.
- **Metrics** of spec §11, including MAST tags (rules over the trace map each failure to specification, inter-agent
  misalignment or task verification, with a step-repetition count; untagged failures are counted, not guessed) and the
  cache-read share (U12); rounds and wall time per task class to calibrate spec §7.2.
- **Replace** `collab/fanout-eval.ts`, its test and `scripts/m5-fanout-eval.mjs`; `docs/evals/m5-fanout.json` stays as a
  historical record, referenced from the new report.
- **Tests:** the fixture self-test per PR (every checker fails on the start tree and passes on the reference for three
  seeds; the coupled tasks really are coupled: their packages' reference diffs overlap); report schema tests; the canary
  secret test.
- **Acceptance:** the baseline for the four initial arms is committed as `docs/evals/2026-11-baseline-team-eval.md`
  (models, dates, denominators, no credentials); the nightly job uploads only the redacted report.

## PT-3a — Team data model and core RPC (3 agent days; Sonnet, TypeScript and schema)

**Language:** TypeScript; collab store, RPC surface and RBAC are existing TypeScript.

The tables of spec §6.4 in one migration after #820's; `plur1bus.teamplan/1` (closed, bounded: 32 packages, the D104
2,000-token rule per brief); `ProjectRole` gains `worker` and `reviewer`; `team.*` and `package.*` events; the methods of
spec §6.6 that do not depend on later packages (`team.create`, `team.get`, `team.list`; human-only `team.plan.approve`,
`team.pause`, `team.resume`, `team.cancel`, `team.package.reassign`, `team.package.budget.set`) with schema, fixtures,
RBAC rules (`humanOnly` where listed) and every human-only name in `FORBIDDEN_EXACT`. The merge methods come with PT-6,
`team.route.explain` with PT-11 and `team.route.reset` with PT-12, each with the same exposure rule. **Tests:** store
round trips; plan schema bounds; RBAC matrix; `exposure-matrix.test.ts` green with the new methods; a viewer and an agent
principal are refused on every human-only method. **Acceptance:** `pnpm docs:check` (schema and `docs/rpc.md` current).

## PT-3b — Plan checker in `plur1bus-tools` (2 agent days; Claude agent, Rust)

**Language:** Rust; a new pure component without secrets or I/O beyond its parameters (ADR-019 (1)).

`tools.team.check { plan }` returns typed findings: a dependency cycle; ownership globs of two packages that intersect
(`own` against `own`, decided on glob languages, plus a sample of the repository's file list the core passes); a merge
order that violates a dependency; a predicted overlap score; `tools.team.diffcheck { owns, interfaces, files }` classifies
changed files as owned, interface, shared or foreign. Core-only guard (D120 §5). **Tests:** property tests for glob
intersection against brute-force expansion on generated trees; cycle detection; fixtures shared with the TypeScript side.
**Acceptance:** `cargo test -p plur1bus-tools`; `cargo deny check` clean; no new crate unless it passes
`docs/dependency-policy.md`.

## PT-4 — Scheduler, writers and resumability (6 agent days, range 5–7; Opus, TypeScript)

**Language:** TypeScript; the scheduler drives TypeScript turns, D109, the call budget and the collab store until Phase 4
step 3 (spec §6.3).

- **Admission** of spec §7.4; call schema 3 with scopes `team` and `package` in `budget/calls.ts` (additive columns,
  default empty); limits set at plan approval.
- **Packages:** claim in one `BEGIN IMMEDIATE` transaction; card worktree through #820 `fork` with an optional base
  branch for stacks; a D104 brief from the package; the native writer runs with the package worktree as its only root.
- **Lead turns** at plan, adjudication, interface changes and synthesis; `team_propose_plan`, `team_decide`, `team_status`.
- **Capacity:** writer bound from `supervisor.maxCores`; per-endpoint semaphore for local models; person-merge
  back-pressure.
- **Failure handling** of spec §6.11; **resumability** of spec §6.12.
- **Tests (red first):** admission (slots, budget refusal before any provider call, back-pressure waits instead of
  refusing); two packages of one agent identity in parallel keep separate scopes and captures (U9); stacked fork from a
  dependency's branch; a writer that stalls on an injected clock gets a steer, then a restart; **the kill test:** the core
  process is killed during writing, review, retarget and merge (four cases) and restarted; every package returns to its
  state or `interrupted`, no commit is lost, no process remains, nothing merges twice.
- **Acceptance:** a three-package fixture project runs end to end with native writers and fake reviewers up to
  `queued`; the PR carries the `team` arm's first PT-2 numbers.

## PT-5 — Review loop and adjudication (3 agent days; Sonnet or Opus, TypeScript)

**Language:** TypeScript; it extends `request_review` and `coding-surface.ts`.

The flow of spec §6.8: D98 checks before review; a fresh reviewer session per round with the diff and the contract only;
findings with severity as untrusted data; writer answers per finding; the round cap (Q9) and the repetition detector
(the same finding hash in three rounds, or the same dispute twice); adjudication decisions; `tools.team.diffcheck` before
review, interface changes paused for the lead. **Tests:** the reviewer's input never contains the writer's transcript
(asserted on the recorded request); the cap and the detector trigger adjudication; `split` changes the plan hash and asks
the person again; a change outside `owns` is refused back. **Acceptance:** a fixture package with a seeded bug is caught,
fixed and passed within the cap.

## PT-6 — Merge queue, local sink (4 agent days; Opus, TypeScript)

**Language:** TypeScript; it extends #820's provisioner, the single git implementation (D115 §6.5), which D123 keeps in
TypeScript as harness-owned git.

`mergePreview`, `merge`, `revert` on the provisioner to D115 §6.5's interface (merge commits with fixed argv, the
`approvedTreeHash` and target-head checks of D115 §6.6–§6.7), `prune` and the orphan scan of spec §6.7; the queue of spec
§6.9 with retarget by merge, the gate on the exact tree, `team.merge.confirm` bound to tree hash and target head, and
`MERGE_HEAD` recovery after a crash. **Tests:** order and reorder (a reorder against a dependency is refused); retarget by
merge leaves no rewritten commit (every old SHA is an ancestor of the new head); a conflict becomes a fix round; a changed
tree voids the confirmation; an orphan directory is reported and not deleted; the merge refuses without a person's
confirmation from a T2 or T3 surface. **Acceptance:** the PT-4 fixture project merges all three packages in order into
the root branch with merge commits after three confirmations; D115 WP4 can reuse the provisioner methods unchanged.

## PT-7 — Forge sink (3 agent days; Sonnet, TypeScript)

**Language:** TypeScript; it needs the forge credential, and secrets never enter `plur1bus-tools` (D120 §5).

Push of the run's `p1b/` branches under the task-scoped grant (Q18), stacked pull requests, required checks as the CI
gate, merge on the forge by the person or by API after `team.merge.confirm`, retarget of dependents by merge after an
upstream merge, PR bodies with the package contract and residual findings. **Tests:** against a fake forge on 127.0.0.1:
the grant's branch scope refuses another branch; a red check keeps the package in `checking`; an upstream merge triggers
retarget and a new check run. **Acceptance:** the fixture project lands as three stacked pull requests merged in order.

## PT-8 — External ACP and A2A workers (2.5 agent days; Sonnet, TypeScript)

**Language:** TypeScript; it extends #820's ACP client.

One ACP session per package with the package worktree as `cwd`; permission requests to the team's approval panel through
D109; `session/load` probed per M6 CLI (U1) with the resume brief as fallback; A2A peers as read helpers and reviewers,
tasks re-read by id after a restart (U2). **Tests:** with the fake ACP agent of #820's suites: a write outside the
package worktree is refused, an approval reaches the person and never an agent, a restart resumes through the brief.
**Acceptance:** one fixture package written by each Tier-1 fake CLI profile.

## PT-9a — Web team view (3 agent days; Sonnet, TypeScript)

**Language:** TypeScript; the web SPA stays TypeScript (ADR-019 (4)).

The team view of spec §6.13 inside `packages/web/src/pages/projects/`, live through the existing event stream; merge
queue with drag reorder calling `team.merge.order.set`; the approvals panel; the router explanation; de and en strings.
**Tests:** component tests per lane state; keyboard reorder; i18n completeness. **Acceptance:** the PT-6 fixture run can
be followed and merged from the web.

## PT-9b — CLI (1.5 agent days; Claude agent, Rust)

**Language:** Rust; the CLI is Rust.

`plur1bus project team status|approve|pause|resume|cancel|merge` as a thin RPC client with `--json` documents.
**Tests:** `crates/plur1bus/tests/cli_surface.rs` and help snapshots; exit codes through `scripts/check-cli-exit-codes.mjs`.
**Acceptance:** a person can approve a plan and confirm merges from a terminal.

## PT-10 — Best-of-N (3.5 agent days; Sonnet or Opus, TypeScript)

**Language:** TypeScript; it orchestrates turns and the verifier, both TypeScript today.

The steps of spec §9: N attempts in card worktrees, budget check before start, tests first through the verifier sandbox,
early stop at two passing candidates, bounded summaries, pairwise tournament with 8 votes per pair, tie to the smaller
diff, optional distill-refine. **Tests:** a candidate that fails the oracle is never selected even if the judge prefers
it; the budget refuses N above the run budget before any call; early stop cancels the rest with partial results.
**Acceptance:** the `best-of-n` arm in PT-2's report, with the judge's agreement with the hidden checkers.

## PT-11 — Router, heuristic stage (2.5 agent days; Claude agent, Rust and TypeScript)

**Language:** Rust for the router (a new component, ADR-019 (1)); the feature collector stays in the TypeScript core
because it reads the plan, the budget and the ledger.

Features and rules of spec §8.2–§8.3, hard masks, overrides, `tools.router.decide`, `tools.router.explain`,
`team.route.explain`. **Tests:** each rule on fixture feature vectors; a masked arm is never returned; an override wins;
the explanation lists every fired rule. **Acceptance:** on PT-2's tasks, the router's choice per task is reported next to
the best arm per task.

## PT-12 — Router, contextual bandit (3 agent days; Claude agent, Rust)

**Language:** Rust; new component in `plur1bus-tools`, own store.

Linear Thompson sampling per arm, the reward of spec §8.4 with provisional and final updates (idempotent per decision),
propensities, decay, shadow mode and the exploration cap (Q13), weights (Q14), `state/router.sqlite` with no text,
`tools.router.outcome`, `tools.router.reset` behind the human-only `team.route.reset`. **Tests:** seeded simulations where
one arm is better for a feature region: the policy converges there and never selects a masked arm; shadow mode never
changes the acted arm; a replayed outcome does not double-count; reset empties the store. **Acceptance:** after PT-2's
nightly runs feed it, the explanation shows posterior means per arm; nothing leaves the installation (no network code in
the module).

## PT-13 — Selective verification gate (later; 2.5 agent days; Sonnet, TypeScript)

Spec §10, off by default; ships only if PT-2 shows a gain at a small token overhead (U7).

## PT-14 — Local external benchmark runner (conditional; 2.5 agent days; Sonnet, TypeScript)

Only if Q15 amends D120 Q21: fetch the official harness and a subset at run time into the eval home, run `single` and
`best-of-n`, report aggregate counts; never vendored, never in CI.

## Gates

1. **PT-2 baseline before PT-4 merges.** Team mode is measured from its first version; PT-4's PR carries the `team` arm's
   delta against the baseline.
2. **Delta rule.** Every behaviour package reports its delta; a package that makes a gated rate worse does not merge
   without an owner decision.
3. **Code dependencies:** #820 merged before PT-3a (migration order), PT-4 and PT-8; D120 H1-1 before PT-3b, PT-11 and
   PT-12; the GitHub credential profile before PT-7.
4. **Owner answers:** Q6 before PT-6 and PT-7; Q18 before PT-7; Q13 and Q14 before PT-12 leaves shadow mode; Q15 before
   PT-14; Q16 before router-initiated teams are switched on; Q17 before PT-13.
5. **Enablement:** `collaboration.teams.enabled` stays `false` until PT-4 to PT-6 have landed; router-initiated teams per
   task class only after PT-2 shows the gain spec §11 names.

## Estimate

| Block | Agent days |
|---|---|
| PT-0 docs | 0.5 |
| PT-1 limits and concurrency | 2.5 |
| PT-2 evaluation | 5 (4–6) |
| PT-3a, PT-3b data model and plan checker | 5 |
| PT-4 scheduler and resumability | 6 (5–7) |
| PT-5, PT-6, PT-7 review, local merge queue, forge sink | 10 |
| PT-8 external workers | 2.5 |
| PT-9a, PT-9b web and CLI | 4.5 |
| PT-10 best-of-N | 3.5 |
| PT-11, PT-12 router | 5.5 |
| **Total** | **45** (range 40–55 with review rounds) |
| Follow-ups PT-13, PT-14 | 5 |

The team mode that reproduces the controller workflow with native workers and a local merge needs PT-1, PT-2, PT-3a,
PT-3b, PT-4, PT-5 and PT-6: 25.5 agent days. The forge sink, external workers, UI, best-of-N and the router add the rest.
