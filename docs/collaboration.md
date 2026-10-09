# Collaboration (M5 core)

Library: `packages/core/src/collab`. Projects, consult, delegate, guardrails and traces live here as a **core library with ports**. RPC (`project.*` / `collab.*`), CLI and Web surfaces are documented below;
D92 “promote a chat to a project” remains a follow-up.

Authorities: [ADR-003](adr/ADR-003-agent-model-and-collaboration.md) (lifecycle, `AgentScope`, collaboration, Q4/Q5), [milestones.md §M5](milestones.md), [ADR-007](adr/ADR-007-users-roles-identity.md) (project roles `member`/`lead`, agent `use`/`manage`), [ADR-010 §4](adr/ADR-010-latency-and-caching.md) (subagent return ≈ 2 000 tokens).

## Model

A **project** is a container:

| Field | Meaning |
|---|---|
| `id` | Opaque id (`prj_…`) |
| `name` | Display name |
| `owner` | Harness user id; stored as project **lead** |
| `members` | `{ userId, role }` with `member` or `lead` (ADR-007 object rights) |
| `agents` | Agent ids assigned to the project |
| `settings` | Guardrail defaults (below) |
| `archivedAt` | Set on archive; **archive-first**, no hard-delete in this slice |

Workflow roles from ADR-003 (`worker` / `reviewer`), the task board, note board, per-agent git worktrees and the workspace memory pool are follow-ups.

## Consult vs delegate

| | Consult | Delegate |
|---|---|---|
| Shape | `consult({ fromAgent, toAgent, question, context, signal, traceId?, path? })` | `delegate({ fromAgent, toAgent, task, acceptanceCriteria, signal, traceId?, path? })` |
| Sync | Awaits the answer | Returns a task (`queued` → `running` → terminal) plus `done` |
| Callee context | Only `question` + `context`. Never the asker’s session history | Only the task contract |
| Result | Structured `consult.answer` with a provenance envelope (`agentId`, `projectId`, `traceId`, `spanId`, `at`, `cost`, `targetKind: "local"`) | Task with a **capped** body (default 2 000 tokens), a truncation **marker**, and a pointer `artifact:<id>` to the full body. Never silent clipping |
| Scope | Target runs inside its own `AgentScope` (fail-closed if missing) | Same |

Peer output is **data**, not instructions: the answer is a structured block with source, not system or assistant text. The callee’s `agent-private` / `user`-scope memory is never read by this library (the runner uses the session `ChatProvider` seam with empty `memory` / `summaries`).

All agent runs go through the deterministic `FakeChatProvider` from `packages/core/src/session/provider.ts` until a follow-up wires real adapters. No network, no live models.

## Guardrails (enforced in code)

| Guard | Default | Refusal |
|---|---|---|
| Depth | **1** (a consulted agent may not consult further) | `guardrail` / `depth` |
| Cycle / self-call | Blocked | `cycle` / `self-call` |
| Fan-out | 3 starts per chain | `fanout` |
| Per pair | 2 starts per `(from, to)` per chain | `pair-limit` |
| Time | 5 minutes from chain start | `timeout` |
| Token / cost budget | Optional per-project cap, checked **before** every hop via a budget port | `token-budget` / `cost-budget` |
| Repeat | Same from/to/question inside 30 s | `repeat` |
| Project boundary | Both agents must belong to the project unless `allowCrossProject` | `project-boundary` |
| Inactive target | Directory state must be `active` | `agent-inactive` |
| User abort | `AbortSignal` cancels the chain and every queued/running child task | `aborted` |

Turn cap (25) is stored on settings for the follow-up that counts provider turns.

## Rights

Every mutating call goes through an injected `authorize(principal, action, object)` port. The default port is `packages/core/src/rbac` `authorize` (read-only from collab).

| Operation | Action | Resource |
|---|---|---|
| Create project | `project.write` | `{ kind: "project", projectId }` of the new id (Owner/Admin `allow`; Member needs an object right they do not yet have → refused) |
| Read / list | `project.read` | the project |
| Add/remove agents | `project.write` | needs project `member` (or role `allow`) |
| Add/remove members, archive | `project.manage` | needs project `lead` |
| Consult / delegate | `project.write` **and** `agent.use` on **both** agents | Member sees only shared agents (`agent.use` object right). Viewer is refused even with planted object rights |

`project.create` is not in the RBAC table today; Owner/Admin succeed because `project.write` is `allow` for those roles. Wiring a dedicated `project.create` action is a follow-up.

## Trace format

Each chain gets a W3C `trace_id` (32 hex, not all-zero). `traceparent` is `00-{traceId}-{rootSpanId}-01`. Each hop is a span:

