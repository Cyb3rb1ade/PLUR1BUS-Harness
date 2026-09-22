# ADR-002: PLUR1BUS engine extraction and the harness as native host

**Status:** Proposed · **Date:** 2026-09-22 · **Deciders:** Christian (owner) · **Inputs:** `docs/phase0/brief.md` D2, D3, D6, D9 · `docs/phase0/auftrag-original-2026-09-21.md` §2.1, §4.1, §6.2, §10, §11, §12 · `docs/phase0/research/plur1bus-host-contract.md` §1–§11 · `docs/phase0/research/plur1bus-crons-embedding-portability.md` §2, §3, §4 · `docs/phase0/research/harness-engineering-state-of-the-art.md` §2, §4 · `docs/phase0/research/openclaw-layout-dreaming-ui.md` §3 · Source of record: `/home/claude/refs/openclaw-plur1bus-memory` @ `89148f9` (`@cyb3rb1ade/plur1bus-memory` 7.15.4); `/home/claude/refs/openclaw` @ `b9421f4`. Companion documents: `docs/host-contract.md`, `docs/engine-extraction.md`.

## Context

D2 is the binding constraint: **PLUR1BUS is the core, not a plugin.** The harness must grow out of PLUR1BUS — PLUR1BUS gains a host-neutral engine with its own API, the harness is that engine's primary native host, and the existing OpenClaw plugin becomes a secondary adapter. §4.1's stage 1 (a host shim emulating the OpenClaw plugin API) is dropped; stage 2 (host-neutral core) becomes mandatory and is the first work package. D3 sends the engine changes to the PLUR1BUS repo as PRs and leaves the one-repo-or-two question to this ADR.

**What is engine and what is adapter is already measurable.** At `89148f9` the plugin is ~13 496 lines of `index.js` plus ~79 734 lines under `lib/` (`plur1bus-host-contract.md` §10 "Totals"). Of that, the OpenClaw-specific adapter bucket outside `index.js` is **≈ 6 400 lines**, and the UI bucket **≈ 4 600 lines** (ibid., §10). The rest — recall pipeline (2 158), Neo (3 500), memory graph (1 078), LanceDB adapter (1 325), dreaming (2 705), jobs (5 165), Obsidian (3 406), re-embedding (2 239), emotion/persona/temporal, i18n — is host-neutral today and portable as-is. The problem is not proportion, it is **location**: `index.js` mixes the ~40 `api.*` registration sites with the recall assembly and the command handlers in one `export default` factory, so "the adapter is not separated from the engine" (ibid., §11).

**The injection contract is already small enough to be an API.** Everything the model sees per turn arrives as one return value, `{ prependContext: string }`, produced by `applyGlobalInjectBudget` over exactly six named blocks with a 17 000-char cap (`index.js:13315-13325` @ `89148f9`, read directly). The only other prompt contribution is a *static* `registerMemoryPromptSupplement` returning constants (`index.js:7073-7088`, read directly) — so the system prompt is stable per turn, which is exactly the property ADR-010's caching rules depend on.

**One assumption blocks a stated requirement.** §6.2 requires per-agent/per-store embedding identities and recall across several of them. Today a single `vectorDim` scalar is threaded through every pool: `new MultiNamespacePool(namespaceLayout, vectorDim, AgentDbPool, api.logger)` and `new SharedMemoryPool(embeddingGenerationLayout.sharedBaseDir, vectorDim, AgentDbPool, api.logger)` — **the same scalar for private, workspace and user tables** (`index.js:5594-5595` @ `89148f9`, read directly; `plur1bus-crons-embedding-portability.md` §2 "Single-dimension assumption").

## Decision

**Refactor PLUR1BUS into three published units — a host-neutral `engine` package, an `openclaw-adapter` package, and a `ui` package — and have the harness consume the engine in-process inside the core daemon as an ordinary workspace dependency, not as a plugin.** The engine exposes a typed, host-agnostic API (lifecycle, recall, capture, checkpoint, tools, commands, jobs registry, embed/rerank, admin, events). The harness implements the engine's `Host` interface directly, supplying a **first-class principal** and a **typed turn origin**, which lets the engine delete the OpenClaw turn-route ticket machinery on the harness path. The six injection blocks and the 17 000-char budget are preserved verbatim as engine output; the harness applies its own, tighter time budgets where the OpenClaw ones exist only to survive a slow host. Multi-identity recall replaces the pool-wide `vectorDim` scalar with a per-route dimension and rank-based fusion. **Two repositories** remain the default (open question Q6 of `docs/assumptions.md`, answered below), with a strict behaviour-neutrality gate on every extraction PR.

