# Hierarchical subprojects (M5+) — implementation plan

**Goal.** Projects get subprojects created from cards: inherited and only narrowed settings, own branch and worktree
forked from the parent's, a coordinator that starts, steers, observes, evaluates and merges, structured reports upwards,
and strict sibling isolation on every channel, as specified in
[`2026-10-19-subprojects-design.md`](../specs/2026-10-19-subprojects-design.md) (cited as "spec §n").
**Architecture.** A subproject is a project row with `parentId`/`rootId`/`depth` (collab migration v5); every existing
M5 path (board, trace, replay, D104, D98, budget admission) is reused by project id; one isolation predicate
`visibleFrom()` in `packages/core/src/collab/` feeds every object check, the event audience, the memory scope and the D109
roots; worktree fork/merge extends `ProjectWorktreePort` with a provisioner shared with M6; a new closed schema
`plur1bus.report/1` carries reports upwards as tainted data.
**Status.** Plan only. Owner questions spec §16 Q1–Q10 open; WP1 waits for Q1–Q3, WP4 for Q8, WP3 for Q6/Q7.
**Constraints.** Additive only: new RPC methods with `x-stability: "experimental"`, `x-server: "core"`, `x-since`, closed
params (AGENTS.md); no new RPC error codes (reuse `E_DENIED`, `E_NOT_FOUND`, `E_CONFLICT`, `E_INVALID_PARAMS`,
`E_APPROVAL_REQUIRED`); no new dependencies; no engine change (memory scoping goes through the existing memory port and
D31 shared-memory surface, or stays a KNOWN GAP); no change to ADR-003 chain depth or the fan-out default; no D104 schema
version change. Git only with fixed argv, never history rewrite. No CI polling, force-push, rebase, amend or stash.

## Review focus

1. **Siblings see nothing** on any channel (board, cards, comments, activity, traces, replay, export, events, reports,
   artifacts, memory, files, budget status, tools, WebMCP, CLI), and a sibling lookup is indistinguishable from a missing
   object (`E_NOT_FOUND`).
2. Effective settings are **never wider** than the parent's, including after a later parent narrowing (computed at use).
3. Approvals reach a child only through `approvalsHeld`; an agent coordinator cannot exceed its principal.
4. Reports and returns are untrusted, tainted data in the parent; core-computed progress/cost override agent claims.
5. Merge only of the exact tree the D98 gate verified; no force, no rewrite, no push.
6. Allocation sum never exceeds the parent's remaining budget; admission checks every ancestor.

## Dependencies and order

```text
WP0 decisions ──► WP1 model + inheritance ──► WP2 isolation ──┬──► WP5 hand-off + reports ──► WP6 coordinator ──► WP8 web
                                   │                            ├──► WP3 memory scope (R4)                            │
                                   │                            └──► WP7 budget (R3) ─────────────────────────────────┤
                                   └──► WP4 worktree fork/merge (R6, Q8) ─────────────────────────────────────────────┤
                                                                                         WP9 CLI ◄────────────────────┤
                                                                       WP11 isolation suite + E2E ◄── all ──► WP10 docs
```

One branch and one **ready** PR per work package (stacked PRs only where a WP needs its predecessor's code; then
`--base <predecessor branch>` and "baut auf #N auf"). Branch names `codex/subproj-wp<n>-<slug>` or per the controller.

**Preconditions (spec §14):** R1 M5 P1–P5 (met, #510/#514/#515/#516/#520). WP8's live acceptance needs R2 (M3 web
transport). WP7's live admission needs R3 (M2 budget turn-loop hook). WP3 needs R4 (project pool materialisation); without
it WP3 ships "stateless subproject runs" with a KNOWN GAP todo test. The security acceptance of WP5/WP6 needs R5 (D109
taint producer). WP4 needs R6 (provisioner agreed with M6).

---

## WP0 — Owner decisions and prerequisite check (≈ 0.5 agent days)

**Content.** Record answers to spec §16 Q1–Q10 in the spec (status lines as in the federation spec), assign the decision
number, update `docs/milestones.md` placement if Q1 changes it. Check R2–R7 on current `main` and note gaps in the plan.
**Acceptance.** Spec §16 carries a status per question; this plan's Status line names the WPs that are unblocked.

