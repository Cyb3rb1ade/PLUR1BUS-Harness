# Task 14 (PR-03e) report — move auto-capture into `engine/capture/`

HEAD at start: `153229f1`. Commits produced: `d59f6e28` (shared meta-reflection
state), `017c3335` (the move).

## 1. State-object commit — `d59f6e28`

The brief's blanket `perl -pi -e 's/\bsessionCountSinceReflection\b/…/g'` would
have produced a **syntax error**, not just a damaged persisted-state property:
`index.js:10861` writes the file with *shorthand* properties,

```js
writeFileSync(metaStatePath, JSON.stringify({ sessionCountSinceReflection, lastReflectionAt }, null, 2));
```

and `{ metaReflectionState.sessionCount, … }` is not a valid object literal.
I therefore did all eight sites by hand.

Before (`index.js:5054-5061`, `:10839-10860`) → after:

| site | before | after |
|---|---|---|
| `:5054-5055` | `let sessionCountSinceReflection = 0;` / `let lastReflectionAt = 0;` | `const metaReflectionState = { sessionCount: 0, lastAt: 0 };` + 2-line comment |
| `:5060-5061` | `sessionCountSinceReflection = metaState.sessionCountSinceReflection \|\| 0;` … | `metaReflectionState.sessionCount = metaState.sessionCountSinceReflection \|\| 0;` … |
| `:10839` | `sessionCountSinceReflection++;` | `metaReflectionState.sessionCount++;` |
| `:10841`, `:10843` | args to `shouldTriggerReflection(…)` | `metaReflectionState.sessionCount` / `.lastAt` |
| `:10857-10858` | `sessionCountSinceReflection = 0;` / `lastReflectionAt = Date.now();` | `metaReflectionState.sessionCount = 0;` / `.lastAt = Date.now();` |
| `:10860` | `JSON.stringify({ sessionCountSinceReflection, lastReflectionAt }, …)` | `JSON.stringify({ sessionCountSinceReflection: metaReflectionState.sessionCount, lastReflectionAt: metaReflectionState.lastAt }, …)` |

The **persisted JSON keys are unchanged** (`sessionCountSinceReflection`,
`lastReflectionAt`), which is what `tests/openclaw-default-llm-callers.test.js:861-862`
asserts after driving a real `agent_end` turn to a reflection. The only
remaining occurrences of the two old names in the whole repo are
`metaState.<name>` reads and those two literal JSON keys:

```
$ grep -rn "sessionCountSinceReflection\|lastReflectionAt" --include=*.js . | grep -v node_modules
index.js:5061 5062 10861      (metaState.* reads + the stringify keys)
tests/openclaw-default-llm-callers.test.js:861 862   (persisted-file assertions)
```

Suite after this commit: **`tests 5179, pass 5176, fail 0, skipped 3`** —
identical to the Task 13 baseline.

## 2. Range derivation

```
$ grep -n 'api.on("agent_end"' index.js
10360:      api.on("agent_end", async (event, ctx) => {    # ← capture (this task)
11310:      api.on("agent_end", (event, ctx) => {           # reply-outcome, untouched
$ awk 'NR==11305' index.js
      }, { timeoutMs: 60_000 });
```

Registration **`10360-11305`** (946 lines, exactly the brief's count at
`89148f9f`; +6 from Tasks 10–13 and the state commit). Body **`10361-11304`**,
944 lines.

**Moved range extended to `10357-11305`** (949 lines) to take the two
warning latches with it — see §4.

## 3. Analyser output

