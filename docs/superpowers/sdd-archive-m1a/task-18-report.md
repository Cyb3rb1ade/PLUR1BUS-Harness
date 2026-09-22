# Task 18 (PR-03i) report — group the remaining registrations, record what stays, and the end-of-PR-03 cleanup

HEAD at start: `99d480a7` (`index.js` 7 905 lines). Commits produced:

| commit | subject |
|---|---|
| `deb3b3c1` | `refactor(adapter): group the gateway and cron registrations` |
| `d39d49ed` | `chore(index): prune imports orphaned by PR-03` |
| `a1bbcd2c` | `test: introduce readRuntimeSources() helper for literal-source guards` |
| `e0fcc45a` | `chore(engine): forbid bare api identifier in engine/**` |

---

## Part A

### 1. Range derivation — five of the six brief ranges are not extractable

Every range re-derived by grep at HEAD, then each extracted slice run through
`node --check` inside an `async function` wrapper (Task 17's pattern note: a
matching analyser fingerprint proves the brief *measured* that range, not that
it is movable).

Anchors:

```
$ grep -n 'api.on("gateway_start"\|api.on("gateway_stop"\|registerGatewayShutdown(\|guardUnsafeDirectCronTurn\|shouldRunCronBootstrap' index.js
4547:        (event, context) => guardUnsafeDirectCronTurn(
5311:      api.on("gateway_start", () => {
7038:          api.on("gateway_start", () => bridgeService.start(), { timeoutMs: 30_000 });
7039:          api.on("gateway_stop", () => bridgeService.stop(), { timeoutMs: 30_000 });
7497:          api.on("gateway_start", startNeoService, { timeoutMs: 30_000 });
7498:          api.on("gateway_stop", stopNeoService, { timeoutMs: 30_000 });
7862:    const gatewayShutdownRegistered = registerGatewayShutdown(api, {
```

Syntax check of the brief's own ranges, against `89148f9f`:

```
5296-5307    check=OK           ← but see below
7024-7033    SYNTAX-FAIL  Unexpected token 'else'
10325-10345  SYNTAX-FAIL  Unexpected token 'catch'
13454-13491  SYNTAX-FAIL  Unexpected token ':'
4530-4545    SYNTAX-FAIL  Unexpected token ')'
7035-7071    check=OK
```

- `7024-7033` starts *inside* `if (obsidianBridgeCfg.watch === true) {` and ends
  on the closing brace of the enclosing `if (obsidianBridgeEnabled)`.
- `10325-10345` starts in the middle of `stopNeoService`'s `try` body and ends
  on a banner comment two statements later.
- `13454-13491` starts at the first *property* of the `registerGatewayShutdown`
  call, one line below the `const` the brief's own prose says to keep.
- `4530-4545` starts inside the `openClawSkillWorkshop` ternary and ends on the
  `const baseDbPath` statement two lines past the guard.
- `5296-5307` passes `node --check` only because it is a run of complete
  statements — but it contains `const NEO_EMBED_TIMEOUT = Symbol(…)` (two lines
  at column 0, wedged between the warm-up const and the warm-up `if`), which is
  still read at `index.js:7768`. Moving the range verbatim would have taken the
  prompt-recall embedding-budget sentinel out of `index.js`.
- `7035-7071` is the only correct range of the six.

**Real ranges at HEAD `99d480a7`** (seven pieces; the warm-up is two disjoint
pieces because of the `NEO_EMBED_TIMEOUT` intrusion):

| piece | HEAD lines | indent | what |
|---|---|---|---|
| G1a | `5304-5307` | 4 | the warm-up comment + `const NEO_WORKER_WARMUP_DELAY_MS = 20_000;` |
| — | `5308-5309` | 0 | `NEO_EMBED_TIMEOUT` — **stays in `index.js`** |
| G1b | `5310-5318` | 4 | `if (neoWorkerRuntime && typeof api.on === "function")` |
| G2 | `7034-7043` | 6 | `if (obsidianBridgeCfg.watch === true) { … } else { … }` |
| G3 | `7484-7506` | 6 | `if (neoEnabled) { … }` — the Neo service pair |
| G4 | `7862-7900` | 4 | `registerGatewayShutdown` + the four `…AfterLifecycle` calls |
| C1 | `4544-4553` | 4 | `if (!cronDirectDispatchReady && typeof api.on === "function")` |
| C2 | `7046-7082` | 4 | the deferred feature-cron bootstrap (comment + `if`) |

