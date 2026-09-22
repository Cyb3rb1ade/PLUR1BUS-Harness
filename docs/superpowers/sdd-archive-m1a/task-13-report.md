# Task 13 (PR-03d) report — move the recall assembly into `engine/recall/`

HEAD at start: `bd16fb53`. Commits produced: `2f38cdea` (instrument),
`153229f1` (the move).

## 1. Instrument commit — `2f38cdea`

`tools/free-identifiers.mjs`'s hand-maintained `const registerStart = 4396;`
is gone. It now derives the boundary from the source:

```js
const registerLines = [];
for (let i = 0; i < sourceLines.length; i++) {
  if (/\bregister\s*\(\s*api\b/.test(sourceLines[i])) registerLines.push(i + 1);
}
if (/(^|[\\/])index\.js$/.test(file) && registerLines.length !== 1) {
  fail(`expected exactly one \`register(api\` line in ${file}, found ${registerLines.length}`);
}
const registerStart = registerLines.length === 1 ? registerLines[0] : Number.POSITIVE_INFINITY;
```

Deliberate deviation from the literal one-liner in the task text: the
`fail(…)` (exit 2) on 0 or >1 matches is scoped to `index.js`, exactly as the
old self-check was. A bare `findIndex(...) + 1` that fails on 0 matches would
have made the analyser refuse to run on any file other than `index.js` — the
old code explicitly supported that case ("Only index.js has a `register`; for
any other file the constant is irrelevant"). For non-`index.js` files the
boundary degrades to `+Infinity`, i.e. "every module-scope declaration is
module-scope", which is the behaviour the old constant produced for small
files. `fail()` still exits 2 and the usage banner is unchanged.

Verified: analyser output on a known range unchanged; a run against
`engine/recall/minimal-maintenance.js` (a file with no `register(api`) still
works; `tests/lint-engine-imports.test.js` `tests 12, pass 12, fail 0`;
`npm run lint` clean. No test invokes the analyser (it is developer-only,
outside `package.json:files`).

## 2. Range derivation

```
$ grep -n 'register(api' index.js
4397:  register(api, registrationDependencies = {}) {

$ grep -n 'api.on("before_prompt_build"' index.js
12220:      api.on("before_prompt_build", async (event, ctx) => {   # reply-outcome (PR-03e)
12261:      api.on("before_prompt_build", async (event, ctx) => {   # ← recall (this task)

$ grep -n 'timeoutMs: runtimeScheduler.config.recallTimeoutMs' index.js
13327:      }, { timeoutMs: runtimeScheduler.config.recallTimeoutMs + 5_000 });
```

Only two registrations remain (Task 12 already moved the maintenance one).
Range: **`index.js:12261-13327`**, 1 067 lines — the brief's
`12285-13351` at `89148f9f` shifted −24 lines by Tasks 10–12. Body:
`12262-13326`, **1 065 lines**.

## 3. Analyser output

```
$ node tools/free-identifiers.mjs index.js 12261 13327
index.js:12261-13327
MODULE-SCOPE (import these): 75
ContradictionDetector InterpretationOverlayStore MAX_PROMPT_REPLY_OUTCOME_READ_BYTES
OPEN_THREADS_SHOWN_FILE OverlayGenerator addTraceDecision addTraceStoreDecision
applyGlobalInjectBudget applySemanticLensToRecall attachTraceToMemory
buildMaintenanceNudges buildMoodStyleDirective callLlm checkAccess collectOpenThreads
compressMemorySlotsForPrompt computeUseAssociative consumePlur1busStartNotice
createRecallDecisionTrace createRecallPhaseTimer createRetrievalLedgerEntry dbg
dedupeNeoLanesAgainstTexts existsSync extractMessageText filterAssociativeCandidates
filterPatternCandidates findBestPattern formatMoodFile formatNeoRecallContext
formatOpenThreadsContext formatRelevantMemoriesContext formatReminderNudge
formatTemporalContinuityContext formatTimeContext getLastActivity getPendingProposals
homedir hourInTimeZone inferEmotionalValenceAsync isBackgroundTurn isLlmRouteAvailable
join lastPresentationAgeMs libGenerateSummary listDueReminders makeQuerySummarizer
normalizeBoundedRecallInteger normalizeTopic normalizedLlmErrorClass presentReminder
readFileSync readPendingReminders readReplyOutcomeLog recordActivity
recordPendingReplyOutcome recordPresentation renameSync renderSkillProposalNudge
resolve resolveFadedThreshold resolveHostHookMemoryContext resolveMemoryRequestContext
resolveRuntimeRecallBudget routeNeoRecall runConversationReactivationRecall
runMergedNamespaceRecall sessionKeyFrom shouldSkipAutoRecallForInternalTurn
throwIfAborted unlinkSync withAccessReadDbs withLlmCallContext writeFileSync
writePendingReminders
REGISTER-SCOPE (pass via context object): 63
NEO_EMBED_TIMEOUT NEO_RECALL_PRELUDE_LOG_MS adaptiveBudgetCfg api autoRecallMinScore
automaticWorkspacePolicyDecision candidateTopK canonicalEnabled canonicalMaxItems
canonicalMinScore cfg dedupEnabled dedupJaccard detectReactionsCapabilityCached
embeddings emotionalPool gcEnabled getMemoryTurnRoutes getNeoStore host
hostRoutingLoader markNeoRecallInjection maxPromptMemories memoryAccountTopology
memoryTextContradictionLlmCfg memoryWorkspaceAliases mergingEnabled namespaceLayout
neoEnabled neoGlobalRecall neoRequester neoWorkerRuntime overlayLlmCfg
personaDirectiveMaxChars personaVoiceLlmCfg pool queryRefinerEnabled recallQueryLlmCfg
replyOutcomeDynamics replyOutcomeEnabled replyOutcomeMaxAssistantChars
replyOutcomeMaxMemoryIds rerankCandidates reranker rerankerCfg
resolveCommandLocaleRecall runMinimalBeforePromptMaintenance runNeoGlobalSearch
runtimeScheduler schicht15Enabled semanticCompressionCfg semanticLensCfg
sharedMemoryPool skillLedgerDirForAgent skillMinerEnabled softBudgetFallback
softBudgetMs summaryMaxWords temporalContextEnabled traceCfg traceEnabled traceInPrompt
workspacePolicyGuard
```

**75 / 63 vs. the plan's 76 / 62.** Both deltas are accounted for exactly. I
re-ran the analyser against `git show 89148f9f:index.js` with the original
`12285-13351` range and diffed the two key sets:

- module-scope lost `runtimeIfUsable` (Task 7 replaced `runtimeIfUsable(api)`
  with `host.runtime…` inside the block);
- register-scope gained `host` (same substitution).

No other name changed on either side. Totals are 138 free names before and
after, so the drift is exactly the documented "±host".

### Classification of the 75 module-scope names

**9 PASS-IN** (declared in `index.js` itself → context keys, Global
Constraints 8 and 9 — no declaration was moved out of `index.js`):

| name | `index.js` declaration |
|---|---|
| `MAX_PROMPT_REPLY_OUTCOME_READ_BYTES` | `:424` `const` |
| `buildMaintenanceNudges` | `:3261` `function` (public export) |
| `callLlm` | `:3838` `async function` |
| `dbg` | `:462` `function` |
| `makeQuerySummarizer` | `:790` `function` |
| `normalizeBoundedRecallInteger` | `:812` `function` |
| `normalizedLlmErrorClass` | `:695` `function` |
| `resolveRuntimeRecallBudget` | `:817` `function` |
| `runMergedNamespaceRecall` | `:851` `async function` |

`callLlm` is a trap: `index.js:341` is
`import { callLlm as callOpenAiLlm } from "./lib/llm-call.js";`, so a naive
`grep "^import .*callLlm"` reports it as an import. The *local binding* from
that line is `callOpenAiLlm`; `callLlm` is the local `async function` at
`:3838`. I classified all 75 names with the TypeScript AST (import clauses →
local binding names incl. aliases, vs. top-level declarations) rather than by
grep, which is how this was caught.

**66 IMPORT** names across 39 specifiers (`./lib/…` → `../../lib/…`,
`node:*` unchanged). Full list is the import block at the top of
`engine/recall/assemble-prompt-context.js`. None of them is on the Global
Constraint 8 forbidden list (`lib/setup/feature-profiles.js` is the only
`lib/setup/*` one and is not a `*-plugin-runtime.js`);
`scripts/lint-engine-imports.mjs` confirms: `clean (5 module(s))`.

### Engine context object: 71 keys

63 register-scope − `api` (adapter-only) = 62, plus the 9 PASS-IN names.
`api` appears zero times in the moved body (grep + `lint-no-api-outside-adapter`).

## 4. The `let` audit

The analyser lists names, not mutability, so every register-scope name was
checked for its *own* declaration inside `register()` (lines 4397–13500,
indent-aware) rather than for the first textual `grep` hit:

```
$ awk 'NR>=4397 && NR<=13500' index.js | grep -n '^\s*\(let\|var\)\s' | <filter to the 62 keys>
4436:     let cfg = resolveEffectiveConfig(rawPluginConfig);
```

**`cfg` is the only non-`const` binding among the 62.** It is reassigned
exactly once:

```
$ grep -n '^\s*cfg\s*=[^=]' index.js
4559:    cfg = providerMigration.config;
```

`4559` is ~7 700 lines *above* the registration site (`12261`), i.e. the
rebinding happens during `register()` setup, long before
`registerRecallHook({ … cfg … })` runs. Passing the value by shorthand
property is therefore safe: the handler could never observe a different `cfg`
than it does today. No getter/object wrapper needed.

Two near-misses worth recording:

- `reranker` — `grep` finds `index.js:4188 let reranker = null;` first, but
  that is inside the module-level `createRuntimeRerankerProvider()`. The
  binding this block closes over is the `const { reranker, rerankerCfg } =
  createRuntimeRerankerProvider(…)` destructuring at `:6195`. `const`.
- `cfg` — `grep` also finds `:3314 const cfg = …` inside a different
  module-level helper. Not the one in scope.

All other 60 register-scope names are `const` (or, for
`runMinimalBeforePromptMaintenance`, a `function` declaration at `:12194`).
Objects among them (`pool`, `neoGlobalRecall`, `runtimeScheduler`, the
`*Cfg`s, …) are passed by reference, so in-place mutation stays shared as
before.

## 5. Moved-block diff

Prescribed substitutions applied to `index.js:12262-13326`:

1. dedent 4 spaces (8 → 4: three levels inside `register()`/`if (autoRecall)`/
   `api.on(…)` becomes two inside `createPromptContextAssembler` /
   `assemblePromptContext`);
2. `ctx` → `hookCtx` (the hook's second parameter), via
   `s/\bctx\?\./hookCtx?./g; s/\bctx\./hookCtx./g; s/\bctx\b(?=\s*[,)\]}])/hookCtx/g`;
3. **`await import("./lib/…")` → `await import("../../lib/…")`** — see §5.3.

Verification:

```
$ diff body-expected.txt body-actual.txt && echo IDENTICAL
IDENTICAL          # 1065 / 1065 lines
```

`body-expected.txt` is the original 1 065 lines with the three substitutions
applied mechanically; `body-actual.txt` is the function body extracted from
the committed `engine/recall/assemble-prompt-context.js`. No hand edits, no
reformatting, no "improvements" to the six named blocks, their order, their
`droppable` flags or `cfg.recall?.globalInjectMaxChars ?? 17_000`.

### 5.1 Dedent safety

Before dedenting I checked the range for any multi-line string or template
literal (dedenting one changes the string's bytes, and this block produces
`prependContext`):

```
$ node <ts-ast walk over index.js, kinds matching /Template|StringLiteral|RegularExpression/ spanning >1 line within 12262-13326>
done      # zero hits
```

and that no line has fewer than 4 leading spaces:

```
$ grep -c '^ \{0,3\}[^ ]' body-orig.txt   → 0
$ grep -c '^ \+$'         body-orig.txt   → 0   (21 truly-empty lines, left empty)
```

### 5.2 `ctx` rename safety

89 whole-word `ctx` occurrences in the body. No inner declaration shadows it
(`const ctx` / `let ctx` / `(ctx…` / `{ ctx …` / `ctx:` — none). The single
`\.ctx\b` hit is `...ctx,` (the third dot of a spread), i.e. the hook
parameter, so it must be renamed too. After the perl pass, `grep '\bctx\b'`
over the body returns nothing, and the factory's own parameter `ctx` is the
only `ctx` left in the file.

### 5.3 The dynamic-import trap (not in the brief)

The free-identifier analyser reports identifiers; it cannot see module
specifiers, which are strings. The moved block contains **eight lazy
`await import("./lib/…")` calls** whose relative specifiers resolve against
the *importing file*, so they silently broke when the code moved two levels
down:

```
lib/memory-text-contradiction.js   lib/contradiction-disclosure.js
lib/temporal-provenance.js         lib/recall-confidence-framing.js
lib/persona-voice.js               lib/dream-echo.js
lib/proactive-governor.js          lib/reaction-directive.js
```

**The golden corpus did not catch this** — none of the seven scenarios
reaches those branches — and `node --check` cannot. It was caught by
`tests/deploy-integrity.test.js` ("contains every reachable relative runtime
import from index.js"), which walks the import graph and refused to resolve
`./lib/memory-text-contradiction.js` from `engine/recall/`. All eight were
rewritten to `../../lib/…` and then verified by actually importing each
specifier resolved against the engine module's URL (8/8 OK), not just by
re-running the suite.

This is the single highest-risk finding of the task and the one thing a
future mover of a large block must check by hand.

## 6. Files

- **`engine/recall/assemble-prompt-context.js`** (new, 1 201 lines) —
  39 import statements (66 names), `createPromptContextAssembler(ctx)`
  destructuring the 71 keys one per line alphabetically, returning
  `async function assemblePromptContext(event, hookCtx)` whose body is the
  1 065 moved lines. JSDoc `@param`/`@returns` added by hand.
- **`adapter/openclaw/register-recall-hook.js`** (new) — verbatim from the
  brief's Step 6 (header line reference updated to the real `index.js:13327`).
  The envelope is unchanged:
  `ctx.api.on("before_prompt_build", handler, { timeoutMs: ctx.runtimeScheduler.config.recallTimeoutMs + 5_000 })`,
  built inside the adapter at registration time.
- **`index.js`** — one new import beside `registerMaintenanceHook`'s
  (line 412), and `12261-13327` replaced by a 74-line
  `registerRecallHook({ api, …71 shorthand keys… });` at the original
  position inside `if (autoRecall) { … }`, after
  `registerTurnRouteHooks(…)`. Net −1 067/+74 lines. The public export list
  is untouched (`tests/index-public-exports.test.js` 21/21).
- **`tests/engine-assemble-prompt-context.test.js`** (new) — the brief's
  Step 3 test, with one adapted assertion (§7).
- **`scripts/lib/deploy-integrity.mjs`** — both new files added to
  `DEPLOY_FILES` (adapter and engine sections).
- **`tests/workspace-policy-runtime-gates.test.js`**,
  **`tests/llm-result-cache-integration.test.js`** — literal-source guards,
  §7.

## 7. Tests adapted

Three, all of them literal-text guards over `index.js` source that this move
made stale, all extended to span the engine module instead of being weakened.

1. **`tests/workspace-policy-runtime-gates.test.js`** — "checks automatic
   capture, recall, outcome, and maintenance paths". Task 12 had already made
   the `automaticWorkspacePolicyDecision(` count a two-file sum
   (`index.js` + `engine/recall/minimal-maintenance.js`, `>= 4`). This move
   takes a third call site out of `index.js` (now 2 there), so the sum would
   have been 3. Replaced the single `minimalMaintenanceSource` with an
   `engineSources` array (`minimal-maintenance.js`,
   `assemble-prompt-context.js`) reduced over the same regex. 2 + 1 + 1 = 4.
   The sibling assertion
   `(indexSource.match(/workspacePolicyGuard\.automatic\(/g)).length >= 2`
   still holds (index.js keeps 2 of 3), as does the literal
   `if (!workspacePolicyGuard.automatic(memoryCtx).allowed) return undefined;`
   match — index.js still has one of those and the engine module the other.
   5/5 green, no assertion loosened.

2. **`tests/llm-result-cache-integration.test.js`** — "binds every private
   index transform to its exact scope, purpose, and deterministic config"
   asserted `countMatches(source, /makeQuerySummarizer\(\s*(?:mergingEnabled\s*\?\s*)?recallQueryLlmCfg/g) === 5`.
   The recall assembly holds one of the five (`index.js:9609, 9646, 9719,
   11428` remain). Extended to the same two-file sum against
   `engine/recall/assemble-prompt-context.js`; still exactly 5, still an
   equality (not a `>=`). 22/22 green. **This one only surfaced in the full
   suite** — it is not in the task's watch list and does not mention
   workspace policy; Tasks 14–18 should grep for it too.

3. **`tests/engine-assemble-prompt-context.test.js`** — the brief's fourth
   test, "refuses a turn the workspace policy declines, without touching the
   pool", is **self-contradictory with the brief's own Step 5** and could
   never have passed as written. It detects pool access with
   `get pool() { poolTouched = true; … }`, but Step 5 prescribes
   `const { …71 keys… } = ctx;` in the factory, which *reads* `ctx.pool` (and
   so fires the getter) at `createPromptContextAssembler(…)` time — before
   the handler is ever called. Any lazier arrangement either still reads
   `pool` before the moved body's first statement, or requires rewriting the
   1 065 lines to `ctx.pool.…`, which would destroy byte-identity.
   I kept the eager destructuring (it matches Task 12's pattern and resolves
   every binding once, at registration) and moved the probe from the property
   read to the actual DB call:
   `pool: { withDb: async () => { poolTouched = true; return undefined; } }`.
   The test's name, intent and the order-dependency it guards (the first
   three statements of the moved body run before anything else) are
   unchanged; a comment in the test records why. The other three tests are
   verbatim from the brief.

No other test pins literal `index.js` text containing identifiers from this
range (verified by the full suite, twice).

## 8. RED / GREEN

RED, before `engine/recall/assemble-prompt-context.js` existed:

```
$ node --test --test-concurrency=1 tests/engine-assemble-prompt-context.test.js
Error [ERR_MODULE_NOT_FOUND]: Cannot find module
  '/home/claude/work/plur1bus-m1a/engine/recall/assemble-prompt-context.js'
  imported from .../tests/engine-assemble-prompt-context.test.js
ℹ tests 1  ℹ pass 0  ℹ fail 1
```

GREEN, after the move:

```
✔ exports a factory
✔ does not mention the OpenClaw api surface
✔ keeps the six named blocks and the 17000-char default in one place
✔ refuses a turn the workspace policy declines, without touching the pool
ℹ tests 4  ℹ pass 4  ℹ fail 0
```

## 9. Gates

| gate | result |
|---|---|
| `node --check` index.js / engine / adapter | silent |
| `npm run lint` | `lint-no-api-outside-adapter: clean`, `lint-engine-imports: clean (5 module(s))` |
| **`tests/golden-prefix.test.js`** | **`tests 9, pass 9, fail 0`** — all seven scenarios byte-identical, plus "deterministic across two fresh registrations" and "covers at least five scenarios" |
| `tests/index-public-exports.test.js` | 21 / 21 |
| `tests/deploy-integrity.test.js` | 33 / 33 |
| `tests/workspace-policy-runtime-gates.test.js` | 5 / 5 |
| `tests/engine-minimal-maintenance.test.js` | 4 / 4 |
| `tests/lint-engine-imports.test.js` | 12 / 12 |
| `tests/llm-result-cache-integration.test.js` | 22 / 22 |

Golden detail (all `produces the recorded prependContext byte for byte`):
`recall-basic`, `recall-empty-store`, `recall-knowledge-canonical`,
`recall-over-budget`, `recall-maintenance-only`, `recall-truncated`,
`recall-canonical-flagged`. The oracle was not touched.

## 10. Full suite

```
$ timeout 590 npm test > /tmp/t13.txt 2>&1
ℹ tests 5179
ℹ pass 5176
ℹ fail 0
ℹ skipped 3
```

Required `fail 0, skipped 3` met. Test count 5175 → 5179 = the four new
boundary tests; no test was deleted or skipped.

(First full run, before the §7.2 fix, was `fail 1` on
`llm-result-cache-integration.test.js`; that is a direct consequence of this
move, fixed in the same commit, as Task 12 did for its own guard.)

## 11. Concerns

- **Lazy `await import("./…")` specifiers are invisible to the analyser and
  to the golden corpus.** Eight of them were in this block and none is
  exercised by any golden scenario; only `deploy-integrity`'s import-graph
  walk caught them. Tasks 14–18 must grep their range for
  `import("./`, `new URL("./`, `require("./` and `import.meta` *before*
  trusting a green golden run. `tests/capture` and `tests/tools` ranges are
  large enough that this will recur.
- **`cfg` is a `let`.** It is safe here only because its single reassignment
  (`index.js:4559`) is far above every registration site. If a later task
  moves a block that runs *during* `register()` setup rather than in a hook
  callback, the same shorthand property would capture a stale value. The
  analyser will not warn.
- **The count-based literal-source guards keep multiplying.** Two files now
  sum identifier occurrences across `index.js` plus a growing list of engine
  modules (`workspace-policy-runtime-gates`, `llm-result-cache-integration`).
  By Task 18 that list will be long enough that a shared helper
  ("count across index.js and every `engine/**/*.js`") is worth more than
  another hand-maintained array. I did not introduce one here because it
  would be a third pattern to review inside a task whose gate is byte
  identity.
- **`createPromptContextAssembler` takes 71 keys.** That is a faithful
  reflection of the closure it replaces, not a design. PR-04 and later should
  group them (`recallConfig`, `neo`, `replyOutcome`, …) rather than let the
  list grow; changing the shape now would have put the golden gate at risk
  for no M1a benefit.
- No behaviour change intended or observed.

## 12. Pattern notes for Tasks 14–18

- `tools/free-identifiers.mjs` no longer needs re-deriving by hand
  (`2f38cdea`); if it exits 2 with "expected exactly one `register(api` line",
  `index.js` really has drifted and the message tells you what it found.
- **Classify MODULE-SCOPE names with the AST, not `grep`.** An aliased import
  (`import { callLlm as callOpenAiLlm }`) makes `grep -n "^import .*callLlm"`
  report a local `function callLlm` as an import; importing it from
  `lib/llm-call.js` would have silently bound a *different function* with the
  same name and the golden corpus would have caught it only if that path were
  exercised. Match import clauses' local binding names (incl. `propertyName as
  name`) against top-level declarations.
- **Check the range for multi-line template literals before dedenting.** A
  TS-AST walk for `Template*`/`StringLiteral` nodes spanning more than one
  line takes a minute and is the difference between "byte-identical" and a
  golden failure you will spend an hour bisecting.
- **Grep the range for relative module specifiers** (`import("./`,
  `new URL("./`, `require("./`) and rewrite them with the same `../../`
  prefix as the static imports — then *prove* they resolve by importing each
  one against the new module's URL. Neither `node --check` nor the golden
  corpus will tell you.
- **Verify the move mechanically.** Extract the original lines to a scratch
  file, apply the substitutions with the same one-liner you used on the
  module, extract the new function body back out, and `diff`. "It looks the
  same" over 1 000 lines is not a check; `IDENTICAL` is.
- **Before the full suite, grep `tests/` for every identifier your range
  moves that a test might count.** `workspace-policy-runtime-gates` is the
  documented one; `llm-result-cache-integration` was not, and cost a full
  suite run. A fast first pass:
  `grep -rln 'readSource("index.js")\|readFileSync(new URL("../index.js"' tests/`
  then grep those files for your range's identifiers.
- When such a guard trips, extend it to a cross-file **sum** and keep the
  original comparison (`=== 5`, `>= 4`); never relax it to make the move fit.
