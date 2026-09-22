### Task 10 (PR-03a): scaffold, the scope analyser, the dependency rule, and the export guard

No product code moves in this task. It builds the three tools every later task depends on.

**Files:**
- Create: `tools/free-identifiers.mjs`
- Create: `scripts/lint-engine-imports.mjs`
- Create: `tests/index-public-exports.test.js`
- Create: `tests/lint-engine-imports.test.js`
- Create: `engine/.gitkeep`, `adapter/openclaw/.gitkeep`
- Modify: `package.json` — add `"engine/"` and `"adapter/"` to `files`, chain the new linter into `scripts.lint`

**Interfaces:**
- Produces: `node tools/free-identifiers.mjs <file> <startLine> <endLine>` printing `MODULE-SCOPE (import these): <n>` and `REGISTER-SCOPE (pass via context object): <n>` followed by the space-separated names; `npm run lint` enforcing the dependency rule; `tests/index-public-exports.test.js` guarding the 19 public names.
- Consumed by: Tasks 11–17.

**`package.json:files` matters.** It currently lists `index.js`, `lib/`, `scripts/`, some docs, `.openclaw/extensions/…`, `openclaw.plugin.json`, `CHANGELOG.md`, `README.md`, `LICENSE`. `engine/` and `adapter/` **must** be added or the published tarball loses everything PR-03 moves and the plugin breaks on install. `tools/` must **not** be added — it is developer-only.

- [ ] **Step 1: Write the scope analyser**

Create `tools/free-identifiers.mjs`:

