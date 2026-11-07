# D127: Executable checks, real edges, blind review, closed lanes and a learning edge into the plan

**Status.** This plan records an owner decision; there is no product code yet. Decided 2026-11-07.

**What it changes.** It amends D104 (hand-off format), D124 (parallel agent teams: plan checker, review, team channel, merge autonomy) and D126 (learning pass).

**Executor.** Sonnet. Mostly Rust in `plur1bus-tools` and TypeScript in the core.

**Effort.** About 3.5 agent-days, inside the D124 work packages named per task.

## 1. Background

The owner asked whether PLUR1BUS should adopt anything from the article "Loops and Graphs: how to stop babysitting agents and only approve the last step" (Hanako, X, 2026-08-23). The article promotes a course and offers no measurements, but its engineering principles are sound:

- **A loop needs a check that can fail.** The check must be one a program can evaluate. "Looks good", "the model is confident" and "no errors were raised" are not checks.
- **Graph edges are real data dependencies.** "And then" is not an edge.
- **Code does deterministic work.** Merging, ranking and deduplication are code, not model calls.
- **Workers run in isolated contexts.** Parallel reviewers that read each other converge on one opinion.
- **Only the failing unit goes back,** with verdict, reason, evidence and scope, under a round cap.
- **The gate opens by blast radius, not by confidence.** Irreversible work belongs to a lane that does not open, not to a high threshold.
- **Learning flows into the planner.** Accepted results return as constraints to the step that splits the work.
- **A person approves only the step of highest consequence and lowest reversibility.**

**Already covered by D124 and D98.**
- **Checks before review:** D98 checks run on the exact tree before review.
- **Fresh-context reviewer:** it sees contract and diff, not the writer's transcript.
- **Per-package fix rounds:** independent packages continue, and the scope is bounded by `owns`.
- **Round cap:** five rounds (owner, Q9), with early stop on repetition and `needs-decision`. The article suggests three; the owner's five stays.
- **Best-of-N:** tests first, a model judge only as tie-break, and attempts without contact.
- **Deterministic scheduling:** the transition function, plan checker and impact analysis are code.
- **The person approves at two points:** the scope up front and the section merge.

D126 already lanes its learning-pass tiers by scope and change type and excludes the model's self-reported confidence.

## 2. Decision (owner, 2026-11-07)

### 2.1 Executable acceptance checks (K1; amends D104 and D124)

Today `doneWhen` is a list of text criteria, and the agent reports `met` and `evidence` itself (`packages/core/src/collab/handoff.ts:47`).

1. **Optional `checks[]` in the hand-off.** The field is additive, so `plur1bus.handoff/1` stays valid. Each entry carries:
   - `criterion`, the index into `doneWhen`;
   - `kind`, one of:
     - `command`: argv, run in the worktree, expected exit 0, with a timeout;
     - `tests`: named tests, run by the project's D98 runner;
     - `paths`: the diff stays inside the listed globs.
2. **The harness runs every check itself,** in the verifier sandbox that runs the D98 checks today: no network unless the task declares it, scrubbed environment, D109 policy.
   - It sets `met` and `evidence` for checked criteria.
   - A worker's own `met` on a checked criterion is ignored.
   - Unchecked criteria stay claims, and the UI shows them as unverified.
3. **The D124 plan checker** (`tools.team.check`) requires at least one `command` or `tests` check per coding package. A plan without one is refused with the package named.
4. **"No error" is never a pass.** A check that cannot run (missing runtime, timeout, sandbox refusal) is `unavailable`, never `met`, and blocks the package like a red check.

### 2.2 Edges must name what crosses (K2; amends D124 §6.14)

1. A `code` dependency is valid only if the dependent package `consumes` an interface the dependency `provides`, or if the plan names the carried artefact (`carries`: file or symbol).
2. An `order` dependency needs a one-line `reason`.
3. `tools.team.check` reports every other edge as `false-edge`, together with the wall time the critical path would save without it. The lead fixes the plan or gives a reason before the person approves.

### 2.3 Blind review (K3; amends D124 §6.8, §6.16, §9)

1. Reviewers and the judge get no `team_read` and no `team_dm` for a package until they have submitted their verdict for it. Best-of-N attempts already have no contact.
2. Parallel reviews are merged and deduplicated by code, by the D124 finding hash. Only then does the merged list reach the writer and the channel.

### 2.4 Closed lanes by reversibility (K4; amends D124 §6.9, §6.14, §8)