`NEO_WORKER_WARMUP_DELAY_MS` is read only at `5315`, inside G1b, so it moved
with it and became a module-level `const` of the adapter. `NEO_EMBED_TIMEOUT`
stayed exactly where it was, at column 0.

### 2. Analyser output (`tools/free-identifiers.mjs` at HEAD)

| range | module-scope | register-scope | names |
|---|---|---|---|
| `5310-5318` | 0 | 4 | `NEO_WORKER_WARMUP_DELAY_MS api host neoWorkerRuntime` |
| `7034-7043` | 0 | 4 | `api bridgeService host obsidianBridgeCfg` |
| `7484-7506` | 0 | 5 | `api host neoEnabled neoRoot neoWorkerRuntime` |
| `7862-7900` | 6 | 15 | see below |
| `4544-4553` | 1 | 2 | `guardUnsafeDirectCronTurn` / `api cronDirectDispatchReady` |
| `7046-7082` | 3 | 5 | `ensureEpistemicCutoff reconcileUnsafeDirectCronsWithService runDeferredFeatureCronBootstrap` / `api baseDbPath cfg cronDirectDispatchReady host` |

`7862-7900` register-scope: `api clearInitializedTurnRoutes
coordinatesLocalModelGeneration embeddings legacyMigrationShutdown
llmResultCache localModelGeneration memoryDbAdapter modelPreparationCoordinator
pool reembeddingCoordinator reembeddingSwitchRecovery reranker
scopedEmbeddingServer sharedMemoryPool`.

Every difference from the brief's table is explained, and each explanation
corroborates the corrected range:

- `+host` everywhere the brief measured `api.logger` — the Task 7 migration.
- `7862-7900` is `6 / 15` where the brief says `5 / 16`: including the
  `const gatewayShutdownRegistered =` line adds `registerGatewayShutdown` to
  module-scope and removes `gatewayShutdownRegistered` from register-scope. The
  brief's prose already said to keep that binding as a local; its numbers were
  measured one line lower.
- `4544-4553` is `1 / 2` where the brief says `4 / 3`: the brief's extra names
  (`createOpenClawSkillWorkshopClient`, `makeReactionsCapabilityChecker`,
  `DEFAULT_BASE_DB_PATH`, `cfg`) all come from the ternary tail and the two
  statements past the guard that its range accidentally spanned.
- `5310-5318` gains `NEO_WORKER_WARMUP_DELAY_MS` because the brief's range
  declared it; moving the declaration too returns the ctx to the brief's 2
  (+`host`) = 3 keys.

### 3. Classification (TS AST, by specifier + exported name)

10 module-scope names across all ranges, **0 UNKNOWN, 0 alias mismatches**:

| name | classification |
|---|---|
| `flushMetrics` | IMPORT `lib/metrics.js` |
| `registerScopedEmbeddingIpcServiceAfterLifecycle` | IMPORT `lib/providers/scoped-embedding-ipc.js` |
| `registerGatewayShutdown`, `registerLocalModelOwnershipServiceAfterLifecycle`, `registerModelPreparationServiceAfterLifecycle`, `registerReembeddingRecoveryServiceAfterLifecycle` | IMPORT `lib/runtime-shutdown.js` |
| `ensureEpistemicCutoff` | IMPORT `lib/epistemic-cutoff.js` |
| `guardUnsafeDirectCronTurn` | PASS-IN, `function :3444` |
| `reconcileUnsafeDirectCronsWithService` | PASS-IN, `function :3465` |
| `runDeferredFeatureCronBootstrap` | PASS-IN, `function :3534` |