```
$ node tools/free-identifiers.mjs index.js 10360 11305
index.js:10360-11305
MODULE-SCOPE (import these): 51
EPISODED_TURN_ID_MEMORY IMPORTANCE_STATUS MAX_POSTPROCESSING_RETRIES applyDynamicsDefaults
buildEdgesForSession buildEpisodeAnchorEdges callLlm categorizeMemoryWithReason
createGraphMetrics createNeoStore decideEpistemicStatusForCapture deriveBudgetedSignal
expandForCapture extractEpisodesWithState extractGraphSignals extractMediaOutputIds
filterAlreadyEpisoded generateSummary isAbortError isBackgroundTurn isBudgetExhaustion
isInjectedContextText isLlmRouteAvailable join lightDream mergeEpisodedTurnIds
planReminderExtraction randomUUID readBoundGraph readFileSync resolveMemoryRequestContext
resolveWatermarkAdvance runReflectionJob runSpeakerProposalPipeline saveReminder
serializeEmotionalValence shouldSkipAutoCaptureForInternalTurn shouldTriggerReflection
stripMediaOutputIdToken summarizeForCapture textSuggestsGroupOrigin throwIfAborted
trySafeWarn turnEventsFromMessages turnIdentityParams waitForTimeoutSettlement
withLlmCallContext writeEpisodeToVault writeFileSync writeGraphConstellationReport
writeLightDreamToVault
REGISTER-SCOPE (pass via context object): 52
NEO_HOOK_DRAIN_MARGIN_MS NEO_HOOK_DRAIN_MIN_MS api baseDbPath captureSummaryLlmCfg cfg
classifyEmotionForStore classifyHostIncognitoSession conversationInsightsLlmCfg
dreamEchoLlmCfg dreamNarrativeCfg dreamNarrativeLlmCfg duplicateThreshold embeddings
emotionIntensityHalfLifeFactor emotionalPool episodeExtractionLlmCfg epistemicCutoffBoot
flashbulbEncodingEnabled getNeoStore halfLifeOverrides host memoryWorkspaceAliases
mergingEnabled metaCognitionEnabled metaCognitionIntervalMs metaCognitionLlmReport
metaCognitionSessionThreshold metaReflectionState neoAgentEndBudgetMs neoCfg
neoEmbeddingAutoDrainEnabled neoEmbeddingDrainImpact neoEmbeddingDrainMaxItems neoEnabled
neoRoot neoWorkerRuntime neoWorkspaceAliases personaVoiceLlmCfg pool rememberNeoWorkspace
reminderAutoExtract resolveTemperamentName runtimeScheduler skillMinerEnabled
snapshotNeoMessages snapshotNeoString summaryMaxWords vectorDim
warnedIncognitoClassifierDegraded warnedMissingCaptureSessionKey workspacePolicyGuard
```

**51 / 52 — exactly the brief's numbers.** `metaReflectionState` is present;
`sessionCountSinceReflection` and `lastReflectionAt` are gone, as required.

### Classification of the 51 module-scope names (TS AST, not grep)

**8 PASS-IN** (top-level declarations in `index.js` → context keys):

| name | `index.js` declaration |
|---|---|
| `EPISODED_TURN_ID_MEMORY` | `:430` `const` |
| `MAX_POSTPROCESSING_RETRIES` | `:434` `const` |
| `callLlm` | `:3839` `async function` |
| `generateSummary` | `:719` `const` |
| `runSpeakerProposalPipeline` | `:469` `async function` |
| `summarizeForCapture` | `:754` `async function` |
| `textSuggestsGroupOrigin` | `:3696` `function` |
| `waitForTimeoutSettlement` | `:1009` `async function` |

Two alias traps, both caught by the AST pass and both resolved as PASS-IN:

- `callLlm` — the Task 13 trap recurs verbatim. `index.js:341` is
  `import { callLlm as callOpenAiLlm } from "./lib/llm-call.js";`; the free
  `callLlm` is the local `async function` at `:3839`.
- `generateSummary` — the *mirror image*. `index.js:40` imports
  `generateSummary as libGenerateSummary`, and `:719` declares
  `const generateSummary = libGenerateSummary;` ("re-export für Tests").
  Importing `generateSummary` from `../../lib/text-utils.js` would bind the
  same function object today, but the classification rule is scope-based, not
  value-based: an index.js top-level declaration is a ctx key. Passed in.
  (Task 13's range saw `libGenerateSummary` instead and correctly imported it —
  the two modules resolve the same underlying function by different routes,
  which is faithful to the two closures they replace.)

