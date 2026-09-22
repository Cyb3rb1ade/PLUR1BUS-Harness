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

