# M1a — PLUR1BUS Engine Extraction, Part 1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give PLUR1BUS a frozen engine contract, a platform-abstraction module, an injected `HostServices` seam and an `engine/` + `adapter/openclaw/` split of `index.js`, with a byte-identical golden-prefix corpus proving nothing about the product changed.

**Architecture:** Three sequential PRs in the PLUR1BUS plugin repo. PR-01 introduces `lib/platform.js` and routes the eight `chmod` sites and the `process.env.HOME` bug through it. PR-02 introduces `lib/host-services.js` and replaces the 323 `api.logger` and 28 `runtimeIfUsable(api)` reads inside `index.js` with `host.logger` / `host.runtime`, so the code that PR-03 moves no longer references `api`. PR-03 lifts the six large closures out of the 9 100-line `plugin.register()` body into `engine/**` and `adapter/openclaw/**` modules, each receiving an explicit context object whose exact key set is produced by a TypeScript-compiler-API scope analyser rather than by hand. A golden-prefix corpus captured *before* any of this is replayed after every task.

**Tech Stack:** Node ≥ 24.16 (ESM, `"type": "module"`), `node:test` + `node:assert/strict`, LanceDB (`@lancedb/lancedb`), `typescript@5.9.3` (already an `optionalDependency`, used both at runtime by `lib/code-index/workspace-indexer.js:59` and here for `tsc --noEmit` and the scope analyser). No new dependencies.

**Spec:**
- `/home/claude/PLUR1BUS-Harness/docs/engine-extraction.md` — §b.1 packages, §b.2 engine API sketch, §c rows PR-01/PR-02/PR-03, §d risks R1–R4, R7
- `/home/claude/PLUR1BUS-Harness/docs/adr/ADR-002-plur1bus-engine-and-host.md` (Accepted) — `Engine`/`Host`/`Principal`/`TurnOrigin` sketch, time budgets, P0–P10 ↔ PR-01…PR-15 mapping
- `/home/claude/PLUR1BUS-Harness/docs/host-contract.md` — §a surface table, §c principal model, §f defects f.1/f.2/f.9/f.15
- `/home/claude/PLUR1BUS-Harness/docs/milestones.md` — M1a definition and owner gate
- `/home/claude/PLUR1BUS-Harness/docs/phase0/decisions-for-owner.md` — "Owner answers 2026-09-22": B6, B7, B8
- `/home/claude/PLUR1BUS-Harness/docs/phase0/review-report.md` — finding S4

---

## Repository, branch, and how to run anything

**Work repo (`$PLUR1BUS`):** a worktree of `Cyb3rb1ade/openclaw-plur1bus-memory` on a new branch `feat/engine-extraction-m1a` cut from `main`. Create it with the `superpowers:using-git-worktrees` skill before Task 1.

**Reference clone:** `/home/claude/refs/openclaw-plur1bus-memory` @ `89148f9f` (`@cyb3rb1ade/plur1bus-memory` 7.15.4). Every `file:line` in this plan was read and verified at that commit on 2026-09-22. If a line number does not match what you see, re-derive it with Grep before editing — never edit by line number alone.

**Node.** The default `node` on this machine is v22.22 and is **wrong**. Always use v24.21:

```bash
export PATH=/home/claude/.node24/bin:$PATH
node -v          # must print v24.21.0
```

**Full suite** (the behaviour-neutrality instrument, 496 files in `tests/` + 10 in `test/`):

```bash
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm test
```

**Accepted baseline:** 5 076 tests, 5 071 pass, **exactly 2 failures**, both needing an installed OpenClaw host:
- `loads reply_dispatch routing through the exact OpenClaw 2026.8.2 plugin loader`
- `PLUR1BUS feature-cron plugin runtime`

"Suite green" in this plan means *those two and only those two fail*. A third failure is a regression.

**One test file:**

```bash
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/<name>.test.js
```

**Lint:** `cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm run lint`

---

## Global Constraints

Every task's requirements implicitly include this section.

1. **Node ≥ 24.16.0.** `package.json:engines` is `">=24.16.0 <25 || >=26.1.0"`. Use `/home/claude/.node24/bin/node` (v24.21.0) for every command. Never invoke the default `node` (v22.22).
2. **No behaviour change.** M1a contains *no* intended behaviour change. Every task ends with the full suite at the accepted baseline **and** the golden-prefix corpus byte-identical. A task that cannot keep both stops and reports rather than updating the oracle.
3. **The golden oracle is append-only during M1a.** `tests/fixtures/golden-prefix/expected/*.txt` is written exactly once, in Task 1, on unmodified `main`. No later task may regenerate, edit or delete it.
4. **No new runtime dependencies.** `typescript@^5.9.3` is already in `optionalDependencies` and is a genuine *runtime* optional dependency (`lib/code-index/workspace-indexer.js:59` does `await import("typescript")`). Leave it in `optionalDependencies`; do not move it to `devDependencies`, do not add a second copy, do not add `dependency-cruiser` or `eslint` (neither is installed and the container has no reliable npm egress for them).
5. **No secrets and no real user data in fixtures.** Fixture memory text is invented; ids are fixed literal UUIDs; no path outside `os.tmpdir()` is written; no network call is made.
6. **`@cyb3rb1ade/plur1bus-memory` stays the published package name** (`package.json:2`) for the whole of M1a. PR-14 renames it later. Do not change `name`, `version`, `openclaw.compat`, `openclaw.build`, `main`, or the `scripts.postinstall` contract.
7. **No edits to `.github/workflows/*`** (`ci.yml`, `macos-portability.yml`, `macos-scoped-embedding.yml`). New checks are wired into the existing `npm run lint` script, which the CI `lint` job already runs.
8. **`engine/**` must not import** `openclaw`, `lib/setup/*-plugin-runtime.js`, `lib/runtime-shutdown.js`, `lib/providers/openclaw-memory-embedding-adapters.js`, or `index.js`. Enforced by `scripts/lint-engine-imports.mjs` from Task 10 onward.
9. **`index.js`'s named export list must not change.** 46 test files import internals from `../index.js`. The line `export { MemoryDB, buildMaintenanceNudges, appendConflictLog, buildConflictSummaryFromLog, createRuntimeRerankerProvider, inspectCronNativeCapabilities, guardUnsafeDirectCronTurn, parseFeatureCronBootstrapLastPlanCreateCount, reconcileUnsafeDirectCronsWithService, runDeferredFeatureCronBootstrap };` (`index.js:13495`) plus the nine `export function`/`export class` declarations stay exactly as they are; if a moved module now owns one, `index.js` re-exports it.
10. **Conventional Commits**, one commit per task unless a task says otherwise. Scope names used here: `platform`, `host`, `engine`, `adapter`, `test`, `docs`, `bench`, `types`.

## Out of scope for M1a, stated so nobody looks for it

These are in the spec and are deliberately **not** in this plan. Each names the PR that owns it, so a reviewer can tell "missing" from "later".

| Spec item | Owner |
|---|---|
| The npm package split into `@cyb3rb1ade/plur1bus-{engine,host-openclaw,control-ui,platform}` (`engine-extraction.md` §b.1, owner B7) | PR-13 and PR-14. M1a creates the `engine/`, `adapter/` and `lib/platform.js` boundaries *inside* the existing package; the published name stays `@cyb3rb1ade/plur1bus-memory` (Global Constraint 6). |
| `createEngine(host, config)` and the `Engine` object itself | PR-04…PR-15. M1a freezes the type and moves the bodies; no engine instance is constructed. |
| Threading a real `AbortSignal` through recall (host-contract §f.1) | PR-05. The type already makes `signal` mandatory. |
| `Principal` / `AgentContext` as runtime inputs (host-contract §c.2) | PR-06. |
| `JobRegistry` and the run ledger | PR-07, PR-08 — both behaviour-changing, both owner-signed (A7). |
| **Risk R3 — generating the hook payload types from the OpenClaw SDK at build time** | Not M1a. R3's mitigation is a build step plus a nightly job that resolves `openclaw@latest` and asserts the three deep-import subpaths still resolve; that touches `.github/workflows/*`, which Global Constraint 7 forbids here. It belongs with PR-14, where the adapter becomes its own package with its own CI. Recorded here so its absence is a decision, not an oversight. |
| The four `bash` scripts → `.mjs` (host-contract §f.13) | PR-12. |
| Windows named-pipe IPC wiring | PR-11. `ipcAddress()` is defined and tested in Task 4 but has no call site yet. |
| `isUnsafeLink` routed through the 17+ `isSymbolicLink()` sites (host-contract §f.15) | A later sweep. Task 4 defines and tests the helper; routing it is not behaviour-neutral on Windows and needs its own gate. |

---

## Review Focus

Five failure modes the spec implies that no task's happy path exercises, most likely first. Each has its test pinned to the task that owns the code.

1. **`api.logger?.info?.(…)` becomes `host.logger.info(…)` and throws where it used to be a silent no-op.** `index.js` mixes hard calls (`api.logger.warn(...)`, e.g. `:13329`) with guarded ones (`api.logger?.info?.(...)`, e.g. `:13308`). A host that supplies `logger: {}` — which the OpenClaw test stubs and `tests/` fixtures do — currently no-ops on the guarded sites and would now throw `TypeError: host.logger.info is not a function`. **Fix:** `createHostServices()` normalises the logger into a four-method object (`info`/`warn`/`error`/`debug`), filling missing methods with a no-op, so *both* call shapes are total. Test in **Task 6**: `createHostServices({ logger: {} }).logger.info("x")` returns `undefined` and does not throw; and `createHostServices({})` (no logger at all) likewise.
2. **`securePath()` is called on a path that is a Unix domain socket, and on Windows on a named pipe.** `lib/providers/scoped-embedding-ipc.js:435` chmods a live listening socket; `ipcAddress()` will later return `\\.\pipe\…` on win32, which has no filesystem ACL and would make `icacls` fail the whole embedding-owner start-up. **Fix:** `securePath()` returns a result object and refuses non-filesystem addresses (`{ applied: false, reason: "not-a-filesystem-path" }`) instead of throwing, and on POSIX chmods sockets normally. Test in **Task 4**: bind a real `net.Server` on a UDS in a temp dir, call `securePath(sock, { mode: 0o600 })`, assert `applied === true` and `statSync(sock).mode & 0o777 === 0o600`; with `process.platform` stubbed to `"win32"`, assert `securePath("\\\\.\\pipe\\plur1bus-x")` returns `{ applied: false, reason: "not-a-filesystem-path" }`.
3. **The split introduces an ESM import cycle, which fails silently.** `adapter/openclaw/register-recall-hook.js` importing something from `index.js` while `index.js` imports it back yields an `undefined` binding at call time, not a load error — the hook would register and then throw on the first turn, long after the tests that only check registration. **Fix:** adapter and engine modules receive *everything* through their context object and import only from `lib/**`; `scripts/lint-engine-imports.mjs` (Task 10) walks the static `import` graph of `engine/**` and `adapter/**` and fails on any cycle and on any import of `index.js`. Test in **Task 10**: the script, run against a fixture directory containing a deliberate `a.js ↔ b.js` cycle, exits 1 and names both files.
4. **A moved symbol disappears from `index.js`'s export list and 46 test files silently import `undefined`.** ESM named-import of a missing binding *is* a load error, but a symbol that becomes `undefined` through a re-export chain is not. **Fix:** a guard test asserts every publicly re-exported name is present and of the right kind. Test in **Task 10** (`tests/index-public-exports.test.js`): import `* as index from "../index.js"` and assert each of the 19 exported names is `typeof "function"` (classes included) and that `index.default` has `id === "memory-lancedb-namespaced"` and `typeof register === "function"`.
5. **The golden test is non-deterministic because block 4 prints the wall clock.** `formatTimeContext` (`lib/session-time.js:68-88`) emits `Current time: <YYYY-MM-DD HH:mm> Europe/Zurich (UTC …)` into the **non-droppable** `time` block on every turn, so a naive capture/replay differs on the second run. **Fix:** `freezeClock()` replaces `globalThis.Date` with a subclass whose `now()` and zero-arg constructor return a fixed epoch (`2026-01-15T12:00:00Z`), restored in a `finally`; verified working with LanceDB in this container. Additionally the capture tool runs every scenario **twice, each with a fresh `plugin.register()`**, and refuses to write the oracle unless both runs are byte-identical. Test in **Tasks 1 and 2**.

---

## File Structure

| Path | Created / modified in | Responsibility |
|---|---|---|
| `tests/helpers/golden-prefix-driver.js` | Task 1 | Drives `before_prompt_build` against a stub `api`, frozen clock and stub embedder; the single source of truth for how a scenario is executed |
| `tests/fixtures/golden-prefix/scenarios.js` | Task 1 | The five synthetic scenarios (data only) |
| `tests/fixtures/golden-prefix/expected/*.txt` | Task 1 (write-once) | The oracle: one file per scenario holding the exact `prependContext` |
| `tools/capture-golden-prefix.mjs` | Task 1 | Writes the oracle; refuses on non-determinism. Not shipped (`tools/` is outside `package.json:files`) |
| `tests/golden-prefix.test.js` | Task 2 | Replays every scenario and asserts byte-identity against the oracle |
| `types/engine.d.ts` | Task 3 | The frozen engine contract (B8) |
| `types/engine.conformance.ts` | Task 3 | Compile-only assertions that make `tsc --noEmit` meaningful |
| `tsconfig.json`, `scripts/typecheck.mjs` | Task 3 | `npm run typecheck` |
| `lib/platform.js` | Task 4 | `securePath`, `ipcAddress`, `isUnsafeLink`, `canonicalIdentityPath` |
| `tests/platform.test.js` | Task 4 | Platform unit tests incl. stubbed-`win32` branches |
| `lib/host-services.js` | Task 6 | `createHostServices(api)` and `createStubHost(overrides)` |
| `tests/host-services.test.js` | Task 6 | Host-services unit tests |
| `scripts/lint-no-api-outside-adapter.mjs` | Task 9 | Forbids `api.` outside the allowlist |
| `tools/free-identifiers.mjs` | Task 10 | TS-compiler-API scope analyser that produces each move's exact context key set |
| `scripts/lint-engine-imports.mjs` | Task 10 | Dependency rule + cycle detector for `engine/**` and `adapter/**` |
| `tests/index-public-exports.test.js` | Task 10 | Guards the 19 public names |
| `adapter/openclaw/register-turn-route.js` | Task 11 | `reply_dispatch` + `agent_end` turn-route cleanup |
| `engine/recall/minimal-maintenance.js` + `adapter/openclaw/register-maintenance-hook.js` | Task 12 | The auto-recall-off `before_prompt_build` branch |
| `engine/recall/assemble-prompt-context.js` + `adapter/openclaw/register-recall-hook.js` | Task 13 | The recall assembly and its registration |
| `engine/capture/capture-turn.js` + `adapter/openclaw/register-capture-hook.js` | Task 14 | Auto-capture |
| `engine/commands/plur1bus-command.js` | Task 15 | `runPlur1busCommand`, including the 17 internal job runners |
| `adapter/openclaw/register-commands.js` | Task 16 | Chat-command registration |
| `adapter/openclaw/register-tools.js`, `adapter/openclaw/register-prompt-supplements.js` | Task 17 | Tool factory and the static system-prompt supplement |
| `adapter/openclaw/register-gateway.js`, `adapter/openclaw/register-cron.js` | Task 18 | Gateway lifecycle, shutdown services, feature-cron hooks |
| `adapter/openclaw/README.md` | Task 18 | What the adapter registers, and what M1a leaves in `index.js` |
| `bench/recall-budget-probe.mjs` | Task 19 | B6 p50/p95/p99 measurement |
| `docs/engine-api.md`, `docs/compatibility-openclaw.md`, `CHANGELOG.md` | Task 20 | Documentation |

Each task also creates its own `tests/…` file; those are named in the task and are not repeated here.

---

### Task 1: Golden-prefix corpus — driver, scenarios, and the write-once oracle

**This task must run first, on an otherwise unmodified branch.** It only adds files under `tests/` and `tools/` and one line of `package.json:scripts.lint`; it changes no product code, so the strings it captures are the behaviour of `main` @ `89148f9`.

**Files:**
- Create: `tests/helpers/golden-prefix-driver.js`
- Create: `tests/fixtures/golden-prefix/scenarios.js`
- Create: `tools/capture-golden-prefix.mjs`
- Create (generated, write-once): `tests/fixtures/golden-prefix/expected/{recall-basic,recall-empty-store,recall-knowledge-canonical,recall-over-budget,recall-maintenance-only}.txt`
- Modify: `package.json` — `scripts.lint` only

**Interfaces:**
- Produces: `runScenario(scenario) -> Promise<string|null>`; `SCENARIOS: Scenario[]` where `Scenario = { name, agentId, workspaceKey, knowledge?: string, topics: Record<string,string>, memories: Array<{id,text,summary,category,ageDays}>, config: object, event: object, ctx: object }`; `FROZEN_NOW`, `VECTOR_DIM`, `freezeClock(now?)`, `topicVector(topic)`.
- Consumed by: Task 2 (`tests/golden-prefix.test.js`) and Task 18 (`bench/recall-budget-probe.mjs`).

**Design notes you need before writing code (all verified at `89148f9`):**
- `plugin.register(api, { importRouting })` registers `before_prompt_build` via `api.on`; the recall handler is the **last** one registered (`index.js:12285`), after the reply-outcome one (`:12216`), so `handlers.get("before_prompt_build").at(-1)` is the recall hook.
- `formatTimeContext` prints the wall clock into the non-droppable `time` block — hence `freezeClock`.
- The default embedding model is `intfloat/multilingual-e5-small` with a **fixed 384 dimensions**; `lib/providers/config-normalize.js:27` throws if you configure anything else. `VECTOR_DIM` is therefore 384.
- `recall.minScore` is **not** a valid config key (`lib/setup/config-contract.js` rejects it). Control ranking through the stub embedder instead: each fixture text is mapped to a *topic*, and a topic becomes a unit vector on one axis, so a query and its intended matches have distance 0.
- In legacy-flat namespace mode (`lib/namespace-config.js:123-133`, the mode you get when `namespaces` is absent from the config) an agent's table lives at `join(baseDbPath, agentId)`.
- `markNeoRecallInjection` (`index.js:5575-5592`) is a *dedupe* keyed on `runId|sessionKey|agentId|prompt` and returns `null` the second time within one `register()`. That is why each run gets a fresh `plugin.register()`.

- [ ] **Step 1: Write the driver**

Create `tests/helpers/golden-prefix-driver.js`:

```js
/**
 * tests/helpers/golden-prefix-driver.js
 *
 * Runs one golden-prefix scenario through the real `before_prompt_build`
 * handler with a stub OpenClaw `api`, a frozen clock and a deterministic
 * embedding provider. No network, no model download, no write outside
 * os.tmpdir(). The string it returns is the exact `prependContext` the model
 * would have seen.
 */

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import plugin, { MemoryDB } from "../../index.js";
import { LocalTransformersEmbeddingProvider } from "../../lib/providers/embedding-local-transformers.js";

/** 2026-01-15T12:00:00Z — every scenario is evaluated at this instant. */
export const FROZEN_NOW = Date.UTC(2026, 0, 15, 12, 0, 0);

/** intfloat/multilingual-e5-small is fixed at 384 dims; the config contract
 *  rejects any other value (lib/providers/config-normalize.js:27). */
export const VECTOR_DIM = 384;

/**
 * Replace globalThis.Date with a frozen subclass. `Date.now()` and `new Date()`
 * return `now`; every other static (UTC, parse) is inherited.
 * @param {number} [now]
 * @returns {() => void} restore function
 */
export function freezeClock(now = FROZEN_NOW) {
  const RealDate = globalThis.Date;
  class FrozenDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(now);
      else super(...args);
    }
    static now() { return now; }
  }
  globalThis.Date = FrozenDate;
  return () => { globalThis.Date = RealDate; };
}

/**
 * One topic -> one unit vector on one axis. Two texts with the same topic get
 * distance 0; two texts with different topics get distance sqrt(2).
 * @param {string} topic
 * @returns {number[]}
 */
export function topicVector(topic) {
  const digest = createHash("sha256").update(String(topic)).digest();
  const axis = ((digest[0] << 8) | digest[1]) % VECTOR_DIM;
  const out = new Array(VECTOR_DIM).fill(0);
  out[axis] = 1;
  return out;
}

function stubEmbedder(topicOf) {
  const proto = LocalTransformersEmbeddingProvider.prototype;
  const originalQuery = proto.embedQuery;
  const originalPassage = proto.embedPassage;
  proto.embedQuery = async (text) => topicVector(topicOf(text));
  proto.embedPassage = async (text) => topicVector(topicOf(text));
  return () => { proto.embedQuery = originalQuery; proto.embedPassage = originalPassage; };
}

const routingCapability = Object.freeze({
  parseAgentSessionKey(value) {
    const match = /^agent:([^:]+):(.+)$/.exec(value);
    return match ? { agentId: match[1], rest: match[2] } : null;
  },
  parseThreadSessionSuffix(value) { return { baseSessionKey: value, threadId: "" }; },
  normalizeOptionalAccountId(value) {
    return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : undefined;
  },
  normalizeMessageChannel(value) {
    return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : undefined;
  },
});

function makeApi(pluginConfig) {
  const handlers = new Map();
  const noop = () => {};
  return {
    pluginConfig,
    config: {},
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    resolvePath: (value) => value,
    registerCommand: noop,
    registerTool(factory) { this.toolFactory = factory; },
    registerService: noop,
    on(name, handler) {
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name).push(handler);
      return { dispose: noop };
    },
    handlers,
  };
}

/**
 * Every feature that would reach the network, a model file or a background
 * scheduler is off. Scenario `config` is merged on top.
 * @param {string} baseDbPath
 * @param {object} [overrides]
 */
export function baseConfig(baseDbPath, overrides = {}) {
  return {
    baseDbPath,
    embedding: { provider: "local-transformers", local: { dimensions: VECTOR_DIM } },
    autoCapture: false,
    autoRecall: true,
    merging: { enabled: false },
    duplicateThreshold: 0.9999,
    obsidianBridge: { enabled: false },
    neo: { enabled: false },
    gc: { enabled: false },
    continuityEngine: { enabled: false },
    conversationReactivationRecall: { enabled: false },
    replyOutcomeTracking: { enabled: false },
    temporalContext: { enabled: false },
    personaVoice: { enabled: false },
    emotion: { t3: { enabled: false } },
    dreaming: { enabled: false },
    skillMiner: { enabled: false },
    runtime: { recallTimeoutMs: 10_000 },
    recall: {
      dedup: false,
      canonicalFirst: true,
      canonicalMaxItems: 1,
      maxPromptMemories: 5,
      decisionTrace: { enabled: false, includeInPrompt: false },
      globalInjectMaxChars: 17_000,
    },
    ...overrides,
  };
}

/**
 * @param {object} scenario
 * @returns {Promise<string|null>} the exact prependContext, or null when the
 *   handler returned undefined.
 */
export async function runScenario(scenario) {
  const restoreClock = freezeClock();
  const topics = new Map(Object.entries(scenario.topics || {}));
  const topicOf = (text) => topics.get(String(text)) ?? String(text);
  const restoreEmbedder = stubEmbedder(topicOf);
  const baseDbPath = mkdtempSync(join(tmpdir(), "plur1bus-golden-db-"));
  const workspaceDir = mkdtempSync(join(tmpdir(), "plur1bus-golden-ws-"));
  const stateDir = mkdtempSync(join(tmpdir(), "plur1bus-golden-state-"));
  const previousHome = process.env.OPENCLAW_HOME;
  process.env.OPENCLAW_HOME = stateDir;
  try {
    mkdirSync(join(workspaceDir, "memory"), { recursive: true });
    if (scenario.knowledge) {
      writeFileSync(join(workspaceDir, "memory", "KNOWLEDGE.md"), scenario.knowledge);
    }
    const db = new MemoryDB(join(baseDbPath, scenario.agentId), VECTOR_DIM);
    for (const memory of scenario.memories) {
      await db.store({
        id: memory.id,
        text: memory.text,
        summary: memory.summary,
        vector: topicVector(topicOf(memory.text)),
        category: memory.category,
        createdAt: FROZEN_NOW - (memory.ageDays ?? 1) * 86_400_000,
        storedBy: scenario.agentId,
        workspaceKey: scenario.workspaceKey,
      });
    }
    const api = makeApi(baseConfig(baseDbPath, scenario.config));
    plugin.register(api, { importRouting: async () => routingCapability });
    const hooks = api.handlers.get("before_prompt_build");
    const hook = hooks?.at(-1);
    if (typeof hook !== "function") throw new Error(`${scenario.name}: before_prompt_build not registered`);
    const result = await hook(scenario.event, { ...scenario.ctx, workspaceDir });
    for (const stop of api.handlers.get("gateway_stop") || []) await stop();
    return result?.prependContext ?? null;
  } finally {
    if (previousHome === undefined) delete process.env.OPENCLAW_HOME;
    else process.env.OPENCLAW_HOME = previousHome;
    restoreEmbedder();
    restoreClock();
    rmSync(baseDbPath, { recursive: true, force: true });
    rmSync(workspaceDir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
}
```

- [ ] **Step 2: Write the five scenarios**

Create `tests/fixtures/golden-prefix/scenarios.js`. All text is invented; no real user data.

```js
/**
 * tests/fixtures/golden-prefix/scenarios.js
 *
 * Five synthetic recall scenarios. `topics` maps a fixture string to the axis
 * the stub embedder puts it on, so recall order is a property of the fixture
 * and not of a downloaded model.
 */

const AGENT = "golden-agent";
const WORKSPACE = "golden-workspace";

function ctxFor(session, run) {
  return {
    agentId: AGENT,
    workspaceKey: WORKSPACE,
    sessionKey: `agent:${AGENT}:${session}`,
    sessionId: session,
    runId: run,
    chatId: "golden-chat",
  };
}

function eventFor(prompt, session, run) {
  return {
    prompt,
    messages: [{ role: "user", content: prompt }],
    sessionKey: `agent:${AGENT}:${session}`,
    sessionId: session,
    runId: run,
  };
}

/** A block of filler large enough to push the join past the 17 000-char cap. */
const FILLER = "Deployment note. ".repeat(700); // ~11 900 chars

export const SCENARIOS = [
  {
    name: "recall-basic",
    agentId: AGENT,
    workspaceKey: WORKSPACE,
    topics: {
      "what dashboard theme do I like": "dashboard",
      "The user prefers a navy dashboard theme.": "dashboard",
      "navy dashboard": "dashboard",
      "The release decision was made on 2026-01-02.": "release",
      "release decision": "release",
    },
    memories: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        text: "The user prefers a navy dashboard theme.",
        summary: "navy dashboard",
        category: "preference",
        ageDays: 3,
      },
      {
        id: "22222222-2222-4222-8222-222222222222",
        text: "The release decision was made on 2026-01-02.",
        summary: "release decision",
        category: "fact",
        ageDays: 10,
      },
    ],
    config: {},
    event: eventFor("what dashboard theme do I like", "golden-session-1", "golden-run-1"),
    ctx: ctxFor("golden-session-1", "golden-run-1"),
  },
  {
    name: "recall-empty-store",
    agentId: AGENT,
    workspaceKey: WORKSPACE,
    topics: { "is there anything you remember": "nothing" },
    memories: [],
    config: {},
    event: eventFor("is there anything you remember", "golden-session-2", "golden-run-2"),
    ctx: ctxFor("golden-session-2", "golden-run-2"),
  },
  {
    name: "recall-knowledge-canonical",
    agentId: AGENT,
    workspaceKey: WORKSPACE,
    knowledge: "# Knowledge\n\nThe project ships on Fridays and never on a public holiday.\n",
    topics: {
      "when does the project ship": "shipping",
      "The team agreed to ship on Fridays.": "shipping",
      "ship on fridays": "shipping",
    },
    memories: [
      {
        id: "33333333-3333-4333-8333-333333333333",
        text: "The team agreed to ship on Fridays.",
        summary: "ship on fridays",
        category: "fact",
        ageDays: 5,
      },
    ],
    config: {},
    event: eventFor("when does the project ship", "golden-session-3", "golden-run-3"),
    ctx: ctxFor("golden-session-3", "golden-run-3"),
  },
  {
    name: "recall-over-budget",
    agentId: AGENT,
    workspaceKey: WORKSPACE,
    topics: {
      "what do you know about the deployment": "deployment",
      [`Deployment runbook A. ${FILLER}`]: "deployment",
      [`Deployment runbook B. ${FILLER}`]: "deployment",
      "runbook A": "deployment",
      "runbook B": "deployment",
    },
    memories: [
      {
        id: "44444444-4444-4444-8444-444444444444",
        text: `Deployment runbook A. ${FILLER}`,
        summary: "runbook A",
        category: "fact",
        ageDays: 2,
      },
      {
        id: "55555555-5555-4555-8555-555555555555",
        text: `Deployment runbook B. ${FILLER}`,
        summary: "runbook B",
        category: "fact",
        ageDays: 4,
      },
    ],
    config: { recall: { dedup: false, canonicalFirst: true, canonicalMaxItems: 1, maxPromptMemories: 5, decisionTrace: { enabled: false, includeInPrompt: false }, globalInjectMaxChars: 17_000 } },
    event: eventFor("what do you know about the deployment", "golden-session-4", "golden-run-4"),
    ctx: ctxFor("golden-session-4", "golden-run-4"),
  },
  {
    name: "recall-maintenance-only",
    agentId: AGENT,
    workspaceKey: WORKSPACE,
    topics: { "hello again": "greeting" },
    memories: [
      {
        id: "66666666-6666-4666-8666-666666666666",
        text: "The user greeted the agent yesterday.",
        summary: "greeting",
        category: "fact",
        ageDays: 1,
      },
    ],
    // autoRecall off drives the third before_prompt_build registration
    // (index.js:13354-13443), the maintenance-only fallback branch.
    config: { autoRecall: false, gc: { enabled: true } },
    event: eventFor("hello again", "golden-session-5", "golden-run-5"),
    ctx: ctxFor("golden-session-5", "golden-run-5"),
  },
];
```

