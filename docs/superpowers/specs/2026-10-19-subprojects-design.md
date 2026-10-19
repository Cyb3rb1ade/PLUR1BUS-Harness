# Hierarchical subprojects in the project/Kanban system (M5+) — design

**Status:** Phase 1: specification and plan, no product code. Owner decisions of 2026-10-19 incorporated (§16 Q1–Q10
decided, **D115**) · **Date:** 2026-10-19 ·
**Owner:** Christian (Cyb3rb1ade) · **Track:** M5+ (collaboration extension; outside the v0.1.0 total but **scheduled**:
the next track directly after the M5 base and before Track F, to be built soon — decided 2026-10-19, Q1) ·
**Decision record:** **D115** in the core spec's register
([`2026-09-24-m1b-2a-core-daemon-cli-design.md`](2026-09-24-m1b-2a-core-daemon-cli-design.md) §2) ·
**Plan:** [`2026-10-19-subprojects.md`](../plans/2026-10-19-subprojects.md)

**Owner request (2026-10-19, dictated, verbatim in substance):** „Können wir die Projekte im Kanban-Board so erweitern,
dass es Subprojekte gibt – nicht vollkommen eigenständig, sondern mit allen Settings und mit dem zugeordneten
GitHub-Worktree, falls einer zugeordnet ist. Agenten, die an so einer Subtask arbeiten, nehmen das Ganze in so ein
Unterprojekt mit und reporten zurück an die eigentliche Projektaufgabe. Im Hauptprojekt kann man einen Koordinator
einsetzen und die Arbeiten an untergeordneter Stelle durchführen lassen. Vom Hauptprojekt aus kann man in die
Unterprojekte gucken, sie steuern, beobachten und auswerten. Von den Subprojekten aus kann man nach oben kommunizieren,
sieht aber die anderen Subtasks nicht.“

