# Parallel agent teams — design (D124)

**Status:** Proposed (specification and plan only, no product code). The owner intents of 2026-11-01 are binding (§2);
owner questions Q1–Q20 are open (§16) · **Date:** 2026-11-01 · **Owner:** Christian (Cyb3rb1ade) · **Track:** M5
collaboration follow-up, beside M5+ (D115) and M6 · **Register entry:** proposed **D124** (Q1) in the core spec's
register ([`2026-09-24-m1b-2a-core-daemon-cli-design.md`](2026-09-24-m1b-2a-core-daemon-cli-design.md) §2), not entered
yet. D120 is on main; D121 is used by open PR #840, D122 by open PR #845, D123 by open PR #847; `D124` appears in no file
of main (`27ec7c4f0c`) and in no doc changed by the 40 most recently updated remote refs, checked 2026-11-01 ·
**Amends (proposed):** the ADR-003 guardrail table (a "Proposed amendment (D124, pending owner decision)" note in
[ADR-003](../../adr/ADR-003-agent-model-and-collaboration.md)); answers ADR-003 open question 5 and action items 8 and 9 ·
**Follows:** D120 path B ([`2026-10-30-harness-hygiene-coding-aci-design.md`](2026-10-30-harness-hygiene-coding-aci-design.md)
§2 decision 3, the ADR-019 text in §13), D115 ([`2026-10-19-subprojects-design.md`](2026-10-19-subprojects-design.md)),
D123 (PR #847) · **Plan:** [`2026-11-01-parallel-agent-teams.md`](../plans/2026-11-01-parallel-agent-teams.md)

**Inputs read:** main at `27ec7c4f0c`: [ADR-003](../../adr/ADR-003-agent-model-and-collaboration.md) (complete),
[ADR-010](../../adr/ADR-010-latency-and-caching.md) (status, context, the L8 row),
[ADR-011](../../adr/ADR-011-external-coding-agents.md) (decision, first-class agent, permission model, M6 set, the
2026-10-07 amendment), [ADR-008](../../adr/ADR-008-protocols-mcp-acp-a2a.md) (decision);
`packages/core/src/collab/{defaults,guardrails,service,runner,types,target,coding-gate,coding-surface,verifier,fanout-eval}.ts`,
the heads of `collab/{board,handoff,store}.ts`, `collab/schemas/handoff.schema.json`, `packages/core/src/tools/collaboration.ts`,
`packages/core/src/composition/collaboration.ts`, `composition/provider.ts` (the tool loop and budget admission),
`composition/index.ts` (collaboration wiring), `packages/core/src/budget/{README.md,subagent.ts,calls.ts}`,
[`docs/budgets.md`](../../budgets.md), [`docs/collaboration.md`](../../collaboration.md),
[`docs/milestones.md`](../../milestones.md) (M5, M5+), [`docs/architecture/turn-pipeline.md`](../../architecture/turn-pipeline.md)
(port inventory), `packages/config-schema/schema/config.schema.json` (`collaboration`, `supervisor.maxCores`),
`packages/webmcp/src/provider.ts`, `packages/core/test/protocols/exposure-matrix.test.ts`,
`crates/plur1bus-engine/src/store/ledger_types.rs` (reply outcomes), the heads of
`packages/web/src/pages/projects/{board-view,delegation-trace}.ts`, the D109 register row, the D115 spec (§1–§3, §6.5–§6.7),
D120 (§2, §4, §5, §6.6, §12, §13, §16–§18 and its plan), D119 (§5, §8.4), D118 (header), the D114 federation spec (§2,
§7), [`docs/acp.md`](../../acp.md). Open PRs: #820 at `42ced5f736` (`external-agents/provisioner.ts`, the
`ProjectWorktreeProvisioner` interface in `collab/coding-surface.ts`, the `project_worktrees` migration), #847 at
`0d542df7da` (D123 spec and plan), #845 at `5773ca3857` (D122 spec and plan). External sources in §3, re-checked
2026-11-01 where marked.

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
| Where the limits live | **Spread over five files, not one place** (with the next row). `evaluateGuardrails` reads project settings (`collab/guardrails.ts:20-30`); the agent tools hard-code 3 starts and 2 per pair (`tools/collaboration.ts:49-50`), refuse any nested call through `currentAgentScope()` regardless of `maxDepth` (`:45`), give every contract `budget: { tokens: 2000, toolCalls: 25, deadline: +300 s }` (`:59`) and a 300 s tool timeout (`:41`); `runTarget` caps a contract deadline at 300,000 ms (`collab/service.ts:267`); the turn loop stops at 25 rounds (`composition/provider.ts:738`) | as listed |
| Work budget vs return cap | The delegated turn runs with `maxOutputTokens` = the contract's `budget.tokens` (`composition/collaboration.ts:51`), i.e. 2,000; the return is capped at 2,000 again (`:79`, `budget/subagent.ts:7-8`, schema `returnContract.maxTokens` maximum 2,000 at `handoff.schema.json:458`). The work budget and the summary cap are the same number | as listed |
| Time | One chain-wide timer from the chain's start (`collab/service.ts:190-195`): every child of a chain dies 5 min after the first hop. `maxTurns` is stored but not counted (`docs/collaboration.md:88`) | as listed |
| Fan-out switch | `collaboration.fanoutEnabled`, default `false` until "owner review of the equal-token-budget evaluation" (`config.schema.json:123`; wiring `composition/index.ts:312`) | as listed |
| Evaluation | 24 synthetic arithmetic fixtures, "not a live-model quality claim" (`collab/fanout-eval.ts:1,13`); result 24/24 both modes, 576 vs 1,728 tokens (`docs/collaboration.md:300-306`, `docs/milestones.md:377`) | as listed |
| Project roles and board | `ProjectRole` is `member \| lead` (`collab/types.ts:3`), not ADR-003's lead/worker/reviewer (`ADR-003:143`). A card has no dependencies, ownership or merge position (`collab/board.ts:8-13`); the board is one JSON document per project (`board.ts:57,67`) with column WIP limits (`board.ts:6`) | as listed |
| Worktrees | Main: `ProjectWorktreePort.root()` only, "no second worktree creator exists" (`collab/coding-surface.ts:15`). PR #820 adds the one provisioner: `fork`, `remove`, `status` (`coding-surface.ts:22-26` at `42ced5f736`), card worktrees on branches `p1b/<key>/c-<suffix>` forked from the project root worktree, a live-row index per (project, card) (`collab/migrations.ts:127-139`), and a refusal set `--force`, `reset`, `rebase`, `push` (`external-agents/provisioner.ts:11`); "M5+ adds merge and revert here" (`:1`). No prune and no orphan detection | PR #820 |
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
concurrently" (`ADR-010:103`) is not implemented for any tool. A latent race follows for the day calls do run
concurrently: the tool checks `starts >= 3` (`tools/collaboration.ts:50`), then awaits `prepareHandoff` (`:68`), and
increments only afterwards (`:80`), so concurrent calls could all pass the check. The library's own check and increment
have no `await` between them (`service.ts:403-409`) and are safe.

### 1.4 Problem

The constants are too small for real work (a coding package needs hours and hundreds of rounds, not 5 minutes and 2,000
output tokens), they are scattered so raising one changes nothing, and nothing in the harness turns a multi-package job
into parallel writers with review, ordered merges, gates and a human merge. Raising the constants alone would be the
wrong fix: the evidence (§3) says parallel agents pay off only for some tasks and fail expensively on others, so the
design needs limits governed by budget and capacity, a coding team mode with single-threaded writes, a selector between
single agent, team and best-of-N, and an evaluation that measures what each costs.