- [ ] **Step 3: Write the capture tool**

Create `tools/capture-golden-prefix.mjs`:

```js
/**
 * tools/capture-golden-prefix.mjs — write the golden-prefix oracle.
 *
 * Runs every scenario twice, each with a fresh plugin.register(), and refuses
 * to write anything unless both runs are byte-identical. Run once, on
 * unmodified main. Never re-run to "fix" a failing golden test.
 *
 * Usage: node tools/capture-golden-prefix.mjs [--force]
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { SCENARIOS } from "../tests/fixtures/golden-prefix/scenarios.js";
import { runScenario } from "../tests/helpers/golden-prefix-driver.js";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "tests", "fixtures", "golden-prefix", "expected");
const force = process.argv.includes("--force");

mkdirSync(outDir, { recursive: true });

let failures = 0;
for (const scenario of SCENARIOS) {
  const first = await runScenario(scenario);
  const second = await runScenario(scenario);
  if (first !== second) {
    console.error(`NON-DETERMINISTIC: ${scenario.name}`);
    console.error(`  run 1: ${JSON.stringify(first)}`);
    console.error(`  run 2: ${JSON.stringify(second)}`);
    failures += 1;
    continue;
  }
  if (first === null) {
    console.error(`EMPTY: ${scenario.name} produced no prependContext; fix the scenario`);
    failures += 1;
    continue;
  }
  const target = join(outDir, `${scenario.name}.txt`);
  if (existsSync(target) && !force) {
    console.error(`REFUSING to overwrite existing oracle ${target} (pass --force only if you know why)`);
    failures += 1;
    continue;
  }
  writeFileSync(target, first, "utf8");
  console.log(`wrote ${target} (${first.length} chars)`);
}

if (failures > 0) {
  console.error(`${failures} scenario(s) failed; no partial oracle is trustworthy`);
  process.exit(1);
}
console.log(`captured ${SCENARIOS.length} scenarios`);
```

- [ ] **Step 4: Teach `npm run lint` about `tools/`**

In `package.json`, change the `lint` script's last `find` from `find scripts -name '*.mjs'` to `find scripts tools -name '*.mjs'`. The full value becomes:

```json
"lint": "node --check index.js && find lib tests test -name '*.js' -exec node --check {} + && find scripts tools -name '*.mjs' -exec node --check {} +",
```

- [ ] **Step 5: Run the capture and read the output**

```bash
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH node tools/capture-golden-prefix.mjs
```

Expected: five `wrote …/expected/<name>.txt (<n> chars)` lines then `captured 5 scenarios`, exit 0. A `NON-DETERMINISTIC` line means a source of entropy is still live — do **not** delete the scenario; find the entropy (diff the two printed strings) and make the fixture pin it. A `recall-empty-store` result that is non-null but tiny (mood directive + time block only) is expected and correct.

- [ ] **Step 6: Verify the oracle is real and re-running is refused**

```bash
cd "$PLUR1BUS" && head -c 400 tests/fixtures/golden-prefix/expected/recall-basic.txt; echo
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH node tools/capture-golden-prefix.mjs; echo "exit=$?"
```

Expected: the first command prints a `<relevant-memories untrusted="true" …>` block containing `11111111-1111-4111-8111-111111111111`; the second prints five `REFUSING to overwrite` lines and `exit=1`.

- [ ] **Step 7: Lint and full suite**

```bash
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm run lint
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm test 2>&1 | tail -20
```

Expected: lint exits 0; the suite shows `pass 5071`, `fail 2` with only the two accepted baseline failures.

- [ ] **Step 8: Commit**

```bash
cd "$PLUR1BUS"
git add tests/helpers/golden-prefix-driver.js tests/fixtures/golden-prefix tools/capture-golden-prefix.mjs package.json
git commit -m "test: capture the golden-prefix oracle on unmodified main

Five synthetic before_prompt_build scenarios, a frozen clock, a topic-axis
stub embedder and a capture tool that refuses to write unless two fresh
register() runs agree byte for byte. This is the behaviour-neutrality
instrument for PR-01..PR-03."
```

---

### Task 2: Golden-prefix byte-identity regression test

**Files:**
- Create: `tests/golden-prefix.test.js`

**Interfaces:**
- Consumes: `SCENARIOS` from `tests/fixtures/golden-prefix/scenarios.js`, `runScenario` from `tests/helpers/golden-prefix-driver.js` (Task 1).
- Produces: the check every later task runs — `node --test --test-concurrency=1 tests/golden-prefix.test.js`.

- [ ] **Step 1: Write the failing test**

Create `tests/golden-prefix.test.js`:

```js
/**
 * tests/golden-prefix.test.js
 *
 * The behaviour-neutrality gate for the engine extraction: every scenario's
 * prependContext must stay byte-identical to the oracle captured on main
 * @ 89148f9. If this fails, the refactor changed what the model sees.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { SCENARIOS } from "./fixtures/golden-prefix/scenarios.js";
import { runScenario } from "./helpers/golden-prefix-driver.js";

const expectedDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "golden-prefix", "expected");

describe("golden prefix corpus", () => {
  for (const scenario of SCENARIOS) {
    it(`${scenario.name} produces the recorded prependContext byte for byte`, async () => {
      const expected = readFileSync(join(expectedDir, `${scenario.name}.txt`), "utf8");
      const actual = await runScenario(scenario);
      assert.equal(typeof actual, "string", `${scenario.name} returned no prependContext`);
      assert.equal(actual, expected);
    });
  }

  it("is deterministic across two fresh registrations", async () => {
    const scenario = SCENARIOS[0];
    const first = await runScenario(scenario);
    const second = await runScenario(scenario);
    assert.equal(first, second);
  });

  it("covers at least five scenarios", () => {
    assert.ok(SCENARIOS.length >= 5, `expected >= 5 scenarios, found ${SCENARIOS.length}`);
  });
});
```

- [ ] **Step 2: Run it and confirm it passes against the oracle**

```bash
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/golden-prefix.test.js
```

Expected: `pass 7`, `fail 0` (5 scenarios + determinism + count).

- [ ] **Step 3: Prove the test can fail**

Temporarily append one character to the oracle and confirm the gate trips:

```bash
cd "$PLUR1BUS" && printf 'X' >> tests/fixtures/golden-prefix/expected/recall-basic.txt
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/golden-prefix.test.js; echo "exit=$?"
cd "$PLUR1BUS" && git checkout -- tests/fixtures/golden-prefix/expected/recall-basic.txt
```

Expected: the middle command reports `fail 1` on `recall-basic …` and `exit=1`; the third restores the oracle. Re-run step 2 and confirm it is green again before committing.

- [ ] **Step 4: Full suite**

```bash
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm test 2>&1 | tail -20
```

Expected: accepted baseline (2 failures).

- [ ] **Step 5: Commit**

```bash
cd "$PLUR1BUS"
git add tests/golden-prefix.test.js
git commit -m "test: assert the golden prefix corpus is byte-identical

Run after every extraction task: node --test --test-concurrency=1 tests/golden-prefix.test.js"
```

---

### Task 3: Freeze the engine contract — `types/engine.d.ts` and `npm run typecheck`

Behaviour-neutral: pure addition. Closes review-report finding S4 and owner decision B8 *before* PR-01, so both adapters are written against one shape.

**Files:**
- Create: `types/engine.d.ts`
- Create: `types/engine.conformance.ts`
- Create: `tsconfig.json`
- Create: `scripts/typecheck.mjs`
- Modify: `package.json` — add `scripts.typecheck`, chain it into `scripts.lint`, add `"types/"` to `files`

**Interfaces:**
- Produces: the type names `HostServices` (= ADR-002's `Host`), `Engine`, `Principal`, `AgentContext`, `TurnOrigin`, `RecallQuery`, `RecallResult`, `ContextBlock`, `Degraded`, `CaptureHandle`, `JobRun`, `JobRegistry`, `EmbeddingService`, `AdminOps`, `EngineEvents`, `PlatformCapabilities`, `SecurePathResult`, `IpcAddress`. Task 4 implements `PlatformCapabilities`; Task 6 implements the runtime half of `HostServices`.
- Consumes: nothing.

**The four reconciliations B8 fixed** (ADR-002 §"Engine API surface" vs `engine-extraction.md` §b.2): `Principal.trust: "proved" | "inferred"` wins over `proof: "transport"`; `TurnOrigin` is a string union with a separate `AgentContext` (not one object); `capture()` returns a non-blocking `CaptureHandle` (not a promise); `RecallResult.degraded` is `Degraded | null` (not a boolean). The conformance file below fails the build if any of the four drifts.

- [ ] **Step 1: Write the frozen contract**

Create `types/engine.d.ts`:

```ts
/**
 * types/engine.d.ts — the frozen PLUR1BUS engine contract.
 *
 * Contract version 1.0.0 (frozen 2026-09-22, owner decision B8).
 *
 * This file reconciles the four places Phase 0 sketched the same API
 * differently (review-report finding S4). Where ADR-002 and
 * engine-extraction.md §b.2 disagreed, B8 chose:
 *   - `Principal.trust: "proved" | "inferred"`   (not `proof: "transport"`)
 *   - `TurnOrigin` as a string union plus a separate `AgentContext`
 *     (not one `TurnOrigin` object)
 *   - `capture()` returns a non-blocking `CaptureHandle`
 *     (not `Promise<CaptureResult>`)
 *   - `RecallResult.degraded` is a structured object or null
 *     (not a boolean)
 *
 * Nothing in this file is implemented in M1a. It is the shape both the
 * OpenClaw adapter and the harness are written against, and it is checked
 * by `npm run typecheck`.
 */

export type ContractVersion = "1.0.0";

/* ------------------------------------------------------------------ */
/* Primitives                                                          */
/* ------------------------------------------------------------------ */

/** Matches /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/ (memory-host-runtime.js:30). */
export type AgentId = string;

export type WorkspacePrincipal = `workspace:v1:${string}` | `workspace-dir:v1:${string}`;

/** `user:v1:` + sha256(JSON.stringify([channel, accountId, userId])).
 *  The hash is the on-disk pool directory name and must not change
 *  (memory-request-context.js:302-304). */
export type UserPrincipal = `user:v1:${string}`;

export type ChatKind = "direct" | "dm" | "group" | "channel";

/** Open vocabulary, host-declared. Replaces the closed four-value set at
 *  memory-request-context.js:24-25. */
export type ChannelRef = string;

export type TurnOrigin = "user" | "cron" | "subagent" | "heartbeat" | "system";

export type SchemaVersion = string;

export interface Disposable {
  dispose(): void;
}

export interface Logger {
  info(message: string, ...rest: unknown[]): void;
  warn(message: string, ...rest: unknown[]): void;
  error(message: string, ...rest: unknown[]): void;
  debug(message: string, ...rest: unknown[]): void;
}

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

/* ------------------------------------------------------------------ */
/* Identity                                                            */
/* ------------------------------------------------------------------ */

export interface Principal {
  agentId: AgentId;
  workspace: WorkspacePrincipal;
  /** Absent means the `user` ACL scope is unreachable
   *  (acl-middleware.js:139-159). Never accepted from an untrusted host. */
  user?: UserPrincipal;
  channel: ChannelRef;
  accountId: string;
  chat: { id: string; kind: ChatKind };
  /** "inferred" degrades every read and write to agent-private and never
   *  throws (memory-request-context.js:1405-1417). */
  trust: "proved" | "inferred";
}

export interface AgentContext {
  origin: TurnOrigin;
  /** Fail-closed: unknown means true. */
  background: boolean;
  jobId?: string;
  parentRunId?: string;
}

/* ------------------------------------------------------------------ */
/* What the host gives the engine                                      */
/* ------------------------------------------------------------------ */

export interface SecretStore {
  /** Short-lived; the engine never persists the value. */
  lease(ref: string): Promise<string>;
}

export interface LlmParams {
  messages: Message[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface LlmResult {
  text: string;
  model?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface PlatformCapabilities {
  securePath(path: string, options?: { mode?: number }): SecurePathResult;
  ipcAddress(stateRoot: string): IpcAddress;
  isUnsafeLink(path: string): boolean;
  canonicalIdentityPath(path: string): string;
}

export interface SecurePathResult {
  applied: boolean;
  reason?: "not-a-filesystem-path" | "missing" | "unsupported-platform";
  mechanism?: "chmod" | "acl";
}

export interface IpcAddress {
  kind: "abstract-socket" | "unix-socket" | "named-pipe";
  address: string;
}

/** `HostServices` is the name used in engine-extraction.md §b.2; ADR-002
 *  calls the same interface `Host`. They are one type. */
export interface HostServices {
  logger: Logger;
  /** Replaces OPENCLAW_HOME (index.js:12425). */
  stateDir: string;
  /** Replaces memory-host-runtime.js:104-111. A harness agent without a real
   *  workspace gets a synthetic one under `stateDir` (engine-extraction R7). */
  workspaceDir(agentId: AgentId): string | undefined;
  config(): EngineConfig;
  mutateConfig?(patch: Record<string, unknown>): Promise<void>;
  llm?: { complete(params: LlmParams): Promise<LlmResult> };
  secrets?: SecretStore;
  events?: { emit(name: string, payload: unknown): void };
  /** Test seam; defaults to Date.now. */
  clock?: () => number;
  platform: PlatformCapabilities;
  /** Host runtime escape hatch; `null` when the host exposes none. Replaces
   *  runtimeIfUsable(api) (runtime-shutdown.js:35). */
  runtime: HostRuntime | null;
}

export interface HostRuntime {
  config?: { current?(): unknown; mutateConfigFile?(...args: unknown[]): unknown };
  agent?: {
    resolveAgentWorkspaceDir?(config: unknown, agentId: AgentId): Promise<string> | string;
    session?: { getSessionEntry?(query: unknown): unknown };
  };
  llm?: { complete?(params: unknown): Promise<unknown> };
}

/** The 56 keys of openclaw.plugin.json configSchema. Kept open in 1.0.0 so
 *  the contract does not have to move every time a key is added. */
export interface EngineConfig {
  [key: string]: unknown;
}

/* ------------------------------------------------------------------ */
/* Recall                                                              */
/* ------------------------------------------------------------------ */

export type ContextBlockName = "neo" | "start" | "memories" | "time" | "temporal" | "reminder" | (string & {});

export interface ContextBlock {
  name: ContextBlockName;
  text: string;
  droppable: boolean;
  tokensEstimate?: number;
}

export interface RecallBudget {
  softMs: number;
  hardMs: number;
  capChars: number;
}

export interface RecallQuery {
  query: string;
  principal: Principal;
  agent: AgentContext;
  budget: RecallBudget;
  /** MANDATORY from PR-05. Fixes host-contract §f.1. */
  signal: AbortSignal;
  compactedAt?: number | null;
  previousUserTurnAt?: number | null;
  validAt?: string;
}

export interface Degraded {
  reason: string;
  capability: string;
  detail?: string;
}

export interface DecisionTrace {
  [key: string]: unknown;
}

export interface RecallResult {
  blocks: ContextBlock[];
  capChars: number;
  /** null means not degraded. Structured, never a bare boolean (B8). */
  degraded: Degraded | null;
  trace?: DecisionTrace;
  timings: Record<string, number>;
}

/* ------------------------------------------------------------------ */
/* Capture and checkpoint                                              */
/* ------------------------------------------------------------------ */

export interface TurnRecord {
  agentId: AgentId;
  principal: Principal;
  agent: AgentContext;
  messages: Message[];
  runId?: string;
  sessionKey?: string;
  /** Classified by the host, fail-closed. */
  incognito: boolean;
  signal: AbortSignal;
}

export interface CaptureResult {
  stored: number;
  skipped: number;
  reason?: string;
}

/** Non-blocking by contract (B8, ADR-002 "capture returns in < 5 ms"): the
 *  caller gets the handle immediately and may await `done` or abandon it. */
export interface CaptureHandle {
  id: string;
  acceptedAt: number;
  done: Promise<CaptureResult>;
  abort(reason?: string): void;
}

export type CheckpointReason = "compaction" | "shutdown" | "manual";

export interface CheckpointResult {
  agentId: AgentId;
  reason: CheckpointReason;
  /** Idempotency key over the transcript digest. */
  digest: string;
  written: boolean;
}

/* ------------------------------------------------------------------ */
/* Jobs                                                                */
/* ------------------------------------------------------------------ */

export type JobName =
  | "persona-evolve" | "afterthought" | "consolidate-daily" | "auto-accept-stale"
  | "embedding-drain" | "emotion-refine" | "classify-recent" | "rem-dream"
  | "skill-miner" | "discover-semantic-links" | "gc-run"
  | "reminder-dispatch" | "feedback-report" | "proactive-check" | "meta-reflect"
  | "skill-benefit-backfill" | "episodes-rebuild"
  | "light-dream";

export interface JobSpec {
  name: JobName;
  needsLlm: boolean;
  singleton: boolean;
  defaultSchedule?: { kind: "cron" | "every"; expr: string; timezone?: string };
  phase?: "light" | "rem" | "deep";
}

export interface JobRun {
  job: JobName;
  agentId: AgentId;
  partition?: string;
  startedAt: number;
  durationMs: number;
  outcome: "completed" | "skipped" | "failed" | "incomplete";
  reason?: string;
  counts: Record<string, number>;
  logRef?: string;
}

export interface JobRegistry {
  list(): JobSpec[];
  run(job: JobName, agentId: AgentId, opts?: { signal?: AbortSignal; dryRun?: boolean }): Promise<JobRun>;
  history(agentId: AgentId, job?: JobName, limit?: number): Promise<JobRun[]>;
}

/* ------------------------------------------------------------------ */
/* Embedding                                                           */
/* ------------------------------------------------------------------ */

export interface EmbeddingIdentity {
  fingerprintId: string;
  provider: string;
  model: string;
  dimensions: number;
}

export interface RerankHit {
  index: number;
  score: number;
}

export interface EmbeddingService {
  embed(texts: string[], o: { kind: "query" | "passage"; identity: EmbeddingIdentity; signal: AbortSignal }): Promise<Float32Array[]>;
  rerank(query: string, docs: string[], o: { topN: number; signal: AbortSignal }): Promise<RerankHit[]>;
  probe(): Promise<{ ok: boolean; error?: string; cached: boolean }>;
  identities(): EmbeddingIdentity[];
  serve(address: IpcAddress): Promise<Disposable>;
}

/* ------------------------------------------------------------------ */
/* Tools, commands, admin, events                                      */
/* ------------------------------------------------------------------ */

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface CommandSpec {
  name: string;
  description: string;
  acceptsArgs: boolean;
}

export interface CommandResult {
  text?: string;
  details?: Record<string, unknown>;
}

export interface ShareResult { id: string; targetId: string; reembedded: boolean }
export interface ForgetResult { id: string; archived: boolean; tombstoneId: string }
export interface MigrationResult { from: SchemaVersion; to: SchemaVersion; applied: boolean }

export interface AdminOps {
  share(sourceId: string, target: "workspace" | "user", p: Principal, confirm: { nonce: string }): Promise<ShareResult>;
  forget(id: string, p: Principal): Promise<ForgetResult>;
  reembedding: {
    plan(): Promise<unknown>; apply(): Promise<unknown>; resume(): Promise<unknown>;
    rollback(): Promise<unknown>; status(): Promise<unknown>; switch(): Promise<unknown>;
  };
  workspacePolicy: { get(): Promise<unknown>; list(): Promise<unknown>; set(patch: unknown): Promise<unknown> };
  obsidian: { detect(): Promise<unknown>; prepare(): Promise<unknown>; confirm(): Promise<unknown> };
  migrate(from: SchemaVersion, to: SchemaVersion): Promise<MigrationResult>;
}

export type EngineEventName =
  | "dream.completed" | "job.run" | "acl.denied" | "recall.degraded" | "embedding.identity.changed";

export interface EngineEvents {
  on(event: EngineEventName, handler: (payload: unknown) => void): Disposable;
}

export interface EngineStatus {
  ready: boolean;
  degraded: Degraded | null;
  agents: number;
  contract: ContractVersion;
}

export interface AgentStore {
  agentId: AgentId;
  close(): Promise<void>;
}

/* ------------------------------------------------------------------ */
/* The engine                                                          */
/* ------------------------------------------------------------------ */

export interface Engine {
  readonly contract: ContractVersion;

  open(agentId: AgentId): Promise<AgentStore>;
  close(): Promise<void>;
  status(): Promise<EngineStatus>;

  /** Stable, cached prefix (index.js:7073-7088). */
  systemSupplement(): string[];
  /** Never throws; a failure comes back as `degraded`. */
  recall(q: RecallQuery): Promise<RecallResult>;
  /** Non-blocking. */
  capture(t: TurnRecord): CaptureHandle;
  checkpoint(agentId: AgentId, reason: CheckpointReason): Promise<CheckpointResult>;

  tools: ToolSpec[];
  commands: CommandSpec[];
  runCommand(name: string, args: string, principal: Principal, agent: AgentContext): Promise<CommandResult>;

  jobs: JobRegistry;
  embedding: EmbeddingService;
  admin: AdminOps;
  events: EngineEvents;
}

export declare function createEngine(host: HostServices, config: EngineConfig): Engine;
```

- [ ] **Step 2: Write the compile-only conformance assertions**

Create `types/engine.conformance.ts`:

```ts
/**
 * types/engine.conformance.ts — compile-only assertions.
 *
 * A .d.ts on its own barely type-checks anything: this file makes
 * `npm run typecheck` fail if the contract drifts from the decisions
 * frozen in B8, or from the shapes the two adapters rely on. It is never
 * imported at runtime and emits nothing.
 */

import type {
  AgentContext, CaptureHandle, ContextBlock, Degraded, Engine, EngineConfig,
  HostServices, JobRun, Principal, RecallQuery, RecallResult, TurnOrigin,
  TurnRecord,
} from "./engine.js";

/** Compile-time equality assertion. */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
function assertTrue<T extends true>(): void { void 0 as unknown as T; }

// B8 decision 1: trust, not proof.
assertTrue<Exact<Principal["trust"], "proved" | "inferred">>();

// B8 decision 2: TurnOrigin is a string union and AgentContext is separate.
assertTrue<Exact<TurnOrigin, "user" | "cron" | "subagent" | "heartbeat" | "system">>();
assertTrue<Exact<AgentContext["origin"], TurnOrigin>>();
assertTrue<Exact<AgentContext["background"], boolean>>();

// B8 decision 3: capture is non-blocking.
assertTrue<Exact<ReturnType<Engine["capture"]>, CaptureHandle>>();

// B8 decision 4: degraded is a structured object or null, never a boolean.
assertTrue<Exact<RecallResult["degraded"], Degraded | null>>();

// The six named blocks and their droppability are the engine's output shape.
const blocks: ContextBlock[] = [
  { name: "neo", text: "", droppable: true },
  { name: "start", text: "", droppable: true },
  { name: "memories", text: "", droppable: true },
  { name: "time", text: "", droppable: false },
  { name: "temporal", text: "", droppable: false },
  { name: "reminder", text: "", droppable: false },
];
void blocks;

// The recall signal is mandatory (host-contract f.1).
declare const query: RecallQuery;
assertTrue<Exact<(typeof query)["signal"], AbortSignal>>();
declare const turn: TurnRecord;
assertTrue<Exact<(typeof turn)["signal"], AbortSignal>>();

// A job run always carries an outcome, including the skip and incomplete paths.
declare const run: JobRun;
assertTrue<Exact<(typeof run)["outcome"], "completed" | "skipped" | "failed" | "incomplete">>();

// A minimal host satisfies HostServices: everything optional stays optional.
const minimalHost: HostServices = {
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  stateDir: "/tmp/plur1bus",
  workspaceDir: () => undefined,
  config: (): EngineConfig => ({}),
  platform: {
    securePath: () => ({ applied: true, mechanism: "chmod" }),
    ipcAddress: () => ({ kind: "unix-socket", address: "/tmp/plur1bus/owner.sock" }),
    isUnsafeLink: () => false,
    canonicalIdentityPath: (p: string) => p,
  },
  runtime: null,
};
void minimalHost;
```

- [ ] **Step 3: Write `tsconfig.json`**

`"lib"` must include `DOM`, because `AbortSignal` is not in the ES libs and `@types/node` is not installed (and must not be added — Global Constraint 4). `"types": []` keeps the checker from scanning `node_modules/@types`.

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2023", "DOM"],
    "types": [],
    "strict": true,
    "noEmit": true,
    "skipLibCheck": false,
    "exactOptionalPropertyTypes": false,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["types/**/*.ts"]
}
```

- [ ] **Step 4: Write the typecheck runner**

`typescript` is an *optional* dependency, so `npm run lint` must give a clear message rather than a resolution stack trace when it is absent. Create `scripts/typecheck.mjs`:

```js
/**
 * scripts/typecheck.mjs — run `tsc --noEmit` over types/.
 *
 * typescript is an optionalDependency (it is also a runtime optional dep of
 * lib/code-index/workspace-indexer.js). If it did not install, say so plainly;
 * set PLUR1BUS_TYPECHECK_OPTIONAL=1 to downgrade that to a warning.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tsc = join(root, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");

if (!existsSync(tsc)) {
  const message = "typecheck: typescript is not installed (optionalDependency); run `npm install typescript`";
  if (process.env.PLUR1BUS_TYPECHECK_OPTIONAL === "1") {
    console.warn(`${message} — skipped`);
    process.exit(0);
  }
  console.error(message);
  process.exit(1);
}

const result = spawnSync(tsc, ["--noEmit", "-p", join(root, "tsconfig.json")], {
  stdio: "inherit",
  cwd: root,
});
process.exit(result.status ?? 1);
```

- [ ] **Step 5: Wire it into `package.json`**

Add to `scripts` (keep every existing script):

```json
"typecheck": "node scripts/typecheck.mjs",
```

and change `lint` so CI's existing `lint` job runs it (no workflow edit — Global Constraint 7):

```json
"lint": "node --check index.js && find lib tests test -name '*.js' -exec node --check {} + && find scripts tools -name '*.mjs' -exec node --check {} + && node scripts/typecheck.mjs",
```

Add `"types/"` to the `files` array, after `"scripts/"`. Nothing else in `files` changes; `types/engine.conformance.ts` ships too and is harmless (there is deliberately **no** `"types"` field in `package.json` — the `.d.ts` describes the future engine, not today's `index.js`, and pointing consumers at it would be a lie).

- [ ] **Step 6: Run the typecheck**

```bash
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm run typecheck; echo "exit=$?"
```

Expected: no output, `exit=0`.

- [ ] **Step 7: Prove the gate catches contract drift**

```bash
cd "$PLUR1BUS" && sed -i 's/  trust: "proved" | "inferred";/  trust: "transport";/' types/engine.d.ts
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm run typecheck; echo "exit=$?"
cd "$PLUR1BUS" && git checkout -- types/engine.d.ts 2>/dev/null || sed -i 's/  trust: "transport";/  trust: "proved" | "inferred";/' types/engine.d.ts
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm run typecheck; echo "exit=$?"
```

Expected: the second command prints `types/engine.conformance.ts(21,12): error TS2344: Type 'false' does not satisfy the constraint 'true'.` and `exit=2`; the last prints `exit=0`.

- [ ] **Step 8: Lint, suite, golden**

```bash
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm run lint
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/golden-prefix.test.js
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm test 2>&1 | tail -20
```

Expected: lint exits 0; golden `pass 7 / fail 0`; suite at the accepted baseline.

- [ ] **Step 9: Commit**

```bash
cd "$PLUR1BUS"
git add types tsconfig.json scripts/typecheck.mjs package.json
git commit -m "types: freeze the engine contract at 1.0.0 and add npm run typecheck

Reconciles the four disagreements review-report S4 found between ADR-002 and
engine-extraction.md b.2, per owner decision B8: trust not proof, TurnOrigin
as a union plus AgentContext, a non-blocking CaptureHandle, and a structured
degraded object. types/engine.conformance.ts fails the build if any drifts."
```

---

### Task 4 (PR-01a): `lib/platform.js` and its unit tests

Pure addition — nothing calls it yet. Task 5 routes the call sites.

**Files:**
- Create: `lib/platform.js`
- Create: `tests/platform.test.js`

**Interfaces:**
- Produces:
  - `isFilesystemPath(target: unknown) -> boolean`
  - `securePath(target: string, options?: { mode?: number, fd?: number|null, platform?: string, execFile?: Function, username?: string|null }) -> { applied: boolean, reason?: string, mechanism?: "chmod"|"acl" }`
  - `ipcAddress(stateRoot: string, options?: { platform?: string }) -> { kind: "abstract-socket"|"unix-socket"|"named-pipe", address: string }`
  - `isUnsafeLink(target: string, options?: { platform?: string, stat?: Stats|null }) -> boolean`
  - `canonicalIdentityPath(target: string, options?: { platform?: string }) -> string`
  These match `PlatformCapabilities`, `SecurePathResult` and `IpcAddress` in `types/engine.d.ts` (Task 3).
- Consumed by: Task 5 (`securePath` only). `ipcAddress` is wired in PR-11, `isUnsafeLink` in the f.15 sweep and `canonicalIdentityPath` in PR-06 — all outside M1a. They are defined and tested now so the contract is complete and the harness can import them.

**House style to match:** `lib/providers/scoped-embedding-ipc.js:207` already takes `platform = process.platform` as a defaulted parameter. Every function here does the same, so a test reaches the win32 branch either by passing `{ platform: "win32" }` or by stubbing `process.platform` — the default is evaluated at call time, so both work.

- [ ] **Step 1: Write the failing tests**

Create `tests/platform.test.js`:

```js
/**
 * tests/platform.test.js — lib/platform.js, including the win32 branches,
 * which are reached both by the explicit `platform` option and by stubbing
 * `process.platform`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { closeSync, mkdirSync, openSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  canonicalIdentityPath,
  ipcAddress,
  isFilesystemPath,
  isUnsafeLink,
  securePath,
} from "../lib/platform.js";
import { makeTempDir } from "./helpers/temp-dir.js";

function withStubbedPlatform(value, body) {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value, configurable: true });
  try {
    return body();
  } finally {
    Object.defineProperty(process, "platform", original);
  }
}

describe("lib/platform isFilesystemPath", () => {
  it("accepts an ordinary path and rejects pipe and abstract addresses", () => {
    assert.equal(isFilesystemPath("/tmp/x"), true);
    assert.equal(isFilesystemPath("\\\\.\\pipe\\plur1bus-embedding-abc"), false);
    assert.equal(isFilesystemPath("\0plur1bus-embedding-abc"), false);
    assert.equal(isFilesystemPath(""), false);
    assert.equal(isFilesystemPath(undefined), false);
  });
});

describe("lib/platform securePath", () => {
  it("chmods a regular file on POSIX", () => {
    const dir = makeTempDir("plur1bus-platform-");
    const file = join(dir, "state.json");
    writeFileSync(file, "{}", { mode: 0o644 });
    const result = securePath(file, { mode: 0o600, platform: "linux" });
    assert.deepEqual(result, { applied: true, mechanism: "chmod" });
    assert.equal(statSync(file).mode & 0o777, 0o600);
  });

  it("chmods through a file descriptor when one is given", () => {
    const dir = makeTempDir("plur1bus-platform-fd-");
    const file = join(dir, "report.json");
    const fd = openSync(file, "wx", 0o644);
    try {
      const result = securePath(file, { mode: 0o600, fd, platform: "linux" });
      assert.deepEqual(result, { applied: true, mechanism: "chmod" });
    } finally {
      closeSync(fd);
    }
    assert.equal(statSync(file).mode & 0o777, 0o600);
  });

  it("secures a live unix domain socket rather than refusing it", async () => {
    const dir = makeTempDir("plur1bus-platform-sock-");
    const socketPath = join(dir, "owner.sock");
    const server = createServer();
    await new Promise((done) => server.listen(socketPath, done));
    try {
      const result = securePath(socketPath, { mode: 0o600, platform: "linux" });
      assert.deepEqual(result, { applied: true, mechanism: "chmod" });
      assert.equal(statSync(socketPath).mode & 0o777, 0o600);
    } finally {
      await new Promise((done) => server.close(done));
    }
  });

  it("refuses a named pipe instead of throwing", () => {
    const result = securePath("\\\\.\\pipe\\plur1bus-embedding-abc", { platform: "win32" });
    assert.deepEqual(result, { applied: false, reason: "not-a-filesystem-path" });
  });

  it("runs an icacls ACL grant on win32", () => {
    const calls = [];
    const result = securePath("C:\\state\\owner.token", {
      platform: "win32",
      username: "tester",
      execFile: (...args) => { calls.push(args); },
    });
    assert.deepEqual(result, { applied: true, mechanism: "acl" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], "icacls");
    assert.deepEqual(calls[0][1], [
      "C:\\state\\owner.token",
      "/inheritance:r",
      "/grant:r",
      "tester:(F)",
    ]);
  });

  it("reaches the win32 branch through a stubbed process.platform", () => {
    const calls = [];
    const result = withStubbedPlatform("win32", () => securePath("C:\\state\\owner.token", {
      username: "tester",
      execFile: (...args) => { calls.push(args); },
    }));
    assert.deepEqual(result, { applied: true, mechanism: "acl" });
    assert.equal(calls.length, 1);
  });
});

describe("lib/platform ipcAddress", () => {
  it("returns an abstract socket on linux", () => {
    const address = ipcAddress("/var/lib/plur1bus", { platform: "linux" });
    assert.equal(address.kind, "abstract-socket");
    assert.match(address.address, /^\0plur1bus-embedding-[0-9a-f]{32}$/);
  });

  it("returns a named pipe on win32", () => {
    const address = ipcAddress("C:\\ProgramData\\plur1bus", { platform: "win32" });
    assert.equal(address.kind, "named-pipe");
    assert.match(address.address, /^\\\\\.\\pipe\\plur1bus-embedding-[0-9a-f]{32}$/);
  });

  it("returns a filesystem socket on darwin", () => {
    const address = ipcAddress("/Users/x/.plur1bus", { platform: "darwin" });
    assert.deepEqual(address, { kind: "unix-socket", address: "/Users/x/.plur1bus/owner.sock" });
  });

  it("is deterministic and distinct per state root", () => {
    const a = ipcAddress("/a", { platform: "linux" });
    const b = ipcAddress("/a", { platform: "linux" });
    const c = ipcAddress("/b", { platform: "linux" });
    assert.equal(a.address, b.address);
    assert.notEqual(a.address, c.address);
  });
});

describe("lib/platform isUnsafeLink", () => {
  it("is true for a symlink and false for a real file", () => {
    const dir = makeTempDir("plur1bus-platform-link-");
    const real = join(dir, "real.txt");
    const link = join(dir, "link.txt");
    writeFileSync(real, "x");
    symlinkSync(real, link);
    assert.equal(isUnsafeLink(link, { platform: "linux" }), true);
    assert.equal(isUnsafeLink(real, { platform: "linux" }), false);
  });

  it("is false for a missing path and for a non-filesystem address", () => {
    assert.equal(isUnsafeLink("/nonexistent/plur1bus/xyz", { platform: "linux" }), false);
    assert.equal(isUnsafeLink("\\\\.\\pipe\\x", { platform: "win32" }), false);
  });

  it("accepts a pre-read stat so callers need not lstat twice", () => {
    const dir = makeTempDir("plur1bus-platform-stat-");
    const real = join(dir, "real.txt");
    writeFileSync(real, "x");
    assert.equal(isUnsafeLink(real, { platform: "linux", stat: { isSymbolicLink: () => true } }), true);
  });

  it("on win32 treats a path whose native realpath differs as a reparse point", () => {
    const dir = makeTempDir("plur1bus-platform-junction-");
    const real = join(dir, "target");
    const link = join(dir, "junction");
    mkdirSync(real);
    symlinkSync(real, link, "dir");
    // The stat says "not a symlink" (as Windows reports a junction); the
    // realpath comparison is what catches it.
    assert.equal(
      isUnsafeLink(link, { platform: "win32", stat: { isSymbolicLink: () => false } }),
      true,
    );
  });
});

describe("lib/platform canonicalIdentityPath", () => {
  it("resolves a real directory on POSIX and preserves case", () => {
    const dir = makeTempDir("plur1bus-platform-Canon-");
    // realpathSync, not the raw path: on macOS os.tmpdir() is /var -> /private/var.
    assert.equal(canonicalIdentityPath(dir, { platform: "linux" }), realpathSync(dir));
    assert.match(canonicalIdentityPath(dir, { platform: "linux" }), /Canon-/);
  });

  it("folds case and separators on win32 so one workspace hashes once", () => {
    const a = canonicalIdentityPath("C:\\Users\\X\\Work", { platform: "win32" });
    const b = canonicalIdentityPath("c:/users/x/work", { platform: "win32" });
    assert.equal(a, b);
  });

  it("falls back to the absolute path when the target does not exist", () => {
    const value = canonicalIdentityPath("/nonexistent/plur1bus/ws", { platform: "linux" });
    assert.equal(value, "/nonexistent/plur1bus/ws");
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

```bash
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/platform.test.js 2>&1 | tail -5
```

Expected: the file fails to load with `ERR_MODULE_NOT_FOUND … '../lib/platform.js'`.

- [ ] **Step 3: Write the implementation**

Create `lib/platform.js`:

```js
/**
 * lib/platform.js — the four platform decisions, in one place.
 *
 * `securePath`            — host-contract §f.9: chmod is not a permission on
 *                           Windows, so a token or state file written 0o600
 *                           stays world-readable there.
 * `ipcAddress`            — the embedding owner's transport per platform.
 * `isUnsafeLink`          — host-contract §f.15: `isSymbolicLink()` is false
 *                           for a Windows junction or reparse point.
 * `canonicalIdentityPath` — ADR-002 §"Principal and turn-origin contract":
 *                           `C:\Users\X` and `c:\users\x` must hash alike.
 *
 * Every function takes a `platform` option that defaults to `process.platform`
 * at call time, mirroring `resolveScopedEmbeddingOwnerClaimAddress`
 * (lib/providers/scoped-embedding-ipc.js:207), so unit tests can reach the
 * win32 branches on Linux either by passing the option or by stubbing
 * `process.platform`.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, fchmodSync, lstatSync, realpathSync } from "node:fs";
import { userInfo } from "node:os";
import { resolve } from "node:path";

const NAMED_PIPE_PREFIX = "\\\\.\\pipe\\";

/**
 * A value `securePath` and `isUnsafeLink` can actually act on. Named pipes and
 * Linux abstract sockets have no filesystem entry.
 * @param {unknown} target Candidate path.
 * @returns {boolean} True when the value is a real filesystem path.
 */
