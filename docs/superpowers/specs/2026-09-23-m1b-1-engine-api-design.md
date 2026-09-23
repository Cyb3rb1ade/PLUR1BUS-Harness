# M1b-1 — Engine API: `createEngine()`, recall contract, job ledger, principal, host-neutral `lib/`

**Status:** Draft for owner review · 2026-09-23 · Repo: `Cyb3rb1ade/openclaw-plur1bus-memory` (branch off `main` @ `01861add` + PR #185) · Contract: `types/engine.d.ts` 1.2.0 → 1.4.0 (expected)

## 1. Intent

M1a moved PLUR1BUS's recall, capture, command and tool bodies into `engine/**` and every `api.on`/`api.register*` call into `adapter/openclaw/**`, but `index.js` still constructs ~100 objects itself and threads them into the engine modules as 71- and 99-key context objects. `createEngine()` is declared in the contract and not implemented. M1b-1 finishes the extraction: **one construction path** (`createEngine(host, config)`), consumed identically by the OpenClaw adapter and, in M1b-2, by the harness daemon.

Owner decisions carried in: M1b decomposition into M1b-1 (this spec, PLUR1BUS repo) → M1b-2 (core daemon + CLI, harness repo) → M1b-3 (dreaming scheduler, harness repo); **A** = one construction path (OpenClaw adapter calls `createEngine()` too); **PR-08 = a** (ledger + retry from merge, with migration, plus a retry cap); dreaming phases are engine-owned jobs, not pluggable providers; gate answers G1–G7 = a. **OpenClaw is test harness, not customer** (owner, 2026-09-23): the PLUR1BUS suite and the golden-prefix corpus are the regression net; no behaviour is preserved *for* OpenClaw users; where harness and OpenClaw behaviour diverge, the adapter follows the engine. PR-14 (separate adapter package) is out of scope.

### Success criteria

1. `createEngine(createStubHost(), config)` constructs an `Engine` with no `openclaw` module on its import graph (transitive lint is the proof), and the OpenClaw adapter's `export default` is `createHostServices(api)` → `createEngine(...)` → nine `register-*.js(engine, api)`; `index.js` ≤ ~200 lines.
2. Full suite green and the golden-prefix corpus byte-identical through the adapter at every step, except where this spec names a behaviour change (PR-08 run semantics; L3 events are additive).
3. `recall()` never throws; abort at 100 ms cancels the embedder call and returns `degraded: { reason: "aborted" }` within 50 ms.
4. Every job run, including every skip, has a ledger row written before the body; a no-narrative REM run persists `incomplete` and is retried on the next sweep, at most twice.
5. `engine/**` and `lib/**` reachable from it contain no `openclaw` import (direct or transitive) and no `process.env.OPENCLAW_*` read.

## 2. Non-goals

PR-10 multi-identity recall (M2), PR-11 Windows named-pipe IPC, PR-12 bash→node scripts, PR-13 control-UI package, PR-14 adapter package rename, any harness code (M1b-2), the scheduler (M1b-3), fixing `truncateMemoryContext`'s warning branch (recorded follow-up of #185).

## 3. Architecture

### 3.1 Engine shape

```
createEngine(host: HostServices, config: EngineConfig): Engine
Engine = {
  contract: "1.4.0",
  open(agentId) → AgentStore, close({ budgetMs }) idempotent, status(),
  systemSupplement(agentId, ctx), recall(query), capture(turn) → CaptureHandle,
  checkpoint(agentId, reason), tools, commands, runCommand(...),
  jobs: JobRegistry, embedding, admin, events
}
```

Internals (pools, embedder/reranker services, caches, confirmation maps, meta-reflection counters, warn-once latches) live in one non-exported `EngineInternals` object created inside `createEngine()`. The M1a context objects (`hookCtx`, `toolCtx`, the 99-key command ctx) become views over `EngineInternals`, built once, not per call. Test seams: `HostServices.clock` and `HostServices.events` replace `api.__recallTimingSinkForTests`; a `createEngine(host, config, { internals?: Partial<EngineInternals> })` third argument (test-only, documented as such) replaces the golden driver's prototype patches for the embedder.

`Engine.close()` takes `{ budgetMs }`, runs the existing shutdown owner (`lib/runtime-shutdown.js` moves into the engine as the close path; its OpenClaw-specific `runtimeIfUsable` stays in the adapter), and is idempotent.

### 3.2 Recall (PR-04, PR-05, PR-09)

```
RecallQuery  = { agentId, principal, agentContext, text, signal: AbortSignal /* required */, budget?: { capChars } }
RecallResult = { blocks: ContextBlock[], capChars, degraded: Degraded | null, timing: { phases, totalMs } , deferrals: Deferral[] }
ContextBlock = { name: "time"|"temporal"|"reminder"|"neo"|"start"|"memories", text, droppable, chars }
Deferral     = { block, kind: "clipped"|"dropped", from: number, to: number, reason }
```

- The engine returns blocks as data. **The host joins and caps**: the OpenClaw adapter calls `applyGlobalInjectBudget` (post-#185, record-boundary cuts) and returns `{ prependContext }`; the harness lays blocks into its cache zones (M2). Golden gate: the adapter's joined string is byte-identical to today's oracle.
- **L3:** every clip/drop of a block emits `recall.block-clipped` / `recall.block-dropped` via `host.events` and appends a `Deferral`. The inner memories cap (`recall.memoriesMaxChars`) reports through the same channel. No silent truncation remains on the recall path.
- **`signal` is mandatory** and threaded into embedder, reranker and LanceDB calls (`lib/setup/memory-host-runtime.js` stops dropping it). Abort ⇒ `recall()` resolves with `degraded: { reason: "aborted", capability: "recall" }` and whatever blocks were complete. Adapter passes `AbortSignal.timeout(recallTimeoutMs)`; harness passes its 400/600 ms budget (G6).
- **One timeout owner for rerank (PR-09):** the pipeline `Promise.race` is removed; the provider's `AbortController` is driven by `AbortSignal.any([callerSignal, AbortSignal.timeout(rerankTimeoutMs)])`. Test: exactly one timer, HTTP request aborted.
- `timing` replaces the M1a `recallTimingSink`; the bench probe reads `RecallResult.timing`.

### 3.3 Jobs (PR-07, PR-08) and checkpoint (PR-15)

```
JobSpec  = { name, phase?: "light"|"rem"|"deep", cron?: string, run(ctx: JobContext) → Promise<JobRun> }
JobRun   = { runId, job, phase, agentId, trigger, startedAt, finishedAt, outcome, reason?, attempt, cost }
outcome  = "completed"|"skipped"|"incomplete"|"failed"|"abandoned"
cost     = { provider?, model?, inputTokens?, outputTokens?, ms }
Engine.jobs = { list(), run(name, agentId, { signal, trigger: "cron"|"manual"|"harness" }), history(agentId, { job?, since?, limit? }) }
```

- Registry holds the 18 names (11 cron specs from `lib/setup/feature-cron-plan.js`, 6 RPC/CLI features, `light-dream`). One owner per name; phases are engine-owned, not pluggable. `/plur1bus internal <feature>` and `plur1bus.feature.run` become thin callers of `jobs.run`.
- **Run ledger:** append-only JSONL at `<stateDir>/<agentId>/jobs/ledger.jsonl`, one `JobRun` per line. "Written before any early return" is implemented as: `jobs.run()` writes a `<runId>.started` marker before invoking the body; every exit of the body — normal completion, each skip site, thrown error — goes through `ledger.record(outcome, reason)`, which appends the row and removes the marker. There is no code path that returns from a job body without a row: skip sites are `return ctx.skip(reason)`, not bare `return`. A marker without a row at next start is recorded as `failed` with reason `crash`. Skip reasons (`no_llm_config`, `too_few_memories`, `already_processed`, …) are rows with `outcome: "skipped"`, logged at `info`.
- **Semantics (behaviour change, owner decision a):** `already_processed` only after a `completed` row for the same idempotency key (transcript digest); `incomplete` (e.g. REM produced no narrative) is retried on the next sweep with `attempt+1`, **max 2 retries**, then `abandoned` with the reason written to the dream diary; the circuit breaker (3 LLM sessions/sweep) counts ledger rows, so retries cannot bypass it. Diary write outcome is part of the row.
- **Migration:** on first open, `runs.json` `completed[runKey]` entries become `completed` rows with `cost: { ms: 0 }` and `migrated: true`; `runs.json` is renamed `runs.json.migrated` and never read again.
- **`checkpoint(agentId, reason: "compaction"|"session-end"|"manual")`** replaces the `event.compactedAt` read; reactivation recall keys off the same timestamp. Adapter may register `before_compaction`; harness calls it from its compaction path.

### 3.4 Principal (PR-06) and host-neutral `lib/` (G1)

- `Principal` (`trust: "proved"|"inferred"`) and `AgentContext` (`origin`, channel, session) are explicit inputs to `recall`, `capture`, `runCommand`, `tools`. `resolveMemoryRequestContext` becomes a constructor from `Principal`; the adapter keeps `resolveHostHookMemoryContext` + the `reply_dispatch` ticket and produces `trust: "proved"`; the harness mints `proved` at admission. `inferred` degrades to agent-private and never throws (existing behaviour, now a contract test).
- Cron/subagent string matching in `index.js` is replaced by `AgentContext.origin` supplied by the caller. Channel vocabulary becomes a registry set (`engine.channels.register(name)`), seeded with today's list.
- **G1 closure:** (1) `lib/memory-request-context.js` loses its `import("openclaw/plugin-sdk/routing")` default parameter — the routing loader is injected via `HostServices.routing?` (adapter supplies OpenClaw's; harness its own; absent ⇒ agent-private); (2) the 8 `OPENCLAW_HOME`/`OPENCLAW_CONFIG_PATH` reads in `engine/**` go through `host.stateDir` / new `host.configPath()`; (3) the five pre-`register()` `api`-taking functions move to `adapter/openclaw/`. Gate: `scripts/lint-engine-imports.mjs` gains a transitive mode (graph walk over `lib/` from `engine/**`) and a rule "no `process.env.OPENCLAW_*` outside `adapter/`"; both red on `main` today, green at the end.

### 3.5 Contract evolution

Expected bumps, each with its reason in the `.d.ts` header changelog: 1.3.0 `HostServices.configPath()` + `HostServices.routing?`; `RecallResult` gains `timing`, `deferrals`; `JobRun.outcome` union; `CheckpointReason`; `createEngine` third (test) argument. Final: 1.4.0. `types/engine.conformance.ts` moves with each bump in the same commit.

## 4. Order of work and gates

| Step | Scope | Gate (in addition to full suite + golden byte-identity) |
|---|---|---|
| 1 | PR-04 blocks + L3 deferrals/events | adapter join byte-identical; event emitted per clip/drop in a fixture that overflows |
| 2 | PR-05 mandatory signal | abort at 100 ms ⇒ embedder cancelled, result ≤ 50 ms, `degraded.reason = "aborted"` |
| 3 | PR-09 single rerank timeout owner | one timer; HTTP abort observed |
| 4 | PR-15 checkpoint | reactivation timestamp identical when only `compactedAt` given |
| 5 | PR-07 JobRegistry | `run()` returns `JobRun` for all 18 names incl. skip paths |
| 6 | PR-08 ledger + retry + migration (**behaviour change**) | no-narrative REM ⇒ `incomplete`, retried next sweep, `abandoned` after 2; `already_processed` only after `completed`; migration test on a real `runs.json` fixture; breaker counts ledger rows |
| 7 | PR-06 Principal/AgentContext, channel registry | `proved` reaches user scope; `inferred` agent-private, never throws; six-step proof unchanged in adapter |
| 8 | G1 host-neutral `lib/` | transitive lint green; env lint green |
| 9 | `createEngine()` + `index.js` reduction | stub-host construction; no `openclaw` in graph; `index.js` ≤ ~200 lines; `close()` idempotent under budget |
| 10 | Docs: `docs/engine-api.md` 1.4.0, CHANGELOG, compatibility matrix | config-docs contract test |

Behaviour changes allowed: step 6 (run semantics), L3 events (additive), `HOME` already done. Everything else byte-identical.

## 5. Testing

TDD per step. New contract tests live in `tests/engine-*.test.js` and run against `createStubHost()`; adapter tests keep running against the stub OpenClaw `api`. Golden corpus: unchanged oracle for all seven scenarios; add `recall-aborted` (signal fires mid-recall) and `jobs-ledger-retry` (REM incomplete → retry → abandoned, virtual clock) as new scenarios. The M1a bench probe (`bench/recall-budget-probe.mjs`) switches to `RecallResult.timing` and is re-run at the end to confirm no regression against `bench/results/2026-09-22-recall-budget-probe.md`.

## 6. Risks

- **R1 boundary rework** (from `engine-extraction.md` §d): the ctx-object → `EngineInternals` refactor may expose hidden coupling. Mitigation: step 9 is last; steps 1–8 keep the ctx objects and only change what they carry.
- **PR-08 file-format change** on the owner's production VPS: migration is one-way and tested on a fixture copied from the real `runs.json` shape; `runs.json.migrated` is kept.
- **Transitive lint false positives**: `lib/` modules the engine never imports at runtime but that import `openclaw` (e.g. `lib/setup/*-plugin-runtime.js`) are excluded by the existing forbidden list, not by the graph walk.

## 7. Open questions

None blocking. Recorded for M1b-2: whether `HostServices.routing` should be replaced by a host-neutral routing interface once the harness has its own; whether `Engine.status()` should expose ledger-derived health (last run per job) for `doctor`.