**43 IMPORT** names across **25 specifiers** (`./lib/…` → `../../lib/…`,
`node:*` unchanged). None on the Global Constraint 8 forbidden list;
`scripts/lint-engine-imports.mjs` → `clean (7 module(s))`.

### Engine context object: 57 keys

52 register-scope − `api` − `warnedMissingCaptureSessionKey` −
`warnedIncognitoClassifierDegraded` = 49, plus the 8 PASS-IN = **57**.
`api` appears **zero** times in the 944-line body (grep + the new test's
`doesNotMatch(/(?<![.\w$/-])api\s*\./)` + `lint-no-api-outside-adapter`), so it
is adapter-only.

## 4. The `let` audit — and a second mutable-state hazard the brief misses

Every register-scope key was resolved to its *own* declaration inside
`register()` (AST walk over the method's span, `4398-12399`, matching
`VariableStatement` / `FunctionDeclaration` names rather than the first
textual grep hit). Result:

```
NON-CONST bindings among the keys:
  cfg: 4437 let
  vectorDim: 5073 let
```

- **`cfg`** — reassigned exactly once, `index.js:4560` (`cfg = providerMigration.config;`),
  ~5 800 lines above the registration site. Safe by shorthand property, same
  argument as Task 13.
- **`vectorDim`** — `let vectorDim = dimensions;` at `:5073`, reassigned only at
  `:5075` and `:5080`, i.e. inside the same 9-line dimension-resolution block,
  ~5 300 lines above the registration. Final long before
  `registerCaptureHook({ … })` runs. Safe.

All other 47 keys are `const` (or `const`-destructured). Objects among them
(`pool`, `embeddings`, `neoWorkerRuntime`, `runtimeScheduler`, the `*Cfg`s,
`metaReflectionState`) are passed by reference, so in-place mutation stays
shared exactly as before.

### The hazard the brief does not name

The analyser lists **`warnedMissingCaptureSessionKey`** and
**`warnedIncognitoClassifierDegraded`** as register-scope keys. They are
`let` bindings at `index.js:10357-10358` — *inside* `if (autoCapture) {`,
three lines above the registration — and they are **rebound at turn time**
inside the moved body (lines 16-17 and 24-25 of the body):

```js
if (!warnedIncognitoClassifierDegraded) {
  warnedIncognitoClassifierDegraded = true;      // one-shot warning latch
  …
} else if (!warnedMissingCaptureSessionKey) {
  warnedMissingCaptureSessionKey = true;
```

Passing them through the context object by value would have re-armed both
latches on **every turn**, turning two one-shot warnings into per-turn log
spam — the exact failure mode the brief warns about for the meta-reflection
counters, in a pair of names the brief never mentions. No test covers it and
the golden corpus does not reach capture.

They are declared and used **only** inside the moved block (verified by grep
across the whole repo), so the correct fix is not another shared object but to
move the declarations *with* the code: they now live in `createTurnCapture`'s
own scope, above the returned handler. Per registration, mutable, private —
byte-for-byte the same closure as before. This is why the moved range is
`10357-11305` rather than `10360-11305`.

## 5. Moved-block diff

Prescribed substitutions applied to `index.js:10361-11304`:

1. dedent 4 spaces (8 → 4: three levels inside `register()`/`if (autoCapture)`/
   `api.on(…)` becomes two inside `createTurnCapture` / `captureTurn`);
2. `ctx` → `hookCtx`, via `s/\bctx\b/hookCtx/g`.

No third substitution was needed — see §5.3.

```
$ diff /tmp/cap-body-expected.txt /tmp/cap-body-actual.txt && echo IDENTICAL
IDENTICAL          # 944 / 944 lines
```

