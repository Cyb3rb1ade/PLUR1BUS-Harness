# Parallel agent teams — design (D124)

**Status:** Decided 2026-11-01 (specification and plan only, no product code). The owner intents of 2026-11-01 are
binding (§2); the owner decided Q1–Q21 the same day, as recommended except for five amendments (Q3, Q7, Q9, Q11, Q21),
and added sync at safe points (§16) · **Date:** 2026-11-01 · **Owner:** Christian (Cyb3rb1ade) · **Track:** M5
collaboration follow-up, beside M5+ (D115) and M6 · **Register entry:** **D124** (decided 2026-11-01, Q1) in the core
spec's register ([`2026-09-24-m1b-2a-core-daemon-cli-design.md`](2026-09-24-m1b-2a-core-daemon-cli-design.md) §2), not
entered yet (plan PT-0). D120 is on main; D121 is used by open PR #840, D122 by open PR #845, D123 by open PR #847;
`D124` appears in no file of main (`27ec7c4f0c`) and in no doc changed by the 40 most recently updated remote refs,
checked 2026-11-01 · **Amends:** the ADR-003 guardrail defaults (note "Amended by D124, decided 2026-11-01" in
[ADR-003](../../adr/ADR-003-agent-model-and-collaboration.md)); answers ADR-003 open question 5 and action items 8 and 9
· **Follows:** D120 path B
([`2026-10-30-harness-hygiene-coding-aci-design.md`](2026-10-30-harness-hygiene-coding-aci-design.md) §2 decision 3, the
ADR-019 text in §13), D115 ([`2026-10-19-subprojects-design.md`](2026-10-19-subprojects-design.md)), D123 (PR #847) ·
**Plan:** [`2026-11-01-parallel-agent-teams.md`](../plans/2026-11-01-parallel-agent-teams.md)

**Inputs read:** main at `27ec7c4f0c`: [ADR-003](../../adr/ADR-003-agent-model-and-collaboration.md) (complete),
[ADR-010](../../adr/ADR-010-latency-and-caching.md) (status, context, the L8 row),
[ADR-011](../../adr/ADR-011-external-coding-agents.md) (decision, first-class agent, permission model, M6 set, the
2026-10-07 amendment), [ADR-008](../../adr/ADR-008-protocols-mcp-acp-a2a.md) (decision);
`packages/core/src/collab/{defaults,guardrails,service,runner,types,target,coding-gate,coding-surface,verifier,fanout-eval}.ts`,
the heads of `collab/{board,handoff,store}.ts`, `collab/schemas/handoff.schema.json`,
`packages/core/src/tools/collaboration.ts`, `packages/core/src/composition/collaboration.ts`, `composition/provider.ts`
(the tool loop and budget admission), `composition/index.ts` (collaboration wiring),
`packages/core/src/budget/{README.md,subagent.ts,calls.ts}`, [`docs/budgets.md`](../../budgets.md),
[`docs/collaboration.md`](../../collaboration.md), [`docs/milestones.md`](../../milestones.md) (M5, M5+),
[`docs/architecture/turn-pipeline.md`](../../architecture/turn-pipeline.md) (port inventory),
`packages/config-schema/schema/config.schema.json` (`collaboration`, `supervisor.maxCores`),
`packages/webmcp/src/provider.ts`, `packages/core/test/protocols/exposure-matrix.test.ts`,
`crates/plur1bus-engine/src/store/ledger_types.rs` (reply outcomes), the heads of
`packages/web/src/pages/projects/{board-view,delegation-trace}.ts`, the D109 register row, the D115 spec (§1–§3,
§6.5–§6.7), D120 (§2, §4, §5, §6.6, §12, §13, §16–§18 and its plan), D119 (§5, §8.4), D118 (header), the D114 federation
spec (§1, §2, §5–§7), [`docs/acp.md`](../../acp.md), [`docs/inbox.md`](../../inbox.md) with
`packages/core/src/inbox/store.ts`. Open PRs: #820 at `dbdb6202c9` (`external-agents/provisioner.ts`, the
`ProjectWorktreeProvisioner` interface in `collab/coding-surface.ts`, the `project_worktrees` migration,
`external-agents/acp-client.ts`; the first three unchanged since `42ced5f736`, the newer commits touch tests only), #847
at `0d542df7da` (D123 spec and plan), #845 at `5773ca3857` (D122 spec and plan), #843 at `2887e8dbd3`
(`a2a/peer-store.ts`, `a2a/peer-client.ts`, `docs/a2a.md`, and the history of its re-merges). External sources in §3,
re-checked 2026-11-01 where marked.

## 1. Context and problem

### 1.1 The workflow the harness must reproduce

Today the owner runs software work through an external controller and external coding agents: several agents work in
parallel, each in its own git worktree and branch on its own work package; an independent reviewer looks at every
package between rounds; findings go back as fix rounds; the packages land in a fixed merge order, stacked where one
needs another, behind CI; a person merges. The D120 plan ends with the same division of labour: "the controller watches
CI and merges" ([plan](../plans/2026-10-30-harness-hygiene-coding-aci.md), "Estimate"). The owner wants the harness itself
to do this (§2).

### 1.2 What the harness does today (verified at `27ec7c4f0c`)

| Area | Today | Evidence |
|---|---|---|
| Guardrail defaults | depth 1, 3 starts per chain, 2 per pair, 25 turns, 5 min, 2,000-token return, no token budget | `collab/defaults.ts:3-14`; ADR-003 table `ADR-003:149-159` |
| Where the limits live | **Spread, not in one place:** `collab/defaults.ts` and `collab/guardrails.ts`, `tools/collaboration.ts`, `collab/service.ts`, `composition/provider.ts` and, in the next row, `composition/collaboration.ts`. `evaluateGuardrails` reads project settings (`collab/guardrails.ts:20-30`); the agent tools hard-code 3 starts and 2 per pair (`tools/collaboration.ts:49-50`), refuse any nested call through `currentAgentScope()` regardless of `maxDepth` (`:45`), give every contract `budget: { tokens: 2000, toolCalls: 25, deadline: +300 s }` (`:59`) and a 300 s tool timeout (`:41`); `runTarget` caps a contract deadline at 300,000 ms (`collab/service.ts:267`); the turn loop stops at 25 rounds (`composition/provider.ts:738`) | as listed |
| Work budget vs return cap | Every model call of the delegated turn carries `maxOutputTokens` = the contract's `budget.tokens` (`composition/collaboration.ts:51`), i.e. 2,000 output tokens **per call** (a multi-round turn can emit more in total); the return is capped at 2,000 again (`:79`, `budget/subagent.ts:7-8`, schema `returnContract.maxTokens` maximum 2,000 at `handoff.schema.json:461`). One number serves as per-call output cap and as summary cap, and no token budget covers the whole delegation | as listed |
| Time | One chain-wide timer from the chain's start (`collab/service.ts:190-195`): every child of a chain dies 5 min after the first hop. `maxTurns` is stored but not counted (`docs/collaboration.md:88`) | as listed |
| Fan-out switch | `collaboration.fanoutEnabled`, default `false` until "owner review of the equal-token-budget evaluation" (`config.schema.json:123`; wiring `composition/index.ts:312`) | as listed |
| Evaluation | 24 synthetic arithmetic fixtures, "not a live-model quality claim" (`collab/fanout-eval.ts:1,13`); result 24/24 both modes, 576 vs 1,728 tokens (`docs/collaboration.md:300-306`, `docs/milestones.md:377`) | as listed |
| Project roles and board | `ProjectRole` is `member \| lead` (`collab/types.ts:3`), not ADR-003's lead/worker/reviewer (`ADR-003:143`). A card has no dependencies, ownership or merge position (`collab/board.ts:8-13`); the board is one JSON document per project (`board.ts:57,67`) with column WIP limits (`board.ts:6`) | as listed |
| Worktrees | Main: `ProjectWorktreePort.root()` only, "no second worktree creator exists" (`collab/coding-surface.ts:15`). PR #820 adds the one provisioner: `fork`, `remove`, `status` (`coding-surface.ts:22-26` at `dbdb6202c9`), card worktrees on branches `p1b/<key>/c-<suffix>` forked from the project root worktree, a live-row index per (project, card) (#820's `collab/migrations.ts:127-139`), and a refusal set `--force`, `reset`, `rebase`, `push` (`external-agents/provisioner.ts:11`); "M5+ adds merge and revert here" (`:1`). No prune and no orphan detection | PR #820 |
| D98 gate and review | Format, lint, typecheck, test in the verifier sandbox; review required at 200 changed lines (`collab/coding-gate.ts:80`); the reviewer must differ from the author and see the same tree hash (`:54`); `request_review` gives a read-only worktree, `file.read/list/stat` only, and a `verdict`/`findings` schema (`tools/collaboration.ts:63-65`) | as listed |
| Durability | Live chains are an in-memory map (`collab/service.ts:95`); shutdown abandons in-flight runs and marks them cancelled (`:308-325`); a persisted trace can be revived as metadata, its runs cannot (`:214-225`) | as listed |
| Budget port | Atomic pre-call admission and reservation with scopes `global, user, project, agent, turn, session` (`budget/calls.ts:13`), called before every provider call (`composition/provider.ts:532`); reservations survive restart until a 30 min TTL ([`docs/budgets.md`](../../budgets.md), "Admission") | as listed |

### 1.3 Finding: delegations in one turn do not run in parallel today

The library can run several delegations at once: `collab.delegate` starts the run in an async closure and returns
`{ task, done }` at once (`collab/service.ts:488-527`), and a chain tracks a set of in-flight runs (`:52`). The agent tool
path serialises them twice:

1. the turn loop dispatches the tool calls of one model step one after another, `for (const call of calls)` with
   `await dispatcher.call(...)` (`composition/provider.ts:685-699`); D120 records the same (§4, "Mid-turn input");
2. `delegate_task` awaits the run before returning (`await handle.done`, `tools/collaboration.ts:91-93`), although
   ADR-003 calls `delegate_task` "asynchronous, result report" (`ADR-003:145`).

So three `delegate_task` calls in one step run strictly in sequence, and ADR-010's L8 "independent tool calls issued
concurrently" (`ADR-010:103`) is not implemented on the turn path. A tested helper exists: `executeBatch`
(`toolcall/results.ts:57-67`) runs `parallelSafe` calls in groups with barriers for unsafe ones, but no production caller
uses it; it is the reuse candidate if L8 is built.

A latent race follows for the day calls do run concurrently. The tool checks `starts >= 3` and the pair count
(`tools/collaboration.ts:50`, `:49`), then awaits `prepareHandoff` (`:68`), and increments both only afterwards (`:80`),
so concurrent calls could all pass both checks. The library would not catch them: its own check and increment have no
`await` between them (`service.ts:403-409` for consult, `:466-472` for delegate), but the tool passes the turn's trace id
only once a call has completed (`traces.set`, `tools/collaboration.ts:101`), so concurrent first calls arrive without
one and `getChain` starts a new chain with fan-out 0 for each (`service.ts:206-207`); no layer sees the siblings.

### 1.4 Problem

The constants are too small for real work (a coding package needs hours and hundreds of rounds, not 5 minutes, 25 rounds
and 2,000 output tokens per call), they are scattered so raising one changes nothing, and nothing in the harness turns a
multi-package job into parallel writers with review, ordered merges, gates and a human merge. Raising the constants
alone would be the wrong fix: the evidence (§3) says parallel agents pay off only for some tasks and fail expensively on
others, so the design needs limits governed by budget and capacity, a coding team mode with single-threaded writes, a
selector between single agent, team and best-of-N, and an evaluation that measures what each costs.

## 2. Owner intents of 2026-11-01 (binding)

| # | Intent | Where this spec carries it |
|---|---|---|
| I1 | The fan-out limits of ADR-003 and `collab/defaults.ts` (depth 1, fan-out 3, 2 per pair, 25 turns, 5 min, 2,000-token return) are "definitely too small". | §7; the exact new defaults are Q2–Q4 |
| I2 | The harness must do what the controller does with external agents: parallel coding agents, each in its own worktree and branch on its own work package, independent review between rounds, fix rounds, a fixed merge order, CI gates, the person merges. "Das sollte er definitiv können … definitiv muss das rein." | §6 (coding team mode) |
| I3 | Learned routing between single agent, team and best-of-N as a contextual bandit over outcomes, tokens and wall time is accepted as the first "real learning" step. No reinforcement learning that changes model weights. | §8 |
| I4 | The topic moves fast; the design rests on current evidence, not on 2025 assumptions. | §3; every default without evidence is marked a judgment call |

