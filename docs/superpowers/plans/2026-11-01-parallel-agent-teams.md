# Parallel agent teams — implementation plan

**Goal.** Replace the constant fan-out guardrails by limits governed by budget and capacity, make delegations started in
one step run concurrently, and build a coding team mode that does what the controller does with external agents today
and goes beyond it where the owner decided: the lead proposes a team and a plan in sections; the person confirms the
team and approves a scope; inside it one writer per worktree and branch (native, ACP or A2A), a fresh-context reviewer
per package with capped fix rounds, autonomous merges into a revertible section branch, sync of running packages at safe
points, a `needs-decision` state that asks the person, failure handling by class (quota holds and hands over instead of
failing), a moderated team channel, CI gates and a section merge into the target branch that stays the person's unless
`auto`, resumable after a restart. Add best-of-N, a router that learns between single agent, team and best-of-N as a
local contextual bandit, and an evaluation that decides the defaults. Specified in
[`2026-11-01-parallel-agent-teams-design.md`](../specs/2026-11-01-parallel-agent-teams-design.md), cited as "spec §n";
register entry D124, decided 2026-11-01 (Q1).

**Architecture.** "Rust decides, TypeScript executes" (owner, Q21 (c), spec §6.3): the scheduler's state logic is a
pure, stateless transition function `tools.team.next` in `plur1bus-tools` (Rust, `x-server: "tools"`), beside the plan
checker, `tools.team.impact` and the router (ADR-019 (1)). The TypeScript core keeps storage as the single source of
truth, turns, D109 approvals, the call budget and git (#820's provisioner, the single git implementation D115 §6.5 asks
for), calls `tools.team.next` per event, persists the state and executes the actions (ADR-019 (3), D120 §13).

**Status.** Plan only, no product code. Owner intents (spec §2) and owner decisions on Q1–Q21 with the amendments of
2026-11-01 (spec §16) are binding; no owner question is open. The remaining gates are measurement, code and dependency
gates ("Gates" below).