`cap-body-expected.txt` is the original 944 lines with the two substitutions
applied mechanically; `cap-body-actual.txt` is the function body extracted back
out of the committed `engine/capture/capture-turn.js`. No hand edits, no
reformatting. `index.js` diff is **+61 / −949** (60-line
`registerCaptureHook({ api, …57 keys… });` at the original position + 1 import).

### 5.1 Dedent safety

TS-AST walk for `Template*` / `StringLiteral` / `RegularExpression` nodes
spanning more than one line inside `10361-11304`: **zero hits**. No line has
fewer than 8 leading spaces (`grep -c '^ \{0,7\}[^ ]'` → 0); the 45 blank lines
are truly empty (no whitespace-only lines), and the dedent regex skips them.

### 5.2 `ctx` rename safety

63 whole-word `ctx` occurrences. No inner declaration shadows it
(`const ctx` / `let ctx` / `(ctx…` / `{ ctx …` / `ctx:` — none; the apparent
hits are all `f(event, ctx)` call arguments). **Zero `\.ctx\b` member accesses**
— unlike Task 13 there is no `...ctx,` spread here. After the pass,
`grep '\bctx\b'` over the body returns nothing; the factory parameter `ctx` is
the only `ctx` left in the file. `hookCtx` did not previously occur.

### 5.3 The dynamic-import trap — checked, absent

Per Task 13's §11 warning I grepped the range for `import("./`, `new URL("./`,
`require("./`, `import.meta`, `__dirname`, `__filename` before trusting any
green run. **One dynamic import in 944 lines**:

```
588:  const { createHash } = await import("node:crypto");
```

A bare specifier — unaffected by relocation. No relative specifier anywhere in
the block, so no `../../` rewrite was needed. `tests/deploy-integrity.test.js`
(33/33) confirms the import graph still resolves.

### 5.4 Registration order

The three `agent_end` registrations keep their order: turn-route cleanup
(Task 11, earlier in `register()`), then capture (now `registerCaptureHook`
at the original position inside `if (autoCapture) { … }`), then reply-outcome
recording (`index.js:11310`, untouched). The 60 000 ms envelope survives
exactly — `ctx.api.on("agent_end", handler, { timeoutMs: 60_000 })` in the
adapter, `60_000` numeric separator included.

## 6. Files

- **`engine/capture/capture-turn.js`** (new, 1 058 lines) — 25 import
  statements (43 names), `createTurnCapture(ctx)` destructuring the 57 keys one
  per line alphabetically, the two warning latches, then
  `return async function captureTurn(event, hookCtx)` whose body is the 944
  moved lines. JSDoc `@param`/`@returns` added by hand.
- **`adapter/openclaw/register-capture-hook.js`** (new) — verbatim from the
  brief's Step 5 (header line reference updated to the real `index.js:11305`,
  `@param` typed `Record<string, any>` to match `register-recall-hook.js`).
- **`index.js`** — one import beside `registerRecallHook`'s (line 413), and
  `10357-11305` replaced by the 60-line `registerCaptureHook({ … });`.
  Public export list untouched (`tests/index-public-exports.test.js` 21/21).
- **`tests/engine-capture-turn.test.js`** (new) — the brief's Step 4 test,
  **verbatim, no adaptation needed**. Its fourth assertion
  (`incognitoAt < poolAt`) passes because `classifyHostIncognitoSession` is at
  body line 9 and the first `pool.` at body line 177; unlike Task 13's
  equivalent, this one probes the *body* (`source.slice(indexOf("return async
  function"))`), not the factory, so eager destructuring does not trip it.
- **`scripts/lib/deploy-integrity.mjs`** — both new files added to
  `DEPLOY_FILES` (adapter and engine sections).
- Four literal-source guards, §7.

## 7. Tests adapted

