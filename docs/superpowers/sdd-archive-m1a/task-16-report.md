# Task 16 (PR-03g) report — move the chat-command registration into `adapter/openclaw/`

HEAD at start: `32f71f5e`. Commit produced: `b365cead`.

## 1. Range derivation

The brief gives `index.js:9083-10268` at `89148f9f` ("1 186 lines, 88 module-scope
imports, 42 context keys") and Step 3 says "wrapping `index.js:9084-10267`".
**The end line is wrong**: at `89148f9f`, `10268` is
`registerPluginCommand({` — the *opening* line of the `/wiki` registration, not
a closing line. `10267` is the `}` that closes the `["share","teile"]` loop, and
the wiki block runs `10268-10316` with `}` (closing
`if (typeof api.registerCommand === "function")`) at `10317`.

Which of the two the brief actually measured is decidable, because the analyser
is deterministic:

```
$ git show 89148f9f:index.js > /tmp/old-index.js
$ node tools/free-identifiers.mjs /tmp/old-index.js 9083 10267 | head -1 … 88 / 42
$ node tools/free-identifiers.mjs /tmp/old-index.js 9083 10268 | head -1 … 88 / 42
$ node tools/free-identifiers.mjs /tmp/old-index.js 9083 10316 | head -1 … 93 / 43
```

The brief's `88 / 42` is the range **without** the `/wiki` registration. So the
intended range is `9083-10267`, i.e. the first line is the
`if (typeof api.registerGatewayMethod …)` guard right after
`runOperatorCommand`'s `};` and the last is the share loop's `}`. The `/wiki`
registration deliberately stays in `index.js`; it is the one chat command M1a
leaves behind, and Task 18's `adapter/openclaw/README.md` ("what stays, and
why") is where it should be recorded.

At HEAD that range is **`7422-8603`** (1 182 lines).

```
$ awk 'NR==7421' index.js →         };            # end of runOperatorCommand
$ awk 'NR==7422' index.js →         if (typeof api.registerGatewayMethod === "function" && typeof api.registerCli === "function") {
$ awk 'NR==8603' index.js →         }             # end of the ["share","teile"] loop
$ awk 'NR==8604' index.js →         registerPluginCommand({   # /wiki — stays
```

`runOperatorCommand` (`:7385-7421`) and `runPlur1busCommand` (`:7278`) stay in
`index.js` and are consumed through the ctx, exactly as the brief's
**Interfaces** section says.

## 2. Analyser output

```
$ node tools/free-identifiers.mjs index.js 7422 8603
index.js:7422-8603
MODULE-SCOPE (import these): 87
CORRECTION_PREVIEW_CHARS EPISTEMIC_STATUSES INPUT_LIMITS activateSkillProposal
applyControlUiWriteAction applyEpistemicStatusToLanceDb applyRetrievalReinforcement
assignShortRefs buildControlPlaneProjection buildCriticalReplyCommand catalogModelIds
checkRuntimePressure collectStatusData completePendingConfirmation correctCard
createCaptureChunkingMutator createCompactionRunner createConfirmation
createConfirmationStore createEmbeddingProfileMutator createFeatureModelMutator
createFormTokenStore createRerankerMutator createSettingMutator describeVaultCandidates
embeddingDimensionProfiles emotionEmoji explainResults forgetCard formatMemoryResults
grantModelPermission isAuthorized isLegalEpistemicTransition isPartitionId
largestKnownAgentCount listFeatures makeQuerySummarizer normalizeCommandInput
normalizeEpistemicStatus parseConfirmationCommand parseCorrection parseMemoryFeedback
parseMemoryQuery pickTone queryMemoryAcrossAccessPools randomUUID readGcReport
readPluginConfigFile recordFeedback registerControlUiRuntime
registerFeatureCronNativeDispatch registerObsidianVaultRuntime registerReembeddingRuntime
registerWorkspacePolicyRuntime rejectSkillProposal rejectSkillProposalWithWorkshop
renderCandidateChoice renderExplanation renderFeatureList renderStatus renderToggleResult
rerankerKeyConfigured resolveAgentWorkspaceDir resolveCandidates
resolveConfirmationIdentity resolveEffectiveConfig resolveHostCommandMemoryContext
resolveLocale resolveSessionOwnerMemoryContext resolveShortRef retireActiveSkill
runSpeakerClearCommand runSpeakerConfirmCommand runSpeakerListCommand
runSpeakerNameCommand runSpeakerProposalsCommand runSpeakerRejectCommand safeUpdate
safeUuid sanitizeMemoryTextForPrompt t toggleFeature translateType validateCommandArgs
validateCorrectionText validateSemanticCommandArgs
REGISTER-SCOPE (pass via context object): 45
activeEmbeddingFingerprintId api baseDbPath cfg collectSkillWorkshopDashboard
configuredObsidianWorkspaces confirmationIndex confirmationStore controlHealth
cronDirectDispatchReady dashboardSkillAction dimensions embeddings emitCommandRuntimeHook
emotionalPool getNeoStore host hostRoutingLoader llmResultCache memoryDbAdapter
memoryWorkspaceAliases mergingEnabled modelPreparationCoordinator namespaceLayout
normalizedEmbeddingCfg obsidianVaultsConfirmed openClawSkillWorkshop pool
recallQueryLlmCfg reembeddingConfigMutationAvailable reembeddingCoordinator
reembeddingStateStore reembeddingSwitchRuntime registerPluginCommand registeredShareCard
reranker rerankerCfg resolveCommandLocale runOperatorCommand runPlur1busCommand
sharedMemoryPool skillActivationDeps vectorDim wikiLlmCfg workspacePolicyGuard
workspacePolicyStore
```

**87 / 45** vs. the brief's `88 / 42` at `89148f9f`. Set-diff against the
`89148f9f` run of the same range:

| | |
|---|---|
| module-scope, gone | `runtimeIfUsable` (Task 7 `host` migration) |
| register-scope, new | `host` (same swap), `confirmationStore`, `confirmationIndex` |

The two `Map`s were declared *inside* this range at `89148f9f`; Task 15's prep
commit `37b9822f` hoisted them to `:7266-7267`, so they are now inbound ctx
keys. 130 free names before, 132 after — the +2 is exactly those Maps. No
other drift.

### Classification of the 87 module-scope names (TS AST, not grep)

**80 IMPORT** across **38 specifiers** (`node:crypto` first, then `./lib/…` →
`../../lib/…`, both alphabetical). Two alias traps were emitted with their `as`
forms — `formatResults as formatMemoryResults` and
`parseQuery as parseMemoryQuery` from
`lib/telegram-commands/memory-query.js`. None of the 38 is on the Global
Constraint 8 forbidden list.

**7 PASS-IN** (declared at `index.js` top level → ctx keys):

| name | declaration | |
|---|---|---|
| `CORRECTION_PREVIEW_CHARS` | `:441` `const` | |
| `applyEpistemicStatusToLanceDb` | `:2426` `export function` | public export |
| `completePendingConfirmation` | `:4356` `export function` | public export |
| `makeQuerySummarizer` | `:792` `function` | |
| `parseConfirmationCommand` | `:4259` `export function` | public export |
| `rememberPendingConfirmation` | `:4327` `export function` | public export |
| `resolveConfirmationIdentity` | `:4278` `export function` | public export |

Five are public exports of `index.js` — all **passed**, none imported, so
Global Constraint 9 is untouched (`tests/index-public-exports.test.js` 21/21).

**0 UNKNOWN, 0 alias mismatches** (no name is simultaneously an import local
and a top-level declaration).

### Context object: 52 keys

45 register-scope + 7 PASS-IN = **52**. `api` is *kept* (unlike Task 15's
engine module): this is the adapter, and `scripts/lint-no-api-outside-adapter.mjs`
allowlists `^adapter/`.

## 3. Thunk targets — all ten moved, all ten re-bound

The task instruction asked whether the other four thunk targets fall inside the
range. **They do.** Declaration lines at HEAD:

```
runStatusCommand                :7467   IN-RANGE
resolveDenialLocale             :7514   IN-RANGE
checkAuth                       :7526   IN-RANGE
checkArgsLength                 :7530   IN-RANGE
runFeatureToggle                :7542   IN-RANGE
resolveRegisteredMemoryContext  :7623   IN-RANGE
runMemoryCommand                :7930   IN-RANGE
runForgetCommand                :7967   IN-RANGE
runCorrectCommand               :8040   IN-RANGE
runCriticalCommand              :8269   IN-RANGE
```

So the brief's six-name return object is extended to **ten**:

```js
export function registerChatCommands(ctx) { …
  return {
    runMemoryCommand, runForgetCommand, runCorrectCommand, runCriticalCommand,
    runStatusCommand, runFeatureToggle,
    checkArgsLength, checkAuth, resolveDenialLocale, resolveRegisteredMemoryContext,
  };
}
```

`index.js` declares all ten as a `let` **at the same block level they used to be
`const`s at** — inside `if (typeof api.registerCommand === "function")`, above
the `createPlur1busCommandRunner(…)` call (`:7273-7279`) — and rebinds them by
destructuring assignment at the original position of the moved block. Names are
unchanged, so Task 15's ten thunks (`(...args) => name(...args)`) keep
resolving at command time.

Scope is *identical* to before (same block, same statement order); the only
semantic difference is TDZ → `undefined` in the window between the `let` and the
assignment. Nothing in that window reads them: the runner's context object only
closes over them inside thunks, and `runOperatorCommand` (`:7385`) only
declares a function.

`confirmationStore` / `confirmationIndex` are **not** thunks and were not
touched — they are the shared `Map` pair Task 15's prep commit hoisted, and both
sides now receive the same two objects through the ctx.

### Reverse audit (Task 14's second lesson)

AST walk over every name the range introduces at statement level:

```
chatConfigCommandsBlocked checkArgsLength checkAuth checkMemoryAuth
checkSemanticArgsLength controlUiWriteMode controlUiWriteSurface
obsidianVaultConfirmationStore parseFeatureArg plur1busCommands
resolveDenialLocale resolveRegisteredMemoryContext
resolveSessionPolicyMemoryContext runCorrectCommand runCriticalCommand
runFeatureToggle runForgetCommand runMemoryCommand runMemoryFeedbackCommand
runShareCommand runStatusCommand                                   (21 names)

referenced OUTSIDE 7422-8603:
  checkArgsLength                 7287
  checkAuth                       7288
  resolveDenialLocale             7353
  resolveRegisteredMemoryContext  7356, 8622
  runCorrectCommand               7358
  runCriticalCommand              7359
  runFeatureToggle                7360
  runForgetCommand                7361
  runMemoryCommand                7362
  runStatusCommand                7364
```

Exactly the ten, and nothing else. `:7287-7364` are the thunks; **`:8622` is the
`/wiki` handler**, which stays in `index.js` and calls
`resolveRegisteredMemoryContext` at command time — after the assignment at
`:7422`. The other eleven introduced names never escape the range.

## 4. The `let` audit — both directions

Declaration kind resolved per key by the AST scope walk, not by
first-textual-`grep`. Among the 52 ctx keys, the non-`const` bindings are:

```
api                          param  :4400   (the adapter may hold it)
cfg                          let    :4439
vectorDim                    let    :5075
modelPreparationCoordinator  let    :6146
```

- **`cfg`** — the one the task flagged. Reassigned exactly once, at
  `index.js:4562` (`cfg = providerMigration.config;`). The call site is
  `index.js:7422`, a **statement in `register()`'s own body** (inside the
  `if (typeof api.registerCommand === "function")` block), not inside a callback,
  and it is 2 860 lines *after* the reassignment. Confirmed by reading the
  enclosing statement chain, not by line distance alone. Value is final; passing
  it by shorthand property is safe. (Margin is smaller than Task 15's 2 710 but
  the reasoning is the same and the answer is the same.)
