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