I scanned all 20 test files that read `index.js` as text by extracting **every
regex and string literal ≥ 12 chars** from them with the TS AST and testing
each against the 944-line body. That surfaced five files; one
(`b13-sensitive-read-auth`, `b13-acl-callsite-adapters`,
`memory-host-runtime`, `status-command-ctx`, `forget-correct-confirm`) group
was false-positive (their slices anchor on command-path text outside the
range, and the matched tokens — `workspaceKey:`, `agent-private`,
`workspaceIdentity` — retain 18-43 occurrences in `index.js`). The four real
hits, all extended or redirected, none weakened:

1. **`tests/background-capture-skip.test.js`** — "gates internal turns before
   the NEO worker or any durable capture path". It located
   `api.on("agent_end"` after `if (autoCapture) {`, then searched forward for
   `shouldSkipAutoCaptureForInternalTurn(event, ctx)` and
   `neoWorkerRuntime.runNeoAgentEnd`. Both tokens left `index.js` entirely
   (1 → 0 each), and the `indexOf('api.on("agent_end"', …)` would silently have
   landed on the *reply-outcome* registration. Split in two: index.js must
   still contain `registerCaptureHook({` inside `if (autoCapture) {`, and the
   ordering assertion now runs over
   `engine/capture/capture-turn.js` from `return async function captureTurn(`,
   with the parameter spelled `hookCtx`. Same `skipAt < neoAt` claim. 8/8.

2. **`tests/capture-neutral-importance.test.js`** — slices between
   `const categoryResult = categorizeMemoryWithReason(p.text)` and
   `await db.store(row)`; both anchors were unique to the moved block
   (1 → 0 in index.js), so the slice would have degenerated to `""` and all
   three assertions would have passed vacuously or failed. Source switched to
   the engine module; anchors, regexes and comments unchanged. 3 / 3.

3. **`tests/capture-chunking.test.js`** — the whole "Verdrahtung im
   Capture-Pfad" describe (6 tests) pins the capture wiring:
   `expandForCapture(preppedOk` before `embeddings.embedBatch(batch`, the
   `Phase 1c` → `// Phase 2: Dedup-Checks` slice and its `chunkGroupId`
   returns, the `categoryResult` → `db.store(row)` slice,
   `keepWhole: cfg.captureChunkingMode !== "geteilt"`, and
   `cfg.captureChunking !== false`. **Every one of those anchors went from 1
   occurrence in index.js to 0.** One line changed: `quelle` now reads
   `engine/capture/capture-turn.js`. All six assertions byte-identical. 26 / 26.

4. **`tests/workspace-policy-runtime-gates.test.js`** — two of its assertions.
   `workspacePolicyGuard.automatic(` drops 2 → 1 in index.js, so the
   `>= 2` index-only count would have failed; extended to a sum over
   `[indexSource, ...engineSources]` with `engine/capture/capture-turn.js`
   added to `engineSources` — 1 + 0 + 1 + 1 = 3, comparison kept at the
   original `>= 2` (the Task 12/13 pattern). The literal
   `if (!workspacePolicyGuard.automatic(memoryCtx).allowed) return undefined;`
   left `index.js` entirely (1 → 0; it now exists in *both* engine modules), so
   `assert.match(indexSource, …)` became `assert.ok(allRuntimeSources.some(…))`
   with the identical regex. The
   `automaticWorkspacePolicyDecision(` sum is **unaffected** — that identifier
   appears 0 times in the moved body — and still totals **2 + 1 + 1 + 0 = 4**.
   5 / 5.

5. **`tests/llm-result-cache-integration.test.js`** — Task 13's §11 prediction
   came true a second time. `assert.match(source, /summarizeForCapture\([\s\S]{0,250}?captureSummaryLlmCfg/)`
   had its only matching site (`index.js:10648-10651`) inside the moved block;
   after the move `summarizeForCapture(` survives in index.js only as its
   `:754` declaration and `captureSummaryLlmCfg` only at `:4836`, ~6 000 lines
   apart. Redirected to `readSource("engine/capture/capture-turn.js")`, and the
   sibling `doesNotMatch(/summarizeForCapture\(text, maxChars, mergingLlmCfg/)`
   is now asserted against **both** files so the "never the merging route"
   guard cannot be escaped by relocation. The `makeQuerySummarizer` count is
   untouched and still **exactly 5** (that identifier is absent from this
   range). 22 / 22.

