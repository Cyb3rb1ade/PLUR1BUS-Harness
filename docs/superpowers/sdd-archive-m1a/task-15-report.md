# Task 15 (PR-03f) report — move `runPlur1busCommand` and the 17 internal job runners into `engine/commands/`

HEAD at start: `017c3335`. Commits produced: `37b9822f` (hoist the
pending-confirmation maps), `32f71f5e` (the move).

## 1. Prep commit — `37b9822f`

The brief names six thunk candidates. The AST scope walk (§4) found **twelve**
register-scope keys declared after the factory position, and two of them —
`confirmationStore` and `confirmationIndex` (`index.js:9182-9183`, `new Map()`)
— are **values, not functions**. A `(...args) => name(...args)` thunk cannot
wrap a `Map`, and a getter does not help either: the factory destructures
eagerly, so `ctx.confirmationStore` is read at `createPlur1busCommandRunner(…)`
time, i.e. still inside the TDZ.

Both Maps are read by the moved dispatcher **and** by the user-facing command
handlers that Task 16 will move (`:9659`, `:9703`, `:9732`, `:9865`, `:9919`,
`:10151`, `:10195` in the old numbering). This is the Task 14 latch lesson in
its "share an object" form: the two sides must hold the *same* two Map objects,
or the nonce index silently detaches from the record store and every
confirmation round-trip breaks. Copying is not an option and neither is a
second pair.

Fix: hoist the two declarations above the first reader, next to `callCommandLlm`
(now `index.js:7265-7266`), with a comment recording why they sit there. Two
side-effect-free `new Map()` declarations, no other statement between the old
and the new position touches them (`grep` over the whole repo: their only uses
are the dispatcher's 12 and the command handlers' 11). Suite after this commit:
command/confirmation tests 27/27, golden-prefix + command-reachability +
plur1bus-internal-auth + b13-sensitive-read-auth 38/38.

## 2. Range derivation

```
$ grep -n "const runPlur1busCommand" index.js
7271:        const runPlur1busCommand = async (commandCtx, prefixTokens = []) => {
$ awk 'NR==9055' index.js
          };
$ grep -n "runPlur1busCommand" index.js          # the three later references
9093:            runFeatureCommand: (commandCtx) => runPlur1busCommand(commandCtx),
9126:              return runPlur1busCommand(commandCtx, command.prefixTokens);
                  # + runOperatorCommand at :9056-9092 (indirect, via pluginCommandHandlers)
```

Range **`7271-9055`** (1 785 lines), body **`7272-9054`** (1 783 lines). The
brief's `7255-9044` at `89148f9f` is 1 790 lines; the −5 is pre-existing drift
from Tasks 7/10–14 inside the block (`runtimeIfUsable(api)` → `host.runtime…`),
not a mis-derived boundary. `+9` on the start line is this task's own prep
commit plus Tasks 10–14.

`index.js` keeps the binding at the original position, so `runOperatorCommand`
and the two later call sites resolve exactly as before.

## 3. Analyser output

