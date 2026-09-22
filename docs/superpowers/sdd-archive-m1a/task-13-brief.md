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