`lib/runtime-shutdown.js` is on the Global-Constraint-8 forbidden list — for
`engine/**`. Both new modules are adapter modules, so the import is legal and
`lint-engine-imports` stays clean.

The three PASS-IN names are on the frozen named-export list (Global Constraint
9) and take the host handle as their *own* first parameter, so they are handed
through `ctx` rather than imported. The export list is untouched
(`index-public-exports` 21/21).

### 4. Reverse audit

Nothing declared inside a range is read outside it:

- `5310-5318`, `7034-7043`, `4544-4553`, `7046-7082` are `IfStatement`s and
  declare nothing at register scope.
- `7484-7506` declares `startNeoService`/`stopNeoService` inside its own `if`
  block.
- `7862-7900` declares `gatewayShutdownRegistered` at register scope, but all
  four reads (`7884`, `7891`, `7894`, `7898`) are inside the range — it stays a
  local of the new function, as the brief requires.
- `5304-5307` declares `NEO_WORKER_WARMUP_DELAY_MS`, read only at `5315` (inside
  G1b, which moves with it).

### 5. `let` audit — both directions

Declaration kind resolved per ctx key by an AST scope-chain walk from each call
site. 33 key resolutions across the six call sites, all resolved. Two non-`const`
bindings, both final at their call site:

- **`cfg`** — `let :4442`, reassigned once at `:4565`
  (`cfg = providerMigration.config`). Only C2 (`7046`) needs it, 2 481 lines
  later, in `register()`'s own body. Same binding and reasoning as Tasks 15–17.
- **`modelPreparationCoordinator`** — `let :6149`, reassigned at `:6152` and
  `:6163` (the two branches of one `try`/`catch`). G4's call site is `7862`,
  1 699 lines later. Value is final; shorthand passing is safe.

Everything else is `const`, a `const` destructuring, a `function` declaration or
the `api` parameter. `reranker` resolves to the `const { reranker, rerankerCfg }`
destructuring at `:6202`, not the `let reranker` inside
`createRuntimeRerankerProvider` — a textual grep mis-flags it, and my first
(scope-blind) reassignment pass did exactly that until the detector was fixed to
count only `++`/`--`, not `!x`.

Reverse direction: §4.

### 6. Semantic parity

Per range: `this` 0, `arguments` 0, top-level `return` 0, top-level `await` 0,
relative dynamic `import("./…")` 0, whitespace-only lines 0, no non-blank line
below the range's own indent, and `node --check` clean on every extracted slice.
No `import("./lib/…")` to rewrite in any of the seven pieces.

### 7. Byte-identity of the moved text

Round-trip: the blocks were extracted back out of the two committed adapter
modules, re-indented by the prescribed amount, and compared line-by-line with
`index.js@99d480a7`.

```
IDENTICAL const        5304-5307 (4 lines)    re-indent +4
IDENTICAL warmup       5310-5318 (9 lines)    re-indent +2
IDENTICAL obsidian     7034-7043 (10 lines)   re-indent +4
IDENTICAL neoservice   7484-7506 (23 lines)   re-indent +4
IDENTICAL shutdown     7862-7900 (39 lines)   re-indent +2
IDENTICAL cronguard    4544-4553 (10 lines)   re-indent +2
### cronboot line 7052
  orig: "    // above and shouldRunCronBootstrap/featureCronsHintFromMarker in"
  got : "    // in index.js and shouldRunCronBootstrap/featureCronsHintFromMarker in"
```

132 moved lines, **one** deliberate substitution beyond the dedent: the cron
bootstrap's comment said "See getFeatureCronsSetupHint **above**", which is no
longer above anything in the adapter file. Changed to "in index.js". No other
hand edit inside any moved block.

### 8. The one design deviation: no consolidated `registerGatewayLifecycle`