```
$ node tools/free-identifiers.mjs index.js 7271 9055
index.js:7271-9055
MODULE-SCOPE (import these): 95
DEFAULT_TEMPERAMENTS IMPORTANCE_STATUS LLM_RESULT_CACHE_PURPOSES LLM_ROUTE_KINDS PLUGIN_KEY
__pluginDir activateSkillProposal aggregateSkillMinerRuns appendDestructiveOpLog
applyConflictViaSafeUpdate applyDropInjected applyEpistemicStatusToLanceDb applyFeatureProfile
applyTemperamentToRawConfig buildNeoDoctorReport buildRefinePatch buildRemPartitions
buildSkillReviewPayload callLlm cancelReminder classifyEncoding commandOption
completePendingConfirmation consumePlur1busStartNotice createConfirmation createNeoStore dbg
describeOwnedVaultConfirmation describeProfileDiff describeRemPartitionRun detectObsidianVaults
detectPendingFeatures findEpisodeCardPath findNeoRecord findProposalWorkspace
findResolvableConflict formatAfterthoughtCronReply formatClassifierCronReply
formatJsonCommandResult getFeatureCronsSetupHint getPendingProposals homedir isLlmRouteAvailable
isOwnedVaultConfirmed join listActiveSkills listReminders migrateLegacySharedRows
migrateNeoWorkspaces parseLegacyMigrationArgs previewDropInjected pruneGraphEdges randomUUID
readFileSync readReplyOutcomeLog rebuildEpisode recommendedProfile rejectSkillProposalWithWorkshop
rememberPendingConfirmation renameSync renderPlur1busStartStatus renderTemperamentOverview
resolutionApplyId resolutionApplyText resolveCommandVaultPath resolveConfirmationIdentity
resolveCurationRecord resolveEnvVars resolveLancedbOptimizePlan resolveNeoHooksConfig
resolveRemOutputRoot runAutoAcceptStale runCriticalClassifier runDailyConsolidation
runFeedbackAnalyzer runGcJob runOverlayAuditCommand runProactiveCheck runReflectionJob runRemDream
runReminderDispatch runSemanticDiscoveryBatches runSkillMiner safeProfile
selectSemanticDiscoveryWorkspaces showProposal summarizeLancedbOptimize summarizeNeoStore t
transitionRecordStatus withConfigLock withLlmCallContext writeEpisodeToVault writeFileSync
writeRemDreamToVault
REGISTER-SCOPE (pass via context object): 83
EMOTION_REFINE_DEADLINE_MS EMOTION_REFINE_MAX_CONSECUTIVE_FAILURES EMOTION_REFINE_MAX_ROWS
NEO_MANUAL_DRAIN_DEADLINE_MS NEO_MANUAL_DRAIN_MAX_ITEMS afterthoughtLlmCfg api baseDbPath
callCommandLlm cfg checkArgsLength checkAuth confirmationIndex confirmationStore
conflictResolutionLlmCfg createFeatureRoute createOwnerBoundMemoryStore createOwnerBoundNeoStore
createOwnerBoundTarget createPartitionScopedDb dreamEchoLlmCfg dreamNarrativeCfg
dreamNarrativeLlmCfg embeddings encodingCallLlm episodeExtractionLlmCfg flashbulbEncodingEnabled
getNeoStore host isCronCommandContext isDestructiveAction isSensitiveChatRead knownPlur1busActions
legacyMigrationShutdown memoryCompactionLlmCfg memoryDbAdapter mergingEnabled
metaCognitionLlmReport neoCfg neoEmbeddingDrainImpact neoEnabled neoGlobalRecall neoRequester
neoRoot neoWorkspaceAliases normalizedEmbeddingCfg obsidianActionNames obsidianBridgeCfg
obsidianServiceMutationPolicy openClawSkillWorkshop overlayAuditLlmCfg parsePlur1busArgs
personaEvolveMinDaysBetween personaEvolveMinOutcomes personaMaxBullets personaVoiceLlmCfg
plur1busHelp pool registeredObsidianCommandHandler remPatternLlmCfg rememberNeoWorkspace
resolveCommandLocale resolveCronMemoryContext resolveDenialLocale resolveRegisteredMemoryContext
resolveTemperamentName runCorrectCommand runCriticalCommand runFeatureToggle runForgetCommand
runMemoryCommand runStatusCommand runtimeScheduler sharedMemoryPool skillActivationDeps
skillLedgerDirsFor skillMinerAutoApplyEffective skillMinerCfg skillMinerEnabled skillMinerLlmCfg
storeMemoryFromToolParams vectorDim workspacePolicyGuard
```

**95 / 83** vs. the plan's 96 / 82 at `89148f9f`: the same ±`host` swap Task 13
documented (`runtimeIfUsable` left module-scope, `host` joined register-scope).
178 free names before and after.

### Classification of the 95 module-scope names (TS AST, not grep)

**17 PASS-IN** (declared at `index.js` top level → context keys):

| name | `index.js` declaration | |
|---|---|---|
| `__pluginDir` | `:417` `const` | |
| `aggregateSkillMinerRuns` | `:3335` `function` | |
| `applyEpistemicStatusToLanceDb` | `:2425` `export async function` | public export |
| `callLlm` | `:3840` `async function` | alias trap |
| `commandOption` | `:711` `const` | |
| `completePendingConfirmation` | `:4355` `export function` | public export |
| `dbg` | `:464` `function` | |
| `findNeoRecord` | `:3684` `function` | |
| `formatJsonCommandResult` | `:3326` `function` | |
| `getFeatureCronsSetupHint` | `:3396` `function` | |
| `rememberPendingConfirmation` | `:4326` `export function` | public export |
| `resolveConfirmationIdentity` | `:4277` `export function` | public export |
| `resolveEnvVars` | `:670` `const` | |
| `resolveNeoHooksConfig` | `:3314` `function` | takes `api`, §7 |
| `runSemanticDiscoveryBatches` | `:580` `const` | |
| `selectSemanticDiscoveryWorkspaces` | `:574` `export function` | public export |
| `summarizeNeoStore` | `:3688` `function` | |