```js
/**
 * scripts/dev/free-identifiers.mjs — list the identifiers a line range of a
 * module uses but does not declare, minus module-level imports and globals.
 *
 * Usage: node scripts/dev/free-identifiers.mjs <file> <startLine> <endLine>
 */
import { readFileSync } from "node:fs";
import ts from "typescript";

const [file, startArg, endArg] = process.argv.slice(2);
const startLine = Number(startArg);
const endLine = Number(endArg);
const text = readFileSync(file, "utf8");
const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);

const lineOf = (pos) => sf.getLineAndCharacterOfPosition(pos).line + 1;

// Identifiers declared at module top level (imports, top-level const/function/class).
const moduleScope = new Set();
for (const st of sf.statements) {
  if (ts.isImportDeclaration(st) && st.importClause) {
    const c = st.importClause;
    if (c.name) moduleScope.add(c.name.text);
    if (c.namedBindings) {
      if (ts.isNamespaceImport(c.namedBindings)) moduleScope.add(c.namedBindings.name.text);
      else for (const e of c.namedBindings.elements) moduleScope.add(e.name.text);
    }
  } else if (ts.isVariableStatement(st)) {
    for (const d of st.declarationList.declarations) collectBindingNames(d.name, moduleScope);
  } else if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name) {
    moduleScope.add(st.name.text);
  }
}

function collectBindingNames(node, out) {
  if (ts.isIdentifier(node)) { out.add(node.text); return; }
  if (ts.isObjectBindingPattern(node) || ts.isArrayBindingPattern(node)) {
    for (const el of node.elements) {
      if (ts.isOmittedExpression(el)) continue;
      collectBindingNames(el.name, out);
    }
  }
}

// Walk the whole file with a scope stack; when inside the range, record
// identifier references that resolve outside the range.
const declaredInRange = new Set();
const free = new Map();
const registerStart = 4394;
const scopes = [new Map()];

function isScopeNode(n) {
  return ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n)
    || ts.isMethodDeclaration(n) || ts.isConstructorDeclaration(n) || ts.isGetAccessor(n)
    || ts.isSetAccessor(n) || ts.isBlock(n) || ts.isForStatement(n) || ts.isForOfStatement(n)
    || ts.isForInStatement(n) || ts.isCatchClause(n) || ts.isCaseBlock(n)
    || ts.isClassDeclaration(n) || ts.isClassExpression(n) || ts.isSourceFile(n);
}

function declareInCurrent(name, node) {
  const line = lineOf(node.getStart(sf));
  scopes[scopes.length - 1].set(name, line);
  if (line >= startLine && line <= endLine) declaredInRange.add(name);
}

function hoistDeclarations(node) {
  // Declare names introduced directly by this node into the current scope.
  if (ts.isImportDeclaration(node) && node.importClause) {
    const names = new Set();
    const clause = node.importClause;
    if (clause.name) names.add(clause.name.text);
    if (clause.namedBindings) {
      if (ts.isNamespaceImport(clause.namedBindings)) names.add(clause.namedBindings.name.text);
      else for (const element of clause.namedBindings.elements) names.add(element.name.text);
    }
    for (const n of names) declareInCurrent(n, node);
  } else if (ts.isVariableDeclaration(node)) {
    const names = new Set();
    collectBindingNames(node.name, names);
    for (const n of names) declareInCurrent(n, node);
  } else if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) {
    declareInCurrent(node.name.text, node);
  } else if (ts.isParameter(node)) {
    const names = new Set();
    collectBindingNames(node.name, names);
    for (const n of names) declareInCurrent(n, node);
  } else if (ts.isBindingElement(node)) {
    const names = new Set();
    collectBindingNames(node.name, names);
    for (const n of names) declareInCurrent(n, node);
  } else if (ts.isCatchClause(node) && node.variableDeclaration) {
    const names = new Set();
    collectBindingNames(node.variableDeclaration.name, names);
    for (const n of names) declareInCurrent(n, node);
  }
}

function isReference(node) {
  if (!ts.isIdentifier(node)) return false;
  const p = node.parent;
  if (!p) return false;
  // property access `x.foo` — only `x` counts
  if (ts.isPropertyAccessExpression(p) && p.name === node) return false;
  if (ts.isPropertyAssignment(p) && p.name === node) return false;
  if (ts.isShorthandPropertyAssignment(p) && p.name === node) return true; // { x } uses x
  if (ts.isBindingElement(p) && p.propertyName === node) return false;
  if (ts.isBindingElement(p) && p.name === node) return false;
  if (ts.isParameter(p) && p.name === node) return false;
  if (ts.isVariableDeclaration(p) && p.name === node) return false;
  if ((ts.isFunctionDeclaration(p) || ts.isClassDeclaration(p) || ts.isFunctionExpression(p)) && p.name === node) return false;
  if (ts.isMethodDeclaration(p) && p.name === node) return false;
  if (ts.isPropertyDeclaration(p) && p.name === node) return false;
  if (ts.isMetaProperty(p)) return false;
  if (ts.isLabeledStatement(p) && p.label === node) return false;
  if (ts.isBreakOrContinueStatement(p) && p.label === node) return false;
  return true;
}

function declarationLine(name) {
  for (let i = scopes.length - 1; i >= 0; i--) {
    if (scopes[i].has(name)) return scopes[i].get(name);
  }
  return null;
}

function visit(node) {
  const opened = isScopeNode(node);
  if (opened) scopes.push(new Map());
  // Hoist sibling declarations of this scope's immediate children first.
  if (opened) {
    node.forEachChild(function pre(child) {
      hoistDeclarations(child);
      if (ts.isVariableStatement(child)) for (const d of child.declarationList.declarations) hoistDeclarations(d);
      if (ts.isBlock(child) || isScopeNode(child)) return; // do not descend into nested scopes
      child.forEachChild(pre);
    });
    if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)
      || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node)) {
      for (const p of node.parameters) hoistDeclarations(p);
    }
    if (ts.isCatchClause(node)) hoistDeclarations(node);
  }
  if (ts.isIdentifier(node) && isReference(node)) {
    const line = lineOf(node.getStart(sf));
    if (line >= startLine && line <= endLine) {
      const name = node.text;
      const declLine = declarationLine(name);
      if (declLine !== null && (declLine < startLine || declLine > endLine)) {
        free.set(name, moduleScope.has(name) && declLine < registerStart ? "module" : "register");
      }
    }
  }
  node.forEachChild(visit);
  if (opened) scopes.pop();
}

visit(sf);
const mod = [...free].filter(([, k]) => k === "module").map(([n]) => n).sort();
const reg = [...free].filter(([, k]) => k === "register").map(([n]) => n).sort();
console.log(`${file}:${startLine}-${endLine}`);
console.log(`MODULE-SCOPE (import these): ${mod.length}`);
console.log(mod.join(" "));
console.log(`REGISTER-SCOPE (pass via context object): ${reg.length}`);
console.log(reg.join(" "));
```

`registerStart` is the line `register(api, registrationDependencies = {})` begins on (`index.js:4394` at `89148f9`). It only separates "declared at module top level, so import it" from "declared inside `register`, so pass it in"; if `index.js` shifts, update the constant and re-run.

- [ ] **Step 2: Verify the analyser against the measured table**

