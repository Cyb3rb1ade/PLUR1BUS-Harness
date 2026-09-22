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