```
{ spanId, traceId, parentSpanId, agentId, kind: "consult"|"delegate"|"guardrail",
  startedAt, endedAt, status, inputTokens, outputTokens, costEstimate,
  inputPreview, outputPreview, error, guardrail }
```

Previews are truncated and passed through a **redaction port** (default: `logs` redactor with PII on) on `getTrace` / `listTraces` / `exportTrace`. Query: one chain by `traceId`, or every chain of a project. Export is JSON.

## Ports

| Port | Default in this slice | Follow-up |
|---|---|---|
| `AuthorizePort` | `rbac.authorize` | unchanged |
| `BudgetPort` | unlimited (project `tokenBudget`/`costBudget` still apply) | M2 `budget` service + per-project ledger |
| `ArtifactPort` | `node:sqlite` table | object store / session transcript |
| `RedactionPort` | `logs.createRedactor({ pii: true })` | shared audit redactor |
| `EventEmitter` | no-op | core event bus / RPC notifications |
| `AgentScopePort` | collab-local `AsyncLocalStorage` | M3 process-wide `AgentScope` |
| `AgentDirectoryPort` | every id is `active` | agent registry (pause/archive hides targets) |
| `ChatProvider` / runner | `FakeChatProvider` | session `TurnRunner` so every hop is a replayable session |

Store: `node:sqlite`, `PRAGMA user_version` migrations, archive-first. Path `:memory:` is supported for tests (no WAL).

## Defaults chosen for open owner questions

**ADR-003 Q4** (external coding agent store): **stateless**. Results land only in the caller-visible artifact + trace. No PLUR1BUS store of the callee’s own. Store opt-in waits for M6 / ADR-011. This slice only addresses **local** agents in a project (`targetKind: "local"`).

**ADR-003 Q5** (depth 1 vs two-level chain): **depth 1** as shipped default (Goose / ADR-003 table / M5 acceptance). `settings.maxDepth` is configurable so a two-hop chain can be enabled per project after an owner decision; the code already refuses the extra hop.

## Follow-ups

- Production Web API/principal binding; task/note board beyond the surfaces below
- D92 promote a direct chat to a card or project (chat stays private; content moves only by explicit choice)
- Wire M2 budget, audit log, D111 logs, session store (replayable hop sessions)
- ACP / A2A / external coding-agent targets (M6)
- Task board, note board, git worktrees, workspace pool, `post_to_project` / `read_project_board` / `request_review` / `handoff` (`plur1bus.handoff/1`)
- Fan-out eval (≥20 cases, equal token budget) before any fan-out **default-on**
- `project.create` RBAC action; identity resolver filling `projectRights` / `agentRights`
- Process-wide `AgentScope` (M3) replacing the collab-local ALS

## M5 RPC, CLI and Web surfaces

Core registers `project.create/get/list/update/archive`,
`project.member.add/remove/role`, `project.agent.add/remove`,
`collab.trace.get/list`, and `collab.chain.cancel`.
`project.update` renames an active project; it does not silently change guardrail
settings. The project library remains the authority for archive-first semantics,
member/lead management and chain cancellation. Membership rights are loaded from
persisted projects. A member cannot promote themselves to lead; the owner remains
lead. Assigning an agent additionally requires agent.use. Members/Viewers see
projects they belong to; Owner/Admin/Operator retain role-level project reads.
Surface RPCs are human-only; agent collaboration uses the existing internal ports.

```sh
plur1bus project create 'Research'
plur1bus project list
plur1bus project show <project-id>
plur1bus project member add <project-id> <user-id> --role member
plur1bus project member role <project-id> <user-id> lead
plur1bus project member remove <project-id> <user-id>
plur1bus project agent add <project-id> main
plur1bus project agent remove <project-id> main
plur1bus project archive <project-id>
plur1bus trace list <project-id>
plur1bus trace show <trace-id>
```

All support global `--json`. Projects (`#/projects`) provides list/detail,
membership and agent forms, archive confirmation, and chain cancellation. Traces
show parent-span relationships, timestamps, tokens, estimated cost/status and
existing-port-redacted previews. Null costs remain unknown. The composition root
opens the project store even without a chat provider; actual consult/delegate
execution then refuses no-provider, and never switches to a synthetic provider.
Existing composed runner/budget checks still handle configured collaboration.

D92 “promote chat to project” remains a follow-up: current session kind/project
association has no authorized mutation port, and this work package excludes new
session behavior. The existing `/rpc` Web transport still needs the API-layer
principal binding described in the media surface notes; browser mock tests are
local UI evidence only.
