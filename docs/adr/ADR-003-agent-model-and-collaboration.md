# ADR-003: Agent model, collaboration, group vs 1:1 behaviour

**Status:** Accepted (2026-09-22, with amendment D14) · **Date:** 2026-09-22 · **Deciders:** Christian (owner) · **Inputs:** `docs/phase0/brief.md` D2/D5/D8/D11/D14/D15; `docs/phase0/auftrag-original-2026-09-21.md` §2.1, §5, §7, §8, §13 Q4; `docs/phase0/research/hermes-learnings-and-import.md` A6, A8, A11, A12, "What our harness must explicitly NOT copy"; `docs/phase0/research/harness-engineering-state-of-the-art.md` §5, rules 13–14; `docs/phase0/research/plur1bus-host-contract.md` §8; `docs/phase0/research/plur1bus-crons-embedding-portability.md` §3; `docs/phase0/research/openclaw-layout-dreaming-ui.md` §1

## Context

The brief makes PLUR1BUS the core and derives identity from it: agent = PLUR1BUS `agentId`, project = PLUR1BUS workspace, human = one canonical principal (auftrag §2.1). ADR-003 has to turn that into a concrete agent record, a lifecycle, an isolation model, and a collaboration model, plus the group-vs-1:1 behaviour profiles that D8 adds to auftrag §5.

Forces from the research:

- **Isolation is the hard part, and partial isolation is worse than none if it is undocumented.** Hermes's gateway multiplexing leaves the built-in tool registry, MCP discovery/tool registration (upstream issue `#67605`), the `TERMINAL_*` sandbox env vars, and the HTTP listener/process lock process-global while presenting itself as profile isolation (`hermes-learnings-and-import.md` A11). Its own "NOT copy" list names this as the mistake to avoid (ibid., item 7). Hermes's mechanism for the isolation it *does* achieve is a context-local `HERMES_HOME` override (`hermes_constants.py:18-42`, `agent/memory_provider.py:21-33`, ibid. A6) whose documented failure mode is "a worker started with an empty context silently lands on the default profile".
- **Multi-agent work is expensive and only sometimes better.** Orchestrator–worker beat single-agent Opus 4 by 90.2% on breadth-first research, but multi-agent costs ≈15× a chat turn and token spend alone explains 80% of performance variance ([Anthropic, multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system), via `harness-engineering-state-of-the-art.md` §5). Fan-out must be budget-gated and benchmarked against a single agent given the same tokens (ibid., rule 14).
- **Concrete guardrail defaults exist.** Goose: subagents cannot spawn subagents; `GOOSE_SUBAGENT_MAX_TURNS` default 25, 5-minute timeout, timed-out subagents produce no output ([Goose subagents docs](https://goose-docs.ai/docs/guides/context-engineering/subagents/), via ibid. §5).
- **The anti-subagent objection is serious.** pi ships no subagent tool because spawning one is "a black box within a black box" with zero observability ([Zechner 2025-11-30](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/), via ibid. §5). The dossier's answer, which we adopt: every delegation is a real, replayable session in the engine.
- **Other agents' output is untrusted data.** Results must enter as `tool_result` with provenance, never as system or assistant text (ibid. §5; auftrag §7, §11).
- **The ACL model already exists and is strict.** Scopes `agent-private` (default) / `workspace` / `user`; `user` requires `userPrincipal` matching `/^user:v1:[a-f0-9]{64}$/` (`lib/acl-middleware.js:102-159`, via `plur1bus-crons-embedding-portability.md` §3). `/share` is copy-never-move and **re-embeds** (`lib/telegram-commands/memory-edit.js:508`, `lib/shared-memory.js:216-231`, ibid.). Peer kinds are a closed set `{direct, dm, group, channel}` (`lib/memory-request-context.js:24`, via `plur1bus-host-contract.md` §8) — the engine already distinguishes 1:1 from group, so D8's split has a native anchor.

## Decision

An **agent** is one record with four separable parts — engine identity, exactly one persona file, a runtime profile, and a pair of behaviour profiles — stored as a directory per agent, provisioned engine-first and torn down archive-first. Behaviour is resolved by a four-level, last-wins merge (`agent default → behaviour.{direct|group} → channel-kind override → bot-connection override`). Isolation is enforced by an `AgentScope` carried in `AsyncLocalStorage`, with every registry (tools, MCP clients, skills, secrets, terminal env) built as a *per-agent view over a global catalog* rather than as a global mutable registry — and with an explicit, published list of what remains process-global. Collaboration is modelled as **projects with peer agents**, not as hidden subagents: six tools (`consult_agent`, `delegate_task`, `post_to_project`, `read_project_board`, `request_review`, `handoff`), targets local / ACP-external (ADR-011) / A2A-remote (ADR-008), every call a budgeted, guard-railed, fully traced, replayable session whose result re-enters the caller as provenance-tagged `tool_result`.

### The persona file: `SOUL.md`, not `persona.md` — reversed by owner decision D14 (2026-09-22)

**This ADR originally recommended renaming the persona file to `persona.md`; the owner declined the rename on 2026-09-22 (A3, verbatim): "nein, es gibt ja auch persona-voice, etc. pp. es braucht ja auch eine Identity, User, etc."** The rename's own rationale (avoid reproducing Hermes product vocabulary) is still sound, but the proposed replacement name turned out to collide with a name PLUR1BUS **already uses for itself** — `persona-voice` and `persona-evolve` are existing engine/dreaming vocabulary (ADR-009's phase mapping), so naming the file `persona.md` would create exactly the kind of naming confusion the rename was meant to avoid, just with the harness's own product instead of Hermes's. The owner's own reasoning is adopted verbatim: keep `SOUL.md`.

The owner adds a second requirement in the same answer: the agent needs more than a persona file — it needs an **identity** and a **user** file too, mirroring OpenClaw's own `IDENTITY.md`/`USER.md` split (persona = who the agent is, identity = stable facts about the agent's own operating context, user = stable facts about the human(s) it serves). This ADR adopts OpenClaw's names as the default pending the action items below fixing them exactly (§"Action items").

