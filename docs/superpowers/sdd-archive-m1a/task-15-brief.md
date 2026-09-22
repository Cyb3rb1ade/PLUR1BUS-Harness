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

