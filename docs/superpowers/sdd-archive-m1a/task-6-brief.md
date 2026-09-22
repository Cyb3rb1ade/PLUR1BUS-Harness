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