## 2. Owner intents of 2026-11-01 (binding)

| # | Intent | Where this spec carries it |
|---|---|---|
| I1 | The fan-out limits of ADR-003 and `collab/defaults.ts` (depth 1, fan-out 3, 2 per pair, 25 turns, 5 min, 2,000-token return) are "definitely too small". | §7; the exact new defaults are Q2–Q4 |
| I2 | The harness must do what the controller does with external agents: parallel coding agents, each in its own worktree and branch on its own work package, independent review between rounds, fix rounds, a fixed merge order, CI gates, the person merges. "Das sollte er definitiv können … definitiv muss das rein." | §6 (coding team mode) |
| I3 | Learned routing between single agent, team and best-of-N as a contextual bandit over outcomes, tokens and wall time is accepted as the first "real learning" step. No reinforcement learning that changes model weights. | §8 |
| I4 | The topic moves fast; the design rests on current evidence, not on 2025 assumptions. | §3; every default without evidence is marked a judgment call |

Decided by these intents and not reopened here: that limits rise (not by how much), that team mode is built (not when it
is on by default), and that the router learns (not its start mode, Q13).

## 3. Research basis

### 3.1 Sources

"Re-checked" means the cited page was read again on 2026-11-01; the other entries are taken from the owner's research
brief of the same day and were not re-fetched. Every figure below appears in its source; this spec adds no number of its
own to them.