- **`vectorDim`** — `let :5075`, reassigned only at `:5077`/`:5082` in the same
  dimension-resolution block. Final.
- **`modelPreparationCoordinator`** — `let :6146`, assigned synchronously at
  `:6149`/`:6160` in the same statement block. Final.
- **`reranker`** — the analyser's *scope-resolved* binding is the
  `const { reranker, rerankerCfg } = createRuntimeRerankerProvider(…)` at
  `:6199`. The `let reranker` at `:4191` is a local inside
  `createRuntimeRerankerProvider` itself and is not in scope here — a first-
  textual-`grep` would have mis-flagged it.

Everything else is `const`, `const`-destructured or a `function` declaration.
Objects among them (`pool`, `embeddings`, the two confirmation `Map`s, the
`*Cfg`s, `workspacePolicyStore`, `reembedding*`) are passed by reference, so
in-place mutation stays shared.

Reverse direction: §3 above.

## 5. Moved-block diff — residue is the dedent, nothing else

Prescribed substitutions applied to `index.js:7422-8603`:

1. dedent 6 spaces (8 → 2: two levels inside `register()` /
   `if (typeof api.registerCommand === "function")` become one inside
   `registerChatCommands`);
2. relative `await import("./lib/…")` → `"../../lib/…"` — **zero occurrences**.
   The range has no dynamic `import(` at all (`grep -c 'import(' → 0`), so
   unlike Task 15 this move has no dynamic-import trap.