## WP1 — Data model, hierarchy and inheritance (≈ 3 agent days)

**Files.** `packages/core/src/collab/migrations.ts` (v5, spec §11.1), `types.ts` (optional `Project` fields, states),
`store.ts` (parent/root/depth, ancestor and descendant queries, state log), new `collab/hierarchy.ts` (`ancestors()`,
`descendants()`, `effectiveSettings()`, `narrow()`, depth ceiling), `service.ts` (create-from-card transaction without
repo and budget parts, lifecycle transitions, archive rules spec §3.3), `errors.ts` (guardrail reasons
`hierarchy-depth`, `sibling-boundary`; reason strings only).
**Tests.** `packages/core/test/collab/hierarchy.test.ts`: migration v4→v5 keeps every row, roots backfilled; depth
ceiling refused with `hierarchy-depth`; property test random parent × override never wider; parent narrowing reaches a
running child on the next evaluation; `allowCrossProject` forced false in a tree; override that widens refused
(`E_INVALID_PARAMS`, reason `override-widens`); archive of a parent with a running child refused/confirmed.
**Acceptance.** All existing collab tests unchanged and green; new tests green on real SQLite.

## WP2 — Isolation in RBAC, scopes, events and object checks (≈ 4 agent days)

**Files.** New `collab/visibility.ts` (`visibleFrom(principal, projectId)` → `self | ancestor | none`), used by
`service.ts` (`getProject`, `listProjects`, `getTask`, `getTrace`, `listTraces`, `replay`, `exportTrace`), `board.ts`
call sites in the board RPC handlers, artifact lookup, `coding-surface.ts` (`admitted`), chat promotion target check;
`scope.ts` (`AgentScope.projectId` must equal the node for agent access); guardrails (`project-boundary` per node,
`sibling-boundary` audited); event audience for collab and board events (per recipient, ancestors only) — coordinate with
the events owner (M6) for the audience hook; WebMCP forbidden prefixes `project.subproject.`, `project.coordinator.`,
`project.repo.` (`packages/webmcp`, coordinated with its owner).
**Tests.** `collab/visibility.test.ts` (predicate table incl. Owner/Admin, Viewer, child-only member, agent assigned to
two siblings); per-channel negative tests move into WP11's suite, WP2 adds the positive ancestor matrix and the
`E_NOT_FOUND`-not-`E_DENIED` oracle test.
**Acceptance.** No existing project/board/trace test changes its expectation for root projects.

## WP3 — Memory scoping and raising memories (≈ 3 agent days; R4)

**Files.** Composition of the turn memory port for subproject runs (pool key `project:<childId>`, agent-private recall and
capture off, spec §5.3/S10), pass-down copy of parent pool items with taint and origin, raise-up as a D31-style proposal
accepted by the coordinator (Q6), `collab/` glue only; engine untouched.
**Tests.** Real stores + fake engine (as `collab/isolation.test.ts`): marker captured in child A absent from child B's
recall, from the agent's private store and from the parent pool until accepted; accepted proposal appears in the parent
pool with provenance; pass-down item tainted in the child.
**Fallback without R4.** Subproject runs are stateless (no recall, no capture); KNOWN GAP todo test
"subproject pool capture" stays executable-pending.

## WP4 — Worktree fork, sandbox and merge back (≈ 4 agent days; R6, Q8)

**Files.** `collab/coding-surface.ts` (`ProjectWorktreeProvisioner` beside `ProjectWorktreePort`, spec §6.5), a single
git implementation with fixed argv (shared with M6, no second creator), repo binding (`project.repo.bind/unbind`),
naming (spec §6.2), fork inside the create transaction, D109 roots and deny-list for child runs (spec §6.4), merge
preview/commit bound to the D98 `treeHash` (spec §6.6), cleanup and branch retention.
**Tests.** Temp git repos: fork from a parent that moved, `baseSha` recorded; conflict preview lists files and refuses
commit; merge of a tree different from the gated one refused; sandbox refuses sibling and parent paths via `..`, symlink,
absolute path (through `pathCovered` and the deny-list); cleanup removes worktree, keeps unmerged branch; names with
unsafe characters never reach argv.
**Acceptance.** D98 gate unchanged for root projects; external agent adapter receives the child checkout.