```bash
cd "$PLUR1BUS" && for r in "12259 12283" "13354 13443" "12285 13351" "10354 11299" "7255 9044" "9083 10268"; do
  set -- $r; /home/claude/.node24/bin/node tools/free-identifiers.mjs index.js $1 $2; echo;
done
```

Expected: the six ranges print, in order, `0/5`, `14/9`, `76/62`, `51/52`, `96/82`, `88/42` for MODULE-SCOPE/REGISTER-SCOPE. Cross-check against the table above. Two spot checks that catch a drifted range immediately:

- `13354-13443` MODULE-SCOPE must be exactly `buildMaintenanceNudges consumePlur1busStartNotice formatReminderNudge formatTemporalContinuityContext formatTimeContext getLastActivity homedir join listDueReminders presentReminder readPendingReminders recordActivity shouldSkipAutoRecallForInternalTurn writePendingReminders`.
- `12259-12283` REGISTER-SCOPE must be exactly `api autoRecall getMemoryTurnRoutes replyDispatchInvocations turnRouteState`.

A different set means the line range drifted; re-derive it with `grep -n 'api.on("before_prompt_build"' index.js` and `grep -n 'api.on("reply_dispatch"' index.js` before trusting it. Note that `api` disappears from every REGISTER-SCOPE list except these registration ranges once Tasks 7 and 8 have landed; if you see `api` in the recall or capture list, those tasks are not in the tree.

- [ ] **Step 3: Write the dependency-rule linter**

Create `scripts/lint-engine-imports.mjs`:

```js
/**
 * scripts/lint-engine-imports.mjs
 *
 * The dependency rule for the extraction (engine-extraction.md §b.1, §c PR-03):
 *
 *   1. `engine/**` never imports the host. Forbidden: the `openclaw` package
 *      and its subpaths, `lib/setup/*-plugin-runtime.js`,
 *      `lib/runtime-shutdown.js`, `lib/host-services.js`,
 *      `lib/providers/openclaw-memory-embedding-adapters.js`.
 *   2. Neither `engine/**` nor `adapter/**` imports `index.js`. Everything they
 *      need arrives through their context object. An import back into the
 *      plugin shell is how an ESM cycle gets in, and a cycle yields an
 *      `undefined` binding at call time rather than a load error.
 *   3. No import cycle inside `engine/** + adapter/**`.
 *
 * dependency-cruiser is not installed and cannot be installed offline, so this
 * is a small static walker: it reads `import … from "x"`, `export … from "x"`
 * and `import("x")` with a literal specifier. That covers every form the
 * codebase uses (`"type": "module"`, no `require`).
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const ROOTS = ["engine", "adapter"];

const FORBIDDEN_FOR_ENGINE = [
  { test: (spec) => spec === "openclaw" || spec.startsWith("openclaw/"), why: "the openclaw package" },
  { test: (spec, target) => target === "lib/runtime-shutdown.js", why: "lib/runtime-shutdown.js (adapter lifecycle)" },
  { test: (spec, target) => target === "lib/host-services.js", why: "lib/host-services.js (built from the OpenClaw api)" },
  { test: (spec, target) => target === "lib/providers/openclaw-memory-embedding-adapters.js", why: "the OpenClaw embedding adapter" },
  { test: (spec, target) => /^lib\/setup\/[^/]+-plugin-runtime\.js$/.test(target || ""), why: "a lib/setup plugin runtime" },
];

const IMPORT_PATTERNS = [
  /(?:^|\n)\s*import\s[^;]*?\sfrom\s*["']([^"']+)["']/g,
  /(?:^|\n)\s*import\s*["']([^"']+)["']/g,
  /(?:^|\n)\s*export\s[^;]*?\sfrom\s*["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
];

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

function toPosix(value) {
  return value.split(sep).join("/");
}

/**
 * @param {string} fromFile Absolute path of the importing file.
 * @param {string} spec Import specifier.
 * @returns {string|null} Repo-relative POSIX path, or null for a bare package.
 */
function resolveTarget(fromFile, spec) {
  if (!spec.startsWith(".")) return null;
  return toPosix(relative(root, resolve(dirname(fromFile), spec)));
}

function importsOf(file) {
  const source = readFileSync(file, "utf8");
  const specs = new Set();
  for (const pattern of IMPORT_PATTERNS) {
    pattern.lastIndex = 0;
    let match = pattern.exec(source);
    while (match) {
      specs.add(match[1]);
      match = pattern.exec(source);
    }
  }
  return [...specs];
}