The brief specifies three exported functions, two of which bundle several
ranges that live at different points of `register()`
(`registerGatewayLifecycle` = 3 ranges, `registerFeatureCronHooks` = 2). A
single call site per function is only possible if the registrations move
relative to one another, and **the host keeps one handler list per event name,
in registration order**. Measured facts at `99d480a7`:

| event | registration order today |
|---|---|
| `gateway_start` | warm-up `5311` → bridge `7038` → cron bootstrap `7058` → control-health (`register-commands.js:621`, called from `index.js:7379`) → Neo `7497` |
| `gateway_stop` | bridge `7039` → control-health (`:622`, via `7379`) → Neo `7498` → shutdown owner `7862` |
| `before_agent_reply` | unsafe-cron guard `4545` → critical-reply handler (`register-commands.js:1141`, via `7379`) |

Consolidating the three gateway ranges at any one legal position reorders at
least one of these lists — `registerChatCommands` is called at `7379`, i.e.
between the bridge pair and the Neo pair — and
`tests/critical-review-command.test.js:418` reads the **last** registered
`before_agent_reply` handler, which is only the critical-reply handler because
the cron guard is registered 2 800 lines earlier.

Global Constraint 2 ("no behaviour change") outranks the brief's shape, so each
range keeps its own exported function and its **original call position**:

- `adapter/openclaw/register-gateway.js`: `registerNeoWorkerWarmUp`,
  `registerObsidianBridgeLifecycle`, `registerNeoServiceLifecycle`,
  `registerGatewayShutdownServices` (unchanged name, still the last statement of
  `register()`).
- `adapter/openclaw/register-cron.js`: `registerUnsafeDirectCronGuard`,
  `registerDeferredFeatureCronBootstrap`.

The brief's three test cases are kept, retargeted to the split functions, and
the reason is recorded both in the test header and in
`adapter/openclaw/README.md` under "Registration order is part of the contract".
Two consequences of the split for the brief's test fixture: the Obsidian case
needs `obsidianBridgeCfg: { watch: true }` (the real guard is `watch === true`,
not `obsidianBridgeEnabled` — that one is the enclosing `if` in `index.js` and
is not part of the moved range), and the Neo case does not pass
`startNeoService`/`stopNeoService` because the moved range *defines* them.

### 9. Files

- **`adapter/openclaw/register-gateway.js`** (new, 185 lines) — 2 import
  statements (6 names), the module-level `NEO_WORKER_WARMUP_DELAY_MS` with its
  original German comment, four exported functions.
- **`adapter/openclaw/register-cron.js`** (new, 84 lines) — 1 import, two
  exported functions.
- **`adapter/openclaw/README.md`** (new) — §10.
- **`index.js`** — `7905 → 7805` (−100): `+2` import lines, six replacement call
  sites, `−132` moved lines. `git diff --stat`: **+28 / −128**. Public export
  list untouched.
- **`tests/adapter-register-gateway.test.js`** (new, 9 tests).
- **`tests/adapter-register-cron.test.js`** (new, 4 tests) — the brief names only
  the gateway file; `register-cron.js` would otherwise ship with no test of its
  own, and the 30 000 ms / 5 000 ms bootstrap budget split is worth pinning.
- **`scripts/lib/deploy-integrity.mjs`** — the two new modules in `DEPLOY_FILES`.
- Two literal-source guards adapted, §11.

### 10. `adapter/openclaw/README.md` — contents

1. **What the adapter is** and the two lint rules that enforce it, including the
   note Task 17 asked for: the engine rule is a *text* rule, so `engine/**`
   comments may not spell `api` followed by a dot.
2. **A module table** — all nine `register-*.js` modules and what each registers.
3. **"Registration order is part of the contract"** — the three ordering facts
   from §8, the two load-bearing budgets (30 000 ms `gateway_stop`, 5 000 ms
   warm-up) with the reason each is what it is, and why
   `registerGatewayShutdownServices` must stay last (and that a regression shows
   up as a hung suite, not an assertion).
