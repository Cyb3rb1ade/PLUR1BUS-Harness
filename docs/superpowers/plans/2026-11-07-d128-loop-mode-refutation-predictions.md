# D128: Loop mode for recurring tasks, refutation before learning, and falsifiable learning

**Status.** This plan records an owner decision; there is no product code yet. Decided 2026-11-07.

**What it changes.**
- It extends the recurring user tasks (`jobs.*`, `packages/core/src/user-jobs/`).
- It amends D126 (learning pass) and D127 K5 (planning constraints, PR #893).
- It records a later owner question on harness self-evolution.

**Executor.** Sonnet, TypeScript.

**Effort.** About 5 agent-days.

## 1. Background

The owner asked whether PLUR1BUS should adopt anything from the article "Prompt → Context → Harness → Loop → Graph: The 5 Levels of AI Engineering" (Livsun, X, 2026-10-31).

**Already covered:**
- context budgeting: ADR-010 prompt zones, recall budgets, D103 shortlists;
- the harness: tools, D109, sandbox, memory, traces;
- "done means tests pass": D98, and the D127 K1 harness-run checks;
- worktrees, skills, connectors, proposer/checker separation, the board as a state store;
- the split → fan-out → verify → merge diamond, and routing as code (D124, D127).

**Two gaps remain.**
1. **Level 4, "loop engineering".** Our recurring tasks are a cron plus a prompt. Every run is an ordinary turn with no goal, no state and no brakes. The article's brakes for such loops are:
   - a done check outside the model;
   - a budget;
   - a dry-round rule: stop after two rounds that find nothing new;
   - state written after every step.
2. **The verify step of the diamond:** a skeptic tries to kill every finding before it passes.

The article cites the paper *Agentic Harness Engineering* (arXiv 2604.25850). Its figures were checked against the paper on 2026-11-07:
- **Result:** Terminal-Bench 2 pass@1 rose from 69.7 % to 77.0 % in ten iterations, against 71.9 % for the Codex-CLI harness.
- **Ablation:** long-term memory +5.6 points, tools +3.3, middleware +2.2, system prompt −2.3.
- **Caveats:**
  - one campaign;
  - evolution and measurement on the same benchmark;
  - budgets tuned to one model.

The paper turns each harness edit into a *falsifiable contract*: evidence, root cause, fix, and the improvements and regressions it predicts. The next round checks those predictions and reverts edits that did not deliver.

## 2. Decision (owner, 2026-11-07)

### 2.1 Loop mode for recurring tasks (L1)

A recurring task may carry an optional `loop`. Without it, nothing changes.

1. **Goal and done check.**
   - `loop.goal` is text of at most 1,000 characters.
   - `loop.checks[]` uses the D127 K1 kinds (`command`, `tests`, `paths`, plus `state`: a field of the loop state equals a value). The harness evaluates them after each run.
   - When all checks pass, the loop ends: status `done`, the task is disabled, and a delivery notice goes out.
   - A loop without checks needs `maxRuns`.
2. **State.**
   - Each loop has a state: a bounded JSON record of at most 8 KiB in `state/user-jobs.sqlite`, or a linked board card.
   - The run loads it into its prompt, after the goal.
   - The agent updates it only through a loop-scoped tool, `loop_state_write`, and the harness writes it after every run.
   - A crashed run resumes from the last written state.
3. **Budget.**
   - `maxRuns`, `tokensPerRun` and `tokensPerDay` per loop, enforced through a new call-budget scope `job` (`budget/calls.ts`).
   - When the budget is exhausted the loop pauses with an inbox entry. Tokens only, never money.
4. **Dry-round rule.**
   - Code detects progress. A run made progress when at least one holds:
     - the loop state's hash changed;
     - a check result changed;
     - a board event occurred on the linked card;
     - a tool call with an effect class other than `read` succeeded.
   - Two consecutive runs without progress pause the loop and post an inbox entry with the last state. The count is configurable from 1 to 5; the default is 2.
5. **Pace.**
   - The cron stays the floor schedule.
   - With `loop.pace: { minMinutes, maxMinutes }`, the agent may set its next run through `loop_next { inMinutes }`, clamped to those bounds. Without `loop.pace` the cron alone decides.
6. **Rights and approvals stay unchanged.**
   - A loop runs as `runAs`, through the regular turn, budget and memory pipeline.
   - Under D109 §9 a headless call without a job grant is refused. Repeated refusals therefore count as "no progress", and the loop pauses and asks in the inbox instead of retrying.
7. **Surfaces.**
   - `jobs.create`/`jobs.update` accept a closed `loop` object, at the next free RPC minor at implementation time.
   - `jobs.history` shows the loop status (`running | paused:dry | paused:budget | done | failed`), runs and progress.
   - CLI: `plur1bus jobs create … --goal --check --max-runs --pace`.
   - The web task editor gets a loop section.

### 2.2 Refutation before learning (L2; amends D126 §3.3)

1. **The skeptic.** After the deterministic aggregation (D127 K6), every candidate finding for tier A or B goes to a skeptic subagent before it is scored.
   - The skeptic sees only the finding, its evidence references (readable under the target store's rights) and the verify-step result.
   - Its one task is to disprove the finding.
   - Its verdict is one of `holds`, `refuted` or `insufficient`.
2. **What each verdict does.**
   - `refuted`: the finding is dropped and logged in the run ledger.
   - `insufficient`: the finding moves to tier C.
   - `holds`: the finding goes on to scoring.
   - The verdict enters the evidence score as a factor; it is never the only input.
3. **Model tiers (D105 classes).**
   - The per-session extraction runs on the small or medium class.
   - The skeptic and the wording of proposals run on the large class.
4. **D124.** Refuting review findings of severity medium or higher before they reach the writer is measured as an option in PT-2. It becomes a default only on a measured reduction of needless fix rounds at a bounded token overhead.

### 2.3 Falsifiable learning (L3; amends D126 §3.3 and D127 K5)

1. **Every automatically applied change carries a prediction.** This covers D126 tiers A and B and D127 K5 planning constraints. The prediction states:
   - the signal: a finding key, a tool-error class, a review finding hash, or the fix rounds per task class;
   - the expected direction;
   - a window: the next 10 relevant sessions, or 14 days, whichever comes later.
2. **Evaluation.** Code counts the signal at each learning-pass run. The outcome is `confirmed`, `not-confirmed` or `insufficient-data`.
3. **What `not-confirmed` does.**
   - For a tier-A change: an automatic revert through V2 `memory.revert`, with a diary entry.
   - For tier B and planning constraints: a retire proposal with the 48-hour objection window.
   - Outcomes feed the D126 calibration record and the revert-rate breaker.

### 2.4 Later owner question: harness self-evolution (L4, not scheduled)

An AHE-style offline loop over PLUR1BUS's own harness components is a later option. Those components are tool descriptions, middleware settings, bundled skills and memory defaults.

Preconditions:
- the B1 coding baseline is accepted;
- the evolving agent edits only a dedicated workspace;
- verifier, tracer and model configuration are read-only;
- every edit carries a falsifiable manifest;
- the measurement is paired on B1 and `turn-eval` against the delta rule of the D120 spec (§6.4);
- the output is pull requests only, merged by a person;
- it never focuses on tuning the system prompt.

The owner decides on it after the baseline exists, together with a token budget.

## 3. Tasks

| Task | Scope | Where | Estimate |
|---|---|---|---|
| **N0** | This plan; amendment notes in the D126 plan and ADR-009 | `docs/` | done in this PR |
| **N1** | `loop` schema (goal, checks, state, budgets, dry-round count, pace); `jobs.*` RPC and CLI; store migration for loop state and status | `packages/rpc-schema`, `packages/core/src/user-jobs/`, `crates/plur1bus/src/commands/` | 1.0 |
| **N2** | Run lifecycle: load state and goal; `loop_state_write` and `loop_next` tools scoped to the job; harness-run checks (D127 K1 runner); `done` handling | `packages/core/src/user-jobs/`, `packages/core/src/tools/` | 1.0 |
| **N3** | Budget scope `job`; progress detection in code; dry-round and budget pause with inbox entries; resume after crash | `packages/core/src/budget/`, `user-jobs/`, `inbox/` | 0.75 |
| **N4** | Web task editor loop section; history with loop status | `packages/web` | 0.5 |
| **N5** | Skeptic step and model tiers in the learning pass | `packages/core/src/dreams/learn/` (D126 V3) | 0.75 |
| **N6** | Predictions on applied changes; outcome evaluation; automatic revert or retire proposal; calibration input | `packages/core/src/dreams/learn/` (D126 V3e, D127 K5) | 1.0 |

**Order.**
- N1–N4 are independent of D124/D126 and can start now. They reuse the D127 K1 check runner, so K1 lands first.
- N5 and N6 belong to D126 V3 and land with it.

## 4. Tests

**Loop mode**
- A loop whose checks pass after run 3 ends as `done` and disables the task.
- A loop without checks and without `maxRuns` is refused.
- Two runs without state change, check change, board event or effect pause it as `paused:dry` with an inbox entry.
- `tokensPerDay` exhaustion pauses it as `paused:budget`.
- `loop_next` is clamped to the pace bounds and ignored without `pace`.
- A crash mid-run resumes from the last written state.
- A headless call that needs approval is refused (D109 §9) and counts as no progress.
- `loop_state_write` cannot write another job's state.
- Loop state and goal never appear in logs, only ids and counts.

**Refutation**
- A refuted finding is never applied and is logged.
- `insufficient` sends the finding to tier C.
- The skeptic sees no evidence beyond the target store's rights.

**Predictions**
- A tier-A change whose signal does not move within its window is reverted, with a diary entry.
- A tier-B change or planning constraint becomes a retire proposal.
- `insufficient-data` changes nothing.
- Outcomes appear in the calibration record.

**Gates**
- ADR-016 contract rules.
- D109 unchanged.
- No money dimension.
- Tests are never skipped or weakened.
