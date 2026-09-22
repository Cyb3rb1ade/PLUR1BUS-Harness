# Making PLUR1BUS host-neutral: engine, adapters, PR plan

**Status:** Phase 0 analysis · **Date:** 2026-09-22 · **Inputs:** `docs/host-contract.md`, `docs/phase0/brief.md` D2/D3/D4/D6/D9/D11, `docs/phase0/research/plur1bus-host-contract.md` §10–§11, `docs/phase0/research/plur1bus-crons-embedding-portability.md` §1–§4, `docs/assumptions.md` A1/A5/Q6.

**Source of record:** `/home/claude/refs/openclaw-plur1bus-memory` @ `89148f9` (`@cyb3rb1ade/plur1bus-memory` 7.15.4). All `file:line` are relative to that root at that commit; `oc:` prefixes are `/home/claude/refs/openclaw` @ `b9421f4`. Line counts marked *(wc)* were re-measured with `wc -l` @ 89148f9; counts marked *(note)* are taken from research §10 and not independently re-derived. This document contains **interface sketches only** — no implementation, per `docs/adr/README.md`.

---

## (a) Engine / adapter / UI / scripts map

### a.1 Totals

| Bucket | Lines | Source |
|---|---|---|
| `index.js` — mixed monolith, the extraction target | **13 496** *(wc)* | contains **37** `api.register*`/`api.on(` sites (`grep -c -o` @ 89148f9); research §10 says "~40 `api.*` sites" |
| `lib/` top level (`lib/*.js`) | **51 728** *(wc)* | |
| `lib/**` recursive (all `.js`) | **80 464** *(wc)* | research §10 computes ≈ 79 734 by summing its buckets |
| — of which **engine** | ≈ **68 000** *(note)* | research §10 "pure engine" bucket |
| — of which **OpenClaw adapter** | ≈ **6 400** *(note)*, itemised sum ≈ 6 544 | research §10 adapter table |
| — of which **UI** | ≈ **4 600** *(note)* | research §10 UI table |
| `scripts/*.mjs` (27 files) | **6 607** *(wc)* | |
| `scripts/*.sh` (4 files) | **2 655** *(wc)* | research §10 folds these into the 6 607 figure — corrected in `docs/host-contract.md` §e.8 |
| `scripts/lib/` | **1 090** *(wc)* | |
| `openclaw.plugin.json` | **2 899** *(wc)* | 56 config keys, 8 secret inputs, 17 uiHints |
| `tests/*.test.js` + `test/*.test.js` | **502 files, 109 502 lines** *(wc)*; runner `node --test --test-concurrency=1` (`package.json:41`) | the behaviour-neutrality instrument |

### a.2 Engine — port as-is (no host dependency)

| Path | Lines | Role |
|---|---|---|
| `lib/recall-pipeline.js` | 2 158 *(note)* | core retrieval, fusion, rerank orchestration |
| `lib/neo-arch.js` | 3 500 *(note)* | turn journal / graph; also holds the PID lock (`:296-305`) |
| `lib/memory-graph.js` | 1 078 *(note)* | graph store |
| `lib/db-adapter.js` | 1 325 *(note)* | LanceDB |
| `lib/relevant-memory-context.js` | 434 *(note)* | `<relevant-memories>` formatter (`:209-211`, `:229`) |
| `lib/inject-budget.js` | 35 *(note)* | global char cap (`:9-35`) |
| `lib/conversation-reactivation-recall.js` | 961 *(note)* | reactivation, 50 ms race caller at `index.js:12967` |
| `lib/temporal-context.js` / `lib/session-time.js` | 163 / 89 *(note)* | non-droppable blocks |
| `lib/mood-style-directive.js`, `lib/emotional-state.js` (+ `emotion-engine`, `-blends`, `-score`, `emotion.js`) | 131 / 607 *(note)* | emotion |
| `lib/persona-voice.js` | 693 *(note)* | reads a workspace file — needs `Host.workspaceDir` |
| `lib/i18n.js` + `lib/i18n-dictionary.js` | 181 + 1 896 *(note)* | |
| `lib/dreaming/` | 2 705 *(wc)* | light-dream, rem-dream, dream-diary |
| `lib/jobs/` | 5 895 *(wc)* (research §10 says 5 165) | `jobs/reminder-dispatch.js` touches delivery |
| `lib/obsidian/` | 3 406 *(wc)* | vault writer, host-independent |
| `lib/code-index/` | 685 *(wc)* | |
| `lib/reembedding/` | 2 239 *(wc)* | engine; its plugin runtime is adapter |
| `lib/model-preparation/` | 570 *(wc)* | engine; its service registration is adapter |
| `lib/providers/` | 4 209 *(wc)* | minus the two adapter files below |
| `lib/memory-request-context.js:1-1250` | of 1 418 | pure identity half: `stableIdentityHash`, `workspacePoolKey`, `userPoolKey`, `validatedIdentity`, `resolveMemoryRequestContext`, `normalizeWorkspaceTarget`, `buildMemoryAccountTopology` |
| `lib/acl-middleware.js`, `lib/workspace-policy.js` (194), `lib/sql-safety.js`, `lib/input-limits.js` | — | pure policy and sanitization; `lib/acl-middleware.js:102-159` reason codes are the de-facto contract |
| `index.js:7216-7252` | 37 | deny-by-default action classification tables |