4. **"Deliberately still in `index.js` after M1a"** — a 13-row table, each row
   with its line numbers in the post-PR-03 `index.js` and the PR that owns it.
   Beyond the brief's seven rows, derived from a full AST sweep of the remaining
   47 `api` references in `register()`:
   - the `/wiki` chat command (`7377-7425`) and the local `registerPluginCommand`
     helper (`7057-7062`) — Task 16's boundary, the last chat command registered
     from `index.js`;
   - the five top-level functions that keep their own `api` parameter, with
     their declaration lines (`3320`, `3421`, `3465`, `3534`, `4244`);
   - the six user-facing command bodies that Task 16 moved into
     `register-commands.js` but that are bodies, not registrations (PR-04);
   - the bare `{ … }` grouping block (`7043` opens, `7429` closes) and what it
     still scopes;
   - `api.registerMemoryCapability` (`4458-4535`) with the actual closures that
     block it;
   - the 11 `api.config` / `api.pluginConfig` / `api.registrationMode` /
     `api.resolvePath` read sites Task 7's `createHostServices` did not cover;
   - the `registerGatewayMethod && registerCli` skill-workshop probe (`4540-4545`);
   - `skill_proposal_changed` (`5883-5949`), reply-outcome recording
     (`7501-7520`) and completion (`7645-7682`);
   - three rows correcting the brief's table, which still places the control-UI
     descriptor, the control-health pair, the critical-push claiming hooks and
     the four `lib/setup/*-plugin-runtime.js` delegations in `index.js`: Task 16
     moved all of them into `register-commands.js`.

   `classifyWorkspaceMemoryPaths`, named in the task description, is **not** in
   `index.js` at all (it lives in `lib/` and is imported directly by
   `tests/workspace-memory-provenance.test.js`), so it is not in the table.

### 11. Residue and guard adaptations

A pre-suite scan extracted every string literal (≥ 8 chars) and regex literal
from all 120 `tests/**` + `test/**` files mentioning `index.js`, and compared
occurrence counts in `index.js@99d480a7` against the patched `index.js`. Every
`N -> 0` row was read to decide whether the literal is a *source anchor* or
*runtime data*. **Two files needed adaptation:**

1. **`tests/cron-plugin-direct-dispatch-wiring.test.js`** — in "ships and
   registers only capability-gated native integration", four `indexSource`
   anchors went 1 → 0 (`force: !cronDirectDispatchReady`,
   `cronDirectDispatchReady ? 90_000 : 0`,
   `await reconcileUnsafeDirectCronsWithService(api, gatewayContext)`,
   `api.on(\s*"before_agent_reply"`). All four redirected to
   `adapter/openclaw/register-cron.js`, regexes byte-identical. The three
   anchors that did *not* move (`inspectCronNativeCapabilities(api)`,
   `cron.list({ includeDisabled: true })`,
   `Promise.resolve(cron.update(job.id`) stay pinned to `index.js`, and
   `guardUnsafeDirectCronTurn` is now asserted on **both** files — it is the
   registration in the adapter and the implementation in `index.js`.

2. **`tests/llm-result-cache-lifecycle.test.js`** — three tests:
   - "wires the real plugin dependencies into the shutdown boundary": the whole
     39-line regex redirected to `register-gateway.js`, unchanged.
   - "starts optional model preparation only after shutdown ownership and hook
     registration": this one could not be redirected, because the ordering it
     asserts is now expressed across two files. Split accordingly —
     `index.js` still decides that lifecycle ownership is taken after the last
     `api.on("before_prompt_build"` (anchor changed from
     `registerGatewayShutdown(api,` to `registerGatewayShutdownServices({`, the
     call that must stay last), and `register-gateway.js` decides that
     `registerModelPreparationServiceAfterLifecycle(api,` comes after
     `registerGatewayShutdown(api,`. Both orderings are still asserted; neither
     is weakened.
   - "routes scoped local providers through activation-owned private IPC": one
     of six assertions (`registerScopedEmbeddingIpcServiceAfterLifecycle({…})`)
     moved; redirected, the other five stay on `index.js`.