**Resolution (D14):** One persona file per agent, at `agents/<agentId>/SOUL.md`, canonical name as originally specified (§5), lookup case-insensitive (`SOUL.md`, `soul.md`). Two further curated files join it: `IDENTITY.md` and `USER.md` (OpenClaw-style default names — final naming is an ADR-003 action item, not fixed here). All three travel together in the agent's curated-file set; only `SOUL.md` is the *persona* file proper, so "exactly one persona file per agent" (§5's original rule) still holds — identity and user are separate curated files, not additional personas.

1. `SOUL.md` is the name the original commission specifies (§5: "Genau eine Soul (`SOUL.md`) pro Agent"), and the owner's 2026-09-22 answer restores it as binding.
2. `persona` remains **engine** vocabulary for the *prompt block* (auftrag §2.2, K1's "Recall-, Temporal-, Mood-, Persona-, Reaktivierungsblöcke") — but the file that fills that block is `SOUL.md`, not a file sharing the block's own name, precisely to avoid the collision the owner flagged.
3. Case-insensitive lookup (`SOUL.md`/`soul.md`) still avoids the case-sensitivity class of bug flagged for the Windows port (`plur1bus-crons-embedding-portability.md` §4) and mirrors the dual-casing lookup OpenClaw needed for `DREAMS.md`/`dreams.md` (`extensions/memory-core/src/dreaming-dreams-file.ts:12` @ `b9421f4`, via `openclaw-layout-dreaming-ui.md` §1).
4. `persona.md` was this ADR's original recommendation. Reversed 2026-09-22: it collides with the harness's own `persona-voice`/`persona-evolve` vocabulary, which is the exact failure mode ("don't reuse a name someone else already means something by") that motivated moving away from `SOUL.md` in the first place.

Same persona on every channel the agent is reachable on (auftrag §5) — the behaviour profiles may overlay *tone*, never identity.

### Agent record — schema sketch

```
agents/<agentId>/
  agent.json          # the record below
  SOUL.md             # the one persona file (D14, 2026-09-22 — not renamed)
  IDENTITY.md          # agent identity (D14; default name, OpenClaw-style, see action items)
  USER.md               # user/owner facts (D14; default name, OpenClaw-style, see action items)
  behaviour/          # optional split-out overrides, merged into agent.json
  memory/
    DailyNote_<YYYY-MM-DD_HHMMSS>.md   # timestamped daily notes — light-sleep input (D15, ADR-009)
    memories.md                        # long-term memory — deep-sleep promotion target (D15, ADR-009)
    dreaming.md                        # dream diary (D15, ADR-009)
    knowledgepool.md                   # curated knowledge corpus (D15, ADR-009)
```

```ts
interface Agent {
  id: AgentId;                      // === PLUR1BUS agentId, through safeAgentId()
  displayName: string;
  persona: { file: "SOUL.md"; checksum: string };
  identity: { file: "IDENTITY.md"; checksum: string };   // D14, 2026-09-22
  user: { file: "USER.md"; checksum: string };           // D14, 2026-09-22
  owner: UserId; access: AgentAccess;          // use / manage — ADR-007
  engine: { kind: "native" | "external"; externalRef?: ExternalAgentId };  // ADR-011
  runtime: RuntimeProfile;
  behaviour: BehaviourSet;
  state: "active" | "paused" | "archived";
}

interface RuntimeProfile {
  model: { primary: ModelRef; fallbacks: ModelRef[]; auxiliary?: ModelRef };
  authProfile: AuthProfileRef;                        // ADR-005
  embedding: Record<StoreId, EmbeddingIdentity>;      // per agent AND per store — auftrag §5
  reranker: RerankerRef;                              // changeable at any time
  toolsets: ToolsetRef[]; skills: SkillRef[]; plugins: PluginRef[];
  mcp: { allowlist: McpServerRef[]; toolApproval: Record<string, ApprovalMode> };  // ADR-008
  a2a: { serverOptIn: boolean; clientAllowlist: RemoteAgentRef[] };
  channels: ChannelBindingRef[];                      // bot connections — auftrag §8
  workdir: { root: Path; terminalBackend: TerminalBackendRef };
  approvalPolicy: ApprovalPolicyRef;                  // conservative default — auftrag §11
  budget: { tokensPerDay: number; costPerDay: Money; perTurn: number };
  plur1bus: { featureProfile: "safe" | "recommended"; temperament: string; namespaces: string[] };
  schedules: ScheduleRef[];                           // ADR-009 owns dreaming
}
```

### Behaviour profiles — schema sketch and precedence

```ts
interface BehaviourSet {
  default: BehaviourLayer;                       // level 1
  direct: Partial<BehaviourLayer>;               // level 2a — peerKind ∈ {direct, dm}
  group:  Partial<BehaviourLayer>;               // level 2b — peerKind ∈ {group, channel}
  byChannelKind?: Record<ChannelKind, Partial<BehaviourLayer>>;      // level 3
  byBotConnection?: Record<BotConnectionId, Partial<BehaviourLayer>>; // level 4
}

interface BehaviourLayer {
  reply: { policy: "always" | "on-mention" | "on-question" | "keywords" | "never";
           keywords?: string[]; cooldownMs?: number; quietHours?: TimeWindow[] };
  tone: { overlay?: string; maxOverlayTokens: number };   // overlay only — never replaces persona
  memory: { capture: "off" | "provenance-only" | "full";
            allowedScopes: ("agent-private" | "workspace" | "user")[];
            requireLinkedPrincipalForUserScope: boolean;
            captureOtherSpeakers: boolean };
  rateLimits: { repliesPerHour: number; editsPerMinute: number; maxReplyChars: number };
  streaming: "off" | "edit" | "chunked";
  tools: { deny?: ToolRef[] };                            // may only narrow, never widen
}
```

**Precedence (last wins):** `behaviour.default` → `behaviour.direct | behaviour.group` (selected by the engine's `chatKind`/peer kind, `lib/memory-request-context.js:24`) → `byChannelKind[telegram|discord|matrix|buzz]` → `byBotConnection[<id>]`. Shallow-merge per top-level key, deep-merge the leaf objects; arrays replace. Two invariants: `tools.deny` is **union-only** across layers (a more specific layer can forbid, never permit), and `memory.allowedScopes` is **intersection-only**. This makes the merge monotonically restrictive, so a wrong override cannot widen a permission — the same "capability sets, not trust levels" rule the subagent literature recommends (`harness-engineering-state-of-the-art.md` §5).

**Shipped defaults.** `direct`: reply `always`, capture `full`, scopes all three, streaming `edit`. `group`: reply `on-mention`, capture `provenance-only`, scopes `{agent-private, workspace}`, `captureOtherSpeakers: false`, `requireLinkedPrincipalForUserScope: true`, lower rate limits. Justification for the group defaults: `user`-scope writes need a `userPrincipal` that only exists when channel + accountId + userId are all present (`lib/memory-request-context.js:302-304`, via `plur1bus-host-contract.md` §8), and in a group the other participants are third parties who never consented — writing them into a `user` pool would make a bystander's words durable under someone's principal. Group capture therefore records *that* something was discussed, with provenance, under `agent-private`, and promotion to `workspace` goes through the normal review queue.

### Lifecycle

| Step | Order | Notes |
|---|---|---|
| Create | **engine first**: store + vault folder + feature profile + crons (auftrag §2.1), then runtime profile, then channel bindings | One saga with a compensation per step and an idempotency key; on any failure roll back in reverse and leave nothing half-provisioned. Templates and clone supported (auftrag §5). |
| Pause | detach channel bindings → disable schedules → drain in-flight sessions (grace, then cancel) | Store stays readable; the agent disappears from `consult_agent`/`delegate_task` target lists. |
| Archive | pause, then mark `archived`; store archived, not deleted | Re-activation is a supported operation. |
| Delete | **archive-first**, then export offer, then confirmation, then purge | Identity-bound confirmation (user + chat + nonce, auftrag §11); destructive-op audit entry. |
| Export / Import | bundle = `agent.json` (secret *references* only) + `SOUL.md` + `IDENTITY.md` + `USER.md` + behaviour + skill/plugin pins + embedding identity per store + schedule definitions | **No secrets, ever.** Import re-resolves references and fails closed on anything unresolvable; embedding identity mismatch triggers the migration path, never a silent mixed vector space. |

### Isolation: what is per-agent and what is not

| Subsystem | Per-agent? | Mechanism |
|---|---|---|
| Config, persona, behaviour | Yes | one directory per agent (the Hermes A6 filesystem-isolation idea, without its 2,190-line profile manager) |
| Sessions, transcripts | Yes | keyed by agentId; sessions are the unit of replay |
| Memory store, pools | Yes | engine-native: `agentId` + `w-`/`u-` pool keys (`lib/memory-request-context.js:37-44`) |
| Secret scope | Yes | scope resolved from `AgentScope`; **unscoped access throws** (fail-closed, mirroring Hermes's own fail-closed bucket, A11) |
| **Tool registry** | **Yes — this is the Hermes gap we close** | one immutable global catalog; each agent gets a computed *view* (allowlist ∩ toolsets ∩ behaviour deny-union). No global mutable registry exists to leak. |
| **MCP clients** | **Yes** | one client set per agent from its allowlist (ADR-008); discovery results cached globally but *selection* is per agent |
| **Terminal env / backend** | **Yes** | child env is constructed from an allowlist plus the agent's own vars — `process.env` is never inherited wholesale |
| Budgets, rate limits, approval state | Yes | counters keyed by agentId |
| Embedding/rerank model cache | **No — shared by design** | D9 / auftrag §2.1: the service belongs to the core and is shared; isolation is by *embedding identity*, not by process |
| HTTP listener, process lock, OS process | **No** | single daemon; RBAC at the API boundary (ADR-007) is the control, not process separation |
| Native model runtime, native addons | **No** | one ONNX/LanceDB runtime per process |

`AgentScope` (`{agentId, paths, secretScope, budgetLedger, toolView}`) is carried in `AsyncLocalStorage` — the direct Node equivalent of Hermes's `ContextVar` (A6) — and **every worker/thread entry point must re-establish it or throw**. Hermes documents "a worker started with an empty context silently lands on the default profile" as a real failure mode; we make it a hard error. The right-hand column above is published in the admin UI and the docs verbatim: we do not claim isolation we do not have (Hermes "NOT copy" item 7).

### Collaboration

**Project** = one PLUR1BUS workspace (`workspace:v1:<key>`) plus: a directory with a **per-agent git worktree** (file locks only for non-git directories); a task board (task, assignee, status, dependencies); a shared note board; a workspace pool with explicit, ACL-bound, copy-never-move sharing; project roles **lead / worker / reviewer**; members (harness users *and* agents); a budget. Project roles are orthogonal to RBAC roles (ADR-007): RBAC decides who may open the project, project roles decide who may merge, approve or reassign inside it.

**Tools.** `consult_agent(target, question, context)` — synchronous, answer carries provenance. `delegate_task(target, contract)` — asynchronous, result report. `post_to_project`, `read_project_board`, `request_review`, `handoff`. `target` resolves to a local agent, an external ACP agent (ADR-011) or a remote A2A agent (ADR-008); the calling agent sees one uniform tool surface.

**Typed contract** (required for `delegate_task`, recommended for `consult_agent`): objective, scope, forbidden actions, output schema, citation requirement, token cap (default ≤ 2k for the returned artifact), model tier, deadline. This is `harness-engineering-state-of-the-art.md` rule 13, and it is what prevents the duplicated work that vague delegation produces (Anthropic multi-agent, ibid. §5).

**Guardrails** (all enforced in the harness, not suggested in a prompt):

| Guard | Default | Source |
|---|---|---|
| Consultation depth | 1 (a consulted agent may not consult further) | Goose's structural depth guard, ibid. §5 |
| Cycle / self-call | blocked; call graph checked per root turn | auftrag §7 |
| Calls per turn / per agent pair | 3 per turn, 2 per pair per turn | ours; tunable |
| Turn and time budget per delegation | 25 turns, 5 minutes | Goose defaults, ibid. §5 |
| Token/cost budget | checked **before** every call, against project and agent budgets | auftrag §7; ≈15× cost multiplier, ibid. §5 |
| User abort | always available, propagates to children | auftrag §7 |
| Partial success | representable — a timed-out delegation returns a partial result marked `interrupted`, never silence | Goose failure semantics, ibid. §5 |

**Security invariants.** Other agents' messages are **data, not instructions** — results enter the caller's context as `tool_result` with a provenance envelope `{agentId, sessionId, projectId, at, cost, target-kind}` and never as system or assistant text (auftrag §7, §11). The caller's permissions **do not transfer** to the callee; the callee runs under its own approval policy, its own toolset and its own budget. The triggering user's RBAC bounds the set of consultable agents (ADR-007). Private knowledge of the consulted agent and any `user`-scope memory never migrates automatically into the caller's store, the workspace pool, or a remote agent (auftrag §7) — the only automatic write is the provenance-tagged result card in the caller's own `agent-private` scope; anything beyond that goes through explicit `/share`, which is copy-never-move and re-embeds (`lib/shared-memory.js:216-231`, `memory-edit.js:508`).

**Observability.** Every consult and delegation is a first-class, replayable harness session with its own transcript — the concrete answer to pi's "black box within a black box" objection ([Zechner 2025-11-30](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/)). Two separate streams: a bounded summary for the model, the full trace for the human (Goose's return-mode split, ibid. §5). The UI shows who asked whom, with cost and result. Project communication can optionally be mirrored into a Buzz channel or Matrix room for humans to read along and intervene (auftrag §7).

### Answer to open question Q4 (bot-connection routing)

**Recommendation: support both, in this order — "one agent, many bot connections" is mandatory for M4; "one bot connection, many agents via mention/command routing" ships no earlier than M6, behind the transport/runtime identity split.** Q4's default ("support both, routing secondary") is confirmed, with a sequencing condition attached.

Reasoning: multiplexing one inbound connection across several agents is exactly where Hermes's isolation gaps bite — its own docs place unserved-route drops and unscoped secret access in the fail-closed bucket while leaving tool registry and terminal env process-global (A11). Routing is safe for us only *after* `AgentScope` and the per-agent registry views above are real and tested. When it ships, adopt Hermes's two-identity model verbatim as a concept: `transportIdentity` (the bot connection that received the event) and `runtimeAgent` (the agent that executes the turn), kept as separate fields so two agents sharing one chat keep separate session lanes (A11). Routing rules are most-specific-first with parent-chain fallback for threads (ibid.), and **deny by default**: an inbound event that matches no route is dropped and logged, never broadcast to every bound agent. Each bot connection declares exactly one default agent for unaddressed DMs; group chats with no default reply to nothing. Every reply carries the responding agent's persona (auftrag §8).

## Options considered

### Behaviour configuration

#### Option A: Flat agent config with per-channel overrides only
| Dimension | Assessment |
|---|---|
| Complexity | Low |
| Fit with brief D1–D11 | **Fails D8** — no first-class group/1:1 distinction |
| Cross-platform risk | None |
| Maintenance burden | Low |
| Latency / token cost | None |

**Pros:** smallest schema. **Cons:** the 1:1-vs-group distinction is the single most requested behaviour axis and would have to be re-encoded per channel, four times.

#### Option B: `behaviour.direct` / `behaviour.group` profiles with four-level monotonic merge (recommended)
| Dimension | Assessment |
|---|---|
| Complexity | Medium |
| Fit with brief D1–D11 | Direct implementation of D8; anchors on the engine's existing `{direct,dm,group,channel}` peer kinds |
| Cross-platform risk | None |
| Maintenance burden | Medium — one merge function, contract-tested |
| Latency / token cost | Negligible; resolution is a cached pure function of (agent, peerKind, channelKind, botConnection) |

**Pros:** expresses the actual requirement; restrictive-only merge makes misconfiguration safe; overrides stay declarative and diffable. **Cons:** four layers is one more than most users will ever need; needs a "show me the effective behaviour" UI view to stay debuggable.

#### Option C: Rule/expression policy engine
| Dimension | Assessment |
|---|---|
| Complexity | High |
| Fit with brief D1–D11 | Satisfies D8 but far beyond it |
| Cross-platform risk | None |
| Maintenance burden | High — a DSL is a permanent product surface |
| Latency / token cost | Evaluation per inbound event |

**Pros:** arbitrary expressiveness. **Cons:** unbounded scope, hard to audit ("why did the bot reply?"), and no evidence in the brief that anyone needs it. Revisit only if real deployments hit the four-layer ceiling.

### Collaboration topology

#### Option A: In-process subagents only (Hermes-style handles)
| Dimension | Assessment |
|---|---|
| Complexity | Low–Medium |
| Fit with brief D1–D11 | **Fails auftrag §7** — no ACP/A2A targets, no project board, no cross-user RBAC |
| Cross-platform risk | Low |
| Maintenance burden | Low |
| Latency / token cost | Lowest |

**Pros:** cheapest. **Cons:** Hermes's own subagent results live in-process for ~1 hour and are lost on restart (A8) — incompatible with "every delegation is a replayable session", and it cannot express external or remote targets.

#### Option B: Peer agents in projects, uniform tool surface over local/ACP/A2A targets (recommended)
| Dimension | Assessment |
|---|---|
| Complexity | High |
| Fit with brief D1–D11 | Full fit with auftrag §7, D5 and M5/M6 acceptance |
| Cross-platform risk | Medium — git worktrees and terminal backends per platform |
| Maintenance burden | Medium–High, but the surface is six tools and one guardrail module |
| Latency / token cost | ≈15× a chat turn when fanned out — hence the mandatory budget gate |

**Pros:** one tool surface for three target kinds; durable, replayable sessions; guardrails and RBAC in one place. **Cons:** the expensive option; needs the budget gate and a benchmark against single-agent-same-tokens before any fan-out default is turned on (rule 14).

#### Option C: External orchestrator process
| Dimension | Assessment |
|---|---|
| Complexity | High |
| Fit with brief D1–D11 | Conflicts with D1 (single monorepo, one daemon) |
| Cross-platform risk | High — a second supervised process on five targets |
| Maintenance burden | High |
| Latency / token cost | Extra IPC hop per call |

**Pros:** hard process isolation between orchestration and execution. **Cons:** a second daemon to install, supervise and upgrade on all five targets for a benefit RBAC already provides.

## Trade-off analysis

The decisive trade is **isolation completeness vs. shipping speed**. A single daemon with per-agent *views* gives most of the practical isolation (config, sessions, secrets, tools, MCP, terminal env, budgets) at a fraction of the cost of process-per-agent, and the residue (HTTP listener, native runtimes, shared embedding service) is either mandated by D9/§2.1 or governed by RBAC. The failure mode we must not repeat is Hermes's: shipping partial isolation described as full isolation. Publishing the table above is cheap and converts a latent security surprise into a documented property.

The second trade is **expressiveness vs. auditability** in behaviour. The monotonic-merge rule (deny-union, scope-intersection) buys safety at the price of not being able to grant a capability in a narrow context. That is the right direction for a multi-user system: to widen, edit the agent default, which is visible and audited.

The third trade is **collaboration power vs. cost**. The 15× multiplier and the 80%-of-variance-is-tokens finding mean that a default-on fan-out would be an expensive way to buy little. Peer collaboration therefore ships opt-in, budget-gated, and with an eval harness that compares it to one agent with the same budget.

## Consequences

- **Easier:** one agent record to back up, export, import or delete; group chats stop polluting user memory by construction; a consulted agent's reply is auditable and replayable; adding an external or remote target is a new `target` kind, not a new tool; the "effective behaviour" question has one answer, computable.
- **Harder:** every new subsystem must declare whether it is per-agent or global and prove it under an `AgentScope` test; the merge function needs its own contract tests (four layers × two peer kinds × four channel kinds); per-agent git worktrees add disk and cleanup work; the budget gate must be right before any fan-out is enabled, or the first real project will be a surprise invoice.
- **Revisit when:** bot-connection routing is actually requested by a deployment (re-open Q4 sequencing); or the four-layer behaviour merge proves insufficient (then Option C); or a measured eval shows peer collaboration does not beat a single agent at equal token budget (then narrow it to review/handoff only).

## Conflicts with the brief

**Finding:** auftrag §5 mandates "Genau eine Soul (`SOUL.md`) pro Agent". `brief.md` D8 expands §5's agent settings but does not touch the file name, so §5 remains binding.
**Source:** `docs/phase0/auftrag-original-2026-09-21.md` §5 vs. `docs/phase0/research/hermes-learnings-and-import.md`, "What our harness must explicitly NOT copy", item 10 ("Do not reproduce Hermes's exact naming vocabulary — `SOUL.md`, `MEMORY.md`, `USER.md`, `HERMES_HOME` … these are Nous Research/Hermes-specific product identity").
**Options:** (a) keep `SOUL.md` as specified; (b) rename to `persona.md`, keeping "exactly one file per agent"; (c) keep `SOUL.md` on disk but never in the UI.
**Original recommended resolution:** (b) — since superseded.

**Resolved by owner decision D14 (2026-09-22): option (a).** The owner declined the rename (A3, verbatim: *"nein, es gibt ja auch persona-voice, etc. pp. es braucht ja auch eine Identity, User, etc."*) — `persona.md` collides with PLUR1BUS's own `persona-voice`/`persona-evolve` vocabulary, the same class of naming confusion §5's "NOT copy" rule was meant to avoid, just pointed at this harness's own product instead of Hermes's. `SOUL.md` stays the persona file, unchanged from §5. The *rule* — exactly one persona file, identical across all channels — is preserved exactly as originally specified, with no filename change at all. Import needs no `SOUL.md`→`persona.md` mapping any more: `SOUL.md` maps straight onto `SOUL.md` (`docs/import.md`, both OpenClaw and Hermes paths). The owner's added requirement — identity and user files — is new scope, addressed above under "The persona file" and in the action items below.

## Open questions for the owner

0. **D14 follow-up (new, 2026-09-22):** `IDENTITY.md` and `USER.md` are adopted here as OpenClaw-style *default* names for the two new curated files the owner asked for. Confirm these exact names, or give the final ones — this ADR's action items fix them before PR-06.
1. **Q4 sequencing (needs a decision now):** confirm "one agent, many connections" for M4 and multi-agent mention routing no earlier than M6, gated on `AgentScope`? Or is routing needed at M4?
2. Should there be a **fifth precedence layer per chat/peer** (one specific group behaves differently from all other groups on the same connection), or is per-bot-connection granularity enough for v0.1?
3. **Group memory default:** is `provenance-only` capture in groups acceptable, or should groups capture nothing at all by default until a human promotes a note?
4. Should an **external coding agent (ADR-011) get its own PLUR1BUS store**, or stay stateless with results captured only into the caller's store? (Default proposed: stateless, store opt-in.)
5. Is **depth 1** acceptable for v0.1, or is a two-level chain (lead → worker → specialist) needed for the intended projects?

## Action items

0. [ ] Fix the final names for the identity and user curated files (default `IDENTITY.md`/`USER.md`, D14) and land them in the `Agent` schema alongside `SOUL.md`, before PR-06.
1. [ ] Freeze the `Agent` / `RuntimeProfile` / `BehaviourSet` schemas as a versioned JSON Schema with a migration path; add `safeAgentId` validation at every boundary (`lib/sql-safety.js:84`).
2. [ ] Write the behaviour-merge contract test matrix (4 layers × {direct,dm,group,channel} × {telegram,discord,matrix,buzz}), including the deny-union and scope-intersection invariants.
3. [ ] Implement `AgentScope` on `AsyncLocalStorage` with a lint/test rule that every thread, worker and timer entry point re-establishes it; add a fail-closed test for "worker started without scope".
4. [ ] Publish the per-agent vs process-global table in the admin UI and `docs/architecture.md`; add a CI check that a new subsystem cannot land without an entry.
5. [ ] Implement the create saga with per-step compensations and an idempotency key; add a fault-injection test that kills the process between engine provisioning and runtime-profile write.
6. [ ] Specify the delegation contract type and the provenance envelope; enforce `tool_result`-only ingestion of peer output in the prompt assembler.
7. [ ] Implement guardrails with the defaults in the table; add the M5 acceptance tests (cycle attempt blocked, budget refusal, timeout → partial result, no private-memory leak).
8. [ ] Build the single-agent-vs-fan-out eval (≥20 cases, equal token budget) before enabling any fan-out default; record results in `docs/milestones.md`.
9. [ ] Decide and document the per-agent git-worktree lifecycle (creation, prune, orphan detection) and the file-lock fallback for non-git project directories.
