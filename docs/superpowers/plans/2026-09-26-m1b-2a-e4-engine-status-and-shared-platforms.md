# M1b-2a engine work: E4 (status with ledger health and model readiness, replay-safe capture, shared memory on macOS/Windows). Implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `Engine.status()` reports what a harness needs for `core.status`, `/status`, `dreams status` and `1staid check` — last run per job, breaker state, running jobs and unreadable ledger lines from the job ledger, the journal backlog when the host reports one, embedder/reranker readiness (`loading | ready | failed | disabled`) with an explicit `Engine.models.warm()` entry point, and whether explicit shared memory works on this platform — plus Q3 (a journal replay of a turn never runs the capture pipeline twice) and a typed `unsupported` failure for shared memory where it is unavailable. The last two tasks add a **verified-path** shared-memory mode for macOS and Windows and are gated on an owner decision. Contract **1.8.0**, additive.

**Architecture:** Three small engine units feed one status reporter: `createJobRegistry().health()` derives per-agent job health from ledger snapshots cached by `(size, mtimeMs)`; `engine/providers/model-readiness.js` turns E3's `embeddingProbe` plus a new reranker probe into `ModelsStatus` and `warm()`; `engine/status/status-reporter.js` assembles `EngineStatus` (including `degraded` derived from models, the host's `journalBacklog` capability under a 50 ms cap, and `SharedMemoryPool.support()`). Q3 is a persisted per-agent turn-replay guard in front of the typed `Engine.capture` path only (the OpenClaw hook path does not go through `Engine.capture`). Shared memory keeps Linux's fd-capability routing unchanged; elsewhere it fails with MemoryOpError `unsupported` until the owner-gated tasks add `VerifiedPathDirectory`, a drop-in for `DirectoryCapability` backed by per-segment `lstat` walks, dev/ino identity checks and an owner-only shared root.