**Constraints.**
- **RPC.** JSON Schema is the single source: closed params, `x-stability: "experimental"`, `x-since` set to the next free
  minor **at implementation time** (1.11–1.14 are taken by open PRs #835, #843, #838 and #820). No new RPC error codes;
  new reason strings go into `docs/errors.md`. **Every `team.*` core method is human-only and goes into
  `FORBIDDEN_EXACT` in `packages/webmcp/src/provider.ts`**; `packages/core/test/protocols/exposure-matrix.test.ts`
  enforces it (spec §6.6 lists methods, rights and the WP that adds each).
- **Versions.** Collab-store migrations and the budget call schema take the next free version at implementation time,
  like the RPC minor (#820 and #843 each add a collab migration; the call schema is at 2 on main).
- **Config.** Every new key has `x-restart` and `x-tier` (ADR-013); project overrides may only narrow (D115 S3). The disk
  floor has a schema minimum above zero, so it cannot be switched off (spec §6.7).
- **Security.** Only a person approves, grants, decides a `needs-decision` or merges into the target branch (D109; `auto`
  sections excepted, spec §6.14); an agent message is never an approval; A2A series are untrusted until review and gates
  pass; no history rewrite, force, reset or rebase by the core; secrets never in briefs, messages, logs or
  `plur1bus-tools` (D120 §5).
- **Tests.** TDD, red test first. No `sleep` synchronisation (barriers, readiness signals, injected clocks). No network in
  tests (fake ACP agents, fake A2A peers and a fake forge on 127.0.0.1). Never skip, disable or quarantine a test to get
  green.
- **Measurement.** Every package that changes behaviour attaches its delta against the PT-2 baseline; no default flips
  without an owner decision (the D120 delta rule).
- **Executor.** Every Rust package is done by a Claude agent, never Codex unless the owner makes an explicit exception.
  TypeScript packages: the controller's choice (Sonnet-suitable unless marked Opus).
- **Process.** One branch and one ready PR per package. No CI polling: push, open the PR, report the number, stop. No
  force-push, rebase, amend or stash. Commits carry the owner's identity.

## Work packages

| WP | Scope | Files | Language | Executor | Estimate (agent days) | Depends on |
|---|---|---|---|---|---|---|
| **PT-0** | Register entry D124 (decided 2026-11-01) and a milestones row | `docs/superpowers/specs/2026-09-24-m1b-2a-core-daemon-cli-design.md` §2, `docs/milestones.md` | docs | Claude | 0.5 | — |
| **PT-1** | Limits by class from one source; work budget separated from the return cap; per-delegation deadlines by task class; read-only depth 2; `wait: false` and `await_delegations`; structured concurrency; the start, pair and trace races closed; the concurrency proof; the ADR-003 guardrail table updated with the code | `packages/core/src/collab/{limits.ts (new),defaults.ts,guardrails.ts,types.ts,service.ts,store.ts,migrations.ts}`, `packages/core/src/tools/collaboration.ts`, `packages/core/src/composition/{collaboration.ts,provider.ts}`, `packages/config-schema/schema/config.schema.json`, `packages/core/test/collab/{concurrency.test.ts (new),guardrails.test.ts,tools.test.ts,project-store.test.ts}`, `docs/collaboration.md`, `docs/adr/ADR-003-agent-model-and-collaboration.md`, generated `docs/config.md` | TypeScript | Sonnet or Opus | 2.5 | — |
| **PT-2** | Evaluation: team tier (12 decomposable, 6 coupled tasks), arms and budgets of spec §11, MAST tags, local-model concurrency, memory per writer and overcommit slowdown, nightly advisory job, baseline; replaces `fanout-eval.ts` and `eval:m5` | `tests/bench/coding/team/<id>/` (new), `packages/core/src/toolcall/coding-bench.ts` (D120 B1's runner), `packages/core/src/collab/team-eval.ts` (new; `fanout-eval.ts` and its test removed), `scripts/eval/team-eval.ts` (new; `scripts/m5-fanout-eval.mjs` removed), `package.json` (`eval:m5` replaced), `docs/demos/m5.md`, `.github/ci/core-test-timings.json` (the `fanout-eval.test.ts` entry), `.github/workflows/nightly.yml`, `docs/evals/2026-11-baseline-team-eval.md` (new), `docs/turn-eval.md`, `docs/ci.md`, `docs/collaboration.md` | TypeScript and fixtures | Sonnet | 5 (4–6) | D120 B1 runner (or builds it, see PT-2); PT-1 only for the `explore+single` arm |
| **PT-3a** | Team data model (runs, members, sections, packages, rounds, queue, messages, event log, outbox), plan schema with sections, core RPC for runs, composition, plans, scopes, packages, budgets and sync settings, roles and events | `packages/core/src/collab/{migrations.ts,types.ts}`, `packages/core/src/collab/team/{store.ts,plan.ts}` (new), `packages/core/src/collab/schemas/teamplan.schema.json` (new), `packages/rpc-schema/schema/rpc.schema.json` and fixtures, `packages/core/src/rpc/collab-surface.ts`, `packages/core/src/rbac/{guard.ts,policy.ts}`, `packages/webmcp/src/provider.ts`, `packages/core/test/protocols/exposure-matrix.test.ts`, `docs/errors.md`, generated `docs/rpc.md` | TypeScript and schema | Sonnet | 3.5 | PT-1; PR #820 merged (its `project_worktrees` table) |
| **PT-3b** | Plan checker and impact analysis in Rust: DAG across sections, ownership disjointness by glob intersection, merge order against dependencies, overlap prediction, diff against ownership, affected running packages after a merge | `crates/plur1bus-tools/src/team/{check,diffcheck,impact}.rs` (new), `tools.team.check`, `tools.team.diffcheck`, `tools.team.impact` in the schema with fixtures, `crates/plur1bus-tools/tests/team_*.rs` | Rust | Claude agent | 2.5 | D120 H1-1; PT-3a (plan schema) |
| **PT-4a** | Transition function: `tools.team.next { state, event } → { state, actions[] }` with closed `plur1bus.teamstate/1`, event and action schemas; every state of spec §6.5 and §6.14 (scopes, sections, `needs-decision`, sync, back-pressure, capacity and disk facts, holds with poll and handover timers, writer epochs) | `crates/plur1bus-tools/src/team/{state,event,action,next}.rs` (new), the three schemas in `packages/rpc-schema/schema/rpc.schema.json` with fixtures, `crates/plur1bus-tools/tests/team_next_*.rs` | Rust | Claude agent | 4 (3.5–4.5) | D120 H1-1; PT-3a |
| **PT-4b** | **Re-targeted 2026-11-07 (D131 Q6): written in Rust as part of Phase 4 package P4-50, not in TypeScript.** Originally: TypeScript shell: event log and outbox around `tools.team.next`, executing actions; admission (spec §7.4) and the call-budget scopes `team`, `section`, `package` (next call-schema version); card worktrees and section integration worktrees; writer briefs; native writers; lead turns (team proposal, plan, section summary); team agent tools; capacity from cores and memory with the warning; the disk floor and cleanup; the local-model semaphore (default 1); pause, cancel, steering hooks; failure handling; resumability and the kill test | `packages/core/src/collab/team/{shell.ts,actions.ts,admission.ts,capacity.ts,brief.ts,resume.ts}` (new), `packages/core/src/tools-service/client.ts` (the D120 H1-1 client), `packages/core/src/budget/calls.ts`, `packages/core/src/tools/collaboration.ts`, `packages/core/src/composition/{index.ts,collaboration.ts}`, `packages/config-schema/schema/config.schema.json`, `packages/log-schema/schema/catalogue.json`, `docs/budgets.md`, `docs/collaboration.md` | TypeScript | Opus or Sonnet | 5.5 (5–6.5) | PT-1, PT-3a, PT-3b, PT-4a (so also D120 H1-1), #820 merged; its PR carries the PT-2 delta |
| **PT-4c** | Failure handling by class (owner addition A2): the classifier (provider error codes, credential pool, retry budget, call-budget refusals → `quota`, `transient`, `deterministic`, `permission`, `auth`, `crash`, `budget`), quota holds with inbox notification, availability polls (no call while a reset is known; otherwise a one-token probe), handover after the deadline to a fitting candidate with room, the writer epoch, stop-then-commit of the old worker's state (no `git stash`), human-only `team.package.hold`, the two settings | `packages/core/src/collab/team/{failures.ts,handover.ts}` (new), `packages/core/src/collab/team/actions.ts`, `packages/core/src/inbox/producers.ts`, `packages/config-schema/schema/config.schema.json`, `packages/rpc-schema/schema/rpc.schema.json` and fixtures, `packages/core/src/rpc/collab-surface.ts`, `packages/core/src/rbac/policy.ts`, `packages/webmcp/src/provider.ts`, `packages/core/test/protocols/exposure-matrix.test.ts`, `docs/collaboration.md` | TypeScript | Sonnet or Opus | 2.5 (2–3) | PT-4b, PT-5 (`needs-decision`, inbox kind) |
| **PT-5** | Review loop: D98 checks before review, fresh-context reviewer per round, findings with severity, fix rounds capped at 5, repetition and dispute detection (A2A peers included), ownership and interface checks; `needs-decision`: lead options (2–3, pros, cons, recommendation), inbox entry of kind `team`, human-only `team.package.decide` and `team.interface.approve` | `packages/core/src/collab/team/{review.ts,decision.ts}` (new), `packages/core/src/collab/coding-surface.ts`, `packages/core/src/tools/collaboration.ts`, `packages/core/src/inbox/{store.ts,producers.ts}`, `docs/inbox.md`, `packages/rpc-schema/schema/rpc.schema.json` and fixtures, `packages/core/src/rpc/collab-surface.ts`, `packages/core/src/rbac/policy.ts`, `packages/webmcp/src/provider.ts`, `packages/core/test/protocols/exposure-matrix.test.ts` | TypeScript | Sonnet or Opus | 4.5 | PT-4b |
| **PT-5b** | Team channel and direct messages for native and ACP members: threads, delivery at round boundaries and with the next ACP prompt, `team_post`/`team_dm`/`team_read`/`team_moderate`, size and rate limits, budget admission, repetition brake, human-only `team.channel.read`, `team.channel.post`, `team.channel.mute` | `packages/core/src/collab/team/channel.ts` (new), `packages/core/src/tools/collaboration.ts`, `packages/core/src/composition/collaboration.ts`, `packages/core/src/external-agents/delegation.ts` (#820), `packages/rpc-schema/schema/rpc.schema.json` and fixtures, `packages/core/src/rpc/collab-surface.ts`, `packages/core/src/rbac/policy.ts`, `packages/webmcp/src/provider.ts`, `packages/core/test/protocols/exposure-matrix.test.ts` | TypeScript | Sonnet | 3.5 (3–4) | PT-4b, PT-8a |
| **PT-6** | Merge queue, local sink, section branches: autonomous merges into the section branch inside the scope, `team.merge.confirm` outside it, the gate on every exact tree, section summary hand-over, human-only `team.section.merge` and `team.merge.order.set`, `auto` sections; provisioner `mergePreview`/`merge`/`revert` to D115 §6.5 (worktree removal through the existing `remove`); the orphan scan (new in D124) | `packages/core/src/external-agents/provisioner.ts` (#820), `packages/core/src/collab/coding-surface.ts` (provisioner interface), `packages/core/src/collab/team/merge-queue.ts` (new), `packages/rpc-schema/schema/rpc.schema.json` and fixtures, `packages/core/src/rpc/collab-surface.ts`, `packages/core/src/rbac/policy.ts`, `packages/webmcp/src/provider.ts`, `packages/core/test/protocols/exposure-matrix.test.ts` | TypeScript | Opus | 5 | PT-5 |
| **PT-6b** | Sync at safe points: impact after each merge into a section branch, the short interface notice, safe-point detection, the section-branch merge into the package branch, conflicts as the next task, unresolvable → `needs-decision`, per-package `auto`/`notify-only`/`at-review` | `packages/core/src/collab/team/sync.ts` (new), `packages/core/src/external-agents/provisioner.ts` (#820) | TypeScript | Sonnet | 2.5 | PT-6, PT-3b (impact), PT-5b (direct messages) |
| **PT-7** | Forge sink: push the run's `p1b/` branches under the per-run grant, one pull request per section into the target branch (plus one per package into the section branch under scope `package`), required checks as the CI gate, merge by the person on the forge or by API after `team.section.merge` | `packages/core/src/collab/team/forge.ts` (new), grant capability rows, `docs/collaboration.md` | TypeScript | Sonnet | 3 | PT-6; the GitHub credential profile (D115 WP4b) |
| **PT-8a** | External ACP writers (session per package, `cwd` = package worktree, approvals to the team panel, resume through `session/load` where supported, else the resume brief); A2A peers as read helpers and reviewers; on handover `session/cancel` and refusal of the old session's `fs/*` and `terminal/*` callbacks | `packages/core/src/external-agents/{delegation.ts,acp-client.ts}` (#820), `packages/core/src/collab/team/workers.ts` (new) | TypeScript | Sonnet | 3 | PT-4b; PT-4c (handover stop); #820 merged (D123 SB-5 later swaps containment underneath) |
| **PT-8b** | A2A writers: trust through #843's pinned registry (or D114 pairing once Track F lands), the brief with remote and base, the disclosure confirmed with the team, file artifacts (bundle or mbox) in #843's client, the pre-apply checks, merge or `git am` with hooks off, artifacts of an older writer epoch refused after a handover, findings and sync heads back to the peer; A2A members in the team channel | `packages/core/src/a2a/peer-client.ts` (#843), `packages/core/src/collab/team/{workers.ts,a2a-writer.ts (new)}`, `packages/core/src/external-agents/provisioner.ts` (#820), `packages/core/src/collab/team/channel.ts` | TypeScript | Sonnet or Opus | 3.5 (3–4.5) | PT-8a, PT-5, PT-6, PT-5b; #843 merged |
| **PT-9a** | Web team view: lanes per package (state, round, writer kind, tokens, wall time, findings, disk), sections with branch, budget and summary, merge queue per section with reorder, composition editor, scope approval, yellow pulse for `needs-decision` and quota holds on project, thread and card with the options, the hold reason, next poll time and handover deadline, team channel, capacity warning, approvals panel, router explanation; de and en | `packages/web/src/pages/projects/{team-view.ts (new),page.ts,rpc-types.ts}`, i18n catalogues | TypeScript | Sonnet | 5 | PT-4b; PT-4c, PT-5, PT-5b and PT-6 for their lanes |
| **PT-9b** | CLI `plur1bus project team status\|confirm\|approve\|decide\|pause\|resume\|cancel\|merge` | `crates/plur1bus/src/commands/{project.rs,project_team.rs (new)}`, `crates/plur1bus/tests/cli_surface.rs` | Rust | Claude agent | 2 | PT-3a; PT-5 (`decide`), PT-6 (`merge`) |
| **PT-10** | Best-of-N: N attempts in worktrees, tests-first selection, pairwise tournament judge, early stop, optional distill-refine, budget caps, evaluation arm | `packages/core/src/collab/team/best-of-n.ts` (new), `packages/core/src/collab/verifier.ts` (oracle run) | TypeScript | Sonnet or Opus | 3.5 | PT-4b, PT-2 |
| **PT-11** | Router, heuristic stage: features, rules and hard masks of spec §8.3, overrides, explanation records; human-only `team.route.explain` | `crates/plur1bus-tools/src/router/{features,heuristic,explain}.rs` (new), `packages/core/src/collab/team/route.ts` (new; collects features), `tools.router.decide`/`explain` and `team.route.explain` in `packages/rpc-schema/schema/rpc.schema.json` with fixtures, `packages/core/src/rpc/collab-surface.ts`, `packages/core/src/rbac/policy.ts`, `packages/webmcp/src/provider.ts`, `packages/core/test/protocols/exposure-matrix.test.ts` | Rust and TypeScript | Claude agent | 2.5 | H1-1, PT-2, PT-3b |
| **PT-12** | Router, contextual bandit: linear Thompson sampling, rewards and delayed updates, propensities, shadow mode for 30 decisions, exploration cap of 10 % until 30 outcomes per arm, decay, store; human-only `team.route.reset` | `crates/plur1bus-tools/src/router/{bandit,reward,store}.rs` (new), `tools.router.outcome`/`reset` and `team.route.reset` in `packages/rpc-schema/schema/rpc.schema.json` with fixtures, `packages/core/src/rpc/collab-surface.ts`, `packages/core/src/rbac/policy.ts`, `packages/webmcp/src/provider.ts`, `packages/core/test/protocols/exposure-matrix.test.ts` | Rust and TypeScript | Claude agent | 3.5 | PT-11; outcome signals from PT-5 and PT-6 |
| | **Total** | | | | **67.5** | |

**Follow-ups** (not in the total):

| WP | Scope | Files | Language | Executor | Estimate | Depends on |
|---|---|---|---|---|---|---|
| PT-13 | Selective verification gate at three decision points (spec §10), off by default | `packages/core/src/collab/team/verify-gate.ts` (new) | TypeScript | Sonnet | 2.5 | PT-10, the PT-2 baseline (Q17) |
| PT-14 | Local-only external benchmark runner: SWE-bench Verified and Terminal-Bench subsets fetched at run time, never vendored, never in CI, aggregate report (Q15) | `scripts/eval/external-bench.ts` (new) | TypeScript | Sonnet | 2.5 | PT-2, PT-10 |

```text
 PT-1 limits + async delegation ─┬─► PT-3a data model + RPC ─┬─► PT-3b checker + impact ◄─┐
                                 │                           └─► PT-4a transition fn ◄────┤ D120 H1-1 (gates PT-3b,
                                 └ ─ ─► PT-2 explore+single arm                           │ PT-4a and so PT-4b onward)
 D120 B1 runner (or built by PT-2) ─► PT-2 evaluation + baseline (GATE for PT-4b merge)  ─┘
 #820 merged + PT-3a + PT-3b + PT-4a ─► PT-4b TS shell + writers + capacity + resume
     ├─► PT-5 review + needs-decision ─┬─► PT-4c failure classes, quota hold, handover
     │                                 └─► PT-6 merge queue + section branches ─┬─► PT-6b sync at safe points
     │                                                                        ├─► PT-7 forge sink
     │                                                                        └─► PT-9b CLI
     ├─► PT-8a ACP writers, A2A helpers ─► PT-5b team channel ─► PT-6b
     │                                  └─► PT-8b A2A writers (also PT-5, PT-6, PT-5b, #843)
     ├─► PT-9a web team view (lanes as PT-5, PT-5b, PT-6 land)
     └─► PT-10 best-of-N ─► PT-13 verification gate (follow-up)
 PT-2 + PT-3b ─► PT-11 router heuristic ─► PT-12 contextual bandit (outcomes from PT-5/PT-6)
 PT-0 docs: alongside; gates nothing
```

## What can start now

- **PT-0** and **PT-1** have no dependency.
- **PT-2** can start at once: the 18 team-tier tasks with checkers and seeds, and the runner (on B1's runner, or B1's
  runner built to the D120 plan). Only its `explore+single` arm needs PT-1's asynchronous consults.
- **D120 H1-1** (3 agent days in the D120 plan, not counted here) gates PT-3b, PT-4a, PT-11 and PT-12 directly and,
  through them, PT-4b and everything after it, as it gates D123's SB-4; pulling it forward, as D123 Q11 recommends,
  unblocks both.
- **#820** gates PT-3a (its `project_worktrees` table), PT-4b, PT-8a and the provisioner work of PT-6, PT-6b and PT-8b;
  **#843** gates PT-8b.

## Best first package: PT-1

PT-1 is small, independent and useful on its own: it removes the hard-coded limits from `tools/collaboration.ts`,
`collab/service.ts`, `composition/collaboration.ts` and `composition/provider.ts` into one resolved source next to
`collab/defaults.ts` and `guardrails.ts`, lets a person raise them by configuration, makes `delegate_task` asynchronous
as ADR-003 describes it, closes the start, pair and trace races, and proves with a barrier test that delegations started
in one step overlap. Every later package builds on its `CollabLimits` and its concurrency.

## PT-0 — Register entry and milestones (0.5 agent days; Claude, docs)

Enter D124 (decided 2026-11-01, with the owner amendments of spec §16) in the core spec's register; add the D124 row to
`docs/milestones.md` with the WPs of this plan. The ADR-003 note is already in place ("Amended by D124, decided
2026-11-01"); the guardrail table itself changes with PT-1. Checks: `node scripts/check-doc-links.mjs`,
`node scripts/lint-hygiene.mjs`.

## PT-1 — Limits by budget and concurrency proof (2.5 agent days; Sonnet or Opus, TypeScript)

**Language:** TypeScript; it changes existing `collab/` and tool code (ADR-019 (3)).

- **One source.** `collab/limits.ts` resolves `CollabLimits` from `collaboration.limits.*` (read helpers per turn 8,
  ceiling 32 enforced by the schema's `maximum`; read-only depth 2; writers per project 4; per-pair consult limit 4; task
  classes of spec §7.2) and the project's narrowing overrides. `guardrails.ts` takes a call class (`read`, `write`,
  `review`); `tools/collaboration.ts` drops its constants (`:45`, `:49-50`, `:59`), `service.ts` drops the 300,000 ms cap
  (`:267`) and the chain-wide timer becomes a per-delegation deadline.
- **Work budget.** Today every model call of a delegated turn is capped at `budget.tokens` = 2,000 output tokens
  (`composition/collaboration.ts:51`, a per-call cap) and nothing caps the delegation as a whole. After PT-1 the per-call
  output cap comes from the model profile, the delegation as a whole is admitted against its token allocation, and the
  delegated turn gets the class's round limit through a per-request round limit in place of the turn-wide default of 25
  (`composition/provider.ts:738`); `returnContract.maxTokens` stays at most 2,000.
- **Depth by class.** A read-only delegation (scope tools all `read` effect) may start one more read-only delegation; a
  nested writer is refused with `depth`.
- **Concurrency.** `wait: false` on `consult_agent` and `delegate_task` returns `{ taskId }`; `await_delegations { taskIds,
  timeoutMs }` returns finished envelopes and the running ids; at the end of a turn unbound children are awaited up to
  their deadlines, then cancelled with partial results.
- **Races.** The start and pair slots are reserved before the first `await` (today checked at
  `tools/collaboration.ts:49-50`, incremented at `:80` after `await prepareHandoff` at `:68`), and the turn's trace is
  created before the first start, not stored after the first completion (`:101`), so concurrent first calls share one
  chain instead of each opening a new one with fan-out 0 (`collab/service.ts:206-207`). Parallel dispatch in the turn
  loop is not part of PT-1; if it is built later, the tested but unused `executeBatch` (`toolcall/results.ts:57-67`) is
  the helper to reuse.
- **Settings migration (Q20).** One collab-store migration drops stored project settings equal to the old defaults
  (`store.ts:87-91` wrote them in full).
- **Tests (red first):** the barrier test of spec §7.5 (four delegations, each blocked on a barrier released only when
  all four started; red on main because the second never starts; green after, maximum concurrency 4); race tests that
  issue starts concurrently against a limit of 3 and a pair limit of 2 and assert exactly 3 and 2 admitted, all in one
  trace; class limits and ceilings; depth 2 read-only allowed, nested writer refused; a delegation running past 5
  minutes on an injected clock is not killed by the old chain timer; the migration keeps a non-default value and drops a
  default one; a steer arriving during `await_delegations` (U13, coordinated with D120 H3-1 if it has landed).
- **Docs:** `docs/collaboration.md` guardrail table; the ADR-003 guardrail table (the decided defaults, spec §7.1);
  `pnpm docs:gen` for `docs/config.md`.
- **Acceptance:** no collaboration limit constant remains in `tools/collaboration.ts`, `service.ts` or
  `composition/collaboration.ts`, and delegated turns no longer stop at the turn-wide 25 rounds; the barrier test passes;
  `collab/*.test.ts` stay green with the decided defaults.

## PT-2 — Evaluation and baseline (5 agent days, range 4–6; Sonnet, TypeScript and fixtures)

**Language:** TypeScript; it extends D120 B1's runner (`coding-bench.ts`), which is TypeScript in the D120 plan.

- **Runner.** If D120 B1 has landed, PT-2 adds a team mode to its runner. If it has not, PT-2 builds B1's runner exactly as
  the D120 plan specifies (same file, same report schema, same nightly secret pattern), and B1 then only adds its 24
  tasks; there is never a second runner.
- **Team tier.** 12 decomposable tasks (3–5 packages each, a checker per package and an end-to-end checker; Rust,
  TypeScript, Python, Go) and 6 sequential or tightly coupled tasks, under `tests/bench/coding/team/`, MIT, seeded
  variants, hidden checkers (the D120 Q21 rules).
- **Arms and budgets** of spec §11: `single`, `single` at the highest effort, `single+review`, `explore+single` now;
  `team` joins with PT-4b, `best-of-n` with PT-10. Matched and natural budgets.
- **Metrics** of spec §11, including MAST tags (rules over the trace map each failure to system design, inter-agent
  misalignment or task verification, with a step-repetition count; untagged failures are counted, not guessed), the
  cache-read share (U12), `needs-decision` counts, sync merges and conflicts, channel messages and brake hits; rounds and
  wall time per task class to calibrate spec §7.2.
- **Capacity (U3, U16):** for each configured local endpoint, throughput and latency at 1, 2 and 4 concurrent requests;
  peak memory per writer; wall time at 1×, 1.5× and 2× the computed writer capacity. PT-4b's semaphore default (1) and
  the `memoryPerWriter` estimate (4 GiB) move to the measured values.
- **Replace** `collab/fanout-eval.ts`, its test and `scripts/m5-fanout-eval.mjs`, together with everything that names
  them: the `eval:m5` script in `package.json`, `docs/demos/m5.md`, the `test/collab/fanout-eval.test.ts` entry in
  `.github/ci/core-test-timings.json` and `docs/collaboration.md`; `docs/evals/m5-fanout.json` stays as a historical
  record, referenced from the new report.
- **Tests:** the fixture self-test per PR (every checker fails on the start tree and passes on the reference for three
  seeds; the coupled tasks really are coupled: their packages' reference diffs overlap); report schema tests; the canary
  secret test.
- **Acceptance:** the baseline for the four initial arms is committed as `docs/evals/2026-11-baseline-team-eval.md`
  (models, dates, denominators, no credentials); the nightly job uploads only the redacted report.

## PT-3a — Team data model and core RPC (3.5 agent days; Sonnet, TypeScript and schema)

**Language:** TypeScript; collab store, RPC surface and RBAC are existing TypeScript.

The tables of spec §6.4 in one migration (the next free version at implementation time), including `team_members`,
`team_sections`, `team_messages`, `team_events` and `team_actions`; `plur1bus.teamplan/1` with goals, sections and
per-section budgets (closed, bounded: 32 packages in 8 sections, the D104 2,000-token rule per brief); `ProjectRole`
gains `worker` and `reviewer`; `team.*`, `section.*`, `package.*` and `message.*` events; the methods of spec §6.6 that do
not depend on later packages: `team.get` and `team.list` (`project.read` plus project visibility), `team.create`
(`project.write`), and `team.composition.confirm`, `team.plan.approve` (with the scope), `team.scope.extend`,
`team.pause`, `team.resume`, `team.cancel`, `team.package.reassign`, `team.package.budget.set`, `team.budget.set` (run
or section), `team.package.sync.set` (`project.write` and project lead, owner or admin), with schema, fixtures,
`humanOnly` RBAC rules and every name in `FORBIDDEN_EXACT`; the project setting `collaboration.teams.approval.auto`.
`team.package.decide` and `team.interface.approve` come with PT-5, the channel methods with PT-5b, the merge methods with
PT-6, `team.route.explain` with PT-11 and `team.route.reset` with PT-12, each under the same rule. **Tests:** store round
trips; plan schema bounds (a dependency on a later section is refused by the schema check before PT-3b); approval
records bound to plan hash, composition hash and scope; RBAC matrix; `exposure-matrix.test.ts` green with the new
methods; a viewer and an agent principal are refused on every human-only method. **Acceptance:** `pnpm docs:check`
(schema and `docs/rpc.md` current).

## PT-3b — Plan checker and impact analysis in `plur1bus-tools` (2.5 agent days; Claude agent, Rust)

**Language:** Rust; new pure components without secrets or I/O beyond their parameters (ADR-019 (1)).

`tools.team.check { plan }` returns typed findings: a dependency cycle, or a dependency on a later section; ownership
globs of two packages that intersect (`own` against `own`, decided on glob languages, plus a sample of the repository's
file list the core passes); a merge order that violates a dependency; a predicted overlap score.
`tools.team.diffcheck { owns, interfaces, files }` classifies changed files as owned, interface, shared or foreign.
`tools.team.impact { merged, running[] }` returns the affected running packages and, per package, the changed interface
files (spec §6.15). Core-only guard (D120 §5). **Tests:** property tests for glob intersection against brute-force
expansion on generated trees; cycle and section-order detection; impact on fixture plans (dependency, consumed
interface, overlapping changed file, unaffected); fixtures shared with the TypeScript side. **Acceptance:**
`cargo test -p plur1bus-tools`; `cargo deny check` clean; no new crate unless it passes `docs/dependency-policy.md`.

## PT-4a — Transition function `tools.team.next` (4 agent days, range 3.5–4.5; Claude agent, Rust)

**Language:** Rust; the scheduler's state logic is a new component that survives Phase 4 unchanged (owner, Q21 (c);
ADR-019 (1)).

- **Schemas:** `plur1bus.teamstate/1` (run, members, sections, packages, merge queue, scope, counters, and the capacity,
  disk and budget facts), the closed event set (plan approved, scope extended, worker returned, checks finished, review
  verdict, merge done, conflict, safe point, person decided, budget refused, disk measured, capacity changed, timer,
  restart, …) and the closed action set (spec §6.3), in `rpc.schema.json` with fixtures; Rust types through `typify`, the
  TypeScript types generated (ADR-012 §2).
- **Logic:** every transition of spec §6.5, §6.8, §6.9, §6.14 and §6.15: admission waits (scope, slots, person queue,
  disk floor) and budget refusals; fix-round cap and `needs-decision` triggers; independent packages continue while
  dependants wait; autonomous merges into the section branch only inside the approved scope; section end and the person
  queue of 3 (autonomous merges not counted); sync per `auto`, `notify-only`, `at-review`; the failure classes of spec
  §6.11 (hold, poll and handover timers from timer events, the person's hold and redirect, the writer epoch); pause and
  cancel. Pure: no clock, no I/O.
- **Tests (red first):** property tests over generated event sequences: no package both writing and merged; no merge
  into a section branch outside the approved scope without a person's approval; no section merge into the target branch
  without a person unless `auto`; dependants never start before their dependency is `queued`; a `needs-decision` never
  resolves without a person-decided event; a holding package hands over only after the handover deadline and never while
  the person keeps it holding; no event of an older writer epoch changes a package; the same state and event always give
  the same output; replaying an applied
  event yields no new action.
- **Acceptance:** `cargo test -p plur1bus-tools`; the schema fixtures are read by both sides.

## PT-4b — TypeScript shell, writers, capacity and resumability (5.5 agent days, range 5–6.5; Opus or Sonnet, TypeScript)

**Language:** TypeScript; storage, turns, D109, the call budget and git stay in the core (owner, Q21 (c); ADR-019 (3)).

- **Shell:** per event: persist it (`team_events`), call `tools.team.next` through `tools-service/client.ts` (D120 H1-1),
  store the new state and the outbox (`team_actions`) in one transaction guarded by the state version, execute the
  actions; every completion is a new event. While `plur1bus-tools` is down, runs pause (fail closed, spec §6.3).
- **Admission** of spec §7.4: the facts passed to the transition function, the synchronous slot reservation, the next
  call-schema version with scopes `team`, `section` and `package` in `budget/calls.ts` (additive columns, default empty);
  limits set at plan approval.
- **Packages:** claim in one `BEGIN IMMEDIATE` transaction; card worktree through #820 `fork` with an optional base
  branch (section branch or dependency branch); one integration worktree per open section; a D104 brief from the
  package; the native writer runs with the package worktree as its only root.
- **Lead turns:** team proposal (`team_propose_team`), plan (`team_propose_plan`), interface decisions (`team_decide`),
  section summaries (`team_section_summary`), `team_status`.
- **Capacity and disk** (owner, Q3): computed capacity from the cores `supervisor.maxCores` allows and available memory
  (`coresPerWriter` 2, `memoryPerWriter` 4 GiB, both configurable), `capacity.maxWriters` override, slots above capacity
  allowed with the `team.capacity.exceeded` warning; the disk floor (`disk.minFreeBytes`, default 20 GiB, schema minimum
  1 GiB) checked before every new worktree and every five minutes; immediate worktree removal and the cleanup of
  git-ignored build directories under pressure (spec §6.7); the per-endpoint local-model semaphore, default 1 until
  PT-2's measurement.
- **Failure handling** of spec §6.11; **resumability** of spec §6.12 (event replay, idempotent actions).
- **Tests (red first):** admission (slots, budget refusal before any provider call, back-pressure and scope waits instead
  of refusals); capacity from injected core and memory values, the warning when exceeded, no upper cap; no worktree
  below the disk floor, cleanup never touches tracked files or a writing package; two packages of one agent identity in
  parallel keep separate scopes and captures (U9); stacked fork from a dependency's branch; a writer that stalls on an
  injected clock gets a steer, then a restart; **the kill test:** the core process is killed during writing, review,
  sync, a merge into a section branch and a section merge (five cases, the merge cases with PT-6) and restarted; every
  package returns to its state or `interrupted`, no commit is lost, no process remains, nothing merges twice; a stopped
  `plur1bus-tools` pauses runs and the queued events apply after it returns.
- **Acceptance:** a three-package, two-section fixture project runs end to end with native writers and fake reviewers up
  to `queued`; the PR carries the `team` arm's first PT-2 numbers.

## PT-4c — Failure handling by class, quota hold and handover (2.5 agent days, range 2–3; Sonnet or Opus, TypeScript)

**Language:** TypeScript; the classifier reads TypeScript provider errors, the credential pool and the call budget, and
the handover executes through the core's turns, ACP client and harness-owned git (ADR-019 (3)); the decisions are PT-4a's.

- **Classifier** (spec §6.11): `ProviderError` kind, `retryable`, `code` and `retryAfterMs` (`insufficient_quota`,
  `usage_limit_reached`, `subscription_sharing_usage_limit_exceeded` → `quota`); the credential pool's `quota_exhausted`
  and `all_cooling_down`; two exhausted `rate_limit` retry budgets in a row (`RetryBudgetExceededError`) → `quota`;
  call-budget refusals by scope (`agent` → `quota`; `user`, `global`, `project` → hold without handover; run scopes →
  `budget`); `invalid_request`, `context_length`, `tool_call_invalid` after its repair, `tool-result-too-large` →
  `deterministic`; `auth` → `needs-decision`; pending approvals → `permission`; unknown → `transient`.
- **Hold and poll:** the inbox entry (kind `team`, from PT-5) with reason, provider, credential, next poll and handover
  deadline; polls every `collaboration.teams.quota.pollIntervalMs` (default 10 min, minimum 1 min) without a call while a
  reset time is known or the pool cools down, otherwise one one-token probe admitted against the run budget (U21).
- **Handover** after `collaboration.teams.quota.handoverAfterMs` (default 60 min): candidate selection (team members,
  then agents allowed in the composition; role, model tier, tools and toolchain fit; a different provider or credential
  preferred; pool selection and call-budget admission checked and released); writer epoch increment; stop the old
  worker (native abort; ACP and A2A through PT-8a and PT-8b); commit uncommitted changes as a `P1B-Handover` commit with
  hooks off, never `git stash`; start the new worker with the resume brief. No candidate → `needs-decision`.
- **RPC:** the human-only `team.package.hold { runId, packageId, until? }` with schema, fixtures, RBAC rule and
  `FORBIDDEN_EXACT`; redirect uses `team.package.reassign` (PT-3a).
- **Tests (red first):** each mapping row of spec §6.11 on recorded provider errors (OpenAI `insufficient_quota`, the
  ChatGPT plan's `usage_limit_reached` with `resets_in_seconds`, Gemini `RESOURCE_EXHAUSTED`, 5xx, 400, 401) and on
  call-budget refusals per scope; a quota failure produces no partial result and no failure; no probe before a known
  reset; handover exactly at the deadline on an injected clock, never while held by the person, to a candidate on a
  different credential; the old worker's late tool call or result is refused by epoch; an uncommitted change survives the
  handover as a commit and no stash entry exists; a `deterministic` failure is never retried or handed over; a pending
  approval counts against the person queue and a hold does not; `exposure-matrix.test.ts` green with
  `team.package.hold`.
- **Acceptance:** on a fixture run where one provider returns `usage_limit_reached`, the package holds, pulses, polls,
  and after the (shortened) deadline continues on the second provider from its committed state, with no duplicated
  commit and no lost change.

## PT-5 — Review loop and `needs-decision` (4.5 agent days; Sonnet or Opus, TypeScript)

**Language:** TypeScript; it extends `request_review`, `coding-surface.ts` and the inbox.

The flow of spec §6.8: D98 checks before review; a fresh reviewer session per round with the diff and the contract only;
findings with severity as untrusted data; writer answers per finding; the round cap of 5 (Q9), the repetition detector
(the same finding hash in three rounds) and dispute detection (the same dispute twice, A2A peers included);
`tools.team.diffcheck` before review, interface changes paused for the lead. `needs-decision`: the lead's options
(`team_decision_options`, 2–3 options with pros, cons and a recommendation), an inbox entry of the new kind `team`
(`inbox/store.ts:9`, `docs/inbox.md`), the human-only `team.package.decide` and `team.interface.approve` with schema,
fixtures, RBAC rules and `FORBIDDEN_EXACT`. **Tests:** the reviewer's input never contains the writer's transcript
(asserted on the recorded request); cap, repetition and dispute each lead to `needs-decision` with 2–3 options; an
independent package keeps running while a dependant waits; a decision that splits a package changes the plan hash and
asks the person again; a change outside `owns` is refused back; `exposure-matrix.test.ts` green with both new methods,
and an agent principal is refused on both. **Acceptance:** a fixture package with a seeded bug is caught, fixed and
passed within the cap; a fixture with an unresolvable finding ends in `needs-decision` and continues after the person's
choice.

## PT-5b — Team channel and direct messages (3.5 agent days, range 3–4; Sonnet, TypeScript)

**Language:** TypeScript; delivery runs through the composed runner and #820's ACP client.

The channel of spec §6.16 for native and ACP members: one channel per run with sub-threads per package and topic, direct
messages, delivery to native members at round boundaries as untrusted peer input and to ACP members with their next
`session/prompt`; the harness tools offered through `session/new`'s `mcpServers` where the CLI uses them (U15);
`team_post`, `team_dm`, `team_read`, `team_moderate`; size (2,000 tokens), rate (20 per member per hour) and budget
admission; the repetition brake (repeated hash refused; a pair paused after 6 exchanges without progress); redaction
before storage and delivery; the human-only `team.channel.read`, `team.channel.post` and `team.channel.mute` with schema,
fixtures, RBAC rules and `FORBIDDEN_EXACT`. **Tests:** a message never changes a package's state, ownership or approval;
a message claiming an approval resolves nothing; a repeated message is refused; a ping-pong pair is paused and the lead
notified; delivery happens only at a round boundary; a redacted secret never reaches a recipient; `exposure-matrix.test.ts`
green. **Acceptance:** two fixture writers settle an interface question in the channel and the review sees the result.

## PT-6 — Merge queue, local sink and section branches (5 agent days; Opus, TypeScript)

**Language:** TypeScript; it extends #820's provisioner, the single git implementation (D115 §6.5), which D123 keeps in
TypeScript as harness-owned git.

`mergePreview`, `merge`, `revert` on the provisioner to D115 §6.5's interface (merge commits with fixed argv, the
`approvedTreeHash` and target-head checks of D115 §6.6–§6.7); worktree removal after a merge through the existing
`remove` (D115 §6.5 lists `fork`, `mergePreview`, `merge`, `revert`, `remove`) and the orphan scan of spec §6.7, which
is new in D124; section branches (`p1b/<key>/t-<run>/s<N>`) and their integration worktrees; the queue of spec §6.9:
autonomous merges into the section branch inside the approved scope after the gate on the exact tree,
`team.merge.confirm` outside it, merge-based conflict resolution (spec §6.9 on how this differs from D115 §6.6 step 3),
the section summary handed to the person, the human-only `team.section.merge` and `team.merge.order.set` with schema,
fixtures, RBAC rules and `FORBIDDEN_EXACT`, `auto` sections, and `MERGE_HEAD` recovery after a crash. **Tests:** order and
reorder (a reorder against a dependency is refused); an autonomous merge happens only inside the scope and never touches
the target branch; a merge leaves no rewritten commit (every old SHA is an ancestor of the new head); a conflict becomes a
fix round; a changed tree voids a confirmation; an orphan directory is reported and not deleted; the section merge
refuses without a person's confirmation from a T2 or T3 surface unless the section is `auto`; an autonomous merge does
not count against the person queue; `exposure-matrix.test.ts` green with the merge methods. **Acceptance:** the PT-4b
fixture project merges every package into its section branch without a person, presents two section summaries, and
lands in the target branch after two section confirmations; a section merge reverts with `git revert -m 1`; D115 WP4
can reuse the provisioner methods unchanged.

## PT-6b — Sync at safe points (2.5 agent days; Sonnet, TypeScript)

**Language:** TypeScript; it executes the transition function's `sync-worktree` actions with #820's provisioner.

After each merge into a section branch, `tools.team.impact` (PT-3b) selects the affected running packages; unaffected
ones get a `sync-note`; affected ones get an immediate direct message (PT-5b) with the changed interface files, their
changed symbols once D120 C3 exists, and the merged package's return summary, never the full diff. At the next safe point
(between rounds, work committed, `git status --porcelain` empty) the provisioner merges the section branch into the
package branch (`--no-ff`, never a rebase), the checks run again, and a reviewed package gets a review round if the tree
changed beyond the merge. Conflicts become the writer's next task; a conflict unresolved twice, or in files outside
`owns`, ends in `needs-decision`. Per-package `auto` (default), `notify-only`, `at-review`. **Tests:** an unaffected
package is not touched; no merge while uncommitted changes exist; `notify-only` sends the message and merges nothing;
`at-review` merges right before checking; a seeded conflict becomes a fix task and, unresolved twice, `needs-decision`;
the message never contains the diff. **Acceptance:** on a team-tier fixture with a changed interface, the dependant
picks up the change at its next safe point and passes review; U19 is reported (how often a writer asks for the full
diff).

## PT-7 — Forge sink (3 agent days; Sonnet, TypeScript)

**Language:** TypeScript; it needs the forge credential, and secrets never enter `plur1bus-tools` (D120 §5).

Push of the run's `p1b/` branches under the per-run task-scoped grant (Q18); one pull request per section from the
section branch into the target branch, and under scope `package` one pull request per package into the section branch
(the controller workflow one to one); required checks as the CI gate; merge on the forge by the person or by API after
`team.section.merge`; PR bodies with the section summary or the package contract and residual findings. **Tests:**
against a fake forge on 127.0.0.1: the grant's branch scope refuses another branch; a red check keeps the section in
`awaiting-person` with the reason; a package PR under scope `package` merges into the section branch only after the
person. **Acceptance:** the fixture project lands as two section pull requests merged in order.

## PT-8a — External ACP writers and A2A helpers (3 agent days; Sonnet, TypeScript)

**Language:** TypeScript; it extends #820's ACP client.

One ACP session per package with the package worktree as `cwd`; permission requests to the team's approval panel through
D109; `session/load` probed per M6 CLI (U1) with the resume brief as fallback; A2A peers as read helpers and reviewers,
tasks re-read by id after a restart (U2); for a PT-4c handover, `session/cancel` and the refusal of the old session's
`fs/*` and `terminal/*` callbacks. **Tests:** with the fake ACP agent of #820's suites: a write outside the package
worktree is refused, an approval reaches the person and never an agent, a restart resumes through the brief; after a
handover the old session can write nothing. **Acceptance:** one fixture package written by each Tier-1 fake CLI profile.

## PT-8b — A2A writers (3.5 agent days, range 3–4.5; Sonnet or Opus, TypeScript)

**Language:** TypeScript; it extends #843's A2A client and #820's provisioner.

The A2A writer of spec §6.10: trust through #843's pinned registry (or D114 pairing once Track F lands); the brief with
remote, base commit and contract; the base bundle only under the disclosure the person confirmed with the team; `file`
artifacts (git bundle or mbox) in #843's client, which reads only text parts today (`a2a/peer-client.ts:23,119`, U14);
the pre-apply checks (size, base ancestry, paths inside `owns`, no gitlink, no escaping symlink); bundle fetch into a
quarantine ref and `--no-ff` merge, or `git am`, with hooks off; findings and synced heads back to the peer as A2A
messages (U17, U18); A2A members in the team channel. **Tests:** against a fake A2A peer on 127.0.0.1: a series based on
a different commit, a path outside `owns`, an oversized artifact, a gitlink and an escaping symlink are each refused with
the reason and nothing is applied; a second rejection ends in `needs-decision`; an accepted series goes through checks
and review like a local writer's; no credential appears in any brief; an untrusted or revoked peer gets no brief.
**Acceptance:** one fixture package written by a fake A2A peer reaches the section branch after review.

## PT-9a — Web team view (5 agent days; Sonnet, TypeScript)

**Language:** TypeScript; the web SPA stays TypeScript (ADR-019 (4)).

The team view of spec §6.13 inside `packages/web/src/pages/projects/`, live through the existing event stream: package
lanes, sections with branch, budget and summary, the merge queue per section with drag reorder (`team.merge.order.set`),
the composition editor (`team.composition.confirm`), scope approval (`team.plan.approve`, `team.scope.extend`), the
yellow pulse on project, team thread and card while a package is in `needs-decision` or holds on quota, with the options
and the decide action, or the hold reason, next poll time, handover deadline and the keep-holding and hand-over-now
actions, the team channel, the capacity warning, the approvals panel and the router explanation; de and en strings.
**Tests:** component tests per lane and section state; the pulse appears and clears with the decision or the end of a
hold; the hold lane shows next poll and deadline; keyboard reorder; i18n completeness. **Acceptance:** the PT-6 fixture
run can be composed, approved, followed, decided and merged from the web.

## PT-9b — CLI (2 agent days; Claude agent, Rust; after PT-6)

**Language:** Rust; the CLI is Rust. It starts after PT-6 so that `merge` calls existing merge methods.

`plur1bus project team status|confirm|approve|decide|pause|resume|cancel|merge` (`merge --section` for a section merge)
as a thin RPC client with `--json` documents. **Tests:** `crates/plur1bus/tests/cli_surface.rs` and help snapshots; exit
codes through `scripts/check-cli-exit-codes.mjs`. **Acceptance:** a person can confirm a team, approve a scope, decide a
`needs-decision` and merge a section from a terminal.

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

Features and rules of spec §8.2–§8.3, hard masks, overrides, `tools.router.decide`, `tools.router.explain`, and the
human-only core method `team.route.explain` (`project.read` plus project visibility) with schema, fixtures, RBAC rule
and `FORBIDDEN_EXACT`. **Tests:** each rule on fixture feature vectors; a masked arm is never returned; an override
wins; the explanation lists every fired rule; `exposure-matrix.test.ts` green with `team.route.explain`. **Acceptance:**
on PT-2's tasks, the router's choice per task is reported next to the best arm per task.

## PT-12 — Router, contextual bandit (3.5 agent days; Claude agent, Rust and TypeScript)

**Language:** Rust for the bandit (a new component in `plur1bus-tools`, own store); the human-only `team.route.reset` is a
core method in TypeScript (RPC surface and RBAC).

Linear Thompson sampling per arm, the reward of spec §8.4 with provisional and final updates (idempotent per decision),
propensities, decay, shadow mode for the first 30 eligible decisions and then at most 10 % exploration until each arm has
30 outcomes (Q13), weights 0.3 and 0.2 (Q14), `state/router.sqlite` with no text, `tools.router.outcome`,
`tools.router.reset` behind the human-only `team.route.reset` (owner or admin; schema, fixtures, RBAC rule,
`FORBIDDEN_EXACT`). **Tests:** seeded simulations where one arm is better for a feature region: the policy converges there
and never selects a masked arm; shadow mode never changes the acted arm; a replayed outcome does not double-count; reset
empties the store; `exposure-matrix.test.ts` green with `team.route.reset`. **Acceptance:** after PT-2's nightly runs
feed it, the explanation shows posterior means per arm; nothing leaves the installation (no network code in the
module).

## PT-13 — Selective verification gate (follow-up; 2.5 agent days; Sonnet, TypeScript)

Spec §10, off by default; starts after the PT-2 baseline and PT-10 (Q17) and ships only if PT-2 shows a gain at a small
token overhead (U7).

## PT-14 — Local external benchmark runner (follow-up; 2.5 agent days; Sonnet, TypeScript)

Q15 (decided 2026-11-01) amends D120 Q21 for evaluation only: fetch the official harness and a subset at run time into
the eval home, run `single` and `best-of-n`, report aggregate counts; never vendored, never in CI.

## Gates

No owner question is open (spec §16). The gates are:

1. **PT-2 baseline before PT-4b merges.** Team mode is measured from its first version; PT-4b's PR carries the `team`
   arm's delta against the baseline.
2. **Delta rule.** Every behaviour package reports its delta; a package that makes a gated rate worse does not merge
   without an owner decision.
3. **Code dependencies:** #820 merged before PT-3a (its `project_worktrees` table), PT-4b and PT-8a; #843 merged before
   PT-8b; D120 H1-1 before PT-3b, PT-4a, PT-11 and PT-12, and therefore before PT-4b and everything that depends on it;
   PT-5 and PT-6 before PT-9b; PT-5 before PT-4c; PT-4c before the handover parts of PT-8a; PT-5b before PT-6b; the
   GitHub credential profile before PT-7.
4. **Decided rules applied as gates:** PT-12 runs in shadow mode for the first 30 eligible decisions, then explores at
   most 10 % until each arm has 30 outcomes (Q13); router-initiated teams are switched on per task class only when PT-2
   shows the gain spec §11 names (Q16); PT-13 starts after the PT-2 baseline and PT-10 (Q17); PT-14 after PT-2 and PT-10
   (Q15). Spec §16 states the same.
5. **Enablement:** `collaboration.teams.enabled` stays `false` until PT-4b, PT-5 and PT-6 have landed.

## Estimate

| Block | Agent days |
|---|---|
| PT-0 docs | 0.5 |
| PT-1 limits and concurrency | 2.5 |
| PT-2 evaluation | 5 (4–6) |
| PT-3a, PT-3b data model, plan checker and impact | 6 |
| PT-4a, PT-4b, PT-4c transition function, TypeScript shell, failure classes | 12 (10.5–14) |
| PT-5, PT-5b review, `needs-decision`, team channel | 8 (7.5–8.5) |
| PT-6, PT-6b, PT-7 merge queue and section branches, sync, forge sink | 10.5 |
| PT-8a, PT-8b external ACP and A2A writers | 6.5 (6–7.5) |
| PT-9a, PT-9b web and CLI | 7 |
| PT-10 best-of-N | 3.5 |
| PT-11, PT-12 router | 6 |
| **Total** | **67.5** (range 64–72 from the packages with their own ranges) |
| Follow-ups PT-13, PT-14 | 5 |

**Change against the plan before the owner decisions (46 agent days):** +21.5. The decisions on Q1–Q21 and A1 add
17.5: Q21 (c) splits the scheduler into PT-4a
and PT-4b, +2.5 against the all-TypeScript PT-4 (the owner's estimate of 2–3, a judgment), and the TypeScript shell
carries +0.5 for the team proposal, memory-based capacity and the disk floor (Q3, Q7); PT-3a +0.5 and PT-3b +0.5
(sections, composition, impact); PT-5 +1 (`needs-decision`, Q9); PT-5b +3.5 (team channel, Q11); PT-6 +1 (section
branches and summaries, Q7); PT-6b +2.5 (sync, owner addition); PT-8b +3.5 (A2A writers, Q11); PT-9a +1.5 and PT-9b
+0.5 (new surfaces). **Owner addition A2** (failure handling by class) adds 4: PT-4c 2.5 (new), PT-4a +0.5 (holds,
timers, epochs), PT-8a +0.5 (ACP stop on handover), PT-9a +0.5 (hold display); 67.5 in all.

The range covers only the packages with their own ranges (PT-2, PT-4a, PT-4b, PT-4c, PT-5b, PT-8b). Rework from the
review of each implementing pull request (PR review rounds, as in the D120 and D123 plans) is not included; these are
not the product's package fix rounds of spec §6.8 (capped at 5, Q9). The team mode that reproduces the controller
workflow with native writers and a local merge needs PT-1, PT-2, PT-3a, PT-3b, PT-4a, PT-4b, PT-4c, PT-5 and PT-6: **35
agent days** (26 before the owner decisions, 32 before A2), plus D120 H1-1 (3 agent days in the D120 plan, not counted
here), which PT-3b and PT-4a and therefore PT-4b need. Sync (PT-6b, 2.5) sends its notices through the team channel
(PT-5b, 3.5), which needs PT-8a (3) for its ACP members; with these three the path is 44. The forge sink, A2A writers,
UI, best-of-N and the router add the rest.