```
$ diff body-dedent.txt body-expected.txt && echo "RESIDUE beyond dedent: NONE"
RESIDUE beyond dedent: NONE
$ diff body-expected.txt body-actual.txt && echo IDENTICAL
IDENTICAL          # 1182 / 1182 lines
```

`body-expected.txt` is the original 1 182 lines dedented mechanically;
`body-actual.txt` is the function body extracted back out of the committed
`adapter/openclaw/register-commands.js`. No hand edits inside the body.

`index.js` diff: **+64 / −1 261** (the 52-key call plus two comment blocks and
the 10-name `let`) **+1** import.

### 5.1 Dedent safety

TS-AST walk for `Template*` / `StringLiteral` / `RegularExpression` nodes
spanning more than one line inside `7422-8603`: **zero hits**. No non-blank line
has fewer than 8 leading spaces (`grep -c '^ \{0,7\}[^ ]'` → 0); zero
whitespace-only lines.

### 5.2 `ctx` — no rename needed

16 `\bctx\b` occurrences in the body: 15 are property *names*
(`ctx: memoryCtx`, `{ ctx: commandCtx, … }`), one is a fresh arrow parameter
(`speakerAuth = (ctx, opts) => checkMemoryAuth(memoryCtx, ctx, opts)`), which
already shadowed nothing in `index.js` and shadows only an already-destructured
factory parameter here. The factory destructures all 52 keys on entry, so the
parameter name is never read inside the body.