## Options considered

### Option A: Host shim — emulate the OpenClaw plugin API inside the harness (original §4.1 stage 1)

| Dimension | Assessment |
|---|---|
| Complexity | Medium initially, **unbounded later**: the shim must emulate ~40 `api.*` members, 30 `api.on` registrations, the `openclaw/plugin-sdk/{routing,gateway-runtime,secret-input-runtime,memory-host-events}` subpath imports, `OPENCLAW_HOME`, and the loader that asserts `manifest.name === "openclaw"` from `process.argv[1]` (`lib/setup/feature-cron-plugin-runtime.js:217-234`; `plur1bus-host-contract.md` §7, §9) |
| Fit with brief D1–D11 | **Excluded by D2.** "No host shim that emulates the OpenClaw plugin API." |
| Cross-platform risk | Inherits every OpenClaw assumption including `OPENCLAW_HOME` and the hard host-package resolution |
| Maintenance burden | Two moving contracts (OpenClaw's and ours) plus a compatibility matrix per PLUR1BUS release |
| Latency / token cost | Neutral, but locks in the 45 s recall budget and the hook-shaped async model |

**Pros:** unmodified npm package runs immediately; fastest path to a demo.
**Cons:** ruled out by D2; makes the harness a second-class host forever; `registerControlUiDescriptor` had to be read from *two* different places to work on 2026.8.2 (`lib/setup/control-ui-plugin-runtime.js:1391-1393`) — that kind of host-version archaeology becomes our permanent tax.

### Option B: Host-neutral engine package + OpenClaw adapter + UI package; harness consumes the engine in-process (recommended)

| Dimension | Assessment |
|---|---|
| Complexity | **High once, then low.** The extraction is a known, enumerable set: ~40 `api.*` call sites collapse into one `Host` interface; nothing in `lib/` outside the §10 adapter bucket needs to change (`plur1bus-host-contract.md` §11) |
| Fit with brief D1–D11 | **Exactly D2 and D3.** Engine changes go upstream as PRs; the harness holds no divergent copy of memory logic (§2.1) |
| Cross-platform risk | Improves it: the Windows work package (§10) becomes engine-internal (`lib/platform.js` with `securePath()`, `ipcAddress()`, `isUnsafeLink()`, `canonicalIdentityPath()` — `plur1bus-crons-embedding-portability.md` §4) and benefits both hosts |
| Maintenance burden | One interface, versioned. The OpenClaw adapter keeps its own release cadence (D3) |
| Latency / token cost | **Best.** In-process calls; no IPC on recall; the harness can set its own deadlines and pass a real `AbortSignal` — fixing a defect the current memory-slot path has, where the host's abort signal is accepted and deliberately **not** propagated (`lib/setup/memory-host-runtime.js:170-171`) |

**Pros:** one identity model end to end; the harness owns the transport and can hand the engine a proven principal; the engine gets a cancellation input it lacks today; behaviour-neutrality is testable (whole suite green under both adapters).
**Cons:** a large refactor of a 13 496-line entry point before any product feature ships; upstream review latency is on our critical path; a mis-drawn boundary is expensive to redraw.

### Option C: Fork PLUR1BUS into the harness monorepo and diverge

| Dimension | Assessment |
|---|---|
| Complexity | Low at first, then two codebases |
| Fit with brief D1–D11 | **Violates §2.1** ("Der Harness enthält keine abweichende Kopie der Memory-Logik") and D3 |
| Cross-platform risk | Duplicated Windows work |
| Maintenance burden | Worst |
| Latency / token cost | Neutral |

**Pros:** no upstream dependency, no review latency.
**Cons:** excluded by the brief; the OpenClaw plugin would stop receiving our fixes, which §6.2 explicitly wants it to receive ("Neue Adapter landen als PRs im PLUR1BUS-Repo, damit auch das OpenClaw-Plugin sie bekommt").

## Engine API surface (interface sketch)

Names are proposals; shapes are derived from what the code already does. All methods take an explicit `Principal` and `TurnOrigin`; none reads ambient globals.

```
createEngine(config: EngineConfig, host: Host): Engine

interface Host {                       // everything the engine needs from any host
  logger: Logger                        // replaces 341 api.logger sites
  paths: { stateRoot(): string; workspaceDir(agentId): string; resolve(p): string }
  llm: { complete(params, opts): Promise<Completion> } | null   // may be absent
  secrets: { lease(ref): Promise<string> }                      // short-lived, never persisted
  clock: () => Date
  platform: PlatformCapabilities        // securePath, ipcAddress, isUnsafeLink, caseFold
}

interface Engine {
  // lifecycle
  init(): Promise<Readiness>            // idempotent; reports degraded capabilities
  dispose(): Promise<void>              // the existing shutdownOnce disposal set
  health(): Promise<HealthReport>

  // per-turn
  recall(req: RecallRequest): Promise<RecallResult>     // → blocks, never throws
  capture(req: CaptureRequest): CaptureHandle           // non-blocking; returns immediately
  checkpoint(req: CheckpointRequest): Promise<CheckpointResult>  // idempotent by transcript digest

  // model-facing
  tools(ctx: ToolContext): ToolDefinition[]             // 5 tools, filtered by workspace policy
  commands(): CommandSpec[]                             // /state /memory /forget /correct /mf /share …
  runCommand(name, args, ctx): Promise<CommandResult>

  // background
  jobs: JobRegistry                                     // see ADR-009
  embeddings: EmbedService                              // see ADR-006
  admin: AdminOps
  events: EventEmitter<EngineEvent>                     // typed; replaces memory-host-events
}

interface RecallRequest {
  principal: Principal; origin: TurnOrigin
  prompt: string; messages: Message[]
  compactedAt?: number | null           // today: event.compactedAt ?? ctx.compactedAt
  previousUserTurnAt?: number | null
  budget: { softMs: number; hardMs: number }
  signal: AbortSignal                   // honoured, unlike today's memory-slot path
}

interface RecallResult {
  blocks: Block[]                       // { name, text, droppable }  — the six below
  cap: number                           // default 17_000
  degraded?: { reason: string; capability: string }
  trace?: DecisionTrace
}

interface JobRegistry {
  list(): JobSpec[]                     // { id, phase, needsLlm, defaultCron, tz, singleton, stagger }
  run(id, { principal, origin, signal, budget }): Promise<JobResult>
}
interface JobResult { outcome: "completed"|"skipped"|"failed"; reason?: string;
                      counts: Record<string, number>; durationMs: number; artifacts?: Artifact[] }

interface EmbedService {
  identity(scope): EmbeddingIdentity    // model+revision+quant+dim+prefix scheme+norm+token cap
  embedQuery(text, { identity }): Promise<Float32Array>
  embedPassage(text, { identity }): Promise<Float32Array>
  rerank(query, docs, { topN, timeoutMs }): Promise<{index:number; score:number}[]>
}
```

`AdminOps` covers what is today spread across gateway methods: `reembedding.{plan,apply,resume,rollback,status,switch}`, `workspacePolicy.{get,list,set}`, `obsidian.{detect,prepare,confirm}`, `controlStatus()` (`lib/setup/*-plugin-runtime.js`; `plur1bus-host-contract.md` §7). Those files become thin OpenClaw wrappers over `engine.admin`, not the owners of the logic.

## Preserving the six injection blocks and the 17 000-char budget

`recall()` returns the **same six blocks, with the same names, order and droppability**, and the harness applies the **same** budget algorithm (drop/truncate the *last* droppable block first, never touch non-droppable ones — `lib/inject-budget.js:9-35`, ported verbatim):

| # | Block | Droppable | Composition (unchanged) |
|---|---|---|---|
| 1 | `neo` | yes | `formatNeoRecallContext(deduped.lanes, …)` (`index.js:13301-13313`) |
| 2 | `start` | yes | one-shot `<plur1bus-start-notice>`; source moves from `OPENCLAW_HOME` to `host.paths.stateRoot()` |
| 3 | `memories` | yes | `[personaDirective, moodStyleDirective, reactionDirective, dreamEchoContext, openThreadsContext, contradictionDisclosureContext, memoriesContext, reactivationContext].join("\n\n")` + `nudge + conflictNudge + skillProposalNudge` (`index.js:13214`, `:13319`) |
| 4 | `time` | **no** | `formatTimeContext(...)` (`index.js:13261`) |
| 5 | `temporal` | **no** | `formatTemporalContinuityContext(...)` (`index.js:13262-13269`) |
| 6 | `reminder` | **no** | merged DB-due + pending-file reminders (`index.js:13272-13296`) |

Two harness-side changes, both additive: (a) the **cap becomes a per-agent budget** the harness sets (default 17 000, `cfg.recall.globalInjectMaxChars` semantics retained) because ADR-010 needs to size the volatile zone against the model's context; (b) **truncation is never silent** — a dropped or clipped block emits an `EngineEvent` the harness surfaces as a visible warning and a deferral record. This directly encodes the lesson of OpenClaw #142393, where silent truncation of an over-cap MEMORY.md (9 728 bytes against a 9 000-char cap) dropped legitimate recent context on every load (`harness-engineering-state-of-the-art.md` §7, §"What better means" item 3).

Block *placement* is ADR-010's decision, not the engine's: the engine returns text; the harness decides whether a block rides in the cached prefix or outside it. The static `registerMemoryPromptSupplement` constants (`index.js:7073-7088`) become `engine.staticPromptSupplement(): string[]` and belong in the cached zone.

## Time budgets carried over, and the harness's own

| Budget | PLUR1BUS today (source) | Harness target | Why |
|---|---|---|---|
| Recall hook envelope | **50 000 ms** (`recallTimeoutMs` 45 000 + 5 000, `index.js:13351`; `lib/runtime-scheduler.js:7,40`) | **hard 1 200 ms** | The 45 s value exists to survive a host that aborts at 15 s (comment `index.js:12311-12313`). We own the caller. D6 requires recall inside a budget *in parallel with prompt assembly* and first token streamed immediately; a 45 s recall is incompatible with that. |
| Recall soft budget | 35 000 ms (`index.js:4711`), scheduler-derived `max(1000, min(hard−2000, hard×0.5))` (`lib/runtime-scheduler.js:392`) | **soft 400 ms** | Same derivation shape (≈⅓ of hard), absolute value set by the TTFT target. Past soft, the engine returns what it has. |
| Reactivation race | **50 ms** hard `Promise.race`, rejects `crr_timeout` (`index.js:12967-12969`, read directly) | **50 ms, unchanged** | Already the tightest and the best-tuned budget in the plugin. Carried over verbatim. |
| `agent_end` / capture | 60 000 ms hook timeout, work queued via `enqueueCapture` with an `AbortSignal` (`index.js:11299`) | **capture returns in < 5 ms**; background completion budget 60 000 ms | Capture must be non-blocking by contract (§4.1). The harness awaits a handle, not the work. |
| Embedding request | 15 000 ms default (`lib/providers/config-normalize.js:63-74`) | **15 000 ms for background, 800 ms inside a recall** | The 15 s rationale — a stalled request must not hold a recall (comment, ibid.) — argues for a *shorter* in-recall deadline once recall itself is 1.2 s. |
| Rerank | 5 000 ms, enforced twice (provider `AbortController` + pipeline `Promise.race`) (`config-normalize.js:158`; `lib/recall-pipeline.js:1466`) | **5 000 ms background, 300 ms in-recall, single owner** | The dual timer lets the pipeline abandon a call still in flight (`plur1bus-crons-embedding-portability.md` §2 Inferences). One owner. |
| Engine shutdown | 30 000 ms (`lib/runtime-shutdown.js`) | 30 000 ms, unchanged | LanceDB writes can be lost otherwise. |

All recall paths receive a real `AbortSignal` and must honour it. Today `manager.search` accepts the host's signal and deliberately drops it ("The recall pipeline has no cancellation input", `lib/setup/memory-host-runtime.js:170-171`) — that is a defect to fix in the new API, not to port (`plur1bus-host-contract.md` §11).

## Principal and turn-origin contract

Today the engine reconstructs a principal from six loosely-typed hook fields plus a session-entry read plus its own ticket ledger, through a six-step chain that falls back to an unauthenticated `safeHookBase` on any failure (`lib/memory-request-context.js:1259-1418`; `plur1bus-host-contract.md` §8). The durable authorization key is `(agentId, workspace principal, user:v1:sha256([channel, accountId, userId]))` (`lib/memory-request-context.js:302-304`), and the proof is a `reply_dispatch`-minted turn-route ticket whose `senderProof === sha256(senderId)` (`:1377-1393`).

**The harness owns the transport, so it supplies the principal directly.** The engine keeps the *formula* (the hash is the storage key and must stay stable across restarts) but stops reconstructing it:

```
interface Principal {
  agentId: AgentId                      // safeAgentId-validated
  workspace: { kind: "key"|"dir"; value: string }   // → workspace:v1: | workspace-dir:v1:
  user?: { channel: string; accountId: string; userId: string }  // all three or none
  userPrincipal?: `user:v1:${string}`   // engine-computed; never accepted from the host
  chatId?: string; chatKind?: "direct"|"dm"|"group"|"channel"
  proof: "transport"                    // the harness authenticated it; no ticket needed
}
interface TurnOrigin {                  // replaces string-matching on trigger/channel/sessionKey
  kind: "user" | "cron" | "subagent" | "background" | "system"
  incognito: boolean                    // fail-closed: unknown ⇒ true
  sessionId: string; runId: string
  surface: "cli" | "api" | "channel" | "acp" | "a2a" | "mcp"
}
```

Two contract rules carry over unchanged: **`origin.kind ∈ {cron, subagent}` ⇒ no automatic writes and no recall recursion** (§4.1); and the closed channel vocabulary (`SUPPORTED_PEER_KINDS`, `SUPPORTED_ROUTE_PROVIDERS` at `lib/memory-request-context.js:24-25`) becomes an **open, host-declared** set, because "telegram, discord, slack, mattermost" is an OpenClaw fact, not a memory fact — and because the current allowlist already excludes WebChat from trusted commands (`KNOWN-ISSUES.md:13`). Two rules are *tightened*: `logViolations` for the ACL audit JSONL is **on by default** in the harness (it is default-off today, so denials are usually invisible — `lib/acl-middleware.js:227-238`), with rotation; and the workspace principal is **case- and separator-normalised before hashing** on Windows, because `workspace-dir:v1:<canonicalDir>` otherwise splits one workspace's memories in two between `C:\Users\X` and `c:\users\x` (`plur1bus-crons-embedding-portability.md` §4).

On the harness path the turn-route ticket subsystem is not used. It stays in the OpenClaw adapter, where it is the only channel-identity proof available.

## Multi-identity recall and share re-embedding

§6.2 requires that private stores, workspace pools and user pools may carry **different** embedding identities. Four changes, all in the engine:

1. **Remove the pool-wide scalar.** `MultiNamespacePool` and `SharedMemoryPool` take a per-route identity resolver instead of `vectorDim` (`index.js:5594-5595`, read directly @ `89148f9`; propagation at `lib/multi-namespace-pool.js:210-212, 335-366`, `index.js:1054, 1080, 2561, 2591, 2708`; zero-vector placeholders at `index.js:1701`). `MemoryDB` carries its own dimension. The existing schema-time guard (`lib/providers/dimension-guard.js:1-40`) stays and becomes per-table.
2. **Embed the query once per identity.** Recall today produces one `queryVector` used against every table (`lib/recall-pipeline.js:1531, 1670, 1995-2004`). It must produce one per distinct identity in the routed set, each within the in-recall embedding budget, in parallel.
3. **Fuse by rank, not by score.** Scores from different models are not comparable; today `1/(1+distance)` values are compared directly and `minScore`/`forgetThreshold` default to 0.3, which "never filters" (`KNOWN-ISSUES.md:66-70`, via `plur1bus-crons-embedding-portability.md` §2). Switch to reciprocal-rank fusion across identities, then optionally rerank the fused head — the reranker is identity-agnostic and is the natural cross-space arbiter (§6.2 says exactly this).
4. **Cache key gains the identity set.** The embedding cache key is already `provider \0 model \0 dimensions \0 scopeId \0 cacheVersion \0 textHash` (`lib/embedding-cache.js:57-58`, read directly) — correct under a dimension change but not under multiple simultaneous identities; `scopeId` becomes per-identity.

**Share re-embeds today and must keep doing so.** `/share` already computes a **fresh** embedding rather than copying the stored vector — `const vector = await embeddings.embed(card.text || card.summary, { agentId: sourceAgent })` (`lib/telegram-commands/memory-edit.js:508`) — and is copy-never-move with an idempotency key and a readback verification (`lib/shared-memory.js:213-232`). Two defects to fix while extracting: the fresh embedding is computed in the **source** agent's identity, not the **target pool's**, and the only guard is a dimension-equality check (`lib/shared-memory.js:202-207`) which passes whenever two different models share a width. §6.2's rule is "`/share` kopiert Text und bettet in der Identität des Ziel-Pools **neu** ein". So: re-embed under the *target* identity, and replace the width check with an identity check.

## Degraded mode without the engine

§2.1 and §4.1: operating without memory is allowed only as a **visibly marked degraded state**, and a turn is **never** blocked. The harness implements this as a first-class state, not an exception path:

- The core daemon supervises the engine with backoff and a health check; `engine.health()` feeds a status the CLI (`doctor`), the API and the UI all read.
- Recall failure, timeout or absence returns `RecallResult { blocks: [], degraded: { reason, capability } }`. The turn proceeds. Today's fallback already does the equivalent — on a thrown recall it still returns the non-empty `neo`/`start` blocks (`index.js:13329-13330`), and on timeout a cached recall or `undefined` (`index.js:13337-13346`).
- Degradation is **announced, not inferred**: a badge in the UI, a line in `doctor`, an `EngineEvent`, and — per T-rule above — never a silent truncation.
- Capture during degradation writes to the journal and embeds later; recall degrades visibly to lexical/recency rather than blocking (§6.2). The harness's own `node:sqlite`+FTS5 session index (V1, V2) is the guaranteed lexical tier when vectors are unavailable, matching the "FTS as the guaranteed tier, vectors as an accelerator" rule (`harness-engineering-state-of-the-art.md` §2).
- Acceptance (M1, §12): "Core-Kill blockiert keinen Turn" — 1 000-turn soak with the engine killed at random intervals, zero blocked turns, degraded state visible in all three surfaces.

## PR plan for the PLUR1BUS repo, and behaviour-neutrality gating

Each PR is independently mergeable, behaviour-neutral by construction, and gated on **the full existing suite green under both adapters** plus new contract tests. Detail lives in `docs/engine-extraction.md`; this is the summary.

**Numbering note.** The P0–P10 labels below are this ADR's coarse-grained view of **the same plan** that `docs/engine-extraction.md` §c and `docs/milestones.md` carry at finer grain as PR-01…PR-15. They are not two plans. Mapping: P0→PR-01 · P1→PR-02+PR-03 · P2→PR-04+PR-05 · P3→PR-15 (checkpoint; capture is folded into PR-03) · P4→PR-03 (tools/commands move with the split) · P5→PR-07+PR-08 · P6→PR-11 (+ the in-process embedding owner of ADR-001 C1, which `engine-extraction.md` §c does not yet carry as its own row) · P7→PR-06 · P8→PR-10 · P9→PR-01+PR-06+PR-11+PR-12 · P10→PR-13+PR-14. **PR-01…PR-15 is the authoritative numbering for execution**; these labels are kept only so earlier references resolve.

| PR | Scope | Neutrality gate |
|---|---|---|
| P0 | `lib/platform.js` — `securePath()`, `ipcAddress()`, `isUnsafeLink()`, `canonicalIdentityPath()`; route the 8 `chmod 0o600/0o700` sites, the `HOME`→`os.homedir()` bug (`lib/providers/openclaw-memory-embedding-adapters.js:56-57`) and the symlink checks through it | Existing suite; new platform unit tests; no behaviour change on POSIX |
| P1 | Extract the `Host` interface: collapse ~40 `api.*` call sites into one injected object; `index.js` keeps only registration | Byte-identical `prependContext` for a recorded fixture corpus |
| P2 | `engine.recall()` — move the assembly at `index.js:12285-13351` behind the API; blocks + cap as the return type; honour `AbortSignal` | Golden-block test: same six blocks, same order, same droppability, same budget outcome |
| P3 | `engine.capture()` / `engine.checkpoint()` — non-blocking capture handle; checkpoint idempotent over transcript digest | Capture parity on a recorded session corpus |
| P4 | `engine.tools()` / `engine.commands()` — deny-by-classification tables (`index.js:7216-7252`) stay engine; channel vocabulary becomes host-declared | Command-matrix test across both adapters |
| P5 | `engine.jobs` registry with **structured `JobResult`** and a run ledger (ADR-009) | Every job returns a record *before* any early return |
| P6 | `engine.embeddings` — extract the service; make the owner transport pluggable and add an in-process owner (ADR-001 conflict C1) | IPC protocol tests unchanged; new in-process path tested |
| P7 | **Principal & turn origin** — typed `Principal`/`TurnOrigin`; ticket machinery confined to the OpenClaw adapter | ACL reason-code parity (`acl-middleware.js:174`'s stable codes are the contract) |
| P8 | **Multi-identity recall** — per-route dimension, per-identity query embedding, RRF fusion, target-identity share re-embedding | New: two agents, two identities, parallel recall, `/share` re-embeds into target (M2 acceptance, §12) |
| P9 | Windows port tier 1: named-pipe IPC, ACL-based `securePath`, four `bash` scripts → `.mjs`, case/separator normalisation before principal hashing, `commandArgv` comparison made path-normalised (`lib/setup/feature-cron-native.js:68-77`) | Windows CI job added; POSIX suite unchanged |
| P10 | Package split: `@cyb3rb1ade/plur1bus-engine`, `…-openclaw-adapter`, `…-ui`; the existing plugin becomes the adapter package's payload | Plugin installs and behaves identically at the same version |

**Behaviour-neutrality is the gate, not a goal.** Concretely, each PR must keep green: the full existing PLUR1BUS suite; a **golden-prefix corpus** (recorded `(principal, turn) → prependContext` pairs, asserted byte-identical); the ACL reason codes; and the time-budget assertions. `docs/engine-extraction.md` owns the fixture list.

## Two repos vs monorepo (open question Q6, `docs/assumptions.md`)

**Recommendation: two repositories, with a single-direction dependency.** `Cyb3rb1ade/PLUR1BUS-*` keeps the engine, the OpenClaw adapter and the UI; `Cyb3rb1ade/PLUR1BUS-Harness` depends on the engine by pinned version.

Reasons, in order of weight: (1) D3's stated default, and the OpenClaw plugin's release cadence is a real constraint — it declares `openclaw.compat.pluginApi ">=2026.8.1"` and `minGatewayVersion "2026.8.1"` (`package.json:8-20` @ `89148f9`) and must be able to ship a host-compatibility fix without shipping harness changes; (2) §6.2 explicitly wants new adapters to reach the OpenClaw plugin through the PLUR1BUS repo; (3) the engine has its own existing users and its own test suite, which the neutrality gate depends on staying independently runnable.

Costs, stated plainly: cross-repo PR latency lands on the harness's critical path, and a breaking engine change needs a two-repo dance. Mitigations: pin the engine by exact version with a compatibility matrix in this ADR's successor; run the harness's contract tests against the engine's `main` nightly so breakage is found before a release; and permit a *temporary* pnpm `link:` override for local development only, never in a published lockfile. **Revisit if** more than three consecutive harness milestones are blocked by cross-repo latency — at which point a monorepo with independent release tags becomes the better trade.

## What still ships to the OpenClaw plugin from these PRs

Everything except the harness's own host implementation. The OpenClaw plugin at the end of P10 is the same product, thinner: it keeps its manifest, its `contracts.tools`, its Control-UI tab, its gateway methods and its CLI commands, and delegates the logic to the engine. Concretely it **gains**: the Windows port tier 1 (P9) — so the plugin becomes Windows-runnable for the first time, which §10 wants as PRs and not harness workarounds; multi-identity recall and correct target-identity share re-embedding (P8); the structured job ledger and per-run records (P5), which is what makes dreaming observable under OpenClaw too (ADR-009); the `AbortSignal` fix (P2); the pluggable embedding-owner transport (P6); and the `HOME`→`homedir()` and `securePath` corrections (P0). It **keeps exclusively**: the turn-route ticket proof chain, the `openclaw/plugin-sdk/*` subpath imports, `OPENCLAW_HOME`, `classifyWorkspaceMemoryPaths`, the memory-slot runtime and the hand-copied Control-UI token block (`lib/setup/control-ui-plugin-runtime.js:991-1013`, a copy documented as drifting silently — `plur1bus-host-contract.md` §7, §11).

## Trade-off analysis

The extraction is expensive up front and cheap forever after; the shim is the reverse. The decisive point is not cost but *ownership of the contract*: under a shim, every OpenClaw release can move the ground (the `registerControlUiDescriptor` dual-path incident and the stale `OPENCLAW_SDK_COMPAT_AUDIT.md` — wrong on three counts at this commit — are both evidence of that, `plur1bus-host-contract.md` §0, §7). Under an engine API, the contract is ours and versioned, and OpenClaw becomes one consumer of it.

The genuine risk is boundary error: putting something in the engine that is really host policy (or vice versa) and discovering it three PRs later. The mitigation is that the boundary is being drawn from a *measured* inventory rather than a guess — §10 of the host-contract note classifies every `api.*` member, every `ctx.*` field, every host import and every environment variable, and the per-file line counts say where the mass is.

## Consequences

- **Easier:** the harness is a first-class host; recall is an in-process call with a real deadline and a real cancel; the principal is proven by the transport instead of reconstructed from six fields; multi-identity recall and per-store embedding choice become expressible; the Windows port lands once for both hosts; the engine gets a typed event stream that ADR-009's scheduler and ADR-004's UI both consume.
- **Harder:** the first product feature waits behind P0–P4; every engine change now needs an upstream PR and a review round (D3); a compatibility matrix (harness × engine × OpenClaw) must be maintained; the OpenClaw adapter must be kept green throughout, which roughly doubles the test surface during the extraction.
- **Revisit when:** (a) cross-repo latency blocks three consecutive milestones (→ monorepo); (b) an OpenClaw host change makes the adapter uneconomic to keep green (→ reconsider whether the adapter ships at all, which is an owner decision, not ours); (c) a second external host appears (→ the `Host` interface is already the right shape; no change).

## Conflicts with the brief

**C1 — §4.1 names a compaction hook and an `agent_context` object; neither exists.**
*Finding:* There is **no** compaction hook registered anywhere; compaction enters PLUR1BUS only as a *read* of `event.compactedAt ?? ctx.compactedAt` inside the recall hook (`index.js:12959`), and `docs/compatibility-openclaw.md:186` states PLUR1BUS "supplies no file-memory flush plan because conversation capture is handled by typed hooks". Likewise there is **no `agent_context` object**: cron/subagent detection is string-matching on `context.trigger`, channel/origin strings and a session-key regex `/^agent:[^:]+:cron(?::|$)/` (`index.js:7195-7201`; `lib/memory-request-context.js:1274`).
*Source:* `plur1bus-host-contract.md` §0, §2, §8; `index.js:12959`, `:7195-7201` @ `89148f9`.
*Options:* (1) build both properly in the engine API — `checkpoint()` as a real, idempotent pre-compaction call and `TurnOrigin` as a typed object; (2) keep inferring from strings; (3) drop the checkpoint requirement.
*Recommended resolution:* **(1).** §4.1's "Checkpoint-API v2, idempotent über Transkript-Digest" is the right requirement; it simply does not exist yet, so it is new work in P3, not a port. The "persist, then prune" seam is also the single highest-value place for a memory engine to sit (`harness-engineering-state-of-the-art.md` §2, top-15 rule 10). Recorded so the milestone estimate includes it.

**C2 — The brief's "einheitliche Embedding-Dimensionen" is stated as an assumption to lift; it is load-bearing in more places than the pools.**
*Finding:* Besides `index.js:5594-5595`, the scalar reaches `AgentDbPool`/`MemoryDB` construction, zero-vector placeholders, the share path's width check and the single-`queryVector` recall path (§"Multi-identity recall" above, all cited). Lifting it is a cross-cutting change touching the recall pipeline's score model, not a parameter change.
*Source:* `plur1bus-crons-embedding-portability.md` §2 "What multi-identity recall would require"; `index.js:5594-5595`, `:1701` @ `89148f9`.
*Options:* (1) full lift in P8 including RRF fusion; (2) lift only for *reads* (allow mixed identities in recall, forbid them at write time); (3) defer to post-v0.1.0 and ship one identity per installation.
*Recommended resolution:* **(1), scheduled as its own PR with its own acceptance test**, because §12's M2 acceptance already demands it ("zwei Agenten mit verschiedenen Embedding-Identitäten parallel, `/share` in einen Pool bettet neu ein"). Flagging it here so the effort is not folded into "extraction".

## Open questions for the owner

1. **Q1:** package names and npm scope for the split — `@cyb3rb1ade/plur1bus-engine`, `-openclaw-adapter`, `-ui`? And does the existing published name `@cyb3rb1ade/plur1bus-memory` stay the *adapter* (so OpenClaw installs are unaffected) or become the *engine*?
2. **Q2:** harness recall budget — is **soft 400 ms / hard 1 200 ms** the right trade against recall quality, or do you want a slower, richer default (e.g. 800/2 500) with a per-agent override? This is the single most user-visible number in the ADR.
3. **Q3:** the OpenClaw plugin's Control-UI tab currently hand-copies OpenClaw's design tokens and drifts silently. Do we (a) leave it as-is in the adapter, (b) generate it from the shared `ui` package, or (c) let it degrade and point users at the harness UI?
4. **Q4:** `/state` exists because `/status` is reserved by OpenClaw (`index.js:9226`). In the harness, should the command be `/status` (natural) with `/state` kept as an alias, or should both hosts stay identical for muscle memory?
5. **Q5:** how much upstream-review latency is acceptable before we switch to a monorepo? Proposed trigger: three consecutive blocked milestones.
6. **Q6:** the ACL audit log is default-off today. Turning it on by default produces a JSONL file per workspace. Confirm retention/rotation (proposal: 30 days or 50 MB, whichever first).

## Action items

1. [ ] Write `docs/engine-extraction.md` with the per-PR file lists, the golden-prefix fixture corpus and the neutrality gate definition (owner: this workstream; blocks P0).
2. [ ] Record the `Host` / `Engine` / `Principal` / `TurnOrigin` sketch above as a versioned `.d.ts` in the PLUR1BUS repo **before** P1, so both adapters are written against a fixed shape.
3. [ ] Build the golden-prefix corpus from recorded OpenClaw sessions (no real user data — synthetic fixtures per §11) and land it as a test *before* P2.
4. [ ] Open upstream issues for C1 (checkpoint API v2 + typed turn origin) and C2 (multi-identity recall) so the effort is visible in the PLUR1BUS backlog, and link them from `docs/milestones.md`.
5. [ ] Add the ACL reason-code list (`lib/acl-middleware.js:174`) to the contract-test suite as a frozen enum — it is the de-facto host contract and must not drift during extraction.
6. [ ] Decide Q1 and Q2 before P1; both change the public surface.
7. [ ] Add a nightly job running the harness contract tests against the engine's `main` to detect breakage before a release, per the two-repo mitigation.
