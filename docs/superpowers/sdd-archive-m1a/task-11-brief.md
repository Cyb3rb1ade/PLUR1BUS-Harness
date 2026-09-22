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