### 5.3 `this` / `arguments`

Zero occurrences outside comments and strings.

### 5.4 `api` in the adapter

24 lines of the moved body mention `api`. That is expected and allowed — this
*is* the OpenClaw adapter, and `scripts/lint-no-api-outside-adapter.mjs`
allowlists `^adapter/`. Task 15's §7 concern (a bare `api` passed as a *value*
into `engine/**`) does not arise: nothing from this range enters `engine/**`.

## 6. Files

- **`adapter/openclaw/register-commands.js`** (new, 1 317 lines) — 38 import
  statements (80 names), `registerChatCommands(ctx)` destructuring the 52 keys
  one per line alphabetically, the 1 182 moved lines, then the ten-name
  `return {…}`. JSDoc `@param`/`@returns` by hand; the header records why the
  six command bodies travel with the registration for M1a.
- **`index.js`** (9 845 → 8 741 lines) — one import beside
  `createPlur1busCommandRunner`'s (`:415`); the ten-name `let` at `:7273-7279`;
  `7422-8603` replaced by the `registerChatCommands({ … })` destructuring
  assignment at the original position. Public export list untouched.
- **`tests/adapter-register-commands.test.js`** (new) — the brief's four tests
  verbatim plus a **fifth** that pins the four extra returned helpers
  (`checkArgsLength`, `checkAuth`, `resolveDenialLocale`,
  `resolveRegisteredMemoryContext`), because a silent drop of any of them is a
  `TypeError` at command time rather than a load-time failure. The return object
  is written in the brief's order so its regex anchors on the real `return {`.