Decided by these intents and not reopened here: that limits rise (not by how much), that team mode is built (not when it
is on by default), and that the router learns (not its start mode, Q13).

The owner then decided every question of §16 on 2026-11-01: as recommended, except Q3, Q7, Q9, Q11 and Q21, which the
owner amended or decided otherwise, and with one addition, sync at safe points (A1).

## 3. Research basis

### 3.1 Sources

"Re-checked" means the cited page was read again on 2026-11-01; the other entries are taken from the owner's research
brief of the same day and were not re-fetched. Figures belong to the source version named in the row; where versions
differ, the row says so. This spec adds no number of its own to them.

| # | Source | Finding as used here | Consequence |
|---|---|---|---|
| R1 | Google Research and MIT, "Towards a science of scaling agent systems": the [blog](https://research.google/blog/towards-a-science-of-scaling-agent-systems-when-and-why-agent-systems-work/) and arXiv 2512.08296 v1 (Dec 2025); re-checked. The current [arXiv v3](https://arxiv.org/abs/2512.08296) (2026-04-08) reports 260 configurations over six benchmarks and a cross-validated R² of 0.373 (0.413 with a task-grounded capability metric), still picking the best architecture for 87 % of held-out configurations; the figures in this row are the blog's and v1's | 180 configurations. Centralised coordination +80.9 % on the parallelisable Finance-Agent; every multi-agent variant −39 to −70 % on the sequential PlanCraft. Independent multi-agent systems amplify errors 17.2×, centralised ones 4.4×. A tool-coordination trade-off: the coordination "tax" rises disproportionately with tool count (the blog's example: "16+ tools"). A model from task properties (tool count, decomposability) reaches R² 0.513 and picks the best architecture for 87 % of unseen configurations | Centralised topology only (TD2); sequential and tool-heavy tasks go to a single agent (§8.3); task properties are the router's features |
| R2 | Tran and Kiela, arXiv [2604.02460](https://arxiv.org/abs/2604.02460), Apr 2026; re-checked | At equal thinking-token budgets single agents match or beat multi-agent systems on multi-hop reasoning; many reported multi-agent gains reflect extra compute and context effects | The evaluation compares at matched budgets as well as at natural ones (§11); no team for pure reasoning |
| R3 | Anthropic, multi-agent research system, 2025, as cited in `ADR-003:12` | Token spend explains about 80 % of performance variance; multi-agent work costs about 15× chat tokens | The token budget is the main governor (§7.3) |
| R4 | Vals Vibe Code Bench, as reported by [yage.ai](https://yage.ai/share/multi-agent-what-it-buys-en-20261021.html), 2026-10-21; re-checked | Team runs cost 1.8–5.1× solo. Only one team configuration was significant, Sol at medium effort (+7.3 points), while raising a single Sol from medium to max effort gave +11.4; in that configuration teams beat solo by about 15 points on hard apps and about 1 on easy ones. The Opus teams dispatched subtasks in serial waves and at their slowest took 2.3× as long as a single agent; the Sol teams were faster. Cohere (same article): a weak lead with cheap workers did worse than a strong solo model; delegating only exploration and planning nearly matched full delegation at about half the cost | A strong lead is required (§6.2); "single at higher effort" and "explore + single" are evaluation arms (§11) and router arms (§8); packages are scheduled by dependency, not in serial waves (§6.5) |
| R5 | Cognition, ["Multi-Agents: What's Actually Working"](https://cognition.com/blog/multi-agents-working), 2026-04-22 (re-checked); earlier ["Don't build multi-agents"](https://cognition.ai/blog/dont-build-multi-agents) | Writes stay single-threaded; extra agents contribute intelligence, not actions. The generator–verifier review loop works (Devin Review about 2 bugs per PR, about 58 % severe). Manager and child agents run in production. The reviewer works best with a clean context. The unstructured-swarm approach is "mostly a distraction". Parallel writers fragment implicit decisions | One writer per branch (TD3); ownership and interface contracts in the plan (§6.4); fresh-context review of every package (§6.8); map, reduce and manage, never a swarm |
| R6 | Kim et al., "Scaling Test-Time Compute for Agentic Coding", arXiv 2604.16529, Apr 2026 ([summary](https://www.emergentmind.com/papers/2604.16529)); re-checked | Parallel rollouts are summarised; Recursive Tournament Voting (pairwise groups, about 8 votes) plus Parallel-Distill-Refine. Claude-4.5-Opus: SWE-bench Verified 70.9 → 77.6 %, Terminal-Bench v2.0 46.9 → 59.1 %. Costs are not characterised; the LM judge stays below an oracle selector | Best-of-N with bounded summaries, tests first and the judge only as tie-break, distill-refine optional (§9); we measure the cost ourselves (§11) |
| R7 | Zou et al., "SWE-Verifier", arXiv [2610.30284](https://arxiv.org/html/2610.30284), Oct 2026; re-checked | A small gate-and-selector verifier at decision points: +1.7 points at 1.09× cost, against 3.5–4.2× for trajectory-level verification; verifying every step is not worth it | A later gate at decision points only, never per step (§10) |
| R8 | Cursor 2.2, Dec 2025 ([forum](https://forum.cursor.com/t/cursor-2-2-multi-agent-judging/145826)); not re-checked | Parallel agents with a judge that picks the winner (multi-agent judging) | Product precedent for parallel attempts with a judge (§9) |
| R9 | Claude Code agent teams, experimental ([docs](https://code.claude.com/docs/en/agent-teams)); re-checked | A lead plus teammates with their own contexts; a shared task list with dependencies and file-locked claiming; a mailbox; hooks as quality gates (`TeammateIdle`, `TaskCreated`, `TaskCompleted`); no hard limit, 3–5 teammates recommended, 5–6 tasks per teammate; no nested teams; avoid same-file edits; permission prompts bubble to the lead; a teammate cannot approve or consent on the user's behalf and cannot relay a denied action to another teammate; in-process teammates are not restored on resume | Atomic claiming, dependencies and gate hooks (§6.5); the approval rule (§12); no nested team inside one project (§6.1); resumability is an explicit requirement here because the reference product lacks it (§6.12) |
| R10 | OpenAI Codex subagents, 2026 ([announcement](https://x.com/OpenAIDevs/status/2033636701848174967)); not re-verified (the post cannot be fetched automatically) | A second vendor ships subagents | Precedent only |
| R11 | MAST, "Why Do Multi-Agent LLM Systems Fail?", [arXiv 2503.13657 v3](https://arxiv.org/abs/2503.13657v3); re-checked | A failure taxonomy of 14 modes in three categories: system design issues (called specification issues in v2), inter-agent misalignment, task verification. Step repetition (FM-1.3) is the largest single mode: 15.7 % in v3 (v2's full text gives 17.14 %, per the 2026-11-01 fact-check) | Typed plans and contracts (specification), ownership and interfaces (misalignment), external verifiers and review (verification); a repetition detector (§6.8); MAST tags in the evaluation (§11) |
| R12 | Simon Willison, ["Embracing the parallel coding agent lifestyle"](https://simonw.substack.com/p/embracing-the-parallel-coding-agent), Oct 2025 | Human review is the bottleneck; parallel agents suit research, explanations, small maintenance and carefully specified work | Back-pressure on packages waiting for a person (§7.3); plans are specified before writers start (§6.5) |
| R13 | Christopher Meiklejohn, [MAS series part 7](https://christophermeiklejohn.com/ai/agents/mas-series/2026/04/30/mas-series-07-benchmarks.html), 2026-04-30 | Most widely used benchmarks are designed for single agents and cannot measure coordination quality, communication overhead or failure recovery; the post advises asking for token cost and failure rates | A team tier of decomposable tasks; tokens, wall time and failure modes in every report (§11) |

### 3.2 What follows for the design

- **Teams help** when the work is parallelisable and decomposable, hard, verifiable, and led by a strong model
  (R1, R4). **They hurt** on sequential or tightly coupled work, on tool-heavy tasks with little decomposition, on easy
  tasks, with a weak lead, and whenever several agents write the same code (R1, R4, R5).
- Much of the cheap gain sits in **verification** (a fresh reviewer, R5; dedicated verification roles on hard apps, R4)
  and in **delegating exploration** (R4), not in parallel writing. The design therefore treats `single + review` and
  `explore + single` as first-class options, not as degenerate teams.
- **Compute explains most differences** (R2, R3). Every comparison must state its token budget, and every team run must
  have one.
- **Centralised beats independent** on error amplification (R1: 4.4× against 17.2×). Decisions (assignment, review
  verdicts, merges, `needs-decision`) stay with the lead, the scheduler and the person. The owner added a moderated team
  channel for information between members (§6.16, Q11); it carries no authority, and D115's rule that sibling
  subprojects never talk directly (D115 S8) is unaffected.

### 3.3 What the evidence does not settle

No source evaluates a bandit that chooses between architectures; R1's predictive model supports the premise that task
features predict the best architecture, and I3 makes the bandit an owner decision. No source gives limits such as "8
read helpers" or "4 writers"; those are judgment calls bounded by the governors in §7 (the owner decided them as
recommended, Q2 and Q3), to be replaced by the evaluation's data. R6 reports no cost and R7 uses a trained verifier we
do not have; both are measured here before they become defaults.

## 4. Goals and non-goals

**Goals.** After this design is built:

1. Limits follow budget and capacity, not constants: read-only helpers and writers are separate classes; per-delegation
   turn and time limits follow a task class; the 2,000-token return stays as the summary cap, separate from the work
   budget; writer capacity follows the hardware, and free disk is a hard floor (§7).
2. Several delegations started in one step run concurrently, provably (§7.5).
3. A **coding team mode** reproduces the controller workflow inside the harness: the lead proposes the team and a plan
   in sections, with work packages, dependencies, file ownership and a budget per section; the person confirms the team
   and approves a scope (per package, up to a section, the whole plan, or `auto`); inside that scope one writer per
   worktree and branch, a fresh-context reviewer per package with a capped fix loop, finished packages merged
   autonomously into a revertible section branch, running packages synced at safe points, and a `needs-decision` state
   that asks the person when agents do not converge; the merge of a section into the target branch stays the person's
   unless the section is `auto`; native, external ACP and A2A writers; a moderated team channel; observable, steerable
   and resumable after a restart (§6).
4. **Best-of-N** for hard single tasks (§9) and, later, a **selective verification gate** (§10).
5. A **router** picks single, single + review, explore + single, team or best-of-N: heuristics first, then a local
   contextual bandit over outcomes, tokens and wall time, every decision explainable (§8).
6. An **evaluation** on coding tasks, including a decomposable team tier, replaces `fanout-eval.ts` and decides the
   defaults (§11).

**Non-goals.**

- No reinforcement learning that changes model weights (I3), no telemetry, no learning across installations.
- No unstructured swarm: team-channel messages never assign work, change ownership, approve, merge or start a writer;
  only the scheduler's transitions and the person do (§6.16).
- No nested team inside one project; a package that needs its own team becomes a D115 subproject (§6.1, Q5).
- No general parallel dispatch of all read-only tool calls in the turn loop (ADR-010 L8); concurrency for delegations
  comes from asynchronous delegation (§7.5). L8 stays its own item because it interacts with D120 H3 steering; the
  existing `executeBatch` helper (`toolcall/results.ts:57-67`) is its reuse candidate.
- No change to D109: only a person approves or grants; no new RPC error codes; no history rewrite, force or rebase by
  the core.
- No untrusted code on D119 compute nodes (D123 §11 keeps that boundary); local workers run where the project worktree
  lives, and A2A writers run on their own instance and return commits (§6.10).
- No money dimension: cost means tokens and wall time (ADR-010, amended 2026-10-19).

## 5. Decisions at a glance

| # | Topic | Decision | Main alternative, why not |
|---|---|---|---|
| TD1 | Limits | Classes (read helper, writer, reviewer, judge) with per-class defaults and ceilings; real governors are the token budget (run, section, package), machine capacity from cores and memory (soft, may be exceeded with a warning), a hard disk floor, local-model concurrency and person-review capacity (§7; Q3) | Raise the constants: still five copies, still one number for different risks |
| TD2 | Topology | Centralised decisions: the lead, the scheduler and the person assign, review, merge, sync and decide; workers report to the lead. A moderated team channel with direct messages between all members carries information, never authority (§6.16; owner, Q11) | Unbounded peer messaging (R9's mailbox without budget or brake): R1's error amplification, R5's "mostly a distraction"; no channel at all: rejected by the owner |
| TD3 | Writes | One writer per worktree and branch; a work package is a board card with a card worktree (PR #820) and declared file ownership | Shared worktree with file locks: R5's fragmented decisions; R9: "Two teammates editing the same file leads to overwrites" |
| TD4 | Review | Every package gets the D98 checks and a fresh-context reviewer that sees the diff and the contract, not the writer's transcript; at most 5 fix rounds; open findings or disagreement put the package into `needs-decision`, where the lead presents 2–3 options and the person decides (§6.8; Q8, Q9) | The lead decides alone after the cap: the owner keeps that decision with the person (Q9) |
| TD5 | Merge | Packages merge into their section branch in the plan's order: autonomously inside the approved scope, through `team.merge.confirm` outside it; merges only, never a rebase; D98 gate on every exact tree; at section end a summary and a merge proposal; the section merges into the target branch by the person unless it is `auto` (§6.9, §6.14; Q7) | Every package merged by the person into the target branch: the waiting queue of the controller run (Q19 example, §6.9); auto-merge into the target branch by default: the owner keeps it with the person (I2) |
| TD6 | Lead | Event-driven lead turns at decision points (team proposal, plan, decision options, interface changes, section summaries, synthesis), not a polling loop | A lead that polls the board: tokens spent on waiting |
| TD7 | Durability | All team state in SQLite, written by the TypeScript core with an event log and an action outbox around the transition function; a restart reconciles worktrees and re-executes pending actions (§6.12) | In-memory chains (today, `service.ts:95`) and R9's missing resume |
| TD8 | Best-of-N | Tests first, a pairwise LM tournament only as tie-break, distill-refine optional, N capped by budget (§9) | Judge only: R6's judge stays below an oracle |
| TD9 | Router | Heuristic rules with overrides, then a local contextual bandit (linear Thompson sampling) with hard masks, shadow start and an exploration cap (§8) | A fixed default: I3; weight-changing RL: excluded by I3 |
| TD10 | Evaluation | B1 coding tasks plus a self-authored team tier, at matched and natural budgets, with MAST tags; nightly and advisory (§11) | Keep `fanout-eval.ts`: it measures routing, not quality |
| TD11 | Language | "Rust decides, TypeScript executes": the scheduler's state logic is a pure transition function `tools.team.next` in `plur1bus-tools`; the TypeScript core stores the state, runs turns, D109, the budget and git, and executes the returned actions; plan checker and router are Rust too (§6.3; owner, Q21 (c)) | (a) all orchestration in TypeScript: the logic would move again in Phase 4; (b) the whole scheduler in Rust: an RPC hop on storage and turns that stay TypeScript until Phase 4 step 3 |
| TD12 | Concurrency | `delegate_task` and `consult_agent` gain `wait: false`, plus an `await_delegations` tool; structured concurrency per turn (§7.5) | Parallel dispatch in the turn loop: touches D120 H3 steering semantics and every tool |
| TD13 | Verification gate | Later phase, decision points only, behind the evaluation (§10) | Now: no trained verifier, no baseline |
| TD14 | Workers | Native agents, external ACP CLIs and A2A peers write; an A2A writer works in its own checkout and returns a commit series that the harness applies (merge or `git am`, never a rebase), untrusted until review and gates pass (§6.10; owner, Q11) | A2A peers as helpers only (the earlier recommendation): rejected by the owner |
| TD15 | Sections and scope | The plan has sections with a budget each; the person approves a scope per package, up to section N, for the whole plan, or `auto`; the orchestrator works autonomously inside it (§6.14; Q7) | One approval for the whole run: no stop between sections; approval per merge: the person becomes the bottleneck (R12) |
| TD16 | Sync | After each merge into a section branch the plan checker finds the affected running packages; they get a short notice and, at their next safe point, a merge of the section branch; per package `auto`, `notify-only` or `at-review` (§6.15; owner addition) | Retarget only when a dependency merges: late conflicts and stale interfaces |

## 6. Architecture

### 6.1 Modes

| Mode | Writers | Helpers | Typical use | Started by |
|---|---|---|---|---|
| `single` | 1 (the agent itself) | none | small or sequential tasks | default |
| `single+review` | 1 | 1 fresh reviewer per round | most code changes | router, request, project setting |
| `explore+single` | 1 | up to the read-helper limit, read-only, before and during the write | unfamiliar code, research-heavy tasks (R4's planning-only delegation) | router or the agent through `consult_agent` |
| `team` | k ≤ writer slots, one per package | reviewers, read helpers | decomposable multi-package work | router, `team.create`, a project card; the lead proposes the members (§6.14) |
| `best-of-n` | N attempts, each its own worktree; one survives | judge, then one reviewer | hard single tasks with a test oracle | router or request |

A team never contains a team. If a package itself needs several writers, it becomes a D115 subproject with its own team,
so hierarchy depth (D115 S2, ceiling 2) and chain depth stay separate axes as D115 §3.2 defines.

### 6.2 Roles

| Role | Who | Rights | Notes |
|---|---|---|---|
| Lead | one agent per team run, the strongest configured model tier (R4: weak leads lose) | proposes the team and the plan, decides interface changes inside the approved scope, presents options for a `needs-decision`, writes section summaries, moderates the team channel; never writes package code; cannot approve, decide a `needs-decision` or merge into the target branch | its session lives as long as the run and is compacted as usual |
| Writer | native agent, external ACP agent or A2A peer | local writers: D109 roots = its package worktree only (the D115 §6.4 pattern), its own approval policy and budget (ADR-003 security invariants, `ADR-003:161`); A2A writers: their own checkout on their instance, results applied by the harness (§6.10) | one per package, one package per writer at a time |
| Reviewer | native agent, ACP agent or A2A peer | read-only worktree view, `file.read/list/stat` (`tools/collaboration.ts:65`); no write or exec tools | fresh session per round; never the writer (`coding-gate.ts:54`) |
| Read helper | any agent kind | read-only tools; may consult one further read helper (depth 2) | counted per lead or writer turn |
| Judge | native agent | reads candidate summaries and diffs | best-of-N only |
| Person | project lead, owner or admin | confirms the team, approves plan and scope, decides a `needs-decision`, merges sections into the target branch unless `auto`, overrides, steers | D109: the only approver |
| Scheduler | not an agent: the Rust transition function decides, the TypeScript core executes (§6.3) | admission, worktrees, gates, merges into the section branch inside the scope, sync, resume | deterministic, durable |

`ProjectRole` gains `worker` and `reviewer` beside `member` and `lead` (`collab/types.ts:3`), matching ADR-003's roles
(`ADR-003:143`); project roles stay orthogonal to RBAC roles.

### 6.3 Placement, language and executor (owner, Q21 (c))

```text
 core (TypeScript): storage (single source of truth) · turns · D109 · call budget · git · forge credential
   event: worker returned · checks done · review verdict · merge done · person decided · safe point · timer · restart …
     │ persist event ─► tools.team.next(state, event) ─► (new state, actions[]) ─► persist state + outbox ─► execute
     │                  plur1bus-tools (Rust, x-server "tools"): pure, stateless, no clock, no I/O, no secrets
     ├─► actions: start-worker · start-review · run-checks · merge-into-section · sync-worktree · ask-person · notify
     │            post-message · create-worktree · remove-worktree · lead-turn · pause · cancel
     ├─► writers: native turn in its worktree │ ACP CLI (#820 client, D123 sandbox) │ A2A peer (#843 client)
     ├─► D98 gate (verifier sandbox; D123 SB-8 moves it to Rust later)
     ├─► provisioner (#820; D115 §6.5 fork · mergePreview · merge · revert · remove; section branches, sync merges,
     │   patch application and the orphan scan are new in D124)
     └─► forge sink: push, pull request, required checks (credentials stay in the core)
 plur1bus-tools (Rust): tools.team.next · tools.team.check · tools.team.diffcheck · tools.team.impact · tools.router.*
```

- **Rust decides.** `tools.team.next { state, event } → { state, actions[] }` is a pure, stateless function. The state
  (`plur1bus.teamstate/1`: run, members, sections, packages, merge queue, scope, counters, and the capacity, disk and
  budget facts the core measured), the event and the actions are closed JSON schemas. It reads no clock (time arrives in
  events), opens no file and holds no secret, so the same input always gives the same output: the state machine is
  tested over generated event sequences, and it survives Phase 4 unchanged, when only the thin TypeScript shell is
  ported (D120 §12.2). The plan checker, `tools.team.impact` and the router are Rust for the same reason (ADR-019 (1)).
- **TypeScript executes.** The core stays the single source of truth. Per event it persists the event (`team_events`),
  calls `tools.team.next`, then in one transaction stores the new state, the actions (`team_actions`, the outbox) and
  the event as applied, guarded by the state version; then it executes the actions, and each completion is a new event.
  Turns, D109 approvals, the call budget and git stay TypeScript (ADR-019 (3)): the merge queue, sync and patch
  application use #820's provisioner, the single git implementation D115 §6.5 asks for, which D123 keeps in TypeScript
  as harness-owned git (D123 §1); the forge sink needs a credential, and secrets never enter `plur1bus-tools` (D120 §5).
- **Tools down: fail closed.** No transition runs while `plur1bus-tools` is unavailable: runs pause, running turns
  finish, their results wait as events, and doctor reports the `tools.service` row (D120 §5). There is no TypeScript
  fallback state machine.
- **Cost.** About 2–3 agent days more than an all-TypeScript scheduler (the owner's estimate, a judgment; plan PT-4a and
  PT-4b); the same D120 H1-1 dependency as the plan checker (D123 Q11 proposes pulling H1-1 forward).
- **Executors.** Rust work goes to Claude agents, never Codex without an explicit owner exception; TypeScript work is
  the controller's choice, Sonnet or Opus by size (D120 plan, D122 plan).

### 6.4 Data model

New tables in the collab store (one migration in `collab/migrations.ts`, the next free version at implementation time;
#820 and #843 each add one ahead of it); every free-text field passes the core redactor before it is written, as
delegation contracts do today (`service.ts:275`).

| Table | Key columns | Purpose |
|---|---|---|
| `team_runs` | `id`, `project_id`, `lead_agent`, `mode` (`team` \| `best-of-n`), `state`, `state_version`, `plan_json`, `plan_hash`, `composition_hash`, `approval_scope`, `approved_by`, `target_branch`, `token_budget`, `wall_budget_ms`, `writers_max`, `route_decision_id`, timestamps | one run; `state`: `proposing → awaiting-team → planning → awaiting-approval → running ⇄ paused → done \| cancelled \| failed` |
| `team_members` | `run_id`, `member_id`, `kind` (`native` \| `acp` \| `a2a`), `role`, `model`, `peer_id`, `disclosure` (what an external member receives) | the confirmed team (§6.14) |
| `team_sections` | `id`, `run_id`, `index`, `title`, `goals_json`, `branch`, `auto`, `state` (`open → running → summarising → awaiting-person → merged`, or `auto-merged`), `token_budget`, `wall_budget_ms`, `summary_json`, `merge_sha` | one plan section and its section branch |
| `team_packages` | `id`, `run_id`, `section_id`, `card_id`, `key`, `task_class`, `state` (§6.5, including `needs-decision`), `writer_member`, `worker_kind` (`native` \| `acp` \| `a2a`), `sync_mode` (`auto` \| `notify-only` \| `at-review`), `base_ref`, `branch`, `merge_position`, `round`, `token_alloc`, `deadline_at`, `last_tree_hash`, `decision_json` | one package, one card, one worktree (the #820 `project_worktrees` row by `card_id`) |
| `team_package_deps` | `package_id`, `depends_on`, `kind` (`code` \| `order`) | `code`: may stack on the dependency's branch; `order`: merge after it |
| `team_ownership` | `package_id`, `glob`, `mode` (`own` \| `interface` \| `shared`) | what a package may change; `interface` files need lead approval to change, `shared` files (lockfiles) follow §6.9 |
| `team_rounds` | `package_id`, `round`, `kind` (`review` \| `fix` \| `sync` \| `sync-note` \| `patch` \| `needs-decision`), `agent`, `tree_hash`, `verdict`, `findings_json`, `finding_hashes`, `artifact_hash`, tokens, times | the package history; findings and A2A artifacts are untrusted data |
| `team_merge_queue` | `run_id`, `kind` (`package` into the section branch \| `section` into the target branch), `item_id`, `position`, `sink` (`local` \| `forge`), `state`, `target_ref`, `approved_tree_hash`, `approval_id` (empty for merges inside the approved scope), `pr_number`, `merge_sha`, `reason` | ordered merges; `state`: `waiting → ready → checking → (awaiting-person) → merging → merged`, side states `blocked`, `reverted` |
| `team_messages` | `id`, `run_id`, `thread_id`, `from_member`, `to_member` (empty for a thread post), `body` (redacted), `tokens`, `content_hash`, `state` (`delivered` \| `refused`), `reason`, timestamps | team channel and direct messages (§6.16) |
| `team_events`, `team_actions` | `run_id`, `seq`, `event_json` or `action_json`, `idempotency_key`, `state` (`pending` \| `applied` \| `done` \| `failed`), timestamps | event log and action outbox around `tools.team.next` (§6.3, §6.12) |

**The plan** is a closed JSON document `plur1bus.teamplan/1`: goals; sections in order with `key`, `title`, `goals[]`
and `budget { tokens, wallTimeMs }`; packages with `key`, `section`, `title`, `objective`, `doneWhen[]`, `taskClass`,
`owns[]`, `interfaces { provides[], consumes[] }`, `dependsOn[]`, `worker { kind, member }`, `sync`, `estimate {
changedLines, tokens }`; a `mergeOrder[]` per section. The run budget is the sum of the section budgets. Bounds: at most
32 packages in at most 8 sections (judgment) and the D104 2,000-token rule per package brief (`handoff.ts:13`), with
longer material as artifact references. The card remains the person's surface: title, description, assignees and links
are written from the plan; the team columns live in the tables above, not in the board's JSON document.

### 6.5 Package lifecycle

```text
planned ─► ready ─► writing ─► checking ─► reviewing ─┬─► queued ─► merged-to-section
   ▲          │      ▲   │  ▲                │        │
   │          │      │   │  └── fixing ◄─────┴────────┘   (findings, failed checks, merge or sync conflicts)
   │          │      │   └─► syncing ─► back to writing or fixing (safe point, §6.15)
   │          │      └── person decided ◄── needs-decision ◄── open findings · disagreement · unresolvable conflict
   └── blocked (dependency, interface change, worktree, disk floor, scope) · interrupted (restart) · cancelled · failed
```

- **ready** when every `code` dependency is `queued` or later, the approved scope covers the package (§6.14), admission
  (§7.4) grants a writer slot, and free disk is above the floor (§6.7). Claiming is a single `BEGIN IMMEDIATE`
  transaction on `team_packages`, the equivalent of R9's file-locked claiming.
- **writing**: for a local writer the scheduler forks the card worktree (PR #820 `fork`; the section branch as base, or
  a `code` dependency's branch while that dependency waits in the queue) and starts the writer with a D104 hand-off
  built from the package (objective, `doneWhen`, scope paths = `owns`, forbidden actions, interfaces, the task class's
  limits); an A2A writer gets the same contract plus the remote and the base commit (§6.10).
- **checking**: the D98 checks run on the worktree without completing the card; failures go back as a fix round with the
  failing names (D120 C4 adds the failing lines).
- **reviewing**, **fixing**, **needs-decision**: §6.8. **syncing**: §6.15, entered from writing or fixing at a safe
  point, or right before checking with `at-review`. **queued** onward: §6.9.
- While a package is in `needs-decision`, independent packages continue and the packages that depend on it wait.

Hooks at three points give projects their own gates, as R9's hooks do: `package.created` (refuse a package),
`package.done` (refuse completion), `writer.idle` (send the writer back with feedback). They are commands under a new
optional `hooks` key in the committed `.plur1bus-verifiers.json` (today closed to `commands` and `networkAllowed`,
`coding-gate.ts:12`; a manifest changed during the run is refused, `:70`), run in the verifier sandbox, exit code 2
meaning "refuse with feedback"; no other code path runs project code on the host.

### 6.6 Protocol: tools, RPC, events

**Agent tools.** Existing tools keep their names (`tools/collaboration.ts:113-120`). Additions:

| Tool | Who | Effect |
|---|---|---|
| `consult_agent`, `delegate_task` with `wait: false` | any agent | return `{ taskId }` at once (§7.5) |
| `await_delegations { taskIds[], timeoutMs }` | the starting agent | returns the finished results (each a `plur1bus.return/1` envelope) and the ids still running |
| `team_propose_team { members[] }` | lead | proposes the members, each with role and model, from existing agents, connected sub-agents, ACP CLIs and A2A peers; the person confirms or edits (§6.14) |
| `team_propose_plan { plan }` | lead | validates through `tools.team.check`, stores the draft, asks the person to approve a scope |
| `team_decide { packageId, files[], decision }` | lead | interface changes inside the approved scope |
| `team_decision_options { packageId, options[], recommendation }` | lead | 2–3 options with pros and cons for a `needs-decision` (§6.8) |
| `team_section_summary { sectionId, summary }` | lead | results, findings, tokens and the merge proposal at section end (§6.14) |
| `team_post`, `team_dm`, `team_read` | every member | team channel and direct messages (§6.16) |
| `team_moderate { action, memberId?, threadId? }` | lead | mute a member for a time, close a thread, summarise a thread into a card comment |
| `team_status { runId }` | lead, writers (own package only) | read |

**RPC (core).** Every `team.*` method is **human-only**, as `collab.trace.*` and `collab.chain.cancel` are today (they
are in `FORBIDDEN_EXACT`); agents reach the same information and decisions only through the agent tools above.

| Method | Rights | Work package |
|---|---|---|
| `team.get`, `team.list`, `team.channel.read`, `team.route.explain` | `project.read` and project visibility (the `visibleProject` rule, `collab/service.ts:137-142`) | PT-3a; `team.channel.read` PT-5b; `team.route.explain` PT-11 |
| `team.create { projectId, objective, mode?, cardId? }`, `team.channel.post { runId, threadId?, to?, text }` | `project.write`; `team.create` starts a lead turn, which spends tokens | PT-3a; `team.channel.post` PT-5b |
| `team.composition.confirm { runId, compositionHash, members[] }`, `team.plan.approve { runId, planHash, scope }`, `team.scope.extend { runId, planHash, scope }`, `team.pause`, `team.resume`, `team.cancel`, `team.package.reassign`, `team.package.budget.set`, `team.budget.set { runId, sectionId?, tokenBudget, wallBudgetMs }`, `team.package.sync.set { runId, packageId, mode }` | `project.write` and project role lead, or owner or admin | PT-3a |
| `team.package.decide { runId, packageId, optionId?, note }` (a `needs-decision`), `team.interface.approve { runId, packageId, files[], treeHash }` (an interface marked `person-review`) | as above | PT-5 |
| `team.channel.mute { runId, memberId, untilMs }` | as above | PT-5b |
| `team.merge.order.set { runId, sectionId, order[] }`, `team.merge.confirm { runId, packageId, treeHash, sectionHead }` (a package outside the approved scope), `team.section.merge { runId, sectionId, treeHash, targetHead }` | as above; both merges on a T2 or T3 surface (D109) | PT-6 |
| `team.route.reset` | owner or admin | PT-12 |

**Every one of these methods goes into `FORBIDDEN_EXACT` in `packages/webmcp/src/provider.ts` (`:52`)** with a
`humanOnly` RBAC rule, which `exposure-matrix.test.ts:74-84` enforces.

**RPC (tools).** `tools.team.next`, `tools.team.check`, `tools.team.diffcheck`, `tools.team.impact`,
`tools.router.decide`, `tools.router.outcome`, `tools.router.explain`, `tools.router.reset`; core-only guard as for
every `tools.*` method (D120 §5). All methods: closed params, `x-stability: "experimental"`, `x-since` = the next free
minor **at implementation time** (1.11–1.14 are taken by open PRs #835, #843, #838 and #820), no new error codes, new
reason strings in `docs/errors.md`.

**Events.** `COLLAB_EVENT_TYPES` (`collab/types.ts:118-124`) gains `team.*`, `section.*`, `package.*` and `message.*`
events (proposed, confirmed, approved, state changed, needs-decision, round finished, synced, merged into section,
section summary, section merged, budget warning, capacity warning, message posted); the web board already listens to
`project.card.changed` for live updates (`packages/web/src/pages/projects/page.ts:184`).

### 6.7 Worktrees and disk

- **Create:** #820 `fork({ projectId, cardId })`, extended with an optional base branch (the section branch, or a
  dependency's branch). **Section branches** are named `p1b/<key>/t-<run>/s<N>` (judgment, after #820's
  `p1b/<key>/c-<suffix>`), forked from the target branch for the first section and from the previous section branch
  while that one still waits for its merge. Each open section has one integration worktree for merges into its branch
  and for the gate on its tree, as D115 §6.7 merges in the parent's worktree.
- **Remove:** after `merged-to-section`, `cancelled` or a best-of-N loss, the worktree is removed at once (#820
  `remove`); the branch stays under D115's retention rule (D115 §6.6 step 6: kept, deleted only when fully merged or
  archived, never forced).
- **Disk floor (Q3, hard).** `collaboration.teams.disk.minFreeBytes` (default 20 GiB, schema minimum 1 GiB, so it can be
  lowered but not switched off; judgment) on the volume of the worktree root. Below it the scheduler creates no new
  worktree: packages wait with reason `disk-floor`, and the project's leads get an inbox entry. Free space is measured
  before every `create-worktree` action and every five minutes (judgment).
- **Cleanup.** Build artefacts such as `node_modules` and `target` can take several GB per worktree (owner). Under disk
  pressure (free space below twice the floor, judgment) the core deletes git-ignored build directories
  (`collaboration.teams.disk.cleanPaths`, default `node_modules`, `target`, `dist`, `.venv`) in harness-owned package
  worktrees whose package is not writing, fixing or syncing; never in the user's own checkout and never tracked files.
  The team view shows the disk use of each worktree.
- **Orphan detection** (ADR-003 action item 9, `ADR-003:295`): at start and hourly, the scheduler compares `git worktree
  list --porcelain` of each bound repository with live `project_worktrees` rows (path, branch, `dev`/`ino` identity that
  #820 records). A directory without a row is reported, never deleted; a row without a directory marks its package
  `blocked` with reason `worktree-missing`; an identity mismatch is `worktree-unsafe`.
- **Count:** at most `writers_max` + N best-of-N attempts + one integration worktree per open section live per run; A2A
  writers need none on our side until their series is applied, then the package worktree.

### 6.8 Review loop and `needs-decision`

1. A package reaches `reviewing` after green checks. The reviewer gets the contract (objective, `doneWhen`, ownership,
   interfaces) and the diff against the base, **not** the writer's transcript (R5's clean context). Its return uses the
   existing `verdict`/`findings` schema (`tools/collaboration.ts:63`) plus a severity per finding. For an A2A writer the
   diff comes from the applied series in our worktree.
2. `pass` records the review bound to the tree hash (`coding-gate.ts:53-57`) and queues the package. `changes_requested`
   starts a fix round: the writer receives the findings as untrusted data, may answer per finding (`fixed`, `disputed`
   with a reason), commits, and the next round reviews the new tree with a fresh reviewer session.
3. **Cap and early stop (Q9):** after 5 review rounds with findings still open the package enters `needs-decision`;
   earlier when the same finding hash appears in three rounds, or when writer and reviewer (of any kind, A2A peers
   included) dispute the same finding twice: R11's step repetition is the largest single failure mode.
4. **`needs-decision` (owner, Q9).** The package stops; project, team thread and card pulse yellow in the web UI until
   it is decided; an inbox entry goes to the project's leads, owner and admins (the closed `kind` set,
   `docs/inbox.md:15` and `inbox/store.ts:9`, gains `team`); the lead presents 2–3 options with pros, cons and its
   recommendation through `team_decision_options`, for example: accept the finding and open a follow-up card; another
   worker or model; change the scope. The person decides with the human-only `team.package.decide` (a chosen option or a
   free note). Independent packages continue; dependants wait. A split or a scope change alters the plan hash and needs
   the person's approval of the changed plan. Other triggers: an unresolvable sync conflict (§6.15) and the failures of
   §6.11.
5. **Ownership and interfaces:** before review, `tools.team.diffcheck` compares the changed files with the package's
   globs. A change outside `owns` is refused back to the writer; a change to an `interface` file pauses the package
   until the lead approves through `team_decide` (and a person through `team.interface.approve`, if the plan marks the
   interface `person-review`).

### 6.9 Merge queue and section branches

- **Targets:** packages merge into their section's branch; a section merges into the run's target branch (§6.14).
- **Order:** the plan's `mergeOrder` per section, which `tools.team.check` verifies against `dependsOn` (a topological
  order, ties in plan order). A person may reorder (`team.merge.order.set`); a reorder that breaks a dependency is
  refused.
- **Inside the approved scope (owner, Q7):** when a package is `queued` and the D98 gate is green on its exact tree, the
  scheduler merges it into the section branch by itself, with a merge commit through the provisioner in the section's
  integration worktree; the section branch stays revertible and the target branch is untouched. Outside the scope (scope
  `package`) the merge needs `team.merge.confirm`, an approval bound to package, tree hash and section head.
- **Stacks and sync:** a package with a `code` dependency may fork from the dependency's branch while that dependency
  waits in the queue; once the dependency is in the section branch, the dependant receives the section branch through
  sync (§6.15), which replaces retargeting. Every such step is a merge (`git merge --no-ff --no-edit`, fixed argv),
  never a rebase; a conflict becomes a fix round for the package's writer: merge and resolve, as a normal
  commit-producing task.
- **Deliberate difference from D115 §6.6 step 3.** D115 sends a conflicting child back with the instruction "rebase onto
  parent", done by the child agent as a normal commit-producing task in its own worktree (never a history rewrite by the
  core), or resolves in the parent. D124 uses a merge instead of a rebase for team packages, because a package branch
  may already carry a review bound to its tree, have stacked packages forked from its commits, or be pushed as a pull
  request (forge sink); a rebase would rewrite exactly those commits. Both keep D115's rule that the core never rewrites
  history.
- **Shared files** (lockfiles, generated registries): owned by none; after each merge the queue regenerates them in the
  next package's worktree through the project's D98 manifest, or the plan names one package as their owner (a plan
  field, not an owner question).
- **Gate:** the D98 gate runs on the exact tree before every merge into a section branch, autonomous ones included, and
  on the section branch's tree before the section merge (`approvedTreeHash`, D115 §6.6 step 5); with the forge sink, the
  forge's required checks must be green as well.
- **The person merges into the target branch (I2, D109).** At section end the lead's summary (results, findings
  including accepted residuals, tokens and wall time per package, the merge proposal) goes to the person; the human-only
  `team.section.merge` (T2 or T3 surface, an approval bound to the section's tree hash and the target head; any change
  voids it) merges the section branch into the target branch with a merge commit. An `auto` section merges by itself
  when the gate is green, is announced in the project feed and can be reverted, the pattern of D115's `auto` mode (D115
  §6.6 step 4).
- **Sinks (Q6).** *Local:* merges through the provisioner (`mergePreview`, `merge`, `revert` as D115 §6.5 specifies;
  built here once, reused by D115 WP4); the root branch reaches the base branch through D115 WP4b. *Forge:* the section
  branch is pushed under the per-run grant (Q18) with one pull request into the target branch; the forge's required
  checks are the CI gate; the person merges on the forge or through `team.section.merge`, which merges by API as a merge
  commit. With scope `package`, each package also gets its own pull request into the section branch, the controller
  workflow one to one. #820's refusal of `push` (`provisioner.ts:11`) stays for every other path.
- **Back-pressure (Q19).** While 3 items wait for a person (`needs-decision` packages, package merges outside the scope,
  section merges, scope approvals), no new package starts writing (R12). Packages merged autonomously inside an approved
  section do not count (owner, Q7). The owner's example from the controller run of 2026-10-31 to 2026-11-01: five pull
  requests (#835, #843, #838, #840, #841) waited at the same time; branches went stale, RPC minors had to be renumbered
  across branches, branches were merged again and again, and an unsolicited parallel writer appeared. The fetched
  history of #843 shows one such re-merge (`111328e2`, "Merge updated budget API base and retain RPC 1.12").

### 6.10 Workers: native, external ACP, A2A

- **Native:** a turn of the writer agent through the composed runner (`composition/collaboration.ts`), with the package
  worktree as its only root, the task class's round limit as `maxRounds`, and the work budget from the package
  allocation (not the 2,000-token return cap).
- **External ACP** (ADR-011 tier 1: Claude Code, Codex, Goose; Gemini best-effort, `ADR-011:85-98`): one ACP session per
  package with `cwd` = the package worktree (#820), `session/request_permission` routed to D109 as today, `fs/*` and
  `terminal/*` contained by #820 and, after D123 SB-5, by the Rust sandbox. Its own approval policy and budget
  (`ADR-011:63`).
- **A2A peers as writers (owner, Q11).**
  1. *Trust.* The peer is registered and trusted through #843's pinned registry: `a2a.peer.add`, then an explicit
     `a2a.peer.trust` of a fingerprint and revision; a replaced key needs remove, add and a new trust decision
     (`a2a/peer-store.ts:47,122-130` at `2887e8dbd3`; `docs/a2a.md:7` there). Where Track F has paired the instances
     (D114 F-R4: federation invite with TLS pin and instance fingerprint, both owners confirm), that pairing qualifies
     as well. The person confirms every A2A member with the team (§6.14).
  2. *Checkout.* The peer works in its own checkout of the repository with its own read access; the brief names the
     remote, the base commit and the package contract. No harness credential crosses the link (D114 §1: "No secret ever
     crosses the link"). If the peer has no read access, the harness sends the base as a git bundle only when the person
     confirmed that disclosure with the team.
  3. *Result.* The peer returns a commit series as an A2A artifact (`file` part): a git bundle (preferred) or an mbox
     from `git format-patch`. #843's outbound client reads only text parts today (`a2a/peer-client.ts:23`,
     `acceptedOutputModes` text at `:119`), so PT-8b adds file parts (U14).
  4. *Apply.* The series is untrusted until review and gates pass. The core checks its size (16 MiB per artifact,
     judgment), that every commit descends from the package head the peer was given, that every changed path is inside
     `owns` (`tools.team.diffcheck`), and that it contains no gitlink and no symlink leaving the worktree. It then
     fetches a bundle into a quarantine ref and merges it into the package branch (`--no-ff`), or applies an mbox with
     `git am`; harness-owned git runs with hooks off, as `gitText` does today (`collab/verifier.ts:61`); never a rebase.
     A rejected series goes back to the peer with the reason.
  5. *Then* the same D98 checks, review, merge queue and sync as for local writers. Findings go back to the peer as an
     A2A message; its next series must build on the last applied head.
  6. *Capacity.* A2A writers count against `writers.perProject`, not against machine capacity; their D98 checks do.
- **One identity, several sessions:** the same agent may write several packages at once, each in its own worktree and
  `AgentScope` (`ADR-003:139`); memory capture follows the 2026-10-29 rule (`ADR-003:165-172`), so each package's
  exchange is captured with origin `collab` and its own trace.

### 6.11 Failure handling

| Failure | Detection | Response |
|---|---|---|
| Writer crash or model error | run rejects | one retry with the profile's fallback model; then `needs-decision` |
| Writer stalls | no tool call and no tree change for the class's stall time | a D120 H3 steer ("report status"), then restart with a resume brief (§6.12), then `needs-decision` |
| Package exceeds its allocation or deadline | budget refusal or timer | partial return kept (today's `interrupted` semantics, `ADR-003:159`); `needs-decision` (raise the allocation with `team.package.budget.set`, reassign, cut scope) |
| Run or section budget exhausted | team or section scope refusal | the run or section pauses (never cancels); the person may raise the budget (`team.budget.set`) |
| Review does not converge, or agents disagree | round cap, repetition, dispute (§6.8) | `needs-decision` |
| Checks or CI red | gate result | fix round with failing names |
| Merge conflict into the section branch | `mergePreview` | fix round for the package |
| Sync conflict | merge at the safe point (§6.15) | the writer's next task; unresolvable → `needs-decision` |
| A2A series rejected | base, path, size, gitlink or symlink check (§6.10) | sent back to the peer with the reason; the second rejection → `needs-decision` |
| Dependency failed or cancelled | state change | dependents `blocked`; a lead turn re-plans (person re-approves a changed plan) |
| Interface change | `tools.team.diffcheck` | package paused until lead (and person, if marked) approves |
| Worktree missing or replaced | reconciliation (§6.7) | `blocked`, reason named; no automatic re-creation over existing files |
| Free disk below the floor | measurement (§6.7) | no new worktree; packages wait (`disk-floor`); inbox entry; cleanup |
| Writer slots above the computed capacity | admission (§7.3) | allowed; warning in the team view and the log |
| Channel repetition | brake (§6.16) | message refused or pair paused; the lead is notified |
| External CLI or A2A peer unavailable | ACP initialise or A2A call fails | reassign to another member if the composition allows, else `needs-decision` |
| `plur1bus-tools` unavailable | RPC error | runs pause; no transitions until it is back (§6.3) |
| Lead unavailable | lead turn fails twice | run pauses; the person is notified |
| Core restart | start-up | §6.12 |

### 6.12 Resumability (a requirement)

R9's reference product does not restore teammates on resume. Here a restart must not lose a run:

1. **State is durable:** runs, members, sections, packages, rounds, queue entries, messages, the event log and the
   action outbox, worktree rows and budget reservations are in SQLite; nothing a run needs lives only in memory (unlike
   `service.ts:95`). The transition function holds nothing.
2. **Reconcile first:** worktrees (§6.7), interrupted merges in package and integration worktrees (detected by
   `MERGE_HEAD`, aborted with `git merge --abort`, then re-queued), and expired budget reservations (the call budget's
   TTL).
3. **Replay:** an event that was persisted but not applied is applied again; `tools.team.next` is pure, so the result is
   the same. Actions in the outbox that are not done run again; each checks its own effect first (a merge is done when
   the package head is already an ancestor of the section head; a worker start is done when the package has a live
   session; an A2A artifact is applied once, by its hash in `team_rounds`).
4. **Resume packages:** a package in `writing`, `fixing` or `syncing` without a live worker becomes `interrupted` and
   restarts with a **resume brief**: the contract, the branch's log since its base, the uncommitted diff (the worktree
   survives a restart), the last partial return and the open findings. A new session, not a transcript replay; the
   worktree carries the work.
5. **External workers:** ACP `session/load` where the CLI supports it (U1), otherwise the resume brief; A2A tasks are
   re-read by task id (U2).
6. **Lead:** its session resumes from the session store; pending decisions are re-issued as a lead turn.
7. **Acceptance:** a kill test (core killed during writing, review, sync, a merge into a section branch and a section
   merge) ends with every package back in its prior state or `interrupted`, no orphan process, no lost commit and no
   double merge.

### 6.13 Observability and steering

- **Trace:** every lead, writer, reviewer and helper hop is a collab span with `team` and `package` attributes and a
  replayable session (`ADR-003:163`); a package's spans link to its card.
- **Team view** in the web kanban (`packages/web/src/pages/projects/`): one lane per package with state, round, writer
  and its kind, token burn against allocation, wall time, findings by severity and the disk use of its worktree;
  sections with branch, budget, state and summary; the merge queue per section; pending approvals of all workers in one
  panel; the team channel; the router's explanation; a warning while writer slots exceed the computed capacity.
- **`needs-decision`:** project, team thread and card pulse yellow until decided; the inbox entry links to the options
  with pros, cons and the lead's recommendation.
- **Steering:** a person can steer the lead or any writer through D120 H3 (`session.submit` with `delivery: "steer"`,
  D120 §9.6) and post in the channel; confirm, approve, extend, pause, resume, cancel, reassign, re-budget, decide,
  reorder and merge are the human-only RPCs of §6.6. The CLI gets `plur1bus project team
  status|confirm|approve|decide|pause|resume|cancel|merge` as a thin client (`merge --section` for a section merge).
- **Logs:** `team.*` events in the D111 catalogue carry ids, counts, states and reasons, never brief, diff or message text.

### 6.14 Team composition, sections and approval scopes (owner, Q7)

1. **Composition.** After `team.create` the lead proposes the team (`team_propose_team`): members from existing agents,
   connected sub-agents, ACP CLIs and A2A peers, each with a role (writer, reviewer, read helper, judge) and a model,
   and for each external member what it would receive (for an A2A writer the repository remote, or a base bundle). The
   person confirms or edits the team (`team.composition.confirm`, bound to the composition hash).
2. **Plan.** Goals, sections in order, packages per section with dependencies and file ownership, and a budget per
   section. `tools.team.check` checks the dependency graph across sections (a package may depend on an earlier section,
   never on a later one) and ownership within each section.
3. **Approval scope,** chosen by the person in `team.plan.approve` and widened later with `team.scope.extend`: `package`
   (one package at a time; its merge into the section branch needs `team.merge.confirm`), `section:N` (every package of
   the sections up to N), `plan` (every section), or `auto`, a project setting (`collaboration.teams.approval.auto`, set
   by a project lead, owner or admin) under which section merges into the target branch need no person either. The
   approval is a record bound to plan hash, composition hash and scope; a plan change voids the part of the scope it
   touches.
4. **Autonomy inside the scope.** The scheduler starts packages, assigns writers, sends packages to review and back for
   fixes, syncs them, and merges finished packages into the section branch; the lead decides interface changes. A
   `needs-decision` still asks the person.
5. **Section end.** When every package of a section is merged or decided, the lead writes the section summary (results,
   findings including accepted residuals, tokens and wall time, merge proposal) with `team_section_summary`; the section
   then waits for `team.section.merge` unless it is `auto` (§6.9). A forge push needs the per-run grant (Q18).
6. **Budget per section:** the call budget gains a `section` scope beside `team` and `package` (§7.3).

### 6.15 Sync at safe points (owner addition)

1. **Trigger:** every merge into a section branch.
2. **Impact:** `tools.team.impact` (Rust, beside the plan checker) takes the merged files and changed interface files,
   and for every running package its `owns`, `interfaces.consumes` and `dependsOn` from the plan and the files it has
   changed so far. A package is affected when it depends on the merged package, consumes a changed interface, or has
   changed a file the merge also changed.
3. **Unaffected packages** get a note in their history (`team_rounds` kind `sync-note`), nothing else.
4. **Affected packages** get an immediate short direct message (§6.16) with a summary of the changed interfaces: the
   interface files and, once D120 C3's outline queries exist, their changed symbols, plus the merged package's return
   summary; never the full diff (U19).
5. **Safe point:** between two rounds, with the writer's work committed and no uncommitted changes (`git status
   --porcelain` empty). There the provisioner merges the section branch into the package branch (`git merge --no-ff
   --no-edit`), never a rebase. The D98 checks run again; a package that had already passed review gets a review round
   if the tree changed beyond the merge.
6. **Conflicts** become the writer's next task; a conflict that stays unresolved twice, or touches files outside `owns`,
   puts the package into `needs-decision` (yellow, §6.8).
7. **Per-package setting** `sync` (plan field; `team.package.sync.set`): `auto` (default), `notify-only` (the message
   only; the merge happens when the package merges into the section branch), `at-review` (the merge right before
   checking).
8. **A2A writers:** the core merges on our side after the last applied series and sends the new head to the peer: with
   the forge sink by pushing the section branch, otherwise as a bundle under the disclosure confirmed with the team
   (U17).

### 6.16 Team channel and direct messages (owner, Q11)

1. **Channel.** One per team run, shown as the run's thread in the project, with sub-threads per package and per topic,
   plus direct messages between any two members (native, ACP, A2A) and from persons. Persons who can see the project can
   read every thread and every direct message between agents.
2. **Purpose and authority.** Solution-oriented exchange as needed: interfaces, fixtures, questions. Messages are
   untrusted data (`ADR-003:161`): they never assign work, change ownership, approve, merge, start a writer or decide a
   `needs-decision`; only the scheduler's transitions and the person do. A message cannot carry an approval (D109; the
   rule R9 states for its teammates). A writer acts on a message only inside its package scope; interface changes still
   go through `tools.team.diffcheck` and the lead.
3. **Delivery.** Native members receive new messages at the next round boundary as untrusted peer input, the way the
   composed runner passes a hand-off (`peerResults`, `composition/collaboration.ts:51`), and use `team_post`, `team_dm`
   and `team_read`. ACP members receive queued messages with their next `session/prompt` (#820's client sends text
   prompts, `acp-client.ts:84` at `dbdb6202c9`; ACP has no mid-prompt input, D120 U15); they can post when the CLI uses
   harness tools offered through `session/new`'s `mcpServers` (`acp-client.ts:74-75`), otherwise they only read (U15).
   A2A members receive messages as A2A messages on their task, and their text replies are posted for them (U18).
4. **Bounds.** A message is at most 2,000 tokens (the D104 bound, `handoff.ts:13`), longer content by artifact
   reference; posting is admitted against the run budget, since every delivery costs the recipients input tokens; at
   most 20 messages per member per hour (judgment). **Repetition brake** (R11's step repetition): a message whose
   normalised hash the same sender already posted in the run is refused (`repeat`); a pair that exchanges more than 6
   messages without a commit, a state change or a new finding is paused and the lead is notified (judgment numbers,
   tuned with PT-2's data).
5. **Moderation.** The lead mutes a member for a time, closes a thread or summarises it into a card comment
   (`team_moderate`); persons do the same through `team.channel.mute` and post through `team.channel.post`.
6. **Privacy.** Every message passes the core redactor before storage and delivery; A2A members receive only the channel
   of the run they belong to; nothing from a person's memory or private chats is posted automatically; logs carry
   counts, never bodies.

## 7. Limits model

### 7.1 Today's constants and their replacement

| Guard | Today | Decided | Evidence or reason |
|---|---|---|---|
| Depth | 1 for everyone (`defaults.ts:5`; tool refuses any nesting, `tools/collaboration.ts:45`) | writers only at depth 1 (children of the lead); read-only helpers up to depth 2 (Q2) | R1 centralised; ADR-003 Q5 asked whether a two-level chain is needed (`ADR-003:282`) |
| Starts per turn | 3, all kinds (`defaults.ts:6`, `tools/collaboration.ts:50`) | read helpers 8 per turn, ceiling 32 (Q2); writers by slot, not by turn | judgment, bounded by the call budget |
| Writers | none (same counter) | 4 per project, configurable; capacity derived from cores and memory and configurable; exceeding it is allowed with a warning, no fixed upper cap (Q3, §7.3) | judgment; R9's 3–5 teammates as a comparable product default |
| Disk | none | hard floor of free space for new worktrees, configurable, not disable-able (Q3, §6.7) | owner: worktrees with build artefacts take several GB |
| Per pair | 2 (`defaults.ts:7`, `tools/collaboration.ts:49`) | 4 for consults (anti ping-pong); none for package delegation, where each package is its own card | MAST repetition is caught by §6.8, §6.16 and the repeat guard |
| Messages | none | 2,000 tokens each, 20 per member per hour, repetition brake (§6.16) | judgment; R11 |
| Turns and time | 25 turns, 5 min per chain (`defaults.ts:8-9`, `service.ts:190-195`, `:267`) | per delegation, by task class (§7.2); runs and sections have wall-time budgets | a chain-wide 5 min timer cannot host a coding package |
| Work budget | none for the delegation; 2,000 output tokens per model call (`composition/collaboration.ts:51`) | the package's token allocation from its section budget, admitted per call; the per-call output cap from the model profile | separates work from summary |
| Return cap | 2,000 tokens | unchanged; full results by pointer | ADR-010 §4; R6 summarises rollouts too |
| Token budget | optional per project (`defaults.ts:13`) | mandatory per run, split into sections and packages, admitted per call | R3 |
| Cycle and self-call, abort propagation, partial results, repeat window | as in `guardrails.ts:21-22,27`, `service.ts:235-247` | unchanged | ADR-003 table |

### 7.2 Task classes (Q4)

| Class | Rounds per delegation | Wall time per delegation | Stall time | Used for |
|---|---|---|---|---|
| `consult` | 25 | 5 min | 2 min | questions, read helpers (today's values) |
| `research` | 50 | 15 min | 5 min | exploration, explanations |
| `review` | 40 | 20 min | 5 min | reviewers, judges |
| `code-small` | 100 | 45 min | 10 min | packages under about 200 changed lines |
| `code-large` | 200 | 120 min | 15 min | larger packages |

These values are judgment calls: no source in §3 gives them. The `consult` row keeps Goose's defaults that ADR-003
cites; the others scale with the work. PT-2's evaluation records rounds and wall time per class, and the defaults move
to the measured 95th percentile plus margin after the first baseline. The token allocation per package is not in this
table: it is the section budget split by the plan's estimates (§7.3).

### 7.3 Governors

1. **Token budget.** A run cannot start without finite section budgets (the person sets them with the plan approval; the
   plan's estimates are the suggestion). The call budget gains three scopes, `team` (id = run), `section` and `package`,
   as an additive change in the next call-schema version (`budget/calls.ts:13`; main is at version 2, `:134`); each
   package's limit is its allocation, each section's limit its budget, the run's limit their sum, and every provider
   call is admitted against all matching scopes as today (`composition/provider.ts:532`). A refusal happens before the
   call, never after.
2. **Machine capacity (owner, Q3).** The computed capacity is `max(1, min(⌊cores ÷ coresPerWriter⌋, ⌊available memory ÷
   memoryPerWriter⌋))`, where `cores` is what `supervisor.maxCores` allows (`config.schema.json:602`), `coresPerWriter`
   defaults to 2 and `memoryPerWriter` to 4 GiB (judgment: each writer runs builds and tests; PT-2 measures peak memory
   per writer, U16). `collaboration.teams.capacity.maxWriters` overrides the computed value. Writer slots are
   `min(writers.perProject, capacity)`, so more cores and more memory give more writers. A person may set either value
   above the computed capacity: CPU and memory are soft, so the scheduler runs the extra writers and shows a clear
   warning in the team view and the log (`team.capacity.exceeded`); there is no fixed upper cap. Disk is the hard limit
   (§6.7). A2A writers count against `writers.perProject` only; concurrent D98 checks have their own bound; each
   external worker process keeps its D123 task and memory limits.
3. **Local-model concurrency.** Calls to a local endpoint (loopback or a D51 node; D119 leaves `llm.chat` unqueued, D119
   §5.1) pass a per-endpoint semaphore, default 1 (judgment; PT-4b builds it, PT-2 measures throughput at 1, 2 and 4
   concurrent requests per endpoint, U3). A blocked call waits; it is not refused. Cloud providers have no fixed cap;
   rate-limit errors go through the retry budget.
4. **Review and person capacity.** Reviewer runs count against a reviewer pool (default = the writer slots); items
   waiting for a person are limited to 3 (Q19, §6.9), autonomous merges inside an approved section not counted.
5. **Channel:** the message bounds of §6.16.

### 7.4 Admission

The transition function decides from the facts the core passes in the event (free slots, free disk, budget remaining);
the core's transaction makes the reservation, synchronously.

```text
admit(start s):
  guardrails: self-call, cycle, depth by class               → refuse (guardrail reason, as today)
  s is a read helper and turn helpers ≥ readHelpers.perTurn     → refuse "fanout"
  s is a writer and the approved scope does not cover it        → wait "scope"
  s is a writer and (slots full or person queue full)        → wait in "ready" (not a refusal)
  s needs a worktree and free disk < floor                    → wait "disk-floor"
  run, section or package budget remaining < package minimum  → refuse "token-budget" before any call
  reserve the slot synchronously (no await between check and reservation)
  every model call                                          → checkBeforeCall with team, section and package scopes
```

### 7.5 Concurrency

- `consult_agent` and `delegate_task` accept `wait: false` and return `{ taskId }` after the slot is reserved; the run
  is the library's existing non-blocking `collab.delegate` (`service.ts:488-527`). `await_delegations` collects results.
- **Structured concurrency:** a turn cannot end with children it started and did not bind to a card; at the end of the
  turn they are awaited up to their deadlines, then cancelled with partial results. Card-bound children survive the turn
  (they belong to the scheduler).
- **The race is closed:** the tool reserves its start slot and its pair slot before any `await` (today it checks at
  `tools/collaboration.ts:49-50`, awaits at `:68`, increments both at `:80`), and the turn's trace is created before the
  first start instead of after the first completion (`:101`), so concurrent first calls share one chain and the
  library's per-chain counters see every sibling (today `getChain` opens a new chain for each, `service.ts:206-207`).
- **Proof (PT-1 acceptance):** four delegations started in one step run against fake runners that each block on a shared
  barrier released only when all four have started. On today's code the test times out, because the second run never
  starts while the first waits; after PT-1 it passes, and the recorded maximum concurrency is 4. No `sleep`
  synchronisation.

## 8. Router

### 8.1 Scope and arms

The router decides for coding work bound to a project (a card, `team.create`, or a `plur1bus code` session with a card,
D120 §8.8). Arms: `single`, `single+review`, `explore+single`, `team(k)`, `best-of-n(N)`. Chat-level consult fan-out stays
an agent's own choice within the limits; using reply outcomes for chat-level arms is a later extension (§8.4).

### 8.2 Features

All numeric or enumerated, never content: task class; estimated changed lines and files (from the lead's draft plan or a
quick plan for small tasks); package count k; dependency density and the critical path's share of the packages
(sequentiality); predicted ownership overlap (`tools.team.check`); the worker profile's tool count (R1's coordination
tax); whether a test oracle exists (failing tests or a checker); language; repository size bucket; lead model tier;
budget headroom (budget ÷ estimate); deadline pressure; the length of the person queue; smoothed past outcomes per arm in
this project.

### 8.3 Heuristic stage (first, and always the safety frame)

Rules in order, each recorded in the explanation:

1. An override by the person, the request (`mode`) or the project setting wins.
2. Sequentiality ≥ 0.7 or k < 2 → no `team` (R1's sequential penalty).
3. Tool count ≥ 16 and k < 3 → no `team` (R1's tool tax).
4. Predicted ownership overlap > 0.2 → no `team` (R5's fragmentation).
5. A test oracle, a task marked hard and budget headroom ≥ 3 → `best-of-n(3)` (R6, R8).
6. k ≥ 2, overlap ≤ 0.2, at least medium size and a strong lead tier → `team(min(k, writer limit))` (R1, R4).
7. Otherwise `single+review` for code changes (R4, R5), `single` for tiny ones.

Rules 2–4 are **hard masks**: no exploration can override them, only a person. The thresholds are judgment calls, tuned
from PT-2's data.

### 8.4 Contextual bandit

- **Model:** linear Thompson sampling, a Bayesian linear regression per arm over the feature vector (at most 24
  dimensions); the heuristic's choice starts with a slightly higher prior mean. Sampling gives a propensity per decision
  (estimated from posterior samples), logged for later off-policy evaluation. Older observations decay (half-life 90
  days, judgment) because models change.
- **Reward:** `r = s − λ_t · tokens / T_ref − λ_w · wall / W_ref`. `s` is an outcome ladder: 1 merged with green gates
  and no revert within 14 days; 0.7 merged after a `needs-decision`; 0.3 partial; 0 failed or cancelled. `T_ref` and `W_ref`
  are the rolling medians of the `single` arm for the task class. Defaults λ_t = 0.3, λ_w = 0.2 (Q14, judgment,
  person-adjustable). A provisional reward is written when the package closes, the final one after the revert window;
  updates are idempotent per decision id.
- **Signals:** D98 gate results, review findings and their severity, CI results, merges and reverts, tokens and wall time
  from the ledger; for later chat-level arms, the engine's reply outcomes, reading only `outcome`, `feedback` and
  `confidence` and never `userPrompt` or `replyText` (`ledger_types.rs:510-526`).
- **Safety:** arms that exceed budget headroom are masked; hard masks (§8.3) stay; start in shadow mode (decisions logged,
  the heuristic acts) and then explore at most 10 % of decisions away from the heuristic until each arm has 30 outcomes
  (Q13).
- **Store and privacy:** `state/router.sqlite`, single writer `plur1bus-tools`; rows hold ids, the feature vector, arm,
  propensity, heuristic arm, override and rewards; nothing leaves the installation; reset only through the human-only
  `team.route.reset`.
- **Explanation:** for each decision, the feature values, the rules that fired, posterior mean and spread per arm, the
  sampled values, the chosen arm, whether it explored, and masked arms with reasons (`team.route.explain`, team view).

## 9. Best-of-N

1. **Attempts:** N workers, each in its own card worktree from the same base, with the same contract and no contact with
   each other. Diversity through different models or providers where configured (R8), otherwise seeds.
2. **Budget:** N × the per-attempt allocation must fit the run budget; N defaults to 3, at most 8 (Q12). Once two
   candidates pass the tests, the remaining attempts are cancelled with partial results kept.
3. **Selection, tests first:** the D98 checks and the task's oracle (the failing tests named in the contract) run in the
   verifier sandbox; failing candidates drop out. One survivor wins.
4. **Tie-break:** with several survivors, bounded summaries (at most 2,000 tokens each) go into a pairwise tournament:
   pairs, 8 judge votes per pair (R6's setting, configurable), a judge model different from the candidates' where
   possible; a tied pair goes to the smaller diff (judgment).
5. **No survivor:** optional distill-refine (off by default): the judge's top two summaries seed a second round of N
   attempts, then selection again (R6's PDR).
6. **After:** the winner takes the normal path (review, merge queue); the losers' worktrees are removed. The judge's
   accuracy is checked in PT-2 against the hidden checkers, because R6 finds LM judges below an oracle.

## 10. Selective verification gate (later phase)

At three decision points, never per step (R7): the writer's first edit of a package, the hand-over to review, and the
entry into the merge queue. A small verifier model (local or the `cheap` tier) scores the candidate against the
contract; below a threshold calibrated on PT-2's data, it asks for one alternative candidate (first point) or an extra
review round (the other two). Off by default. R7's gains come from a trained verifier; a prompted one may not reach
them (U7), so PT-13 only ships if the evaluation shows a gain at a small token overhead.

## 11. Evaluation

Replaces `collab/fanout-eval.ts` and `scripts/m5-fanout-eval.mjs` (ADR-003 action item 8, `ADR-003:294`; M5 acceptance
8).

- **Task sets.** (a) D120 B1's 24 self-authored coding tasks (D120 §6.6), single-package. (b) A new **team tier**,
  self-authored under the same rules (MIT, seeded variants, hidden checkers): 12 decomposable multi-package tasks (3–5
  packages each, a checker per package and an end-to-end checker) and 6 deliberately sequential or tightly coupled tasks
  that measure the sequential penalty and whether the router avoids it (R1, R13). (c) Subsets of SWE-bench Verified and
  Terminal-Bench in local-only runs (Q15, decided 2026-11-01; it amends D120 Q21, "self-authored only", for evaluation
  only): D120 §6.6 records that the SWE-bench harness is MIT while its instances are third-party code under their own
  licences with dataset terms of their own, and that Terminal-Bench is Apache-2.0 at repository level while single tasks
  can embed third-party files. The runner (PT-14) fetches them at run time, never vendored and never in CI, and reports
  aggregate counts only.
- **Arms.** `single`, `single` at the highest reasoning effort (R4's control), `single+review`, `explore+single`,
  `team`, `best-of-n(3)`; each arm joins when its package lands.
- **Budgets.** Matched: the same token cap per task for every arm (R2's fair comparison). Natural: each arm at its
  default (what a person pays).
- **Metrics.** Resolved rate per tier and language; tokens in and out with the cache-read share; wall time p50 and p95;
  model calls; review findings by severity; fix rounds; merge conflicts; person interventions and approvals; failure
  modes tagged by MAST category (system design, inter-agent misalignment, task verification) with a step-repetition
  count (R11); `needs-decision` count; sync merges and sync conflicts; channel messages and repetition-brake hits;
  resolved per million tokens.
- **Statistics.** Paired per task and seed (McNemar or sign test) with the counts shown, as B1 does.
- **Schedule.** Nightly and advisory, B1's secret pattern (credentials only in the setup step, a canary searched in log
  and report); PR runs use the fixture self-test.
- **Use.** The limit defaults (§7.2) and the router's thresholds and priors move to measured values; router-initiated
  teams are switched on per task class only when the team arm beats `single+review` on that tier at natural budgets with
  a paired significant difference, and the coupled tier shows the router keeping teams away (Q16). ADR-003's revisit
  rule applies unchanged: if peer collaboration does not beat a single agent at equal budget, narrow it (`ADR-003:264`).

## 12. Security

| Threat | Protection | Residual |
|---|---|---|
| A worker writes outside its package | D109 roots = its worktree only; sibling paths on its deny list (D115 §6.4 pattern); ACP `fs/*` and terminals contained (#820, D123); `tools.team.diffcheck` before review and before an A2A series is applied | a process outside the sandbox (the same-OS-user boundary that D123 §1 keeps) |
| An A2A writer delivers a malicious or broken series | untrusted until review and gates pass; base, path (`owns`), size, gitlink and symlink checks; hooks off; merge or `git am`, never a rebase; D98 in the verifier sandbox; review; merges only into the section branch, never into the target branch without the person or an `auto` section (§6.10) | a subtle change that passes review, gates and the section summary; the section branch stays revertible |
| Repository content disclosed to a peer | the person confirms every A2A member and what it receives (remote access of its own, or a base bundle) with the team; trust pinned through #843 or D114 pairing; no credential crosses the link (D114 §1) | the peer's own handling of the code it can read |
| An agent message taken as a person's approval | D109: only a person approves; every worker's approval request goes to the person's surfaces (team view, T2/T3 channels), batched per run within D109's prompt cap; agent text, channel messages included, never resolves a request (the rule R9 states for its teammates) | approval fatigue with many workers; mitigated by per-run task grants (Q18) and approval scopes (§6.14) |
| Permission laundering between agents | a denial is recorded on the run; the same action hash requested by another agent of the run within the run is answered as repeat-denied (D109's repeat-denied context); `approvalsHeld` only for delegable approvals within the hand-off scope (D109 row); channel messages carry no authority (§6.16) | a semantically equivalent action with a different hash; the reviewer and the person see the diff |
| Injection or noise through the team channel | messages are untrusted data, redacted, bounded in size and rate, braked on repetition, moderated by the lead; they cannot assign, approve, merge or decide (§6.16) | a persuasive message that leads a writer astray inside its own scope; review catches its result |
| Secrets in briefs or messages | contracts, plans, findings and messages pass the core redactor before persistence and dispatch (`service.ts:275`); external workers get the scrubbed environment (#820); `plur1bus-tools` never sees secrets (D120 §5); the forge credential stays in the core | a secret the redactor does not know |
| Prompt injection through code, findings or peer output | all peer and repository content enters as untrusted `tool_result` (`ADR-003:161`); findings cannot widen scope; the target-branch merge needs a person unless `auto` | an injected change that passes review and the person |
| Autonomous merges hide problems | only inside the scope the person approved; the D98 gate on every exact tree; the section branch is revertible; the target branch is untouched until the person (or an `auto` section) merges after the summary | a problem gates and summary miss; revertible |
| State-machine bypass | actions come only from `tools.team.next`; the core executes them through the dispatcher, D109 and the call budget as before; the transition function cannot act by itself | a bug in the core's executor |
| Budget runaway | finite section budgets; per-package allocation; admission before every call, messages included; pause, not overspend | estimate errors within one call |
| Merge of an unreviewed or changed tree | every merge, autonomous ones included, binds tree hash and target head; the D98 gate runs on the exact tree | — |
| History damage | merges only, sync and patch application included; no rebase, reset, force or delete by the core (#820 refusal set; D115 §6.6) | — |
| Push without consent | push needs a D109 grant scoped to the run's `p1b/` branches (Q18) | — |
| Router learns from or leaks content | features are numbers and enums; the store holds no text; local only | — |

## 13. Migration from today's guardrails

1. **One source.** PT-1 moves every limit into a resolved `CollabLimits` (config keys under `collaboration.limits.*`,
   `x-restart: live`, `x-tier: advanced`, project overrides that may only narrow, as D115 S3 rules); the tool layer, the
   service, the composed runner and the turn loop read from it. The copies listed in §1.2 disappear.
2. **Stored project settings.** `createProject` persists the full merged settings (`collab/store.ts:87-91`), so every
   existing project carries today's defaults. One migration drops stored values equal to the old defaults so the new
   defaults apply (Q20); explicit non-default values stay. Fan-out was off by default (`config.schema.json:123`), so no
   default installation depends on the old values.
3. **Switches.** `collaboration.fanoutEnabled` keeps its meaning for model-initiated fan-out;
   `collaboration.teams.enabled` (default `false`) gates team mode; per-project and per-request use is possible once
   built (Q16); `collaboration.teams.approval.auto` (default `false`) enables `auto` scopes per project (Q7).
4. **Return contract.** `returnContract.maxTokens` stays at most 2,000; `budget.tokens` becomes the work allocation and
   loses the 2,000 coupling.
5. **ADR-003.** The note "Amended by D124, decided 2026-11-01" records the decided defaults; PT-1 updates the guardrail
   table itself together with the code that enforces them.
6. **Docs.** `docs/collaboration.md` (guardrails, team mode), `docs/budgets.md` (new scopes), `docs/errors.md` (new
   reasons), `docs/inbox.md` (the `team` kind), the register row and a milestones row (PT-0).

## 14. Risks

| Risk | Mitigation |
|---|---|
| Token cost grows several-fold (R3: about 15×; R4: 1.8–5.1×) for little gain | finite section budgets; router masks; `single+review` as the common default; evaluation at both budgets |
| Teams used on sequential work (R1: −39 to −70 %) | hard masks; the coupled tier in the evaluation |
| Error amplification | centralised decisions (R1: 4.4× against 17.2×); the team channel carries no authority, is moderated and has a repetition brake (§6.16) |
| Channel noise and ping-pong (R5: unstructured swarms "mostly a distraction"; R11: step repetition) | size and rate limits, repetition brake, lead moderation, budget admission; PT-2 reports message counts and brake hits |
| Fragmented implicit decisions (R5) | one writer per branch; ownership and interface contracts; lead approval for interface changes |
| The person becomes the bottleneck (R12; the Q19 example) | approval scopes; autonomous merges into section branches; sync at safe points; a person queue of 3 |
| Review loops that never end (R11) | round cap, repetition detector, `needs-decision` |
| Untrusted A2A series | §12; review and gates before anything reaches the section branch |
| Disk exhaustion from many worktrees and build artefacts | hard floor; immediate removal of finished worktrees; cleanup of git-ignored build directories |
| Overcommitted CPU or memory | computed capacity; a clear warning when it is exceeded; PT-2 measures the slowdown (U16) |
| Benchmarks that do not reflect team work (R13) | the team tier; tokens and failure modes always reported |
| A weak lead (R4) | the lead uses the strongest configured tier; the router masks `team` without one |
| The bandit learns noise from sparse, delayed rewards | shadow start, exploration cap, hard masks, decay, reset |
| Merge conflicts and stale branches | ownership disjointness checked at plan time; merge preview; sync at safe points; fix rounds |
| Scope and maintenance (a large feature) | packages land behind `teams.enabled`; each PR independently useful (plan) |

## 15. Calls made by the author (not owner decisions)

- The arms, the heuristic rules and their order (§8.3); linear Thompson sampling over LinUCB, because it yields
  propensities for off-policy evaluation.
- Asynchronous delegation with structured concurrency instead of parallel dispatch in the turn loop (TD12).
- The table and column names in §6.4, the schema names `plur1bus.teamplan/1` and `plur1bus.teamstate/1`, the method and
  tool names in §6.6, the section branch name `p1b/<key>/t-<run>/s<N>` (§6.7).
- Merge-based conflict resolution and sync merges, deliberately different from D115 §6.6 step 3's rebase (§6.9); merge
  preview before the person is asked; the shared-files rule (§6.9).
- All `team.*` RPC methods human-only, agents limited to the agent tools (§6.6).
- The event log and action outbox around `tools.team.next`, and failing closed while `plur1bus-tools` is down (§6.3, §6.12).
- The defaults marked as judgment: `coresPerWriter` 2, `memoryPerWriter` 4 GiB, the disk floor of 20 GiB (minimum 1
  GiB), the cleanup paths and the pressure threshold (§6.7, §7.3); 2,000 tokens and 20 messages per member per hour, the
  brake after 6 exchanges (§6.16); 16 MiB per A2A artifact (§6.10); 8 sections per plan (§6.4).
- A2A series as a git bundle (preferred) or an mbox (§6.10).
- The `needs-decision` triggers beyond the owner's (a finding repeated in three rounds, a dispute repeated twice, a
  twice-unresolved sync conflict, a twice-rejected A2A series, §6.8, §6.11, §6.15).
- Orphaned worktree directories are reported, never deleted (§6.7); the resume brief instead of transcript replay
  (§6.12); a tied best-of-N pair goes to the smaller diff (§9).

## 16. Owner decisions

Every question was decided by the owner on 2026-11-01: as recommended, except where the row says **owner amendment** or
**owner change**; the owner also added sync at safe points (A1). The options are kept for the record.

| # | Question | Options | Decision (2026-11-01) |
|---|---|---|---|
| Q1 | Register entry | **D124**; fold into D120 | **D124**, as recommended |
| Q2 | Read-only helpers | (a) 8 per turn, ceiling 32, depth 2; (b) 6 per turn, ceiling 16, depth 1; (c) keep 3 | **(a)**, as recommended |
| Q3 | Concurrent writers per project | 2; 4; capacity only | **4, configurable. Owner amendment:** the capacity bound is configurable too and derived from the hardware (cores and memory: more cores, more writers); exceeding the computed capacity is allowed with a clear warning in UI and log and no fixed upper cap (CPU and memory are soft); free disk is a hard floor, configurable but not disable-able, with worktree cleanup (§6.7, §7.3) |
| Q4 | Turn and time limits per task class | the §7.2 table; keep 25 turns and 5 min; per project only | **The table** as a start, replaced by PT-2's data; as recommended |
| Q5 | Unit of a work package | a card with a card worktree (#820); a D115 subproject per package | **Card**, as recommended |
| Q6 | Merge sink | local (D115 §6.6 merge commit); forge (pull requests, forge CI, the person merges on the forge); both | **Both, local first** (PT-6), forge next (PT-7); as recommended |
| Q7 | Plan and budget approval | once per run; automatic; per package | **Owner amendment:** the lead proposes the team (role and model per member) and the person confirms or edits it; the plan has goals, sections, packages per section with dependencies and file ownership, and a budget per section; the approval scope is selectable: per package, up to the end of section N, the whole plan, or `auto` per project; inside the scope the orchestrator works autonomously and merges finished packages into a revertible section branch; at section end a summary and merge proposal; the merge into the target branch is the person's unless the section is `auto`; a forge push needs the per-run grant (Q18); packages merged autonomously inside an approved section do not count against Q19 (§6.14) |
| Q8 | Review in team mode | every package; only at 200 changed lines (D98) | **Every package**, as recommended; the 200-line rule stays for single-agent `coding_complete` |
| Q9 | Fix rounds | 3; 5; unbounded | **5, with early adjudication on repeated findings (now a `needs-decision`). Owner amendment:** an open finding or a disagreement (A2A peers included) puts the package into `needs-decision`: project, thread and card pulse yellow, a notification goes out, the lead presents 2–3 options with pros, cons and a recommendation; independent packages continue, dependants wait; the person decides through a human-only RPC in `FORBIDDEN_EXACT` (§6.8) |
| Q10 | Reviewer model | same family as the writer; prefer a different provider family | **Prefer a different family** when one is configured; as recommended |
| Q11 | Worker kinds in v1 | native only; native and ACP; also A2A writers | **Owner change** (recommended: native and ACP writers, A2A peers as helpers and reviewers): native agents, ACP CLIs **and A2A peers write**; an A2A writer works in its own checkout (paired per D114 or trust-pinned per #843, with read access to the repository) and returns a commit series as an A2A artifact, which the harness applies (merge or `git am`, no rebase) and treats as untrusted until review and gates pass. **Added:** a team channel per run with direct messages for all members, bounded by budget and a repetition brake, moderated by the lead (§6.10, §6.16) |
| Q12 | Best-of-N | N 3 (max 8), distill-refine off; N 5; judge only | **N 3, max 8, distill-refine off**, as recommended |
| Q13 | Router start | bandit from day one; shadow first, then capped exploration; heuristic only | **Shadow for the first 30 eligible decisions**, then at most 10 % exploration until each arm has 30 outcomes; as recommended |
| Q14 | Reward weights | λ_t 0.3, λ_w 0.2; outcome only; token-heavy | **0.3 and 0.2**, adjustable by the person; as recommended |
| Q15 | External benchmarks | keep D120 Q21 (self-authored only); allow local-only, un-vendored runs of SWE-bench Verified and Terminal-Bench subsets | **Allow local-only runs**, never vendored, never in CI, aggregate counts only; amends D120 Q21 for evaluation only; as recommended |
| Q16 | Team mode availability | off until the evaluation; explicit use once built, router-initiated after the evaluation; on by default | **Explicit use once built, router-initiated per task class after the evaluation** (§11); as recommended |
| Q17 | Selective verification gate | now; after the evaluation baseline and best-of-N; drop | **After** (PT-13); as recommended |
| Q18 | Push authority for the forge sink | an approval per push; one task-scoped grant per run limited to the run's `p1b/` branches; a standing grant | **Task-scoped grant per run**; as recommended |
| Q19 | Items waiting for a person | 3; 5; no limit | **3**, as recommended; the owner added the controller-run example (§6.9) |
| Q20 | Stored settings of existing projects | drop values equal to the old defaults; keep them | **Drop** (§13 step 2); as recommended |
| Q21 | Language of the team scheduler and merge queue | (a) TypeScript under ADR-019 (3); (b) Rust in `plur1bus-tools` under ADR-019 (1); (c) added by the owner | **Owner change** (recommended: (a)): **(c) "Rust decides, TypeScript executes"**: the state logic is a pure transition function `tools.team.next` in `plur1bus-tools`; TypeScript keeps storage, turns, D109 approvals, budget and git and executes the actions; the Rust part survives Phase 4 unchanged; about 2–3 agent days more than (a), a judgment (§6.3) |
| A1 | (owner addition, no question) Sync at safe points | — | After each merge into the section branch, affected running packages get a short notice and, at the next safe point, a merge of the section branch; unresolvable conflicts become `needs-decision`; per package `auto` (default), `notify-only` or `at-review` (§6.15) |

No owner question is open. The remaining gates are measurement, code and dependency gates: PT-4b's PR carries the first
`team` numbers against the PT-2 baseline; PT-12 runs in shadow mode for the first 30 eligible decisions, then explores
at most 10 % until each arm has 30 outcomes (Q13); router-initiated teams are switched on per task class only when PT-2
shows the gain §11 names (Q16); PT-13 starts after the baseline and PT-10 (Q17); PT-14 (local-only external benchmarks,
Q15) after PT-2 and PT-10. The plan's "Gates" list the same.

## 17. Unknowns

| # | Unknown | How it gets resolved |
|---|---|---|
| U1 | Which ACP CLIs support `session/load` for resuming a worker (our own ACP server says `loadSession: false`, `docs/acp.md:16`; #820's client side is not checked) | PT-8a probes each M6 CLI; the resume brief is the fallback |
| U2 | A2A task re-reading after a long restart for remote members | PT-8b |
| U3 | Real concurrency of local model servers behind D51 endpoints | PT-2 measures throughput at 1, 2 and 4 concurrent requests per endpoint; PT-4b's semaphore defaults to 1 until then |
| U4 | Whether D115 WP4 builds the provisioner's merge operations before PT-6 | PT-6 builds them to the D115 §6.5 interface; WP4 reuses them |
| U5 | The GitHub credential profile needed by D115 WP4b and PT-7 | checked when PT-7 starts |
| U6 | Token and wall-time cost of team and best-of-N on our stack (R6 reports none; R4 reports 1.8–5.1×) | PT-2, PT-10 |
| U7 | Whether a prompted verifier gives R7-like gains without training | PT-13 |
| U8 | MAST's step-repetition share differs between versions (v3 15.7 %, v2 17.14 %) | not used as a threshold; only the ranking (largest single mode) is used |
| U9 | Hidden shared state when one agent identity runs several sessions at once | PT-4b isolation test |
| U10 | When D120 B1's runner lands | PT-2 builds it to D120's plan if B1 has not started |
| U11 | Precision of glob ownership for generated files and lockfiles | PT-3b and the team tier |
| U12 | Prompt-cache hit rate when many workers start fresh contexts | PT-2 reports the cache-read share per arm |
| U13 | A D120 H3 steer that arrives while a turn waits in `await_delegations` | PT-1 test, coordinated with H3-1 |
| U14 | Which A2A peers can return a commit series as a `file` artifact (bundle or mbox); #843's client reads only text parts today (`a2a/peer-client.ts:23,119`) | PT-8b extends the client and tests against a fake peer |
| U15 | Whether ACP CLIs use harness tools offered through `session/new`'s `mcpServers` (#820 passes the list, `acp-client.ts:74-75`) to post in the team channel | PT-5b probes each M6 CLI; read-only membership otherwise |
| U16 | Memory per writer (the 4 GiB estimate) and how far CPU and memory can be overcommitted before writers slow down | PT-2 measures peak memory per writer and wall time at 1×, 1.5× and 2× the computed capacity |
| U17 | How an A2A writer receives a synced section branch without a forge (bundle size, peer support) | PT-8b |
| U18 | A2A messages on a running task, for channel delivery to A2A members | PT-8b, against #843's client |
| U19 | Quality of interface-change summaries for sync before D120 C3 exists (file list plus return summary only) | PT-6b measures how often an affected writer asks for the full diff |
| U20 | Whether the 20 GiB disk floor and the build-directory cleanup fit typical repositories | PT-4b measures disk per worktree on the team tier |