## WP5 — Hand-off down and report channel up (≈ 3 agent days)

**Files.** Card → subproject preview/commit/start (spec §5.1) building `plur1bus.handoff/1` from the card (spec §8.1);
new `collab/schemas/report.schema.json` (`plur1bus.report/1`, closed); report store, triggers (spec §8.3), rate limit and
dedup; core-computed `progress`/`cost`; `report_to_parent` tool for child agents; `BoardLink.kind` `subproject`; instruct
and forward with source stripping (spec §8.4); taint marking `subproject:<id>`.
**Tests.** Schema closure (unknown property, oversize refused); agent-supplied progress/cost overwritten; forward to B
contains no A id/name/agent/trace id; instruct cannot widen authority (D104 `expected`); rate limit; returns rendered as
untrusted `tool_result` for an agent coordinator; taint flag set on the coordinator turn (needs R5, else KNOWN GAP todo).

## WP6 — Coordinator role, control and agent tools (≈ 3 agent days)

**Files.** `project.coordinator.set`; control operations start/pause/resume/cancel/reprioritise/swap-agent with live
effect at the next turn boundary (pause/cancel abort in-flight chains through the existing abort path, partial results
kept); coordinator tools (spec §7.2) in the per-turn composition with D109 effects and defaults; audit events (spec
§13.4); evaluation flow (spec §9.3).
**Tests.** Rights matrix spec §7.1 row by row for person, agent coordinator, ancestor lead, child member; agent
coordinator gets `ask` for start/cancel/budget/merge and `allow` for pause; pause stops new turns and keeps partial output;
swap-agent moves the child's sessions to the new agent without carrying the old agent's memory; a child agent cannot see
or call coordinator tools.

## WP7 — Budget allocation (≈ 2 agent days; R3)

**Files.** `project.subproject.budget.set`; allocation as M2 project-scope ceiling + reservation against the parent;
ancestor chain in admission (`packages/core/src/budget` call site through the collab `BudgetPort`, no budget-store schema
change if the existing project scope suffices — otherwise stop and report); pause on exhaustion; release on terminal
state.
**Tests.** Allocation sum bound; top-up beyond parent refused (`E_CONFLICT`, `allocation-exceeds-parent`); cut below used
+ in-flight refused; ancestor limit refuses a child call even when the child has allocation left; unused part released on
completion; child sees only its own figures.

## WP8 — Web UI (≈ 4 agent days; live acceptance needs R2)

**Files.** `packages/web/src/pages/projects/**`: subproject badge with traffic light and progress on origin cards
(`board-view.ts`), "Make subproject" in `card-drawer.ts` with preview dialog, drilldown route and breadcrumb (`page.ts`),
coordinator tab (children table, report feed, question inbox, actions), child "Upwards" panel; DE/EN in
`i18n/projects.ts` (append only); styles in `styles/projects.css` (no inline styles); report bodies escaped like
`handoff-card.ts`.
**Tests.** Mock-server unit tests per component; Chromium DE/EN keyboard flow card → subproject → pause → report →
merge preview; a child-only member's view contains no sibling name or link (DOM assertion); axe clean.

## WP9 — CLI (≈ 1.5 agent days)

**Files.** `crates/plur1bus/src/commands/project.rs` (or the existing project command module): `project sub …`,
`project tree`, `project coordinator set`, `project repo bind` (spec §11.5), every leaf `[experimental]`, `--json` raw RPC
value with `schema` id; regenerate `docs/cli.md` via `pnpm docs:gen` (`cargo` build only where the controller allows it;
otherwise the CLI WP runs on a machine with disk for cargo).
**Tests.** clap parse tests; JSON passthrough tests against a fake core; exit codes from `docs/errors.md` mapping.

## WP10 — Documentation (≈ 1 agent day)

**Files.** `docs/collaboration.md` (subproject section), `docs/projects-board.md` (subproject link and badge),
`docs/rbac.md` (hierarchy visibility, new methods in the project table), `docs/rpc.md` (generated), `docs/cli.md`
(generated), user docs DE/EN (`docs/user/*/`), `docs/demos/` (demo: split a card into two subprojects, observe, merge),
`docs/milestones.md` status paragraph for M5+.