export function isFilesystemPath(target) {
  if (typeof target !== "string" || target.length === 0) return false;
  if (target.startsWith(NAMED_PIPE_PREFIX)) return false;
  if (target.startsWith("\0")) return false;
  return true;
}

/**
 * Restrict a path to the current user.
 *
 * POSIX: `chmod` (on `fd` when one is supplied, which is race-free).
 * win32: a per-user SID ACL via `icacls`, because `chmod` only toggles the
 *        read-only bit there.
 *
 * Never throws for an address that has no filesystem entry; the caller gets
 * `{ applied: false, reason: "not-a-filesystem-path" }` so an embedding owner
 * on a named pipe does not fail to start.
 *
 * @param {string} target Filesystem path.
 * @param {{mode?: number, fd?: number|null, platform?: string,
 *          execFile?: Function, username?: string|null}} [options] Options.
 * @returns {{applied: boolean, reason?: string, mechanism?: "chmod"|"acl"}} Outcome.
 */
export function securePath(target, {
  mode = 0o600,
  fd = null,
  platform = process.platform,
  execFile = execFileSync,
  username = null,
} = {}) {
  if (!isFilesystemPath(target)) return { applied: false, reason: "not-a-filesystem-path" };
  if (platform !== "win32") {
    if (fd !== null && fd !== undefined) fchmodSync(fd, mode);
    else chmodSync(target, mode);
    return { applied: true, mechanism: "chmod" };
  }
  const who = username || userInfo().username;
  execFile("icacls", [target, "/inheritance:r", "/grant:r", `${who}:(F)`], { stdio: "ignore" });
  return { applied: true, mechanism: "acl" };
}

/**
 * The embedding-owner IPC address for a state root.
 *
 * linux  — abstract socket, no filesystem entry, released on process death.
 * win32  — named pipe `\\.\pipe\plur1bus-embedding-<sha256(stateRoot)[0:32]>`.
 * other  — filesystem socket under the state root (darwin, BSD).
 *
 * @param {string} stateRoot Canonical private state directory.
 * @param {{platform?: string}} [options] Options.
 * @returns {{kind: "abstract-socket"|"unix-socket"|"named-pipe", address: string}} Address.
 */
export function ipcAddress(stateRoot, { platform = process.platform } = {}) {
  const digest = createHash("sha256").update(String(stateRoot)).digest("hex").slice(0, 32);
  if (platform === "linux") {
    return Object.freeze({ kind: "abstract-socket", address: `\0plur1bus-embedding-${digest}` });
  }
  if (platform === "win32") {
    return Object.freeze({ kind: "named-pipe", address: `${NAMED_PIPE_PREFIX}plur1bus-embedding-${digest}` });
  }
  return Object.freeze({ kind: "unix-socket", address: resolve(stateRoot, "owner.sock") });
}

/**
 * True when a path must not be followed: a symlink anywhere, and additionally
 * a junction or other reparse point on Windows, where `isSymbolicLink()` is
 * false. A missing path is not unsafe.
 *
 * @param {string} target Path to inspect.
 * @param {{platform?: string, stat?: import("node:fs").Stats|null}} [options] Options.
 * @returns {boolean} True when the path is a link the caller must refuse.
 */
export function isUnsafeLink(target, { platform = process.platform, stat = null } = {}) {
  if (!isFilesystemPath(target)) return false;
  let entry = stat;
  if (!entry) {
    try {
      entry = lstatSync(target);
    } catch {
      return false;
    }
  }
  if (typeof entry.isSymbolicLink === "function" && entry.isSymbolicLink()) return true;
  if (platform !== "win32") return false;
  try {
    return realpathSync.native(target) !== resolve(target);
  } catch {
    return false;
  }
}

/**
 * The stable identity form of a path, used before hashing a workspace
 * principal. On Windows the filesystem is case-insensitive and accepts both
 * separators, so `C:/Users/X` and `c:\users\x` must produce one string.
 *
 * @param {string} target Path to canonicalise.
 * @param {{platform?: string}} [options] Options.
 * @returns {string} Canonical identity path.
 */
