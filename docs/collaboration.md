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

## D104 hand-off contract (M5 phase 1, 2026-10-15)

Closed schemas live in `packages/core/src/collab/schemas/`: `plur1bus.handoff/1`,
`plur1bus.return/1` and the receiver's `plur1bus.ack/1`. `prepareHandoff` validates
both structure and the 2,000-token bound, returning issues to the **sender** for
at most one repair. The bound uses a UTF-8-byte upper bound for byte-level tokenizers, deliberately stricter
than an estimate when a model tokenizer is unavailable; it is not billed usage. Large content
belongs in artifact references. Contracts contain output schema and citation
requirements, model tier/deadline, scope and forbidden actions, and authority.

`HandoffContext` must come from the authenticated dispatcher, not model arguments.
`verifyHandoffAuthority` checks approval/grant references against the chain-backed
stores for person, originating agent, task, session (approval), expiry and
explicit delegation. A mismatch is an audited refusal, never a repair request.
This is validation, not a new grant: each receiver tool call must still pass D109
for action hash/path, capability scope and single use. Approval and grant stores
remain the only authorities; `decide()` and `begin()` signatures are unchanged.

`handoffTicket` snapshots a validated contract and requires a receiver ack before
`delegate` or `handoff` work. Blocked/wrong-reply acks do not unlock it. Start is
single use and checks authority again, including expiry/consumption since ack.
Consultations do not require an ack. `validateReturn` checks reply binding, size,
output schema and citations for completed results; `partial` is representable.
Board card descriptions and comments containing these JSON envelopes render as
DE/EN cards with an untrusted-data label; all peer strings are escaped text.

Phase 1 exposes these ports; phase 2 must bind them to the sole `delegate_task`
and normal dispatcher. No existing runner is silently opted into delegation.

## M5 agent tools (phase 2)

`composition/tools.ts` appends the six tools through `collaborationTools`, each
registered with the existing `agent.delegate` capability and dispatched by D109.
Live authenticated people and current stored project/agent membership are
required. `collaboration.fanoutEnabled` defaults to **false** (`live`, advanced);
explicit owner enablement is required after reviewing the phase-4 evaluation.
Board reads/posts remain usable independently of fan-out.

`delegate_task` is unique. M6 adapters implement `collab/target.ts`'s
`DelegationTarget` (`kind`, `accepts`, `ack`, `run`) and enter through
`CompositionOptions.delegationTargets`; targets do not own engine stores. The
local adapter and external adapters use the same contract/ticket and library
guardrails. M6 P2 had no PR at phase-2 start, so there was no PR on which to post
the port comment. No second worktree implementation is introduced here.

One tool composition is created per turn and retains the library trace, so
three total calls and two per pair are enforced across successive model calls.
Nested local targets have no tool view and cannot create a new root delegation.
The project M2 ledger is checked before each fan-out; provider calls separately
reserve/settle their actual usage. Local target memory and summaries are empty,
with no engine recall/capture path. Peer contracts and returns are explicit
untrusted `tool_result` envelopes. A successful `handoff` stops the sender loop.

Contract-driven calls race abort against the target and retain streamed progress.
Timeout/abort produces a `plur1bus.return/1` partial body; a supplied card receives
that body as a comment and the trace span has status `partial`. On a user abort
the ordinary dispatcher still returns its abort indication promptly; the durable
card/trace records retain the partial result. Legacy direct library calls retain
their existing error/abort behavior. Completed delegate reports remain explicitly
unverified until the phase-4 external gate.

## Replayable delegation sessions (M5 phase 3)

When composed with the existing SessionStore, every consult/delegate creates a
new `project` session before target execution. Its opaque owner is
`collab-project:<projectId>`; ordinary private-session APIs cannot claim it as the
caller's own chat. Span `sessionId` and transcript events bind it to the W3C
trace/span, sender, receiver, usage, redacted result and D104 contract/ack. Target
provider calls use the new session id. Partial results are retained too.

`collab.session.replay { traceId, spanId }` checks current project rights and the
persisted session/project binding on every read. It returns the same stored,
redacted messages/events without making a model call. Redaction runs before
persistence and again on read. Project UI renders a delegation tree, duration,
token counts, known monetary cost (unknown stays `?`) and a keyboard-usable
transcript link. Session shutdown follows collaboration shutdown so an in-flight
hop cannot write into a closed transcript store. Optional channel mirroring is
not enabled or implemented by this phase.