**Five** are public exports of `index.js` (the brief predicted four; the fifth
is `selectSemanticDiscoveryWorkspaces`) — all passed, none imported, so Global
Constraint 9 is untouched.

`callLlm` is the Task 13/14 alias trap for the third time: `index.js:341` is
`import { callLlm as callOpenAiLlm } from "./lib/llm-call.js";`, so the *local*
binding from that import clause is `callOpenAiLlm`; the free `callLlm` is the
local `async function` at `:3840`. Classification was done by matching import
clauses' local binding names (incl. `propertyName as name`) against top-level
declarations, so the aliased imports in the range — `autoAcceptStale as
runAutoAcceptStale`, `runClassifier as runCriticalClassifier`, `runConsolidation
as runDailyConsolidation` — were emitted with their `as` forms. **0 mismatches,
0 UNKNOWN.**

**78 IMPORT** names across **41 specifiers** (`./lib/…` → `../../lib/…`,
`node:*` unchanged). None on the Global Constraint 8 forbidden list;
`scripts/lint-engine-imports.mjs` → `clean (8 module(s))`.

### Engine context object: 99 keys

83 register-scope − `api` = 82, plus the 17 PASS-IN = **99**.

## 4. The `let` audit — both directions

Every register-scope key was resolved to **its own** declaration with the
analyser's scope walker (extended to report the declaration kind and line),
not by first-textual-`grep`:

```
NON-CONST bindings among the 82 keys:
  api          param  :4399     (excluded from the context — adapter-only)
  cfg          let    :4438
  vectorDim    let    :5074
```

- **`cfg`** — reassigned exactly once, `index.js:4561`
  (`cfg = providerMigration.config;`). Task 13 flagged that a block evaluated
  *during* `register()` setup rather than in a hook callback could capture a
  stale `cfg`. This block **is** evaluated during setup — but at line 7271,
  2 710 lines *after* `:4561`, so the value is already final. Safe by shorthand
  property. (This is the first PR-03 move where that question had a real
  answer rather than a trivially large margin.)
- **`vectorDim`** — `let` at `:5074`, reassigned only at `:5076` and `:5081`
  inside the same dimension-resolution block, 2 190 lines above the factory
  call. Final. Safe.

All other 79 keys are `const` / `const`-destructured / a `function`
declaration (`storeMemoryFromToolParams`, `:6733`). Objects among them (`pool`,
`embeddings`, `neoWorkerRuntime`, `runtimeScheduler`, the `*Cfg`s, and the two
confirmation `Map`s) are passed by reference, so in-place mutation stays shared.

### Declared-after-the-range (the real thunk list)

```
checkArgsLength                 const  :9207
checkAuth                       const  :9203
confirmationIndex               const  :9183   ← Map, NOT thunkable (prep commit)
confirmationStore               const  :9182   ← Map, NOT thunkable (prep commit)
resolveDenialLocale             const  :9191
resolveRegisteredMemoryContext  const  :9300
runCorrectCommand               const  :9717
runCriticalCommand              const  :9946
runFeatureToggle                const  :9219
runForgetCommand                const  :9644
runMemoryCommand                const  :9607
runStatusCommand                const  :9144
```

**Twelve, not six.** The brief names only the six user-facing command bodies;
`checkAuth`, `checkArgsLength`, `resolveDenialLocale` and
`resolveRegisteredMemoryContext` are the auth/locale helpers those bodies share
and are declared in the same later region, and the two `Map`s are a different
hazard entirely (§1). The brief's own Step-1 `grep` loop *does* find all twelve
— but it finds them by first-textual-declaration, which in a 13 500-line file
is the wrong `foo` about as often as the right one; the AST walk is what makes
the list trustworthy.

All ten thunked names are referenced **only in call position** inside the moved
body (verified: `grep -n '\bname\b' body | grep -v 'name('` → empty for each),
so `(...args) => name(...args)` is arity- and default-parameter-faithful.

### Reverse direction (Task 14's second lesson)