export function canonicalIdentityPath(target, { platform = process.platform } = {}) {
  const absolute = resolve(String(target));
  let resolved = absolute;
  try {
    resolved = realpathSync(absolute);
  } catch {
    resolved = absolute;
  }
  if (platform !== "win32") return resolved;
  return resolved.replace(/\//g, "\\").toLowerCase();
}
```

- [ ] **Step 4: Run the tests and watch them pass**

```bash
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/platform.test.js 2>&1 | tail -8
```

Expected: `tests 18`, `pass 18`, `fail 0`.

- [ ] **Step 5: Lint, suite, golden**

```bash
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm run lint
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/golden-prefix.test.js
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm test 2>&1 | tail -20
```

Expected: lint 0; golden `pass 7 / fail 0`; suite at the accepted baseline (now 5 094 tests, 5 089 pass, 2 fail).

- [ ] **Step 6: Commit**

```bash
cd "$PLUR1BUS"
git add lib/platform.js tests/platform.test.js
git commit -m "feat(platform): add securePath, ipcAddress, isUnsafeLink, canonicalIdentityPath

PR-01a. No call site yet. securePath returns a result object instead of
throwing so a named pipe or abstract socket cannot fail the embedding owner's
start-up; the win32 branches are covered both by an explicit platform option
and by a stubbed process.platform."
```

---

### Task 5 (PR-01b): route the eight chmod sites and the `HOME` bug through `lib/platform.js`

Behaviour-neutral on POSIX by construction: `securePath(p, { mode })` with `platform !== "win32"` is exactly `chmodSync(p, mode)`.

**Files** (every line verified at `89148f9`; re-derive with Grep before editing):
- Modify: `lib/providers/scoped-embedding-ipc.js:153` (`chmodSync(tokenPath, 0o600)`), `:279` (`chmodSync(directory, 0o700)`), `:435` (`chmodSync(paths.socketPath, 0o600)`), and the `chmodSync` entry in the `node:fs` import at `:3`
- Modify: `lib/shared-memory-migration.js:216` (`fchmodSync(fd, 0o600)`) and the `fchmodSync` import at `:5`
- Modify: `lib/workspace-policy.js:98` (`chmodSync(statePath, 0o600)`) and the import at `:4`
- Modify: `lib/model-preparation/state-store.js:130` (`chmodSync(path, 0o600)`) and the import at `:2`
- Modify: `lib/reembedding/lance-backend.js:126` (`chmodSync(path, 0o600)`) and the import at `:3`
- Modify: `lib/reembedding/state-store.js:179` (`chmodSync(statePath, 0o600)`) and the import at `:2`
- Modify: `lib/llm-result-cache.js:225` — the injectable default parameter `chmodFile = chmodSync`; and the import at `:7`
- Modify: `lib/providers/openclaw-memory-embedding-adapters.js:56` — `process.env.HOME` → `homedir()` (host-contract §f.2)
- Create: `tests/platform-callsites.test.js`

**Interfaces:**
- Consumes: `securePath` from Task 4.
- Produces: no new exported names. `lib/llm-result-cache.js` keeps its injectable seam, but its default becomes a `securePath` wrapper rather than `chmodSync` directly.

**Exact edits.**

1. **The six plain `chmodSync(path, mode)` sites** — `scoped-embedding-ipc.js:153`, `:279`, `:435`, `workspace-policy.js:98`, `model-preparation/state-store.js:130`, `reembedding/lance-backend.js:126`, `reembedding/state-store.js:179`. In each file add the import (relative depth differs per file: `./platform.js` from `lib/`, `../platform.js` from `lib/providers/`, `lib/reembedding/`, `lib/model-preparation/`):

```js
import { securePath } from "../platform.js";
```

and replace the call, e.g. at `lib/workspace-policy.js:98`:

```js
    securePath(statePath, { mode: 0o600 });
```

at `lib/providers/scoped-embedding-ipc.js:279`:

```js
  securePath(directory, { mode: 0o700 });
```

Then delete `chmodSync` from that file's `node:fs` import list if nothing else in the file uses it (check with `grep -n chmodSync <file>` after the edit; leave the import if another use remains).

2. **The `fchmodSync` site**, `lib/shared-memory-migration.js:216`. `securePath` takes the descriptor for the race-free POSIX path and the path for the Windows ACL:

```js
        securePath(tempPath, { mode: 0o600, fd });
```

Then remove `fchmodSync` from the `node:fs` import at `:5` and add `import { securePath } from "./platform.js";`.

3. **The injectable seam**, `lib/llm-result-cache.js:225`. The parameter name and call shape stay so every existing caller and test keeps working; only the default changes:

```js
  chmodFile = (path, mode) => { securePath(path, { mode }); },
```

Add `import { securePath } from "./platform.js";` and drop `chmodSync` from the `node:fs` import at `:7` if unused afterwards.

4. **The `HOME` bug**, `lib/providers/openclaw-memory-embedding-adapters.js:56`. Before:

```js
function resolveOpenClawHome() {
  return process.env.OPENCLAW_HOME || join(process.env.HOME || ".", ".openclaw");
}
```

After (add `homedir` to the existing `node:os` import, or add `import { homedir } from "node:os";` if the file has none):

```js
function resolveOpenClawHome() {
  return process.env.OPENCLAW_HOME || join(homedir(), ".openclaw");
}
```

Leave `lib/providers/env.js:10` alone: it is a *declaration* of the environment contract read by the config tooling, not a path used to write a file, and changing it is PR-11's business.

- [ ] **Step 1: Write the failing call-site test**

Create `tests/platform-callsites.test.js`:

```js
/**
 * tests/platform-callsites.test.js — PR-01b.
 *
 * Two guards that survive later refactors: no module writes a
 * permission with a raw fs chmod any more, and the embedding cache
 * directory no longer falls back to $HOME (host-contract f.2/f.9).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const ROUTED = [
  "lib/providers/scoped-embedding-ipc.js",
  "lib/shared-memory-migration.js",
  "lib/workspace-policy.js",
  "lib/model-preparation/state-store.js",
  "lib/reembedding/lance-backend.js",
  "lib/reembedding/state-store.js",
  "lib/llm-result-cache.js",
];

describe("PR-01b platform call sites", () => {
  for (const relative of ROUTED) {
    it(`${relative} secures permissions through lib/platform.js`, () => {
      const source = readFileSync(join(root, relative), "utf8");
      assert.match(source, /from "\.{1,2}\/platform\.js"/, `${relative} must import lib/platform.js`);
      assert.doesNotMatch(source, /\bchmodSync\s*\(/, `${relative} must not call chmodSync directly`);
      assert.doesNotMatch(source, /\bfchmodSync\s*\(/, `${relative} must not call fchmodSync directly`);
    });
  }

  it("the embedding adapter resolves the home directory with os.homedir()", () => {
    const source = readFileSync(join(root, "lib/providers/openclaw-memory-embedding-adapters.js"), "utf8");
    assert.doesNotMatch(source, /process\.env\.HOME/, "HOME is unset on Windows; use homedir()");
    assert.match(source, /homedir\(\)/);
  });

  it("no module outside lib/platform.js calls chmodSync or fchmodSync", async () => {
    const { execFileSync } = await import("node:child_process");
    const out = execFileSync("grep", [
      "-rn", "--include=*.js", "-E", "\\b(f?chmodSync)\\s*\\(", "lib", "index.js",
    ], { cwd: root, encoding: "utf8" }).trim().split("\n").filter(Boolean)
      .filter((line) => !line.startsWith("lib/platform.js:"));
    assert.deepEqual(out, [], `unrouted chmod call sites:\n${out.join("\n")}`);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/platform-callsites.test.js 2>&1 | tail -15
```

Expected: 8 failures — the seven routed files plus the `HOME` assertion.

- [ ] **Step 3: Apply the eight edits described above**

Work one file at a time. After each file:

```bash
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --check <the file you just edited>
```

- [ ] **Step 4: Run the call-site test and watch it pass**

```bash
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/platform-callsites.test.js 2>&1 | tail -8
```

Expected: `tests 9`, `pass 9`, `fail 0`.

- [ ] **Step 5: Run the tests that own those files**

```bash
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 \
  tests/platform.test.js \
  tests/scoped-embedding-ipc.test.js \
  tests/workspace-policy*.test.js \
  tests/llm-result-cache*.test.js \
  tests/reembedding*.test.js 2>&1 | tail -10
```

Expected: all pass. (If a glob matches no file, drop it — the suite run in Step 6 is the real gate.)

- [ ] **Step 6: Lint, suite, golden**

```bash
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm run lint
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/golden-prefix.test.js
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm test 2>&1 | tail -20
```

Expected: lint 0; golden `pass 7 / fail 0`; suite at the accepted baseline.

- [ ] **Step 7: Commit**

```bash
cd "$PLUR1BUS"
git add lib tests/platform-callsites.test.js
git commit -m "fix(platform): route every chmod site and the HOME fallback through lib/platform.js

PR-01b. Closes host-contract f.9 (chmod is not a permission on Windows) and
f.2 (process.env.HOME is unset on Windows, so the model cache landed in the
CWD). No behaviour change on POSIX: securePath with platform !== win32 is
chmodSync. lib/llm-result-cache.js keeps its injectable chmodFile seam."
```

---

### Task 6 (PR-02a): `lib/host-services.js` — the `HostServices` seam

**A correction to the spec you must know before you start.** `engine-extraction.md` §c row PR-02 says "replace the 341 `api.logger` and the ~20 `runtimeIfUsable(api)` reads **in `lib/**`**". That is wrong at `89148f9`, and following it literally produces a no-op PR. Measured:

| Where | `api.logger` | `runtimeIfUsable(api)` |
|---|---|---|
| `index.js` | **323** | **29** |
| `lib/**` — all of it | **17** | 3 |

and all 17 of the `lib/**` occurrences sit in six files that are *already* classified as adapter by `engine-extraction.md` §a.3 and are on the lint allowlist: `lib/runtime-shutdown.js` (11), `lib/setup/feature-cron-plugin-runtime.js` (2), `lib/setup/{control-ui,workspace-policy,reembedding}-plugin-runtime.js` (1 each), `lib/providers/openclaw-memory-embedding-adapters.js` (1). **`lib/**` is already host-neutral.** The real work is inside `index.js`, and doing it in PR-02 is what makes PR-03's moves possible: after Tasks 7 and 8 the code PR-03 lifts out of `register()` no longer mentions `api` at all.

Behaviour-neutral: pure addition; nothing constructs a host yet.

**Files:**
- Create: `lib/host-services.js`
- Create: `tests/host-services.test.js`

**Interfaces:**
- Consumes: `securePath`, `ipcAddress`, `isUnsafeLink`, `canonicalIdentityPath` from `lib/platform.js` (Task 4); `runtimeIfUsable` from `lib/runtime-shutdown.js`.
- Produces:
  - `normalizeLogger(logger) -> { info, warn, error, debug }` (all total)
  - `resolveStateDir(env?) -> string`
  - `platformCapabilities` (frozen `{ securePath, ipcAddress, isUnsafeLink, canonicalIdentityPath }`)
  - `createHostServices(api, options?) -> HostServices` with members `logger`, `stateDir`, `config()`, `workspaceDir(agentId)`, `clock`, `platform`, `api`, and the **accessors** `runtime` and `llm`
  - `createStubHost(overrides?) -> HostServices`
  Tasks 7, 8, 13–17 consume `host`; the harness consumes `createStubHost` in its own contract tests.

**Two design points that are behaviour, not style:**
1. **`runtime` is a getter, never a cached value.** `runtimeIfUsable` (`lib/runtime-shutdown.js:35-49`) exists because outside `"full"` registration OpenClaw substitutes a proxy that *throws on every property access*, and because a usable runtime can appear after registration. Today each of the 29 sites re-probes. Caching it in the host would change behaviour on both counts.
2. **`logger` is normalised to four total methods.** Review Focus item 1. `index.js` mixes `api.logger.warn(...)` with `api.logger?.info?.(...)`; once Task 7 drops the optional chains, a host with a partial logger must keep no-opping.

- [ ] **Step 1: Write the failing tests**

Create `tests/host-services.test.js`:

```js
/**
 * tests/host-services.test.js — PR-02.
 *
 * The important cases are the partial-logger ones: index.js mixes
 * `api.logger.warn(...)` with `api.logger?.info?.(...)`, and many host stubs
 * pass a partial logger. Once the optional chains become `host.logger.info(...)`
 * a partial logger must still no-op rather than throw.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createHostServices, createStubHost, normalizeLogger, resolveStateDir } from "../lib/host-services.js";

describe("normalizeLogger", () => {
  it("fills every missing method with a no-op", () => {
    const logger = normalizeLogger({});
    for (const method of ["info", "warn", "error", "debug"]) {
      assert.equal(typeof logger[method], "function");
      assert.equal(logger[method]("x"), undefined);
    }
  });

  it("keeps the methods the host does supply, bound to it", () => {
    const seen = [];
    const source = { prefix: "p", info(message) { seen.push(`${this.prefix}:${message}`); } };
    const logger = normalizeLogger(source);
    logger.info("hello");
    logger.warn("ignored");
    assert.deepEqual(seen, ["p:hello"]);
  });

  it("tolerates null and undefined", () => {
    assert.equal(normalizeLogger(null).error("x"), undefined);
    assert.equal(normalizeLogger(undefined).debug("x"), undefined);
  });
});

describe("createHostServices", () => {
  it("never throws on a partial or absent logger", () => {
    assert.equal(createHostServices({ logger: {} }).logger.info("x"), undefined);
    assert.equal(createHostServices({}).logger.warn("x"), undefined);
    assert.equal(createHostServices().logger.error("x"), undefined);
  });

  it("re-probes the runtime on every read instead of caching it", () => {
    let runtime = null;
    const api = { get runtime() { return runtime; } };
    const host = createHostServices(api);
    assert.equal(host.runtime, null);
    runtime = { config: { current: () => ({ a: 1 }) } };
    assert.equal(host.runtime, runtime);
  });

  it("returns null for a runtime proxy that throws on property access", () => {
    const api = {
      runtime: new Proxy({}, { get() { throw new Error("restricted registration"); } }),
    };
    const host = createHostServices(api);
    assert.equal(host.runtime, null);
  });

  it("exposes llm only when the runtime has a complete() function", () => {
    assert.equal(createHostServices({ runtime: {} }).llm, undefined);
    assert.equal(createHostServices({ runtime: { llm: {} } }).llm, undefined);
    const llm = { complete: async () => ({ text: "" }) };
    assert.equal(createHostServices({ runtime: { llm } }).llm, llm);
  });

  it("reads the host config through config()", () => {
    assert.deepEqual(createHostServices({ config: { agents: {} } }).config(), { agents: {} });
    assert.deepEqual(createHostServices({}).config(), {});
  });

  it("resolves a workspace dir through the runtime and undefined without one", () => {
    assert.equal(createHostServices({}).workspaceDir("a"), undefined);
    const api = {
      config: { marker: true },
      runtime: { agent: { resolveAgentWorkspaceDir: (config, agentId) => `/ws/${agentId}/${config.marker}` } },
    };
    assert.equal(createHostServices(api).workspaceDir("agent-1"), "/ws/agent-1/true");
  });

  it("carries the four platform capabilities", () => {
    const host = createHostServices({});
    for (const name of ["securePath", "ipcAddress", "isUnsafeLink", "canonicalIdentityPath"]) {
      assert.equal(typeof host.platform[name], "function", name);
    }
  });

  it("uses OPENCLAW_HOME for the state dir and never process.env.HOME", () => {
    assert.equal(resolveStateDir({ OPENCLAW_HOME: "/srv/state" }), "/srv/state");
    const withoutHome = resolveStateDir({ HOME: "/should/not/be/used" });
    assert.doesNotMatch(withoutHome, /should\/not\/be\/used/);
    assert.match(withoutHome, /\.openclaw$/);
  });
});

describe("createStubHost", () => {
  it("is inert and complete by default", () => {
    const host = createStubHost();
    assert.equal(host.logger.info("x"), undefined);
    assert.equal(host.runtime, null);
    assert.equal(host.llm, undefined);
    assert.deepEqual(host.config(), {});
    assert.equal(host.workspaceDir("a"), undefined);
    assert.equal(typeof host.clock(), "number");
    assert.equal(typeof host.platform.securePath, "function");
  });

  it("applies overrides, including a partial logger", () => {
    const lines = [];
    const host = createStubHost({
      logger: { warn: (m) => lines.push(m) },
      stateDir: "/tmp/stub-state",
      config: () => ({ k: 1 }),
      runtime: { config: { current: () => ({}) } },
    });
    host.logger.warn("w");
    host.logger.debug("ignored");
    assert.deepEqual(lines, ["w"]);
    assert.equal(host.stateDir, "/tmp/stub-state");
    assert.deepEqual(host.config(), { k: 1 });
    assert.equal(typeof host.runtime.config.current, "function");
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

```bash
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/host-services.test.js 2>&1 | tail -5
```

Expected: `ERR_MODULE_NOT_FOUND … '../lib/host-services.js'`.

- [ ] **Step 3: Write the implementation**

Create `lib/host-services.js`:

```js
/**
 * lib/host-services.js — the `HostServices` seam (PR-02).
 *
 * One object carrying everything the engine needs from a host, so engine code
 * stops reaching for the OpenClaw `api` capability surface. `createHostServices`
 * builds it from an OpenClaw `api`; `createStubHost` builds an inert one for
 * tests and for the harness's own contract tests.
 *
 * The shape is `HostServices` in types/engine.d.ts (contract 1.0.0).
 *
 * Two properties are deliberately accessors, not values:
 *   - `runtime` — `api.runtime` may be a proxy that throws on every property
 *     access outside "full" registration, and the real runtime can appear
 *     after registration. `runtimeIfUsable` must therefore run on *every*
 *     read (lib/runtime-shutdown.js:35-49). Caching it here would change
 *     behaviour.
 *   - `llm` — same reason, plus it must stay `undefined` when the host has none.
 *
 * `logger` is normalised into four total methods. `index.js` mixes hard calls
 * (`api.logger.warn(...)`) with guarded ones (`api.logger?.info?.(...)`), and
 * many test stubs pass a partial logger; a partial logger must keep no-opping
 * rather than throwing once the guards are gone.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import { canonicalIdentityPath, ipcAddress, isUnsafeLink, securePath } from "./platform.js";
import { runtimeIfUsable } from "./runtime-shutdown.js";

const LOG_METHODS = Object.freeze(["info", "warn", "error", "debug"]);

function noop() {}

/**
 * Turn any logger-ish value into four total methods.
 * @param {object|null|undefined} logger Host logger, possibly partial.
 * @returns {{info: Function, warn: Function, error: Function, debug: Function}} Total logger.
 */
export function normalizeLogger(logger) {
  const out = {};
  for (const method of LOG_METHODS) {
    const fn = logger && typeof logger[method] === "function" ? logger[method].bind(logger) : noop;
    out[method] = fn;
  }
  return Object.freeze(out);
}

/**
 * The host's private state directory. Mirrors today's OPENCLAW_HOME reads
 * (index.js:12425) but never falls back to `process.env.HOME`, which is unset
 * on Windows (host-contract f.2).
 * @param {object} [env] Environment to read.
 * @returns {string} State directory.
 */
export function resolveStateDir(env = process.env) {
  return env.OPENCLAW_HOME || join(homedir(), ".openclaw");
}

/** The four platform decisions, as the `PlatformCapabilities` contract shape. */
export const platformCapabilities = Object.freeze({
  securePath,
  ipcAddress,
  isUnsafeLink,
  canonicalIdentityPath,
});

/**
 * Build `HostServices` from an OpenClaw plugin API.
 * @param {object} api OpenClaw plugin API capability surface.
 * @param {{clock?: () => number, stateDir?: string|null, platform?: object}} [options] Overrides.
 * @returns {object} HostServices.
 */
export function createHostServices(api = {}, {
  clock = () => Date.now(),
  stateDir = null,
  platform = platformCapabilities,
} = {}) {
  const host = {
    logger: normalizeLogger(api?.logger),
    stateDir: stateDir ?? resolveStateDir(),
    config() { return api?.config ?? {}; },
    workspaceDir(agentId) {
      const resolver = runtimeIfUsable(api)?.agent?.resolveAgentWorkspaceDir;
      if (typeof resolver !== "function") return undefined;
      return resolver(api?.config, agentId);
    },
    clock,
    platform,
    /** Escape hatch for the adapter shell only; removed at PR-14. */
    api,
  };
  Object.defineProperty(host, "runtime", {
    get() { return runtimeIfUsable(api) ?? null; },
    enumerable: true,
    configurable: true,
  });
  Object.defineProperty(host, "llm", {
    get() {
      const llm = runtimeIfUsable(api)?.llm;
      return llm && typeof llm.complete === "function" ? llm : undefined;
    },
    enumerable: true,
    configurable: true,
  });
  return host;
}

/**
 * An inert `HostServices` for tests and harness contract tests. Everything is
 * a no-op or empty; `overrides` is shallow-merged last so a test can supply
 * exactly the one member it cares about.
 * @param {object} [overrides] Members to replace.
 * @returns {object} HostServices.
 */
export function createStubHost(overrides = {}) {
  const host = {
    logger: normalizeLogger(overrides.logger),
    stateDir: overrides.stateDir ?? join(homedir(), ".plur1bus-stub"),
    config: overrides.config ?? (() => ({})),
    workspaceDir: overrides.workspaceDir ?? (() => undefined),
    clock: overrides.clock ?? (() => Date.now()),
    platform: overrides.platform ?? platformCapabilities,
    runtime: overrides.runtime ?? null,
    llm: overrides.llm,
    secrets: overrides.secrets,
    events: overrides.events,
    api: overrides.api ?? null,
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (key === "logger") continue;
    host[key] = value;
  }
  return host;
}
```

- [ ] **Step 4: Run them and watch them pass**

```bash
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/host-services.test.js 2>&1 | tail -8
```

Expected: `tests 13`, `pass 13`, `fail 0`.

- [ ] **Step 5: Lint, suite, golden**

```bash
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm run lint
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/golden-prefix.test.js
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm test 2>&1 | tail -20
```

Expected: lint 0; golden `pass 7 / fail 0`; suite at the accepted baseline.

- [ ] **Step 6: Commit**

```bash
cd "$PLUR1BUS"
git add lib/host-services.js tests/host-services.test.js
git commit -m "feat(host): add the HostServices seam and a stub host

PR-02a. runtime and llm are accessors, because runtimeIfUsable must re-probe
on every read (a non-full registration hands us a proxy that throws on any
property access). logger is normalised to four total methods so a partial host
logger keeps no-opping once the optional chains go."
```

---

### Task 7 (PR-02b): `api.logger` → `host.logger` inside `index.js`

323 sites. Mechanical, but *not* blind `sed`: three shapes appear and two of them must collapse.

**Files:**
- Modify: `index.js` — construct `host` next to `pluginLogger = api.logger` (`index.js:4445`), then rewrite 323 call sites
- Create: `tests/index-host-logger.test.js`

**Interfaces:**
- Consumes: `createHostServices` from Task 6.
- Produces: a `register`-scope binding `const host = createHostServices(api);` declared at `index.js:4445`. Tasks 11–17 pass `host` into every moved module through its context object.

**The three shapes and their replacements** (counts from `grep -c` at `89148f9`; re-count before you start):

| Shape | Replacement | Why |
|---|---|---|
| `api.logger.<m>(` | `host.logger.<m>(` | direct |
| `api.logger?.<m>?.(` | `host.logger.<m>(` | the optional chain existed only because `api.logger` could be partial; `normalizeLogger` now guarantees all four methods |
| `api.logger?.<m>(` | `host.logger.<m>(` | same |
| bare `api.logger` passed as a value (e.g. `new MultiNamespacePool(namespaceLayout, vectorDim, AgentDbPool, api.logger)` at `index.js:5594`, `logger: api.logger` in option objects) | `host.logger` | the normalised logger is a superset: every method the old one had, plus no-ops |

`pluginLogger = api.logger;` at `index.js:4445` becomes `pluginLogger = host.logger;` — `pluginLogger` is module-level state used by the `dbg`/speaker helpers at `:461`, `:483`, `:489`, which already optional-chain and keep working.

- [ ] **Step 1: Record the starting counts**

```bash
cd "$PLUR1BUS" && grep -c "api\.logger" index.js
cd "$PLUR1BUS" && grep -o "api\.logger?\.[a-z]*?\?\.(\|api\.logger?\.[a-z]*(\|api\.logger\.[a-z]*(" index.js | sort | uniq -c
```

Expected: `324` total occurrences (323 call/value sites plus the assignment), and a breakdown across `info`/`warn`/`error`/`debug`.

- [ ] **Step 2: Write the guard test**

Create `tests/index-host-logger.test.js`:

```js
/**
 * tests/index-host-logger.test.js — PR-02b.
 *
 * index.js must reach the host logger through HostServices, and a host with a
 * partial logger must not make registration throw. The second test is the one
 * that matters: before normalizeLogger, `api.logger?.info?.(...)` no-opped for
 * such a host and `host.logger.info(...)` would have thrown.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import plugin from "../index.js";
import { makeTempDir } from "./helpers/temp-dir.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("PR-02b host logger", () => {
  it("index.js no longer reads api.logger", () => {
    const source = readFileSync(join(root, "index.js"), "utf8");
    const hits = source.split("\n")
      .map((line, i) => [i + 1, line])
      .filter(([, line]) => /(?<![.\w$])api\s*\.\s*logger/.test(line));
    assert.deepEqual(hits.map(([i, line]) => `${i}: ${line.trim()}`), []);
  });

  it("index.js constructs HostServices", () => {
    const source = readFileSync(join(root, "index.js"), "utf8");
    assert.match(source, /createHostServices\s*\(\s*api\s*\)/);
  });

  it("registers against a host whose logger has only one method", () => {
    const warned = [];
    const api = {
      pluginConfig: { baseDbPath: makeTempDir("plur1bus-partial-logger-"), autoCapture: false, autoRecall: false },
      config: {},
      logger: { warn: (message) => warned.push(message) },
      resolvePath: (value) => value,
      registerCommand() {},
      registerTool() {},
      registerService() {},
      on() { return { dispose() {} }; },
    };
    assert.doesNotThrow(() => plugin.register(api, {}));
  });
});
```

- [ ] **Step 3: Run it and watch the first two fail**

```bash
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/index-host-logger.test.js 2>&1 | tail -15
```

Expected: `fail 2` (the two source assertions); the third test already passes today.

- [ ] **Step 4: Add the import and the host construction**

Add to the import block in `index.js` (next to the other `./lib/` imports, e.g. after the `runtime-shutdown.js` import at `:159`):

```js
import { createHostServices } from "./lib/host-services.js";
```

At `index.js:4445`, replace:

```js
    pluginLogger = api.logger;
```

with:

```js
    const host = createHostServices(api);
    pluginLogger = host.logger;
```

- [ ] **Step 5: Rewrite the 323 call sites, longest pattern first**

Order matters — rewrite the optional forms before the plain one, or the plain rule will half-rewrite them.

```bash
cd "$PLUR1BUS"
perl -pi -e 's/\bapi\.logger\?\.(info|warn|error|debug)\?\.\(/host.logger.$1(/g' index.js
perl -pi -e 's/\bapi\.logger\?\.(info|warn|error|debug)\(/host.logger.$1(/g' index.js
perl -pi -e 's/\bapi\.logger\.(info|warn|error|debug)\(/host.logger.$1(/g' index.js
perl -pi -e 's/(?<![.\w$])api\.logger\b/host.logger/g' index.js
grep -n "api\.logger" index.js          # must print nothing
grep -c "host\.logger" index.js         # must print 324
```

Expected: the `grep -n` prints nothing; the count is `324`.

- [ ] **Step 6: Syntax check, then the guard test**

```bash
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --check index.js
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/index-host-logger.test.js 2>&1 | tail -8
```

Expected: `--check` silent; `tests 3`, `pass 3`, `fail 0`.

- [ ] **Step 7: Lint, suite, golden**

```bash
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm run lint
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/golden-prefix.test.js
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm test 2>&1 | tail -20
```

Expected: lint 0; golden `pass 7 / fail 0`; suite at the accepted baseline. **If a third test fails here it is almost certainly a stub host whose logger lacked a method that a `host.logger.x(...)` site now calls — that is exactly the case `normalizeLogger` covers, so the failure means the host was built somewhere other than `createHostServices`. Find that construction site rather than restoring an optional chain.**

- [ ] **Step 8: Commit**

```bash
cd "$PLUR1BUS"
git add index.js tests/index-host-logger.test.js
git commit -m "refactor(host): route all 323 index.js logger sites through HostServices

PR-02b. The optional chains collapse because normalizeLogger guarantees four
total methods; a partial host logger still no-ops, which a new test pins."
```

---

### Task 8 (PR-02c): `runtimeIfUsable(api)` → `host.runtime` inside `index.js`

29 sites. Three of them pass the runtime *on* as a value and need `?? undefined` to stay byte-equivalent.

**Files:**
- Modify: `index.js`
- Modify: `tests/index-host-logger.test.js` — add one assertion

**Interfaces:**
- Consumes: `host` from Task 7.
- Produces: nothing new. `runtimeIfUsable` stays exported from `lib/runtime-shutdown.js` (other modules and tests import it) and stays imported by `lib/host-services.js`; only `index.js` stops calling it.

**The two shapes:**

1. **Probes (26 sites)** — `runtimeIfUsable(api)?.…` or `runtimeIfUsable(api).…`. Replace the call with `host.runtime`, keeping the rest of the expression exactly:

```js
// before, index.js:3311
    const cfg = commandConfig || runtimeIfUsable(api)?.config?.current?.();
// after
    const cfg = commandConfig || host.runtime?.config?.current?.();
```

```js
// before, index.js:12322
              getSessionEntry: ({ agentId, sessionKey, readConsistency }) => runtimeIfUsable(api).agent.session.getSessionEntry({ agentId, sessionKey, readConsistency }),
// after
              getSessionEntry: ({ agentId, sessionKey, readConsistency }) => host.runtime.agent.session.getSessionEntry({ agentId, sessionKey, readConsistency }),
```

A non-optional `.agent` read (`:7204`, `:9288`, `:9314`, `:9331`, `:12322`) throws today when the runtime is absent and must keep throwing — `host.runtime` returning `null` gives the same `TypeError`.

2. **Pass-throughs (3 sites)** — `index.js:5326`, `:7099`, `:7134`, each `runtime: runtimeIfUsable(api),`. `runtimeIfUsable` yields `undefined` when unusable; `host.runtime` yields `null`. Downstream code may distinguish them, so preserve the value exactly:

```js
        runtime: host.runtime ?? undefined,
```

- [ ] **Step 1: List every site so nothing is missed**

```bash
cd "$PLUR1BUS" && grep -n "runtimeIfUsable(api)" index.js
cd "$PLUR1BUS" && grep -c "runtimeIfUsable(api)" index.js
```

Expected: 29 occurrences on 28 lines (line `4240` carries two).

- [ ] **Step 2: Add the guard assertion**

Append to the `describe("PR-02b host logger", …)` block in `tests/index-host-logger.test.js`:

```js
  it("index.js reaches the host runtime through HostServices", () => {
    const source = readFileSync(join(root, "index.js"), "utf8");
    assert.doesNotMatch(source, /runtimeIfUsable\s*\(\s*api\s*\)/, "use host.runtime");
    assert.match(source, /host\.runtime/);
  });
```

- [ ] **Step 3: Run it and watch it fail**

```bash
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/index-host-logger.test.js 2>&1 | tail -10
```

Expected: `fail 1` on the new assertion.

- [ ] **Step 4: Rewrite the three pass-throughs by hand first**

At `index.js:5326`, `:7099` and `:7134`, change `runtime: runtimeIfUsable(api),` to `runtime: host.runtime ?? undefined,`. Confirm exactly three:

```bash
cd "$PLUR1BUS" && grep -n "runtime: host.runtime ?? undefined," index.js
```

- [ ] **Step 5: Rewrite the remaining 26 probes**

```bash
cd "$PLUR1BUS"
perl -pi -e 's/\bruntimeIfUsable\(api\)/host.runtime/g' index.js
grep -n "runtimeIfUsable(api)" index.js   # must print nothing
```

Then drop `runtimeIfUsable` from the `./lib/runtime-shutdown.js` import list at `index.js:159` **only if** nothing else in `index.js` uses it:

```bash
cd "$PLUR1BUS" && grep -n "runtimeIfUsable" index.js
```

If the only hit is the import, remove the name from that import list.

- [ ] **Step 6: Syntax check and guard test**

```bash
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --check index.js
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/index-host-logger.test.js 2>&1 | tail -8
```

Expected: `--check` silent; `tests 4`, `pass 4`, `fail 0`.

- [ ] **Step 7: Run the runtime-sensitive tests explicitly**

These are the ones that exercise restricted registration and the throwing proxy:

```bash
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 \
  tests/openclaw-restricted-registration.test.js \
  tests/b12p-runtime-reachability.test.js \
  tests/runtime-config-contract.test.js \
  tests/openclaw-default-llm-runtime.test.js \
  tests/openclaw-default-llm-callers.test.js 2>&1 | tail -10
```

Expected: all pass.

- [ ] **Step 8: Lint, suite, golden**

```bash
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm run lint
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/golden-prefix.test.js
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm test 2>&1 | tail -20
```

Expected: lint 0; golden `pass 7 / fail 0`; suite at the accepted baseline.

- [ ] **Step 9: Commit**

```bash
cd "$PLUR1BUS"
git add index.js tests/index-host-logger.test.js
git commit -m "refactor(host): read the host runtime through HostServices in index.js

PR-02c. host.runtime is an accessor, so the proxy probe still runs on every
read. The three sites that pass the runtime on keep '?? undefined' so a host
without one still receives undefined, not null."
```

---

### Task 9 (PR-02d): the `api.` boundary lint

**Files:**
- Create: `scripts/lint-no-api-outside-adapter.mjs`
- Modify: `package.json` — chain it into `scripts.lint`
- Create: `tests/lint-no-api-outside-adapter.test.js`

**Interfaces:**
- Produces: `npm run lint` fails when any file outside the allowlist references `api.`. The allowlist is the contract PR-03 is written against: `index.js`, `adapter/**`, `lib/setup/*-plugin-runtime.js`, `lib/runtime-shutdown.js`, `lib/host-services.js`, `lib/providers/openclaw-memory-embedding-adapters.js`, `lib/providers/scoped-embedding-ipc.js`.

**Why `lib/providers/scoped-embedding-ipc.js` is allowlisted:** it carries the `registerScopedEmbeddingIpcServiceAfterLifecycle({ api, … })` seam, which is an OpenClaw service registration and therefore adapter by `engine-extraction.md` §a.3.

- [ ] **Step 1: Write the script**

Create `scripts/lint-no-api-outside-adapter.mjs`:

```js
/**
 * scripts/lint-no-api-outside-adapter.mjs
 *
 * The OpenClaw plugin API surface may only be touched by the adapter. Engine
 * code reaches the host through `HostServices` (lib/host-services.js) instead.
 *
 * Allowed to reference `api.`:
 *   - index.js                                       (the plugin shell)
 *   - adapter/**                                     (the OpenClaw adapter)
 *   - lib/setup/*-plugin-runtime.js                  (gateway/CLI runtimes)
 *   - lib/runtime-shutdown.js                        (lifecycle + runtimeIfUsable)
 *   - lib/providers/openclaw-memory-embedding-adapters.js
 *   - lib/providers/scoped-embedding-ipc.js          (registerService seam)
 *   - lib/host-services.js                           (the seam itself)
 *
 * Everything else under lib/ and all of engine/ must be clean.
 *
 * Exits 1 and prints file:line for every violation.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const SCANNED_ROOTS = ["lib", "engine"];

const ALLOWED_EXACT = new Set([
  "index.js",
  "lib/runtime-shutdown.js",
  "lib/host-services.js",
  "lib/providers/openclaw-memory-embedding-adapters.js",
  "lib/providers/scoped-embedding-ipc.js",
]);

const ALLOWED_PATTERNS = [
  /^adapter\//,
  /^lib\/setup\/[^/]+-plugin-runtime\.js$/,
];

/** `api.x` but not `foo.api.x`, not `myapi.x`, and not `https://api.host/…`. */
const API_REFERENCE = /(?<![.\w$/-])api\s*\./;

/**
 * Remove block comments and everything after a `//`. Crude on purpose: it also
 * truncates a line at a URL's `//`, which is exactly what we want, since a
 * hostname is never a reference to the plugin API.
 * @param {string} line Source line.
 * @returns {string} Line with comments removed.
 */
function stripComments(line) {
  return line.replace(/\/\*.*?\*\//g, " ").replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "");
}

function isAllowed(relativePath) {
  if (ALLOWED_EXACT.has(relativePath)) return true;
  return ALLOWED_PATTERNS.some((pattern) => pattern.test(relativePath));
}

function* walk(directory) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      yield* walk(full);
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      yield full;
    }
  }
}

const violations = [];
for (const scanRoot of SCANNED_ROOTS) {
  const base = join(root, scanRoot);
  try {
    if (!statSync(base).isDirectory()) continue;
  } catch {
    continue;
  }
  for (const file of walk(base)) {
    const relativePath = relative(root, file).split(sep).join("/");
    if (isAllowed(relativePath)) continue;
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, index) => {
      if (API_REFERENCE.test(stripComments(line))) violations.push(`${relativePath}:${index + 1}: ${line.trim()}`);
    });
  }
}

if (violations.length > 0) {
  console.error("The OpenClaw `api` surface is only reachable from the adapter.");
  console.error("Use the injected HostServices (lib/host-services.js) instead.\n");
  for (const violation of violations) console.error(`  ${violation}`);
  console.error(`\n${violations.length} violation(s)`);
  process.exit(1);
}
console.log("lint-no-api-outside-adapter: clean");
```

- [ ] **Step 2: Run it against the current tree**

```bash
cd "$PLUR1BUS" && /home/claude/.node24/bin/node scripts/lint-no-api-outside-adapter.mjs; echo "exit=$?"
```

Expected: `lint-no-api-outside-adapter: clean`, `exit=0`. (Verified at `89148f9`: the three near-misses — `https://api.openai.com` in `lib/llm-call.js:77`, `https://api.cohere.com` in `lib/providers/reranker-cohere.js:52`, and the prose `api.pluginConfig…` in `lib/telegram-commands/status-data.js:9` — are excluded by the `/`-guard and the comment stripper.)

- [ ] **Step 3: Write the test that proves the script detects a violation**

Create `tests/lint-no-api-outside-adapter.test.js`:

```js
/**
 * tests/lint-no-api-outside-adapter.test.js — PR-02d.
 *
 * The boundary rule is only worth having if it fails on a real violation, so
 * the test plants one under engine/ and removes it again.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, "scripts", "lint-no-api-outside-adapter.mjs");

function run() {
  try {
    return { status: 0, out: execFileSync(process.execPath, [script], { cwd: root, encoding: "utf8" }) };
  } catch (error) {
    return { status: error.status ?? 1, out: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

describe("lint-no-api-outside-adapter", () => {
  it("passes on the current tree", () => {
    const result = run();
    assert.equal(result.status, 0, result.out);
  });

  it("fails on an api. reference under engine/", (t) => {
    const dir = join(root, "engine", "__lint_probe__");
    mkdirSync(dir, { recursive: true });
    t.after(() => rmSync(join(root, "engine", "__lint_probe__"), { recursive: true, force: true }));
    writeFileSync(join(dir, "bad.js"), "export function x(api) { return api.logger; }\n");
    const result = run();
    assert.equal(result.status, 1);
    assert.match(result.out, /engine\/__lint_probe__\/bad\.js:1/);
  });

  it("allows an api. reference inside the adapter", (t) => {
    const dir = join(root, "adapter", "__lint_probe__");
    mkdirSync(dir, { recursive: true });
    t.after(() => rmSync(join(root, "adapter", "__lint_probe__"), { recursive: true, force: true }));
    writeFileSync(join(dir, "ok.js"), "export function x(api) { return api.on(\"gateway_stop\", () => {}); }\n");
    assert.equal(run().status, 0);
  });
});
```

- [ ] **Step 4: Run it**

```bash
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/lint-no-api-outside-adapter.test.js 2>&1 | tail -8
```

Expected: `tests 3`, `pass 3`, `fail 0`.

- [ ] **Step 5: Chain it into `npm run lint`**

```json
"lint": "node --check index.js && find lib tests test -name '*.js' -exec node --check {} + && find scripts tools -name '*.mjs' -exec node --check {} + && node scripts/typecheck.mjs && node scripts/lint-no-api-outside-adapter.mjs",
```

- [ ] **Step 6: Lint, suite, golden**

```bash
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm run lint
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/golden-prefix.test.js
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm test 2>&1 | tail -20
```

Expected: lint prints `lint-no-api-outside-adapter: clean` and exits 0; golden `pass 7 / fail 0`; suite at the accepted baseline.

- [ ] **Step 7: Commit**

```bash
cd "$PLUR1BUS"
git add scripts/lint-no-api-outside-adapter.mjs tests/lint-no-api-outside-adapter.test.js package.json
git commit -m "chore(host): forbid the OpenClaw api surface outside the adapter

PR-02d. Wired into npm run lint, which the existing CI lint job already runs,
so no workflow change is needed."
```

---

## PR-03 — how the split is actually done

Read this once before Tasks 10–17.

`plugin.register(api, registrationDependencies)` is **one function from `index.js:4394` to `index.js:13491`** — about 9 100 lines, with 471 bindings in scope and every hook body a closure over them. You cannot move a hook body by cut-and-paste; you have to know exactly which bindings it captures.

**The recipe, applied identically in Tasks 11–17:**

1. Run `tools/free-identifiers.mjs` (Task 10) over the line range. It prints two lists: **module-scope** names (declared at `index.js` top level → the moved module `import`s them from the same `./lib/…` path `index.js` uses) and **register-scope** names (→ they go in the context object).
2. Create the module. It exports one factory that takes a single context object and destructures it **at the top of the factory**, then contains the moved code verbatim:

```js
export function createSomething(ctx) {
  const { pool, cfg, embeddings, host /* … the exact list the tool printed … */ } = ctx;
  return async function something(event, hookCtx) {
    /* the moved body, unchanged */
  };
}
```

3. In `index.js`, at the *same line* the code used to start, call the factory with an object literal of exactly those keys and register the result. Keeping the call at the original position preserves evaluation order — several registrations read values (`runtimeScheduler.config.recallTimeoutMs`) at registration time, and moving the call earlier would read them before they exist.
4. The five bindings that `let`-rebind are safe to pass by value **because every rebinding happens before any hook is registered**: `cfg` (`index.js:4433`, rebound once at `:4555`), `vectorDim` (`:5067`, rebound at `:5069`/`:5074`), `modelPreparationCoordinator` (`:6138`, assigned at `:6141`/`:6152`), `hostMemoryConfig` (`:5220`), `controlHealthPrimaryAgentIds` (`:5601`). The earliest registration is at `:7024`. **The two exceptions are `sessionCountSinceReflection` and `lastReflectionAt`** (`:5049-5050`), which the capture hook rebinds *at turn time* (`:10852-10853`); Task 14 converts them into one shared mutable object first.
5. Run the golden corpus and the suite. Commit.

**Measured sizes at `89148f9`** (`tools/free-identifiers.mjs` output; the counts are the acceptance check for step 1 of each task — a different number means the range drifted and you must re-derive it):

| Range | Lines | module-scope imports | register-scope context keys | Task |
|---|---|---|---|---|
| `12259-12283` `reply_dispatch` + `agent_end` cleanup | 25 | 0 | 5 | 11 |
| `13354-13443` maintenance-only `before_prompt_build` | 90 | 14 | 9 | 12 |
| `12285-13351` recall assembly | 1 067 | 76 | 62 | 13 |
| `10354-11299` auto-capture | 946 | 51 | 52 | 14 |
| `7255-9044` `runPlur1busCommand` incl. the 17 internal job runners | 1 790 | 96 | 82 | 15 |
| `9083-10268` chat-command registration | 1 186 | 88 | 42 | 16 |

(The register-scope counts above are after Tasks 7 and 8, which remove `api` from every one of these ranges except the `api.on(...)` registration calls themselves — those stay in `index.js` or move to an `adapter/` module. Before Task 7 the tool also reports `api`.)

---

### Task 10 (PR-03a): scaffold, the scope analyser, the dependency rule, and the export guard

No product code moves in this task. It builds the three tools every later task depends on.

**Files:**
- Create: `tools/free-identifiers.mjs`
- Create: `scripts/lint-engine-imports.mjs`
- Create: `tests/index-public-exports.test.js`
- Create: `tests/lint-engine-imports.test.js`
- Create: `engine/.gitkeep`, `adapter/openclaw/.gitkeep`
- Modify: `package.json` — add `"engine/"` and `"adapter/"` to `files`, chain the new linter into `scripts.lint`

**Interfaces:**
- Produces: `node tools/free-identifiers.mjs <file> <startLine> <endLine>` printing `MODULE-SCOPE (import these): <n>` and `REGISTER-SCOPE (pass via context object): <n>` followed by the space-separated names; `npm run lint` enforcing the dependency rule; `tests/index-public-exports.test.js` guarding the 19 public names.
- Consumed by: Tasks 11–17.

**`package.json:files` matters.** It currently lists `index.js`, `lib/`, `scripts/`, some docs, `.openclaw/extensions/…`, `openclaw.plugin.json`, `CHANGELOG.md`, `README.md`, `LICENSE`. `engine/` and `adapter/` **must** be added or the published tarball loses everything PR-03 moves and the plugin breaks on install. `tools/` must **not** be added — it is developer-only.

- [ ] **Step 1: Write the scope analyser**

Create `tools/free-identifiers.mjs`:

```js
/**
 * scripts/dev/free-identifiers.mjs — list the identifiers a line range of a
 * module uses but does not declare, minus module-level imports and globals.
 *
 * Usage: node scripts/dev/free-identifiers.mjs <file> <startLine> <endLine>
 */
import { readFileSync } from "node:fs";
import ts from "typescript";

const [file, startArg, endArg] = process.argv.slice(2);
const startLine = Number(startArg);
const endLine = Number(endArg);
const text = readFileSync(file, "utf8");
const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);

const lineOf = (pos) => sf.getLineAndCharacterOfPosition(pos).line + 1;

// Identifiers declared at module top level (imports, top-level const/function/class).
const moduleScope = new Set();
for (const st of sf.statements) {
  if (ts.isImportDeclaration(st) && st.importClause) {
    const c = st.importClause;
    if (c.name) moduleScope.add(c.name.text);
    if (c.namedBindings) {
      if (ts.isNamespaceImport(c.namedBindings)) moduleScope.add(c.namedBindings.name.text);
      else for (const e of c.namedBindings.elements) moduleScope.add(e.name.text);
    }
  } else if (ts.isVariableStatement(st)) {
    for (const d of st.declarationList.declarations) collectBindingNames(d.name, moduleScope);
  } else if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name) {
    moduleScope.add(st.name.text);
  }
}

function collectBindingNames(node, out) {
  if (ts.isIdentifier(node)) { out.add(node.text); return; }
  if (ts.isObjectBindingPattern(node) || ts.isArrayBindingPattern(node)) {
    for (const el of node.elements) {
      if (ts.isOmittedExpression(el)) continue;
      collectBindingNames(el.name, out);
    }
  }
}

// Walk the whole file with a scope stack; when inside the range, record
// identifier references that resolve outside the range.
const declaredInRange = new Set();
const free = new Map();
const registerStart = 4394;
const scopes = [new Map()];

function isScopeNode(n) {
  return ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n)
    || ts.isMethodDeclaration(n) || ts.isConstructorDeclaration(n) || ts.isGetAccessor(n)
    || ts.isSetAccessor(n) || ts.isBlock(n) || ts.isForStatement(n) || ts.isForOfStatement(n)
    || ts.isForInStatement(n) || ts.isCatchClause(n) || ts.isCaseBlock(n)
    || ts.isClassDeclaration(n) || ts.isClassExpression(n) || ts.isSourceFile(n);
}

function declareInCurrent(name, node) {
  const line = lineOf(node.getStart(sf));
  scopes[scopes.length - 1].set(name, line);
  if (line >= startLine && line <= endLine) declaredInRange.add(name);
}

function hoistDeclarations(node) {
  // Declare names introduced directly by this node into the current scope.
  if (ts.isImportDeclaration(node) && node.importClause) {
    const names = new Set();
    const clause = node.importClause;
    if (clause.name) names.add(clause.name.text);
    if (clause.namedBindings) {
      if (ts.isNamespaceImport(clause.namedBindings)) names.add(clause.namedBindings.name.text);
      else for (const element of clause.namedBindings.elements) names.add(element.name.text);
    }
    for (const n of names) declareInCurrent(n, node);
  } else if (ts.isVariableDeclaration(node)) {
    const names = new Set();
    collectBindingNames(node.name, names);
    for (const n of names) declareInCurrent(n, node);
  } else if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) {
    declareInCurrent(node.name.text, node);
  } else if (ts.isParameter(node)) {
    const names = new Set();
    collectBindingNames(node.name, names);
    for (const n of names) declareInCurrent(n, node);
  } else if (ts.isBindingElement(node)) {
    const names = new Set();
    collectBindingNames(node.name, names);
    for (const n of names) declareInCurrent(n, node);
  } else if (ts.isCatchClause(node) && node.variableDeclaration) {
    const names = new Set();
    collectBindingNames(node.variableDeclaration.name, names);
    for (const n of names) declareInCurrent(n, node);
  }
}

function isReference(node) {
  if (!ts.isIdentifier(node)) return false;
  const p = node.parent;
  if (!p) return false;
  // property access `x.foo` — only `x` counts
  if (ts.isPropertyAccessExpression(p) && p.name === node) return false;
  if (ts.isPropertyAssignment(p) && p.name === node) return false;
  if (ts.isShorthandPropertyAssignment(p) && p.name === node) return true; // { x } uses x
  if (ts.isBindingElement(p) && p.propertyName === node) return false;
  if (ts.isBindingElement(p) && p.name === node) return false;
  if (ts.isParameter(p) && p.name === node) return false;
  if (ts.isVariableDeclaration(p) && p.name === node) return false;
  if ((ts.isFunctionDeclaration(p) || ts.isClassDeclaration(p) || ts.isFunctionExpression(p)) && p.name === node) return false;
  if (ts.isMethodDeclaration(p) && p.name === node) return false;
  if (ts.isPropertyDeclaration(p) && p.name === node) return false;
  if (ts.isMetaProperty(p)) return false;
  if (ts.isLabeledStatement(p) && p.label === node) return false;
  if (ts.isBreakOrContinueStatement(p) && p.label === node) return false;
  return true;
}

function declarationLine(name) {
  for (let i = scopes.length - 1; i >= 0; i--) {
    if (scopes[i].has(name)) return scopes[i].get(name);
  }
  return null;
}

function visit(node) {
  const opened = isScopeNode(node);
  if (opened) scopes.push(new Map());
  // Hoist sibling declarations of this scope's immediate children first.
  if (opened) {
    node.forEachChild(function pre(child) {
      hoistDeclarations(child);
      if (ts.isVariableStatement(child)) for (const d of child.declarationList.declarations) hoistDeclarations(d);
      if (ts.isBlock(child) || isScopeNode(child)) return; // do not descend into nested scopes
      child.forEachChild(pre);
    });
    if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)
      || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node)) {
      for (const p of node.parameters) hoistDeclarations(p);
    }
    if (ts.isCatchClause(node)) hoistDeclarations(node);
  }
  if (ts.isIdentifier(node) && isReference(node)) {
    const line = lineOf(node.getStart(sf));
    if (line >= startLine && line <= endLine) {
      const name = node.text;
      const declLine = declarationLine(name);
      if (declLine !== null && (declLine < startLine || declLine > endLine)) {
        free.set(name, moduleScope.has(name) && declLine < registerStart ? "module" : "register");
      }
    }
  }
  node.forEachChild(visit);
  if (opened) scopes.pop();
}

visit(sf);
const mod = [...free].filter(([, k]) => k === "module").map(([n]) => n).sort();
const reg = [...free].filter(([, k]) => k === "register").map(([n]) => n).sort();
console.log(`${file}:${startLine}-${endLine}`);
console.log(`MODULE-SCOPE (import these): ${mod.length}`);
console.log(mod.join(" "));
console.log(`REGISTER-SCOPE (pass via context object): ${reg.length}`);
console.log(reg.join(" "));
```

`registerStart` is the line `register(api, registrationDependencies = {})` begins on (`index.js:4394` at `89148f9`). It only separates "declared at module top level, so import it" from "declared inside `register`, so pass it in"; if `index.js` shifts, update the constant and re-run.

- [ ] **Step 2: Verify the analyser against the measured table**

```bash
cd "$PLUR1BUS" && for r in "12259 12283" "13354 13443" "12285 13351" "10354 11299" "7255 9044" "9083 10268"; do
  set -- $r; /home/claude/.node24/bin/node tools/free-identifiers.mjs index.js $1 $2; echo;
done
```

Expected: the six ranges print, in order, `0/5`, `14/9`, `76/62`, `51/52`, `96/82`, `88/42` for MODULE-SCOPE/REGISTER-SCOPE. Cross-check against the table above. Two spot checks that catch a drifted range immediately:

- `13354-13443` MODULE-SCOPE must be exactly `buildMaintenanceNudges consumePlur1busStartNotice formatReminderNudge formatTemporalContinuityContext formatTimeContext getLastActivity homedir join listDueReminders presentReminder readPendingReminders recordActivity shouldSkipAutoRecallForInternalTurn writePendingReminders`.
- `12259-12283` REGISTER-SCOPE must be exactly `api autoRecall getMemoryTurnRoutes replyDispatchInvocations turnRouteState`.

A different set means the line range drifted; re-derive it with `grep -n 'api.on("before_prompt_build"' index.js` and `grep -n 'api.on("reply_dispatch"' index.js` before trusting it. Note that `api` disappears from every REGISTER-SCOPE list except these registration ranges once Tasks 7 and 8 have landed; if you see `api` in the recall or capture list, those tasks are not in the tree.

- [ ] **Step 3: Write the dependency-rule linter**

Create `scripts/lint-engine-imports.mjs`:

```js
/**
 * scripts/lint-engine-imports.mjs
 *
 * The dependency rule for the extraction (engine-extraction.md §b.1, §c PR-03):
 *
 *   1. `engine/**` never imports the host. Forbidden: the `openclaw` package
 *      and its subpaths, `lib/setup/*-plugin-runtime.js`,
 *      `lib/runtime-shutdown.js`, `lib/host-services.js`,
 *      `lib/providers/openclaw-memory-embedding-adapters.js`.
 *   2. Neither `engine/**` nor `adapter/**` imports `index.js`. Everything they
 *      need arrives through their context object. An import back into the
 *      plugin shell is how an ESM cycle gets in, and a cycle yields an
 *      `undefined` binding at call time rather than a load error.
 *   3. No import cycle inside `engine/** + adapter/**`.
 *
 * dependency-cruiser is not installed and cannot be installed offline, so this
 * is a small static walker: it reads `import … from "x"`, `export … from "x"`
 * and `import("x")` with a literal specifier. That covers every form the
 * codebase uses (`"type": "module"`, no `require`).
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const ROOTS = ["engine", "adapter"];

const FORBIDDEN_FOR_ENGINE = [
  { test: (spec) => spec === "openclaw" || spec.startsWith("openclaw/"), why: "the openclaw package" },
  { test: (spec, target) => target === "lib/runtime-shutdown.js", why: "lib/runtime-shutdown.js (adapter lifecycle)" },
  { test: (spec, target) => target === "lib/host-services.js", why: "lib/host-services.js (built from the OpenClaw api)" },
  { test: (spec, target) => target === "lib/providers/openclaw-memory-embedding-adapters.js", why: "the OpenClaw embedding adapter" },
  { test: (spec, target) => /^lib\/setup\/[^/]+-plugin-runtime\.js$/.test(target || ""), why: "a lib/setup plugin runtime" },
];

const IMPORT_PATTERNS = [
  /(?:^|\n)\s*import\s[^;]*?\sfrom\s*["']([^"']+)["']/g,
  /(?:^|\n)\s*import\s*["']([^"']+)["']/g,
  /(?:^|\n)\s*export\s[^;]*?\sfrom\s*["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
];

function* walk(directory) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      yield* walk(full);
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      yield full;
    }
  }
}

function toPosix(value) {
  return value.split(sep).join("/");
}

/**
 * @param {string} fromFile Absolute path of the importing file.
 * @param {string} spec Import specifier.
 * @returns {string|null} Repo-relative POSIX path, or null for a bare package.
 */
function resolveTarget(fromFile, spec) {
  if (!spec.startsWith(".")) return null;
  return toPosix(relative(root, resolve(dirname(fromFile), spec)));
}

function importsOf(file) {
  const source = readFileSync(file, "utf8");
  const specs = new Set();
  for (const pattern of IMPORT_PATTERNS) {
    pattern.lastIndex = 0;
    let match = pattern.exec(source);
    while (match) {
      specs.add(match[1]);
      match = pattern.exec(source);
    }
  }
  return [...specs];
}

const violations = [];
const graph = new Map();

for (const scanRoot of ROOTS) {
  const base = join(root, scanRoot);
  try {
    if (!statSync(base).isDirectory()) continue;
  } catch {
    continue;
  }
  for (const file of walk(base)) {
    const from = toPosix(relative(root, file));
    const edges = [];
    for (const spec of importsOf(file)) {
      const target = resolveTarget(file, spec);
      if (target === "index.js") {
        violations.push(`${from}: imports index.js — pass what you need through the context object instead`);
      }
      if (from.startsWith("engine/")) {
        for (const rule of FORBIDDEN_FOR_ENGINE) {
          if (rule.test(spec, target)) violations.push(`${from}: engine code must not import ${rule.why} (\`${spec}\`)`);
        }
      }
      if (target && (target.startsWith("engine/") || target.startsWith("adapter/"))) edges.push(target);
    }
    graph.set(from, edges);
  }
}

// Depth-first cycle detection over the engine+adapter subgraph.
const WHITE = 0;
const GREY = 1;
const BLACK = 2;
const colour = new Map([...graph.keys()].map((key) => [key, WHITE]));
const stack = [];

function visit(node) {
  colour.set(node, GREY);
  stack.push(node);
  for (const next of graph.get(node) || []) {
    if (!graph.has(next)) continue;
    const state = colour.get(next);
    if (state === GREY) {
      const cycle = stack.slice(stack.indexOf(next)).concat(next);
      violations.push(`import cycle: ${cycle.join(" -> ")}`);
    } else if (state === WHITE) {
      visit(next);
    }
  }
  stack.pop();
  colour.set(node, BLACK);
}

for (const node of graph.keys()) if (colour.get(node) === WHITE) visit(node);

if (violations.length > 0) {
  console.error("Engine/adapter dependency rule violated:\n");
  for (const violation of [...new Set(violations)]) console.error(`  ${violation}`);
  console.error(`\n${new Set(violations).size} violation(s)`);
  process.exit(1);
}
console.log(`lint-engine-imports: clean (${graph.size} module(s))`);
```

- [ ] **Step 4: Write its test**

Create `tests/lint-engine-imports.test.js`:

```js
/**
 * tests/lint-engine-imports.test.js — PR-03a.
 *
 * Review Focus item 3: an ESM cycle between adapter and engine modules yields
 * an undefined binding at call time, not a load error, so it must be caught
 * statically.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, "scripts", "lint-engine-imports.mjs");

function run() {
  try {
    return { status: 0, out: execFileSync(process.execPath, [script], { cwd: root, encoding: "utf8" }) };
  } catch (error) {
    return { status: error.status ?? 1, out: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

function probe(t, files) {
  const dirs = new Set();
  for (const [relativePath, source] of Object.entries(files)) {
    const full = join(root, relativePath);
    mkdirSync(dirname(full), { recursive: true });
    dirs.add(dirname(full));
    writeFileSync(full, source);
  }
  t.after(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });
}

describe("lint-engine-imports", () => {
  it("passes on the current tree", () => {
    const result = run();
    assert.equal(result.status, 0, result.out);
  });

  it("allows an adapter module importing an engine module", (t) => {
    probe(t, {
      "engine/__probe__/a.js": 'import { applyGlobalInjectBudget } from "../../lib/inject-budget.js";\nexport function a() { return applyGlobalInjectBudget; }\n',
      "adapter/__probe__/r.js": 'import { a } from "../../engine/__probe__/a.js";\nexport function r(api) { return api.on("x", a); }\n',
    });
    assert.equal(run().status, 0);
  });

  it("rejects engine code importing the adapter lifecycle", (t) => {
    probe(t, {
      "engine/__probe__/bad.js": 'import { runtimeIfUsable } from "../../lib/runtime-shutdown.js";\nexport const x = runtimeIfUsable;\n',
    });
    const result = run();
    assert.equal(result.status, 1);
    assert.match(result.out, /must not import lib\/runtime-shutdown\.js/);
  });

  it("rejects an import of index.js", (t) => {
    probe(t, { "engine/__probe__/shell.js": 'import plugin from "../../index.js";\nexport const p = plugin;\n' });
    const result = run();
    assert.equal(result.status, 1);
    assert.match(result.out, /imports index\.js/);
  });

  it("rejects an import cycle", (t) => {
    probe(t, {
      "engine/__probe__/b.js": 'import { c } from "./c.js";\nexport function b() { return c(); }\n',
      "engine/__probe__/c.js": 'import { b } from "./b.js";\nexport function c() { return b(); }\n',
    });
    const result = run();
    assert.equal(result.status, 1);
    assert.match(result.out, /import cycle: engine\/__probe__\/[bc]\.js/);
  });
});
```

- [ ] **Step 5: Write the public-export guard**

Review Focus item 4. Create `tests/index-public-exports.test.js`:

```js
/**
 * tests/index-public-exports.test.js — PR-03a.
 *
 * 46 test files import internals from ../index.js. Moving a symbol into
 * engine/ or adapter/ without re-exporting it here breaks them, sometimes
 * quietly. This list is frozen for M1a; PR-14 is the PR that may change it.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import * as index from "../index.js";

const PUBLIC_NAMES = [
  "AgentDbPool",
  "MemoryDB",
  "appendConflictLog",
  "applyEpistemicStatusToLanceDb",
  "applyEpistemicStatusToNeo",
  "applyValidTimeCloseToLanceDb",
  "buildConflictSummaryFromLog",
  "buildMaintenanceNudges",
  "completePendingConfirmation",
  "createRuntimeRerankerProvider",
  "guardUnsafeDirectCronTurn",
  "inspectCronNativeCapabilities",
  "parseConfirmationCommand",
  "parseFeatureCronBootstrapLastPlanCreateCount",
  "reconcileUnsafeDirectCronsWithService",
  "rememberPendingConfirmation",
  "resolveConfirmationIdentity",
  "runDeferredFeatureCronBootstrap",
  "selectSemanticDiscoveryWorkspaces",
];

describe("index.js public surface", () => {
  for (const name of PUBLIC_NAMES) {
    it(`exports ${name}`, () => {
      assert.equal(typeof index[name], "function", `${name} must stay exported from index.js`);
    });
  }

  it("exports exactly these names and nothing new", () => {
    const actual = Object.keys(index).filter((key) => key !== "default").sort();
    assert.deepEqual(actual, [...PUBLIC_NAMES].sort());
  });

  it("still default-exports the plugin", () => {
    assert.equal(index.default.id, "memory-lancedb-namespaced");
    assert.equal(index.default.kind, "memory");
    assert.equal(typeof index.default.register, "function");
  });
});
```

- [ ] **Step 6: Create the directories and update `package.json`**

```bash
cd "$PLUR1BUS" && mkdir -p engine adapter/openclaw && touch engine/.gitkeep adapter/openclaw/.gitkeep
```

In `package.json`, add `"engine/"` and `"adapter/"` to `files` immediately after `"lib/"`, and extend `lint`:

```json
"lint": "node --check index.js && find lib tests test -name '*.js' -exec node --check {} + && find scripts tools -name '*.mjs' -exec node --check {} + && node scripts/typecheck.mjs && node scripts/lint-no-api-outside-adapter.mjs && node scripts/lint-engine-imports.mjs",
```

Also extend the `node --check` sweep to the new directories by changing `find lib tests test` to `find lib engine adapter tests test`.

- [ ] **Step 7: Run everything**

```bash
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/lint-engine-imports.test.js tests/index-public-exports.test.js 2>&1 | tail -10
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm run lint
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/golden-prefix.test.js
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm test 2>&1 | tail -20
```

Expected: `pass 27, fail 0` for the two new files (5 + 22); lint prints `lint-engine-imports: clean (0 module(s))` and exits 0; golden `pass 7 / fail 0`; suite at the accepted baseline.

- [ ] **Step 8: Commit**

```bash
cd "$PLUR1BUS"
git add tools/free-identifiers.mjs scripts/lint-engine-imports.mjs tests/lint-engine-imports.test.js tests/index-public-exports.test.js engine adapter package.json
git commit -m "chore(engine): scaffold engine/ and adapter/ with their dependency rule

PR-03a. tools/free-identifiers.mjs uses the TypeScript compiler API (already a
dependency) to produce each move's exact context key set, so no closure
dependency is enumerated by hand. The linter catches the three ways the split
can go wrong: engine importing the host, anything importing index.js, and an
ESM cycle. package.json:files gains engine/ and adapter/ so the published
tarball does not lose them."
```

---

### Task 11 (PR-03b): move the turn-route registrations into `adapter/openclaw/`

The smallest move: 25 lines, 5 context keys, 0 imports. Do it first so the recipe is proven on something you can read in one screen. This code is **pure adapter** — `engine-extraction.md` §a.1 marks `reply_dispatch` and the `agent_end` turn-route cleanup as "deleted" on the harness path — so nothing goes into `engine/`.

**Files:**
- Create: `adapter/openclaw/register-turn-route.js`
- Modify: `index.js:12255-12283` (the `let replyDispatchInvocations = 0;` line through the closing `});` of the `agent_end` handler)
- Create: `tests/adapter-register-turn-route.test.js`

**Interfaces:**
- Consumes: `host` (Task 7).
- Produces: `registerTurnRouteHooks(ctx) -> void` where `ctx = { api, host, autoRecall, getMemoryTurnRoutes, turnRouteState }`.

- [ ] **Step 1: Confirm the range and its dependencies**

```bash
cd "$PLUR1BUS" && grep -n 'api.on("reply_dispatch"' index.js
cd "$PLUR1BUS" && /home/claude/.node24/bin/node tools/free-identifiers.mjs index.js 12259 12283
```

Expected: the hook at `12259`; `MODULE-SCOPE … 0`; `REGISTER-SCOPE … 5` = `api autoRecall getMemoryTurnRoutes replyDispatchInvocations turnRouteState`. `replyDispatchInvocations` is declared at `:12258`, one line above the range, and moves *with* the code, so the context object carries four keys plus `host`.

- [ ] **Step 2: Write the failing test**

Create `tests/adapter-register-turn-route.test.js`:

```js
/**
 * tests/adapter-register-turn-route.test.js — PR-03b.
 *
 * The turn-route observer is the only proof of channel identity the OpenClaw
 * adapter has (host-contract §c.1), and its registration options are part of
 * the contract: lowest possible priority, and only the agent/acp dispatch
 * kinds.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { registerTurnRouteHooks } from "../adapter/openclaw/register-turn-route.js";
import { createStubHost } from "../lib/host-services.js";

function makeApi() {
  const registrations = [];
  return {
    registrations,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    on(name, handler, options) {
      registrations.push({ name, handler, options });
      return { dispose() {} };
    },
  };
}

describe("registerTurnRouteHooks", () => {
  it("registers reply_dispatch at minimum priority for agent and acp only", () => {
    const api = makeApi();
    registerTurnRouteHooks({
      api,
      host: createStubHost(),
      autoRecall: true,
      getMemoryTurnRoutes: async () => null,
      turnRouteState: {},
    });
    const dispatch = api.registrations.find((r) => r.name === "reply_dispatch");
    assert.ok(dispatch, "reply_dispatch must be registered");
    assert.equal(dispatch.options.priority, Number.MIN_SAFE_INTEGER);
    assert.deepEqual(dispatch.options.eligibleDispatchKinds, ["agent", "acp"]);
  });

  it("observes a dispatch and returns undefined", async () => {
    const api = makeApi();
    const observed = [];
    const turnRoutes = { observeReplyDispatch: (event) => observed.push(event), lastObserve: () => "registered" };
    registerTurnRouteHooks({
      api,
      host: createStubHost(),
      autoRecall: true,
      getMemoryTurnRoutes: async () => turnRoutes,
      turnRouteState: {},
    });
    const dispatch = api.registrations.find((r) => r.name === "reply_dispatch");
    const result = await dispatch.handler({ sessionKey: "agent:a:s", runId: "r" }, { dispatchKind: "agent" });
    assert.equal(result, undefined);
    assert.equal(observed.length, 1);
  });

  it("clears the run on agent_end only once the routes have initialised", async () => {
    const api = makeApi();
    const cleared = [];
    const turnRouteState = {};
    registerTurnRouteHooks({
      api,
      host: createStubHost(),
      autoRecall: true,
      getMemoryTurnRoutes: async () => null,
      turnRouteState,
    });
    const end = api.registrations.find((r) => r.name === "agent_end");
    assert.equal(await end.handler({ runId: "r1" }, {}), undefined, "no init promise means no work");
    turnRouteState.initPromise = Promise.resolve({ clearRun: (id) => cleared.push(id) });
    await end.handler({}, { runId: "r2" });
    assert.deepEqual(cleared, ["r2"]);
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

```bash
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/adapter-register-turn-route.test.js 2>&1 | tail -5
```

Expected: `ERR_MODULE_NOT_FOUND … '../adapter/openclaw/register-turn-route.js'`.

- [ ] **Step 4: Create the module**

Create `adapter/openclaw/register-turn-route.js`. The two handler bodies are `index.js:12258-12283` moved verbatim, with `api.logger?.x?.(` already `host.logger.x(` from Task 7:

```js
/**
 * adapter/openclaw/register-turn-route.js
 *
 * OpenClaw-only: the `reply_dispatch` observer that mints the turn-route
 * ticket the six-step identity chain later claims
 * (lib/memory-request-context.js:1377-1393), and the `agent_end` cleanup that
 * drops the run. The harness supplies a proved principal instead and registers
 * neither (engine-extraction.md §a.1).
 */

/**
 * @param {{api: object, host: object, autoRecall: boolean,
 *          getMemoryTurnRoutes: () => Promise<object|null>,
 *          turnRouteState: {initPromise?: Promise<object|null>}}} ctx Registration context.
 * @returns {void}
 */
export function registerTurnRouteHooks(ctx) {
  const { api, host, autoRecall, getMemoryTurnRoutes, turnRouteState } = ctx;

  // 7.12.35: Registrierung und jeden Aufruf sichtbar machen — auf 7.12.34
  // erschien fuer Bernds Turns (10.09.2026 14:27–15:04) keine einzige
  // Handler-Zeile, `pending=0`; statisch war im Host kein Gate zu finden.
  let replyDispatchInvocations = 0;
  const replyDispatchRegistration = api.on("reply_dispatch", async (event, hookCtx) => {
    replyDispatchInvocations += 1;
    host.logger.info(`memory-turn-routes: reply_dispatch handler invoked #${replyDispatchInvocations} dispatchKind=${String(hookCtx?.dispatchKind || "")} hasCtx=${Boolean(event?.ctx)} sessionKey=${String(event?.sessionKey || event?.ctx?.SessionKey || "").slice(0, 96)}`);
    const turnRoutes = await getMemoryTurnRoutes();
    turnRoutes?.observeReplyDispatch(event);
    // 7.12.33: Ausgang der Beobachtung (Debug); die Fallback-Warnung des
    // Prompt-Hooks traegt denselben Grund als `ticket=`.
    try {
      const sessionKey = event?.sessionKey || event?.ctx?.SessionKey || "";
      const observed = turnRoutes?.lastObserve?.(sessionKey) || "none";
      const line = `memory-turn-routes: dispatch observe:${observed} session=${String(sessionKey).slice(0, 96)} runId=${String(event?.runId || event?.ctx?.RunId || "").slice(0, 40)} eventKeys=${Object.keys(event || {}).filter((k) => k !== "ctx").slice(0, 24).join(",")} ctxKeys=${Object.keys(event?.ctx || {}).filter((k) => /^(CommandTurn|CommandSource|CommandBody|Body|BodyForAgent|RawBody|SenderId|ChatId|Provider|Surface|AccountId|OriginatingTo|OriginatingChannel|OriginatingAccountId|SessionKey|RunId|isTailDispatch|MessageThreadId)$/.test(k)).join(",")}`;
      // 7.12.34: Nicht-Kommando-Ausstiege sichtbar machen (Info), Rest Debug.
      if (/^(registered|slash_command|command_turn:|command_source|is_command|tail_dispatch)/.test(observed)) host.logger.debug(line);
      else host.logger.info(line);
    } catch (_) { /* best-effort */ }
    return undefined;
  }, { priority: Number.MIN_SAFE_INTEGER, eligibleDispatchKinds: ["agent", "acp"] });
  host.logger.info(`memory-turn-routes: reply_dispatch hook registered result=${replyDispatchRegistration === undefined ? "undefined" : typeof replyDispatchRegistration} autoRecall=${autoRecall}`);

  api.on("agent_end", async (event, hookCtx) => {
    if (!turnRouteState.initPromise) return;
    const turnRoutes = await turnRouteState.initPromise;
    const runId = hookCtx?.runId ?? event?.runId;
    if (runId !== undefined && runId !== null) turnRoutes?.clearRun(runId);
  });
}
```

The `agent_end` handler's second parameter was named `ctx` in `index.js`; it is renamed `hookCtx` here because `ctx` is now the registration context. Nothing else changes.

- [ ] **Step 5: Replace the code in `index.js`**

Add the import next to the other `./lib/` imports:

```js
import { registerTurnRouteHooks } from "./adapter/openclaw/register-turn-route.js";
```

Delete `index.js:12258-12283` (from `      let replyDispatchInvocations = 0;` through the `      });` that closes the `agent_end` handler, inclusive of the two comment lines at `:12255-12257`) and put in its place:

```js
      registerTurnRouteHooks({ api, host, autoRecall, getMemoryTurnRoutes, turnRouteState });
```

- [ ] **Step 6: Syntax check, new test, dependency rule**

```bash
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --check index.js
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/adapter-register-turn-route.test.js 2>&1 | tail -8
cd "$PLUR1BUS" && /home/claude/.node24/bin/node scripts/lint-engine-imports.mjs
```

Expected: `--check` silent; `tests 3`, `pass 3`, `fail 0`; `lint-engine-imports: clean (1 module(s))`.

- [ ] **Step 7: Run the turn-route tests, then everything**

```bash
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 \
  tests/b13-memory-request-context.test.js \
  tests/b13-acl-callsite-adapters.test.js \
  tests/multi-namespace-recall-runtime.test.js 2>&1 | tail -8
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/golden-prefix.test.js
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm run lint
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm test 2>&1 | tail -20
```

Expected: all pass; golden `pass 7 / fail 0`; lint 0; suite at the accepted baseline. `tests/multi-namespace-recall-runtime.test.js` asserts `api.handlers.get("reply_dispatch")?.length === 1` — that assertion is the real regression detector for this task.

- [ ] **Step 8: Commit**

```bash
cd "$PLUR1BUS"
git add adapter/openclaw/register-turn-route.js index.js tests/adapter-register-turn-route.test.js
git commit -m "refactor(adapter): move the turn-route registrations out of index.js

PR-03b. reply_dispatch and the agent_end run cleanup are OpenClaw-only; the
harness supplies a proved principal and registers neither."
```

---

### Task 12 (PR-03c): move the maintenance-only `before_prompt_build` branch

90 lines, 14 module imports, 9 context keys. Splits into an engine module (the maintenance body) and an adapter module (the registration).

**Files:**
- Create: `engine/recall/minimal-maintenance.js`
- Create: `adapter/openclaw/register-maintenance-hook.js`
- Modify: `index.js:13352-13444` (the `} else if (neoEnabled || schicht15Enabled || gcEnabled) {` branch)
- Create: `tests/engine-minimal-maintenance.test.js`

**Interfaces:**
- Consumes: `host` (Task 7).
- Produces:
  - `createMinimalMaintenance(ctx) -> async (event, hookCtx) => ({ prependContext: string } | undefined)` from `engine/recall/minimal-maintenance.js`, where `ctx = { host, automaticWorkspacePolicyDecision, gcEnabled, getNeoStore, neoEnabled, pool, resolveCommandLocaleRecall, schicht15Enabled, temporalContextEnabled, stateDir }`
  - `registerMaintenanceHook(ctx) -> void` from `adapter/openclaw/register-maintenance-hook.js`, where `ctx` is the same object plus `api`

**One substitution inside the moved body.** `index.js:13379` reads the state dir inline:

```js
        const pendingStartNotice = consumePlur1busStartNotice(process.env.OPENCLAW_HOME || join(homedir(), ".openclaw"));
```

In the engine module that becomes `consumePlur1busStartNotice(stateDir)` with `stateDir` supplied by the context. `index.js` passes `host.stateDir`, and `resolveStateDir` (Task 6) computes exactly `process.env.OPENCLAW_HOME || join(homedir(), ".openclaw")`, so the value is identical. This is the `start` block's env dependency that `host-contract.md` §a.2 marks **Adapter**, and moving it behind `Host.stateDir` is precisely what that row asks for.

- [ ] **Step 1: Confirm the range and its dependencies**

```bash
cd "$PLUR1BUS" && grep -n 'else if (neoEnabled || schicht15Enabled || gcEnabled)' index.js
cd "$PLUR1BUS" && /home/claude/.node24/bin/node tools/free-identifiers.mjs index.js 13354 13443
```

Expected: `MODULE-SCOPE … 14` = `buildMaintenanceNudges consumePlur1busStartNotice formatReminderNudge formatTemporalContinuityContext formatTimeContext getLastActivity homedir join listDueReminders presentReminder readPendingReminders recordActivity shouldSkipAutoRecallForInternalTurn writePendingReminders`; `REGISTER-SCOPE … 9` = `api automaticWorkspacePolicyDecision gcEnabled getNeoStore neoEnabled pool resolveCommandLocaleRecall schicht15Enabled temporalContextEnabled`. `homedir` and `join` drop out of the engine module's imports because of the `stateDir` substitution; `api` stays in the adapter module.

- [ ] **Step 2: Write the failing test**

Create `tests/engine-minimal-maintenance.test.js`:

```js
/**
 * tests/engine-minimal-maintenance.test.js — PR-03c.
 *
 * The auto-recall-off branch still has to return the non-droppable blocks.
 * The important cases are the two early exits, because a regression there is
 * invisible in the golden corpus (which exercises the enabled path).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createMinimalMaintenance } from "../engine/recall/minimal-maintenance.js";
import { createStubHost } from "../lib/host-services.js";
import { makeTempDir } from "./helpers/temp-dir.js";

function baseCtx(overrides = {}) {
  return {
    host: createStubHost(),
    automaticWorkspacePolicyDecision: () => ({ allowed: true }),
    gcEnabled: false,
    getNeoStore: () => ({ recordHook() {} }),
    neoEnabled: false,
    pool: { withDb: async () => undefined },
    resolveCommandLocaleRecall: () => ({ lang: "en", tone: "neutral" }),
    schicht15Enabled: false,
    temporalContextEnabled: false,
    stateDir: makeTempDir("plur1bus-maintenance-state-"),
    ...overrides,
  };
}

describe("createMinimalMaintenance", () => {
  it("returns undefined when the workspace policy refuses the turn", async () => {
    const handler = createMinimalMaintenance(baseCtx({
      automaticWorkspacePolicyDecision: () => ({ allowed: false }),
    }));
    assert.equal(await handler({ prompt: "x" }, { agentId: "a", workspaceDir: "/tmp/ws" }), undefined);
  });

  it("returns undefined when there is no workspace directory", async () => {
    const handler = createMinimalMaintenance(baseCtx());
    assert.equal(await handler({ prompt: "x" }, { agentId: "a" }), undefined);
  });

  it("records the neo hook dispatch when neo is enabled", async () => {
    const recorded = [];
    const handler = createMinimalMaintenance(baseCtx({
      neoEnabled: true,
      getNeoStore: () => ({ recordHook: (name, payload) => recorded.push([name, payload]) }),
    }));
    await handler({ prompt: "hello" }, { agentId: "a" });
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0][0], "before_prompt_build");
    assert.equal(recorded[0][1].autoRecallDisabled, true);
    assert.equal(recorded[0][1].promptLength, 5);
  });

  it("survives a neo store that throws, logging instead of failing the turn", async () => {
    const warned = [];
    const handler = createMinimalMaintenance(baseCtx({
      neoEnabled: true,
      host: createStubHost({ logger: { warn: (m) => warned.push(m) } }),
      getNeoStore: () => { throw new Error("neo unavailable"); },
    }));
    assert.equal(await handler({ prompt: "x" }, { agentId: "a" }), undefined);
    assert.equal(warned.length, 1);
    assert.match(warned[0], /before_prompt_build dispatch tracking failed/);
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

```bash
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/engine-minimal-maintenance.test.js 2>&1 | tail -5
```

Expected: `ERR_MODULE_NOT_FOUND … '../engine/recall/minimal-maintenance.js'`.

- [ ] **Step 4: Create the engine module**

Create `engine/recall/minimal-maintenance.js`. Its imports are the 12 module-scope names the tool listed minus `homedir`/`join`, each from the same path `index.js` imports it from — check with `grep -n '<name>' index.js | head -1` for each:

```js
/**
 * engine/recall/minimal-maintenance.js
 *
 * The auto-recall-off branch of before_prompt_build (was index.js:13354-13443).
 * It still records the Neo hook dispatch, runs throttled GC, and emits the
 * non-droppable time/temporal/reminder blocks plus the maintenance nudges.
 * Host-neutral: everything it needs arrives in the context object.
 */

import { buildMaintenanceNudges } from "../../lib/... /* see note */";
```

> **Import resolution note.** Do not guess the paths. For each of the twelve names run `grep -n "<name>" index.js | head -3` and copy the `from "./lib/…"` specifier, rewriting the prefix `./lib/` to `../../lib/`. At `89148f9` they are: `buildMaintenanceNudges` — declared in `index.js` itself, so it must be moved or re-exported (see Step 4b); `consumePlur1busStartNotice`, `formatReminderNudge`, `listDueReminders`, `presentReminder`, `readPendingReminders`, `writePendingReminders`, `formatTemporalContinuityContext`, `formatTimeContext` / `getLastActivity` / `recordActivity` (`./lib/session-time.js`, `index.js:370`), `shouldSkipAutoRecallForInternalTurn`.

- [ ] **Step 4b: Handle `buildMaintenanceNudges`**

`buildMaintenanceNudges` is declared inside `index.js` (it is one of the 19 public exports). Two rules collide: the engine module must not import `index.js` (Global Constraint 8), and the name must stay exported from `index.js` (Global Constraint 9). Resolve both by passing it in through the context object rather than importing it: add `buildMaintenanceNudges` to the context keys for this module and for Task 13's. Verify afterwards:

```bash
cd "$PLUR1BUS" && /home/claude/.node24/bin/node scripts/lint-engine-imports.mjs
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/index-public-exports.test.js 2>&1 | tail -5
```

Both must pass. Apply the same rule to any other name the tool lists that turns out to be declared in `index.js` rather than imported: **pass it, do not import it.**

- [ ] **Step 5: Write the factory around the moved body**

The module's single export, with the body being `index.js:13355-13443` verbatim except for the `stateDir` substitution and `_event`/`ctx` renamed to `event`/`hookCtx`:

```js
/**
 * @param {object} ctx Engine context.
 * @returns {(event: object, hookCtx: object) => Promise<{prependContext: string}|undefined>} Handler.
 */
export function createMinimalMaintenance(ctx) {
  const {
    host,
    automaticWorkspacePolicyDecision,
    buildMaintenanceNudges,
    gcEnabled,
    getNeoStore,
    neoEnabled,
    pool,
    resolveCommandLocaleRecall,
    schicht15Enabled,
    stateDir,
    temporalContextEnabled,
  } = ctx;

  return async function minimalMaintenance(event, hookCtx) {
    /* index.js:13355-13443 verbatim, with:
       - `_event`  -> `event`
       - `ctx`     -> `hookCtx`
       - `api.logger.warn(` / `api.logger?.warn?.(` -> `host.logger.warn(`
       - `consumePlur1busStartNotice(process.env.OPENCLAW_HOME || join(homedir(), ".openclaw"))`
             -> `consumePlur1busStartNotice(stateDir)`
    */
  };
}
```

- [ ] **Step 6: Create the adapter module**

Create `adapter/openclaw/register-maintenance-hook.js`:

```js
/**
 * adapter/openclaw/register-maintenance-hook.js
 *
 * Registers the auto-recall-off before_prompt_build branch. The OpenClaw hook
 * default of 15 000 ms applies (no timeoutMs was declared here before and none
 * is declared now — host-contract §a.1).
 */

import { createMinimalMaintenance } from "../../engine/recall/minimal-maintenance.js";

/**
 * @param {object} ctx Registration context: the engine context plus `api`.
 * @returns {void}
 */
export function registerMaintenanceHook(ctx) {
  const handler = createMinimalMaintenance(ctx);
  ctx.api.on("before_prompt_build", handler);
}
```

- [ ] **Step 7: Replace the branch in `index.js`**

Add the import, then replace `index.js:13353-13444` (everything between the `} else if (neoEnabled || schicht15Enabled || gcEnabled) {` line and its closing `}`) with:

```js
      registerMaintenanceHook({
        api,
        host,
        automaticWorkspacePolicyDecision,
        buildMaintenanceNudges,
        gcEnabled,
        getNeoStore,
        neoEnabled,
        pool,
        resolveCommandLocaleRecall,
        schicht15Enabled,
        stateDir: host.stateDir,
        temporalContextEnabled,
      });
