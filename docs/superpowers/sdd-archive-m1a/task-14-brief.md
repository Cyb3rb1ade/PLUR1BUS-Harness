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

