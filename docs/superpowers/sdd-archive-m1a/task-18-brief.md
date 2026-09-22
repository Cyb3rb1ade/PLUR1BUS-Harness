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