- **`scripts/lib/deploy-integrity.mjs`** — `adapter/openclaw/register-commands.js`
  added to `DEPLOY_FILES`.
- Seven literal-source guards, §7.

## 7. Tests adapted

The guard scan ran **before** the full suite (Task 14/15 pattern note). Every
`tests/**.test.js` and `test/**.test.js` that mentions `index.js` (120 files)
had its string literals (≥ 8 chars) and regex literals (≥ 6 chars) extracted
with the TS AST and counted against `index.js` and against `index.js` minus the
moved range, printed as `before -> after` with the moved-range count alongside.
Rows reaching `0` are breakages; the rest were read individually. That produced
**7 real files**; the rest were literals used as runtime test data (command
replies, config keys) or anchors that keep occurrences in `index.js`.

1. **`tests/audit-kleinkram.test.js`** — both K3 and K6 anchor on the
   `/plur1bus critical` handler. `/if \(!subKey \|\| subKey === "list"\) \{/`
   went **1 → 0** and `critical.failed` **4 → 0** in `index.js`; the K6
   `doesNotMatch` would have passed vacuously. Both redirected to the adapter
   source, regexes byte-identical. 4/4.
2. **`tests/b13-acl-callsite-adapters.test.js`** — two tests. In the first, all
   four anchors left `index.js`
   (`const auth = isAuthorized(memoryCtx, cfg, …)` 1 → 0,
   `const checkAuth = async (…)` 1 → 0,
   `checkAuth(memoryCtx, { destructive: true, …}, commandCtx)` **6 → 0**,
   `const runStatusCommand = async (…)` 1 → 0) → redirected whole. In the
   second, only `const memoryCtx = await resolveRegisteredMemoryContext(commandCtx)`
   left (2 → 0) and is redirected; `const storeAccessCtx = memoryCtx` (2 → 2),
   the `queryRefinerEnabled` anchor (1 → 1) and the `doesNotMatch` stay pinned
   to `index.js`. 14/14.
3. **`tests/b13-sensitive-read-auth.test.js`** — the third test
   ("authorizes direct handlers before I/O locale resolution"). All three
   markers went 1 → 0. Redirected to the adapter, and the two
   **indentation-bearing** markers were re-indented by the same 6 columns as the
   move: `"\n            const deniedLen = …"` → `"\n      const deniedLen = …"`
   and the slice terminator `"\n        };"` → `"\n  };"`. Semantics unchanged
   (both still mean "a `};` at the block's own indentation"). The file's other
   two tests were already redirected/concatenated by Task 15 and are unaffected:
   `if \(action(?:Key)? === "([a-z-]+)"` is **6 → 6** in `index.js` and the
   `observed` set is 27 before and 27 after. 9/9.
4. **`tests/forget-correct-confirm.test.js`** — `const runForgetCommand` and
   `const runMemoryFeedbackCommand`, the two `indexOf` slice bounds, both
   1 → 0. Source redirected to the adapter; the five assertions inside are
   byte-identical. 24/24.
5. **`tests/status-command-ctx.test.js`** — same shape:
   `const runStatusCommand = async (commandCtx, suppliedMemoryCtx = null) => {`
   and `const parseFeatureArg` both 1 → 0. Redirected. 1/1.
6. **`tests/workspace-policy-runtime-gates.test.js`** — the last test's three
   anchors left `index.js` (`registerWorkspacePolicyRuntime\(\{` 1 → 0,
   `getSessionEntry\(\{\s*agentId,\s*sessionKey,` 2 → 0, `spawnedWorkspaceDir`
   1 → 0) → redirected to the adapter with the identical regexes. The adapter
   source was also appended to `allRuntimeSources`. The two count-based sums are
   unaffected (`workspacePolicyGuard.automatic(` and
   `automaticWorkspacePolicyDecision(` each have 0 occurrences in the moved
   range), and `text: "NO_REPLY"` stays pinned to `index.js` — its surviving
   call site is `runOperatorCommand`, which did not move. 5/5.