### a.3 OpenClaw adapter — re-implement for the harness

| Path | Lines | What it binds |
|---|---|---|
| `index.js` registration shell (37 `api.on`/`api.register*` sites spread over `index.js:4431-13443`) | of 13 496 | **the adapter is not separated from the engine here** — the whole extraction problem |
| `lib/setup/memory-host-runtime.js` | 274 *(note)* | `registerMemoryCapability` runtime |
| `lib/setup/workspace-memory-provenance.js` | 82 *(note)* | `classifyWorkspaceMemoryPaths` |
| `lib/setup/feature-cron-plugin-runtime.js` | 412 *(note)* | Gateway+CLI, `openclaw/plugin-sdk/gateway-runtime` loader (`:217-234`) |
| `lib/setup/workspace-policy-plugin-runtime.js` | 256 *(note)* | 3 gateway methods + CLI |
| `lib/setup/obsidian-vault-plugin-runtime.js` | 253 *(note)* | 3 gateway methods + CLI |
| `lib/setup/reembedding-plugin-runtime.js` | 284 *(note)* | 6 gateway methods + CLI |
| `lib/setup/skill-workshop-plugin-runtime.js` | 163 *(note)* | `skills.proposals.{create,apply}` |
| `lib/setup/feature-cron-native.js` / `-bootstrap.js` | 99 / 69 *(note)* | argv byte-comparison; marker/throttle |
| `lib/setup/config-contract.js` | 324 *(note)* | host config-shape contract |
| `lib/runtime-shutdown.js` | 487 *(note)* | `runtimeIfUsable`, lifecycle/service/`gateway_stop` |
| `lib/memory-request-context.js:1237-1418` | ≈ 180 of 1 418 | `sessionEntryDeliveryView`, `resolveHostHookMemoryContext`, `createHostRoutingLoader` |
| `lib/providers/openclaw-memory-embedding-adapters.js` | 326 *(note)* | `registerEmbeddingProvider` |
| `lib/providers/scoped-embedding-ipc.js` | 720 *(note)* | `registerService` + Unix socket bound to the activation generation |
| `lib/llm-router.js:405-460` | ≈ 55 of 464 | the only `runtimeLlm.complete` call |
| `lib/workspace-policy-guard.js` | 114 *(note)* | thin; the policy itself is engine |
| `lib/telegram-commands/*` | 2 446 *(wc)* | channel-shaped I/O around engine logic |
| **Adapter subtotal excl. `index.js`** | ≈ **6 400** *(note)* | |

### a.4 UI

| Path | Lines | Note |
|---|---|---|
| `lib/setup/control-ui-plugin-runtime.js` | 1 426 *(note)* | HTTP route (`:1403-1408`), descriptor (`:1394-1424`) **and** the whole self-contained HTML/CSS renderer with the hand-copied token block (`:991-1013`) |
| `lib/setup/control-ui-write.js` | 576 *(note)* | write actions behind `controlUi.writeActions` |
| `lib/setup/control-ui-compaction.js` | 144 *(note)* | |
| `lib/setup/skill-workshop-dashboard.js` | 55 *(note)* | |
| `lib/control-plane-projection.js` | 754 *(note)* | data shaping — engine-ish, UI-bound |
| `lib/control-plane-health.js` / `-storage.js` | 520 / 90 *(note)* | |
| `lib/dashboard-settings.js` / `-operations.js` | 355 / 134 *(note)* | |
| `lib/setup/feature-profiles.js` | 606 *(note)* | setup-wizard profiles |
| **UI subtotal** | ≈ **4 600** *(note)* | |

### a.5 Scripts (out-of-process)