**Inputs read for this spec** (state of `origin/main` @ `f7fc17c6`): `packages/core/src/collab/**` (`types.ts`,
`service.ts`, `store.ts`, `migrations.ts` v1–v4, `board.ts`, `handoff.ts` and the three closed schemas, `target.ts`,
`runner.ts`, `scope.ts`, `guardrails.ts`, `defaults.ts`, `errors.ts`, `ports.ts`, `coding-gate.ts`, `coding-surface.ts`,
`verifier.ts`, `chat-promotion.ts`, `fanout-eval.ts`); the M5 plan
[`2026-10-15-m5-collaboration.md`](../plans/2026-10-15-m5-collaboration.md) (phases P1–P5, all merged: #510, #514, #515,
#516, #520); [`docs/milestones.md`](../../milestones.md) (§2, §M5, Track F, §7, §8);
[`docs/collaboration.md`](../../collaboration.md); [`docs/projects-board.md`](../../projects-board.md);
[`docs/rbac.md`](../../rbac.md) and [ADR-007](../../adr/ADR-007-users-roles-identity.md);
[ADR-003](../../adr/ADR-003-agent-model-and-collaboration.md) (`AgentScope`, depth 1, Q4/Q5);
[`docs/policy-evaluator.md`](../../policy-evaluator.md) (D109) and [`docs/approvals.md`](../../approvals.md) §3.5 (taint);
[`docs/agent-isolation.md`](../../agent-isolation.md); [`docs/budgets.md`](../../budgets.md) (L8 hierarchy);
`packages/web/src/pages/projects/**` (`page.ts`, `board-view.ts`, `card-drawer.ts`, `handoff-card.ts`,
`delegation-trace.ts`); the federation spec
[`2026-10-19-federation-cluster-design.md`](2026-10-19-federation-cluster-design.md) (§5–§8, Q14); `AGENTS.md`
(RPC schema conventions). Structure and style follow
[`2026-10-18-desktop-ssh-remote-design.md`](2026-10-18-desktop-ssh-remote-design.md).

## 1. Goal and non-goals

**Goal.** A project can have **subprojects**. A subproject is not an independent project: it is created from a card of
its parent, inherits the parent's settings, rights, budget and (if the parent has one) its git repository, and works in
its own branch and worktree. A **coordinator** in the parent distributes work to subprojects, starts, steers, observes
and evaluates them, and decides what is merged back. Agents working in a subproject receive a bounded context package
and report **only upwards**; **siblings never see each other**.

Concretely, after this design is built:

1. A card on a project board can be turned into a subproject ("card → subproject"), manually or by the coordinator.
2. The subproject has its own board, members, agents, trace and memory scope; its effective settings are the parent's,
   optionally **narrowed**, never widened.
3. If the parent has a bound repository, the subproject gets its own branch and worktree forked from the parent's
   branch; the result returns through the D98 coding gate and a review into the parent branch, and **PLUR1BUS performs
   the merge itself** after a person's confirmation (or on its own with the per-project auto-merge setting, Q8) — no
   manual commit or merge on GitHub.
4. The parent sees every descendant (board, status, trace, reports, cost) and can pause, resume, cancel, reprioritise,
   re-budget, instruct and re-staff it, live.
5. A subproject sees only its own context plus what the parent coordinator explicitly passes down; it talks upwards
   through one structured channel; anything between siblings goes through the coordinator.

**Non-goals (this design).**

- No independent "project inside a project" with its own owner hierarchy: the root project's owner and leads stay
  authoritative for the whole tree.
- No change to ADR-003's **chain** depth 1. Subproject depth and delegation depth are separate axes (§3.2).
- No lateral channel between siblings, not even an opt-in one in v1 (Q5, decided).
- No new worktree subsystem beside the existing `ProjectWorktreePort`; the fork/merge operations are an extension of
  that port, owned together with M6 (§6.5).
- No federation code in this track. The federation side — one subproject as the share and mission unit — is built in
  Track F WP14 on top of the interface this design defines (§12); this track is its precondition.
- No change to D104 schema versions: the hand-off package is `plur1bus.handoff/1` as is; the upward reports add one new
  closed schema `plur1bus.report/1` (§8).
- No new RPC error codes; refusals use `E_DENIED`, `E_NOT_FOUND`, `E_CONFLICT`, `E_INVALID_PARAMS`,
  `E_APPROVAL_REQUIRED` and the existing collab guardrail reason mechanism (two new reason strings, §13).

## 2. Decisions at a glance

| # | Topic | Decision (owner answers of 2026-10-19 marked "decided") | Main alternative, why not |
|---|---|---|---|
| S1 | Representation | A subproject is a **project row** with `parentId`, `rootId`, `depth`, `originCardId`; it reuses board, members, agents, tasks, traces, artifacts, budget scope keyed by its own id. | A separate `subprojects` table with its own board: duplicates every M5 path (board, trace, replay, gate, RBAC) and every test. |
| S2 | Depth | **Hard ceiling 2 levels below the root in v1** (root → child → grandchild; decided, Q2); default setting `subprojects.maxDepth = 2`, configurable downwards. **Children may create grandchildren themselves** by default; per project switchable to "only with the root coordinator's approval" (decided, Q3, §5.2). | Unbounded: the visibility and budget computations walk the ancestor chain on every call; the UI breadcrumb and the isolation test matrix grow without bound. Depth 1 only: fails the first realistic split of a large child. |
| S3 | Inheritance | **Effective settings = parent's effective settings narrowed by the child's override**; computed live on every evaluation, never copied; an override that would widen is refused at write time. | Copy at creation: a later narrowing in the parent would not reach running children (privilege escalation by staleness). |
| S4 | Repository | If the parent has a repo binding: child branch `p1b/<rootKey>/<childKey>` forked from the parent branch HEAD, worktree under the core's state root, **merge back only through D98 gate + review**; **PLUR1BUS executes the merge** (merge commit) after a person confirms the bot's proposal, or by itself with the per-project auto-merge setting (decided, Q8, §6.6–§6.7). No repo binding → no worktree. | Children working directly in the parent worktree: siblings would see each other's files (violates the core requirement). |
| S5 | Coordinator | One coordinator per project node. **Default: the project owner, whatever kind of identity it is** — a person or an agent persona such as "Bernd"; another identity only by assignment (decided, Q4). A person acts through RPC/UI under `project.manage`; an agent acts through the coordinator tools, every effectful action through D109 (approvals and policy as usual, `ask` by default). | Lead-only control without a coordinator role: the owner explicitly asked for a delegable coordinator. |
| S6 | Visibility | **Down: full** (ancestors see descendants). **Up: only the report channel** plus what was passed down. **Sideways: nothing**, enforced in RBAC/object checks, `AgentScope`, event audience, memory scope and D109 roots — not only in the UI. A sibling object answers `E_NOT_FOUND`, never `E_DENIED`. | UI-only hiding: an agent with the board tools or a person with the CLI would still read sibling cards. |
| S7 | Upward channel | **`plur1bus.report/1`** for progress, question, blocker and milestone; `plur1bus.return/1` stays the completion envelope; both arrive in the parent as **tainted, untrusted data** with provenance. | Free-text comments on the origin card: no structure for aggregation, no taint boundary, injection-prone. |
| S8 | Sibling hand-over | Only via **coordinator forward** (`project.subproject.forward`); the receiving child sees "from coordinator", never the source sibling's id or name; no direct channel (decided, Q5). | Direct child-to-child messages: the request says siblings do not see each other. |
| S9 | Budget | Every child has an **allocation** carved from the parent's remaining budget in the dimensions tokens, turns/requests and wall time — no USD dimension (§10.1); finite values are hard limits; every call checks the child **and all ancestors**; unused allocation flows back on close. Every project has a budget with defaults (tokens unlimited, 150 turns, 36 h wall time; §10.1, Q9); each value is user-modifiable and may be set to unlimited per project. | Shared pool without allocation: one child can starve its siblings, and "how much did this subproject cost" has no limit to compare against. |
| S10 | Memory | Child work is captured into a **subproject pool** (`project:<childId>`), not into the agents' private stores; recall inside a child sees only that pool plus items passed down; **no agent-private recall or capture** in children and grandchildren (decided, Q7). Raising memories to the parent is **explicit per entry**; at completion the coordinator confirms a pre-selected list (decided, Q6). | Agent-private capture: the same agent working in two siblings would carry one sibling's knowledge into the other (a covert sibling channel). |
| S11 | Federation | A subproject is the **share unit** and **mission scope**; Track F builds this as **WP14** (on WP4/WP12; federation spec Q14 decided: one borrower project); this spec defines `SubprojectRef` and the isolation predicate WP14 reuses (§12). | Sharing whole root projects only: a guest would see all siblings. |

## 3. Terms and the hierarchy model

### 3.1 Terms

| Term | Meaning |
|---|---|
| **Project** | today's M5 project (`prj_…`): members, agents, board, settings, traces. A project without a parent is a **root project**. |
| **Subproject** | a project with `parentId ≠ null`. It belongs to exactly one parent and one root. "Unterprojekt" in the owner's words. |
| **Ancestors / descendants** | the parent chain up to the root / all subprojects below a node. |
| **Siblings** | subprojects with the same parent. **Cousins** (same root, different parent) are treated exactly like siblings. |
| **Card / task** | a card on a board (`BoardCard`). A subproject is created from one **origin card** of its parent; the card stays on the parent board as the subproject's representative. |
| **Coordinator** | the actor of a project node that distributes and steers that node's subprojects: by default the project owner — a person or an agent persona —, otherwise the identity assigned to the node (§7). |
| **Hand-off package** | the D104 `plur1bus.handoff/1` contract that starts a subproject (§8.1). |
| **Report** | a `plur1bus.report/1` envelope from a subproject to its parent (§8.2); the completion is a `plur1bus.return/1`. |
| **Pass-down item** | anything the coordinator explicitly gives a child after start: an instruction, an artifact, a forwarded report excerpt, a memory item (§8.4). |

### 3.2 Two independent depth axes

- **Hierarchy depth** (`project.depth`, root = 0): bounded by `subprojects.maxDepth` (hard ceiling 2 in v1, S2).
- **Chain depth** (ADR-003, `CollabSettings.maxDepth`, default 1): applies **inside** each project node as today. Starting a
  subproject is **not** a consult/delegate hop: the child gets its own root chain (new `traceId`) whose root span carries a
  **link** to the parent's span that created it (`links: [{ traceId, spanId, kind: "subproject" }]`). So a child agent can
  still consult one peer inside the child (depth 1 there), and the parent's chain does not grow by one per level.

Rationale: if subproject start counted as a hop, depth 1 would forbid any delegation inside a child, and raising chain
depth globally (ADR-003 Q5) is a much broader change than the owner asked for.

### 3.3 Lifecycle states

`draft` (created, not started) → `running` ⇄ `paused` → `completed` | `cancelled` | `failed` → `merged` (repo only) →
`archived`. Transitions are owned by the coordinator (§7) and audited. `completed` means the child's return envelope was
accepted by the parent's evaluation (§9.3), not that the child said "done". Archiving a parent requires all descendants to
be in a terminal state (or cancels them, with confirmation); a parent cannot be archived with a `running` child silently.

## 4. Inheritance (settings, rights, budget, tools, guardrails)

### 4.1 Principle: narrow only, computed live

`effective(node) = narrow(effective(parent), node.override)` for every inherited field, evaluated at **use time** (each
RPC, each tool call, each D109 decision), never cached across a parent change. An override is stored as a sparse object;
fields not present are inherited. Writing an override that is wider than the parent's current effective value is refused
(`E_INVALID_PARAMS`, reason `override-widens`). If a parent later narrows below a child's override, the child's effective
value follows the parent (the override is then redundant, and the UI marks it "overridden by parent").

### 4.2 Field table

| Field (source) | Narrowing rule | Notes |
|---|---|---|
| `CollabSettings.maxDepth`, `maxFanout`, `maxPairPerTurn`, `maxTurns`, `timeoutMs`, `returnTokens`, `repeatWindowMs` | `min(parent, override)` (`repeatWindowMs`: `max`, longer is stricter) | numeric guardrails |
| `CollabSettings.allowCrossProject` | **forced `false`** for every node of a tree that has subprojects | otherwise the `project-boundary` guard would let a child agent consult a sibling's agent |
| `CollabSettings.tokenBudget`, `costBudget` | replaced by the **allocation** (§10) | a child never declares its own unbounded budget |
| `collaboration.fanoutEnabled` (global) | AND | fan-out stays off unless on globally and not disabled on any ancestor |
| Model roles (D105 class / allowed models per role) | subset of the parent's allowed set | a child may pin a cheaper allowed model, never a model the parent does not allow |
| Tool view (`AgentScope.toolView`) | intersection | a child may drop tool families, never add |
| D109: `tools.deny`, deny-list, roots | `tools.deny` and deny-list **union**; roots **replaced** by the child's sandbox roots (§6.4), which lie inside the parent's roots | grants are not inherited (§4.3) |
| Effects ceiling (`read` … `money`) | `min` | e.g. parent `local-write`, child may be `read` |
| Guardrails added by the parent (e.g. WIP limits on the child board) | parent's value is a ceiling | |
| Members (people) | child members ⊆ root members (any role); child role ≤ role in the parent | a person cannot become lead of a child unless lead of the parent or explicitly made child lead by the coordinator |
| Agents | child agents ⊆ agents the coordinator may use (`agent.use`); see §5.3 for sharing one agent across siblings | |
| `privacy.localOnly` and other global privacy keys | global, unchanged | a child never relaxes a global key |

### 4.3 Rights and approvals are not inherited upwards or sideways

- RBAC object rights on the **root** (`member`/`lead`) imply **observe** on all descendants and, for `lead`, **control**
  (§7.1). Rights on a child imply nothing on the parent or siblings.
- D109 grants and approvals are bound to person, task, session and agent (handoff.ts `verifyHandoffAuthority`); they do not
  flow to a child. What a child may do with the parent's approvals is exactly what the hand-off package lists in
  `authority.approvalsHeld` (delegable, bound to the child's task) — the existing D104 mechanism.

## 5. Creating a subproject ("card → subproject")

### 5.1 Flow

1. **Select** a card on the parent board (not archived, not already linked to a subproject).
2. **Prepare** (`project.subproject.create` with `preview: true`): the core proposes
   - name (card title), the hand-off package draft from the card (objective = title + description, `doneWhen` from a
     checklist in the description or entered explicitly; the card description is untrusted text and is quoted, never
     interpreted),
   - inherited effective settings with an editable narrowing override,
   - an allocation (§10; defaults from §10.1 unless set, Q9),
   - members and agents (default: the card's assignees that are eligible, §4.2),
   - branch and worktree names if the parent has a repo binding (§6.2).
3. **Commit** (`preview: false` with the preview id): one transaction creates the project row, its board (existing
   trigger), the link `originCardId`, the allocation reservation, the repo fork (§6) and the audit event; state `draft`.
4. **Start** (`project.subproject.control` action `start`): the hand-off package is validated (D104 sender repair once),
   delivered to the child's lead agent as the first task, the agent acks (`plur1bus.ack/1`), state `running`.

The origin card on the parent board gets a `subproject` link (`BoardLink.kind` gains `subproject`, additive) and from
then on shows the aggregated child status (§9.2). Moving the card does not change the child's state; the card is a view.

### 5.2 Who may create

| Actor | Allowed when |
|---|---|
| Person, parent **lead** (or Owner/Admin) | always within the depth ceiling |
| Person, parent **member** | only if the parent's coordinator is that person (coordinator assignment, §7.1) |
| Agent coordinator of the parent | via `subproject_spawn` tool; D109 `ask` by default (effect `local-write`, plus `money` when an allocation is set); a grant can make it `allow` within a per-day count and budget cap |
| Child coordinator or the child's lead agent creating a grandchild | **by default allowed** within the depth ceiling (project setting `subprojects.childrenMayCreate = true`, decided Q3; children know their own need, no detour via the root coordinator); agents through `subproject_spawn` under D109 as above. With the setting `false`: only with an approval of the **root** coordinator (or a root lead) |
| Other agents of a child | create nothing themselves; they may *suggest* a split to the child's coordinator (`suggestedNext` in a report) |
| A grandchild | never (depth ceiling 2) |

`subprojects.childrenMayCreate` is a setting of the **root** project, set by a root lead (human-only) and inherited by the
whole tree; a child cannot switch it on for itself. The limits stay in force either way: depth 2, rights and budget of a
grandchild only narrower than its child's, the grandchild is supervised by the child (the child's coordinator is its
coordinator), and the root sees everything (§9.1). Every grandchild creation raises a `milestone` report to the root.

### 5.3 Agents across siblings

The same agent id may be assigned to two siblings (a reviewer, a specialist; decided, Q10). To keep siblings isolated:

- every subproject run of that agent happens in a **separate session** under `AgentScope { agentId, projectId: <child> }`;
- **recall** inside a child reads only the child's pool (and pass-down items), **not** the agent's private store (matching
  ADR-003 Q4 "stateless" for external agents; decided, Q7: children and grandchildren are spontaneously spawned agents,
  not fixed personas, so there is no agent-private recall and no agent-private capture, not even read-only);
- **capture** goes only to the child's pool; agent-private capture of subproject work is disabled;
- prompt-cache and compaction state are per session, so no cached prefix crosses siblings.

## 6. Repository and worktree

### 6.1 Repo binding on a project (prerequisite)

Today a project has no repository field; `ProjectWorktreePort.root(agentId, projectId, cardId)` returns a bound checkout
supplied by M6 adapters, defaulting to the agent workspace (`composition/index.ts`). This design adds an optional
**repo binding** on root projects: `{ repoPath, baseBranch, remote?: string }`, set by a lead, validated (`git rev-parse
--show-toplevel` equals `repoPath`, `baseBranch` exists), and a project branch/worktree for the root itself
(`p1b/<rootKey>/main`, forked from `baseBranch`). Subprojects inherit the binding; they cannot change it.

### 6.2 Naming

| Item | Scheme | Example |
|---|---|---|
| `rootKey` / `childKey` | slug of the name (a–z, 0–9, `-`, ≤ 24 chars) + `-` + first 6 hex of the project id | `auth-rework-3f9a1c` |
| Root branch | `p1b/<rootKey>/main` | `p1b/auth-rework-3f9a1c/main` |
| Child branch | `p1b/<rootKey>/<childKey>` | `p1b/auth-rework-3f9a1c/oauth-flow-b71e02` |
| Grandchild branch | `p1b/<rootKey>/<childKey>--<grandKey>` | flat, so no ref is a prefix directory of another |
| Worktree path | `<state>/worktrees/<rootId>/<projectId>/` | never inside the repository, never inside a sibling path |

Branch and path components come only from the core-generated keys; names typed by people or agents never reach `git`
argv unvalidated (same quoting-free charset rule as the D98 verifier's fixed argv).

### 6.3 Fork

At **commit** (§5.1 step 3) the core runs, with fixed argv and no shell: `git -C <repoPath> worktree add -b <childBranch>
<childPath> <parentBranch>` and records `baseSha` (the parent branch HEAD at fork time). A failure rolls back the whole
creation transaction (`E_CONFLICT`, reason `worktree-fork-failed`).

### 6.4 Sandbox

- D109 roots of every agent running in the child = **the child worktree only** (plus the child's artifact area).
  The parent worktree and every sibling path are **outside roots** and additionally on the child's deny-list
  (`<state>/worktrees/<rootId>/` minus its own subtree), so a symlink or `..` trick is refused by `pathCovered` and the
  deny-list before any host tool runs.
- External coding agents (M6, ADR-011) receive the child worktree as their bound checkout through
  `ProjectWorktreePort.root(agentId, <childId>, cardId)`.
- The D98 verifier and the review checkout read the child worktree only.

### 6.5 Port extension (coordinated with M6)

`ProjectWorktreePort` today has only `root(...)` ("no second worktree creator exists", `coding-surface.ts`). This design
proposes an additive **provisioner** next to it, implemented once and shared with M6 rather than duplicated:

```ts
interface ProjectWorktreeProvisioner {
  fork(input: { rootId: string; projectId: string; parentBranch: string; branch: string; path: string }): { baseSha: string };
  mergePreview(input: { projectId: string }): { ahead: number; behind: number; conflicts: string[]; diffStat: string };
  merge(input: { projectId: string; message: string; approvedTreeHash: string; approval: MergeApprovalRef }): { sha: string };
  revert(input: { projectId: string; mergeSha: string; message: string }): { sha: string };
  remove(input: { projectId: string; keepBranch: boolean }): void;
}
```

### 6.6 Merge back

1. Child state `completed` (return accepted, §9.3).
2. **D98 gate on the child worktree** (`task.complete` semantics: formatter, linter, type checker, tests green; review above
   200 changed lines by an agent other than the author; override only by a human lead with a note).
3. **Merge preview** against the *current* parent branch (it may have moved since `baseSha`): ahead/behind, conflicts.
   Conflicts → no merge; the coordinator either sends the child back with an instruction ("rebase onto parent" is done by
   the child agent as a normal commit-producing task in its own worktree — **never** a history rewrite by the core) or
   resolves in the parent.
4. **Merge decision** (decided, Q8), per project setting `subprojects.merge.mode` (root project, set by a root lead,
   human-only, inherited by the tree):
   - `confirm` (**default**): the coordinator — for an agent coordinator PLUR1BUS on its behalf — **proposes** the merge
     with preview, gate result and review result; **a person confirms** with one click in the coordinator view or one
     command (`plur1bus project sub merge <id> --confirm`, or the approval prompt on a paired channel through the
     existing D109 approval surface). The confirmation is an approval record bound to the child, the parent branch HEAD
     and `approvedTreeHash`; any change of either voids it.
   - `auto`: the coordinator merges by itself when the D98 gate is green **and** the review passed (verifier result plus
     an agent review by an agent other than the author, as in step 2). No human confirmation; the merge is still
     announced in the parent's feed and can be reverted (§6.7).
   In both modes **PLUR1BUS executes the merge**; nobody has to commit or merge by hand, locally or on GitHub.
5. The core merges with fixed argv into the parent branch as a **merge commit** (decided; no squash) only if the tree
   hash equals the one the gate verified (`approvedTreeHash`), state `merged`.
6. **Cleanup:** worktree removed after `merged`, `cancelled` or `archived`; the branch is kept until the parent is merged
   or archived plus `subprojects.branchRetentionDays` (default 14), then deleted only if fully merged or the project is
   archived. Nothing is force-deleted; an unmerged branch of a cancelled child stays until a lead deletes it explicitly.

Subprojects never push; only the root project's branch reaches the repository's real base branch, through §6.7.

### 6.7 Merge execution through the harness

The owner asked that PLUR1BUS carries out merges itself (Q8). The harness therefore owns three operations, all through
the provisioner (§6.5) with fixed argv, no shell, never a history rewrite or force push:

| Operation | Git / GitHub action | Who may trigger |
|---|---|---|
| **Child → parent** (every level) | `git -C <parentWorktree> merge --no-ff --no-edit -m <msg> <childBranch>` after checking `git rev-parse <childBranch>^{tree}` = `approvedTreeHash` and parent HEAD = the confirmed HEAD | `confirm`: a person (coordinator person, node lead or ancestor lead) confirms the proposal; `auto`: the coordinator once gate + review are green |
| **Root → base branch** (repo with a remote) | push of the root branch `p1b/<rootKey>/main` (fast-forward only), open or update a GitHub pull request into `baseBranch`, merge it as a merge commit through the GitHub REST API once the repository's required checks are green | same two modes, decided by the root project's `subprojects.merge.mode`; without a remote or a GitHub credential the root merges locally into `baseBranch` the same way as child → parent |
| **Revert** (undo) | `git revert -m 1 <mergeSha>` as a new commit on the target branch; on GitHub a revert pull request through the same flow | a person with merge rights (always confirm, also in `auto` mode); an agent coordinator may propose it |

- **Commit identity and trailers.** The merge commit uses the git identity of the repo binding (`authorName`,
  `authorEmail`, set with `project.repo.bind`) and carries `P1B-Subproject: <childId>`, `P1B-Tree: <approvedTreeHash>` and
  `P1B-Approved-By: <principal>|auto`.
- **Rights.** RBAC object check as in §7.1; for an agent coordinator D109 capability `project.subproject.merge` (effect
  `local-write`) and, for root → base on GitHub, effect `external`; in `confirm` mode the agent's call without a valid
  confirmation record is refused with `E_APPROVAL_REQUIRED`. Switching `subprojects.merge.mode` is human-only and needs
  root lead rights; an agent can never switch it.
- **GitHub credential.** A per-repository credential profile in the M2 secret store (fine-grained token or GitHub App
  installation, scopes `contents:write` and `pull_requests:write` for that one repository), leased per operation, never
  in prompts, logs or tool results; requests through egress to `api.github.com` only (prerequisite R8).
- **Failure handling.** A merge conflict, a moved parent HEAD, a tree-hash mismatch or a red required check leaves the
  branches untouched and answers `E_CONFLICT` with reason `merge-conflict`, `parent-moved`, `tree-changed` or
  `checks-red`; the coordinator view shows the reason and the proposal can be renewed after a fix.
- **Undo.** A revert moves the child from `merged` back to `completed` with a state-log entry `reverted`; re-merging it
  later needs a revert of the revert, which the core also does as a new commit. Nothing is ever reset or force-pushed.
- **Audit.** Proposal (tree hash, gate and review result), confirmation (who, which surface), merge commit sha, push,
  pull-request number and merge result, revert — each as an audit chain event (§13.4).

## 7. The coordinator

### 7.1 Assignment and rights

- `project.coordinator.set { projectId, coordinator: { kind: "person" | "agent", id } | null }` by a lead of that node
  (or of an ancestor).
- **Default coordinator: the project owner, whatever kind of identity it is** (decided, Q4). In PLUR1BUS a project owner
  is an identity/persona — a person or an agent persona such as "Bernd". There is no rule "person by default, agent only
  explicitly": an agent-persona owner is its project's coordinator unless someone assigns another identity. `null`
  resets to the default.
- A subproject has no owner of its own (§1 non-goals): its coordinator defaults to its parent's coordinator unless the
  parent's coordinator assigns another identity at creation (for example the child's lead agent).
- **Whenever the coordinator is an agent** (default persona owner or assigned), its effectful actions go through D109
  exactly like any other agent action: its own policy and grants, approvals (`ask`) to the persons who hold lead rights
  on the root project (for a persona-owned project: the root leads and the installation Owner/Admin). An assigned agent
  must hold `agent.use` for the person who assigned it, and that person is then the principal of its approvals.
- Rights matrix (child = any descendant of the node):

| Capability | Lead of an ancestor | Coordinator (person) | Coordinator (agent) | Child member/agent |
|---|---|---|---|---|
| See child board, cards, trace, reports, cost, worktree diff | yes | yes | yes (as tool results, tainted) | own node only |
| Create / start child | yes | yes | D109 `ask` | grandchildren of its own node only, when `childrenMayCreate` is on (default; agents through D109); otherwise suggest only |
| Pause / resume / reprioritise | yes | yes | D109 (default `allow` for pause, `ask` for resume) | no |
| Cancel | yes | yes | D109 `ask` | no |
| Budget top-up / cut | yes | yes, within the node's own remaining budget | D109 `ask` (effect `money`) | no |
| Instruct / forward (pass down) | yes | yes | yes, D109 `allow` within the node's own content; forwarding a sibling's content `ask` | no |
| Swap agent | yes | yes | D109 `ask` | no |
| Merge back (§6.6–§6.7) | yes (confirms) | yes (confirms the proposal) | proposes; executes only with a person's confirmation (`confirm`, default) or by itself on green gate + review (`auto`) | no |
| Switch `childrenMayCreate`, `merge.mode` | root lead only, human-only | root lead only | never | no |
| Report upwards | — | — | — | yes (own node only) |

### 7.2 Agent coordinator tools

Registered through the existing per-turn tool composition and D109 dispatcher (capability `agent.delegate`, as the six M5
tools), only for an agent that is the coordinator of the turn's project:

| Tool | Effect | Purpose |
|---|---|---|
| `subproject_spawn` | `local-write` (+`money` with allocation) | card → subproject (preview + commit + start) |
| `subproject_status` | `read` | tree, states, last reports, cost, acceptance status of descendants |
| `subproject_control` | `local-write` | pause, resume, cancel, reprioritise, swap agent |
| `subproject_budget` | `money` | top-up or cut an allocation |
| `subproject_instruct` | `local-write` | pass an instruction down (§8.4) |
| `subproject_forward` | `local-write` | pass an artifact or report excerpt to another child, source stripped (§8.4) |
| `subproject_merge` | `local-write` (`external` for root → base on GitHub) | merge preview, propose, and execute when confirmed or in `auto` mode (§6.6–§6.7) |

Child agents get exactly one new tool, `report_to_parent` (`read` effect towards the child, writes only into the report
channel). Children never get coordinator tools for their siblings. A child's coordinator and the child's lead agent get
`subproject_spawn`, `subproject_status`, `subproject_control`, `subproject_instruct` and `subproject_merge` for their own
children (the root's grandchildren) when `subprojects.childrenMayCreate` is on (default, Q3); a grandchild never gets
them (depth ceiling).

### 7.3 Human coordinator

The same operations through RPC (§11) and the coordinator view in the web UI (§11.4). Every control action is audited
with actor, node, previous and new state.

## 8. Hand-off down, reports up, pass-down

### 8.1 Hand-off package (D104, unchanged schema)

The start of a child is a `plur1bus.handoff/1` with `kind: "delegate"` (or `"handoff"` when ownership transfers with
history, then `state` and `triedAndFailed` are required as today):

| Field | Filled from |
|---|---|
| `task.project` | the **child** project id; `task.card` the child's first card (created from the origin card); `parent` = parent task id |
| `objective`, `why`, `doneWhen` | origin card, edited in preview; `doneWhen` required |
| `constraints.scope.paths` | the child worktree (relative) and named sub-paths; never parent or sibling paths |
| `constraints.scope.tools` | the child's effective tool view |
| `constraints.must` / `mustNot` | coordinator text plus fixed lines: "report only via report_to_parent", "do not merge" |
| `authority` | `mayDecide`, `mustAsk`, `approvalsHeld` (delegable approvals bound to the child task only) |
| `budget` | tokens and turns from the allocation (if one is set), tool-call cap, deadline from the wall-time allocation, model tier within the child's allowed models |
| `returnContract` | `plur1bus.return/1`, `maxTokens` = child `returnTokens`, `reportTo` = parent card id |
| `facts`, `decided`, `assumptions` | relevant excerpts selected by the coordinator; large material as artifact references (2 k token cap holds) |

### 8.2 `plur1bus.report/1` (new closed schema)

```json
{
  "schema": "plur1bus.report/1",
  "id": "rep_…",
  "subproject": "prj_…",
  "inReplyTo": "<handoff id>",
  "kind": "progress | milestone | question | blocker | final-notice",
  "summary": "≤ 1 000 chars",
  "progress": { "doneWhenMet": 2, "doneWhenTotal": 5, "cardsDone": 7, "cardsTotal": 12 },
  "artifacts": [{ "ref": "artifact:… | git:<sha> | pr:<url>", "kind": "diff|file|log|link", "sha256": "…" }],
  "cost": { "tokens": 12345, "turns": 18, "wallMs": 5400000, "allocationLeft": { "tokens": 40000, "turns": 42 } },
  "openPoints": ["≤ 20 items, ≤ 300 chars each"],
  "question": { "text": "…", "options": ["…"], "blocking": true },
  "at": "RFC 3339"
}
```

`additionalProperties: false` at every level; `progress` and `cost` are **computed by the core** from the child board,
ledger and acceptance evaluation and overwrite whatever the agent supplied (an agent cannot inflate its progress or hide
its cost). The completion stays `plur1bus.return/1` (status `done`, `done_with_concerns`, `blocked`, `needs_context`,
`declined`, `partial`).

### 8.3 Triggers

| Trigger | Who | Kind |
|---|---|---|
| Card of the child reaches its done column; a `doneWhen` item met | core (automatic) | `milestone` |
| Agent calls `report_to_parent` | child agent | any kind |
| Blocker (approval waiting > `subprojects.blockerAfterMs`, guardrail refusal, budget < 10 % left, verifier red) | core | `blocker` |
| Interval while `running` (`subprojects.reportIntervalMs`, default 30 min, 0 = off) | core | `progress` |
| Return envelope received | core | `final-notice` + return |

Rate limit per child: at most `subprojects.maxReportsPerHour` (default 12) agent-initiated reports; core-generated
reports are deduplicated (same content hash within the interval is dropped).

### 8.4 Pass-down

- **Instruct:** an instruction amends the running child's contract as a new task message in the child's session; it can
  narrow scope or add work **within** the existing authority. Widening authority requires a new hand-off with new
  approvals (D104 `expected` immutability).
- **Forward:** an artifact or report excerpt of child A given to child B is copied into B's artifact area with provenance
  `{ origin: "coordinator", forwardedAt, sha256 }`; A's id, name, agent ids and trace ids are stripped (Q5). The coordinator
  sees the full provenance in the parent's audit.
- **Memory items:** a parent pool entry passed down is copied into the child's pool, marked tainted with its origin.

## 9. Observation and evaluation from above

### 9.1 What the parent sees

For every descendant: board (read), cards, comments, activity, traces and replay (redacted as today), reports and returns,
cost and allocation, worktree diff and gate results, state history. Read access walks **down** only.

### 9.2 Aggregation on the parent board

The origin card shows a subproject badge: state, **traffic light**, progress bar, cost vs. allocation, last report time,
open blockers count. Traffic light:

| Colour | Rule (first match) |
|---|---|
| red | state `failed`, an open blocking question older than `blockerAfterMs`, allocation exhausted, verifier red on the last gate |
| amber | `paused`, allocation < 20 % left, no report within 2 × `reportIntervalMs`, `done_with_concerns` |
| green | `running` and none of the above, or `completed`/`merged` |
| grey | `draft`, `cancelled`, `archived` |

Progress = `doneWhenMet / doneWhenTotal` when the contract has criteria (always, D104 requires `doneWhen` for delegate),
board card ratio as secondary figure. The parent's own progress aggregates its children weighted by allocation.

### 9.3 Evaluation

When a return arrives: (1) the core checks it against the schema (one repair by the same target, as today); (2) each
`doneWhen` criterion is shown with the child's claimed evidence **and** the core's independent evidence where one exists
(L10: verifier result for coding criteria, card states, artifact hashes); (3) the coordinator accepts (`completed`),
returns with instruction (`running`), or rejects (`failed`). An agent coordinator's acceptance of a coding child is never
sufficient for merge (§6.6). The child's self-report is never evidence on its own (L10).

## 10. Budget

### 10.1 What a budget can measure

The owner asked what "budget" means for subscription accounts (Codex, ChatGPT or Claude plans, cloud subscriptions),
where no cost per call can be measured. A subproject budget therefore has exactly three dimensions, all measurable on
every account:

| Dimension | Unit | Measured by | Meaning on a subscription account |
|---|---|---|---|
| **Tokens** | input + output tokens per model call (provider usage figures, else the core's estimate) | M2 usage ledger | measured as on metered accounts |
| **Turns / requests** | model calls of the subproject's agents | collab runner, M2 ledger count | measured; the natural unit where a plan has request or message quotas |
| **Wall time** | running time of the subproject (paused time excluded) | collab state log | measured |

**No USD dimension** (owner decision 2026-10-19). A dollar figure would need a maintained price table per provider and
model (input, output, cache, reasoning prices), it would be wrong for subscription accounts, and it would still miss
whatever a provider does not report. Subprojects therefore neither show nor limit money. Tokens already include the
reasoning tokens wherever the provider's usage figures report them; where a provider reports none, the core's estimate
counts only the visible text. The M2 budget store keeps its own `costMicros` scope for other uses; the subproject surface
never reads or writes it.

Rules (decided 2026-10-19, Q9): every project — root and subproject — has a budget in the three measurable dimensions,
with these **defaults**:

| Dimension | Default | Setting it |
|---|---|---|
| Tokens | **unlimited** | a number or `unlimited` |
| Turns / requests | **150** | a number or `unlimited` |
| Wall time | **36 h** (`wallMs` 129 600 000) | a duration or `unlimited` |

- The user can change the defaults installation-wide (config key `collab.subprojects.budgetDefaults`, `x-restart: live`,
  `x-tier: advanced`) and per project (`project.subproject.budget.set`, §10.2), and per project **every** dimension may be set to `unlimited`, including all three
  at once. A child created without explicit values gets the defaults.
- A dimension with a finite value is a **hard limit**, checked against the project and all its ancestors (§10.2);
  `unlimited` means no limit at that level, the ancestors' limits still apply.
- Turns and tokens are **summed** across a parent and its children (§10.2 reservation). Wall time is **not** summed,
  because siblings run in parallel: a child's wall-time ceiling is at most the parent's remaining wall time.
- A child's default is **clamped** to what the parent has left in each dimension (a default never fails a start; an
  explicit value beyond the parent's remainder is refused, §10.2).
- Tokens use the existing M2 budget scopes; turns and wall time are enforced by the collab runner (as the existing
  `maxTurns` and `timeoutMs` guardrails are), so no budget-store schema change is needed.

### 10.2 Allocation, admission and return

- **Allocation:** `project.subproject.budget.set { projectId, tokens?, turns?, wallMs? }`. The allocation is a
  ceiling on the child id **and** a reservation against the parent's remaining budget in each dimension that is set:
  `sum(children allocations) + parent own usage ≤ parent ceiling`. Creating or topping up beyond the parent's remaining budget is refused (`E_CONFLICT`, reason
  `allocation-exceeds-parent`).
- **Admission:** every model call inside a child runs `checkBeforeCall` with the child as `project` and the M2 hierarchy
  extended by the ancestor chain: all matching limits apply, the tightest wins (budgets.md: agent, project, user, global →
  plus ancestor projects). A refusal is a normal `token-budget` guardrail refusal (or the runner's turn or wall-time limit) plus a `blocker` report.
- **Hard limit:** an exhausted allocation pauses the child at the next turn boundary (state `paused`, reason
  `budget`), never kills a running provider call mid-stream (partial output is kept as today).
- **Top-up / cut:** top-up within the parent's remaining budget; a cut cannot go below used + in-flight reservations.
- **Return of unused funds:** on `completed`, `cancelled`, `failed` the unused part of the allocation is released back to
  the parent (the reservation shrinks to actual usage); audited.
- **Visibility:** a child sees only its own allocation and usage, never the parent's remaining budget or a sibling's
  figures.

## 11. Data model, RPC, events, UI, CLI

### 11.1 Store (collab migration v5, additive)

```sql
ALTER TABLE projects ADD COLUMN parent_id TEXT REFERENCES projects(id);
ALTER TABLE projects ADD COLUMN root_id TEXT;            -- = id for roots (backfilled)
ALTER TABLE projects ADD COLUMN depth INTEGER NOT NULL DEFAULT 0;
ALTER TABLE projects ADD COLUMN origin_card_id TEXT;
ALTER TABLE projects ADD COLUMN state TEXT NOT NULL DEFAULT 'running';  -- roots stay 'running'
ALTER TABLE projects ADD COLUMN override TEXT;           -- sparse JSON, narrowing only
ALTER TABLE projects ADD COLUMN coordinator TEXT;        -- JSON {kind,id} or NULL
ALTER TABLE projects ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;
ALTER TABLE projects ADD COLUMN subproject_settings TEXT; -- root only: JSON {childrenMayCreate, mergeMode}
CREATE INDEX idx_projects_parent ON projects(parent_id, archived_at);
CREATE INDEX idx_projects_root ON projects(root_id);
CREATE TABLE project_repos (project_id TEXT PRIMARY KEY REFERENCES projects(id), repo_path TEXT NOT NULL,
  base_branch TEXT NOT NULL, branch TEXT NOT NULL, worktree TEXT NOT NULL, base_sha TEXT NOT NULL, state TEXT NOT NULL,
  author_name TEXT, author_email TEXT, remote TEXT);
CREATE TABLE subproject_merges (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
  tree_hash TEXT NOT NULL, parent_head TEXT NOT NULL, mode TEXT NOT NULL, approved_by TEXT, merge_sha TEXT,
  pr_number INTEGER, reverted_by_sha TEXT, state TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE subproject_reports (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
  kind TEXT NOT NULL, body TEXT NOT NULL CHECK(json_valid(body)), taint TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE subproject_state_log (project_id TEXT NOT NULL, at INTEGER NOT NULL, actor TEXT NOT NULL,
  from_state TEXT NOT NULL, to_state TEXT NOT NULL, reason TEXT NOT NULL);
ALTER TABLE traces ADD COLUMN link TEXT;                  -- JSON {traceId,spanId,kind:"subproject"} for child roots
```

Existing projects become roots (`root_id = id`, `depth = 0`). `Project` in `types.ts` gains optional `parentId`, `rootId`,
`depth`, `originCardId`, `state`, `coordinator`, `priority`, `override`; existing readers are unaffected.

### 11.2 RPC (additive, `x-stability: "experimental"`, `x-server: "core"`, `x-since` the release that ships it, closed params)

| Method | Coarse action | Object check |
|---|---|---|
| `project.subproject.create` (`preview` / commit) | `project.surface.write` | coordinator or lead of the parent; for a grandchild also the child's coordinator or lead agent when `childrenMayCreate` (else with root approval); depth ceiling |
| `project.subproject.list` | `project.surface.read` | caller sees the node; returns direct children only |
| `project.tree.get` | `project.surface.read` | returns the subtree **below** the caller's highest visible node; never ancestors' siblings |
| `project.subproject.get` | `project.surface.read` | ancestor visibility or own membership |
| `project.subproject.control` (`start`/`pause`/`resume`/`cancel`/`reprioritise`/`swap-agent`) | `project.surface.write` | coordinator or ancestor lead |
| `project.subproject.budget.set` | `project.surface.write` | coordinator or ancestor lead; parent remaining |
| `project.subproject.instruct` / `.forward` | `project.surface.write` | coordinator of the parent |
| `project.subproject.report.list` | `project.surface.read` | ancestors of the reporting node only |
| `project.subproject.report.send` | `project.surface.write` | member/agent of the reporting node (agents via the tool) |
| `project.subproject.merge` (`preview` / `propose` / `confirm` / `commit`) | `project.surface.write` | coordinator or ancestor lead; D98 gate and review state; `commit` needs a valid confirmation or `mergeMode = auto` |
| `project.subproject.merge.revert` | `project.surface.write` | person with merge rights on the target node |
| `project.subproject.settings.set` (`childrenMayCreate`, `mergeMode`) | `project.surface.write` | lead of the root project; human-only |
| `project.coordinator.set` | `project.surface.write` | lead of the node or an ancestor |
| `project.repo.bind` / `.unbind` (incl. commit identity, remote, GitHub credential profile name) | `project.surface.write` | lead of a root project; human-only |

Existing methods (`project.get/list`, `project.card.*`, `project.column.*`, `collab.trace.*`, `collab.session.replay`,
`task.complete`) gain the hierarchy visibility predicate (§13.1) in their object check; their params and results stay
unchanged except optional new `Project` fields. `project.list` keeps returning only what the caller sees; children appear
with `parentId` so clients can nest them.

### 11.3 Events (additive to `COLLAB_EVENT_TYPES`)

`subproject.created`, `subproject.state.changed`, `subproject.report`, `subproject.budget.changed`,
`subproject.merged`, `project.coordinator.changed`. **Audience** = members of the node and of all its ancestors, rechecked
per recipient against stored membership (as board events today); never members of siblings, never child members for
events of the parent. Existing `project.card.changed` events of a child reach ancestors' subscribers too.

### 11.4 Web UI (`#/projects`)

- **Board:** origin cards with a subproject badge (§9.2), a "Make subproject" action in the card drawer (preview dialog
  with inherited settings, narrowing override, allocation, members/agents, branch name).
- **Drilldown:** `#/projects/<childId>` opens the child board; **breadcrumb** `Root › Child › Grandchild` for viewers who
  see the ancestors; a child-only member sees `Parent project › Child` with the parent as a non-link label.
- **Coordinator view** (tab "Subprojects" on every node with children): table of children with state, traffic light,
  progress, cost/allocation, last report, blockers, actions (pause, resume, cancel, budget, instruct, forward, merge
  preview, merge proposal with a **Merge** confirm button, revert); report feed with filters; inbox of open questions and
  pending merge confirmations.
- **Project settings (root):** "Children may create subprojects" (default on) and "Merge: confirm each merge | auto-merge
  on green gate and review" (default confirm), both lead-only.
- **Child view:** an "Upwards" panel with the child's own sent reports, the coordinator's instructions and forwarded
  items; no sibling list, no tree beyond its own descendants.
- DE/EN, keyboard operable, no inline styles (`styles.test.ts`), handoff/report bodies escaped (as `handoff-card.ts`).

### 11.5 CLI (all `[experimental]`, global `--json`, schema ids `project.subproject.*/1`)

```sh
plur1bus project sub create <project-id> --from-card <card-id> [--name …] [--tokens N] [--preview]
plur1bus project sub list <project-id>
plur1bus project tree <project-id>
plur1bus project sub show <sub-id>
plur1bus project sub start|pause|resume|cancel <sub-id>
plur1bus project sub priority <sub-id> <n>
plur1bus project sub budget <sub-id> --tokens N [--cost-micros N]
plur1bus project sub instruct <sub-id> "<text>"
plur1bus project sub forward <from-sub-id> <to-sub-id> --artifact <id>
plur1bus project sub reports <sub-id> [--kind blocker]
plur1bus project sub merge <sub-id> --preview | --propose | --confirm | --revert <merge-sha>
plur1bus project settings <project-id> [--children-may-create on|off] [--merge-mode confirm|auto]
plur1bus project coordinator set <project-id> agent <agent-id> | person <user-id>
plur1bus project repo bind <project-id> <repo-path> --base main
```

## 12. Federation: subproject as share and mission unit (built in Track F WP14)

Track F shares **one project** (F-R7, WP4) and binds a loaned agent's mission to **exactly one borrower project the lender
does not see** (federation spec Q14, decided; WP12). A subproject is the natural unit for both, because sibling isolation
already guarantees that a guest or mission agent inside it sees nothing lateral and the parent coordinator stays on the
home instance.

**Where it is built.** The federation side is a concrete work package, **Track F WP14 "Subproject as share and mission
unit"** in the [federation plan](../plans/2026-10-19-federation-cluster.md): sharing exactly one subproject with a peer,
binding a b2 mission to one subproject, isolation and visibility as in this spec, its own tests. It is not built in this
track only because Track F's pairing, peer principal, transport and share records (WP2–WP4) do not exist yet;
WP14's precondition is this track. This track delivers the pieces WP14 consumes:

- `SubprojectRef { rootId, projectId, depth, parentId }` — what a share or a mission binds to.
- `visibleFrom(principal, projectId) → "self" | "ancestor" | "none"` — the single isolation predicate (§13.1) that the
  federation peer principal (`peer:<id>`) will also go through; a peer bound to a subproject is evaluated like a child
  member/agent of that node.
- The **report channel** as the only upward path for a guest or mission agent (`plur1bus.report/1`, tainted on arrival).
- The **allocation** as the hard cap for borrower-side mission spend inside the subproject (F §8.3 keeps "each instance
  pays for its own calls").
- Mission end ↔ subproject terminal state: Track F may end a loan when the bound subproject reaches `completed`,
  `cancelled` or `archived`; mission memories correspond to the subproject pool entries authored by the mission agent.

Constraints WP14 must keep: a peer bound to a subproject never gets coordinator rights on that node's parent; a share of
a root project is a share of the whole tree only if the owner says so explicitly (default: root share without descendants).

## 13. Security

### 13.1 Isolation enforcement (all channels)

One predicate, `visibleFrom(principal, projectId)`, implemented in `collab/` and used by every object check:
`ancestor` if the principal is a member/lead/assigned agent of any **strict ancestor** (or Owner/Admin role-level read);
`self` if a member/assigned agent of the node itself; otherwise `none`. `none` → `E_NOT_FOUND` (no existence oracle).
Channels and their enforcement:

| Channel | Enforcement |
|---|---|
| Board, cards, comments, activity | board store object check uses `visibleFrom`; agents additionally need `AgentScope.projectId` = node |
| Traces, replay, export | trace lookup by `traceId` checks the trace's project with `visibleFrom`; `link` to a parent span is shown only to ancestors |
| Reports | `report.list` only for `ancestor`; `report.send` only for `self` and only to the direct parent |
| Events | audience computed per recipient (§11.3) |
| consult/delegate | `project-boundary` guard: both agents must be assigned to the **same node**; `allowCrossProject` forced false in a tree; new guardrail reason `sibling-boundary` for an attempt that targets an agent only assigned to a sibling (audited separately) |
| Memory | `AgentScope` carries `projectId`; the memory port maps a child run to pool `project:<childId>` and refuses other pools; agent-private capture off for subproject runs |
| Files | D109 roots = own worktree; sibling and parent worktrees on the deny-list (§6.4) |
| Artifacts | `ArtifactPort.get` checks the artifact's project with `visibleFrom` |
| Hand-off forging | `verifyHandoffAuthority` already binds `task.project`; a contract naming another node is `handoff-binding` refused |
| Budget status | child sees own allocation only |
| Tools / WebMCP | coordinator tools exist only in a coordinator's turn; WebMCP blocks `project.subproject.` and `project.coordinator.` and `project.repo.` prefixes (control structure stays human/agent-tool, not browser-agent) |
| Hierarchy depth | new guardrail reason `hierarchy-depth` for create beyond the ceiling |
| Merge | only through the provisioner, bound to `approvedTreeHash` and the confirmed parent HEAD; agent coordinators need a confirmation record unless `mergeMode = auto` (§6.7) |

### 13.2 No privilege escalation through the hierarchy

Narrowing is checked at write (override) **and** recomputed at use (§4.1). Approvals reach a child only through
`approvalsHeld` (delegable, task-bound). An agent coordinator cannot grant a child more than the coordinator's principal
has; it cannot make itself lead; it cannot change repo binding, depth ceiling, `childrenMayCreate`, `merge.mode` or global
keys. A child agent can never call coordinator tools on its parent or siblings; a child's coordinator tools reach only its
own descendants.

### 13.3 Taint and prompt injection

Reports, returns, forwarded items and child artifacts arrive in the parent **as untrusted data**: rendered as
`tool_result` blocks with provenance for an agent coordinator (never system/assistant text), escaped in the UI, length-
capped by the closed schema, and marked `taint: subproject:<id>`. A coordinator turn that reads them is **tainted** in
D109 (approvals.md §3.5): standing grants for private-data reads are suspended in that turn and effectful coordinator
actions fall back to `ask`. `suggestedNext` and `question.options` are advisory; nothing in a report is executed or
turned into a tool call by the core. The taint producer is an open D109 follow-up and therefore a prerequisite (§14).

### 13.4 Audit

Audit chain events for: subproject created/started/state changed, coordinator set, override changed, allocation set/
returned, instruct/forward (with full source provenance), report received (hash), merge preview/proposal/confirmation/
commit (tree hash, sha, confirming principal and surface or `auto`), push and pull-request merge, revert, settings change
(`childrenMayCreate`, `merge.mode`), worktree fork/remove, every isolation refusal (`sibling-boundary`, `hierarchy-depth`, `none` lookups by agents).

### 13.5 Residual risks

- A **person** who is a member of two siblings sees both through their own membership; isolation is between subproject
  contexts and their agents, not between a human and themselves. The UI never links siblings to each other.
- Timing and cost side channels between siblings through shared models or the parent's budget are not eliminated;
  children do not see each other's figures.
- A cooperative-only boundary: an external coding agent (M6 tier with its own process) is constrained by the sandbox and
  the bound checkout; its own network is governed by the existing M6/egress rules.

## 14. Prerequisites

| # | Prerequisite | Needed for | Owner workstream | Status on `main` @ `f7fc17c6` |
|---|---|---|---|---|
| R1 | M5 P1–P5 (D104, tools, trace/replay, D98 gate, promotion) | everything | M5 | merged (#510, #514, #515, #516, #520) |
| R2 | M3 web transport and process-wide `AgentScope` carrying `projectId` | UI, isolation in turns | M3 | transport #468 open; collab ALS adapter exists |
| R3 | M2 budget turn-loop hook (`checkBeforeCall` with project) | §10 admission | M2 | library done, hook item 1 in budgets.md open |
| R4 | Workspace/project memory pool materialisation | §5.3, S10 | M5 follow-up + engine (D31 shared memory) | not built (milestones §M5 status) |
| R5 | D109 taint producer | §13.3 | D109 follow-ups | open |
| R6 | Worktree provisioning agreed with M6 (`ProjectWorktreeProvisioner`) | §6 | M6 + this track | only `root()` exists |
| R7 | Event audience reauthorisation per recipient | §11.3 | M6 (events) | exists for board events |
| R8 | GitHub integration: per-repository credential profile in the M2 secret store, GitHub REST through egress to `api.github.com` | §6.7 root → base push, pull request, merge, revert | M2 secrets + this track (plan WP4b) | not built |

R1 is met; R2–R3 gate the live end-to-end; R4 gates S10 (until then: subproject runs are **stateless**, no capture at all,
recorded as KNOWN GAP); R5 gates the security acceptance; R6 gates the repo part (projects without repo work without it);
R8 gates only root → base on GitHub (local merges work without it).

## 15. Testability

- **Isolation suite** ("siblings see nothing"): a fixture tree root → A, B (→ A1) with distinct markers per node;
  every channel of §13.1 is probed from A's agent, A's child-only member, A's coordinator and A1, asserting B's markers are
  absent and lookups answer `E_NOT_FOUND`; plus the positive matrix from the root (sees all) and the negative upwards
  (A sees nothing of root's board).
- Inheritance property tests: random parent settings × random overrides → effective never wider; later parent narrowing
  reaches running children.
- Budget: allocation sum bound, ancestor admission, return of unused funds, cut below usage refused.
- Worktree: fork from a moving parent, conflict preview, gate-bound tree hash on merge, sandbox refusal of sibling paths
  through `..`, symlink and absolute paths, cleanup and retention.
- Reports: schema closure, core-computed progress/cost override agent values, rate limit, taint flag on the coordinator
  turn.
- Merge execution (Q8): `confirm` mode — an agent coordinator's commit without confirmation refused with
  `E_APPROVAL_REQUIRED`, a confirmation voided by a new child commit or a moved parent HEAD, one-click/command
  confirmation produces exactly one merge commit with the trailers; `auto` mode — merges only with gate green **and**
  review passed, refuses on either red; root → base against a fake GitHub API (push fast-forward only, pull request,
  merge only with green required checks, `checks-red` otherwise); revert creates a new commit and moves the child back
  to `completed`; no force push and no history rewrite in any path (argv recorder); the GitHub credential never appears
  in logs, audit or tool results.
- Grandchildren (Q3): with `childrenMayCreate` on, a child's coordinator and lead agent create a grandchild (agent via
  D109) and the root sees it; with it off, creation waits for the root coordinator's approval; a grandchild can never
  create; a grandchild's settings, rights and budget are never wider than its child's.
- Coordinator default (Q4): a project owned by an agent persona has that persona as coordinator without assignment, and
  its effectful actions go through D109 like any agent's.
- Real SQLite stores, real D109 evaluator and approval store, fake engine and provider (as M5 tests), Chromium DE/EN
  for the UI; no live models.

## 16. Owner questions

Q1–Q10 were answered by the owner on 2026-10-19 (**D115**); the answers are worked into the sections named. Q9 was
reformulated after the owner's question what a budget means for subscription accounts and then decided the same day.

1. **Q1 — Placement and release.** *Status: entschieden 2026-10-19.* Outside the v0.1.0 total, but firmly scheduled and
   to be built soon: the next track directly after the M5 base, before Track F (`docs/milestones.md` §2, §M5+). Track F
   reuses it as share and mission unit (WP14). Recommended was: track "M5+ Subprojects" after the M5 base and before
   Track F, outside the v0.1.0 total; alternatives were inside v0.1.0 or together with Track F in Beta 2.
2. **Q2 — Maximum depth.** *Status: entschieden 2026-10-19.* Depth 2 (root → child → grandchild), configurable downwards
   (S2). Recommended was the same; alternatives were 1 level only or unbounded.
3. **Q3 — May children create grandchildren?** *Status: entschieden 2026-10-19.* Yes: children create grandchildren
   themselves, because they know their own need and the detour via the coordinator is saved. Switchable per project
   (`subprojects.childrenMayCreate`, default `true`; alternative `false` = only with the root coordinator's approval).
   The limits stay: depth 2, rights and budget only narrower, grandchildren supervised by the child, the root sees
   everything (§5.2, §7.1, §7.2). Recommended was: only the child's coordinator, and only with an approval of the root
   coordinator or a root lead.
4. **Q4 — Default coordinator.** *Status: entschieden 2026-10-19.* The coordinator is by default the project owner,
   whether a person or an agent persona (in PLUR1BUS a project owner is an identity/persona, e.g. "Bernd"); another
   identity only by assignment. When the coordinator is an agent, its actions go through D109 (approvals and policy as
   usual) (S5, §7.1). Recommended was: the project owner as a person, an agent coordinator only by explicit assignment.
5. **Q5 — Sibling communication.** *Status: entschieden 2026-10-19.* Siblings communicate only through forwarding by the
   coordinator; no direct channel (S8, §8.4). Recommended was the same.
6. **Q6 — Raising memories to the parent.** *Status: entschieden 2026-10-19.* Explicitly per entry; at completion the
   coordinator gets a pre-selected list to confirm (S10, §8.4). Recommended was the same; the alternative was automatic
   proposals for all child pool entries.
7. **Q7 — Agent-private memory inside a subproject.** *Status: entschieden 2026-10-19.* No agent-private memories in
   children and grandchildren, neither recall nor capture: they are spontaneously spawned agents, not fixed personas
   (S10, §5.3). Recommended was the same; the alternative was read-only recall of the agent's private memory.
8. **Q8 — Merging subproject branches.** *Status: entschieden 2026-10-19.* The bot proposes the merge, a person confirms
   by click or command, and **PLUR1BUS executes the merge itself** (no manual commit or merge on GitHub). Per project
   switchable to **auto-merge**: the coordinator merges by itself when the D98 gate is green and the review (verifier and
   agent review) passed. Default: proposal + confirmation. Merge commit, no squash (§6.6, §6.7, R8). Recommended was:
   always a human decision in v1; merge commit.
9. **Q9 — Budget for subprojects: optional, and in which unit?** *Status: entschieden 2026-10-19.* **Decision:** every project has
   a budget with defaults tokens **unlimited**, turns **150**, wall time **36 h**; the user can change the defaults and,
   per project, set any or all dimensions to unlimited; finite values are hard limits checked against all ancestors; there is
   **no USD dimension at all**, neither shown nor limited, because it would need a maintained price table and is wrong
   for subscription accounts (§10.1). Background: with
   subscription accounts (e.g. Codex, ChatGPT or Claude plans, cloud subscriptions) no cost per call can be measured, so
   a USD budget means nothing there. §10.1 lists what can be measured on every account: tokens, turns/requests and wall
   time; USD only where a price list is known. **Recommendation:** a budget is optional per subproject; if set, it is
   given in turns, tokens and/or wall time and enforced as a hard limit (checked against all ancestors); USD is shown
   only as information where a price list exists and is never a limit for subscription accounts. Alternatives: (a) an
   allocation is mandatory before every start (the earlier recommendation), in turns, tokens or time; (b) no subproject
   budget at all, only the ancestors' limits and the guardrails `maxTurns` and `timeoutMs`.
10. **Q10 — Shared agents across siblings.** *Status: entschieden 2026-10-19.* The same agent may work in several
    siblings, with separate sessions (and pools) per sibling (§5.3). Recommended was the same; the alternative was
    exclusive agents per sibling.