7. **`tests/llm-result-cache-integration.test.js`** — the
   `makeQuerySummarizer\(\s*(?:mergingEnabled\s*\?\s*)?recallQueryLlmCfg` sum
   asserts **exactly 5**. `index.js` went 4 → 1 (3 moved). The adapter source
   was added as a third summand; total is 5 again. Threshold and regex
   unchanged. All eight `sourceSection` anchors in the same test are outside the
   range. 20/20.

**Checked and *not* adapted** (every anchor keeps ≥ 1 occurrence in `index.js`,
or the literal is runtime data rather than a source anchor):
`index-host-logger` (`host.runtime` 22 → 18, still matches),
`index-public-exports` (export names, declarations stay),
`llm-result-cache-lifecycle`, `llm-error-hygiene`, `memory-host-runtime`,
`skill-workshop-actor-tier`, `config-audit`, `platform-callsites`,
`cron-plugin-direct-dispatch-wiring`, `auto-capture-checkpoint`,
`background-capture-skip`, `capture-chunking`, `neo-vector-sidecar`,
`repair-scripts`, `deploy-integrity`, `host-patch-skip`,
`emotion-refine-encoding-maxtokens`, `openclaw-default-llm-contract`,
`b13-installed-host-loader`, `code-index-*`, and the ~30 runtime files whose
flagged literals are command replies (`critical-review-command`,
`plur1bus-start-flow`, `openclaw-default-llm-callers`, `skill-review-confirm-path`,
`plur1bus-internal-auth`, `feature-cron-bootstrap`, `runtime-config-contract`, …).
The full suite found no further hit — the pre-suite scan caught them all.

## 8. RED / GREEN

RED, before `adapter/openclaw/register-commands.js` existed:

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module
  '/home/claude/work/plur1bus-m1a/adapter/openclaw/register-commands.js'
  imported from .../tests/adapter-register-commands.test.js