**Tech stack:** engine repo `Cyb3rb1ade/openclaw-plur1bus-memory` (ESM JavaScript, `types/engine.d.ts` + `types/engine.conformance.ts`, `node --test`, LanceDB). Node ≥ 24.16 (`/home/claude/.node24/bin` in the cloud session). Branch `feat/e4-engine-status` from `main` at `3a4426a5` (merge of #193, E3, contract 1.7.0).

**Spec:** `docs/superpowers/specs/2026-09-24-m1b-2a-core-daemon-cli-design.md` (harness repo) — §7 row **E4** ("`status()` with ledger-derived health (last run per job, breaker state, journal backlog if the host reports one) and readiness of models", additive); **Q3** ("confirm in E4 that a replay is never counted as a new LLM session"); §5 lifecycle (journal replay at core start; "`core.status.degraded = { reason: "models-warming" }` until they are ready"); §6 CLI table (`1staid check`: last job runs, journal backlog; `dreams status`: breaker, retries, `already_running`, ledger health); **D21** (`/status`, `/health` → `core.status`); **D31** (shared copies — the feature that is dead on macOS/Windows today); **D8** (targets macOS arm64, Linux, Windows); benchmark **B11** (`core.status` roundtrip p95 < 5 ms). Engine background: `docs/superpowers/plans/2026-07-21-b13-acl-wiki-share.md` (fail-closed shared pool, Task 6), `docs/audits/2026-07-20-b12-core-recall-namespaces-fix.md` (directory capabilities are Linux-evidenced).

## 2a-E sequence

| Step | Branch / PR | Contract | Status |
|---|---|---|---|
| E1 | `feat/e1-memory-ops` | 1.5.0 | merged `215193e5` (#188) |
| E2 | `feat/e2-admin-ops` | 1.6.0 | merged (#192) |
| E3 | `feat/e3-embedding-service` | 1.7.0 | merged `3a4426a5` (#193) |
| **E4** | `feat/e4-engine-status` | **1.8.0** | **this plan** |
| E5 … E7 | see the spec's §7 table | | |

The harness side — calling `engine.models.warm({ signal })` in the background after `ready`, mapping `EngineStatus` onto `core.status`/`1staid check`/`dreams status`, implementing `HostCapabilities.journalBacklog` over `state/journal/*.jsonl`, giving journal lines a stable `runId` — is 2a-H3's work.

## Global constraints

- Contract amendment policy (`types/engine.d.ts:23-31`): every observable shape change bumps `ContractVersion`; `ContractVersion`, `types/engine.conformance.ts` and both adapters move together in one PR. E4 bumps once, to `"1.8.0"`, in Task 1. Literal sites (grep `1\.7\.0` excluding `package-lock.json`, `CHANGELOG.md` history, `.superpowers/`): `types/engine.d.ts` (line 4, line 5 "amended eight times" → "nine", changelog after line 40, `ContractVersion` line 43), `types/engine.conformance.ts:107`, `engine/create-engine.js` (3492, 3494, 3507), `tests/engine-contract.test.js` (46, 48, 51, 384, 386, 387), `docs/engine-api.md` (3 incl. "amended eight times", 530, 579). Historical "(1.7.0)" member annotations stay.
- Engine gate per task: `npm run lint && npm test` (~10 min; **590000 ms** timeout) plus `TZ=UTC node --test tests/golden-prefix.test.js` (golden **11/11**). The base is fully green; a failure is yours until proven otherwise.
- Conventions from E1-E3: every new `engine/**/*.js` file is registered in `tests/helpers/runtime-sources.js` `ENGINE_PATHS` **and** `scripts/lib/deploy-integrity.mjs` `DEPLOY_FILES`; new `lib/*.js` files go into `DEPLOY_FILES`; tests use `makeTempDir` from `tests/helpers/temp-dir.js`, never `mkdtempSync`; typed failures are `MemoryOpError` (`engine/memory-ops/errors.js`) with fixed, log-safe English messages; raw exceptions go to `logger.warn`/`debug` only.
- `engine/**` never imports `openclaw`, `lib/host-services.js`, `lib/runtime-shutdown.js`, `lib/providers/openclaw-memory-embedding-adapters.js` or `lib/setup/*-plugin-runtime.js`, never reads a bare `api` or `process.env.OPENCLAW_*`, and new code never consults `host.runtime` (`scripts/lint-engine-imports.mjs`, `lint-no-api-outside-adapter.mjs`).
- `status()` is read-only and cheap: it never creates a directory, opens LanceDB, loads a model or calls a provider, never rejects, and stays inside the B11 budget (no per-call full ledger re-read when nothing changed; the host capability capped at 50 ms).
- Linux behaviour of shared memory is unchanged in every task: fd-capability routing (`lib/directory-capability.js`) stays the only Linux mode, and every existing `tests/b13-*` case passes unchanged.
- The OpenClaw path is behaviour-neutral except for the `/share` reply on a platform without shared memory (Task 6). The adapter's capture hook does not go through `Engine.capture`, so the Q3 guard does not touch it.
- No new third-party dependency, no native addon.
- Commit identity via `git -c user.name=Cyb3rb1ade -c user.email=84099452+Cyb3rb1ade@users.noreply.github.com commit …`; body trailers `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01SxcLhve6hyM9AFm2nU9B3F`. Never `git stash`, never `--amend`, never push, never change git config; pushes and merges are the owner's (via the Mac). Ignore stop-hook demands about identity/amend/push.
- Never put secrets, tokens or real user data in the repo, logs or test fixtures. Paths, agent ids, SIDs, model names and texts in tests are synthetic.
- **Tasks 9 and 10 are security-sensitive and are dispatched only after the owner's explicit yes to the ADR's recommendation (Task 7).** Tasks 1-8 ship a complete, mergeable 1.8.0 without them.

## Controller rulings (2026-09-26, binding)

- **C1 readiness before warm-up:** `ModelState` keeps four values; `loading` with `checkedAt: null` means "not probed yet" and `docs/engine-api.md` says so. A fifth state is not added — cost if wrong: one additive enum value later.
- **C2 replay key:** the harness journal (2a-H3 Task 15) gives every line a stable `runId`; E4's guard keys on it as planned.
- **C3 golden corpus:** 11/11 (current main), not the spec's historic 9/9.
- **C4 Tasks 9–10 (verified-path mode, incl. the Windows ACL check via `powershell.exe`):** not dispatched until the owner answers in chat. Tasks 1–8 ship a complete 1.8.0 without them.
- **C5 Task 10 test seam:** implementer's choice between the internals view and `testOptions.sharedMemoryMode`, recorded in the report.

## Review focus

1. **Status cost under real ledgers:** a months-old `ledger.jsonl` and several agents must not make every 5 s `core.status` poll re-read and re-parse every ledger; a hung or throwing `journalBacklog` capability must not delay `status()` beyond its cap. Pinned in Tasks 2 and 4.
2. **Broken ledger state:** a torn last line, a non-JSON line, a missing `_jobs` root and an unreadable `_jobs` root must surface as `unreadableLines` / `ledger: "unavailable"`, never as a rejected `status()`. Pinned in Tasks 2 and 4.
3. **Replay across a core restart and after a failed capture:** the journal is replayed by a *new* process, so the replay guard must persist; a capture that failed (embedder down, aborted) must not be recorded, or its replay would be swallowed and the fact lost. Pinned in Task 5.
4. **Readiness before and during warm-up:** before any probe the embedder is `loading` with `checkedAt: null`; while a probe runs `warming: true`; an aborted `warm()` leaves `loading`, not `failed`; a failed reranker never marks the embedder failed; after `close()` `status()` still resolves. Pinned in Tasks 3 and 4.
5. **Share on a platform without shared memory:** `share` and `proposals.accept` answer `unsupported` before any row, archive or `.plur1bus-shared` directory is written; shared reads still answer empty; the OpenClaw `/share` reply says why instead of the generic failure. Pinned in Task 6.

---

### Task 1: Contract 1.8.0 — types, conformance pins, literal sites

**Files:**
- Modify: `types/engine.d.ts` (header 4-5, changelog after 40, `ContractVersion` 43; `HostCapabilities` 203-213; `MemoryOpErrorCode` 537-539; Embedding block after 463; `EngineStatus` 669-675; `Engine` 685-715)
- Modify: `types/engine.conformance.ts` (pin line 107; new pins after the 1.7.0 block at 145)
- Modify: `engine/create-engine.js` (3492, 3494, 3507 only), `tests/engine-contract.test.js` (46, 48, 51, 384, 386, 387)

**Interfaces (produces; later tasks implement exactly this):**

```ts
export type ContractVersion = "1.8.0";

export type MemoryOpErrorCode =
  | "not-found" | "denied" | "invalid-input" | "approval-required"
  | "conflict" | "storage"
  /** 1.8.0: the operation needs a capability this engine does not have on this platform (e.g. shared memory). */
  | "unsupported";

/** 1.8.0: what the host knows about turns it journaled while the engine was unavailable. */
export interface JournalBacklog { entries: number; oldestAt: number | null }
export interface HostCapabilities {
  /* existing members unchanged */
  /** 1.8.0: read by Engine.status(); absent, throwing, invalid or slower than 50 ms → `EngineStatus.journal: null`. */
  journalBacklog?(): JournalBacklog | null | Promise<JournalBacklog | null>;
  [capability: string]: unknown;
}

// ---- Models ----
export type ModelState = "loading" | "ready" | "failed" | "disabled";
export type RerankerProbeError = "aborted" | "provider-failed" | "invalid-result";
export interface ModelReadiness {
  /** loading: not confirmed yet (checkedAt null) or first probe running; the embedder is never "disabled". */
  state: ModelState;
  /** true while a probe is in flight. */
  warming: boolean;
  /** Clock time of the completed probe that set `state`; null before any, and when disabled. */
  checkedAt: number | null;
  /** Only when state === "failed". */
  error?: EmbeddingProbeError | RerankerProbeError;
}
export interface ModelsStatus {
  embedder: ModelReadiness & { identity: EmbeddingIdentity };
  reranker: ModelReadiness & { provider: string | null };
}
/** warm(): probes embedder and reranker concurrently (embedding.probe semantics: coalesced, memoized on success,
 *  `refresh` forces new provider calls, `signal` ends only this caller's wait) and resolves the status afterwards.
 *  Never rejects for a provider failure; rejects MemoryOpError `storage` ("engine is closed") after close(). */
export interface ModelsService {
  status(): ModelsStatus;
  warm(opts?: { signal?: AbortSignal; refresh?: boolean }): Promise<ModelsStatus>;
}

// ---- Status ----
export interface JobLastRun {
  runId: string; outcome: JobOutcome; reason?: string; trigger: JobTrigger;
  startedAt: number; finishedAt: number; attempt: number;
}
export interface BreakerState { sweep: string; sessions: number; limit: number; open: boolean }
export interface AgentJobHealth {
  agentId: AgentId;
  /** Latest finished run per job (by finishedAt); jobs that never ran are absent. */
  lastRuns: Partial<Record<JobName, JobLastRun>>;
  /** Jobs with a run in flight in this process, sorted. */
  running: JobName[];
  /** rem/deep LLM-session breaker for the current UTC sweep, in-flight sessions included. */
  breaker: BreakerState;
  /** Ledger lines that could not be parsed. */
  unreadableLines: number;
}
export interface JobsHealth { ledger: "ok" | "unavailable"; agents: AgentJobHealth[] }
export type SharedMemoryMode = "fd-capability" | "verified-path" | "unavailable";
export interface SharedMemorySupport {
  supported: boolean;
  mode: SharedMemoryMode;
  /** Why it is unsupported: the platform lacks a mode, the shared root failed its safety check, the Windows ACL
   *  reader is missing, or the root's identity changed during a lease (pool refuses until restart). */
  reason?: "platform" | "unsafe-root" | "acl-tool-unavailable" | "identity-changed";
}
export interface EngineStatus {
  ready: boolean;
  /** 1.8.0: derived from models — embedder failed → {reason:"model-failed",capability:"embedding"}; embedder loading →
   *  {reason:"models-warming",capability:"embedding"}; reranker failed → model-failed/"reranker"; reranker loading →
   *  models-warming/"reranker"; first match wins; otherwise null. */
  degraded: Degraded | null;
  agents: number;
  contract: ContractVersion;
  storeSchema: { current: SchemaVersion | null; expected: SchemaVersion };
  /** 1.8.0 */ jobs: JobsHealth;
  /** 1.8.0 */ models: ModelsStatus;
  /** 1.8.0: null when the host reports none. */ journal: JournalBacklog | null;
  /** 1.8.0 */ sharedMemory: SharedMemorySupport;
}
export interface Engine { /* … */ models: ModelsService; /* after embedding */ }
```

Changelog line: `1.8.0 — EngineStatus.jobs/models/journal/sharedMemory, degraded derived from model readiness; Engine.models (status, warm); HostCapabilities.journalBacklog?; MemoryOpErrorCode "unsupported"; CaptureResult.reason "duplicate-turn" (E4).` Also extend the `CaptureResult.reason` comment: `"duplicate-turn": the same turn was already captured (Q3, E4)`.

- [ ] **Step 1:** Edit `types/engine.d.ts` as above (add, never reorder).
- [ ] **Step 2:** `types/engine.conformance.ts`: import the new names, pin `"1.8.0"`, and under `// 1.8.0: status health, models, journal, shared memory, unsupported (E4 Task 1).` add: `Exact<Engine["models"]["warm"], (opts?: { signal?: AbortSignal; refresh?: boolean }) => Promise<ModelsStatus>>`; `Exact<ModelState, "loading" | "ready" | "failed" | "disabled">`; `Exact<EngineStatus["journal"], JournalBacklog | null>`; `Exact<EngineStatus["sharedMemory"]["mode"], "fd-capability" | "verified-path" | "unavailable">`; `"unsupported" extends MemoryOpErrorCode ? true : false`; `Exact<AgentJobHealth["lastRuns"], Partial<Record<JobName, JobLastRun>>>`; and a host literal `const hostWithJournal: HostServices = { ...minimalHost, capabilities: { journalBacklog: () => ({ entries: 0, oldestAt: null }) } }; void hostWithJournal;`.
- [ ] **Step 3:** Bump the three `create-engine.js` literals and the six test hits. No runtime change (status gains its fields in Task 4; `npm run typecheck` does not type-check the JS implementation).
- [ ] **Step 4:** `npm run lint && npm run typecheck && node --test tests/engine-contract.test.js`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(contract): 1.8.0 — status health, models, journal backlog, shared-memory support, unsupported (pins)`.

### Task 2: Job health from the ledger

**Files:**
- Modify: `engine/jobs/job-ledger.js` (add `snapshot()`; `readAll()` becomes `snapshot().rows`)
- Modify: `engine/jobs/job-registry.js` (in-flight run map in `run`/`finish`; new `health()` in the returned object at 469-481)
- Test: `tests/job-registry-health.test.js`

**Interfaces:**
- Produces:
  ```js
  // job-ledger.js — one read; unreadable = count of non-empty lines that failed JSON.parse or are not objects (warn-once unchanged)
  snapshot(): { rows: object[], unreadable: number }
  // job-registry.js
  health(): JobsHealth   // types/engine.d.ts; synchronous, never throws
  createJobRegistry({ host, jobsRoot = null, idFactory, createLedger = createJobLedger })   // test seam; ledgerFor() uses it
  ```
- `health()` algorithm: `jobsRoot === null` → `{ ledger: "ok", agents: [] }`. Agents = `readdirSync(jobsRoot, { withFileTypes: true })` directories whose name passes `safeAgentId` unchanged, ∪ agents with in-flight runs; `ENOENT` → none; any other readdir error → `logger.debug(...)` and `{ ledger: "unavailable", agents: <in-flight agents only> }`. Per agent: `statSync(ledger.paths.ledger)` → cache key `${size}:${mtimeMs}` in a per-registry `Map(agentId → { key, rows, unreadable })`; re-`snapshot()` only when the key changed (missing file → rows `[]`). `lastRuns[job]` = row with the greatest `finishedAt` per job, projected to `JobLastRun` (no other fields). `running` = sorted unique job names from a new `inflightRuns: Map<runId, { agentId, job }>` (set in `run()` right after `ledger.writeMarker`, or after the dry-run/ledgerless early exits are passed; deleted in `finish()`), so non-singleton jobs count too. `breaker`: `sweep = sweepKey(clock())`, `sessions` = rows with `row.sweep === sweep && row.llmSession === true && BREAKER_PHASES.has(row.phase)` + `inflightSessions.get(\`${agentId}\u0000${sweep}\`) ?? 0`, `limit = BREAKER_LIMIT`, `open = sessions >= BREAKER_LIMIT`. A per-agent stat/read failure other than ENOENT → that agent reported with `lastRuns: {}` and `unreadableLines: 0`, top-level `ledger: "unavailable"`. Agents sorted by id; result deep-frozen.

- [ ] **Step 1: Write the failing tests** (`createJobRegistry({ host: { logger, clock: () => now }, jobsRoot: makeTempDir("e4-jobs-") })`, bodies bound with `registry.bind`):
  - (a) `"health reports the latest run per job with outcome, reason, trigger and attempt"`: run `gc-run` twice (completed, then a body throwing → `failed`, reason `error:Error`) and `feedback-report` once with `trigger: "cron"`; `health().agents[0].lastRuns["gc-run"]` deep-equals `{ runId, outcome: "failed", reason: "error:Error", trigger: "manual", startedAt, finishedAt, attempt: 1 }` of the second run; `lastRuns["feedback-report"].trigger === "cron"`; `"rem-dream" in lastRuns === false`.
  - (b) `"health counts the rem/deep breaker for the current sweep including in-flight sessions"`: seed `ledger.jsonl` with three rows `{ v: 1, job: "rem-dream", phase: "rem", sweep: sweepKey(now), llmSession: true, outcome: "completed", … }` → `breaker` deep-equals `{ sweep: sweepKey(now), sessions: 3, limit: 3, open: true }`; rows of yesterday's sweep do not count; a `rem-dream` body parked on a deferred shows `running: ["rem-dream"]` and one extra session until released.
  - (c) `"health lists a running non-singleton job"`: a parked `feedback-report` body → `running` contains `"feedback-report"`; after release `running` is `[]`.
  - (d) `"health counts unreadable ledger lines and survives a torn last line"`: ledger with one valid row, `"not json"`, and a trailing `{"v":1,"job":` → `unreadableLines === 2`, one `lastRuns` entry.
  - (e) `"health does not re-read an unchanged ledger"`: wrap `createJobLedger` via a spy on the ledger's `snapshot` (expose `ledgerFor` through an optional `createLedger = createJobLedger` factory parameter of `createJobRegistry`) → two `health()` calls with no run between them call `snapshot` once; a run in between calls it again.
  - (f) `"health reports an unavailable ledger root instead of throwing"`: `jobsRoot` is a regular file → `{ ledger: "unavailable", agents: [] }` and a debug line; a missing `jobsRoot` directory → `{ ledger: "ok", agents: [] }`.
- [ ] **Step 2:** Run `node --test tests/job-registry-health.test.js`. Expected: FAIL (`health` is not a function).
- [ ] **Step 3:** Implement `snapshot()`, the `createLedger` factory option, `inflightRuns`, `health()`.
- [ ] **Step 4:** Run the file plus every `tests/*job*.test.js` and `tests/engine-contract.test.js`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(jobs): ledger-derived health — last run per job, breaker, running jobs, unreadable lines`.

### Task 3: Model readiness and `Engine.models`

**Files:**
- Modify: `engine/providers/embedding-service.js` (`createEmbeddingProbe` return object gains `pending()`)
- Create: `engine/providers/model-readiness.js`
- Modify: `engine/create-engine.js` (after `embeddingProbe` at 3410-3416: build `rerankerProbe` and `modelsService`; `engine.models`; `internals.modelsService`)
- Modify: `tests/helpers/runtime-sources.js`, `scripts/lib/deploy-integrity.mjs`
- Test: `tests/engine-models-readiness.test.js`

**Interfaces:**
- Consumes: `embeddingProbe.probe/lastResult/lastAttempt` (E3), `raceAbort` from `lib/abort.js`.
- Produces:
  ```js
  // embedding-service.js
  pending(): boolean                      // a provider call is running or queued
  // model-readiness.js
  export const RERANK_PROBE_QUERY = "plur1bus reranker probe";
  /** → { probe(opts?): Promise<{ ok, error?, cached, durationMs, checkedAt }>, lastAttempt(): object|null, pending(): boolean } */
  export function createRerankerProbe({ getReranker, logger, clock = Date.now })
  /** Pure: ModelReadiness from a probe's lastAttempt() and pending(); `disabled` → { state: "disabled", warming: false, checkedAt: null }. */
  export function readinessOf({ lastAttempt, pending, disabled = false })
  /** → ModelsService (types/engine.d.ts) */
  export function createModelsService({ embeddingProbe, rerankerProbe, getIdentity, getReranker, getRerankerProvider })
  ```
- `readinessOf`: `disabled` → disabled; `lastAttempt` null → `{ state: "loading", warming: pending, checkedAt: null }`; `lastAttempt.ok` → `{ state: "ready", warming: pending, checkedAt }`; else `{ state: "failed", warming: pending, checkedAt, error }`. The latest completed attempt decides (a failed refresh after a success reports `failed`); an abort never completes an attempt, so it never yields `failed`.
- `createRerankerProbe`: same coalescing as the embedding probe — one in-flight provider call shared by concurrent callers, memoized on success, `refresh: true` queues one new call behind a running one, each caller races its own `signal` (`{ ok: false, error: "aborted" }` for that caller only). Provider call: `getReranker().rerank(RERANK_PROBE_QUERY, ["plur1bus probe document one", "plur1bus probe document two"], 1)` with no signal; throw → `provider-failed` (raw error to `logger.warn("reranker.probe: provider failed: …")`); not an array, or any hit without integer `index` in `[0, 2)` and finite `score` → `invalid-result`. `getReranker()` null → probe resolves `{ ok: false, error: "provider-failed", … }` without calling anything (never reached through `warm`, which skips a disabled reranker).
- `createModelsService.status()` = `{ embedder: { ...readinessOf(embeddingProbe), identity: getIdentity() }, reranker: { ...readinessOf({ …rerankerProbe, disabled: getReranker() == null }), provider: getRerankerProvider() } }`; `warm(opts)` = `Promise.all([embeddingProbe.probe(opts), reranker ? rerankerProbe.probe(opts) : null])` then `status()`.
- Engine wiring: `getReranker: () => internals.reranker ?? null`; `getRerankerProvider: () => internals.reranker ? (internals.rerankerCfg?.provider ?? null) : null` (re-grep where `rerankerCfg` lands in `internals`; if it is not there, pass it from the `createRuntimeRerankerProvider` call site); `engine.models = Object.freeze({ status: () => modelsService.status(), warm: async (opts) => { assertMemoryOpen(); return memoryOpsContext.track(() => modelsService.warm(opts)); } })`.

- [ ] **Step 1: Write the failing tests** (engine per `tests/engine-close-inflight.test.js` `config()`/`stubHost()`, `testOptions.internals.embeddings` a counting 384-dim stub, `internals.reranker` a stub `{ rerank: async (q, docs, n) => [{ index: 0, score: 0.9 }] }` counting calls, or `null`):
  - (a) `"models report loading before any probe and ready after warm"`: fresh engine → `models.status().embedder` has `state: "loading", warming: false, checkedAt: null`, `identity` deep-equals `embedding.identities()[0]`; `await models.warm()` → embedder and reranker `state: "ready"`, `checkedAt` numbers; embedder/reranker call counts 1/1; a second `warm()` makes no new calls; `warm({ refresh: true })` makes one more of each.
  - (b) `"a disabled reranker reports disabled and is never probed"`: `internals.reranker = null` → `reranker` deep-equals `{ state: "disabled", warming: false, checkedAt: null, provider: null }` before and after `warm()`.
  - (c) `"warming is visible while a probe runs and an abort leaves loading"`: embedder parked on a deferred; `const w = models.warm({ signal: AbortSignal.timeout(20) })`; `models.status().embedder.warming === true`; `await w` resolves (no reject) with `embedder.state === "loading"`; release → `status().embedder.state === "ready"`, `warming === false`.
  - (d) `"a failing reranker does not fail the embedder"`: reranker throws `new Error("boom sk-secret")` → `reranker: { state: "failed", error: "provider-failed" }`, `embedder.state === "ready"`, the status JSON contains no `"sk-secret"`; reranker returning `[{ index: 7, score: 1 }]` → `invalid-result`.
  - (e) `"a failed refresh after a success reports failed"`: warm ok, then the embedder throws, `warm({ refresh: true })` → `embedder: { state: "failed", error: "provider-failed" }`.
  - (f) `"warm after close rejects storage"`: `await engine.close()` → `models.warm()` rejects `MemoryOpError` `storage` "engine is closed"; `models.status()` still returns.
- [ ] **Step 2:** Run the file. Expected: FAIL (`engine.models` undefined).
- [ ] **Step 3:** Implement; register `engine/providers/model-readiness.js`.
- [ ] **Step 4:** Run the file, `tests/engine-embedding-probe.test.js`, `tests/engine-contract.test.js`, `tests/deploy-integrity.test.js`, `tests/lint-engine-imports.test.js`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(models): embedder and reranker readiness, Engine.models.warm() as the warm-up entry point`.

### Task 4: `Engine.status()` assembles health, models, journal and shared-memory support

**Files:**
- Create: `engine/status/status-reporter.js`
- Modify: `lib/shared-memory-pool.js` (add `support()`; `this.mode` set in the constructor: `this.supported ? "fd-capability" : "unavailable"`)
- Modify: `engine/create-engine.js` (`status()` at 3502-3510 delegates to the reporter)
- Modify: `tests/helpers/runtime-sources.js`, `scripts/lib/deploy-integrity.mjs`, `tests/engine-contract.test.js` (the status case at 46-54 asserts the new keys)
- Test: `tests/engine-status-health.test.js`

**Interfaces:**
- Consumes: `jobs.health()` (Task 2), `modelsService.status()` (Task 3).
- Produces:
  ```js
  export const JOURNAL_BACKLOG_TIMEOUT_MS = 50;
  /** Pure: Degraded | null from ModelsStatus, in the order fixed by the EngineStatus.degraded doc comment. */
  export function degradedFromModels(models)
  /** Validated copy or null: entries a non-negative safe integer, oldestAt a finite number or null, no other keys kept. */
  export function normalizeJournalBacklog(value)
  /** → { status(): Promise<EngineStatus> } — never rejects. */
  export function createStatusReporter({ jobs, models, sharedMemoryPool, storeMigrator, expectedSchema, openedAgents, host, contract })
  // lib/shared-memory-pool.js
  support(): SharedMemorySupport   // no filesystem access; reason "platform" when !supported
  ```
- `status()`: `journal` = `host.capabilities?.journalBacklog` absent → `null`; else `raceAbort(Promise.resolve().then(() => cap()), AbortSignal.timeout(JOURNAL_BACKLOG_TIMEOUT_MS))` → `normalizeJournalBacklog`; timeout, throw or invalid → `null` and `logger.debug("engine.status: journal backlog unavailable: …")` (first occurrence per reason only). `jobs.health()` or `models.status()` throwing (should not happen) → `jobs: { ledger: "unavailable", agents: [] }` / the reporter logs and uses `readinessOf` defaults; `status()` never rejects. `ready: true`, `agents: openedAgents.size`, `storeSchema` as today.

- [ ] **Step 1: Write the failing tests** (engine as in Task 3):
  - (a) `"status carries jobs, models, journal and shared-memory support"`: `const s = await engine.status()` → keys include `jobs`, `models`, `journal`, `sharedMemory`; `s.journal === null` (no capability); `s.degraded` deep-equals `{ reason: "models-warming", capability: "embedding" }`; after `await engine.models.warm()` → `s.degraded === null`; `s.sharedMemory` deep-equals `stableDirectoryCapabilitiesSupported() ? { supported: true, mode: "fd-capability" } : { supported: false, mode: "unavailable", reason: "platform" }`.
  - (b) `"status reflects a job run"`: `await engine.jobs.run("gc-run", "agent-a")` → `s.jobs.agents` has `agent-a` with `lastRuns["gc-run"].outcome` equal to the returned run's outcome and `breaker.limit === 3`.
  - (c) `"status reports the host journal backlog"`: capability `() => ({ entries: 3, oldestAt: 1_000, extra: "x" })` → `journal` deep-equals `{ entries: 3, oldestAt: 1_000 }`; `async () => ({ entries: -1, oldestAt: null })` → `null`; a throwing capability → `null`; a never-settling capability → `status()` resolves within 100 ms (`performance.now()` delta) with `journal: null`.
  - (d) `"degraded follows the model states"` (unit, `degradedFromModels`): embedder failed + reranker loading → `{ reason: "model-failed", capability: "embedding" }`; embedder ready + reranker failed → `{ reason: "model-failed", capability: "reranker" }`; embedder ready + reranker loading → `{ reason: "models-warming", capability: "reranker" }`; embedder ready + reranker disabled → `null`.
  - (e) `"status never rejects and still answers after close"`: `createStatusReporter({ …, jobs: { health: () => { throw new Error("x"); } } })` → `status()` resolves with `jobs: { ledger: "unavailable", agents: [] }` (the registry is frozen, so this is unit level); on the engine, `await engine.close()` then `await engine.status()` resolves with `contract: "1.8.0"`.
  - (f) `"status does not create shared or job directories"`: fresh `baseDbPath`, `await engine.status()` twice → neither `join(baseDbPath, "_jobs")` nor any `.plur1bus-shared` exists afterwards.
- [ ] **Step 2:** Run the file. Expected: FAIL (no `jobs` key).
- [ ] **Step 3:** Implement the reporter, `support()`, the wiring; register the new file.
- [ ] **Step 4:** Run the file, `tests/engine-contract.test.js`, `tests/b13-shared-memory-pool.test.js`, `tests/engine-close-inflight.test.js`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(status): Engine.status() with ledger health, model readiness, journal backlog and shared-memory support`.

### Task 5: Q3 — a replayed turn never runs the capture pipeline twice

**Why a fix is needed (from the code at `3a4426a5`):** the capture pipeline's only replay protection is the vector dedup (`engine/capture/capture-turn.js:569-581`), and several LLM-bearing steps run before it or depend on it being exact: an oversized text is summarised by the `capture-summary` LLM route before embedding (`capture-turn.js:475-497`), and that summary is non-deterministic, so the replay embeds different text, escapes dedup, stores a second row, calls emotion classification again and increments `metaReflectionState.sessionCount` (`capture-turn.js:675-676`, the counter that triggers meta-reflection LLM runs). A replay must be recognised at the turn level, before any of that.

**Files:**
- Create: `engine/capture/turn-replay-guard.js`
- Modify: `engine/create-engine.js` (build the guard next to `openedAgents` ~3405; `capture(t)` at 3534-3558 routes through it)
- Modify: `tests/helpers/runtime-sources.js`, `scripts/lib/deploy-integrity.mjs`
- Test: `tests/engine-capture-replay.test.js`

**Interfaces:**
- Produces:
  ```js
  export const REPLAY_GUARD_MAX_ENTRIES = 512;
  export const REPLAY_GUARD_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  /** sha256 hex of JSON.stringify([agentId, runId ?? null, sessionKey ?? null, messages.map(m => [m.role, typeof m.content === "string" ? m.content : JSON.stringify(m.content)])]) */
  export function turnKeyOf(t)
  /** → { run(agentId, key, fn: () => Promise<CaptureResult>): Promise<CaptureResult> } */
  export function createTurnReplayGuard({ root, clock = Date.now, logger })
  ```
- Storage: `<root>/<safeAgentId>.json` = `{ v: 1, entries: [{ key, at }] }`, `root = join(baseDbPath, "_capture-turns")`, written atomically (temp file `0o600` in the same directory + `renameSync`), directory `0o700`; loaded lazily per agent into memory; entries older than `REPLAY_GUARD_TTL_MS` dropped and the newest `REPLAY_GUARD_MAX_ENTRIES` kept on every write. An unreadable/corrupt file → `logger.warn` once, treated as empty (fail-open: the vector dedup still applies; never block a capture on the guard).
- `run(agentId, key, fn)`: key present → `{ stored: 0, skipped: 1, reason: "duplicate-turn" }` without calling `fn`. Same key already in flight → await that call; if it recorded, answer `duplicate-turn`, else run `fn` itself. Otherwise call `fn`; record the key only when the result has no `reason` (the capture completed: `outcome.ok`); a write failure → `logger.warn`, result returned unchanged.
- Engine wiring: in `capture(t)`, after the `closing`/`incognito`/principal-agent checks and `safeAgentId`, wrap the existing body from `host.workspaceDir(...)` to the result in `replayGuard.run(agentId, turnKeyOf(t), async () => …)`. Incognito and closed turns are never recorded (they return before the guard).

- [ ] **Step 1: Write the failing tests** (engine config from `tests/engine-close-inflight.test.js` but `duplicateThreshold: 0.95`; `internals.embeddings` a deterministic text-hash embedder: 384 dims, `v[i] = ((hash(text) >> (i % 24)) & 1) ? 1 : -1` normalised, so equal texts give equal vectors and different texts differ; one `TurnRecord` builder `turn({ runId, text })` with `principal`, `agent: { origin: "user", background: false }`, `incognito: false`, `signal: new AbortController().signal`):
  - (a) `"replaying the same turn is a duplicate-turn and does not advance the meta-reflection counter"`: config `metaCognition: { enabled: true, sessionThreshold: 50 }`; `await engine.capture(turn({ runId: "r1", text: T })).done` → `stored >= 1`; `const count = internalsOf(engine).captureContext.metaReflectionState.sessionCount`; the same turn again → deep-equals `{ stored: 0, skipped: 1, reason: "duplicate-turn" }`; the counter is still `count`; `engine.memory.list({ since: 0 }, …)` shows one card for `T`; `(await engine.jobs.history("agent-a")).filter((r) => r.llmSession).length === 0`.
  - (b) `"a replay makes no capture-summary LLM call"`: config `merging: { enabled: true }, captureMaxChars: 100`; host `llm.complete` records `params.purpose` and returns a different summary text per call (response shape as in `tests/openclaw-default-llm-callers.test.js`); first capture of a 700-char text → one `"capture-summary"` call; replay → no further `"capture-summary"` call and `reason: "duplicate-turn"`. (Before the fix this test sees a second call and a second row.)
  - (c) `"a replay survives an engine restart"`: capture, `await engine.close()`, new engine on the same `baseDbPath` and `stateDir` → the same turn answers `duplicate-turn`; `join(baseDbPath, "_capture-turns")` has mode `0o700` and the agent file `0o600` (POSIX only: `{ skip: process.platform === "win32" }`).
  - (d) `"a failed capture is not recorded, so its replay is captured"`: the embedder throws for the first call only → first result has a `reason`; replay → `stored >= 1`, no `reason`.
  - (e) `"a different runId with the same text is not a duplicate-turn"`: `turn({ runId: "r2", text: T })` after (a) → `reason` is not `"duplicate-turn"` and `stored === 0` (the vector dedup still holds).
  - (f) `"concurrent identical turns capture once"`: two `engine.capture(turn({ runId: "r3", text: U }))` started together → one result with `stored >= 1`, the other `duplicate-turn`.
  - (g) unit: a corrupt `_capture-turns/agent-a.json` (`"{"`) → `run` calls `fn`, one warn line, and the file is rewritten valid; 600 distinct keys → the file holds 512 entries; an entry with `at` older than the TTL is dropped on the next write.
- [ ] **Step 2:** Run the file. Expected: (a), (b), (c), (f), (g) FAIL; (d), (e) PASS.
- [ ] **Step 3:** Implement the guard and the wiring; register the file.
- [ ] **Step 4:** Run the file, `tests/engine-close-inflight.test.js`, `tests/e1-memory-ops-write.test.js`, `tests/engine-contract.test.js`, `tests/openclaw-default-llm-callers.test.js`. Expected: PASS.
- [ ] **Step 5:** Commit `fix(capture): a replayed turn is recognised before the pipeline runs (Q3: no second summary, row or session count)`.

### Task 6: Typed `unsupported` for shared memory where the platform has no mode

**Files:**
- Modify: `lib/shared-memory-pool.js` (the two "stable directory capabilities are unavailable" throws in `_ensureSharedRoot` become `sharedMemoryUnsupportedError(reason)`)
- Modify: `engine/memory-ops/errors.js` (`MEMORY_OP_ERROR_CODES` gains `"unsupported"`)
- Modify: `lib/telegram-commands/memory-edit.js` (`codeForShareError` at 542-549)
- Modify: `engine/memory-ops/write.js` (`messageForCode` 26-33; `share` 234-288: early check)
- Modify: `engine/memory-ops/proposals.js` (`accept`: same early check before any refresh step)
- Modify: `adapter/openclaw/register-commands.js` (`runShare` 1243-1270, `shareFailure` 1271-1274), `lib/i18n-dictionary.js` (new key next to `plur1bus.share_failed` at 742)
- Test: `tests/b13-shared-memory-pool.test.js` (new case), `tests/engine-memory-share-unsupported.test.js`, `tests/adapter-register-commands.test.js` (new case)

**Interfaces:**
- Produces:
  ```js
  // lib/shared-memory-pool.js
  export const SHARED_MEMORY_UNSUPPORTED = "SHARED_MEMORY_UNSUPPORTED";
  /** Error("shared memory is not supported on this platform") with code SHARED_MEMORY_UNSUPPORTED and .reason */
  export function sharedMemoryUnsupportedError(reason = "platform")
  // engine: MemoryOpError("unsupported", "shared memory is not supported on this platform",
  //                       { capability: "shared-memory", reason: support().reason })
  ```
- `share`: right after argument validation and `opsContext.resolve`, before `getCard`: `if (!sharedMemoryPool.support().supported) throw memoryOpError("unsupported", …)`. This is a platform property, not data-dependent, so it answers before the anti-oracle lookups. `codeForShareError` maps an error string starting with `"shared memory is not supported"` to `"unsupported"` (the lease-time path, e.g. a pool that became tainted). `proposals.accept`: the check runs after the proposal is resolved and authorised (so a foreign proposal still answers `not-found`), before `memory.correct`. Reads are unchanged (`withWorkspaceReadDb`/`withUserReadDb` keep answering `null`).
- Adapter: `runShare` returns `unsupported: outcome.code === "unsupported"`; `shareFailure` answers `fail("plur1bus.share_unsupported")` for it. Dictionary entry (de/en, same shape as `plur1bus.share_failed`): de „Geteilte Erinnerungen sind auf diesem System noch nicht verfügbar.", en "Shared memories are not available on this system yet."

- [ ] **Step 1: Write the failing tests:**
  - (a) `tests/b13-shared-memory-pool.test.js` `"an unsupported pool reports its support and throws a typed error"`: `const pool = new SharedMemoryPool(base, 4, FakeAgentDbPool); pool.supported = false;` → `pool.support()` deep-equals `{ supported: false, mode: "unavailable", reason: "platform" }`; `withWorkspaceDb` rejects with `err.code === SHARED_MEMORY_UNSUPPORTED` and message `"shared memory is not supported on this platform"`; `withUserReadDb` calls back with `null`; no `.plur1bus-shared` directory.
  - (b) `tests/engine-memory-share-unsupported.test.js` (setup from `tests/helpers/shared-workspace-engine.js`; after construction `internalsOf(engine).sharedMemoryPool.supported = false`): anna captures a fact; `memory.share(id, "workspace", …)` rejects `MemoryOpError` `unsupported` with `detail` deep-equal `{ capability: "shared-memory", reason: "platform" }`; no `.plur1bus-shared` under the shared base and no archive file was written; `memory.share("00000000-0000-4000-8000-000000000000", "workspace", …)` also answers `unsupported` (platform first); `memory.list` still returns anna's card.
  - (c) same file, only where shared memory works (`{ skip: !stableDirectoryCapabilitiesSupported() }`): share succeeds, bernd files a proposal, then `supported = false` → anna's `proposals.accept(id)` rejects `unsupported` and the proposal file still says `pending`; carol's `accept` answers `not-found`.
  - (d) `tests/adapter-register-commands.test.js` `"/share answers share_unsupported when shared memory is unavailable"`: the existing /share harness with `engineMemory.share` rejecting `memoryOpError("unsupported", …)` → the reply is the `plur1bus.share_unsupported` text.
- [ ] **Step 2:** Run the three files. Expected: the new cases FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the three files plus every `tests/b13-*.test.js`, `tests/engine-memory-shared-ops.test.js`, `tests/engine-memory-proposals.test.js`, `tests/e1-memory-ops-write.test.js`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(memory): shared memory fails with a typed unsupported error where the platform has no mode; /share says why`.

### Task 7: ADR — shared memory on macOS and Windows

**Files:**
- Create: `docs/adr/0001-shared-memory-on-macos-and-windows.md` (the engine repo's first ADR; `docs/adr/README.md` one-line index)

The ADR is a decision document for the owner; its recommendation must follow from these facts, which the implementer verifies and cites with file:line:

- **Context:** explicit shared memory (D31) routes every LanceDB path through `/proc/self/fd/<n>/…` aliases of held `O_DIRECTORY|O_NOFOLLOW` descriptors (`lib/directory-capability.js:30-64`), so a directory swapped for a symlink between check and use cannot redirect a write. macOS has no `/proc`; `/dev/fd/<n>` for a directory stats as the fdesc device and `readdir` answers `ENOTDIR`, so `fdAlias` finds no alias and the probe answers false; win32 is excluded outright. Result: share, refresh, proposals and shared reads are disabled on two of the three D8 targets (Task 6 now says so with `unsupported`).
- **Option A — native addon (`openat`/`mkdirat` with `O_NOFOLLOW`, Windows handle-relative `NtCreateFile`):** the decisive fact is that LanceDB opens its files itself, by path string, inside its Rust object store; our addon could open *our* directories race-free, but it cannot hand LanceDB a descriptor, and macOS/Windows have no path form that routes through a held descriptor. So A protects the checks, not the writes — the same residual window as B — at the cost of five signed prebuilds (darwin-arm64, linux-x64/arm64, win32-x64/arm64), a C/C++ toolchain in CI and a new supply-chain surface.
- **Option B — verified-path mode:** (1) canonicalise the shared base once (`realpathSync.native` of its nearest existing ancestor + the missing segments) and walk it from the filesystem root segment by segment with `lstat` (bigint), refusing any symlink, junction or reparse point (`lib/platform.js` `isUnsafeLink` semantics); (2) ancestors: POSIX owner `root` or the current uid and not group/other-writable unless sticky; Windows: no reparse point; (3) the shared base: owner = current user, POSIX `(mode & 0o022) === 0`; (4) the shared root `.plur1bus-shared`: created `0o700`, owner = current user, POSIX `(mode & 0o077) === 0`; Windows owner = current user SID and every Allow ACE's SID ∈ {current user, `S-1-5-18` SYSTEM, `S-1-5-32-544` Administrators}, applied at creation with `icacls <root> /inheritance:r /grant:r <user>:(OI)(CI)(F)`; (5) every held directory keeps its `{dev, ino}` (POSIX additionally holds an `O_RDONLY|O_DIRECTORY|O_NOFOLLOW` anchor descriptor so the inode cannot be recycled; NTFS file ids carry a sequence number) and is re-verified by `lstat` before every LanceDB operation (`MemoryDB` already calls `directoryCapability.assertOpen()` there, `engine/store/memory-db.js:442-454`) and after every lease; a mismatch taints the pool until restart.
- **Security argument for B:** after (2)-(4) no other unprivileged user can create, rename or replace anything at or below the shared root, or rename the base out from under it. Whoever can still race the residual check-to-use window already holds the current user's write access (or root/Administrators), and with that can edit the LanceDB files directly; the race gives no power beyond what that principal already has. What B does not defend against — malware running as the user — the fd mode on Linux does not defend against either (it can write the tables directly). B's checks are cheap (`lstat` per segment, one ACL read per process on Windows).
- **Residual risks to record:** Windows ancestors above the base are checked for reparse points only (their ACLs are the OS profile defaults); the Windows ACL read depends on `powershell.exe` (absent → `acl-tool-unavailable`, fail closed); network filesystems with unstable inode numbers fail the identity check (fail closed, `identity-changed`); legacy shared migration (`lib/shared-memory-migration.js`) and explicit named namespaces (`lib/multi-namespace-pool.js`) stay fd-only.
- **Decision (recommended, pending owner):** Option B on darwin and win32; Linux stays fd-capability. Consequences: `SharedMemorySupport.mode: "verified-path"` there; if the owner declines, `unsupported` stays the answer and the `"verified-path"` literal is removed from the union before the PR.

- [ ] **Step 1:** Write the ADR (Status: Proposed; Context; Options with the facts above; Decision; Consequences; Residual risks; References: B13 plan Task 6, B12 audit, spec D8/D31).
- [ ] **Step 2:** `npm run lint` (markdown lint, if configured). Expected: PASS.
- [ ] **Step 3:** Commit `docs(adr): shared memory on macOS and Windows — verified-path mode recommended over a native addon`.
- [ ] **Step 4:** Stop and report to the controller: the owner decides on Tasks 9-10 from this ADR.

### Task 8: Docs, changelog, full gate for 1.8.0

**Files:**
- Modify: `docs/engine-api.md` (header line 3 and "amended nine times"; a **1.8.0** entry after the 1.7.0 entry at 81-90; new section "Status, models and shared memory in 1.8.0" after the EmbeddingService section; line 530 "full 1.8.0 `Engine` surface"; line 579 status description; line 587 member list gains `models.status`/`warm`; Hosting rules gain bullets on `journalBacklog` and on `unsupported`)
- Modify: `CHANGELOG.md` (`[Unreleased]`, German)

- [ ] **Step 1:** Docs section: `EngineStatus` fields and their sources (ledger snapshot cache, current UTC sweep, `running` is per process, `unreadableLines`); the `degraded` precedence; model states and when each appears (`loading` with `checkedAt: null` = not confirmed; hosts call `models.warm({ signal })` after start, which is how the harness clears `models-warming`); `journalBacklog` (shape, 50 ms cap, `null` rules); Q3 (`duplicate-turn`, what the key covers, persisted 7 days / 512 per agent, failed captures are not recorded, hosts should give journal lines a stable `runId`); `sharedMemory` and `unsupported` (`detail.reason`), Linux fd mode, macOS/Windows per the ADR.
- [ ] **Step 2:** CHANGELOG (German), e.g. „**`Engine.status()`** meldet Job-Gesundheit aus dem Ledger (letzter Lauf je Job, Breaker, laufende Jobs, unlesbare Zeilen), Modellbereitschaft, Journal-Rückstand des Hosts und Shared-Memory-Unterstützung — Contract 1.8.0", „**`Engine.models.warm()`** wärmt Embedder und Reranker explizit an", `### Behoben`: „Ein erneut eingespielter Turn (Journal-Replay) läuft nicht mehr ein zweites Mal durch die Capture-Pipeline (keine zweite Zusammenfassung, keine zweite Zeile, kein zweiter Sitzungszähler; Q3)", `### Geändert`: „Teilen ohne Shared-Memory-Unterstützung antwortet mit `unsupported` statt `storage`; `/share` sagt, warum".
- [ ] **Step 3:** `grep -rn '"1\.7\.0"' engine types tests docs` returns only historical annotations.
- [ ] **Step 4:** Full gate: `npm run lint && npm run typecheck && npm test` (590000 ms) and `TZ=UTC node --test tests/golden-prefix.test.js`. Expected: all green, golden 11/11.
- [ ] **Step 5:** Commit `docs: E4 — contract 1.8.0 (status health, models, journal backlog, replay guard, unsupported) in CHANGELOG and contract docs`.
- [ ] **Step 6:** If the owner declined Tasks 9-10: remove `"verified-path"` from `SharedMemoryMode` (types, conformance pin, docs), rerun Step 4, commit `chore(contract): drop the unused verified-path mode`, then hand over (Task 10 Step 6 wording). Otherwise continue with Task 9.

### Task 9: `VerifiedPathDirectory` — **Owner decision required before execution (security-sensitive)**

**Files:**
- Create: `lib/verified-path-directory.js`
- Modify: `lib/platform.js` (add `secureDirectoryOwnerOnly`, `readDirectoryAcl`)
- Modify: `scripts/lib/deploy-integrity.mjs`
- Test: `tests/verified-path-directory.test.js`

**Interfaces:**
- Produces:
  ```js
  // lib/verified-path-directory.js — duck-type-compatible with DirectoryCapability (assertOpen, openChild, childMatches, close, path, identity, displayPath)
  export class VerifiedPathDirectory { /* constructor(path, identity, anchorFd, opts) — internal */ }
  /** Opens/creates an absolute directory: canonicalise once, per-segment lstat walk, ancestor policy, returns the held leaf. */
  export function openVerifiedPathDirectory(path, { create = false, platform = process.platform, uid = process.getuid?.(), lstat = lstatSync } = {})
  /** Throws Error with .reason "unsafe-root" | "acl-tool-unavailable" unless `path` is owned by the current user and private (POSIX (mode & 0o077) === 0; win32 via readAcl). */
  export function assertOwnerOnlyDirectory(path, { platform = process.platform, uid, readAcl = readDirectoryAcl } = {})
  // lib/platform.js
  /** win32: icacls <path> /inheritance:r /grant:r <user>:(OI)(CI)(F); POSIX: chmod 0o700. Same result shape as securePath. */
  export function secureDirectoryOwnerOnly(target, { platform = process.platform, execFile = execFileSync, username = null } = {})
  /** win32 only: { ownerSid, userSid, aces: [{ sid, type: "Allow" | "Deny" }] } via powershell.exe -NoProfile -NonInteractive,
   *  the path passed in env PLUR1BUS_ACL_PATH (never interpolated into the script); ENOENT → Error with reason "acl-tool-unavailable". */
  export function readDirectoryAcl(target, { execFile = execFileSync } = {})
  ```
- Rules (exact): segment validation as `lib/directory-capability.js` `validateSegment`; identity = `lstat(path, { bigint: true })` `{ dev, ino }`; a segment is refused when `isUnsafeLink(path, { platform, stat })` or `!stat.isDirectory()`; POSIX ancestor policy `stat.uid === 0 || stat.uid === uid` and (`(mode & 0o022) === 0` or `(mode & 0o1000) !== 0`); `openChild(name, { create })` creates with `mkdirSync(child, { mode: 0o700 })` and re-lstats (refusing a symlink planted between `ENOENT` and `mkdir`: `EEXIST` → lstat again and apply the same refusal); POSIX holds an anchor fd per directory (`O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC`) and `assertOpen()` requires `fstat(anchor)` and `lstat(path)` to match the stored identity; win32 compares `lstat` only; every failure throws an `Error` whose message names the display path only (no identity numbers) and sets `.code = "ELOOP"` for a link and `.code = "EIDENTITY"` for a changed identity. `childMatches` follows `DirectoryCapability.childMatches` (ENOENT/ENOTDIR/ELOOP → false).

- [ ] **Step 1: Write the failing tests** (run on Linux and macOS CI; win32 behaviour through `platform: "win32"` plus injected `lstat`/`readAcl`/`execFile`):
  - (a) `"opens and creates a private chain and routes children"`: `base = makeTempDir("e4-vp-")` → `openVerifiedPathDirectory(join(base, "s"), { create: true })` → `path === realpathSync.native(join(base, "s"))`; `openChild("workspaces", { create: true })` exists with mode `0o700`; `assertOpen()` passes.
  - (b) `"refuses a symlinked segment at open and a swap after open"`: `symlinkSync(other, join(base, "link"))` → open of `join(base, "link", "x")` throws `code: "ELOOP"`; open `d`, then `renameSync(d, d + ".old"); symlinkSync(other, d)` → `assertOpen()` throws `code: "EIDENTITY"`; `childMatches` returns false.
  - (c) `"refuses a replaced directory with the same name"`: open `d`, `rmSync(d, { recursive: true }); mkdirSync(d)` → `assertOpen()` throws `EIDENTITY` (anchor fd keeps the old inode alive).
  - (d) `"ancestor and owner policy"` (injected `lstat`): an ancestor with `mode 0o40777` without sticky → throws `.reason === "unsafe-root"`; with `0o41777` (sticky, `/tmp`) → passes; an ancestor owned by uid 4242 → throws; `assertOwnerOnlyDirectory` on a `0o750` directory → `unsafe-root`, on `0o700` → passes.
  - (e) `"win32 ACL policy"` (injected `readAcl`): owner = user SID, ACEs {user Allow, S-1-5-18 Allow, S-1-5-32-544 Allow} → passes; an extra `S-1-5-11` (Authenticated Users) Allow → `unsafe-root`; owner ≠ user → `unsafe-root`; `readAcl` throwing `reason: "acl-tool-unavailable"` → that reason; a `Deny` ACE for anyone is allowed.
  - (f) `"readDirectoryAcl passes the path via the environment"` (injected `execFile` spy): the argv contains no part of the path; `env.PLUR1BUS_ACL_PATH` equals it; JSON output `{"ownerSid":"S-1-5-21-1-2-3-1001","userSid":"S-1-5-21-1-2-3-1001","aces":[…]}` parses; `ENOENT` → `acl-tool-unavailable`. `secureDirectoryOwnerOnly` on win32 calls `icacls` with exactly `[path, "/inheritance:r", "/grant:r", "<user>:(OI)(CI)(F)"]`.
- [ ] **Step 2:** Run `node --test tests/verified-path-directory.test.js`. Expected: FAIL (module missing).
- [ ] **Step 3:** Implement; register the new lib file in `DEPLOY_FILES`.
- [ ] **Step 4:** Run the file and `tests/platform*.test.js`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(fs): VerifiedPathDirectory — lstat-walked, identity-checked, owner-only directories for platforms without fd aliases`.

### Task 10: Shared memory in verified-path mode on macOS and Windows — **Owner decision required before execution (security-sensitive)**

**Files:**
- Modify: `lib/shared-memory-pool.js` (mode selection in the constructor; `_openBase`/`_ensureSharedRoot`/`_readRouteExists`/`assertSharedRoot` dispatch on `this.mode`; after-lease check and taint in `_lease`; `support()`)
- Modify: `lib/shared-memory-migration.js` (answers `sharedMemoryUnsupportedError("platform")` unless `mode === "fd-capability"`)
- Modify: `.github/workflows/macos-portability.yml` (add `tests/verified-path-directory.test.js` and `tests/b13-shared-memory-verified-path.test.js`)
- Modify: `docs/engine-api.md`, `CHANGELOG.md`, `docs/adr/0001-shared-memory-on-macos-and-windows.md` (Status: Accepted, owner and date)
- Test: `tests/b13-shared-memory-verified-path.test.js`

**Interfaces:**
- Consumes: `openVerifiedPathDirectory`, `assertOwnerOnlyDirectory`, `secureDirectoryOwnerOnly` (Task 9); `sharedMemoryUnsupportedError` (Task 6).
- Produces: `new SharedMemoryPool(baseDir, vectorDim, AgentDbPool, logger, { mode })` — `mode` defaults to `stableDirectoryCapabilitiesSupported() ? "fd-capability" : (platform === "darwin" || platform === "win32") ? "verified-path" : "unavailable"`; `this.supported = mode !== "unavailable"`. In verified-path mode the pool uses `openVerifiedPathDirectory` where fd mode uses `openDirectoryCapability`, and an identity comparison of freshly opened `VerifiedPathDirectory` objects where fd mode uses `pathMatchesDirectoryCapability`. On creating `.plur1bus-shared`: `secureDirectoryOwnerOnly`, then `assertOwnerOnlyDirectory` on it and the base-owner check on `baseDir` (once per process; failure → `this.taint = err.reason`). Every `_lease` start: `taint` set → `sharedMemoryUnsupportedError(taint)`; `finally` after the callback: `assertSharedRoot()`; a throw there sets `taint = "identity-changed"`, logs via `safeWarn`, and rethrows (the caller sees `storage`; later calls see `unsupported`). `support()` = `{ supported: this.supported && !this.taint, mode: this.supported ? this.mode : "unavailable", ...(reason) }`. The child `AgentDbPool`s receive the `VerifiedPathDirectory` as `parentDirectoryCapability` unchanged; verify that on the parent-routed path `AgentDbPool` only calls `openChild`/`childMatches`/`assertOpen`/`path`/`close` (`engine/store/agent-db-pool.js:86-95, 164-230`) and never `openDirectoryCapability`.

- [ ] **Step 1: Write the failing tests** (`new SharedMemoryPool(base, 384, EngineAgentDbPool-equivalent, logger, { mode: "verified-path" })` with the real `AgentDbPool` from `index.js`; runs on Linux and macOS CI, so the mode is forced explicitly):
  - (a) `"verified-path mode writes and reads a workspace pool"`: `withWorkspaceDb(workspaceA, (db) => db.store(row))` then `withWorkspaceReadDb(workspaceA, (db) => db.getById(id))` returns the row; `.plur1bus-shared` has mode `0o700`; `db.dbPath` is under `realpathSync.native(base)`.
  - (b) `"a symlink swap of the shared root before a lease fails closed"`: after one lease, `renameSync(shared, shared + ".x"); symlinkSync(evil, shared)` → next `withWorkspaceDb` rejects; nothing was created under `evil`.
  - (c) `"an identity change during a lease taints the pool"`: inside the lease callback rename the root away and recreate it → the lease rejects with `/identity changed/`; `support()` deep-equals `{ supported: false, mode: "verified-path", reason: "identity-changed" }`; the next `withUserDb` rejects `code: SHARED_MEMORY_UNSUPPORTED`.
  - (d) `"an unsafe shared root is refused"`: pre-create `.plur1bus-shared` with `0o755` → first write lease rejects, `support().reason === "unsafe-root"`; a base directory with `0o777` → same.
  - (e) `"engine share works end to end in verified-path mode"` (`tests/helpers/shared-workspace-engine.js`, then replace the engine's pool before first use with one constructed `{ mode: "verified-path" }` via `internalsOf(engine)` if the internals view allows it; otherwise add a `testOptions.sharedMemoryMode` seam read by `createEngine` at `create-engine.js:1245` and document it next to `internals`): anna shares, bernd lists the copy, bernd proposes, anna accepts → the refreshed copy is visible to bernd; `engine.status()` reports `sharedMemory: { supported: true, mode: "verified-path" }`.
  - (f) `"Linux default stays fd-capability"` (`{ skip: process.platform !== "linux" }`): default constructor → `support().mode === "fd-capability"`; the whole existing `tests/b13-shared-memory-pool.test.js` passes unchanged.
- [ ] **Step 2:** Run `node --test tests/b13-shared-memory-verified-path.test.js`. Expected: FAIL (the `mode` option is ignored).
- [ ] **Step 3:** Implement; update the macOS workflow list; mark the ADR Accepted; docs section "Shared memory on macOS and Windows (verified-path)" and CHANGELOG bullet „Geteilte Erinnerungen funktionieren auf macOS und Windows im Verified-Path-Modus (ADR 0001)".
- [ ] **Step 4:** Full gate: `npm run lint && npm run typecheck && npm test` (590000 ms) and `TZ=UTC node --test tests/golden-prefix.test.js`. Expected: all green, golden 11/11. The macOS workflow runs on the PR.
- [ ] **Step 5:** Commit `feat(shared): verified-path shared memory on macOS and Windows (ADR 0001); Linux keeps fd capabilities`.
- [ ] **Step 6:** Hand over: bundle `origin/main..feat/e4-engine-status` for the owner to push via the Mac and open the PR "E4: status health and model readiness, replay-safe capture, shared memory on macOS/Windows (contract 1.8.0)" against `main`; the owner merges.

---

## Self-review notes

- **Spec coverage:** E4 row — last run per job, breaker, journal backlog "if the host reports one", model readiness (Tasks 2, 3, 4, types in 1); §5 `models-warming` → `degraded` from models plus `models.warm()` for the harness warm-up (Tasks 3, 4); §6 `1staid check`/`dreams status` needs (retries = `attempt`, `already_running` = `running`, ledger health = `unreadableLines`/`ledger`) (Task 2); Q3 (Task 5, with the code-level reason a fix is needed); shared memory on D8 targets — typed failure and status (Tasks 4, 6), ADR (Task 7), verified-path implementation owner-gated (Tasks 9, 10); contract, docs, German CHANGELOG (Tasks 1, 8). Deferred with a reason: harness consumption and journal `runId`s (2a-H3); legacy shared migration and named namespaces off Linux (stay fd-only, ADR residual risks).
- **Type consistency:** `JobsHealth`/`AgentJobHealth`/`BreakerState` produced only by Task 2's `health()`; `ModelReadiness`/`ModelsStatus` only by Task 3's `readinessOf`/`createModelsService`; `SharedMemorySupport` only by `SharedMemoryPool.support()` (Task 4, extended in Task 10); `sharedMemoryUnsupportedError` defined in Task 6 and reused in Task 10; `CaptureResult.reason "duplicate-turn"` from Task 5 matches Task 1's doc comment.
- **Order:** 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8, then 9 → 10 only after the owner's yes. Task 5 and 6 are independent of 2-4 but share the gate; keep them sequential.