**Checked and not adapted.** The other `N -> 0` rows are runtime data, not
anchors: `"gateway_stop"` (2 → 0 in `index.js`) in eight tests that iterate
`api.handlers.get("gateway_stop")` after running `plugin.register`;
`"before_agent_reply"` in `critical-review-command.test.js:418` (same — and its
`.at(-1)` is exactly why the guard keeps its original position);
`"registerService"` and `"plur1bus-obsidian"` in
`openclaw-restricted-registration.test.js` (a capability-name list and a CLI
command name); `"plur1bus-obsidian-bridge"` in
`obsidian-bridge-runtime-wiring.test.js` (a service id asserted after a real
`plugin.register`); `"scripts/setup-feature-crons.mjs"` in two tests (a
filesystem path and a `DEPLOY_FILES` entry).

A second scan checked the *opposite* failure mode — an `assert.doesNotMatch`
that is now vacuous because its subject moved. Every `doesNotMatch` regex in
every test that mentions `index.js` was run against the two new adapter
modules; the 13 that match all have a runtime value as their subject
(`result.text`, `JSON.stringify(status)`), not a source string. No guard was
weakened.

The full suite found no further hit.

### 12. RED / GREEN (Part A)

RED, before the modules existed:

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module
  '.../adapter/openclaw/register-gateway.js'