```

- [ ] **Step 8: Run the new test, the dependency rule, then everything**

```bash
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --check index.js
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/engine-minimal-maintenance.test.js 2>&1 | tail -8
cd "$PLUR1BUS" && /home/claude/.node24/bin/node scripts/lint-engine-imports.mjs
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/golden-prefix.test.js
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm run lint
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm test 2>&1 | tail -20
```

Expected: `tests 4`, `pass 4` for the new file; `lint-engine-imports: clean (3 module(s))`; golden `pass 7 / fail 0` — **scenario `recall-maintenance-only` is the one that covers this branch, so a byte difference there is this task's regression**; lint 0; suite at the accepted baseline.

- [ ] **Step 9: Commit**

```bash
cd "$PLUR1BUS"
git add engine adapter index.js tests/engine-minimal-maintenance.test.js
git commit -m "refactor(engine): extract the auto-recall-off maintenance branch

PR-03c. The start-notice path stops reading OPENCLAW_HOME directly and takes
host.stateDir, which resolveStateDir computes to the same value; that is the
host-contract a.2 'start' block moving behind Host.stateDir."
```

---

### Task 13 (PR-03d): move the recall assembly into `engine/recall/`

The centrepiece. 1 067 lines, 76 module-scope imports, 62 context keys. Same recipe as Task 12, at scale. Budget the hour for the mechanics, not for thinking — the analyser has already done the thinking.

**Files:**
- Create: `engine/recall/assemble-prompt-context.js`
- Create: `adapter/openclaw/register-recall-hook.js`
- Modify: `index.js:12285-13351`
- Create: `tests/engine-assemble-prompt-context.test.js`

**Interfaces:**
- Consumes: `host` (Task 7); the golden corpus (Tasks 1–2) is the acceptance gate.
- Produces:
  - `createPromptContextAssembler(ctx) -> async (event, hookCtx) => ({ prependContext: string } | undefined)`
  - `registerRecallHook(ctx) -> void`, which performs `ctx.api.on("before_prompt_build", handler, { timeoutMs: ctx.runtimeScheduler.config.recallTimeoutMs + 5_000 })`

**Three things that will bite if you do them differently:**
1. **The registration option is evaluated at registration time.** `index.js:13351` is `{ timeoutMs: runtimeScheduler.config.recallTimeoutMs + 5_000 }`. `registerRecallHook` must read `ctx.runtimeScheduler` and build that object itself, and the call must stay at the original position in `register()` — `runtimeScheduler` is constructed earlier, but several other context values are not built until just before this line.
2. **`runMinimalBeforePromptMaintenance` is a context key, not an import.** It is declared at `index.js:12190` inside `register()` and is called from the recall body at `:12306`. Pass it in.
3. **The six named blocks and the 17 000-char cap must come out unchanged.** The return at `index.js:13315-13325` builds the block array and calls `applyGlobalInjectBudget`. Do not "improve" the block array, the names, the droppable flags or the `cfg.recall?.globalInjectMaxChars ?? 17_000` default. PR-04 owns that change; M1a does not.

- [ ] **Step 1: Derive the exact dependency lists**

```bash
cd "$PLUR1BUS" && grep -n 'api.on("before_prompt_build"' index.js
cd "$PLUR1BUS" && /home/claude/.node24/bin/node tools/free-identifiers.mjs index.js 12285 13351 > /tmp/recall-deps.txt
cd "$PLUR1BUS" && cat /tmp/recall-deps.txt
```

Expected: three `before_prompt_build` registrations, the recall one at `12285`; `MODULE-SCOPE … 76`; `REGISTER-SCOPE … 62`, beginning `NEO_EMBED_TIMEOUT NEO_RECALL_PRELUDE_LOG_MS adaptiveBudgetCfg api autoRecallMinScore …` and ending `… traceEnabled traceInPrompt workspacePolicyGuard`. Keep `/tmp/recall-deps.txt`; you will copy both lists from it.

- [ ] **Step 2: Sort the 76 module-scope names into imports and context keys**

Most are imports in `index.js`; a few are declared in `index.js` itself and must be **passed, not imported** (Global Constraints 8 and 9). Classify each one:

```bash
cd "$PLUR1BUS" && for n in $(sed -n '3p' /tmp/recall-deps.txt); do
  line=$(grep -n "^import .*\b$n\b\|^import {[^}]*\b$n\b" index.js | head -1)
  if [ -z "$line" ]; then echo "PASS-IN  $n  (declared in index.js)"; else echo "IMPORT   $n  <- $line"; fi