| Path | Lines | Host coupling |
|---|---|---|
| `scripts/setup-feature-crons.mjs` | of 6 607 | npm `postinstall`; the exit-0 contract (`:13-17`) and the native probe (`:48`, `:57-72`) |
| `scripts/run-feature-cron.mjs` | 34 *(wc)* | the cron entry point; imports `lib/setup/feature-cron-plugin-runtime.js` (`:6-10`) |
| `scripts/auto-capture-lancedb.mjs` | of 6 607 | documented `agent_end` fallback (`index.js:15-18`) |
| `scripts/repair-installed-plugin.mjs`, `scripts/repair-dreaming-cron.mjs`, `scripts/verify-plugin-deploy.mjs`, `scripts/provider-wizard.mjs` | of 6 607 | host-install shaped |
| `scripts/*.sh` ×4 | 2 655 | `install-memory-system.sh` (local + SSH), `backup-snapshot.sh`, `restore-snapshot.sh`, `protect-plur1bus-deploy.sh` |
| remaining ≈ 20 `.mjs` | of 6 607 | store maintenance, host-neutral |
| `lib/install/agents-patcher.js`, `soul-patcher.js` | 181 *(note)* | writes into the agent workspace at install time |

**Structural conclusion.** 85 % of the code is already host-neutral; the coupling is concentrated in one file (`index.js`) and fourteen `lib/setup/*` + `lib/runtime-shutdown.js` + two `lib/providers/*` files. The extraction is therefore a *move-and-inject* job, not a rewrite — matching assumption A1.

---

## (b) Package boundaries and the engine API

### b.1 Packages (in the PLUR1BUS repo)

| Package | Contains | Depends on | Ships to |
|---|---|---|---|
| `@cyb3rb1ade/plur1bus-engine` | stores (`lib/db-adapter.js`, `lib/multi-namespace-pool.js`, `lib/shared-memory.js`), recall pipeline, capture, ACL + sanitization, emotion, persona, Neo/graph, dreaming jobs, reembedding, model preparation, obsidian writer, i18n, embedding/rerank service incl. the IPC protocol, the inject-budget and all context formatters, the deny-by-default action tables, the job registry | Node ≥ 24, `@lancedb/lancedb`, `@huggingface/transformers`, `openai` — **nothing from `openclaw`** | npm |
| `@cyb3rb1ade/plur1bus-host-openclaw` | today's plugin: manifest, the 37 registration sites, `lib/setup/*-plugin-runtime.js`, `memory-host-runtime.js`, `workspace-memory-provenance.js`, `runtime-shutdown.js`, `memory-request-context.js:1237-1418`, `openclaw-memory-embedding-adapters.js`, the plugin-SDK deep-import loader, `feature-cron-*`, `scripts/setup-feature-crons.mjs`, `scripts/run-feature-cron.mjs` | `@cyb3rb1ade/plur1bus-engine`, `openclaw` (peer) | npm, keeps the current release cadence (D3) |
| `@cyb3rb1ade/plur1bus-control-ui` | the renderer, its design tokens, `control-plane-projection`, `control-plane-health`, dashboard modules, `control-ui-write` | `@cyb3rb1ade/plur1bus-engine` | npm; mounted by either host |
| `@cyb3rb1ade/plur1bus-platform` (new, small) | `securePath()`, `ipcAddress()`, `isUnsafeLink()`, `canonicalIdentityPath()` — the four platform decisions (research Windows §4 recommends exactly this) | — | internal |

The harness (`Cyb3rb1ade/PLUR1BUS-Harness`) consumes `plur1bus-engine` + `plur1bus-control-ui` directly. There is **no** `plur1bus-host-harness` adapter package: per D2 the harness *is* the native host, so it implements `HostServices` itself.

### b.2 Engine API surface (interface sketch — pseudo-TypeScript, no implementation)