The moved range is the body of a single function expression. Nothing declared
inside it can be referenced from outside — the only binding the range
introduces into `register()`'s scope is `runPlur1busCommand` itself, which is
preserved verbatim at the original position. Confirmed structurally and by
`node scripts/typecheck.mjs` (part of `npm run lint`) plus the full suite.

## 5. Moved-block diff

Prescribed substitutions applied to `index.js:7272-9054`:

1. dedent 8 spaces (12 → 4: three levels inside `register()` /
   `if (typeof api.registerCommand === "function")` / the arrow becomes two
   inside `createPlur1busCommandRunner` / `runPlur1busCommand`);
2. `await import("./lib/…")` → `await import("../../lib/…")`;
3. `resolveNeoHooksConfig(api, commandCtx.config)` →
   `resolveNeoHooksConfig(commandCtx.config)` (§7).

```
$ diff body-expected.txt body-actual.txt && echo IDENTICAL
IDENTICAL          # 1783 / 1783 lines
```

`body-expected.txt` is the original 1 783 lines with the three substitutions
applied mechanically; `body-actual.txt` is the function body extracted back out
of the committed `engine/commands/plur1bus-command.js`. No hand edits.

**Residue beyond the dedent — exactly six lines**
(`diff body-dedent.txt body-expected.txt`):

```
639  await import("./lib/jobs/skill-miner/benefit-backfill.js")  → "../../lib/…"
666  await import("./lib/afterthought.js")                       → "../../lib/…"
692  await import("./lib/persona-voice.js")                      → "../../lib/…"
1079 await import("./lib/persona-voice.js")                      → "../../lib/…"
1498 resolveNeoHooksConfig(api, commandCtx.config)               → resolveNeoHooksConfig(commandCtx.config)
1746 await import("./lib/dreaming/rem-dream.js")                 → "../../lib/…"
```

`index.js` diff: **+107 / −1 785** (the 99-key factory call plus a 6-line
comment at the original position) **+1** import.

### 5.1 Dedent safety

TS-AST walk for `Template*` / `StringLiteral` / `RegularExpression` nodes
spanning more than one line inside `7272-9054`: **zero hits**. No line has fewer
than 12 leading spaces (`grep -c '^ \{0,11\}[^ ]'` → 0); zero whitespace-only
lines; the 11 blank lines are truly empty and the dedent skips them.

### 5.2 `ctx` — no rename needed

Two `\bctx\b` occurrences in the body, both **property names**
(`ctx: memoryCtx,` at body lines 1374 and 1413), not references. The factory
parameter `ctx` is therefore not shadowed and not shadowing; unlike Tasks 13/14
this move needed no `ctx` → `hookCtx` pass.

### 5.3 `this` / `arguments`

Zero occurrences outside strings and comments, so the arrow function converts
to a named `function` declaration (`return async function runPlur1busCommand(…)`)
without semantic change. The name also gives the new test's
`source.slice(source.indexOf("return async function"))` probe its anchor.

### 5.4 Dynamic-import trap — present, five hits

Task 13's §11 warning fires again. Five relative `await import("./lib/…")`
specifiers in 1 783 lines (plus one bare `node:child_process`, unaffected). All
five were rewritten to `../../lib/…` and then **proved** to resolve by importing
each one against the engine module's URL:

```
OK ../../lib/jobs/skill-miner/benefit-backfill.js
OK ../../lib/afterthought.js
OK ../../lib/persona-voice.js
OK ../../lib/dreaming/rem-dream.js
```

None of these branches is reached by the golden corpus.
`tests/deploy-integrity.test.js` (33/33) confirms the import graph resolves.

## 6. Thunk list — what Task 16 must return

`index.js:7272-7377` now reads:

```js
        const runPlur1busCommand = createPlur1busCommandRunner({
          …,
          checkArgsLength: (...args) => checkArgsLength(...args),
          checkAuth: (...args) => checkAuth(...args),
          resolveDenialLocale: (...args) => resolveDenialLocale(...args),
          resolveRegisteredMemoryContext: (...args) => resolveRegisteredMemoryContext(...args),
          runCorrectCommand: (...args) => runCorrectCommand(...args),
          runCriticalCommand: (...args) => runCriticalCommand(...args),
          runFeatureToggle: (...args) => runFeatureToggle(...args),
          runForgetCommand: (...args) => runForgetCommand(...args),
          runMemoryCommand: (...args) => runMemoryCommand(...args),
          runStatusCommand: (...args) => runStatusCommand(...args),
          resolveNeoHooksConfig: (commandConfig) => resolveNeoHooksConfig(api, commandConfig),
          …
        });
```