ℹ tests 1  ℹ pass 0  ℹ fail 1
```

GREEN, after the move:

```
✔ exports a factory
✔ registers every plur1bus_* command name
✔ keeps /state, /enable and /disable, and never registers /status
✔ returns the six command bodies the runner calls back into
✔ also returns the four auth/locale helpers the runner thunks
ℹ tests 5  ℹ pass 5  ℹ fail 0
```

All 15 `plur1bus_*` names plus `state`, `enable`, `disable` survive verbatim;
`name: "status"` has 0 occurrences in the adapter (`/status` stays reserved by
OpenClaw).

## 9. Gates

| gate | result |
|---|---|
| `node --check` index.js / adapter module | silent |
| `npm run lint` | `lint-no-api-outside-adapter: clean`, `lint-engine-imports: clean (9 module(s))`, typecheck clean |
| **`tests/golden-prefix.test.js`** | **9 / 9** — byte-identical; oracle untouched (`git diff 32f71f5e -- tests/fixtures/golden-prefix/expected/` → 0 files) |
| `tests/index-public-exports.test.js` | 21 / 21 |
| `tests/deploy-integrity.test.js` | 33 / 33 |
| `tests/adapter-register-commands.test.js` | 5 / 5 |
| `tests/command-reachability` + `memory-edit` (×2) + `smoke-wiki-command` + `b14-command-policy` | 89 / 89 |
| `tests/b13-sensitive-read-auth` + `b13-acl-callsite-adapters` | 23 / 23 |
| `tests/forget-correct-confirm` + `status-command-ctx` + `workspace-policy-runtime-gates` + `llm-result-cache-integration` | 50 / 50 |
| `tests/audit-kleinkram.test.js` | 4 / 4 |

## 10. Full suite

```
$ timeout 590 npm test > /tmp/t16.txt 2>&1
ℹ tests 5192
ℹ pass 5189
ℹ fail 0
ℹ skipped 3
```

Required `fail 0, skipped 3` met on the first attempt. 5187 → 5192 = the five
new boundary tests; no test deleted or skipped.

## 11. Concerns

- **The brief's end line (`10268`) was not a statement boundary.** It is the
  opening line of the `/wiki` registration, so the brief as written would not
  have produced parsable code. The `88 / 42` measurement disambiguated it to
  `10267` (wiki excluded). Tasks 17–18 should treat the plan's line pairs as
  *approximate* and re-derive with the analyser counts as the acceptance check,
  which is what the plan's own table says.
- **`/wiki` is now the only chat command still registered from `index.js`**
  (`index.js:8604-8652`). It is an intentional consequence of the brief's
  measured range, not an oversight of this task, and it is cheap to leave: its
  only in-range dependency, `resolveRegisteredMemoryContext`, is rebound. Task
  18's `adapter/openclaw/README.md` must list it under "what stays, and why", or
  it becomes an undocumented leftover of exactly the kind Task 18 warns about.
  Moving it later is a ~50-line follow-up (`93 / 43` keys for the widened range).
- **The thunk list was ten, not the brief's six**, and all ten moved. If any
  future task splits this file, the same rule applies: a thunk target that moves
  into the module that the thunk's *caller* also lives in can lose its thunk;
  one that lands elsewhere must stay a thunk and be rebound by name.
- **`registerChatCommands` takes 52 keys and returns 10.** Same note as Tasks
  13–15: a faithful reflection of the closure, not a design. PR-04 should group
  them.
- **The literal-source guards now span nine files.** Task 13, 14 and 15 each
  recommended a shared `readRuntimeSources()` helper; this task added four more
  hand-maintained source redirects and one more summand to a count-based
  assertion. I again did not add the helper, for the same reason my predecessors
  gave (a new shared test utility is a second thing to review inside a
  byte-identity gate) — but three of this task's seven adaptations were pure
  "s/index.js/adapter\/openclaw\/register-commands.js/", which is precisely what
  the helper would have made a one-line change. It should go in before Task 17.
- **One indentation-coupled test.** `b13-sensitive-read-auth`'s markers encode
  the *column* of the code they slice. Any future re-indentation of
  `register-commands.js` silently turns that test vacuous (`indexOf` → −1,
  `slice` → `""`, and `"" .indexOf(x) < "".indexOf(y)` is `-1 < -1` = false, so
  it would actually fail loudly — but for the wrong reason). Worth converting to
  a regex in a change that owns that guard.
- **`index.js` now carries ~80 more dead import bindings.** Tasks 13–15 left
  theirs the same way; the single end-of-PR-03 cleanup commit is still the right
  place, gated on `deploy-integrity` and the golden corpus.
- No behaviour change intended or observed.

## 12. Pattern notes for Tasks 17–18

- **Decide a disputed brief range by re-running the analyser on both
  candidates.** The plan's `module-scope / register-scope` pair is a fingerprint:
  `9083-10267` and `9083-10316` differ by `88/42` vs `93/43`, which settled the
  `/wiki` question in one command and without reading a line of the block.
- **Run the reverse audit before writing the return object, not after.** The AST
  "names introduced by the range / referenced outside it" walk produced the
  correct ten-name return list directly; the brief's six would have shipped four
  `undefined` thunk targets and failed only when a user typed `/plur1bus status`.
- **A `let` rebound by destructuring assignment is the general fix, and it costs
  nothing when the `let` sits at the same block level the `const`s were at.**
  Check that: if the declaration has to move *up* a scope, the change is no
  longer purely mechanical.
- **`grep -c 'import(' <range>` before assuming Task 13/15's dynamic-import
  trap applies.** This range had zero, which is what made the residue pure
  dedent.
- **Re-indent indentation-bearing test markers by exactly the dedent amount.**
  Two markers here carried 12 and 8 leading spaces; both had to drop 6. A marker
  that starts with `\n` plus N spaces still means "at indentation N" after the
  move, so the edit is mechanical — but it is invisible to a
  `s/index.js/…/` redirect and will pass a careless review as unchanged.
- **Scan for guard breakages with a `before -> after (moved N)` triple.** The
  third column separates "the anchor left" (`N -> 0`, moved N) from "the file
  merely shares a word" (`420 -> 390`), which is what kept 120 candidate files
  down to 7 in one pass.