ℹ tests 2  ℹ pass 0  ℹ fail 2
```

GREEN, first attempt: `tests 13  pass 13  fail 0`.

### 13. Gates (Part A)

| gate | result |
|---|---|
| `node --check` index.js + both new modules | silent |
| `npm run lint` | `lint-no-api-outside-adapter: clean`, `lint-engine-imports: clean (14 module(s))`, typecheck clean |
| `tests/golden-prefix.test.js` | 9/9 byte-identical; `git status --porcelain tests/fixtures/golden-prefix/expected/` → 0 files |
| `tests/index-public-exports.test.js` | 21/21 |
| `tests/deploy-integrity.test.js` | pass (two new `DEPLOY_FILES` entries) |
| gateway + cron + cron-wiring + lifecycle + critical-review + restricted-registration + b12p-reachability + bounded-cache-shutdown | 64/64 |

### 14. Full suite after Part A

```
ℹ tests 5209
ℹ pass 5206
ℹ fail 0
ℹ skipped 3
```

5196 → 5209 = the 13 new boundary tests. Required `fail 0, skipped 3` met first
try.

---

## Part B

### B1 — `chore(index): prune imports orphaned by PR-03` (`d39d49ed`)

**Method.** A TypeScript-AST pass over `index.js`: collect every local binding
introduced by an `ImportDeclaration`, then walk every other node and count
`Identifier` occurrences, **excluding** the positions that are not references —
`PropertyAccessExpression.name`, `PropertyAssignment.name`,
`MethodDeclaration.name`, `BindingElement.propertyName`, `QualifiedName.right`.
An `ExportSpecifier` name *does* count, so the frozen export list keeps its
bindings alive. A grep would have kept roughly 40 of these alive on property
positions alone.

**Result.** 481 import bindings, **243 unreferenced**. Removed: 74 whole import
declarations and 100 named specifiers = 240 bindings on the first pass; the
remaining 3 (`createConfirmation`, `transitionRecordStatus`,
`buildEdgesForSession`) were held back by a conservative "name appears inside a
JSDoc block" heuristic, checked by hand — all three are prose mentions in
comments (`Confirmation returned by createConfirmation()`), not `{Type}`
positions — and removed too. **243 removed, 238 remain, 0 unreferenced.**
`index.js` 7 805 → 7 629 lines (`+21 / −197`; the insertions are multi-line
import blocks that lost members).

**Reachability.** The import graph was walked from `index.js` before and after:
**276 modules both times, 0 lost, 0 gained** — every pruned module is still
imported by the engine or adapter module that took over its call site.
`tests/deploy-integrity.test.js` passes unchanged.

`scripts/typecheck.mjs` (checkJs) is the backstop for an import referenced only
from a JSDoc type position; it is clean.

### B2 — `test: introduce readRuntimeSources() helper` (`a1bbcd2c`)

**`tests/helpers/runtime-sources.js`**:

```js
const { index, engine, adapter, all } = readRuntimeSources();
// index   : string
// engine  : { assemblePromptContext, captureTurn, memoryTools,
//             minimalMaintenance, plur1busCommand }
// adapter : { captureHook, commands, cron, gateway, maintenanceHook,
//             promptSupplements, recallHook, tools, turnRoute }
// all     : [index, ...engine values, ...adapter values]
runtimeSourcePath("adapter/openclaw/register-commands.js") // absolute path
```

Every call re-walks `engine/` and `adapter/openclaw/` and throws if a `.js`
file on disk is not in the map, naming it — so a future module cannot quietly
fall outside every source guard. That self-check is what makes the helper worth
more than the four lines it saves per call site.

**12 files converted**, thresholds, regexes and comparisons unchanged:
`workspace-policy-runtime-gates`, `llm-result-cache-integration`,
`llm-result-cache-lifecycle`, `b13-sensitive-read-auth`,
`b13-acl-callsite-adapters`, `background-capture-skip`, `capture-chunking`,
`capture-neutral-importance`, `forget-correct-confirm`, `status-command-ctx`,
`audit-kleinkram` (uses `runtimeSourcePath`, it wants the path),
`cron-plugin-direct-dispatch-wiring`.

- `allRuntimeSources` in `workspace-policy-runtime-gates` drops the adapter, as
  instructed. Measured first: `register-commands.js` contributes **0** matches
  to all four patterns that list spans (`workspacePolicyGuard.automatic(`,
  `automaticWorkspacePolicyDecision(`, `actionKey === "workspace"`,
  `workspacePolicyDecision.reason || "workspace_disabled"`). It is now
  `[index, ...every engine module]`; the `>= 4` threshold is still met exactly
  (index 2 + minimal-maintenance 1 + assemble-prompt-context 1). The three
  registration anchors the adapter *does* own are still asserted against it
  directly.
- Six import bindings that this change orphaned were removed (`readFileSync` in
  five files, plus `readFileSync`/`dirname`/`join`/`fileURLToPath` and the now
  unused `const root` in `llm-result-cache-lifecycle`). Bindings that were
  *already* unused before this task (`mkdtempSync`, `tmpdir`, `join` in four
  files) were left alone — out of scope for a hygiene commit.
- Stale comments fixed: the b13 indentation numbers are **6 and 2** (measured in
  `register-commands.js`), down from **12 and 8** (measured in `index.js` at
  `32f71f5e`, the pre-Task-16 parent) — the comment said "8 and 2 … instead of
  14 and 8". And `tests/adapter-register-commands.test.js:42`'s message no
  longer names `index.js:9226`.

### B3 — `chore(engine): forbid bare api identifier in engine/**` (`e0fcc45a`)

**Rule 5** in `scripts/lint-engine-imports.mjs`:

```js
const BARE_API_IDENTIFIER = /(?<![.\w$])api(?![\w$])/;
```

The negative lookbehind on `.` keeps it disjoint from rule 4's
`/\.\s*api\b/`, so `host.api` is reported once, under the rule that explains
it, and `function f(api)` / `const { api } = ctx` is reported under rule 5.

Both rules now test `stripCommentsAndStrings(line)` — the existing
`stripComments` plus simple `'…'` and `"…"` literals. Template literals are
deliberately **not** stripped, so `${host.api}` is still caught. Rule 4's
effective behaviour is unchanged on the current tree (no `engine/**` line has
`.api` inside a quoted string); the string strip exists because a bare `api` in
a log message is far more likely than a dotted one. The header docblock records
the consequence: an `engine/**` comment may not spell `api` followed by a dot.

**Tests** (5 new, in the existing tmpdir fixture harness — nothing is written
into the real `engine/`):

| fixture | expectation |
|---|---|
| `engine/bare.js`: `export function h(api) { return api.on(…) }` | fail, `engine/bare.js:1`, "must not name the OpenClaw `api`" |
| `engine/ctx.js`: `const { api, host } = ctx;` | fail, `engine/ctx.js:2` |
| `engine/near.js`: `apiKey`, `rapidMode`, `openaiClient`, `apiVersion` | pass |
| `engine/prose.js`: `api` in a `//` and a `/* */` comment | pass |
| `adapter/bare-ok.js`: `export function h(api)` | pass |

RED: `tests 17 pass 15 fail 2` — exactly the two positive fixtures; the three
negatives passed before the rule existed, which is the point of having them.
GREEN: `tests 17 pass 17 fail 0`, and `lint-engine-imports: clean (14 module(s))`
on the real tree. A scan of `engine/**` for a bare `api` outside comments found
**0** occurrences before the rule was written, so no engine module needed
touching.

`adapter/openclaw/README.md`'s lint paragraph was updated in the same commit to
describe both halves of the rule, and its "still in `index.js`" table was
renumbered against the pruned `index.js` (B1 removed 176 lines, all of them
above `register()`, so every line number in that table shifted).

### Gates and full suite after B1–B3

`npm run lint`, `golden-prefix` (9/9, oracle untouched),
`index-public-exports` (21/21) and `deploy-integrity` ran green before each of
the three commits.

```
$ timeout 590 npm test
ℹ tests 5214
ℹ pass 5211
ℹ fail 0
ℹ skipped 3
```

5209 → 5214 = the five new lint fixtures. Required `fail 0, skipped 3` met. No
test deleted or skipped anywhere in the task.

---

## Concerns

- **The brief's ranges were the least reliable of the series: five of six were
  not extractable as written**, and four of those fail `node --check` outright.
  Task 17's pattern note is now load-bearing rather than advisory — the counting
  fingerprint agreed with the brief on `5296-5307`, and that range would have
  silently taken `NEO_EMBED_TIMEOUT` (read 2 400 lines later) out of `index.js`.
  Whoever writes PR-04's briefs should run the same `node --check` pass over the
  ranges *before* the brief ships; it is three lines of script.
- **The brief's three-function interface is not implementable without a
  behaviour change**, and this is the one place I deviated from the plan
  (§8). If the extraction plan wants those three names, PR-04 has to either
  accept the reordering explicitly or hoist `bridgeService` and the Neo service
  definitions to a common point first — the second is real restructuring, not a
  move, so it belongs with the `Engine` object.
- **`registerGatewayShutdownServices` being last is enforced only by a source
  guard** (`llm-result-cache-lifecycle`'s index-position check) and by the suite
  hanging if it breaks. It is now one function call rather than 39 lines, which
  makes it *easier* to move by accident. A behavioural test would need a real
  `register()` run that asserts the `gateway_stop` handler list's last entry is
  the shutdown owner; `tests/b12p-runtime-reachability.test.js` already runs the
  plugin and could carry it. Out of scope here.
- **`api.` prose in `engine/**` comments is now a hard error, including `api`
  alone.** Rule 5 fires on a bare `api` in a comment only if `stripComments`
  misses it, which it does for a `/* … */` spanning several lines (it only
  strips a block comment that opens and closes on one line). No engine module
  has one today. A future multi-line block comment in `engine/**` mentioning
  `api` will fail the lint with a confusing message; the fix is a real comment
  stripper, which I judged too much machinery for this commit.
- **`index.js` is 7 629 lines and still holds 47 `api` references** (AST count, register() only). None is a
  movable registration (§10), so PR-03 has genuinely finished; the next
  reduction has to come from the `Engine`/`Host` objects, not from relocation.
- **Two of the four commits touch tests only**, and `readRuntimeSources()` is a
  new shared test utility inside a byte-identity gate — the thing Tasks 13–17
  each declined to add. It is introduced in its own commit, after the move
  commit, so a bisect can separate "the move broke something" from "the helper
  broke something".
- No behaviour change intended or observed.