**Task 16 owns exactly these ten thunk names.** Every one of them is a
declaration Task 16 will move out of `index.js`. When it does:

- if the declaration moves into the *same* engine module as its caller, delete
  the thunk and the ctx key together;
- if it moves into a *different* engine module, the thunk stays but its target
  becomes that module's exported factory result — and it must stay a thunk
  unless the new binding is created before line 7272;
- **never** drop the thunk and pass the name directly while the declaration is
  still below the factory call: that is a `ReferenceError: Cannot access '…'
  before initialization` at registration, and it fires on plugin load, not in a
  test that happens to exercise the branch.

`confirmationStore` / `confirmationIndex` are *not* thunks — they are the two
shared `Map`s the prep commit hoisted. Task 16 must keep them as one pair of
objects for both sides.

## 7. The `api` read the brief does not cover

The moved body contains exactly one `api` reference (grep `\bapi\b` over the
1 783 lines → one hit; **zero** `api.` member reads, so the brief's own test
regex would have let it through):

```js
config: { ...neoCfg, hooks: resolveNeoHooksConfig(api, commandCtx.config) },
```

`resolveNeoHooksConfig` is an `index.js` top-level `function` (`:3314`) that
takes the OpenClaw plugin handle as its first parameter — it calls
`runtimeIfUsable(api)` and `api?.logger?.warn?.(…)`, and
`tests/index-host-logger.test.js:61` explicitly exempts it from the PR-02b
`host` migration because `host` does not exist in its scope. It cannot move and
its signature cannot change here.