```ts
// ---------- what the host gives the engine ----------
interface HostServices {
  logger: Logger;                                   // replaces api.logger (341 sites)
  stateDir: string;                                 // replaces OPENCLAW_HOME (index.js:12425)
  workspaceDir(agentId: string): string | undefined;// replaces memory-host-runtime.js:104-111
  config(): EngineConfig;                           // the 56 keys of openclaw.plugin.json configSchema
  mutateConfig?(patch: DeepPartial<EngineConfig>): Promise<void>; // index.js:6158
  llm?: { complete(p: LlmParams): Promise<LlmResult> };           // lib/llm-router.js:412-450
  secrets?: SecretStore;                            // the 8 configContracts.secretInputs
  events?: { emit(name: string, payload: unknown): void };        // plugin-sdk/memory-host-events
  clock?: () => number;                             // test seam
}

// ---------- identity (ADR-007) ----------
type WorkspacePrincipal = `workspace:v1:${string}` | `workspace-dir:v1:${string}`; // memory-request-context.js:27-28
type UserPrincipal = `user:v1:${string}`;            // sha256([channel, accountId, userId]) — :302-304
type TurnOrigin = "user" | "cron" | "subagent" | "heartbeat" | "system";
interface Principal {
  agentId: string;                                   // /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/ — memory-host-runtime.js:30
  workspace: WorkspacePrincipal;
  user?: UserPrincipal;                              // absent ⇒ no `user` scope (acl-middleware.js:139-159)
  channel: string;                                   // open vocabulary, replaces the 4-value list at :24-25
  accountId: string;
  chat: { id: string; kind: "direct" | "dm" | "group" | "channel" };
  trust: "proved" | "inferred";                      // "inferred" ⇒ degrade to agent-private
}
interface AgentContext { origin: TurnOrigin; background: boolean; jobId?: string; parentRunId?: string; }

// ---------- lifecycle ----------
interface Engine {
  open(agentId: string): Promise<AgentStore>;        // replaces getMemorySearchManager + pool warm-up
  close(): Promise<void>;                            // replaces runtime-shutdown.js:243-297 (12 disposals)
  status(): Promise<EngineStatus>;                   // memory-host-runtime.js:202-219

  // ---------- turn path ----------
  systemSupplement(): string[];                      // stable, cached prefix (index.js:7077-7088)
  recall(q: RecallQuery): Promise<RecallResult>;
  capture(t: TurnRecord): Promise<CaptureResult>;
  checkpoint(agentId: string, reason: "compaction" | "shutdown" | "manual"): Promise<CheckpointResult>;

  tools: ToolSpec[];                                 // memory_recall|search|store|forget, knowledge_update
  commands: CommandSpec[];                           // /state /memory /forget /correct /share /wiki, plur1bus_*
  jobs: JobRegistry;
  embedding: EmbeddingService;
  admin: AdminOps;
  events: EngineEvents;
}

interface RecallQuery {
  query: string; principal: Principal; agent: AgentContext;
  budget: { softMs: number; hardMs: number; capChars: number }; // 35 000 / 50 000 / 17 000 today
  signal: AbortSignal;                               // MANDATORY — fixes host-contract.md §f.1
  compactedAt?: number | null; previousUserTurnAt?: number | null;
  validAt?: string;                                  // caller-supplied only (index.js:11396-11403)
}
interface ContextBlock { name: "neo"|"start"|"memories"|"time"|"temporal"|"reminder"|string;
                         text: string; droppable: boolean; tokensEstimate?: number; }
interface RecallResult { blocks: ContextBlock[]; capChars: number; degraded: boolean;
                         trace?: DecisionTrace; timings: Record<string, number>; }

interface TurnRecord { agentId: string; principal: Principal; agent: AgentContext;
                       messages: Message[]; runId?: string; sessionKey?: string;
                       incognito: boolean;            // classified by the host, fail-closed
                       signal: AbortSignal; }

// ---------- jobs (D4) ----------
type JobName = "persona-evolve" | "afterthought" | "consolidate-daily" | "auto-accept-stale"
  | "embedding-drain" | "emotion-refine" | "classify-recent" | "rem-dream" | "skill-miner"
  | "discover-semantic-links" | "gc-run"              // the 11 specs, feature-cron-plan.js:25-170
  | "reminder-dispatch" | "feedback-report" | "proactive-check" | "meta-reflect"  // RPC/CLI only today
  | "skill-benefit-backfill" | "episodes-rebuild"     // chat-command only today
  | "light-dream";                                    // fire-and-forget in agent_end today (index.js:10992)
interface JobSpec { name: JobName; needsLlm: boolean; singleton: boolean;   // gc-run only (plan:163-168)
                    defaultSchedule?: { kind: "cron" | "every"; expr: string; timezone?: string };
                    phase?: "light" | "rem" | "deep"; }                     // D4 sleep-plan mapping
interface JobRun { job: JobName; agentId: string; partition?: string;
                   startedAt: number; durationMs: number;
                   outcome: "completed" | "skipped" | "failed" | "incomplete";
                   reason?: string; counts: Record<string, number>; logRef?: string; }
interface JobRegistry {
  list(): JobSpec[];
  run(job: JobName, agentId: string, opts?: { signal?: AbortSignal; dryRun?: boolean }): Promise<JobRun>;
  history(agentId: string, job?: JobName, limit?: number): Promise<JobRun[]>;  // persisted, see PR-08
}

// ---------- embedding / rerank (D9) ----------
interface EmbeddingService {
  embed(texts: string[], o: { kind: "query" | "passage"; identity: EmbeddingIdentity;
                              signal: AbortSignal }): Promise<Float32Array[]>;
  rerank(query: string, docs: string[], o: { topN: number; signal: AbortSignal }): Promise<RerankHit[]>;
  probe(): Promise<{ ok: boolean; error?: string; cached: boolean }>;   // 10 s / 5 min
  identities(): EmbeddingIdentity[];                  // { fingerprintId, provider, model, dimensions }
  serve(address: IpcAddress): Promise<Disposable>;    // the owner process; envelope unchanged
}

// ---------- admin ----------
interface AdminOps {
  share(sourceId: string, target: "workspace" | "user", p: Principal,
        confirm: { nonce: string }): Promise<ShareResult>;              // copy-never-move, re-embeds
  forget(id: string, p: Principal): Promise<ForgetResult>;              // archive-first, tombstone
  reembedding: { plan(); apply(); resume(); rollback(); status(); switch(); };
  workspacePolicy: { get(); list(); set(); };
  obsidian: { detect(); prepare(); confirm(); };
  migrate(from: SchemaVersion, to: SchemaVersion): Promise<MigrationResult>;
}
interface EngineEvents { on(e: "dream.completed" | "job.run" | "acl.denied" | "recall.degraded"
                            | "embedding.identity.changed", h: (p: unknown) => void): Disposable; }
```

