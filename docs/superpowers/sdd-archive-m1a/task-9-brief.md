### Task 9 (PR-02d): the `api.` boundary lint

**Files:**
- Create: `scripts/lint-no-api-outside-adapter.mjs`
- Modify: `package.json` — chain it into `scripts.lint`
- Create: `tests/lint-no-api-outside-adapter.test.js`

**Interfaces:**
- Produces: `npm run lint` fails when any file outside the allowlist references `api.`. The allowlist is the contract PR-03 is written against: `index.js`, `adapter/**`, `lib/setup/*-plugin-runtime.js`, `lib/runtime-shutdown.js`, `lib/host-services.js`, `lib/providers/openclaw-memory-embedding-adapters.js`, `lib/providers/scoped-embedding-ipc.js`.

**Why `lib/providers/scoped-embedding-ipc.js` is allowlisted:** it carries the `registerScopedEmbeddingIpcServiceAfterLifecycle({ api, … })` seam, which is an OpenClaw service registration and therefore adapter by `engine-extraction.md` §a.3.

- [ ] **Step 1: Write the script**

Create `scripts/lint-no-api-outside-adapter.mjs`:

```js
/**
 * scripts/lint-no-api-outside-adapter.mjs
 *
 * The OpenClaw plugin API surface may only be touched by the adapter. Engine
 * code reaches the host through `HostServices` (lib/host-services.js) instead.
 *
 * Allowed to reference `api.`:
 *   - index.js                                       (the plugin shell)
 *   - adapter/**                                     (the OpenClaw adapter)
 *   - lib/setup/*-plugin-runtime.js                  (gateway/CLI runtimes)
 *   - lib/runtime-shutdown.js                        (lifecycle + runtimeIfUsable)
 *   - lib/providers/openclaw-memory-embedding-adapters.js
 *   - lib/providers/scoped-embedding-ipc.js          (registerService seam)
 *   - lib/host-services.js                           (the seam itself)
 *
 * Everything else under lib/ and all of engine/ must be clean.
 *
 * Exits 1 and prints file:line for every violation.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const SCANNED_ROOTS = ["lib", "engine"];

const ALLOWED_EXACT = new Set([
  "index.js",
  "lib/runtime-shutdown.js",
  "lib/host-services.js",
  "lib/providers/openclaw-memory-embedding-adapters.js",
  "lib/providers/scoped-embedding-ipc.js",
]);

const ALLOWED_PATTERNS = [
  /^adapter\//,
  /^lib\/setup\/[^/]+-plugin-runtime\.js$/,
];

/** `api.x` but not `foo.api.x`, not `myapi.x`, and not `https://api.host/…`. */
const API_REFERENCE = /(?<![.\w$/-])api\s*\./;

/**
 * Remove block comments and everything after a `//`. Crude on purpose: it also
 * truncates a line at a URL's `//`, which is exactly what we want, since a
 * hostname is never a reference to the plugin API.
 * @param {string} line Source line.
 * @returns {string} Line with comments removed.
 */
function stripComments(line) {
  return line.replace(/\/\*.*?\*\//g, " ").replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "");
}

function isAllowed(relativePath) {
  if (ALLOWED_EXACT.has(relativePath)) return true;
  return ALLOWED_PATTERNS.some((pattern) => pattern.test(relativePath));
}

function* walk(directory) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      yield* walk(full);
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      yield full;
    }
  }
}

const violations = [];
for (const scanRoot of SCANNED_ROOTS) {
  const base = join(root, scanRoot);
  try {
    if (!statSync(base).isDirectory()) continue;
  } catch {
    continue;
  }
  for (const file of walk(base)) {
    const relativePath = relative(root, file).split(sep).join("/");
    if (isAllowed(relativePath)) continue;
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, index) => {
      if (API_REFERENCE.test(stripComments(line))) violations.push(`${relativePath}:${index + 1}: ${line.trim()}`);
    });
  }
}

if (violations.length > 0) {
  console.error("The OpenClaw `api` surface is only reachable from the adapter.");
  console.error("Use the injected HostServices (lib/host-services.js) instead.\n");
  for (const violation of violations) console.error(`  ${violation}`);
  console.error(`\n${violations.length} violation(s)`);
  process.exit(1);
}
console.log("lint-no-api-outside-adapter: clean");
```

- [ ] **Step 2: Run it against the current tree**

```bash
cd "$PLUR1BUS" && /home/claude/.node24/bin/node scripts/lint-no-api-outside-adapter.mjs; echo "exit=$?"
```

Expected: `lint-no-api-outside-adapter: clean`, `exit=0`. (Verified at `89148f9`: the three near-misses — `https://api.openai.com` in `lib/llm-call.js:77`, `https://api.cohere.com` in `lib/providers/reranker-cohere.js:52`, and the prose `api.pluginConfig…` in `lib/telegram-commands/status-data.js:9` — are excluded by the `/`-guard and the comment stripper.)

- [ ] **Step 3: Write the test that proves the script detects a violation**

Create `tests/lint-no-api-outside-adapter.test.js`:

```js
/**
 * tests/lint-no-api-outside-adapter.test.js — PR-02d.
 *
 * The boundary rule is only worth having if it fails on a real violation, so
 * the test plants one under engine/ and removes it again.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, "scripts", "lint-no-api-outside-adapter.mjs");

function run() {
  try {
    return { status: 0, out: execFileSync(process.execPath, [script], { cwd: root, encoding: "utf8" }) };
  } catch (error) {
    return { status: error.status ?? 1, out: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

describe("lint-no-api-outside-adapter", () => {
  it("passes on the current tree", () => {
    const result = run();
    assert.equal(result.status, 0, result.out);
  });

  it("fails on an api. reference under engine/", (t) => {
    const dir = join(root, "engine", "__lint_probe__");
    mkdirSync(dir, { recursive: true });
    t.after(() => rmSync(join(root, "engine", "__lint_probe__"), { recursive: true, force: true }));
    writeFileSync(join(dir, "bad.js"), "export function x(api) { return api.logger; }\n");
    const result = run();
    assert.equal(result.status, 1);
    assert.match(result.out, /engine\/__lint_probe__\/bad\.js:1/);
  });

  it("allows an api. reference inside the adapter", (t) => {
    const dir = join(root, "adapter", "__lint_probe__");
    mkdirSync(dir, { recursive: true });
    t.after(() => rmSync(join(root, "adapter", "__lint_probe__"), { recursive: true, force: true }));
    writeFileSync(join(dir, "ok.js"), "export function x(api) { return api.on(\"gateway_stop\", () => {}); }\n");
    assert.equal(run().status, 0);
  });
});
```

- [ ] **Step 4: Run it**

```bash
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/lint-no-api-outside-adapter.test.js 2>&1 | tail -8
```

Expected: `tests 3`, `pass 3`, `fail 0`.

- [ ] **Step 5: Chain it into `npm run lint`**

```json
"lint": "node --check index.js && find lib tests test -name '*.js' -exec node --check {} + && find scripts tools -name '*.mjs' -exec node --check {} + && node scripts/typecheck.mjs && node scripts/lint-no-api-outside-adapter.mjs",
```

- [ ] **Step 6: Lint, suite, golden**

```bash
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm run lint
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/golden-prefix.test.js
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm test 2>&1 | tail -20
```

Expected: lint prints `lint-no-api-outside-adapter: clean` and exits 0; golden `pass 7 / fail 0`; suite at the accepted baseline.

- [ ] **Step 7: Commit**

```bash
cd "$PLUR1BUS"
git add scripts/lint-no-api-outside-adapter.mjs tests/lint-no-api-outside-adapter.test.js package.json
git commit -m "chore(host): forbid the OpenClaw api surface outside the adapter

PR-02d. Wired into npm run lint, which the existing CI lint job already runs,
so no workflow change is needed."
```

---

## PR-03 — how the split is actually done

Read this once before Tasks 10–17.

`plugin.register(api, registrationDependencies)` is **one function from `index.js:4394` to `index.js:13491`** — about 9 100 lines, with 471 bindings in scope and every hook body a closure over them. You cannot move a hook body by cut-and-paste; you have to know exactly which bindings it captures.

**The recipe, applied identically in Tasks 11–17:**

1. Run `tools/free-identifiers.mjs` (Task 10) over the line range. It prints two lists: **module-scope** names (declared at `index.js` top level → the moved module `import`s them from the same `./lib/…` path `index.js` uses) and **register-scope** names (→ they go in the context object).
2. Create the module. It exports one factory that takes a single context object and destructures it **at the top of the factory**, then contains the moved code verbatim:

```js
export function createSomething(ctx) {
  const { pool, cfg, embeddings, host /* … the exact list the tool printed … */ } = ctx;
  return async function something(event, hookCtx) {
    /* the moved body, unchanged */
  };
}
```

3. In `index.js`, at the *same line* the code used to start, call the factory with an object literal of exactly those keys and register the result. Keeping the call at the original position preserves evaluation order — several registrations read values (`runtimeScheduler.config.recallTimeoutMs`) at registration time, and moving the call earlier would read them before they exist.
4. The five bindings that `let`-rebind are safe to pass by value **because every rebinding happens before any hook is registered**: `cfg` (`index.js:4433`, rebound once at `:4555`), `vectorDim` (`:5067`, rebound at `:5069`/`:5074`), `modelPreparationCoordinator` (`:6138`, assigned at `:6141`/`:6152`), `hostMemoryConfig` (`:5220`), `controlHealthPrimaryAgentIds` (`:5601`). The earliest registration is at `:7024`. **The two exceptions are `sessionCountSinceReflection` and `lastReflectionAt`** (`:5049-5050`), which the capture hook rebinds *at turn time* (`:10852-10853`); Task 14 converts them into one shared mutable object first.
5. Run the golden corpus and the suite. Commit.

**Measured sizes at `89148f9`** (`tools/free-identifiers.mjs` output; the counts are the acceptance check for step 1 of each task — a different number means the range drifted and you must re-derive it):

| Range | Lines | module-scope imports | register-scope context keys | Task |
|---|---|---|---|---|
| `12259-12283` `reply_dispatch` + `agent_end` cleanup | 25 | 0 | 5 | 11 |
| `13354-13443` maintenance-only `before_prompt_build` | 90 | 14 | 9 | 12 |
| `12285-13351` recall assembly | 1 067 | 76 | 62 | 13 |
| `10354-11299` auto-capture | 946 | 51 | 52 | 14 |
| `7255-9044` `runPlur1busCommand` incl. the 17 internal job runners | 1 790 | 96 | 82 | 15 |
| `9083-10268` chat-command registration | 1 186 | 88 | 42 | 16 |

(The register-scope counts above are after Tasks 7 and 8, which remove `api` from every one of these ranges except the `api.on(...)` registration calls themselves — those stay in `index.js` or move to an `adapter/` module. Before Task 7 the tool also reports `api`.)

---