done
```

Everything printed `IMPORT` becomes an `import … from "../../lib/…"` in the engine module (rewrite the `./lib/` prefix to `../../lib/`, and `node:*` specifiers stay as they are). Everything printed `PASS-IN` — at `89148f9` that is `MAX_PROMPT_REPLY_OUTCOME_READ_BYTES`, `buildMaintenanceNudges`, `dbg`, `makeQuerySummarizer`, `normalizeBoundedRecallInteger`, `normalizedLlmErrorClass`, `resolveRuntimeRecallBudget`, `runMergedNamespaceRecall`, `callLlm` and the other module-level helpers — is added to the context object instead. **Do not move a declaration out of `index.js`**: `buildMaintenanceNudges` is one of the 19 public exports, and the others are shared with code that is still in `index.js`.

- [ ] **Step 3: Write the failing test**

Create `tests/engine-assemble-prompt-context.test.js`. It does not re-test recall quality — the golden corpus does that — it pins the boundary contract:

```js
/**
 * tests/engine-assemble-prompt-context.test.js — PR-03d.
 *
 * The engine module must be constructible from a plain context object with no
 * OpenClaw api in it, and its refusal paths must stay refusals. Recall content
 * is covered byte for byte by tests/golden-prefix.test.js.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createPromptContextAssembler } from "../engine/recall/assemble-prompt-context.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("engine/recall/assemble-prompt-context", () => {
  it("exports a factory", () => {
    assert.equal(typeof createPromptContextAssembler, "function");
  });

  it("does not mention the OpenClaw api surface", () => {
    const source = readFileSync(join(root, "engine", "recall", "assemble-prompt-context.js"), "utf8");
    assert.doesNotMatch(source, /(?<![.\w$/-])api\s*\./);
  });

  it("keeps the six named blocks and the 17000-char default in one place", () => {
    const source = readFileSync(join(root, "engine", "recall", "assemble-prompt-context.js"), "utf8");
    for (const name of ["neo", "start", "memories", "time", "temporal", "reminder"]) {
      assert.match(source, new RegExp(`name:\\s*"${name}"`), `block ${name} must survive the move`);
    }
    assert.match(source, /globalInjectMaxChars \?\? 17_000/);
    assert.match(source, /\{ name: "time", text: timeContext, droppable: false \}/);
    assert.match(source, /\{ name: "reminder", text: reminderNudge, droppable: false \}/);
  });

  it("refuses a turn the workspace policy declines, without touching the pool", async () => {
    let poolTouched = false;
    const handler = createPromptContextAssembler({
      automaticWorkspacePolicyDecision: () => ({ allowed: false }),
      get pool() { poolTouched = true; return { withDb: async () => undefined }; },
    });
    assert.equal(await handler({ prompt: "x" }, { workspaceDir: "/tmp/ws", agentId: "a" }), undefined);
    assert.equal(poolTouched, false);
  });
});
```

The last test relies on the very first statements of the moved body (`index.js:12286-12288`) running before anything else; keep that order.

- [ ] **Step 4: Run it and watch it fail**

```bash
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/engine-assemble-prompt-context.test.js 2>&1 | tail -5
```

Expected: `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 5: Create the engine module**

Create `engine/recall/assemble-prompt-context.js` with the Step 2 imports, then:

```js
/**
 * engine/recall/assemble-prompt-context.js
 *
 * The per-turn recall assembly (was index.js:12285-13351): identity, Neo
 * window, embedding, merged namespace search, lanes, dedupe, and the six
 * named injection blocks under the global char cap. Host-neutral; everything
 * it needs arrives in the context object.
 */

/**
 * @param {object} ctx Engine context; see the destructuring below.
 * @returns {(event: object, hookCtx: object) => Promise<{prependContext: string}|undefined>} Handler.
 */
export function createPromptContextAssembler(ctx) {
  const {
    /* the exact 62 REGISTER-SCOPE names from /tmp/recall-deps.txt, minus `api`,
       plus `host` and the Step 2 PASS-IN names, one per line, alphabetically */
  } = ctx;

  return async function assemblePromptContext(event, hookCtx) {
    /* index.js:12286-13350 verbatim, with:
       - `ctx`        -> `hookCtx`   (the hook's second parameter)
       - `api.logger` -> `host.logger`  (already done by Task 7)
       No other edit. In particular the return at index.js:13315-13325 keeps
       its six blocks, their order, their droppable flags and the
       `cfg.recall?.globalInjectMaxChars ?? 17_000` default. */
  };
}
```

Rename discipline: the hook's second parameter is called `ctx` throughout the 1 067 moved lines and the registration context is now also called `ctx`. Rename the *parameter* to `hookCtx` and apply it to the whole moved body in one pass:

```bash
# inside the moved body only — never run this over index.js
cd "$PLUR1BUS" && perl -pi -e 's/\bctx\?\./hookCtx?./g; s/\bctx\./hookCtx./g; s/\bctx\b(?=\s*[,)\]}])/hookCtx/g' engine/recall/assemble-prompt-context.js
```

then re-add the destructuring line (`const { … } = ctx;`) if the pass rewrote it, and read the diff before moving on.

- [ ] **Step 6: Create the adapter module**

Create `adapter/openclaw/register-recall-hook.js`:

```js
/**
 * adapter/openclaw/register-recall-hook.js
 *
 * Registers the recall assembly on before_prompt_build with the plugin's own
 * envelope: recallTimeoutMs + 5 000 ms (index.js:13351,
 * lib/runtime-scheduler.js:7). The harness passes a real AbortSignal and a
 * much tighter budget instead; that is PR-05, not this task.
 */

import { createPromptContextAssembler } from "../../engine/recall/assemble-prompt-context.js";

/**
 * @param {object} ctx Registration context: the engine context plus `api`.
 * @returns {void}
 */
export function registerRecallHook(ctx) {
  const handler = createPromptContextAssembler(ctx);
  ctx.api.on("before_prompt_build", handler, {
    timeoutMs: ctx.runtimeScheduler.config.recallTimeoutMs + 5_000,
  });
}
```

- [ ] **Step 7: Replace the block in `index.js`**

Add the import, then replace `index.js:12285-13351` with a single call whose object literal lists every context key in the same order as the destructuring in Step 5:

```js
      registerRecallHook({
        api,
        host,
        /* … the 61 remaining REGISTER-SCOPE keys and the Step 2 PASS-IN keys,
           each as a shorthand property … */
      });
```

- [ ] **Step 8: Syntax check and the boundary test**

```bash
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --check index.js
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --check engine/recall/assemble-prompt-context.js
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/engine-assemble-prompt-context.test.js 2>&1 | tail -8
cd "$PLUR1BUS" && /home/claude/.node24/bin/node scripts/lint-engine-imports.mjs
```

Expected: both checks silent; `tests 4`, `pass 4`; `lint-engine-imports: clean (5 module(s))`.

- [ ] **Step 9: The golden corpus is the real gate**

```bash
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/golden-prefix.test.js 2>&1 | tail -20
```

Expected: `pass 7`, `fail 0`. **A byte difference here means a binding resolved differently after the move — most often a name you imported that was actually a `register`-scope value, so the module got the module-level one.** Diff the two strings the failure prints, find the block that changed, and look up which of its inputs came from the wrong scope. Do not touch the oracle.

- [ ] **Step 10: Lint and full suite**

```bash
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm run lint
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm test 2>&1 | tail -20
```

Expected: lint 0; suite at the accepted baseline.

- [ ] **Step 11: Commit**

```bash
cd "$PLUR1BUS"
git add engine/recall/assemble-prompt-context.js adapter/openclaw/register-recall-hook.js index.js tests/engine-assemble-prompt-context.test.js
git commit -m "refactor(engine): extract the recall assembly from index.js

PR-03d. 1067 lines behind createPromptContextAssembler(ctx); the OpenClaw
registration and its recallTimeoutMs+5000 envelope stay in the adapter. The
six named blocks, their order, their droppability and the 17000-char cap are
unchanged, which the golden corpus asserts byte for byte."
```

---

### Task 14 (PR-03e): move auto-capture into `engine/capture/`

946 lines, 51 module-scope imports, 52 context keys — **and the one mutable-state hazard in the whole split**.

**Files:**
- Modify: `index.js:5049-5050` and `:10852-10853` (the meta-reflection counters) — *first*, as its own commit
- Create: `engine/capture/capture-turn.js`
- Create: `adapter/openclaw/register-capture-hook.js`
- Modify: `index.js:10354-11299`
- Create: `tests/engine-capture-turn.test.js`

**Interfaces:**
- Consumes: `host` (Task 7).
- Produces:
  - `createTurnCapture(ctx) -> async (event, hookCtx) => Promise<unknown>`
  - `registerCaptureHook(ctx) -> void`, performing `ctx.api.on("agent_end", handler, { timeoutMs: 60_000 })`

**The hazard.** `sessionCountSinceReflection` and `lastReflectionAt` are `let` bindings declared at `index.js:5049-5050`, seeded at `:5055-5056`, and **reassigned inside the capture body at `:10852-10853`, i.e. at turn time**. Passing them into a module by value would silently freeze meta-reflection: the module would read the value captured at registration and its writes would go nowhere. Convert them into one shared object before moving anything.

- [ ] **Step 1: Convert the counters to shared mutable state**

Replace `index.js:5049-5050`:

```js
    let sessionCountSinceReflection = 0;
    let lastReflectionAt = 0;
```

with:

```js
    // Shared mutable state: the capture hook rebinds these at turn time
    // (index.js:10852-10853), so they must survive being passed into a module.
    const metaReflectionState = { sessionCount: 0, lastAt: 0 };
```

Then update every read and write. Find them all:

```bash
cd "$PLUR1BUS" && grep -n "sessionCountSinceReflection\|lastReflectionAt" index.js
```

At `89148f9` there are six sites: the two declarations (`:5049-5050`), the two seeds (`:5055-5056`), and the two turn-time writes (`:10852-10853`), plus the reads in the capture body that the grep will show. Rewrite mechanically:

```bash
cd "$PLUR1BUS"
perl -pi -e 's/\bsessionCountSinceReflection\b/metaReflectionState.sessionCount/g; s/\blastReflectionAt\b/metaReflectionState.lastAt/g' index.js
grep -n "metaReflectionState" index.js
```

Then fix the two seed lines by hand, since `metaState.sessionCountSinceReflection` and `metaState.lastReflectionAt` are *properties of the persisted state file* and must keep their names — the rewrite above will have renamed them too:

```js
        metaReflectionState.sessionCount = metaState.sessionCountSinceReflection || 0;
        metaReflectionState.lastAt = metaState.lastReflectionAt || 0;
```

Check for any other property of the same name that the blanket rewrite damaged:

```bash
cd "$PLUR1BUS" && grep -n "metaReflectionState\.\(sessionCount\|lastAt\)" index.js
cd "$PLUR1BUS" && grep -rn "sessionCountSinceReflection\|lastReflectionAt" index.js lib/ tests/ | grep -v "metaState\."
```

The second command must show only writes into the persisted JSON object, never a bare identifier.

- [ ] **Step 2: Verify and commit the state conversion on its own**

```bash
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --check index.js
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/meta-cognition.test.js test/meta-cognition.test.js 2>&1 | tail -8
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm test 2>&1 | tail -20
cd "$PLUR1BUS" && git add index.js && git commit -m "refactor(engine): hold the meta-reflection counters in one shared object