1. **Every package gets a lane,** computed by `tools.team.check`/`tools.team.impact` from its `owns` paths, its contract and the target.
   - **`contained`:** an isolated change with test coverage. Autonomous as today.
   - **`wide`:** a shared utility, a schema or an interface with many consumers (impact fan-out ≥ 5 packages or files outside its section; judgement value). Autonomous inside the scope only when:
     - the deterministic checks are green;
     - the trajectory is clean: at most two fix rounds, no dispute, no `needs-decision`;
     - the revert rate of its model, task class and worker kind (from the router's outcome store) is below 10 %.
     - Otherwise the merge needs `team.merge.confirm`.
   - **`closed`:** the package touches any of these, or its target branch deploys on push:
     - database migrations;
     - data deletion;
     - release, publish or deploy configuration;
     - CI workflows;
     - container and infrastructure files;
     - secret-bearing configuration;
     - branch-protection or permission settings.
2. **Rules for `closed`.**
   - A `closed` package always needs `team.merge.confirm`, even inside an approved scope.
   - Its section never merges into the target branch by itself, even under `auto`.
   - The classes are built in. A project can add paths and branches (`collaboration.teams.closedPaths`, `collaboration.teams.deployBranches`), but cannot remove a built-in class.
   - A closed lane is not a threshold.
3. **Detecting a deploying target branch.** A workflow under `.github/workflows` that runs on push to that branch and contains a deploy, publish or release step marks the branch `deploys`. Unknown or unparsable workflows count as deploying (fail closed).

### 2.5 Learning edge into the plan (K5; amends D126 §3.3)

1. **A new finding kind, `planning-constraint`,** produced by the per-project D126 learning pass. It draws on:
   - fix rounds whose cause was confirmed;
   - `needs-decision` outcomes;
   - review finding hashes that recur across packages or runs.

   Example: "adapters preserve keyword arguments exactly", derived from an accepted fix.
2. **Storage and use.**
   - Planning constraints live in the project memory under a planning node.
   - The lead's brief for `team_propose_plan` carries the active ones, bounded to 20 constraints and about 1,500 tokens, newest-confirmed first.
   - They shape how the work is cut, not only what a worker does.
3. **Tier.** They are tier B of D126: project memory, applied after the 48-hour objection window.
   - Each carries its source runs and findings.
   - One without a related event for 90 days becomes a retire proposal.

### 2.6 Aggregation in code (K6; amends D126 V3b)

In the learning pass:
- **The model:** extracts findings per session and words proposals.
- **Code:** clusters, counts prevalence, deduplicates and ranks. It uses normalised keys, finding hashes and embedding similarity as a deterministic computation, never a model judgement.

## 3. Tasks

| Task | Scope | Where (D124/D126 package) | Estimate |
|---|---|---|---|
| **K0** | This plan; amendment notes in the D124 spec, the basics spec (D104) and the D126 plan | `docs/` | done in this PR |
| **K1** | `checks[]` in the hand-off; harness-run checks in the verifier sandbox; `met`/`evidence` set by the harness; `unavailable` blocks; plan checker requires one check per coding package; UI marks unverified claims | `packages/core/src/collab/{handoff,verifier,coding-gate}.ts`, `crates/plur1bus-tools` (PT-3b, PT-5) | 1.0 |
| **K2** | `code` edges validated against `provides`/`consumes`/`carries`; `order` needs `reason`; `false-edge` report with critical-path saving | `crates/plur1bus-tools` (PT-3b) | 0.5 |
| **K3** | No channel access for reviewers and judge before their verdict; merge and deduplicate parallel findings by hash in code | `packages/core/src/collab/`, team channel (PT-5, PT-5b, PT-10) | 0.5 |
| **K4** | Lane computation, closed classes and deploy-branch detection; confirm gates for `wide`/`closed`; no autonomous section merge with a `closed` package; revert rate from the router store | `crates/plur1bus-tools`, `packages/core` (PT-6, PT-11) | 1.0 |
| **K5** | `planning-constraint` finding kind; planning node; bounded injection into the lead's plan brief; 90-day retire proposal | `packages/core/src/dreams/learn/`, lead brief (after D126 V3d and PT-4b) | 0.5 |
| **K6** | Specification only: the D126 V3b aggregation is code | D126 V3b | 0 |

**Order.**
- K1 can land on its own now; the hand-off format and verifier exist on `main`.
- K2 and K4 go with PT-3b and PT-6, K3 with PT-5/PT-5b, and K5 after D126 V3 and PT-4b.

## 4. Tests

**K1**
- A worker claims `met: true` on a checked criterion whose command fails. The harness records `met: false` with the exit code.
- A check whose runtime is missing is `unavailable` and blocks.
- A check runs in the sandbox, without network, and with a scrubbed environment.
- A plan with a prose-only coding package is refused.

**K2**
- A `code` edge without a crossing interface is reported as `false-edge`, and the critical-path saving is computed.
- An `order` edge without `reason` is refused.

**K3**
- A reviewer's `team_read` before its verdict is refused.
- Two reviewers with the same finding produce one merged finding with both sources.

**K4**
- A migration path, a CI workflow or a deploying target branch makes the lane `closed`.
- A `closed` package inside an approved `plan` scope still waits for `team.merge.confirm`.
- An `auto` section with a `closed` package waits for `team.section.merge`.
- A project setting cannot remove a built-in class.
- An unparsable workflow counts as deploying.

**K5**
- A confirmed fix cause becomes a `planning-constraint` proposal with sources.
- After the objection window it appears in the next plan brief, within the bound.
- After 90 days without a related event it becomes a retire proposal.

**Gates**
- D124's existing gates and owner decisions stay in force: five fix rounds, scopes, the section merge by the person unless `auto`.
- Tests are never skipped or weakened.