| # | Source | Finding as used here | Consequence |
|---|---|---|---|
| R1 | Google Research and MIT, "Towards a science of scaling agent systems", Dec 2025, arXiv 2512.08296 ([blog](https://research.google/blog/towards-a-science-of-scaling-agent-systems-when-and-why-agent-systems-work/)); re-checked | 180 configurations. Centralised coordination +80.9 % on the parallelisable Finance-Agent; every multi-agent variant −39 to −70 % on the sequential PlanCraft. Independent multi-agent systems amplify errors 17.2×, centralised ones 4.4×. A tool-coordination trade-off: the coordination "tax" rises disproportionately with tool count (the blog's example: "16+ tools"). A model from task properties (tool count, decomposability) reaches R² 0.513 and picks the best architecture for 87 % of unseen configurations | Centralised topology only (TD2); sequential and tool-heavy tasks go to a single agent (§8.3); task properties are the router's features |
| R2 | Tran and Kiela, arXiv [2604.02460](https://arxiv.org/abs/2604.02460), Apr 2026; re-checked | At equal thinking-token budgets single agents match or beat multi-agent systems on multi-hop reasoning; many reported multi-agent gains reflect extra compute and context effects | The evaluation compares at matched budgets as well as at natural ones (§11); no team for pure reasoning |
| R3 | Anthropic, multi-agent research system, 2025, as cited in `ADR-003:12` | Token spend explains about 80 % of performance variance; multi-agent work costs about 15× chat tokens | The token budget is the main governor (§7.3) |
| R4 | Vals Vibe Code Bench, as reported by [yage.ai](https://yage.ai/share/multi-agent-what-it-buys-en-20261021.html), 2026-10-21; re-checked | Team runs cost 1.8–5.1× solo. One team configuration was significant (+7.3 points) while raising reasoning effort gave +11.4. Teams +15 points on hard broad apps, about +1 on easy ones. Serial waves made teams up to 2.3× slower. Cohere (same article): a weak lead with cheap workers did worse than a strong solo model; delegating only exploration and planning nearly matched full delegation at about half the cost | A strong lead is required (§6.2); "single at higher effort" and "explore + single" are evaluation arms (§11) and router arms (§8); packages are scheduled by dependency, not in waves (§6.5) |
| R5 | Cognition, ["Multi-Agents: What's Actually Working"](https://cognition.com/blog/multi-agents-working), 2026-04-22 (re-checked); earlier ["Don't build multi-agents"](https://cognition.ai/blog/dont-build-multi-agents) | Writes stay single-threaded; extra agents contribute intelligence, not actions. The generator–verifier review loop works (Devin Review about 2 bugs per PR, about 58 % severe). Manager and child agents run in production. The reviewer works best with a clean context. Unstructured swarms are mostly noise. Parallel writers fragment implicit decisions | One writer per branch (TD3); ownership and interface contracts in the plan (§6.4); fresh-context review of every package (§6.8); map, reduce and manage, never a swarm |
| R6 | Kim et al., "Scaling Test-Time Compute for Agentic Coding", arXiv 2604.16529, Apr 2026 ([summary](https://www.emergentmind.com/papers/2604.16529)); re-checked | Parallel rollouts are summarised; Recursive Tournament Voting (pairwise groups, about 8 votes) plus Parallel-Distill-Refine. Claude-4.5-Opus: SWE-bench Verified 70.9 → 77.6 %, Terminal-Bench v2.0 46.9 → 59.1 %. Costs are not characterised; the LM judge stays below an oracle selector | Best-of-N with bounded summaries, tests first and the judge only as tie-break, distill-refine optional (§9); we measure the cost ourselves (§11) |
| R7 | Zou et al., "SWE-Verifier", arXiv [2610.30284](https://arxiv.org/html/2610.30284), Oct 2026; re-checked | A small gate-and-selector verifier at decision points: +1.7 points at 1.09× cost, against 3.5–4.2× for trajectory-level verification; verifying every step is not worth it | A later gate at decision points only, never per step (§10) |
| R8 | Cursor 2.0/2.2, Dec 2025 ([forum](https://forum.cursor.com/t/cursor-2-2-multi-agent-judging/145826)) | Parallel agents in worktrees; a judge picks the winner | Product precedent for best-of-N in worktrees (§9) |
| R9 | Claude Code agent teams, experimental ([docs](https://code.claude.com/docs/en/agent-teams)); re-checked | A lead plus teammates with their own contexts; a shared task list with dependencies and file-locked claiming; a mailbox; hooks as quality gates (`TeammateIdle`, `TaskCreated`, `TaskCompleted`); no hard limit, 3–5 teammates recommended, 5–6 tasks per teammate; no nested teams; avoid same-file edits; permission prompts bubble to the lead; a teammate cannot approve or consent on the user's behalf and cannot relay a denied action to another teammate; in-process teammates are not restored on resume | Atomic claiming, dependencies and gate hooks (§6.5); the approval rule (§12); no nested team inside one project (§6.1); resumability is an explicit requirement here because the reference product lacks it (§6.12) |
| R10 | OpenAI Codex subagents, 2026 ([announcement](https://x.com/OpenAIDevs/status/2033636701848174967)) | A second vendor ships subagents | Precedent only |
| R11 | MAST, "Why Do Multi-Agent LLM Systems Fail?", NeurIPS 2025, [arXiv 2503.13657v2](https://arxiv.org/abs/2503.13657v2); abstract re-checked | A failure taxonomy of 14 modes in three categories: specification, inter-agent misalignment, task verification. Step repetition is the largest single cause (about 15.7 %; this share is from the brief, the abstract page does not show it) | Typed plans and contracts (specification), ownership and interfaces (misalignment), external verifiers and review (verification); a repetition detector (§6.8); MAST tags in the evaluation (§11) |
| R12 | Simon Willison, ["Embracing the parallel coding agent lifestyle"](https://simonw.substack.com/p/embracing-the-parallel-coding-agent), Oct 2025 | Human review is the bottleneck; parallel agents suit research, explanations, small maintenance and carefully specified work | Back-pressure on packages waiting for a person (§7.3); plans are specified before writers start (§6.5) |
| R13 | Christopher Meiklejohn, [MAS series part 7](https://christophermeiklejohn.com/ai/agents/mas-series/2026/04/30/mas-series-07-benchmarks.html), 2026-04-30 | Most multi-agent claims use single-agent benchmarks and omit token cost and failure rates | A team tier of decomposable tasks; tokens, wall time and failure modes in every report (§11) |

### 3.2 What follows for the design

- **Teams help** when the work is parallelisable and decomposable, hard and broad, verifiable, and led by a strong model
  (R1, R4). **They hurt** on sequential or tightly coupled work, on tool-heavy tasks with little decomposition, on easy
  tasks, with a weak lead, and whenever several agents write the same code (R1, R4, R5).
- Much of the cheap gain sits in **verification** (a fresh reviewer, R5; dedicated verification roles on hard apps, R4)
  and in **delegating exploration** (R4), not in parallel writing. The design therefore treats `single + review` and
  `explore + single` as first-class options, not as degenerate teams.
- **Compute explains most differences** (R2, R3). Every comparison must state its token budget, and every team run must
  have one.
- **Centralised beats independent** on error amplification (R1: 4.4× against 17.2×). Siblings never talk to each other
  directly; everything goes through the lead and the core scheduler, as D115 already decided for subprojects (D115 S8).

### 3.3 What the evidence does not settle

No source evaluates a bandit that chooses between architectures; R1's predictive model supports the premise that task
features predict the best architecture, and I3 makes the bandit an owner decision. No source gives limits such as "8 read
helpers" or "4 writers"; those are judgment calls bounded by the governors in §7, to be replaced by the evaluation's
data. R6 reports no cost and R7 uses a trained verifier we do not have; both are measured here before they become
defaults.

## 4. Goals and non-goals

**Goals.** After this design is built:

1. Limits follow budget and capacity, not constants: read-only helpers and writers are separate classes; per-delegation
   turn and time limits follow a task class; the 2,000-token return stays as the summary cap, separate from the work
   budget (§7).
2. Several delegations started in one step run concurrently, provably (§7.5).
3. A **coding team mode** reproduces the controller workflow inside the harness: a lead plans work packages with
   dependencies and file ownership on the project board; one writer per worktree and branch; a fresh-context reviewer per
   package with a capped fix loop and adjudication; a merge queue with a fixed order, stacks retargeted by merge, a CI gate
   and a merge only a person confirms; native, external ACP and (as helpers) A2A workers; observable, steerable and
   resumable after a restart (§6).
4. **Best-of-N** for hard single tasks (§9) and, later, a **selective verification gate** (§10).
5. A **router** picks single, single + review, explore + single, team or best-of-N: heuristics first, then a local
   contextual bandit over outcomes, tokens and wall time, every decision explainable (§8).
6. An **evaluation** on coding tasks, including a decomposable team tier, replaces `fanout-eval.ts` and decides the
   defaults (§11).

**Non-goals.**

- No reinforcement learning that changes model weights (I3), no telemetry, no learning across installations.
- No peer-to-peer messaging between workers and no unstructured swarm (TD2).
- No nested team inside one project; a package that needs its own team becomes a D115 subproject (§6.1, Q5).
- No general parallel dispatch of all read-only tool calls in the turn loop (ADR-010 L8); concurrency for delegations
  comes from asynchronous delegation (§7.5). L8 stays its own item because it interacts with D120 H3 steering.
- No change to D109: only a person approves or grants; no new RPC error codes; no history rewrite, force or rebase by the
  core.
- No untrusted code on D119 compute nodes (D123 §11 keeps that boundary); workers run where the project worktree lives.
- No money dimension: cost means tokens and wall time (ADR-010, amended 2026-10-19).

## 5. Decisions at a glance

| # | Topic | Decision | Main alternative, why not |
|---|---|---|---|
| TD1 | Limits | Classes (read helper, writer, reviewer, judge) with per-class defaults and ceilings; real governors are the team token budget, machine capacity, local-model concurrency and person-review capacity (§7) | Raise the constants: still five copies, still one number for different risks |
| TD2 | Topology | Centralised: a lead agent plus an event-driven core scheduler; workers report only to the lead; no worker-to-worker channel | Teammates messaging each other (R9): R1's error amplification, R5's swarm noise, and D115 S8 already chose coordinator forwarding |
| TD3 | Writes | One writer per worktree and branch; a work package is a board card with a card worktree (PR #820) and declared file ownership | Shared worktree with file locks: R5's fragmented decisions, R9's "avoid same-file edits" |
| TD4 | Review | Every package gets the D98 checks and a fresh-context reviewer that sees the diff and the contract, not the writer's transcript; at most 5 fix rounds, then adjudication by the lead (Q8, Q9) | Self-review or review only above 200 lines: R5's clean-context result, R4's verification gains |
| TD5 | Merge | A durable merge queue in the plan's fixed order; dependent packages stack on their dependency's branch and are retargeted by a merge, never a rebase; D98 gate and, with a forge, CI; only a person confirms each merge (§6.9) | Auto-merge (I2 says the person merges); rebase (D115 §6.6 forbids history rewrite by the core) |
| TD6 | Lead | Event-driven lead turns at decision points (plan, adjudication, interface changes, synthesis), not a polling loop | A lead that polls the board: tokens spent on waiting |
| TD7 | Durability | All team state in SQLite; a restart reconciles worktrees and resumes packages (§6.12) | In-memory chains (today, `service.ts:95`) and R9's missing resume |
| TD8 | Best-of-N | Tests first, a pairwise LM tournament only as tie-break, distill-refine optional, N capped by budget (§9) | Judge only: R6's judge stays below an oracle |
| TD9 | Router | Heuristic rules with overrides, then a local contextual bandit (linear Thompson sampling) with hard masks, shadow start and an exploration cap (§8) | A fixed default: I3; weight-changing RL: excluded by I3 |
| TD10 | Evaluation | B1 coding tasks plus a self-authored team tier, at matched and natural budgets, with MAST tags; nightly and advisory (§11) | Keep `fanout-eval.ts`: it measures routing, not quality |
| TD11 | Language | Orchestration extends TypeScript `collab/` (ADR-019 (3)); the new pure components, plan checks and the router, are Rust in `plur1bus-tools` (§6.3) | All Rust now: the scheduler drives TypeScript turns, D109 and the collab store until Phase 4 step 3 |
| TD12 | Concurrency | `delegate_task` and `consult_agent` gain `wait: false`, plus an `await_delegations` tool; structured concurrency per turn (§7.5) | Parallel dispatch in the turn loop: touches D120 H3 steering semantics and every tool |
| TD13 | Verification gate | Later phase, decision points only, behind the evaluation (§10) | Now: no trained verifier, no baseline |
| TD14 | Workers | Native and external ACP agents write; A2A peers serve as read helpers and reviewers in v1 (Q11) | A2A writers now: no worktree containment across instances |

## 6. Architecture

### 6.1 Modes

| Mode | Writers | Helpers | Typical use | Started by |
|---|---|---|---|---|
| `single` | 1 (the agent itself) | none | small or sequential tasks | default |
| `single+review` | 1 | 1 fresh reviewer per round | most code changes | router, request, project setting |
| `explore+single` | 1 | up to the read-helper limit, read-only, before and during the write | unfamiliar code, research-heavy tasks (R4's planning-only delegation) | router or the agent through `consult_agent` |
| `team` | k ≤ writer limit, one per package | reviewers, read helpers | decomposable multi-package work | router, `team.create`, a project card |
| `best-of-n` | N attempts, each its own worktree; one survives | judge, then one reviewer | hard single tasks with a test oracle | router or request |

A team never contains a team. If a package itself needs several writers, it becomes a D115 subproject with its own
team, so hierarchy depth (D115 S2, ceiling 2) and chain depth stay separate axes as D115 §3.2 defines.

### 6.2 Roles

| Role | Who | Rights | Notes |
|---|---|---|---|
| Lead | one agent per team run, the strongest configured model tier (R4: weak leads lose) | plans, decides adjudications and interface changes, synthesises; never writes package code; cannot approve or merge | its session lives as long as the run and is compacted as usual |
| Writer | native agent, external ACP agent | D109 roots = its package worktree only (the D115 §6.4 pattern); its own approval policy and budget (ADR-003 security invariants, `ADR-003:161`) | one per package, one package per writer at a time |
| Reviewer | native agent or A2A peer | read-only worktree view, `file.read/list/stat` (`tools/collaboration.ts:65`); no write or exec tools | fresh session per round; never the writer (`coding-gate.ts:54`) |
| Read helper | any agent kind | read-only tools; may consult one further read helper (depth 2) | counted per lead or writer turn |
| Judge | native agent | reads candidate summaries and diffs | best-of-N only |
| Person | project lead, owner or admin | approves plan and budget, confirms merges, overrides, steers | D109: the only approver |
| Scheduler | the core, not an agent | admission, worktrees, gates, merge queue, resume | deterministic, durable |

`ProjectRole` gains `worker` and `reviewer` beside `member` and `lead` (`collab/types.ts:3`), matching ADR-003's roles
(`ADR-003:143`); project roles stay orthogonal to RBAC roles.

### 6.3 Placement, language and executor

```text
 core (TypeScript)
  collab service ─► team scheduler (new module, extends collab/) ─► lead session (event-driven turns)
       │               │ admission: class limits · call budget (team/package scopes) · capacity · person back-pressure
       │               ├─► writers: native turn in its worktree │ ACP CLI (#820 client, D123 sandbox)
       │               ├─► reviewers and read helpers (local or A2A), fresh contexts
       │               ├─► D98 gate (verifier sandbox; D123 SB-8 moves it to Rust later)
       │               └─► merge queue ─► provisioner (#820; D115 §6.5: fork · mergePreview · merge · revert · prune)
       │                               └─► forge sink: push, pull request, required checks (credentials stay in the core)
       └─ x-server "tools" ─► plur1bus-tools (Rust): tools.team.check · tools.team.diffcheck · tools.router.*
```

- **TypeScript, with reasons (ADR-019 (3), "changes to existing TypeScript code that are not new components stay
  TypeScript until their subsystem's Phase 4 step").** The scheduler drives TypeScript turns, the D109 dispatcher, the
  call budget and the collab store; splitting it across RPC would add a hop to every state change and still leave the
  turns in TypeScript until Phase 4 step 3 (D120 §12.2). The merge queue extends #820's provisioner, which D115 §6.5 makes
  the single git implementation and D123 keeps in TypeScript as harness-owned git (D123 §1). The forge sink needs a
  credential, and secrets never enter `plur1bus-tools` (D120 §5).
- **Rust in `plur1bus-tools` (ADR-019 (1)).** The plan checker (DAG, ownership disjointness by glob intersection, merge
  order consistency, overlap prediction, diff-against-ownership) and the router (features in, decision out, outcome
  updates, its own store) are new, pure, secret-free components. They need D120 H1-1 (the skeleton); D123 Q11 proposes to
  pull H1-1 forward.
- **Executors.** Rust work goes to Claude agents, never Codex without an explicit owner exception; TypeScript work is the
  controller's choice, Sonnet or Opus by size (D120 plan, D122 plan).

### 6.4 Data model

New tables in the collab store (one migration in `collab/migrations.ts`, next version after #820's); every free-text
field passes the core redactor before it is written, as delegation contracts do today (`service.ts:275`).

| Table | Key columns | Purpose |
|---|---|---|
| `team_runs` | `id`, `project_id`, `lead_agent`, `mode` (`team` \| `best-of-n`), `state`, `plan_json`, `plan_hash`, `approved_by`, `token_budget`, `wall_budget_ms`, `writers_max`, `route_decision_id`, timestamps | one run; `state`: `planning → awaiting-approval → running ⇄ paused → merging → done \| cancelled \| failed` |
| `team_packages` | `id`, `run_id`, `card_id`, `key`, `task_class`, `state`, `writer_agent`, `worker_kind` (`native` \| `acp`), `base_ref`, `branch`, `merge_position`, `round`, `token_alloc`, `deadline_at`, `last_tree_hash` | one package, one card, one worktree (the #820 `project_worktrees` row by `card_id`) |
| `team_package_deps` | `package_id`, `depends_on`, `kind` (`code` \| `order`) | `code`: stack on the dependency's branch; `order`: merge after it |
| `team_ownership` | `package_id`, `glob`, `mode` (`own` \| `interface` \| `shared`) | what a package may change; `interface` files need lead approval to change, `shared` files (lockfiles) follow §6.9 |
| `team_rounds` | `package_id`, `round`, `kind` (`review` \| `fix` \| `retarget` \| `adjudication`), `agent`, `tree_hash`, `verdict`, `findings_json`, `finding_hashes`, tokens, times | the review history; findings are untrusted data |
| `team_merge_queue` | `run_id`, `package_id`, `position`, `sink` (`local` \| `forge`), `state`, `target_ref`, `approved_tree_hash`, `approval_id`, `pr_number`, `merge_sha`, `reason` | ordered merges; `state`: `waiting → ready → checking → awaiting-person → merging → merged`, side states `blocked`, `reverted` |

**The plan** is a closed JSON document `plur1bus.teamplan/1`: objective; packages with `key`, `title`, `objective`,
`doneWhen[]`, `taskClass`, `owns[]`, `interfaces { provides[], consumes[] }`, `dependsOn[]`, `worker { kind, agent? }`,
`estimate { changedLines, tokens }`; `mergeOrder[]`; `budget { tokens, wallTimeMs }`. Bounds: at most 32 packages and
the D104 2,000-token rule per package brief (`handoff.ts:13`), with longer material as artifact references. The card
remains the person's surface: title, description, assignees and links are written from the plan; the team columns live in
the tables above, not in the board's JSON document.

### 6.5 Package lifecycle

```text
planned ─► ready ─► writing ─► checking ─► reviewing ─┬─► queued ─► (retargeting) ─► awaiting-person ─► merged
   ▲          │        ▲            │          │       │
   │          │        └── fixing ◄─┴──────────┘       └─► adjudication ─► accepted │ reassigned │ split │ escalated
   └── blocked (dependency failed, interface change pending, worktree unsafe) · interrupted (restart) · cancelled · failed
```

- **ready** when every `code` dependency is `queued` or later (its branch exists and passed review) and admission (§7.4)
  grants a writer slot. Claiming is a single `BEGIN IMMEDIATE` transaction on `team_packages`, the equivalent of R9's
  file-locked claiming.
- **writing**: the scheduler forks the card worktree (PR #820 `fork`; a `code` dependency's branch as base instead of the
  root branch) and starts the writer with a D104 hand-off built from the package (objective, `doneWhen`, scope paths =
  `owns`, forbidden actions, interfaces, the task class's limits).
- **checking**: the D98 checks run on the worktree without completing the card; failures go back as a fix round with the
  failing names (D120 C4 adds the failing lines).
- **reviewing**, **fixing**, **adjudication**: §6.8.
- **queued** onward: §6.9.

Hooks at three points give projects their own gates, as R9's hooks do: `package.created` (refuse a package), `package.done`
(refuse completion), `writer.idle` (send the writer back with feedback). They are commands under a new optional `hooks`
key in the committed `.plur1bus-verifiers.json` (today closed to `commands` and `networkAllowed`, `coding-gate.ts:12`; a
manifest changed during the run is refused, `:70`), run in the verifier sandbox, exit code 2 meaning "refuse with
feedback"; no other code path runs project code on the host.

### 6.6 Protocol: tools, RPC, events

**Agent tools.** Existing tools keep their names (`tools/collaboration.ts:113-120`). Additions:

| Tool | Who | Effect |
|---|---|---|
| `consult_agent`, `delegate_task` with `wait: false` | any agent | return `{ taskId }` at once (§7.5) |
| `await_delegations { taskIds[], timeoutMs }` | the starting agent | returns the finished results (each a `plur1bus.return/1` envelope) and the ids still running |
| `team_propose_plan { plan }` | lead | validates through `tools.team.check`, stores the draft, asks the person for approval |
| `team_decide { packageId, decision, note }` | lead | adjudication (`accept`, `reassign`, `split`, `escalate`) and interface approvals |
| `team_status { runId }` | lead, writers (own package only) | read |

**RPC (core).** `team.create`, `team.get`, `team.list`, `team.route.explain` (read or project write); and the human-only
`team.plan.approve { runId, planHash, tokenBudget, wallBudgetMs }`, `team.pause`, `team.resume`, `team.cancel`,
`team.package.reassign`, `team.package.budget.set`, `team.merge.order.set`, `team.merge.confirm { runId, packageId,
treeHash, targetHead }` and `team.route.reset`. **Every human-only method goes into `FORBIDDEN_EXACT` in
`packages/webmcp/src/provider.ts` (`:52`)**, which `exposure-matrix.test.ts:74-84` enforces for `humanOnly` rules.
**RPC (tools).** `tools.team.check`, `tools.team.diffcheck`, `tools.router.decide`, `tools.router.outcome`,
`tools.router.explain`, `tools.router.reset`; core-only guard as for every `tools.*` method (D120 §5).
All methods: closed params, `x-stability: "experimental"`, `x-since` = the next free minor **at implementation time**
(1.11–1.14 are taken by open PRs #835, #843, #838 and #820), no new error codes, new reason strings in `docs/errors.md`.

**Events.** `COLLAB_EVENT_TYPES` (`collab/types.ts:118-124`) gains `team.*` and `package.*` events (planned, approved,
state changed, round finished, merge queued, merged, budget warning); the web board already listens to
`project.card.changed` for live updates (`packages/web/src/pages/projects/page.ts:184`).

### 6.7 Worktrees

- **Create:** #820 `fork({ projectId, cardId })`, extended with an optional base branch for stacks.
- **Prune:** after `merged`, `cancelled` or a best-of-N loss, the worktree is removed (#820 `remove`); the branch stays
  under D115's retention rule (D115 §6.6 step 6: kept, deleted only when fully merged or archived, never forced).
- **Orphan detection** (ADR-003 action item 9, `ADR-003:295`): at start and hourly, the scheduler compares `git worktree
  list --porcelain` of each bound repository with live `project_worktrees` rows (path, branch, `dev`/`ino` identity that
  #820 records). A directory without a row is reported, never deleted; a row without a directory marks its package
  `blocked` with reason `worktree-missing`; an identity mismatch is `worktree-unsafe`.
- **Disk and count:** at most `writers_max` + N best-of-N attempts + 1 live worktrees per run.

### 6.8 Review loop and adjudication

1. A package reaches `reviewing` after green checks. The reviewer gets the contract (objective, `doneWhen`, ownership,
   interfaces) and the diff against the base, **not** the writer's transcript (R5's clean context). Its return uses the
   existing `verdict`/`findings` schema (`tools/collaboration.ts:63`) plus a severity per finding.
2. `pass` records the review bound to the tree hash (`coding-gate.ts:53-57`) and queues the package. `changes_requested`
   starts a fix round: the writer receives the findings as untrusted data, may answer per finding (`fixed`, `disputed`
   with a reason), commits, and the next round reviews the new tree with a fresh reviewer session.
3. **Cap:** after 5 review rounds (Q9) the package goes to adjudication. **Early adjudication** when the same finding hash
   appears in three rounds, or a writer disputes the same finding twice: R11's step repetition is the largest single
   failure cause.
4. **Adjudication** is a lead turn: `accept` (residual findings are listed on the card and in the merge request),
   `reassign` (new writer, same worktree), `split` (new packages; the plan's hash changes and the person re-approves) or
   `escalate` (a person decides).
5. **Ownership and interfaces:** before review, `tools.team.diffcheck` compares the changed files with the package's
   globs. A change outside `owns` is refused back to the writer; a change to an `interface` file pauses the package until
   the lead approves through `team_decide` (and a person, if the plan marks the interface `person-review`).

### 6.9 Merge queue

- **Order:** the plan's `mergeOrder`, which `tools.team.check` verifies against `dependsOn` (a topological order, ties in
  plan order). A person may reorder (`team.merge.order.set`); a reorder that breaks a dependency is refused.
- **Stacks:** a package with a `code` dependency forks from the dependency's branch. When the dependency merges, the
  scheduler **retargets by merge**: on a clean package worktree (the writer idle, its work committed) it merges the
  updated target branch into the package branch with fixed argv (`git merge --no-ff --no-edit`), never a rebase, re-runs
  the checks and, if the tree changed beyond the merge, a review round. A conflict becomes a fix round for the package's writer ("merge the target and resolve"), the D115 §6.6 step 3
  rule.
- **Shared files** (lockfiles, generated registries): owned by none; after each merge the queue regenerates them in the
  next package's worktree through the project's D98 manifest, or the plan names one package as their owner (a plan
  field, not an owner question).
- **Gate:** before `awaiting-person`, the D98 gate runs on the exact tree that will merge (`approvedTreeHash`, D115 §6.6
  step 5), and, with the forge sink, the forge's required checks must be green.
- **The person merges (I2, D109).** `team.merge.confirm` is human-only, needs a T2 or T3 surface (D109 row), and is an
  approval bound to package, tree hash and target head; any change voids it.
- **Sinks (Q6).** *Local:* the core merges the package branch into the project's root branch with a merge commit through
  the provisioner (`mergePreview`, `merge`, `revert` as D115 §6.5 specifies; built here once, reused by D115 WP4). The
  root branch reaches the base branch through D115 WP4b. *Forge:* each package branch is pushed and gets a pull request
  (stacked on its dependency's branch), the forge's checks are the CI gate, and the merge happens on the forge by the
  person, or through `team.merge.confirm` which merges by API as a merge commit. Pushing needs a D109 grant (Q18); #820's
  refusal of `push` (`provisioner.ts:11`) stays for every other path.
- **Back-pressure:** while `collaboration.teams.merge.maxPendingPersonMerges` (Q19) packages wait for a person, no new
  package starts writing (R12).

### 6.10 Workers: native, external ACP, A2A

- **Native:** a turn of the writer agent through the composed runner (`composition/collaboration.ts`), with the package
  worktree as its only root, the task class's round limit as `maxRounds`, and the work budget from the package
  allocation (not the 2,000-token return cap).
- **External ACP** (ADR-011 tier 1: Claude Code, Codex, Goose; Gemini best-effort, `ADR-011:85-98`): one ACP session per
  package with `cwd` = the package worktree (#820), `session/request_permission` routed to D109 as today, `fs/*` and
  `terminal/*` contained by #820 and, after D123 SB-5, by the Rust sandbox. Its own approval policy and budget
  (`ADR-011:63`).
- **A2A peers** (ADR-008, `ADR-008:20`; D114 "agent as a service"): read helpers and reviewers only in v1 (Q11). A remote
  writer would need a worktree across instances, which D114's loan model scopes to a borrower project, not to a package.
- **One identity, several sessions:** the same agent may write several packages at once, each in its own worktree and
  `AgentScope` (`ADR-003:139`); memory capture follows the 2026-10-29 rule (`ADR-003:165-172`), so each package's exchange
  is captured with origin `collab` and its own trace.

### 6.11 Failure handling

| Failure | Detection | Response |
|---|---|---|
| Writer crash or model error | run rejects | one retry with the profile's fallback model; then `adjudication` |
| Writer stalls | no tool call and no tree change for the class's stall time | a D120 H3 steer ("report status"), then restart with a resume brief (§6.12), then adjudication |
| Package exceeds its allocation or deadline | budget refusal or timer | partial return kept (today's `interrupted` semantics, `ADR-003:159`); adjudication may raise the allocation within the run budget |
| Run budget exhausted | team scope refusal | the run pauses (never cancels); the person may raise the budget |
| Review does not converge | round cap or repetition (§6.8) | adjudication |
| Checks or CI red | gate result | fix round with failing names |
| Merge conflict | `mergePreview` | fix round for the later package |
| Dependency failed or cancelled | state change | dependents `blocked`; a lead turn re-plans (person re-approves a changed plan) |
| Interface change | `tools.team.diffcheck` | package paused until lead (and person, if marked) approves |
| Worktree missing or replaced | reconciliation (§6.7) | `blocked`, reason named; no automatic re-creation over existing files |
| External CLI unavailable | ACP initialise fails | reassign to another worker kind if the plan allows, else adjudication |
| Lead unavailable | lead turn fails twice | run pauses; the person is notified |
| Core restart | start-up | §6.12 |

### 6.12 Resumability (a requirement)

R9's reference product does not restore teammates on resume. Here a restart must not lose a run:

1. **State is durable:** runs, packages, rounds, queue entries, worktree rows and budget reservations are in SQLite;
   nothing a run needs lives only in memory (unlike `service.ts:95`).
2. **Reconcile first:** worktrees (§6.7), queue entries (a merge interrupted mid-way is detected by `MERGE_HEAD` and
   aborted with `git merge --abort`, then re-queued), and expired budget reservations (the call budget's TTL).
3. **Resume packages:** a package in `writing` or `fixing` without a live worker becomes `interrupted` and restarts with
   a **resume brief**: the contract, the branch's log since its base, the uncommitted diff (the worktree survives a
   restart), the last partial return and the open findings. A new session, not a transcript replay; the worktree carries
   the work.
4. **External workers:** ACP `session/load` where the CLI supports it (U1), otherwise the resume brief; A2A tasks are
   re-read by task id (U2).
5. **Lead:** its session resumes from the session store; pending decisions are re-issued as a lead turn.
6. **Acceptance:** a kill test (core killed during writing, review, retarget and merge) ends with every package back in
   its prior state or `interrupted`, no orphan process, no lost commit and no double merge.

### 6.13 Observability and steering

- **Trace:** every lead, writer, reviewer and helper hop is a collab span with `team` and `package` attributes and a
  replayable session (`ADR-003:163`); a package's spans link to its card.
- **Team view** in the web kanban (`packages/web/src/pages/projects/`): one lane per package with state, round, writer,
  token burn against allocation, wall time, findings by severity, the merge queue in order, pending approvals of all
  workers in one panel, and the router's explanation.
- **Steering:** a person can steer the lead or any writer through D120 H3 (`session.submit` with `delivery: "steer"`,
  D120 §9.6); pause, resume, cancel, reassign, re-budget and reorder are the human-only RPCs of §6.6. The CLI gets
  `plur1bus project team status|approve|pause|resume|cancel|merge` as a thin client.
- **Logs:** `team.*` events in the D111 catalogue carry ids, counts, states and reasons, never brief or diff text.

## 7. Limits model

### 7.1 Today's constants and their replacement

| Guard | Today | Proposed | Evidence or reason |
|---|---|---|---|
| Depth | 1 for everyone (`defaults.ts:5`; tool refuses any nesting, `tools/collaboration.ts:45`) | writers only at depth 1 (children of the lead); read-only helpers up to depth 2 | R1 centralised; ADR-003 Q5 asked whether a two-level chain is needed (`ADR-003:282`) |
| Starts per turn | 3, all kinds (`defaults.ts:6`, `tools/collaboration.ts:50`) | read helpers 8 per turn, ceiling 32 (Q2); writers by slot, not by turn | judgment, bounded by the call budget |
| Writers | none (same counter) | 4 concurrent per project (Q3), never above the capacity bound (§7.3) | judgment; R9's 3–5 teammates as a comparable product default |
| Per pair | 2 (`defaults.ts:7`, `tools/collaboration.ts:49`) | 4 for consults (anti ping-pong); none for package delegation, where each package is its own card | MAST repetition is caught by §6.8 and the repeat guard |
| Turns and time | 25 turns, 5 min per chain (`defaults.ts:8-9`, `service.ts:190-195`, `:267`) | per delegation, by task class (§7.2); the run has a wall-time budget | a chain-wide 5 min timer cannot host a coding package |
| Work budget | 2,000 output tokens (`composition/collaboration.ts:51`) | the package's token allocation from the run budget | separates work from summary |
| Return cap | 2,000 tokens | unchanged; full results by pointer | ADR-010 §4; R6 summarises rollouts too |
| Token budget | optional per project (`defaults.ts:13`) | mandatory per run, allocated per package, admitted per call | R3 |
| Cycle and self-call, abort propagation, partial results, repeat window | as in `guardrails.ts:21-22,27`, `service.ts:235-247` | unchanged | ADR-003 table |

### 7.2 Task classes (Q4)

| Class | Rounds per delegation | Wall time per delegation | Stall time | Used for |
|---|---|---|---|---|
| `consult` | 25 | 5 min | 2 min | questions, read helpers (today's values) |
| `research` | 50 | 15 min | 5 min | exploration, explanations |
| `review` | 40 | 20 min | 5 min | reviewers, judges |
| `code-small` | 100 | 45 min | 10 min | packages under about 200 changed lines |
| `code-large` | 200 | 120 min | 15 min | larger packages |

These values are judgment calls: no source in §3 gives them. The `consult` row keeps Goose's defaults that ADR-003 cites;
the others scale with the work. PT-2's evaluation records rounds and wall time per class, and the defaults move to the
measured 95th percentile plus margin after the first baseline. The token allocation per package is not in this table: it
is the run budget split by the plan's estimates (§7.3).

### 7.3 Governors

1. **Token budget.** A run cannot start without a finite `tokenBudget` (the person sets it with the plan approval; the
   plan's estimate is the suggestion). The call budget gains two scopes, `team` (id = run) and `package` (id = package),
   as an additive call-schema 3 (`budget/calls.ts:13`); each package's limit is its allocation, the run's limit is the
   budget, and every provider call is admitted against all matching scopes as today (`composition/provider.ts:532`). A
   refusal happens before the call, never after.
2. **Machine capacity.** Concurrent writers are bounded by `min(writers.perProject, capacity.maxWriters)`, where the
   capacity default is half the cores `supervisor.maxCores` allows, at least one (`config.schema.json:602`; judgment:
   each writer runs builds and tests). Concurrent D98 checks have their own bound. Each external worker process keeps
   its D123 task and memory limits.
3. **Local-model concurrency.** Calls to a local endpoint (loopback or a D51 node; D119 leaves `llm.chat` unqueued,
   D119 §5.1) pass a per-endpoint semaphore, default 1 (judgment; measured by PT-2, U3). A blocked call waits; it is not
   refused. Cloud providers have no fixed cap; rate-limit errors go through the retry budget.
4. **Review capacity.** Reviewer runs count against a reviewer pool (default = the writer limit); person merges against
   `maxPendingPersonMerges` (Q19).

### 7.4 Admission

```text
admit(start s):
  guardrails: self-call, cycle, depth by class           → refuse (guardrail reason, as today)
  s is a read helper and turn helpers ≥ readHelpers.perTurn → refuse "fanout"
  s is a writer and (slots full or person queue full)    → wait in "ready" (not a refusal)
  run budget remaining < package minimum                 → refuse "token-budget" before any call
  reserve the slot synchronously (no await between check and reservation)
  every model call                                      → checkBeforeCall with team and package scopes
```

### 7.5 Concurrency

- `consult_agent` and `delegate_task` accept `wait: false` and return `{ taskId }` after the slot is reserved; the run is
  the library's existing non-blocking `collab.delegate` (`service.ts:488-527`). `await_delegations` collects results.
- **Structured concurrency:** a turn cannot end with children it started and did not bind to a card; at the end of the
  turn they are awaited up to their deadlines, then cancelled with partial results. Card-bound children survive the turn
  (they belong to the scheduler).
- **The race is closed:** the tool reserves its start slot before any `await` (today it checks at
  `tools/collaboration.ts:50`, awaits at `:68`, increments at `:80`).
- **Proof (PT-1 acceptance):** four delegations started in one step run against fake runners that each block on a
  shared barrier released only when all four have started. On today's code the test times out, because the second run
  never starts while the first waits; after PT-1 it passes, and the recorded maximum concurrency is 4. No `sleep`
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
budget headroom (budget ÷ estimate); deadline pressure; the person-merge queue length; smoothed past outcomes per arm in
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
  and no revert within 14 days; 0.7 merged after adjudication; 0.3 partial; 0 failed or cancelled. `T_ref` and `W_ref`
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
6. **After:** the winner takes the normal path (review, merge queue); the losers' worktrees are pruned. The judge's
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
  Terminal-Bench only if the owner amends D120 Q21 (Q15): D120 §6.6 records that the SWE-bench harness is MIT while its
  instances are third-party code under their own licences with dataset terms of their own, and that Terminal-Bench is
  Apache-2.0 at repository level while single tasks can embed third-party files; Q21 decided "self-authored only". The
  proposal is a local-only runner that fetches them at run time, never vendored and never in CI.
- **Arms.** `single`, `single` at the highest reasoning effort (R4's control), `single+review`, `explore+single`,
  `team`, `best-of-n(3)`; each arm joins when its package lands.
- **Budgets.** Matched: the same token cap per task for every arm (R2's fair comparison). Natural: each arm at its
  default (what a person pays).
- **Metrics.** Resolved rate per tier and language; tokens in and out with the cache-read share; wall time p50 and p95;
  model calls; review findings by severity; fix rounds; merge conflicts; person interventions and approvals; failure
  modes tagged by MAST category (specification, inter-agent misalignment, task verification) with a step-repetition
  count (R11); resolved per million tokens.
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
| A worker writes outside its package | D109 roots = its worktree only; sibling paths on its deny list (D115 §6.4 pattern); ACP `fs/*` and terminals contained (#820, D123); `tools.team.diffcheck` before review | a process outside the sandbox (the same-OS-user boundary that D123 §1 keeps) |
| An agent message taken as a person's approval | D109: only a person approves; every worker's approval request goes to the person's surfaces (team view, T2/T3 channels), batched per run within D109's prompt cap; agent text never resolves a request (the rule R9 states for its teammates) | approval fatigue with many workers; mitigated by per-run task grants (Q18) |
| Permission laundering between agents | a denial is recorded on the run; the same action hash requested by another agent of the run within the run is answered as repeat-denied (D109's repeat-denied context); `approvalsHeld` only for delegable approvals within the hand-off scope (D109 row) | a semantically equivalent action with a different hash; the reviewer and the person see the diff |
| Secrets in briefs | contracts, plans and findings pass the core redactor before persistence and dispatch (`service.ts:275`); external workers get the scrubbed environment (#820); `plur1bus-tools` never sees secrets (D120 §5); the forge credential stays in the core | a secret the redactor does not know |
| Prompt injection through code, findings or peer output | all peer and repository content enters as untrusted `tool_result` (`ADR-003:161`); findings cannot widen scope; the merge needs a person | an injected change that passes review and the person |
| Budget runaway | finite run budget; per-package allocation; admission before every call; pause, not overspend | estimate errors within one call |
| Merge of an unreviewed or changed tree | the merge approval binds tree hash and target head; the D98 gate runs on the exact tree | — |
| History damage | merges only, no rebase, reset, force or delete by the core (#820 refusal set; D115 §6.6) | — |
| Push without consent | push needs a D109 grant scoped to the run's `p1b/` branches (Q18) | — |
| Router learns from or leaks content | features are numbers and enums; the store holds no text; local only | — |

## 13. Migration from today's guardrails

1. **One source.** PT-1 moves every limit into a resolved `CollabLimits` (config keys under `collaboration.limits.*`,
   `x-restart: live`, `x-tier: advanced`, project overrides that may only narrow, as D115 S3 rules); the tool layer, the
   service and the composed runner read from it. The copies spread over the five files of §1.2 disappear.
2. **Stored project settings.** `createProject` persists the full merged settings (`collab/store.ts:87-91`), so every
   existing project carries today's defaults. One migration drops stored values equal to the old defaults so the new
   defaults apply (Q20); explicit non-default values stay. Fan-out was off by default (`config.schema.json:123`), so no
   default installation depends on the old values.
3. **Switches.** `collaboration.fanoutEnabled` keeps its meaning for model-initiated fan-out; `collaboration.teams.enabled`
   (default `false`) gates team mode; per-project and per-request use is possible once built (Q16).
4. **Return contract.** `returnContract.maxTokens` stays at most 2,000; `budget.tokens` becomes the work allocation and
   loses the 2,000 coupling.
5. **ADR-003.** The proposed amendment note points here; the guardrail table changes only when the owner accepts D124.
6. **Docs.** `docs/collaboration.md` (guardrails, team mode), `docs/budgets.md` (new scopes), `docs/errors.md` (new
   reasons), the register row and a milestones row when D124 is accepted.

## 14. Risks

| Risk | Mitigation |
|---|---|
| Token cost grows several-fold (R3: about 15×; R4: 1.8–5.1×) for little gain | finite run budgets; router masks; `single+review` as the common default; evaluation at both budgets |
| Teams used on sequential work (R1: −39 to −70 %) | hard masks; the coupled tier in the evaluation |
| Error amplification | centralised topology only (R1: 4.4× against 17.2×); no worker-to-worker channel |
| Fragmented implicit decisions (R5) | one writer per branch; ownership and interface contracts; lead approval for interface changes |
| The person becomes the bottleneck (R12) | back-pressure on pending merges; one plan approval; batched approvals |
| Review loops that never end (R11) | round cap, repetition detector, adjudication |
| Benchmarks that do not reflect team work (R13) | the team tier; tokens and failure modes always reported |
| A weak lead (R4) | the lead uses the strongest configured tier; the router masks `team` without one |
| The bandit learns noise from sparse, delayed rewards | shadow start, exploration cap, hard masks, decay, reset |
| Merge conflicts and stale stacks | ownership disjointness checked at plan time; merge preview; retarget by merge; fix rounds |
| Scope and maintenance (a large feature) | packages land behind `teams.enabled`; each PR independently useful (plan) |

## 15. Calls made by the author (not owner questions)

- The arms, the heuristic rules and their order (§8.3); linear Thompson sampling over LinUCB, because it yields
  propensities for off-policy evaluation.
- Asynchronous delegation with structured concurrency instead of parallel dispatch in the turn loop (TD12).
- The table and column names in §6.4, the plan schema name `plur1bus.teamplan/1`, the method and tool names in §6.6.
- Retarget by merge, merge preview before the person is asked, the shared-files rule (§6.9).
- Orphaned worktree directories are reported, never deleted (§6.7).
- The resume brief instead of transcript replay (§6.12).
- A tied best-of-N pair goes to the smaller diff (§9).

## 16. Owner questions

| # | Question | Options | Recommendation |
|---|---|---|---|
| Q1 | Register entry | **D124**; fold into D120 | **D124.** Free on main and on the recently updated branches; a decision of its own beside D115 |
| Q2 | Read-only helpers | (a) 8 per turn, ceiling 32, depth 2; (b) 6 per turn, ceiling 16, depth 1; (c) keep 3 | **(a).** Read helpers do not write; the call budget bounds their cost; depth 2 answers ADR-003 Q5 for reading only |
| Q3 | Concurrent writers per project | 2; **4**; capacity only | **4**, configurable, never above the capacity bound (§7.3) |
| Q4 | Turn and time limits per task class | the §7.2 table; keep 25 turns and 5 min; per project only | **The table** as a start; PT-2 replaces it with measured values |
| Q5 | Unit of a work package | a card with a card worktree (#820); a D115 subproject per package | **Card.** Subprojects carry their own board, members, memory pool and allocation, which a package does not need; a package that needs its own team becomes a subproject |
| Q6 | Merge sink | local (D115 §6.6 merge commit into the root branch); forge (a pull request per package, forge CI, the person merges on the forge); both | **Both, local first** (PT-6, no credential needed), forge next (PT-7, the controller workflow exactly) |
| Q7 | Plan and budget approval | the person approves plan and budget once; automatic; per package | **Once per run**, on a T2 or T3 surface; `auto` as a per-project opt-in |
| Q8 | Review in team mode | every package; only at 200 changed lines (D98) | **Every package** (R4, R5); the 200-line rule stays for single-agent `coding_complete` |
| Q9 | Fix rounds | 3; **5**; unbounded | **5**, with early adjudication on repeated findings (R11) |
| Q10 | Reviewer model | same family as the writer; prefer a different provider family | **Prefer a different family** when one is configured; otherwise the same family in a fresh session |
| Q11 | Worker kinds in v1 | native only; native and ACP; also A2A writers | **Native and ACP** writers; A2A peers as read helpers and reviewers |
| Q12 | Best-of-N | N 3 (max 8), distill-refine off; N 5; judge only | **N 3, max 8, distill-refine off** until PT-2 measures it |
| Q13 | Router start | bandit from day one; shadow first, then capped exploration; heuristic only | **Shadow for the first 30 eligible decisions**, then at most 10 % exploration until each arm has 30 outcomes |
| Q14 | Reward weights | λ_t 0.3, λ_w 0.2; outcome only; token-heavy | **0.3 and 0.2**, adjustable by the person |
| Q15 | External benchmarks | keep D120 Q21 (self-authored only); allow local-only, un-vendored runs of SWE-bench Verified and Terminal-Bench subsets | **Allow local-only runs**: never vendored, never in CI, aggregate counts only; an amendment of Q21 for evaluation only |
| Q16 | Team mode availability | off until the evaluation; explicit use once built, router-initiated after the evaluation; on by default | **Explicit use once built, router-initiated per task class after the evaluation** (§11) |
| Q17 | Selective verification gate | now; after the evaluation baseline and best-of-N; drop | **After** (PT-13) |
| Q18 | Push authority for the forge sink | an approval per push; one task-scoped grant per run limited to the run's `p1b/` branches; a standing grant | **Task-scoped grant per run** |
| Q19 | Packages waiting for a person | 3; 5; no limit | **3** (R12) |
| Q20 | Stored settings of existing projects | drop values equal to the old defaults; keep them | **Drop** (§13 step 2) |

None blocks PT-1's mechanism: it ships with the recommended defaults behind configuration, and an answer changes only
values. PT-6 and PT-7 wait for Q6, PT-12 for Q13 and Q14, PT-14 for Q15.

## 17. Unknowns

| # | Unknown | How it gets resolved |
|---|---|---|
| U1 | Which ACP CLIs support `session/load` for resuming a worker (our own ACP server says `loadSession: false`, `docs/acp.md:16`; #820's client side is not checked) | PT-8 probes each M6 CLI; the resume brief is the fallback |
| U2 | A2A task re-reading after a long restart for remote helpers | PT-8 |
| U3 | Real concurrency of local model servers behind D51 endpoints | PT-2 measures; the default semaphore is 1 until then |
| U4 | Whether D115 WP4 builds the provisioner's merge operations before PT-6 | PT-6 builds them to the D115 §6.5 interface; WP4 reuses them |
| U5 | The GitHub credential profile needed by D115 WP4b and PT-7 | checked when PT-7 starts |
| U6 | Token and wall-time cost of team and best-of-N on our stack (R6 reports none; R4 reports 1.8–5.1×) | PT-2, PT-10 |
| U7 | Whether a prompted verifier gives R7-like gains without training | PT-13 |
| U8 | MAST's step-repetition share (about 15.7 %) is from the brief; the abstract page does not show it | not used as a threshold |
| U9 | Hidden shared state when one agent identity runs several sessions at once | PT-4 isolation test |
| U10 | When D120 B1's runner lands | PT-2 builds it to D120's plan if B1 has not started |
| U11 | Precision of glob ownership for generated files and lockfiles | PT-3b and the team tier |
| U12 | Prompt-cache hit rate when many workers start fresh contexts | PT-2 reports the cache-read share per arm |
| U13 | A D120 H3 steer that arrives while a turn waits in `await_delegations` | PT-1 test, coordinated with H3-1 |