const violations = [];
const graph = new Map();

for (const scanRoot of ROOTS) {
  const base = join(root, scanRoot);
  try {
    if (!statSync(base).isDirectory()) continue;
  } catch {
    continue;
  }
  for (const file of walk(base)) {
    const from = toPosix(relative(root, file));
    const edges = [];
    for (const spec of importsOf(file)) {
      const target = resolveTarget(file, spec);
      if (target === "index.js") {
        violations.push(`${from}: imports index.js — pass what you need through the context object instead`);
      }
      if (from.startsWith("engine/")) {
        for (const rule of FORBIDDEN_FOR_ENGINE) {
          if (rule.test(spec, target)) violations.push(`${from}: engine code must not import ${rule.why} (\`${spec}\`)`);
        }
      }
      if (target && (target.startsWith("engine/") || target.startsWith("adapter/"))) edges.push(target);
    }
    graph.set(from, edges);
  }
}

// Depth-first cycle detection over the engine+adapter subgraph.
const WHITE = 0;
const GREY = 1;
const BLACK = 2;
const colour = new Map([...graph.keys()].map((key) => [key, WHITE]));
const stack = [];

function visit(node) {
  colour.set(node, GREY);
  stack.push(node);
  for (const next of graph.get(node) || []) {
    if (!graph.has(next)) continue;
    const state = colour.get(next);
    if (state === GREY) {
      const cycle = stack.slice(stack.indexOf(next)).concat(next);
      violations.push(`import cycle: ${cycle.join(" -> ")}`);
    } else if (state === WHITE) {
      visit(next);
    }
  }
  stack.pop();
  colour.set(node, BLACK);
}

for (const node of graph.keys()) if (colour.get(node) === WHITE) visit(node);