Mapping of every host surface in `docs/host-contract.md` §a onto this sketch is given in that document's "Harness mapping" column; nothing in §a is left without a target.

---

## (c) PR plan for the PLUR1BUS repo

Each PR is gated by the same **behaviour-neutrality test**: the full PLUR1BUS suite (**502 files / 109 502 lines**, `node --test --test-concurrency=1 tests/*.test.js test/*.test.js`, `package.json:41`) green **under the OpenClaw adapter**, plus the PR-specific contract test named below run under a stub harness adapter. A PR that changes observable behaviour must say so in its description and update the matrix in `docs/compatibility-openclaw.md`.

| PR | Title | Size | Depends on | Scope | Behaviour-neutrality gate |
|---|---|---|---|---|---|
| **PR-01** | `lib/platform.js`: `securePath`, `ipcAddress`, `isUnsafeLink`, `canonicalIdentityPath` | **S** | — | Introduce the module; route the 7 `chmodSync` + 1 `fchmodSync` sites (host-contract §f.9) and `process.env.HOME` (`lib/providers/openclaw-memory-embedding-adapters.js:56` → `homedir()`) through it. No behaviour change on POSIX | Suite green; new unit test asserts `securePath` is a `chmod` on POSIX and the win32 branch is reached under a stubbed `process.platform` |
| **PR-02** | Extract `HostServices` and inject it | **L** | PR-01 | Define the interface in b.1; replace the 341 `api.logger` and the ~20 `runtimeIfUsable(api)` reads in `lib/**` with `host.*`. `index.js` still constructs it from `api`. Pure mechanical | Suite green with zero diff in test expectations; a lint rule forbids `api.` outside `index.js` and `lib/setup/*-plugin-runtime.js` |
| **PR-03** | Split `index.js` into `engine/` factory + `adapter/openclaw/` shell | **L** | PR-02 | Move the 37 registration sites into `adapter/openclaw/register-*.js`; the recall assembly (`index.js:12285-13351`), capture (`:10354-11299`), command handlers (`:9090-9122`, `:9224-10268`) and the internal feature runners (`:7498-8272`) become engine modules. The `export default` factory stays in the adapter | Suite green; new contract test constructs the engine with a stub `HostServices` (no `openclaw` import on the module graph — enforced by a dependency-cruiser rule) |
| **PR-04** | `Engine.recall()` returning `ContextBlock[]` | **M** | PR-03 | Replace the `{ prependContext }` return with the block array + `capChars`; the adapter joins via `applyGlobalInjectBudget` (`lib/inject-budget.js:9-35`, unchanged) and returns `{ prependContext }` | Suite green; a golden test asserts the joined string is byte-identical to today's for a fixed fixture, including the six block names and the 17 000 cap |
| **PR-05** | **Abort propagation** through recall | **M** | PR-04 | Make `signal` mandatory on `RecallQuery` and thread it into the embedder, reranker and LanceDB calls. Removes the comment at `lib/setup/memory-host-runtime.js:170-172` | New contract test: abort at 100 ms ⇒ the embedding provider's call is cancelled and `recall` rejects with `AbortError` within 50 ms. Suite green (the OpenClaw adapter passes `AbortSignal.timeout(recallTimeoutMs)`) |
| **PR-06** | **Principal model**: `Principal` + `AgentContext` as explicit inputs | **L** | PR-03 | Add the types; `resolveMemoryRequestContext` becomes a *constructor* of `Principal`. The OpenClaw adapter keeps `resolveHostHookMemoryContext` (`lib/memory-request-context.js:1259-1418`) and the `reply_dispatch` ticket and feeds their output into it. Replace the cron/subagent string matching (`index.js:7195-7201`, `:1274`) with `AgentContext` supplied by the caller. Open the channel vocabulary (`:24-25`) to a registry | Suite green (the adapter reproduces today's six-step proof); new contract test: a harness-supplied `Principal` with `trust:"proved"` reaches `user` scope, `trust:"inferred"` degrades to agent-private and never throws (`:1405-1417`) |
| **PR-07** | Engine job registry + `run(job, agentId)` returning `JobRun` | **M** | PR-03 | Lift the 11 specs (`lib/setup/feature-cron-plan.js:25-170`), the 6 RPC/CLI-only features and `light-dream` into `JobRegistry`; the `/plur1bus internal <feature>` handlers become `run()` bodies. The OpenClaw adapter keeps `plur1bus.feature.run` as a thin caller | Suite green; contract test: `run()` returns a `JobRun` for each of the 18 names, including the skip paths (`no_llm_config` `index.js:7692-7694`, `too_few_memories` `lib/dreaming/rem-dream.js:1139`) |
| **PR-08** | **Persist job results with status** | **M** | PR-07 | Replace the boolean `runs.json completed[runKey]` (`lib/neo-arch.js:1916-1925`) with an append-only per-agent run ledger written **before** any early return; promote the four silent rem-dream skips (`rem-dream.js:1118,1136,1139,1170`) to `info`; make the diary write's outcome part of the record (`lib/dreaming/dream-diary.js:141-170`). Fixes host-contract §f.3 | **Behaviour-changing by design** — gated instead by: suite green after updating the run-state tests; new test asserts a no-narrative REM run persists `outcome:"incomplete"` and is retried the next night (the 7.12.58 case, `rem-dream.js:1327-1338`); `already_processed` is only reachable after a `completed` record |
| **PR-09** | Single timeout owner for rerank | **S** | PR-05 | Remove the pipeline `Promise.race` (`lib/recall-pipeline.js:1466` path) and keep the provider `AbortController` (`lib/providers/reranker-cohere.js:50,74`) driven by the caller's signal | Suite green; test asserts exactly one timer fires and the HTTP request is aborted |
| **PR-10** | **Multi-identity recall**: per-route `vectorDim` | **L** | PR-04, PR-05, PR-06 | Replace the scalar at `index.js:5594-5595` with a per-route value in `MultiNamespacePool`/`SharedMemoryPool` (`lib/multi-namespace-pool.js:210-212`, `:335-366`) and per-DB in `AgentDbPool`/`MemoryDB` (`index.js:1054,1080,2561,2591,2708`); zero-vector placeholder (`index.js:1701`) takes the route's dim; one `embedQuery` per identity instead of the single vector at `lib/recall-pipeline.js:1530-1532`; **fusion moves from raw `1/(1+distance)` to rank fusion (RRF)**; share equality check (`lib/shared-memory.js:202-207`) becomes a re-embed-into-target check; `embedding-cache` `scopeId` gains the identity (`lib/embedding-cache.js:57-58`) | **Behaviour-changing for ranking.** Gate: (1) single-identity configuration must produce byte-identical recall order on a frozen fixture corpus (RRF over one list = the original order); (2) `lib/providers/dimension-guard.js:20-40` still rejects a mismatched existing table; (3) new contract test with two identities of different width returns a fused list with both |
| **PR-11** | Embedding-owner IPC: named pipe on Windows | **M** | PR-01 | `ipcAddress()` returns the abstract socket (linux), filesystem socket (darwin/BSD) or `\\.\pipe\plur1bus-embedding-<sha256(stateRoot)[0:32]>` (win32); replace `lstatSync().isSocket()` (`lib/providers/scoped-embedding-ipc.js:165-172`, `:406-415`) with the existing connect-probe (`:174-195`); drop `chmodSync(socketPath)` (`:435`) in favour of `securePath`. Envelope, limits and fingerprint checks unchanged (`:61-92`, `:24-31`, `:376-390`) | Suite green on Linux; new contract test round-trips the envelope over each transport and asserts `scoped_embedding_identity_mismatch` / `_fingerprint_mismatch` still fire |
| **PR-12** | Bash → Node | **M** | PR-01 | Port `install-memory-system.sh`, `backup-snapshot.sh`, `restore-snapshot.sh`, `protect-plur1bus-deploy.sh` (2 655 lines) to `.mjs`, matching the existing 27-script pattern | New tests for the two snapshot scripts (create/restore round-trip); `install-memory-system.mjs` gated by a `--dry-run` golden output |
| **PR-13** | Extract `@cyb3rb1ade/plur1bus-control-ui` | **M** | PR-03 | Move the renderer and `control-plane-*`/`dashboard-*` modules; replace the hand-copied token block (`lib/setup/control-ui-plugin-runtime.js:991-1013`) with a `tokens.ts` module the OpenClaw adapter imports and the harness overrides | Suite green; a snapshot test of the rendered HTML with the OpenClaw token set is unchanged |
| **PR-14** | Publish `@cyb3rb1ade/plur1bus-engine` and repoint the plugin | **M** | PR-03…PR-13 | The plugin package becomes `@cyb3rb1ade/plur1bus-host-openclaw` depending on the engine; manifest, `contracts.*` and `cliCommands` unchanged | Full suite green in the plugin repo against the published engine; `docs/compatibility-openclaw.md` matrix re-verified |
| **PR-15** | Engine-side `checkpoint()` | **S** | PR-03 | Turn the `event.compactedAt` read (`index.js:12959`) into an explicit `Engine.checkpoint(agentId,"compaction")`; the OpenClaw adapter may optionally register `before_compaction` (oc:`src/plugins/hook-types.ts:116`, 30 000 ms default) | Suite green; test asserts reactivation recall still keys off the same timestamp when only `compactedAt` is supplied |

**Numbering note.** PR-01…PR-15 is the authoritative numbering. ADR-002's "PR plan" table labels the same plan P0–P10 at coarser grain; the mapping is recorded in ADR-002 §"PR plan for the PLUR1BUS repo".

**Ordering.** PR-01 → PR-02 → PR-03 is the critical path; PR-04…PR-09, PR-11, PR-12, PR-13 parallelise after PR-03; PR-10 is last among the behaviour-affecting ones because it needs PR-04/05/06; PR-14 closes the extraction; PR-15 is independent and can land any time after PR-03. Estimated: 4 × L, 8 × M, 3 × S.

**Two PRs are not behaviour-neutral and need an explicit owner decision** before they land: PR-08 (run-state semantics) and PR-10 (ranking). Both are required by the brief (D4 observability, multi-identity recall), so they are listed as decisions, not as risks to avoid.

---

## (d) Risks

| # | Risk | Evidence | Mitigation |
|---|---|---|---|
| R1 | **The OpenClaw plugin must keep releasing independently** (D3). A monorepo-style lockstep would block a hotfix for the current user base on unfinished harness work | `package.json:8-20` declares `minGatewayVersion 2026.8.1`; `docs/compatibility-openclaw.md:280` already tracks 2026.9.1 separately | Engine is semver-published; the plugin pins a caret range. PR-14 is the only PR that changes the plugin's dependency graph. Keep the plugin's own CI and release workflow untouched by PRs 01–13 |
| R2 | **Drift between the two hosts.** Once the harness is the primary host, OpenClaw-only paths (ticket proof, session entry, cron provisioning, plugin-SDK deep imports) will rot silently | The adapter already carries three known silent-drift copies: Control-UI tokens (`lib/setup/control-ui-plugin-runtime.js:991-1013`, "value-identical" per `docs/compatibility-openclaw.md:306`), `cfg.channels` shape assumptions (`lib/memory-request-context.js:804-815`), and `OPENCLAW_SDK_COMPAT_AUDIT.md` which is already 3½ months stale and wrong on three points (host-contract §e.6) | Run the **full suite under both adapters in CI** (two jobs, same tests, different `HostServices` implementation). Add a nightly job that resolves `openclaw@latest` and asserts the three deep-import subpaths (`gateway-runtime`, `secret-input-runtime`, `memory-host-events`, allowlist `lib/setup/feature-cron-plugin-runtime.js:221`) still resolve and that the hook-name union still contains the 8 names PLUR1BUS registers |
| R3 | **Hook payload types are undeclared in the PLUR1BUS repo** — the `event`/`ctx` field sets are only knowable from PLUR1BUS's reads | research §11 "Gap — hook payload types"; the authoritative declarations do exist host-side (oc:`src/plugins/hook-before-agent-start.types.ts:22-50`, oc:`src/plugins/hook-types.ts:105-147`) | Generate the adapter's types from the host SDK at build time and fail the build when a field PLUR1BUS reads disappears |
| R4 | **Two hosts, two identity strengths.** The harness supplies a proved principal; OpenClaw degrades to agent-private on ticket failure. The same store then answers differently depending on host | `lib/memory-request-context.js:1405-1417`; `docs/compatibility-openclaw.md:190` | `Principal.trust` is part of the contract and is recorded in the ACL audit; a store migrated between hosts keeps the same `user:v1:` hash (PR-06 gate) |
| R5 | **PR-10 changes ranking**, and today's `minScore`/`forgetThreshold` default of 0.3 "never filters" (`KNOWN-ISSUES.md:66-70`), so the change is not covered by existing thresholds | as cited | Single-identity byte-identity gate (PR-10 gate 1) plus a recorded A/B on a frozen corpus before the default flips |
| R6 | **`compatibility-openclaw.md` matrix needs a "harness" column.** Its rows today are `OpenClaw feature \| PLUR1BUS overlap \| Compatibility policy` (`docs/compatibility-openclaw.md:175-176`, rows `:177-198`) | as cited | Extend to `… \| Harness behaviour`, filled per row. Rows that become "n/a (harness owns this)": exclusive memory slot (`:177`), Active Memory (`:178`), memory-core dreaming (`:179`), scheduled tasks/cron dispatcher (`:182`), compaction memory flush (`:186`). Rows that stay live: Skill Workshop (`:180`,`:181`), config-watcher handoff (`:183`), model-selection scopes (`:184`), forget/provenance (`:185`). The column is the drift tripwire for R2 |
| R7 | **The engine still assumes a workspace directory** (persona file, KNOWLEDGE.md, diary, ACL audit, run state) | `lib/persona-voice.js`; `index.js:3921`; `lib/dreaming/dream-diary.js:27`; `lib/acl-middleware.js:183-215` | `Host.workspaceDir(agentId)` stays mandatory in `HostServices`; a harness agent without a workspace gets a synthetic one under `Host.stateDir` |
| R8 | **Non-commercial model licences** (two Jina profiles, CC BY-NC 4.0) travel with the engine package | `lib/providers/local-model-artifacts.js:50-51`, `:79-80`; gate `:458`,`:468`; confirmed externally at https://huggingface.co/jinaai/jina-embeddings-v3 (checked 2026-09-22) | `acceptNonCommercialLicense` stays a required engine config flag; the harness surfaces it in setup (ADR-006) |

---

## (e) Recommendation on Q6 — two repos vs monorepo

**Recommendation: two repos, as A5 assumes — `Cyb3rb1ade/PLUR1BUS` (engine + OpenClaw adapter + control UI, published as three npm packages) and `Cyb3rb1ade/PLUR1BUS-Harness` (host, CLI, API, web UI).** This is for ADR-002 to accept formally.

Reasoning from the evidence:

1. **Release cadence is the binding constraint (D3, R1).** The plugin has a live user base pinned to `openclaw >= 2026.8.1` (`package.json:8-20`) and a compatibility document that already tracks a newer host (`docs/compatibility-openclaw.md:280`). A monorepo makes every plugin hotfix a harness-repo event. Two repos keep the plugin's release train intact, which D3 names as the reason for the default.
2. **The test suite is large enough to make CI cost real.** 502 files / 109 502 lines run with `--test-concurrency=1` (`package.json:41`). In a monorepo, harness changes would re-trigger it on every PR unless a task graph is tuned; in two repos the split is free.
3. **The coupling that would justify a monorepo is small and shrinking.** The adapter is ≈ 6 400 lines (research §10) against ≈ 68 000 engine lines, and PRs 01–14 reduce, not increase, the shared surface. The engine API sketched in §b is 12 methods — a size that survives semver.
4. **The counter-argument (engine-API churn during M1, A5's "would change if") is real but bounded.** Mitigation without a monorepo: publish the engine from CI on every merge as `0.x-<sha>` prereleases and have the harness consume that tag during M1, switching to semver ranges at M2. If churn still forces more than roughly one coordinated two-repo PR per week during M1, revisit — that is the concrete trigger for ADR-002 to flip.
5. **Licensing and provenance stay clean.** The harness is MIT (D10); the engine carries the CC BY-NC model gate (R8) in its own package where `acceptNonCommercialLicense` already lives (`lib/providers/local-model-artifacts.js:458`).

**What becomes harder with two repos:** cross-repo refactors need two PRs and a version bump; a breaking engine change is visible only at integration time. Both are absorbed by R2's dual-adapter CI and by the prerelease channel in point 4.

**What does not decide it:** the fact that PLUR1BUS is the core (D2) is orthogonal to repository layout — D2 constrains the *architecture* (engine-first, harness as native host, no plugin shim), and §a–§c satisfy it in either layout.