Prepares PR-03e: the capture hook rebinds these at turn time, so they cannot
be passed into a module by value."
```

Expected: suite at the accepted baseline before you go on. If meta-cognition tests fail here, the blanket rewrite hit a persisted-state property — fix that before moving code.

- [ ] **Step 3: Derive the dependency lists**

```bash
cd "$PLUR1BUS" && grep -n 'api.on("agent_end"' index.js
cd "$PLUR1BUS" && /home/claude/.node24/bin/node tools/free-identifiers.mjs index.js 10354 11299 > /tmp/capture-deps.txt
cd "$PLUR1BUS" && cat /tmp/capture-deps.txt
```

Expected: `MODULE-SCOPE … 51`; `REGISTER-SCOPE … 52` — now containing `metaReflectionState` in place of `sessionCountSinceReflection` and `lastReflectionAt`, so the count is 51 if you compare against the table; either way the two old names must be gone. Sort the 51 module-scope names into `IMPORT` and `PASS-IN` with the same loop as Task 13 Step 2.

- [ ] **Step 4: Write the failing test**

Create `tests/engine-capture-turn.test.js`:

```js
/**
 * tests/engine-capture-turn.test.js — PR-03e.
 *
 * Capture's fail-closed incognito classification and its shared
 * meta-reflection state are the two things a move can quietly break.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createTurnCapture } from "../engine/capture/capture-turn.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("engine/capture/capture-turn", () => {
  it("exports a factory", () => {
    assert.equal(typeof createTurnCapture, "function");
  });

  it("does not mention the OpenClaw api surface", () => {
    const source = readFileSync(join(root, "engine", "capture", "capture-turn.js"), "utf8");
    assert.doesNotMatch(source, /(?<![.\w$/-])api\s*\./);
  });

  it("reads and writes the meta-reflection counters through the shared object", () => {
    const source = readFileSync(join(root, "engine", "capture", "capture-turn.js"), "utf8");
    assert.match(source, /metaReflectionState\.sessionCount/);
    assert.match(source, /metaReflectionState\.lastAt/);
    assert.doesNotMatch(source, /\blet\s+sessionCountSinceReflection\b/);
  });

  it("keeps the fail-closed incognito classification first", () => {
    const source = readFileSync(join(root, "engine", "capture", "capture-turn.js"), "utf8");
    const body = source.slice(source.indexOf("return async function"));
    const incognitoAt = body.indexOf("classifyHostIncognitoSession");
    const poolAt = body.indexOf("pool.");
    assert.ok(incognitoAt >= 0, "incognito classification must survive the move");
    assert.ok(poolAt === -1 || incognitoAt < poolAt, "classification must run before any store access");
  });
});
```

- [ ] **Step 5: Run it and watch it fail; then create the two modules**

```bash
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/engine-capture-turn.test.js 2>&1 | tail -5
```

Create `engine/capture/capture-turn.js` exporting `createTurnCapture(ctx)` around `index.js:10355-11298` verbatim (`ctx` parameter renamed to `hookCtx` exactly as in Task 13 Step 5), and `adapter/openclaw/register-capture-hook.js`:

```js
/**
 * adapter/openclaw/register-capture-hook.js
 *
 * Registers auto-capture on agent_end with the plugin's 60 000 ms envelope
 * (index.js:11299). The work itself is queued inside runtimeScheduler with its
 * own AbortSignal; the harness awaits a CaptureHandle instead (ADR-002).
 */

import { createTurnCapture } from "../../engine/capture/capture-turn.js";

/**
 * @param {object} ctx Registration context: the engine context plus `api`.
 * @returns {void}
 */
export function registerCaptureHook(ctx) {
  const handler = createTurnCapture(ctx);
  ctx.api.on("agent_end", handler, { timeoutMs: 60_000 });
}
```

Replace `index.js:10354-11299` with `registerCaptureHook({ api, host, /* the context keys */ });`.

**Leave the other two `agent_end` registrations alone**: reply-outcome recording at `index.js:11304-11321` and the turn-route cleanup (already moved in Task 11). Registration order across the three matters and must not change.

- [ ] **Step 6: Verify**

```bash
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --check index.js && /home/claude/.node24/bin/node --check engine/capture/capture-turn.js
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/engine-capture-turn.test.js 2>&1 | tail -8
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 \
  tests/auto-capture-batch.test.js tests/auto-capture-checkpoint.test.js \
  tests/background-capture-skip.test.js tests/capture-chunking.test.js 2>&1 | tail -8
cd "$PLUR1BUS" && /home/claude/.node24/bin/node scripts/lint-engine-imports.mjs
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/golden-prefix.test.js
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm run lint
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm test 2>&1 | tail -20
```

Expected: `tests 4, pass 4` for the new file; the capture tests pass; `lint-engine-imports: clean (7 module(s))`; golden `pass 7 / fail 0`; lint 0; suite at the accepted baseline.

- [ ] **Step 7: Commit**

```bash
cd "$PLUR1BUS"
git add engine/capture/capture-turn.js adapter/openclaw/register-capture-hook.js index.js tests/engine-capture-turn.test.js
git commit -m "refactor(engine): extract auto-capture from index.js

PR-03e. The fail-closed incognito classification stays the first thing the
handler does, and the meta-reflection counters now live in the shared object
introduced in the previous commit."
```

---

### Task 15 (PR-03f): move `runPlur1busCommand` and the 17 internal job runners into `engine/commands/`

1 790 lines, 96 module-scope imports, 82 context keys — the biggest single move. It carries the whole `/plur1bus internal <job>` surface (`index.js:7498-8272`), which PR-07 later turns into `JobRegistry.run()`. Moving it now is what makes PR-07 a rewrite of one module instead of a second dig through `index.js`.

**Files:**
- Create: `engine/commands/plur1bus-command.js`
- Modify: `index.js:7255-9044`
- Create: `tests/engine-plur1bus-command.test.js`

**Interfaces:**
- Consumes: `host` (Task 7).
- Produces: `createPlur1busCommandRunner(ctx) -> async (commandCtx, prefixTokens = []) => CommandResult`. `index.js` keeps the binding name: `const runPlur1busCommand = createPlur1busCommandRunner({ … });` **at line 7255**, so the three later references (`:9087`, `:9122`, and `runOperatorCommand` at `:9046-9082`) resolve exactly as before.

**Do not move the deny-by-classification tables.** `SENSITIVE_READ_ACTIONS`, `isSensitiveChatRead`, `isDestructiveAction` and `knownPlur1busActions` (`index.js:7215-7250`) sit just above the range and are *engine* policy by `engine-extraction.md` §a.2 — but they are also read by the command registration block (Task 16). Pass them in as context keys for both, and leave the declarations where they are until PR-04. Same for `callCommandLlm` (`:7251-7254`).

- [ ] **Step 1: Derive the dependency lists**

```bash
cd "$PLUR1BUS" && grep -n "const runPlur1busCommand = async" index.js
cd "$PLUR1BUS" && /home/claude/.node24/bin/node tools/free-identifiers.mjs index.js 7255 9044 > /tmp/command-deps.txt
cd "$PLUR1BUS" && cat /tmp/command-deps.txt
```

Expected: the declaration at `7255`; `MODULE-SCOPE … 96`; `REGISTER-SCOPE … 82`. Sort the 96 with the Task 13 Step 2 loop. Expect a large `PASS-IN` set here: `formatJsonCommandResult`, `checkArgsLength`, `checkAuth`, `parsePlur1busArgs`, `plur1busHelp`, `resolveCommandLocale`, `resolveDenialLocale`, `resolveRegisteredMemoryContext`, `resolveCronMemoryContext`, `isCronCommandContext`, `obsidianActionNames`, `runMemoryCommand`, `runForgetCommand`, `runCorrectCommand`, `runCriticalCommand`, `runStatusCommand`, `runFeatureToggle`, `applyEpistemicStatusToLanceDb`, `rememberPendingConfirmation`, `completePendingConfirmation`, `resolveConfirmationIdentity`, `selectSemanticDiscoveryWorkspaces`, `__pluginDir`, `dbg` and the rest the loop prints. Four of those are public exports of `index.js` and must be **passed, not imported**.

**Ordering trap.** `runMemoryCommand`, `runForgetCommand`, `runCorrectCommand`, `runCriticalCommand`, `runStatusCommand` and `runFeatureToggle` are declared *after* line 7255 (they live in the `9083-10268` region). `runPlur1busCommand` only calls them at command time, so today's TDZ is satisfied. If you put them in an object literal evaluated at line 7255 you will get `ReferenceError: Cannot access '…' before initialization` at registration. **Pass them as thunks:**

```js
        runMemoryCommand: (...args) => runMemoryCommand(...args),
```

and destructure them like any other key. Confirm which names need this before writing the literal:

```bash
cd "$PLUR1BUS" && for n in $(sed -n '5p' /tmp/command-deps.txt); do
  d=$(grep -n "^\s*\(const\|let\|function\|async function\)\s\+$n\b" index.js | head -1 | cut -d: -f1)
  if [ -n "$d" ] && [ "$d" -gt 7255 ]; then echo "THUNK $n (declared at :$d, after the call site)"; fi
done
```

- [ ] **Step 2: Write the failing test**

Create `tests/engine-plur1bus-command.test.js`:

```js
/**
 * tests/engine-plur1bus-command.test.js — PR-03f.
 *
 * The command runner is the deny-by-classification chokepoint and the home of
 * the 17 internal job runners. This pins the boundary; behaviour is covered by
 * the existing command tests.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createPlur1busCommandRunner } from "../engine/commands/plur1bus-command.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(root, "engine", "commands", "plur1bus-command.js"), "utf8");

const INTERNAL_JOBS = [
  "consolidate-daily", "classify-recent", "auto-accept-stale", "rem-dream",
  "skill-miner", "skill-benefit-backfill", "afterthought", "persona-evolve",
  "reminder-dispatch", "discover-semantic-links", "gc-run", "embedding-drain",
  "emotion-refine", "feedback-report", "proactive-check", "meta-reflect",
  "episodes-rebuild",
];

describe("engine/commands/plur1bus-command", () => {
  it("exports a factory", () => {
    assert.equal(typeof createPlur1busCommandRunner, "function");
  });

  it("does not mention the OpenClaw api surface", () => {
    assert.doesNotMatch(source, /(?<![.\w$/-])api\s*\./);
  });

  it("still handles all 17 internal job names", () => {
    for (const job of INTERNAL_JOBS) {
      assert.match(source, new RegExp(`"${job}"`), `internal job ${job} must survive the move`);
    }
  });

  it("checks authorization before dispatching an action", () => {
    const body = source.slice(source.indexOf("return async function"));
    const authAt = body.indexOf("checkAuth");
    const dispatchAt = body.indexOf('actionKey === "internal"');
    assert.ok(authAt >= 0 && dispatchAt >= 0);
    assert.ok(authAt < dispatchAt, "deny-by-classification must run before any internal dispatch");
  });
});
```

- [ ] **Step 3: Run it, watch it fail, then move the code**

```bash
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/engine-plur1bus-command.test.js 2>&1 | tail -5
```

Create `engine/commands/plur1bus-command.js`:

```js
/**
 * engine/commands/plur1bus-command.js
 *
 * The /plur1bus chat command (was index.js:7255-9044), including the 17
 * internal job runners at index.js:7498-8272 that PR-07 turns into
 * JobRegistry.run(). Host-neutral: every dependency arrives in the context
 * object, and the OpenClaw registration stays in the adapter.
 */

/* the IMPORT names from Step 1, each rewritten from "./lib/…" to "../../lib/…" */

/**
 * @param {object} ctx Engine context.
 * @returns {(commandCtx: object, prefixTokens?: string[]) => Promise<object>} Runner.
 */
export function createPlur1busCommandRunner(ctx) {
  const {
    /* the 82 REGISTER-SCOPE names minus `api`, plus `host` and the PASS-IN names */
  } = ctx;

  return async function runPlur1busCommand(commandCtx, prefixTokens = []) {
    /* index.js:7256-9043 verbatim; `api.logger` is already `host.logger` */
  };
}
```

In `index.js`, replace lines `7255-9044` with, at the same position:

```js
        const runPlur1busCommand = createPlur1busCommandRunner({
          host,
          /* every context key, with the THUNK names from Step 1 written as
             `name: (...args) => name(...args),` */
        });
```

and add `import { createPlur1busCommandRunner } from "./engine/commands/plur1bus-command.js";` to the import block.

- [ ] **Step 4: Verify**

```bash
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --check index.js && /home/claude/.node24/bin/node --check engine/commands/plur1bus-command.js
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/engine-plur1bus-command.test.js 2>&1 | tail -8
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 \
  tests/command-reachability.test.js tests/plur1bus-internal-auth.test.js \
  tests/b14-command-policy.test.js tests/feature-toggle.test.js \
  tests/emotion-refine-cron.test.js tests/classifier-cron-partial-failure.test.js 2>&1 | tail -10
cd "$PLUR1BUS" && /home/claude/.node24/bin/node scripts/lint-engine-imports.mjs
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/golden-prefix.test.js
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm run lint
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm test 2>&1 | tail -20
```

Expected: `tests 4, pass 4` for the new file; the command tests pass — `tests/command-reachability.test.js` and `tests/plur1bus-internal-auth.test.js` are the ones that catch a lost action or a lost auth check; `lint-engine-imports: clean (8 module(s))`; golden `pass 7 / fail 0`; lint 0; suite at the accepted baseline.

If you see `ReferenceError: Cannot access 'runMemoryCommand' before initialization`, the Step 1 thunk list was incomplete — wrap the named function and re-run.

- [ ] **Step 5: Commit**

```bash
cd "$PLUR1BUS"
git add engine/commands/plur1bus-command.js index.js tests/engine-plur1bus-command.test.js
git commit -m "refactor(engine): extract runPlur1busCommand and the internal job runners

PR-03f. 1790 lines, including the 17 /plur1bus internal <job> runners PR-07
turns into JobRegistry.run(). Commands declared later in register() are passed
as thunks so the factory call at the original position stays TDZ-safe."
```

---

### Task 16 (PR-03g): move the chat-command registration into `adapter/openclaw/`

1 186 lines, 88 module-scope imports, 42 context keys. This is registration plus the six user-facing command bodies (`runStatusCommand`, `runFeatureToggle`, `runMemoryCommand`, `runForgetCommand`, `runCorrectCommand`, `runCriticalCommand`), which `engine-extraction.md` §c PR-03 lists as "command handlers … become engine modules". Splitting registration from bodies here would need a second dependency pass and does not fit an hour; **keep them together in the adapter module for M1a** and note it for PR-04, which is where `Engine.commands`/`Engine.runCommand` appear. The `adapter/**` placement keeps the `api.` lint satisfied without weakening the engine rule.

**Files:**
- Create: `adapter/openclaw/register-commands.js`
- Modify: `index.js:9083-10268`
- Create: `tests/adapter-register-commands.test.js`

**Interfaces:**
- Consumes: `host` (Task 7); `runPlur1busCommand` and `runOperatorCommand` from the enclosing scope (Task 15).
- Produces: `registerChatCommands(ctx) -> { runMemoryCommand, runForgetCommand, runCorrectCommand, runCriticalCommand, runStatusCommand, runFeatureToggle }`. The return value is what makes Task 15's thunks resolve: `index.js` assigns it to the same-named bindings.

**The binding dance.** Today `runPlur1busCommand` (line 7255) calls `runMemoryCommand` (declared ~line 9500) and the command registration (line 9091-9122) calls `runPlur1busCommand`. After Tasks 15 and 16 the cycle is broken by a `let` declared before both:

```js
        // declared once, above the createPlur1busCommandRunner call at :7255
        let runMemoryCommand, runForgetCommand, runCorrectCommand,
            runCriticalCommand, runStatusCommand, runFeatureToggle;
```

Task 15's thunks (`(...args) => runMemoryCommand(...args)`) read them at command time. Task 16's call assigns them:

```js
        ({ runMemoryCommand, runForgetCommand, runCorrectCommand,
           runCriticalCommand, runStatusCommand, runFeatureToggle } = registerChatCommands({ api, host, /* … */ }));
```

- [ ] **Step 1: Derive the dependency lists and confirm the range**

```bash
cd "$PLUR1BUS" && grep -n "const plur1busCommands = \[" index.js
cd "$PLUR1BUS" && /home/claude/.node24/bin/node tools/free-identifiers.mjs index.js 9083 10268 > /tmp/cmdreg-deps.txt
cd "$PLUR1BUS" && cat /tmp/cmdreg-deps.txt
```

Expected: `MODULE-SCOPE … 88`; `REGISTER-SCOPE … 42`, including `registerPluginCommand`, `runPlur1busCommand`, `runOperatorCommand`, `emitCommandRuntimeHook`, `isSensitiveChatRead`, `workspacePolicyGuard`, `pool`, `cfg`, `embeddings`, `reranker`. Sort the 88 with the Task 13 Step 2 loop.

- [ ] **Step 2: Write the failing test**

Create `tests/adapter-register-commands.test.js`:

```js
/**
 * tests/adapter-register-commands.test.js — PR-03g.
 *
 * The registered command set and its channel list are a published contract
 * (openclaw.plugin.json cliCommands, docs/compatibility-openclaw.md). This
 * pins the 15 plur1bus_* commands and the three top-level ones.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { registerChatCommands } from "../adapter/openclaw/register-commands.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(root, "adapter", "openclaw", "register-commands.js"), "utf8");

const PLUR1BUS_COMMANDS = [
  "plur1bus", "plur1bus_start", "plur1bus_temperament", "plur1bus_persona",
  "plur1bus_status", "plur1bus_doctor", "plur1bus_state", "plur1bus_enable",
  "plur1bus_disable", "plur1bus_memory", "plur1bus_forget", "plur1bus_correct",
  "plur1bus_critical", "plur1bus_dashboards", "plur1bus_conflicts",
];

describe("adapter/openclaw/register-commands", () => {
  it("exports a factory", () => {
    assert.equal(typeof registerChatCommands, "function");
  });

  it("registers every plur1bus_* command name", () => {
    for (const name of PLUR1BUS_COMMANDS) {
      assert.match(source, new RegExp(`name: "${name}"`), `${name} must survive the move`);
    }
  });

  it("keeps /state, /enable and /disable, and never registers /status", () => {
    assert.match(source, /name: "state"/);
    assert.match(source, /name: "enable"/);
    assert.match(source, /name: "disable"/);
    assert.doesNotMatch(source, /name: "status"/, "/status is reserved by OpenClaw (index.js:9226)");
  });

  it("returns the six command bodies the runner calls back into", () => {
    assert.match(source, /return \{[\s\S]*runMemoryCommand[\s\S]*runForgetCommand[\s\S]*runCorrectCommand[\s\S]*runCriticalCommand[\s\S]*runStatusCommand[\s\S]*runFeatureToggle[\s\S]*\}/);
  });
});
```

- [ ] **Step 3: Run it, watch it fail, then move the code**

```bash
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/adapter-register-commands.test.js 2>&1 | tail -5
```

Create `adapter/openclaw/register-commands.js` with `registerChatCommands(ctx)` wrapping `index.js:9084-10267` verbatim and ending with the `return { … }` of the six bodies. In `index.js`, add the `let` declaration above line 7255, replace `9083-10268` with the destructuring assignment shown above, and add the import.

- [ ] **Step 4: Verify**

```bash
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --check index.js && /home/claude/.node24/bin/node --check adapter/openclaw/register-commands.js
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/adapter-register-commands.test.js 2>&1 | tail -8
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 \
  tests/command-reachability.test.js tests/memory-edit.test.js test/memory-edit.test.js \
  tests/smoke-wiki-command.test.js tests/b14-command-policy.test.js 2>&1 | tail -10
cd "$PLUR1BUS" && /home/claude/.node24/bin/node scripts/lint-engine-imports.mjs
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/golden-prefix.test.js
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm run lint
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm test 2>&1 | tail -20
```

Expected: `tests 4, pass 4`; the command tests pass; `lint-engine-imports: clean (9 module(s))`; golden `pass 7 / fail 0`; lint 0; suite at the accepted baseline.

- [ ] **Step 5: Commit**

```bash
cd "$PLUR1BUS"
git add adapter/openclaw/register-commands.js index.js tests/adapter-register-commands.test.js
git commit -m "refactor(adapter): move chat-command registration out of index.js

PR-03g. The six command bodies travel with their registration for now; PR-04
splits them behind Engine.commands/runCommand. The mutual reference with
runPlur1busCommand is broken by a let declared before both."
```

---

### Task 17 (PR-03h): move the tool factory and the prompt supplements

843 + 38 lines. Finishes the shell: after this, `index.js` is construction and registration calls, and every turn-path body lives in `engine/**` or `adapter/**`.

**Files:**
- Create: `engine/tools/memory-tools.js`
- Create: `adapter/openclaw/register-tools.js`
- Create: `adapter/openclaw/register-prompt-supplements.js`
- Modify: `index.js:7073-7110` and `index.js:11328-12170`
- Create: `tests/engine-memory-tools.test.js`

**Interfaces:**
- Consumes: `host` (Task 7).
- Produces:
  - `createMemoryTools(ctx) -> (toolCtx) => ToolDefinition[]` — the factory `api.registerTool` is given
  - `registerMemoryTools(ctx) -> void`
  - `registerPromptSupplements(ctx) -> void`

**Counts** (`tools/free-identifiers.mjs`): `11328-12170` → 71 module-scope, 55 register-scope. `7073-7110` → 4 module-scope, 10 register-scope (`api embeddings getNeoStore neoCfg neoEnabled neoRequester neoRoot neoWorkspaceAliases runNeoGlobalSearch sessionWorkspaceKeys`).

**Keep the capability guards.** `index.js:7073`, `:7081` and `:7090` all test `typeof api.registerMemoryPromptSupplement === "function"` / `api.registerMemoryCorpusSupplement`. Those guards exist because an older host lacks the method; they move into `adapter/openclaw/register-prompt-supplements.js` unchanged. The same applies to `api.registerTool` — `index.js:11328` calls it unguarded today, so keep it unguarded.

- [ ] **Step 1: Derive the dependency lists**

```bash
cd "$PLUR1BUS" && grep -n "api.registerTool((ctx) =>" index.js
cd "$PLUR1BUS" && /home/claude/.node24/bin/node tools/free-identifiers.mjs index.js 11328 12170
cd "$PLUR1BUS" && /home/claude/.node24/bin/node tools/free-identifiers.mjs index.js 7073 7110
```

Expected: the tool factory at `11328`; the two count pairs above. Sort each module-scope list with the Task 13 Step 2 loop.

- [ ] **Step 2: Write the failing test**

Create `tests/engine-memory-tools.test.js`:

```js
/**
 * tests/engine-memory-tools.test.js — PR-03h.
 *
 * The five model-facing tools are a published contract
 * (openclaw.plugin.json contracts.tools), and the destructive-op gate is a
 * security boundary: a model-facing call carries no user-bound authorization.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createMemoryTools } from "../engine/tools/memory-tools.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(root, "engine", "tools", "memory-tools.js"), "utf8");

describe("engine/tools/memory-tools", () => {
  it("exports a factory", () => {
    assert.equal(typeof createMemoryTools, "function");
  });

  it("does not mention the OpenClaw api surface", () => {
    assert.doesNotMatch(source, /(?<![.\w$/-])api\s*\./);
  });

  it("keeps all five model-facing tool names", () => {
    for (const name of ["memory_recall", "memory_search", "memory_store", "memory_forget", "knowledge_update"]) {
      assert.match(source, new RegExp(`"${name}"`), `${name} must survive the move`);
    }
  });

  it("keeps the destructive-op gate and its default", () => {
    assert.match(source, /allowModelDestructiveMemoryOps !== false/);
    assert.match(source, /do not carry a user-bound authorization context/);
  });
});
```

- [ ] **Step 3: Run it, watch it fail, then move the code**

Create `engine/tools/memory-tools.js` exporting `createMemoryTools(ctx)` whose return value is the arrow function `index.js:11328` passes to `api.registerTool` (body `11329-12169` verbatim; the arrow's parameter is already called `ctx` — rename it `toolCtx`). Then:

```js
/**
 * adapter/openclaw/register-tools.js
 *
 * Hands the engine's tool factory to OpenClaw. `api.registerTool` is called
 * unguarded, exactly as index.js:11328 did.
 */

import { createMemoryTools } from "../../engine/tools/memory-tools.js";

/**
 * @param {object} ctx Registration context: the engine context plus `api`.
 * @returns {void}
 */
export function registerMemoryTools(ctx) {
  ctx.api.registerTool(createMemoryTools(ctx));
}
```

```js
/**
 * adapter/openclaw/register-prompt-supplements.js
 *
 * The static system-prompt supplement (index.js:7073-7088) and the Neo corpus
 * supplement (:7090-7110). The supplement returns constants, which is what
 * makes the system prompt stable per turn and therefore cacheable (ADR-010).
 * The `typeof api.registerX === "function"` guards are kept: an older host
 * does not have these methods.
 */
```

with `registerPromptSupplements(ctx)` containing `index.js:7073-7110` verbatim, and replace both ranges in `index.js` with the two calls, each at its original position.

- [ ] **Step 4: Verify**

```bash
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --check index.js && /home/claude/.node24/bin/node --check engine/tools/memory-tools.js
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/engine-memory-tools.test.js 2>&1 | tail -8
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 \
  tests/tool-registration-metadata.test.js tests/model-tool-auth.test.js \
  tests/multi-namespace-recall-runtime.test.js tests/memory-store-decision-trace.test.js 2>&1 | tail -10
cd "$PLUR1BUS" && /home/claude/.node24/bin/node scripts/lint-engine-imports.mjs
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/golden-prefix.test.js
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm run lint
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm test 2>&1 | tail -20
```

Expected: `tests 4, pass 4`; the tool tests pass — `tests/tool-registration-metadata.test.js` is the contract check for the five tool names and `tests/model-tool-auth.test.js` for the destructive gate; `lint-engine-imports: clean (12 module(s))`; golden `pass 7 / fail 0`; lint 0; suite at the accepted baseline.

- [ ] **Step 5: Record the shrinkage**

```bash
cd "$PLUR1BUS" && wc -l index.js
```

Expected: roughly 6 400 lines, down from 13 496 — about 7 100 lines now live under `engine/` and `adapter/`.

- [ ] **Step 6: Commit**

```bash
cd "$PLUR1BUS"
git add engine/tools adapter/openclaw/register-tools.js adapter/openclaw/register-prompt-supplements.js index.js tests/engine-memory-tools.test.js
git commit -m "refactor(engine): extract the tool factory and the prompt supplements