if (violations.length > 0) {
  console.error("Engine/adapter dependency rule violated:\n");
  for (const violation of [...new Set(violations)]) console.error(`  ${violation}`);
  console.error(`\n${new Set(violations).size} violation(s)`);
  process.exit(1);
}
console.log(`lint-engine-imports: clean (${graph.size} module(s))`);
```

- [ ] **Step 4: Write its test**

Create `tests/lint-engine-imports.test.js`:

```js
/**
 * tests/lint-engine-imports.test.js — PR-03a.
 *
 * Review Focus item 3: an ESM cycle between adapter and engine modules yields
 * an undefined binding at call time, not a load error, so it must be caught
 * statically.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, "scripts", "lint-engine-imports.mjs");

function run() {
  try {
    return { status: 0, out: execFileSync(process.execPath, [script], { cwd: root, encoding: "utf8" }) };
  } catch (error) {
    return { status: error.status ?? 1, out: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

function probe(t, files) {
  const dirs = new Set();
  for (const [relativePath, source] of Object.entries(files)) {
    const full = join(root, relativePath);
    mkdirSync(dirname(full), { recursive: true });
    dirs.add(dirname(full));
    writeFileSync(full, source);
  }
  t.after(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });
}

describe("lint-engine-imports", () => {
  it("passes on the current tree", () => {
    const result = run();
    assert.equal(result.status, 0, result.out);
  });

  it("allows an adapter module importing an engine module", (t) => {
    probe(t, {
      "engine/__probe__/a.js": 'import { applyGlobalInjectBudget } from "../../lib/inject-budget.js";\nexport function a() { return applyGlobalInjectBudget; }\n',
      "adapter/__probe__/r.js": 'import { a } from "../../engine/__probe__/a.js";\nexport function r(api) { return api.on("x", a); }\n',
    });
    assert.equal(run().status, 0);
  });

  it("rejects engine code importing the adapter lifecycle", (t) => {
    probe(t, {
      "engine/__probe__/bad.js": 'import { runtimeIfUsable } from "../../lib/runtime-shutdown.js";\nexport const x = runtimeIfUsable;\n',
    });
    const result = run();
    assert.equal(result.status, 1);
    assert.match(result.out, /must not import lib\/runtime-shutdown\.js/);
  });

  it("rejects an import of index.js", (t) => {
    probe(t, { "engine/__probe__/shell.js": 'import plugin from "../../index.js";\nexport const p = plugin;\n' });
    const result = run();
    assert.equal(result.status, 1);
    assert.match(result.out, /imports index\.js/);
  });

  it("rejects an import cycle", (t) => {
    probe(t, {
      "engine/__probe__/b.js": 'import { c } from "./c.js";\nexport function b() { return c(); }\n',
      "engine/__probe__/c.js": 'import { b } from "./b.js";\nexport function c() { return b(); }\n',
    });
    const result = run();
    assert.equal(result.status, 1);
    assert.match(result.out, /import cycle: engine\/__probe__\/[bc]\.js/);
  });
});
```

- [ ] **Step 5: Write the public-export guard**

Review Focus item 4. Create `tests/index-public-exports.test.js`:

```js
/**
 * tests/index-public-exports.test.js — PR-03a.
 *
 * 46 test files import internals from ../index.js. Moving a symbol into
 * engine/ or adapter/ without re-exporting it here breaks them, sometimes
 * quietly. This list is frozen for M1a; PR-14 is the PR that may change it.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import * as index from "../index.js";

const PUBLIC_NAMES = [
  "AgentDbPool",
  "MemoryDB",
  "appendConflictLog",
  "applyEpistemicStatusToLanceDb",
  "applyEpistemicStatusToNeo",
  "applyValidTimeCloseToLanceDb",
  "buildConflictSummaryFromLog",
  "buildMaintenanceNudges",
  "completePendingConfirmation",
  "createRuntimeRerankerProvider",
  "guardUnsafeDirectCronTurn",
  "inspectCronNativeCapabilities",
  "parseConfirmationCommand",
  "parseFeatureCronBootstrapLastPlanCreateCount",
  "reconcileUnsafeDirectCronsWithService",
  "rememberPendingConfirmation",
  "resolveConfirmationIdentity",
  "runDeferredFeatureCronBootstrap",
  "selectSemanticDiscoveryWorkspaces",
];

describe("index.js public surface", () => {
  for (const name of PUBLIC_NAMES) {
    it(`exports ${name}`, () => {
      assert.equal(typeof index[name], "function", `${name} must stay exported from index.js`);
    });
  }

  it("exports exactly these names and nothing new", () => {
    const actual = Object.keys(index).filter((key) => key !== "default").sort();
    assert.deepEqual(actual, [...PUBLIC_NAMES].sort());
  });

  it("still default-exports the plugin", () => {
    assert.equal(index.default.id, "memory-lancedb-namespaced");
    assert.equal(index.default.kind, "memory");
    assert.equal(typeof index.default.register, "function");
  });
});
```

- [ ] **Step 6: Create the directories and update `package.json`**

```bash
cd "$PLUR1BUS" && mkdir -p engine adapter/openclaw && touch engine/.gitkeep adapter/openclaw/.gitkeep
```

In `package.json`, add `"engine/"` and `"adapter/"` to `files` immediately after `"lib/"`, and extend `lint`:

```json
"lint": "node --check index.js && find lib tests test -name '*.js' -exec node --check {} + && find scripts tools -name '*.mjs' -exec node --check {} + && node scripts/typecheck.mjs && node scripts/lint-no-api-outside-adapter.mjs && node scripts/lint-engine-imports.mjs",
```

Also extend the `node --check` sweep to the new directories by changing `find lib tests test` to `find lib engine adapter tests test`.

- [ ] **Step 7: Run everything**

```bash
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/lint-engine-imports.test.js tests/index-public-exports.test.js 2>&1 | tail -10
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm run lint
cd "$PLUR1BUS" && /home/claude/.node24/bin/node --test --test-concurrency=1 tests/golden-prefix.test.js
cd "$PLUR1BUS" && PATH=/home/claude/.node24/bin:$PATH npm test 2>&1 | tail -20
```

Expected: `pass 27, fail 0` for the two new files (5 + 22); lint prints `lint-engine-imports: clean (0 module(s))` and exits 0; golden `pass 7 / fail 0`; suite at the accepted baseline.

- [ ] **Step 8: Commit**

```bash
cd "$PLUR1BUS"
git add tools/free-identifiers.mjs scripts/lint-engine-imports.mjs tests/lint-engine-imports.test.js tests/index-public-exports.test.js engine adapter package.json
git commit -m "chore(engine): scaffold engine/ and adapter/ with their dependency rule

PR-03a. tools/free-identifiers.mjs uses the TypeScript compiler API (already a
dependency) to produce each move's exact context key set, so no closure
dependency is enumerated by hand. The linter catches the three ways the split
can go wrong: engine importing the host, anything importing index.js, and an
ESM cycle. package.json:files gains engine/ and adapter/ so the published
tarball does not lose them."
```

---