## D98 completion and L10 verifiers (M5 phase 4)

The `task.complete` agent tool is a D109 `shell.exec` operation and can complete
only the caller agent's assigned project card. It resolves the checkout through
`ProjectWorktreePort` (existing configured agent worktree by default; M6 can
supply the same port). It accepts no path, commands, pass flags or override note.
Four independently run checks must pass: format, lint, typecheck and tests.
Node/pnpm, Python, Rust, Go and Java/Gradle conventions are recognized; committed
`.plur1bus-verifiers.json` fixed argv arrays take precedence. Changing verifier
manifests/scripts during delegation is refused rather than trusting a new no-op.
Fallback standards ship in `skills/coding-standards` and
`skills/documentation-standards`; missing check executables fail closed.

Verifier subprocesses have a bounded lifetime/output and a minimal environment,
run without a shell in OS isolation, and cannot use the network unless the
committed project conventions explicitly allow it. macOS uses sandbox-exec;
Linux requires bubblewrap; unsupported isolation refuses. The tree is hashed
before and after checks (including untracked files); repository diff/textconv,
fsmonitor and hooks cannot execute during host-side fingerprinting. Diagnostics
returned to the model contain output hashes and exit statuses, not raw output.
Documentation gaps are listed.

At **200 or more changed lines**, `request_review` must produce an independent
pass tied to that exact worktree hash. The reviewer receives a read-only view of
the bound checkout, no private recall, and no write/exec tools. Later edits void
the pass. Completion rechecks project/card assignment and tree after verification.
The human-only `task.complete` RPC allows a project lead/Owner/Admin to override
with a bounded nonempty note; the note is audited before the card moves. The
agent tool cannot submit it. A lying delegate's self-report is never a gate input.

## Fan-out evaluation (2026-10-15)

`pnpm run eval:m5` replays 24 deterministic arithmetic fixtures through the real
provider/tool/budget composition. Each single/peer case has the same hard project
budget of 8,192 tokens. Both modes score 24/24; settled fixture usage is 576 vs
1,728 tokens in total, and 24 vs 72 routed model calls. Full inputs/results are
in `docs/evals/m5-fanout.json`; `--check` reproduces the artifact. This is a routing
and equal-budget regression, **not evidence of a live-model quality advantage**.
Fan-out remains off and still requires the owner's explicit enablement.

## D92 private chat promotion (M5 phase 5)

`chat.promote.preview` accepts an owned direct chat, a destination (new card,
new project or existing project link) and an optional explicit selection.
Omitting the selection means **no content**. A summary is written/approved by the
person; selected message ids must belong to that chat; full transcript copying
is explicit. System messages are excluded. Oversized content is refused rather
than silently clipped (64 KiB; full transcript maximum 10,000 messages).

The preview is private, held only in RAM for ten minutes and bound to the person,
source snapshot, exact destination and content choice. `chat.promote.commit`
accepts only its id, rechecks source ownership and current destination rights,
and refuses stale/expired previews. A retry of a completed commit is idempotent.
The source chat's owner, agent, kind, scope and messages are never changed. Links
are private metadata; source id/title are not automatically copied to a board.
Chosen content goes into a new board card. Incognito previews do not create a
durable private-content copy; copying after explicit confirmation is deliberate.
Durable model delegation from an incognito chat is refused until an explicit
promotion, so replay sessions cannot silently persist its context.

The chat menu provides DE/EN destination/content choices, a mandatory preview,
selection-change invalidation, native modal focus handling and confirmation.
M3 P1 (#493) is merged as a dependency. Production Web exposure still requires
the explicit API allowlist addition described in the phase-5 handoff; the owner
work package forbids this package from editing `packages/api/**` without an
exception. Core/RPC and mocked browser tests alone do not remove that release gate.

Final integration also pins handoff behavior/authority/return constraints across
sender repair, transfers card assignment on acknowledged ownership handoff, and
allows one sender-side repair of invalid/oversized returns in the same target
scope/session/budget pipeline. Peer return bodies remain untrusted data.