The full suite found no sixth. `tests/auto-capture-batch.test.js`,
`tests/auto-capture-checkpoint.test.js` and `tests/auto-capture-import.test.js`
drive the hook through `register()` and needed no change.

## 8. RED / GREEN

RED, before `engine/capture/capture-turn.js` existed:

```
$ node --test --test-concurrency=1 tests/engine-capture-turn.test.js
Error [ERR_MODULE_NOT_FOUND]: Cannot find module
  '/home/claude/work/plur1bus-m1a/engine/capture/capture-turn.js'
  imported from .../tests/engine-capture-turn.test.js
ℹ tests 1  ℹ pass 0  ℹ fail 1
```

GREEN, after the move:

```
✔ exports a factory
✔ does not mention the OpenClaw api surface
✔ reads and writes the meta-reflection counters through the shared object
✔ keeps the fail-closed incognito classification first
ℹ tests 4  ℹ pass 4  ℹ fail 0
```

## 9. Gates

| gate | result |
|---|---|
| `node --check` index.js / engine / adapter | silent |
| `npm run lint` | `lint-no-api-outside-adapter: clean`, `lint-engine-imports: clean (7 module(s))`, typecheck clean |
| **`tests/golden-prefix.test.js`** | **9 / 9** — all seven scenarios byte-identical; oracle untouched |
| `tests/index-public-exports.test.js` | 21 / 21 |
| `tests/deploy-integrity.test.js` | 33 / 33 |
| `tests/engine-capture-turn.test.js` | 4 / 4 |
| `tests/workspace-policy-runtime-gates.test.js` | 5 / 5 |
| `tests/llm-result-cache-integration.test.js` | 22 / 22 |
| `tests/background-capture-skip.test.js` | 11 / 11 |
| `tests/capture-chunking.test.js` | 26 / 26 |
| `tests/capture-neutral-importance.test.js` | 3 / 3 |
| `tests/auto-capture-batch.test.js` + `-checkpoint` | included in the 158/158 targeted run |
| `tests/meta-cognition.test.js` + `openclaw-default-llm-callers.test.js` | 16 / 16 (state commit) |

## 10. Full suite

After `d59f6e28` (state object):

```
ℹ tests 5179   ℹ pass 5176   ℹ fail 0   ℹ skipped 3
```

After `017c3335` (the move):

```
$ timeout 590 npm test > /tmp/t14.txt 2>&1
ℹ tests 5183
ℹ pass 5180
ℹ fail 0
ℹ skipped 3
```

Required `fail 0, skipped 3` met on both. 5179 → 5183 = the four new boundary
tests; no test deleted or skipped. Both suite runs were clean on the first
attempt — no mid-task guard failures this time, because the literal-source
scan in §7 was done *before* the full run rather than after it.

## 11. Concerns

- **The two warning latches are the finding of this task** (§4). The brief
  calls the meta-reflection counters "the one mutable-state hazard in the whole
  split"; they were not. Nothing in the analyser output distinguishes a `let`
  that is rebound at turn time from one that is final by registration — I only
  found these because the `let` audit resolves each key to its declaration and
  I then read the two that turned up plus the three the analyser named. Tasks
  15–18 should run the `let` audit over their keys *and* read every hit, not
  just the ones a brief flags.