Resolution, per the task instruction ("that read must come through the ctx as a
named capability and you report it"): the ctx key `resolveNeoHooksConfig` is
**pre-bound to `api` in `index.js`** —

```js
resolveNeoHooksConfig: (commandConfig) => resolveNeoHooksConfig(api, commandConfig),
```

— and the single body line drops its first argument. The engine module never
sees the plugin handle: `grep '\bapi\b' engine/commands/plur1bus-command.js`
returns nothing, `lint-no-api-outside-adapter` is clean, and the new test's
`doesNotMatch(/(?<![.\w$/-])api\s*\./)` passes for the right reason rather than
by accident.

This is the one arity change in the move and the only substitution that is not
purely mechanical. Flagging it rather than asking mid-task: the alternative
(passing `api` under a neutral ctx name) would launder an OpenClaw handle into
`engine/**` and defeat Global Constraint 8's intent, and every other option
would have edited the 1 783 lines.

## 8. Files

- **`engine/commands/plur1bus-command.js`** (new, 1 948 lines) — 41 import
  statements (78 names; `node:*` first, then `../../lib/…`, both alphabetical),
  `createPlur1busCommandRunner(ctx)` destructuring the 99 keys one per line
  alphabetically, then
  `return async function runPlur1busCommand(commandCtx, prefixTokens = [])`
  whose body is the 1 783 moved lines. JSDoc `@param`/`@returns` by hand.
- **`index.js`** — one import beside `registerCaptureHook`'s (line 414); the
  two hoisted `Map`s at `:7265-7266` (prep commit); `7271-9055` replaced by the
  107-line `createPlur1busCommandRunner({ … });` at the original position.
  Public export list untouched (`tests/index-public-exports.test.js` 21/21).
- **`tests/engine-plur1bus-command.test.js`** (new) — the brief's Step 2 test,
  **verbatim, no adaptation**. The fourth assertion's
  `source.slice(indexOf("return async function"))` probe works because the
  converted arrow is a named function declaration (§5.3); `checkAuth` is at body
  line 17 and `actionKey === "internal"` at body line 193.
- **`scripts/lib/deploy-integrity.mjs`** — `engine/commands/plur1bus-command.js`
  added to `DEPLOY_FILES`.
- Two literal-source guards, §9.

## 9. Tests adapted

The guard scan was run **before** the full suite, per Task 14's pattern note:
19 test files read `index.js` as text; every string literal ≥ 8 chars and every
regex literal ≥ 6 chars was extracted from each with the TS AST and counted
against `index.js` and against the extracted body, printing `before -> after`.
That produced 4 true hits in 2 files and a long tail of false positives
(literals used as runtime test data, or anchors that keep occurrences in
`index.js`). Both files were extended/redirected; no assertion was weakened.

1. **`tests/workspace-policy-runtime-gates.test.js`** — one test, three
   assertions.
   - `/actionKey === "workspace"/` and
     `/workspacePolicyDecision\.reason \|\| "workspace_disabled"/` each went
     **1 → 0** in `index.js` (the whole `workspace` action branch is inside the
     dispatcher). Both `assert.match(indexSource, …)` became
     `assert.ok(allRuntimeSources.some(…))` with the **identical regex** — the
     Task 14 "anchor left index.js entirely → redirect, don't sum" rule.
   - `/text: "NO_REPLY"/` went 2 → 1 (the surviving one is `runOperatorCommand`),
     so it stays pinned to `indexSource`; a comment records why.
   - `engine/commands/plur1bus-command.js` added to `engineSources`. The two
     count-based sums are **unaffected**: `workspacePolicyGuard.automatic(`
     has 0 occurrences in the moved body (index keeps its 1, sum still ≥ 2), and
     `automaticWorkspacePolicyDecision(` likewise 0 (2 + 1 + 1 + 0 + 0 = 4,
     comparison kept at `>= 4`). 5 / 5.

2. **`tests/b13-sensitive-read-auth.test.js`** — three of its ten tests. This
   file is the dispatcher's classification guard and took the brunt.
   - *"classifies every non-Obsidian dispatched action explicitly"*:
     `[...source.matchAll(/if \(action(?:Key)? === "([a-z-]+)"/g)]` went
     **37 → 6** in `index.js`, and the test's own anti-vacuity check
     (`observed.size > 15`) would have failed. `source` is now the
     concatenation of `index.js` and the engine module; the regex, the five
     classification sets and the `exactly one dispatch class` assertion are
     byte-identical.
   - *"keeps public help and B14 delegation ahead of the general Neo store"*:
     every anchor left `index.js` — `const cronInternal` 1 → 0,
     `const commandStore = getNeoStore({` 1 → 0, `actionKey === "obsidian"`
     2 → 0, the `skills`/`neo` guards 1 → 0 each. With `indexOf` returning −1
     the three ordering assertions would have compared `-1 < -1`. Redirected
     whole to the engine module, dispatcher anchor
     `"return async function runPlur1busCommand"`. Offsets after the redirect:
     obsidian 8 904, skills 14 058, neo 14 385, general store 18 373 — three
     genuinely ordered assertions.
     **Pre-existing defect preserved, not fixed:** the fourth assertion,
     `source.indexOf("handleObsidianBridgeCommand", dispatcher) < generalStoreAt`,
     was **already vacuous before this task** — the dispatcher calls
     `registeredObsidianCommandHandler` (the injectable alias), and all four
     `handleObsidianBridgeCommand` occurrences in `index.js` are at `:115`,
     `:4407`, `:4416`, `:4417`, i.e. *above* the dispatcher, so `indexOf` from
     the dispatcher offset returned −1 and `-1 < 18373` passed for free. It
     still returns −1 against the engine module, so the test's meaning is
     unchanged. Repointing it at `registeredObsidianCommandHandler` would
     *strengthen* the guard; I left it, because this task's gate is faithful
     relocation and a strengthened assertion here belongs in a change that owns
     the B14 delegation contract.
   - *"uses only canonical workspace fields for the general Neo store"*: same
     two anchors, same 1 → 0. Redirected to the engine module; the three
     assertions (`workspaceDir: memoryCtx?.workspaceDir || ""`, no
     `workspaceKey:`, no `commandCtx.workspace(Key|Dir)`) are unchanged.
   9 / 9 after (one test in the file is a long runtime matrix, 3.2 s).

**Checked and *not* adapted**, because every anchor keeps at least one
occurrence in `index.js`: `b13-acl-callsite-adapters` (`checkAuth(memoryCtx, {
destructive: true, …})` 24 → 6; `const checkAuth = async (…)`,
`const runStatusCommand = async (…)`, `const memoryCtx = await
resolveRegisteredMemoryContext(commandCtx)` 1 → 1 / 2 → 2 — all still in the
Task 16 region), `llm-result-cache-integration` (all eight `sourceSection`
anchors are outside `7271-9055`; the `makeQuerySummarizer` sum is still exactly
5 — that identifier is absent from this range), `index-host-logger`
(`host.runtime` 27 → 22, no `api.logger` in the moved body),
`forget-correct-confirm`, `memory-host-runtime`, `platform-callsites`,
`status-command-ctx`, `skill-workshop-actor-tier`, `audit-kleinkram`,
`config-audit`, `llm-error-hygiene`, `llm-result-cache-lifecycle`,
`neo-vector-sidecar`, `background-capture-skip`, `capture-chunking`,
`cron-plugin-direct-dispatch-wiring`, `code-index-ts-source`. The full suite
found no further hit — the pre-suite scan caught them all this time.

## 10. RED / GREEN

RED, before `engine/commands/plur1bus-command.js` existed:

```
$ node --test --test-concurrency=1 tests/engine-plur1bus-command.test.js
Error [ERR_MODULE_NOT_FOUND]: Cannot find module
  '/home/claude/work/plur1bus-m1a/engine/commands/plur1bus-command.js'
  imported from .../tests/engine-plur1bus-command.test.js
ℹ tests 1  ℹ pass 0  ℹ fail 1
```

GREEN, after the move:

```
✔ exports a factory
✔ does not mention the OpenClaw api surface
✔ still handles all 17 internal job names
✔ checks authorization before dispatching an action
ℹ tests 4  ℹ pass 4  ℹ fail 0
```

All 17 job literals survive (occurrence counts in the moved body:
`consolidate-daily` 4, `classify-recent` 4, `auto-accept-stale` 3, `rem-dream`
5, `skill-miner` 5, `skill-benefit-backfill` 4, `afterthought` 5,
`persona-evolve` 4, `reminder-dispatch` 3, `discover-semantic-links` 4,
`gc-run` 4, `embedding-drain` 5, `emotion-refine` 3, `feedback-report` 4,
`proactive-check` 4, `meta-reflect` 4, `episodes-rebuild` 5).

## 11. Gates

| gate | result |
|---|---|
| `node --check` index.js / engine module | silent |
| `npm run lint` | `lint-no-api-outside-adapter: clean`, `lint-engine-imports: clean (8 module(s))`, typecheck clean |
| **`tests/golden-prefix.test.js`** | **9 / 9** — all seven scenarios byte-identical; oracle untouched (`git diff 017c3335 -- tests/fixtures/golden-prefix/expected/` → 0 files) |
| `tests/index-public-exports.test.js` | 21 / 21 |
| `tests/deploy-integrity.test.js` | 33 / 33 |
| `tests/engine-plur1bus-command.test.js` | 4 / 4 |
| `tests/command-reachability.test.js` + `plur1bus-internal-auth` + `b14-command-policy` + `feature-toggle` + `emotion-refine-cron` + `classifier-cron-partial-failure` | 44 / 44 |
| `tests/workspace-policy-runtime-gates.test.js` | 5 / 5 |
| `tests/b13-sensitive-read-auth.test.js` | 9 / 9 |
| `tests/b13-acl-callsite-adapters.test.js` + `llm-result-cache-integration` | 41 / 41 |
| `tests/forget-correct-confirm` + `b14-semantic-confirmation` + `skill-review-confirm-path` (prep commit) | 27 / 27 |

## 12. Full suite

```
$ timeout 590 npm test > /tmp/t15.txt 2>&1
ℹ tests 5187
ℹ pass 5184
ℹ fail 0
ℹ skipped 3
```

Required `fail 0, skipped 3` met, on the first attempt. 5183 → 5187 = the four
new boundary tests; no test deleted or skipped.

## 13. Concerns

- **The thunk list was twice the brief's, and two of its entries were not
  thunkable.** Nothing in the analyser output distinguishes a later-declared
  function from a later-declared `Map`. Tasks 16–18 must run the
  declaration-kind walk (§4) over *all* keys and then read every
  `AFTER-RANGE` hit, because the fix differs by kind: function → thunk, shared
  object → hoist the declaration, value copy → never.
- **`resolveNeoHooksConfig` is the first genuine `api` leak into `engine/**`**
  (§7) and it is invisible to both the brief's test regex and
  `lint-no-api-outside-adapter`, because the handle is passed as a *value*, not
  dereferenced. Both guards only look for `api.`. A one-line addition to
  `scripts/lint-no-api-outside-adapter.mjs` — a bare-identifier `\bapi\b` check
  for `engine/**` only — would have caught it mechanically; I did not add it in
  this task because a new lint rule is a second thing to review inside a
  byte-identity gate, and because `index.js` legitimately passes `api` around.
  Recommended for PR-04.
- **`cfg` is a `let` and this is the first block that reads it during
  `register()` setup.** It is safe here (§4), but the margin is 2 710 lines
  rather than Task 13's 7 700, and Task 16's blocks are *closer still* to
  `:4561`. The analyser will not warn.
- **`createPlur1busCommandRunner` takes 99 keys.** Same note as Task 13's 71 and
  Task 14's 57 — a faithful reflection of the closure, not a design. PR-04
  should group them (`jobs`, `neo`, `obsidian`, `skills`, `llmCfgs`, …).
- **The literal-source guards now span five files and four engine modules.**
  `workspace-policy-runtime-gates` reduces over `index.js` + 4 engine modules;
  `b13-sensitive-read-auth` now *concatenates* two sources in one test and
  *redirects* two more. Tasks 13 and 14 both recommended a shared
  `readRuntimeSources()` helper; after this task the hand-maintained arrays are
  clearly the larger risk, and I would put that helper in before Task 17.
  I again did not add it, for the same reason both predecessors gave.
- **One pre-existing vacuous assertion carried over verbatim** (§9.2,
  `handleObsidianBridgeCommand`). It was vacuous before the move and is vacuous
  after; flagged here so nobody later reads the redirect as its cause.
- **`index.js` now carries ~40 more dead import bindings** (`runRemDream`,
  `runGcJob`, `runSkillMiner`, `migrateLegacySharedRows`, … each down to its
  own import line). Task 13 and 14 left theirs the same way; the single
  end-of-PR-03 cleanup commit is still the right place, gated on
  `deploy-integrity` and the golden corpus.
- No behaviour change intended or observed.

## 14. Pattern notes for Tasks 16–18

- **The AST declaration-kind walk is now the mandatory first step, not the
  `let` audit's optional refinement.** Extend `tools/free-identifiers.mjs`'s
  walker to carry `{ line, kind }` instead of `line` (≈ 25 lines) and print, for
  every register-scope key, `name kind :line AFTER-RANGE?`. That single output
  answers the thunk question, the `let` question and the shared-object question
  at once. The brief's `grep -nE "^\s*(const|let|function)\s+$n\b"` loop finds
  the right count here only by luck.
- **Classify an `AFTER-RANGE` hit by kind before reaching for a thunk.** A
  later-declared *function* gets `name: (...args) => name(...args)`. A
  later-declared *object that both sides mutate* gets its declaration hoisted
  above the factory call, in its own commit, with a comment. A later-declared
  *scalar* would need the Task 14 shared-state-object treatment. Getters do not
  help for any of them, because the factory destructures eagerly.
- **Verify a thunk target is only ever called, never passed.** `grep -n '\bname\b'
  body | grep -v 'name('` must be empty; a thunk changes function identity and
  `.length`, so a name used as a value is not thunkable either.
- **Grep the range for a bare `api` identifier, not just `api.`.** Both the
  briefs' tests and `lint-no-api-outside-adapter` use
  `(?<![.\w$/-])api\s*\.`, which is blind to `f(api, …)`. One hit in 1 783
  lines here, and it would have shipped an OpenClaw handle into `engine/**`
  with every gate green.
- **Two `ctx` occurrences can be zero references.** Check whether the hits are
  property *names* (`ctx: x`) before writing a rename pass; this range needed
  none, unlike Tasks 13 and 14.
- **Convert the arrow to a *named* function declaration.** `return async
  function runPlur1busCommand(…)` costs nothing when there is no `this` /
  `arguments`, and it is what makes the brief's
  `source.slice(indexOf("return async function"))` probe and the redirected
  `b13-sensitive-read-auth` dispatcher anchor work.
- **Run the pre-suite literal scan with a *delta* column** (`before -> after`),
  not a boolean "appears in the body". The 1 → 0 rows are the breakages; the
  N → M rows are the ones to reason about; everything else is noise. That
  ordering turned 19 candidate files into 2 real ones in a single pass and cost
  no suite run.
- **Diff the dedent-only text against the substituted text** before diffing the
  substituted text against the extracted module body. The first diff is the
  audit trail of what you changed on purpose (six lines here); the second is
  the proof you changed nothing else.