## WP11 — Isolation suite and end-to-end (≈ 3 agent days)

**Files.** `packages/core/test/collab/subproject-isolation.test.ts`, `packages/web/test/subprojects.test.ts`, a
transport test through the real HTTP API (as `collab/web-transport.test.ts`) once R2 is on `main`.
**Matrix.** Fixture tree root → A (→ A1), B, each with unique markers in card text, comment, trace preview, report,
artifact, memory entry, worktree file. Probed **from** A's agent, A's child-only member, A's agent coordinator, A1's agent
(and the federation peer stub once Track F exists) **through** board read/list/search, card get, comments, activity, trace
get/list/export, replay, events subscription, report list/send addressing, artifact get, memory recall, host file tools,
consult/delegate to B's agent, hand-off forging with `task.project = B`, budget status, `project.list`, `project.tree.get`,
WebMCP tool list, CLI `--json`. Expected: no B marker anywhere; lookups `E_NOT_FOUND`; refusals audited. Plus root sees
all, A sees nothing of root's board except pass-down items.
**Acceptance.** Every cell has a named test; the suite runs in CI without live models.

---

## Effort and gates

| WP | Content | Depends on | Effort (ad) |
|---|---|---|---|
| WP0 | Owner decisions, prerequisite check | — | 0.5 |
| WP1 | Data model, hierarchy, inheritance | WP0 (Q1–Q3) | 3 |
| WP2 | Isolation predicate in RBAC/scopes/events/object checks | WP1 | 4 |
| WP3 | Memory scoping, pass-down, raise-up | WP2; R4; Q6/Q7 | 3 |
| WP4 | Worktree fork, sandbox, merge back | WP1; R6; Q8 | 4 |
| WP5 | Hand-off down, `plur1bus.report/1` up, forward | WP2 | 3 |
| WP6 | Coordinator role, control, agent tools | WP5 | 3 |
| WP7 | Budget allocation and ancestor admission | WP2; R3; Q9 | 2 |
| WP8 | Web UI | WP4–WP7; R2 for live | 4 |
| WP9 | CLI | WP4–WP7 | 1.5 |
| WP10 | Documentation and demo | WP8, WP9 | 1 |
| WP11 | Isolation suite and E2E | all | 3 |
| | **Total** | | **≈ 32 ad (26–40)** |

Range: −20 % if R4/R6 are already provided by their owners when work starts; +25 % if the worktree provisioner has to be
built here from scratch and the events audience hook needs its own change.

**Gates.**
- **G1 (after WP2):** isolation predicate reviewed by an independent reviewer; no change to root-project behaviour.
- **G2 (after WP4):** git operations audited (fixed argv, no rewrite, no push, tree-hash binding).
- **G3 (after WP6):** D109 defaults for agent coordinator tools confirmed by the owner.
- **G4 (WP11):** full isolation matrix green; owner acceptance of the demo.

**Acceptance criteria (track).**
1. A card becomes a subproject with inherited, narrowed settings, its own board and (with a repo) its own branch/worktree.
2. An agent in a subproject works only in its worktree and reports upwards with `plur1bus.report/1`; the parent board
   shows aggregated status with traffic light, progress and cost.
3. The coordinator (person and agent) can start, pause, resume, cancel, reprioritise, re-budget, instruct, forward and
   swap agents; effects apply at the next turn boundary.
4. **Siblings see nothing** across the WP11 matrix; sibling lookups answer `E_NOT_FOUND`.
5. No effective setting, right or budget of a child is wider than its parent's, including after later parent changes.
6. Merge back happens only through the D98 gate and the coordinator's decision on the exact verified tree.
7. Allocations never exceed the parent's remaining budget; unused allocation returns on completion.
8. Reports and returns enter the parent as tainted untrusted data; agent-supplied progress/cost is overwritten by the core.

## Open points carried from the spec

Spec §16 Q1–Q10; prerequisites R2–R7 (spec §14); the Track F interface (spec §12) is named, not built.