- **23 imports in `index.js` are now dead** (`expandForCapture`,
  `runReflectionJob`, `lightDream`, `turnIdentityParams`, … — each down to a
  single occurrence, the import line itself). Task 13 left its own dead imports
  the same way (`OverlayGenerator`, `collectOpenThreads`,
  `applySemanticLensToRecall`, …), and no lint rule or test objects. I did not
  prune them: removing import statements changes what
  `tests/deploy-integrity.test.js`'s reachable-import walk pulls into
  `DEPLOY_FILES`, which is a different risk from this task's byte-identity
  gate. By Task 18 `index.js` will carry ~100 dead import bindings; a single
  cleanup commit at the end of PR-03, gated on `deploy-integrity` and the
  golden corpus, is the right place for it.
- **The literal-source guards now span four files.** Task 13 predicted this;
  `workspace-policy-runtime-gates` reduces over three engine modules and
  `llm-result-cache-integration` over two, and this task added
  `background-capture-skip`, `capture-chunking` and `capture-neutral-importance`
  as *redirected* (not summed) guards. The redirect form is fragile in a
  different way from the sum form: it silently stops guarding `index.js`. A
  shared helper (`readRuntimeSources()` returning `index.js` plus every
  `engine/**/*.js`) is now clearly worth more than the hand-maintained arrays.
  I still did not introduce one, for the same reason Task 13 gave.
- **`createTurnCapture` takes 57 keys.** Same note as Task 13's 71: a faithful
  reflection of the closure, not a design. Group in PR-04.
- **`generateSummary` is passed in, not imported** (§3). Functionally identical
  today because `index.js:719` is a plain re-binding of the lib export, but if
  anyone ever makes that line non-trivial, the engine module keeps following
  `index.js` — which is the behaviour-preserving choice, and the reason I did
  not "simplify" it to an import.
- No behaviour change intended or observed.

## 12. Pattern notes for Tasks 15–18

- **Do not run a blanket `perl -pi` rename over an identifier that appears as
  an object-literal shorthand.** `{ foo, bar }` → `{ state.foo, state.bar }` is
  a syntax error, not a subtle bug; `node --check` catches it, but only if you
  run it before the suite. Eight sites by hand beat one regex here.
- **Run the `let` audit over *all* keys and read every non-`const` hit**, not
  just the ones the brief names. Resolve each key to its own declaration with
  the AST (the method's span, `VariableStatement`/`FunctionDeclaration` names);
  `grep -n 'let foo'` finds the wrong `foo` in a file this size. The question
  to ask of each hit is not "is it a `let`" but "is it rebound *after*
  registration" — `cfg` and `vectorDim` are `let`s that are safe; the two
  warning latches are `let`s that are not.
- **A `let` used only inside the moved block belongs inside the moved module**,
  in the factory scope above the returned handler — not in a shared-state
  object and not in the context. Extend the moved range upward to take its
  declaration with it.
- **Scan the index-source guards mechanically and *before* the full suite.**
  `grep -rln 'readFileSync[^)]*index\.js\|readSource("index.js")\|indexSource' tests/`
  gives ~20 files; then extract every regex and string literal ≥ 12 chars from
  each with the TS AST and test it against your extracted body text. That
  20-line script found all five affected guards in one pass and cost no suite
  run — Task 13 spent a full run discovering `llm-result-cache-integration` the
  hard way.
- When a guard's anchor leaves `index.js` **entirely** (count 1 → 0), redirect
  it to the engine module rather than summing — a sum over a token that no
  longer exists in `index.js` reads as if it still guards `index.js`. When the
  anchor is *split*, sum and keep the original comparison.
- Task 13's dynamic-import check is cheap and worth repeating even when it
  comes back empty: this range had 944 lines and exactly one `await import(…)`,
  a bare `node:crypto`, so no rewrite was needed — but the grep is what makes
  "no rewrite needed" a fact rather than an assumption.
- The brief's new-test template probes `source.slice(indexOf("return async
  function"))`. That is the form to prefer over Task 13's factory-level probe:
  it is indifferent to whether the factory destructures eagerly, so it needs no
  adaptation.
