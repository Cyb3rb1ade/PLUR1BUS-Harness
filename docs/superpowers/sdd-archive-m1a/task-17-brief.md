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