PR-03h. index.js is now construction plus registration calls; every turn-path
body lives under engine/ or adapter/openclaw/."
```

---

### Task 18 (PR-03i): group the remaining registrations, and record what stays

Finishes the adapter shell with the two clean groups the extraction plan names — `register-gateway.js` and `register-cron.js` — and writes down, with reasons, every registration M1a deliberately leaves in `index.js`. An undocumented leftover is how a boundary quietly stops being a boundary.

**Files:**
- Create: `adapter/openclaw/register-gateway.js`
- Create: `adapter/openclaw/register-cron.js`
- Modify: `index.js` — four gateway ranges and two cron ranges
- Create: `adapter/openclaw/README.md`
- Create: `tests/adapter-register-gateway.test.js`

**Interfaces:**
- Consumes: `host` (Task 7).
- Produces:
  - `registerGatewayLifecycle(ctx) -> void` — the three `gateway_start`/`gateway_stop` pairs
  - `registerGatewayShutdownServices(ctx) -> void` — the shutdown + four `…AfterLifecycle` registrations at the tail of `register()`
  - `registerFeatureCronHooks(ctx) -> void` — the unsafe-cron guard and the deferred bootstrap

**The ranges and their measured dependencies** (`tools/free-identifiers.mjs` at `89148f9`):

| Range | What | module-scope | register-scope |
|---|---|---|---|
| `5296-5307` | Neo worker warm-up on `gateway_start` (20 000 ms delay, 5 000 ms budget) | 0 | 2 |
| `7024-7033` | Obsidian bridge: `api.registerService` when available, else the `gateway_start`/`gateway_stop` pair | 0 | 3 |
| `10325-10345` | Neo service start/stop, with the `api.registerService` fallback | 0 | 4 |
| `13454-13491` | `registerGatewayShutdown` + the four `…AfterLifecycle` service registrations | 5 | 16 |
| `4530-4545` | the unsafe direct feature-cron guard, registered only when `!cronDirectDispatchReady` | 4 | 3 |
| `7035-7071` | the deferred feature-cron bootstrap on `gateway_start` | 3 | 4 |

**What stays in `index.js` for M1a, and why.** Write this list into `adapter/openclaw/README.md` (Step 5) so the next PR does not have to re-derive it:

| Site | Why it stays |
|---|---|
| `export default plugin` and the `plugin` object (`index.js:4388-13492`) | `openclaw.plugin.json` declares `extensions: ["./index.js"]` and `package.json:main` is `./index.js`; 46 test files import the default and the 19 named exports from there. Moving the factory is PR-14's job, together with the package rename. |
| `api.registerMemoryCapability` (`:4446-4529`) | It builds `createMemoryHostRuntime` from closures over values created much later in `register()`; splitting it needs the PR-04 `Engine` object to close over instead. |
| control-UI registration and the control-health pair (`:9476-9592`) | Both sit inside one `if (typeof api.registerGatewayMethod === "function")` block that also builds the projection callback; PR-13 extracts the whole control UI into its own package and is the right place. |
| `registerWorkspacePolicyRuntime`, `registerObsidianVaultRuntime`, `registerReembeddingRuntime`, `registerFeatureCronNativeDispatch` (`:9083-9090`, `:9341`, `:9476`) | Already one-line delegations into `lib/setup/*-plugin-runtime.js`; wrapping a one-line call in another module buys nothing. |
| the critical-push claiming hooks (`:10068-10111`) | A claiming hook short-circuits the whole turn and has no host timeout; `engine-extraction.md` §a.1 maps it to a new `Host.registerTurnInterceptor`, which is a harness feature, not a move. |
| reply-outcome completion and recording (`:12216-12251`, `:11304-11321`) | `engine-extraction.md` §a.1 folds both into `Engine.capture`'s close-out; that is PR-04, not a relocation. |
| `skill_proposal_changed` (`:5939-5956`) | Optional host capability; it becomes `Host.onSkillProposalChanged` in PR-04. |

- [ ] **Step 1: Confirm the six ranges**

```bash
cd "$PLUR1BUS" && grep -n 'api.on("gateway_start"\|api.on("gateway_stop"\|registerGatewayShutdown(\|guardUnsafeDirectCronTurn\|shouldRunCronBootstrap' index.js
cd "$PLUR1BUS" && for r in "5296 5307" "7024 7033" "10325 10345" "13454 13491" "4530 4545" "7035 7071"; do
  set -- $r; /home/claude/.node24/bin/node tools/free-identifiers.mjs index.js $1 $2; echo;
done
```

Expected: the counts in the table above. `13454-13491` must list `api clearInitializedTurnRoutes coordinatesLocalModelGeneration embeddings gatewayShutdownRegistered legacyMigrationShutdown llmResultCache localModelGeneration memoryDbAdapter modelPreparationCoordinator pool reembeddingCoordinator reembeddingSwitchRecovery reranker scopedEmbeddingServer sharedMemoryPool`. `gatewayShutdownRegistered` is *assigned* inside that range, so it does not go in the context object — it stays a local of the new function.

- [ ] **Step 2: Write the failing test**

Create `tests/adapter-register-gateway.test.js`:

```js
/**
 * tests/adapter-register-gateway.test.js — PR-03i.
 *
 * The gateway_stop budget is the one that loses LanceDB writes when it is
 * wrong: the host default for gateway_stop is 5 000 ms and the plugin
 * deliberately overrides it to 30 000 ms (lib/runtime-shutdown.js:308,
 * host-contract §a.1). A move must not drop that override.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { registerGatewayLifecycle } from "../adapter/openclaw/register-gateway.js";
import { createStubHost } from "../lib/host-services.js";

function makeApi() {
  const registrations = [];
  return {
    registrations,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    on(name, handler, options) { registrations.push({ name, handler, options }); return { dispose() {} }; },
    registerService(service) { registrations.push({ name: "service", service }); },
  };
}

function ctxFor(api, overrides = {}) {
  return {
    api,
    host: createStubHost(),
    neoWorkerRuntime: { warmUp() {} },
    obsidianBridgeEnabled: false,
    bridgeService: null,
    startNeoService: () => {},
    stopNeoService: () => {},
    neoEnabled: true,
    ...overrides,
  };
}

describe("registerGatewayLifecycle", () => {
  it("registers the Neo service pair with the 30 000 ms budget", () => {
    const api = makeApi();
    registerGatewayLifecycle(ctxFor(api));
    const stops = api.registrations.filter((r) => r.name === "gateway_stop");
    assert.ok(stops.length >= 1, "at least the Neo service stop must be registered");
    assert.ok(
      stops.some((r) => r.options?.timeoutMs === 30_000),
      "the 30 000 ms gateway_stop override must survive: the host default is 5 000 ms and LanceDB writes are lost under it",
    );
  });

  it("warms the Neo worker on gateway_start within 5 000 ms", () => {
    const api = makeApi();
    let warmed = false;
    registerGatewayLifecycle(ctxFor(api, { neoWorkerRuntime: { warmUp() { warmed = true; } } }));
    const start = api.registrations.find((r) => r.name === "gateway_start" && r.options?.timeoutMs === 5_000);
    assert.ok(start, "the warm-up registration keeps its 5 000 ms budget");
    start.handler();
    assert.equal(warmed, false, "warm-up is deferred on an unref'd timer, not run inline");
  });

  it("prefers registerService for the Obsidian bridge and falls back to the hook pair", () => {
    const withService = makeApi();
    const bridgeService = { id: "bridge", start() {}, stop() {} };
    registerGatewayLifecycle(ctxFor(withService, { obsidianBridgeEnabled: true, bridgeService }));
    assert.ok(withService.registrations.some((r) => r.name === "service" && r.service === bridgeService));

    const withoutService = makeApi();
    delete withoutService.registerService;
    registerGatewayLifecycle(ctxFor(withoutService, { obsidianBridgeEnabled: true, bridgeService }));
    const pairs = withoutService.registrations.filter((r) => r.options?.timeoutMs === 30_000);
    assert.ok(pairs.length >= 2, "without registerService the bridge falls back to gateway_start/stop");
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

```bash
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/adapter-register-gateway.test.js 2>&1 | tail -5
```

Expected: `ERR_MODULE_NOT_FOUND … '../adapter/openclaw/register-gateway.js'`.

- [ ] **Step 4: Create the two adapter modules**

`adapter/openclaw/register-gateway.js` exports two functions. `registerGatewayLifecycle(ctx)` contains `index.js:5296-5307`, `:7024-7033` and `:10325-10345` verbatim, in that order, each guarded exactly as it is today (`if (obsidianBridgeEnabled)`, `if (typeof api.registerService === "function")`, `if (neoEnabled)`). `registerGatewayShutdownServices(ctx)` contains `:13454-13491` verbatim, keeping `const gatewayShutdownRegistered = registerGatewayShutdown(api, { … })` as a local and the four `…AfterLifecycle` calls after it in the same order — that order is the contract (`index.js:13447-13451`: lifecycle ownership is registered after every hook and capability registration).

`adapter/openclaw/register-cron.js` exports `registerFeatureCronHooks(ctx)` containing `:4530-4545` and `:7035-7071` verbatim, each behind its existing guard (`!cronDirectDispatchReady`, and the `shouldRunCronBootstrap` condition at `:7043-7046`).

In `index.js`, replace each range with its call **at the original position**:

```js
      registerGatewayLifecycle({ api, host, neoWorkerRuntime, /* … */ });
```

`registerGatewayShutdownServices({ … })` must remain the **last** statement of `register()`.

- [ ] **Step 5: Write `adapter/openclaw/README.md`**

```markdown
# The OpenClaw adapter

Every `api.on` / `api.register*` call that PR-03 could move lives here. Engine
code never touches the OpenClaw `api` surface —
`scripts/lint-no-api-outside-adapter.mjs` enforces that, and
`scripts/lint-engine-imports.mjs` enforces that `engine/**` never imports the
host, `index.js`, or itself in a cycle.

| Module | Registers |
|---|---|
| `register-turn-route.js` | `reply_dispatch`, `agent_end` run cleanup |
| `register-recall-hook.js` | `before_prompt_build` (auto-recall on) |
| `register-maintenance-hook.js` | `before_prompt_build` (auto-recall off) |
| `register-capture-hook.js` | `agent_end` auto-capture |
| `register-commands.js` | the 15 `plur1bus_*` commands, `/state`, `/enable`, `/disable` |
| `register-tools.js` | the five model-facing tools |
| `register-prompt-supplements.js` | the static system-prompt supplement and the Neo corpus supplement |
| `register-gateway.js` | `gateway_start`/`gateway_stop` lifecycle, shutdown and the four service registrations |
| `register-cron.js` | the unsafe direct feature-cron guard and the deferred bootstrap |

## Deliberately still in `index.js` after M1a

<the table from this task's description, copied verbatim>
```

- [ ] **Step 6: Verify**

```bash
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --check index.js
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/adapter-register-gateway.test.js 2>&1 | tail -8
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 \
  tests/b12p-runtime-reachability.test.js tests/llm-result-cache-lifecycle.test.js \
  tests/bounded-cache-shutdown.test.js 2>&1 | tail -8
cd "$PLUR1BUS" && /home/claude/.node24/bin/node scripts/lint-engine-imports.mjs
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/golden-prefix.test.js
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm run lint
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm test 2>&1 | tail -20
```

Expected: `tests 3, pass 3` for the new file; `lint-engine-imports: clean (14 module(s))`; golden `pass 7 / fail 0`; lint 0; suite at the accepted baseline. A regression in the shutdown ordering shows up as a hang or a leaked handle in the suite rather than an assertion failure — if `npm test` stops terminating, `registerGatewayShutdownServices` is no longer last.

- [ ] **Step 7: Commit**

```bash
cd "$PLUR1BUS"
git add adapter/openclaw/register-gateway.js adapter/openclaw/register-cron.js adapter/openclaw/README.md index.js tests/adapter-register-gateway.test.js
git commit -m "refactor(adapter): group the gateway and cron registrations

PR-03i. adapter/openclaw/README.md records every registration M1a leaves in
index.js and why, so PR-04 and PR-13 do not have to re-derive the list. The
30000 ms gateway_stop override is pinned by a test: the host default is 5000 ms
and LanceDB writes are lost under it."
```

---

### Task 19: `bench/recall-budget-probe.mjs` — answer B6 from data

Owner decision B6 reads *"40/60"*, interpreted as **soft 400 ms / hard 600 ms**, and both `decisions-for-owner.md` and ADR-002 Q2 say the same thing twice: **measure today's pipeline first**. Today's values are soft 35 000 ms (`index.js:4711`) and hard 50 000 ms (`index.js:13351`). This task produces the distribution.

**Files:**
- Create: `bench/recall-budget-probe.mjs`
- Modify: `tests/helpers/golden-prefix-driver.js` — add a `{ freezeClock }` option to `runScenario`

**Interfaces:**
- Consumes: `SCENARIOS` and `runScenario` (Task 1).
- Produces: `node bench/recall-budget-probe.mjs [--iterations N] [--scale M]` printing p50/p95/p99 per scenario and per phase.

**Why the driver needs an option.** `freezeClock()` pins `Date.now()`, which is exactly wrong for a latency measurement — the internal soft-budget check (`phaseTimer.isSoftBudgetExceeded()`, `lib/recall-phase-timer.js:95-97`) would always read 0 ms elapsed. The probe therefore runs with the real clock. Measurement uses `performance.now()`, which `mock`-free `freezeClock` never touched anyway.

**What the numbers mean, and what they do not.** With a stub embedder, no reranker and a two-card fixture store, this is the pipeline's **floor** — orchestration, LanceDB open, context formatting — not the owner's distribution. It is still the right first number, because if the floor already exceeds 400 ms the budget question is answered before any provider is involved. The probe prints that caveat and supports `--scale` to grow the fixture corpus. **The owner must re-run this against their own store before PR-04 fixes the budget.**

- [ ] **Step 1: Add the clock option to the driver**

In `tests/helpers/golden-prefix-driver.js`, change the signature and the first line of `runScenario`:

```js
/**
 * @param {object} scenario
 * @param {{freezeClock?: boolean}} [options] `freezeClock: false` keeps the real
 *   clock, which the latency probe needs; the golden test leaves it on.
 * @returns {Promise<string|null>} the exact prependContext, or null.
 */
export async function runScenario(scenario, { freezeClock: useFrozenClock = true } = {}) {
  const restoreClock = useFrozenClock ? freezeClock() : () => {};
```

Everything else is unchanged; `restoreClock()` in the `finally` still runs.

- [ ] **Step 2: Confirm the golden test is unaffected**

```bash
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/golden-prefix.test.js 2>&1 | tail -8
```

Expected: `pass 7`, `fail 0` — the default is still a frozen clock.

- [ ] **Step 3: Write the probe**

Create `bench/recall-budget-probe.mjs`:

```js
/**
 * bench/recall-budget-probe.mjs — measure today's recall latency (owner B6).
 *
 * ADR-002 Q2 and decisions-for-owner B6 both say the 400/600 ms budget must be
 * set from data, not taste. Today's values are soft 35 000 ms (index.js:4711)
 * and hard 50 000 ms (index.js:13351).
 *
 * Runs the golden-prefix scenarios N times each with the REAL clock and a
 * deterministic offline embedder, and prints p50/p95/p99 of the whole
 * before_prompt_build call plus of the two phases this harness can observe:
 * embedding and store access.
 *
 * Usage:
 *   node bench/recall-budget-probe.mjs                 # 30 iterations
 *   node bench/recall-budget-probe.mjs --iterations 100
 *   node bench/recall-budget-probe.mjs --scale 50      # 50x the fixture cards
 */

import { performance } from "node:perf_hooks";

import { SCENARIOS } from "../tests/fixtures/golden-prefix/scenarios.js";
import { runScenario } from "../tests/helpers/golden-prefix-driver.js";
import { LocalTransformersEmbeddingProvider } from "../lib/providers/embedding-local-transformers.js";

function flag(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = Number(process.argv[index + 1]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const iterations = flag("iterations", 30);
const scale = flag("scale", 1);

/** Same definition bench/report.mjs:20 uses, so the numbers are comparable. */
function quantile(values, q) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

const fmt = (n) => `${n.toFixed(1)} ms`;

/** Grow a scenario's card count without changing what it recalls. */
function scaled(scenario) {
  if (scale <= 1 || scenario.memories.length === 0) return scenario;
  const memories = [];
  for (let copy = 0; copy < scale; copy += 1) {
    for (const [index, memory] of scenario.memories.entries()) {
      memories.push(copy === 0 ? memory : {
        ...memory,
        id: `${copy.toString(16).padStart(8, "0")}-0000-4000-8000-${String(index).padStart(12, "0")}`,
        text: `${memory.text} (variant ${copy})`,
        ageDays: (memory.ageDays ?? 1) + copy,
      });
    }
  }
  const topics = { ...scenario.topics };
  for (const memory of memories) topics[memory.text] = topics[memory.text] ?? scenario.topics[memory.text.replace(/ \(variant \d+\)$/, "")];
  return { ...scenario, memories, topics };
}

/** Count time spent inside the embedding provider, across all call sites. */
function instrumentEmbedder() {
  const proto = LocalTransformersEmbeddingProvider.prototype;
  const originals = { embedQuery: proto.embedQuery, embedPassage: proto.embedPassage };
  const totals = { embedMs: 0, calls: 0 };
  for (const name of ["embedQuery", "embedPassage"]) {
    const original = proto[name];
    proto[name] = async function instrumented(...args) {
      const started = performance.now();
      try {
        return await original.apply(this, args);
      } finally {
        totals.embedMs += performance.now() - started;
        totals.calls += 1;
      }
    };
  }
  return {
    totals,
    restore() { proto.embedQuery = originals.embedQuery; proto.embedPassage = originals.embedPassage; },
  };
}

console.log(`recall-budget-probe: ${iterations} iteration(s) per scenario, fixture scale x${scale}`);
console.log("Stub embedder, no reranker, no network: these are the pipeline FLOOR, not a");
console.log("production distribution. Re-run against a real store before fixing the budget.\n");

const rows = [];
for (const raw of SCENARIOS) {
  const scenario = scaled(raw);
  const totals = [];
  const embedShare = [];
  // One warm-up: the first run pays module init and LanceDB's first open.
  await runScenario(scenario, { freezeClock: false });
  for (let i = 0; i < iterations; i += 1) {
    const probe = instrumentEmbedder();
    const started = performance.now();
    await runScenario(scenario, { freezeClock: false });
    const elapsed = performance.now() - started;
    probe.restore();
    totals.push(elapsed);
    embedShare.push(probe.totals.embedMs);
  }
  rows.push({
    name: scenario.name,
    p50: quantile(totals, 0.5),
    p95: quantile(totals, 0.95),
    p99: quantile(totals, 0.99),
    embedP50: quantile(embedShare, 0.5),
  });
}

const width = Math.max(...rows.map((row) => row.name.length), 8);
console.log(`${"scenario".padEnd(width)}  ${"p50".padStart(10)}  ${"p95".padStart(10)}  ${"p99".padStart(10)}  ${"embed p50".padStart(10)}`);
for (const row of rows) {
  console.log(`${row.name.padEnd(width)}  ${fmt(row.p50).padStart(10)}  ${fmt(row.p95).padStart(10)}  ${fmt(row.p99).padStart(10)}  ${fmt(row.embedP50).padStart(10)}`);
}

const allP95 = Math.max(...rows.map((row) => row.p95));
const allP99 = Math.max(...rows.map((row) => row.p99));
console.log(`\nworst p95 ${fmt(allP95)}, worst p99 ${fmt(allP99)}`);
console.log(`owner B6 proposal: soft 400 ms / hard 600 ms`);
console.log(`today in code:     soft 35000 ms (index.js:4711) / hard 50000 ms (index.js:13351)`);
console.log(allP95 <= 400
  ? "floor fits the 400 ms soft budget; the remaining headroom is the provider's."
  : "floor already exceeds the 400 ms soft budget before any provider is involved — report this.");
```

- [ ] **Step 4: Run it**

```bash
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH node bench/recall-budget-probe.mjs --iterations 30
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH node bench/recall-budget-probe.mjs --iterations 20 --scale 50
```

Expected: a table with one row per scenario and non-zero p50/p95/p99, then the two comparison lines. Record both outputs verbatim in the commit message — they are the evidence the owner gate reads.

- [ ] **Step 5: Lint and suite**

```bash
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm run lint
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm test 2>&1 | tail -20
```

Expected: lint 0 (the probe is under `bench/`, which `npm run lint` does not `node --check`; run `/home/claude/.node24/bin/node --check bench/recall-budget-probe.mjs` yourself); suite at the accepted baseline.

- [ ] **Step 6: Commit, with the numbers in the message**

```bash
cd "$PLUR1BUS"
git add bench/recall-budget-probe.mjs tests/helpers/golden-prefix-driver.js
git commit -m "bench: measure today's recall latency for the B6 budget decision

Owner B6 and ADR-002 Q2 both require measuring before fixing 400/600 ms.
Paste the two runs' tables here (scale x1 and x50) so the owner gate can read
them without re-running."
```

---

### Task 20: documentation — the harness column, the engine API, the changelog

**Files:**
- Modify: `docs/compatibility-openclaw.md:175-190` — add the `Harness behaviour` column (risk R6)
- Create: `docs/engine-api.md`
- Modify: `CHANGELOG.md` — add an `## [Unreleased]` section above `## [7.15.4]`
- Modify: `package.json` — add `"docs/engine-api.md"` to `files`

**Interfaces:**
- Consumes: `types/engine.d.ts` (Task 3); the module layout from Tasks 10–17.
- Produces: nothing executable.

**Constraint check:** `.github/workflows/*` stays untouched (Global Constraint 7); `package.json:version` stays `7.15.4` (Global Constraint 6) — the `Unreleased` heading is how an unreleased change is recorded in a Keep-a-Changelog file, which is the format this CHANGELOG declares at `CHANGELOG.md:5`.

- [ ] **Step 1: Add the fourth column to the compatibility matrix**

`docs/compatibility-openclaw.md:175-176` is today:

```markdown
| OpenClaw feature | PLUR1BUS overlap | Compatibility policy |
| --- | --- | --- |
```

Change both lines to:

```markdown
| OpenClaw feature | PLUR1BUS overlap | Compatibility policy | Harness behaviour |
| --- | --- | --- | --- |
```

and append one cell to each of the 14 rows at `:177-190`, in this order (R6 fixes the first ten; the last four are this workstream's proposal and are marked as such):

| Row (`docs/compatibility-openclaw.md`) | Cell to append |
|---|---|
| `:177` Exclusive memory slot and `memory-core` tools | `n/a (harness owns this) — the harness has no plugin slot; the engine is the only memory owner.` |
| `:178` Active Memory | `n/a (harness owns this) — one automatic pre-reply lane, `Engine.recall`.` |
| `:179` Memory-core dreaming | `n/a (harness owns this) — the harness scheduler owns every phase (ADR-009, owner A6).` |
| `:180` Skill Workshop self-learning | `Live — the harness exposes the same proposal lane; PLUR1BUS never applies a skill autonomously.` |
| `:181` System-owned skill collection review | `Live — distinct job ids stay distinct; the harness scheduler runs the PLUR1BUS miner only.` |
| `:182` Scheduled tasks / cron dispatcher | `n/a (harness owns this) — in-process `Engine.jobs.run()`, never a host cron (owner A6, D4).` |
| `:183` Config-watcher handoff and restart recovery | `Live — the core daemon supervises the engine; `Engine.close()` gets a real teardown budget.` |
| `:184` Configurable model-selection scopes | `Live — the harness supplies the effective model through `HostServices.llm`.` |
| `:185` Session provenance and `openclaw memory forget` | `Live — `AdminOps.forget` stays archive-first and confirmation-bound; no cross-store deletion.` |
| `:186` Compaction memory flush | `n/a (harness owns this) — `Engine.checkpoint(agentId, "compaction")` replaces the read of `event.compactedAt` (PR-15).` |
| `:187` `USER.md` user model | `Proposed: live — the harness keeps an identity file and a user file per agent (owner D14); PLUR1BUS stays provenance-bearing recall and never auto-promotes into them.` |
| `:188` Standing intents | `Proposed: live — the harness owns exact-time reminders; event-conditioned intents stay out of scope for v0.1.` |
| `:189` Memory Wiki / Obsidian mode | `Proposed: live — one writer per vault, unchanged; the harness mounts the same Obsidian bridge through `AdminOps.obsidian`.` |
| `:190` Session/workspace ownership | `n/a (harness owns this) — the harness mints a `Principal` with `trust: "proved"` at admission; no ticket chain (ADR-007, host-contract §c.2).` |

Immediately after the table, add:

```markdown
The **Harness behaviour** column is the drift tripwire for risk R2 in
`PLUR1BUS-Harness/docs/engine-extraction.md` §d: a row whose OpenClaw side
changes without this cell changing is an unreviewed divergence. Cells marked
*Proposed* are this workstream's reading and are open at the M1a owner gate.
```

- [ ] **Step 2: Write `docs/engine-api.md`**

```markdown
# The PLUR1BUS engine API

**Contract version 1.0.0** · frozen 2026-09-22 · source of truth: `types/engine.d.ts`

This document explains the contract; `types/engine.d.ts` *is* the contract, and
`types/engine.conformance.ts` fails `npm run typecheck` if the two disagree on
any of the four decisions below.

## Why it is frozen

Phase 0 sketched this API in four places and they disagreed on four points
(`PLUR1BUS-Harness/docs/phase0/review-report.md`, finding S4). Owner decision
**B8** (2026-09-22) settled each one, and the `.d.ts` was frozen **before**
PR-01 so both adapters — the OpenClaw plugin and the harness — are written
against one shape.

| Point | ADR-002 said | `engine-extraction.md` §b.2 said | B8 chose |
|---|---|---|---|
| Principal strength | `proof: "transport"` | `trust: "proved" \| "inferred"` | **`trust`** |
| Turn origin | one `TurnOrigin` object | string union + `AgentContext` | **union + `AgentContext`** |
| Capture | `Promise<CaptureResult>` | non-blocking handle | **`CaptureHandle`** |
| Degradation | `degraded: boolean` | `degraded: { reason, … }` | **structured, `\| null`** |

## The two halves

**`HostServices`** — what a host gives the engine. ADR-002 calls it `Host`;
they are the same type. `logger`, `stateDir`, `workspaceDir(agentId)`,
`config()`, `platform`, `runtime`, and the optional `mutateConfig`, `llm`,
`secrets`, `events`, `clock`. `lib/host-services.js` implements it for
OpenClaw (`createHostServices(api)`) and for tests (`createStubHost()`).

**`Engine`** — what the engine gives a host. Lifecycle (`open`, `close`,
`status`), the turn path (`systemSupplement`, `recall`, `capture`,
`checkpoint`), the model-facing surface (`tools`, `commands`, `runCommand`),
and the background surface (`jobs`, `embedding`, `admin`, `events`).

## Rules the types encode

- **`recall()` never throws.** A failure comes back as `degraded: { reason, capability }` with whatever blocks were assembled. The turn is never blocked.
- **`signal` is mandatory** on `RecallQuery` and `TurnRecord`. Today's memory-slot path accepts the host's signal and deliberately drops it (`lib/setup/memory-host-runtime.js:170-172`); PR-05 threads it through.
- **`capture()` returns immediately.** The caller gets a `CaptureHandle` with a `done` promise it may await or abandon.
- **The six blocks are the output shape.** `neo`, `start` and `memories` are droppable; `time`, `temporal` and `reminder` are not. The join and the cap live in `lib/inject-budget.js`, unchanged.
- **`UserPrincipal` stays `user:v1:sha256([channel, accountId, userId])`.** The hash is an on-disk pool directory name; changing it orphans every `user`-scoped row.
- **`trust: "inferred"` degrades to agent-private and never throws** — the behaviour `lib/memory-request-context.js:1405-1417` already has.

## What is implemented in M1a, and what is not

M1a implements `PlatformCapabilities` (`lib/platform.js`) and the runtime half
of `HostServices` (`lib/host-services.js`), and moves the recall, capture,
command and tool bodies into `engine/**` behind explicit context objects. No
`createEngine()` exists yet: `Engine` is the target PR-04…PR-15 build toward.

## Module layout after PR-03

| Path | Holds |
|---|---|
| `engine/recall/assemble-prompt-context.js` | the per-turn recall assembly and the six blocks |
| `engine/recall/minimal-maintenance.js` | the auto-recall-off branch |
| `engine/capture/capture-turn.js` | auto-capture |
| `engine/commands/plur1bus-command.js` | `/plur1bus` and the 17 internal job runners |
| `engine/tools/memory-tools.js` | the five model-facing tools |
| `adapter/openclaw/register-*.js` | every `api.on` / `api.register*` call |
| `index.js` | construction plus the registration calls, and the `export default` plugin factory |

`engine/**` may not import `openclaw`, `index.js`, `lib/runtime-shutdown.js`,
`lib/host-services.js`, `lib/setup/*-plugin-runtime.js` or
`lib/providers/openclaw-memory-embedding-adapters.js`, and the graph may not
contain a cycle. `scripts/lint-engine-imports.mjs` enforces all of it inside
`npm run lint`.
```

- [ ] **Step 3: Add the changelog entry**

Insert directly above `## [7.15.4] — 2026-09-21` in `CHANGELOG.md`:

```markdown
## [Unreleased]

### Hinzugefügt

- **Eingefrorener Engine-Vertrag** in `types/engine.d.ts` (Contract 1.0.0) plus
  `npm run typecheck`. Reicht `Host`/`HostServices`, `Engine`, `Principal`,
  `AgentContext`, `TurnOrigin`, `RecallQuery`/`RecallResult`, `CaptureHandle`
  und `JobRun` in einer Form ein, gegen die beide Adapter geschrieben werden.
- **`lib/platform.js`** mit `securePath`, `ipcAddress`, `isUnsafeLink` und
  `canonicalIdentityPath`.
- **`lib/host-services.js`** — `createHostServices(api)` und `createStubHost()`.
- **Golden-Prefix-Korpus** (`tests/fixtures/golden-prefix/`): fünf synthetische
  Szenarien, deren `prependContext` byteweise festgehalten ist.
- **`bench/recall-budget-probe.mjs`** — p50/p95/p99 der Recall-Latenz.
- **`docs/engine-api.md`** und die Spalte *Harness behaviour* in
  `docs/compatibility-openclaw.md`.

### Geändert

- `index.js` ist auf die Konstruktion und die Registrierungsaufrufe reduziert;
  Recall, Capture, Kommandos und Tools liegen unter `engine/`, jede
  `api.on`/`api.register*`-Stelle unter `adapter/openclaw/`. **Kein
  Verhaltensunterschied** — die volle Suite und der Golden-Prefix-Korpus sind
  die Gates.

### Behoben

- `process.env.HOME` wird nicht mehr als Home-Verzeichnis benutzt
  (`lib/providers/openclaw-memory-embedding-adapters.js`); unter Windows ist
  die Variable nicht gesetzt, der Modell-Cache landete im Arbeitsverzeichnis.
- Alle acht `chmod`-Stellen laufen über `securePath`, das unter Windows eine
  benutzergebundene ACL setzt statt nur das Read-only-Bit.
```

- [ ] **Step 4: Ship the new doc**

Add `"docs/engine-api.md"` to `package.json:files`, next to the other `docs/` entries.

- [ ] **Step 5: Verify**

```bash
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm run lint
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/config-docs-contract.test.js 2>&1 | tail -8
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/golden-prefix.test.js
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm test 2>&1 | tail -20
cd "$PLUR1BUS" && git diff --stat .github/ ; echo "must be empty"
```

Expected: lint 0; `tests/config-docs-contract.test.js` passes (it reads the docs and would catch a broken table); golden `pass 7 / fail 0`; suite at the accepted baseline; the `git diff --stat .github/` prints nothing.

- [ ] **Step 6: Commit**

```bash
cd "$PLUR1BUS"
git add docs/compatibility-openclaw.md docs/engine-api.md CHANGELOG.md package.json
git commit -m "docs: add the Harness behaviour column, docs/engine-api.md and an Unreleased entry

Closes risk R6: the compatibility matrix now has the fourth column that acts as
the drift tripwire for R2. docs/engine-api.md explains the frozen contract and
records which of the four S4 disagreements B8 settled, and how."
```

---

## Done means

All twenty tasks committed on `feat/engine-extraction-m1a`, and:

```bash
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm run lint
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm test 2>&1 | tail -20
cd "$PLUR1BUS" && git diff --stat main -- .github/ ; echo "^ must be empty"
cd "$PLUR1BUS" && git diff main -- tests/fixtures/golden-prefix/expected/ ; echo "^ must be empty"
```

- lint exits 0, having run `node --check`, `tsc --noEmit`, the `api.` boundary rule and the engine dependency rule;
- the suite is at the accepted baseline — 2 failures, both the OpenClaw-host ones;
- `tests/golden-prefix.test.js` passes with the oracle **unmodified since Task 1** (the last command must print nothing);
- no workflow file changed;
- `package.json` still says `"name": "@cyb3rb1ade/plur1bus-memory"` and `"version": "7.15.4"`, with `engine/`, `adapter/`, `types/` and `docs/engine-api.md` added to `files`.

Then the M1a **owner gate**: the extraction boundary, the frozen `.d.ts` and the measured recall distribution go to the owner before M1b (PR-04…PR-09, PR-15, the daemon, the scheduler and the CLI) starts.
