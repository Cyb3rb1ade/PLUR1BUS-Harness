# Task 17 (PR-03h) report — move the tool factory and the prompt supplements

HEAD at start: `b365cead`. Commit produced: `99d480a7`.

## 1. Range derivation

Both ranges re-derived by grep at HEAD, as Task 16's pattern notes prescribe:

```
$ grep -n "registerMemoryPromptSupplement\|api.registerTool(" index.js
7082:    if (!neoEnabled && typeof api.registerMemoryPromptSupplement === "function") {
7086:      api.registerMemoryPromptSupplement(() => [buildRecallSafetyPreamble()]);
7090:      if (neoEnabled && typeof api.registerMemoryPromptSupplement === "function") {
7091:        api.registerMemoryPromptSupplement(() => [
7672:    api.registerTool((ctx) => {
```

### 1.1 Tool factory — the brief's range is correct

`89148f9f:11328` ↔ HEAD `7672` and `89148f9f:12170` ↔ HEAD `8514` (constant
offset −3 656; 843 lines both sides, matching the brief's "843").

```
awk 'NR==7672' index.js →     api.registerTool((ctx) => {
awk 'NR==8512' index.js →     }, {
awk 'NR==8513' index.js →       names: ["memory_recall", "memory_search", "memory_store", "memory_forget", "knowledge_update"],
awk 'NR==8514' index.js →     });
```

So the statement is `7672-8514`; the arrow body the brief calls
`11329-12169` is HEAD **`7673-8511`** (839 lines).

### 1.2 Prompt supplements — the brief's end line is wrong (again)

The brief gives `7073-7110` at `89148f9f` ("38 lines"). The three guards it
names (`:7073`, `:7081`, `:7090`) map to HEAD `7082`, `7090`, `7099` — a
constant offset of +9, so the mapping is unambiguous. But at `89148f9f`,
line `7110` is

```
7110:            return Object.entries(lanes)
```

— the middle of the corpus supplement's `search()` body, not a statement
boundary. Unlike Task 16 the analyser fingerprint does **not** disambiguate:
the brief's `4 / 10` reproduces exactly on the literal truncated range, so the
brief measured the truncation rather than an alternative block.

```
$ node tools/free-identifiers.mjs old-index.js 7073 7110 → 4 / 10   ← the brief
$ node tools/free-identifiers.mjs old-index.js 7073 7157 → 6 / 10   ← the real block
$ node tools/free-identifiers.mjs old-index.js 7090 7157 → 5 / 10
```

The brief's own prose ("the static system-prompt supplement (index.js:7073-7088)
and the Neo corpus supplement (:7090-7110)") makes the intent clear: the three
guarded registration blocks. The corpus supplement closes at `89148f9f:7157`
↔ HEAD **`7166`**.

A second defect in the same range: `89148f9f:7080` (HEAD `7089`) is a **bare
`{`** that does *not* close at 7157/7166 — it is the large `neoEnabled`
grouping block that also holds `resolveCommandLocale`, `registerPluginCommand`
and (before Task 16) the whole chat-command registration. Moving `7073-7110`
verbatim was therefore impossible regardless of the end line: it would have
carried an unmatched `{`.

**Moved ranges at HEAD** — two disjoint pieces, with the grouping `{` left
behind:

| piece | HEAD lines | indent | what |
|---|---|---|---|
| A | `7082-7087` | 4 | `if (!neoEnabled && typeof api.registerMemoryPromptSupplement === "function")` |
| — | `7089` | 4 | the bare `{` — **stays in `index.js`** |
| B | `7090-7166` | 6 | the two `neoEnabled` registrations (prompt + corpus supplement) |

## 2. Analyser output

### 2.1 Tool factory

```
$ node tools/free-identifiers.mjs index.js 7672 8514
MODULE-SCOPE (import these): 71
REGISTER-SCOPE (pass via context object): 56
```

vs. the brief's `71 / 55` at `89148f9f`. Set-diff against the `89148f9f` run of
`11328-12170`: module-scope **identical**; register-scope **+`host`** — the
Task 7 `host` migration, exactly as in Task 16. No other drift.

Measured on the body alone (`7673-8511`) the register-scope list is the same 56
with `api` replaced by `ctx` — i.e. **`api` occurs in the range only on line
7672**, the `api.registerTool(` call itself:

```
$ awk 'NR>=7672 && NR<=8514' index.js | grep -n "\bapi\b"
1:    api.registerTool((ctx) => {
```

See §6 — this is why the engine module needs no `api` capability at all.

### 2.2 Prompt supplements

```
$ node tools/free-identifiers.mjs index.js 7082 7166
MODULE-SCOPE (import these): 5
buildRecallSafetyPreamble findNeoRecord routeNeoRecall sanitizeMemoryTextForPrompt workspaceKeyFromContext
REGISTER-SCOPE (pass via context object): 11
api embeddings getNeoStore host neoCfg neoEnabled neoRequester neoRoot
neoWorkspaceAliases runNeoGlobalSearch sessionWorkspaceKeys
```

vs. the brief's `4 / 10`. Diff: module-scope **+`findNeoRecord`
+`sanitizeMemoryTextForPrompt`** (both live in the part the brief's `7110`
truncated away) and **−`runtimeIfUsable`**; register-scope **+`host`** (the same
Task 7 swap).

## 3. Classification (TS AST, by specifier + exported name)

### 3.1 Tool factory — 71 module-scope names

**54 IMPORT** across **28 specifiers** (`node:` first, then `./lib/…` →
`../../lib/…`, both alphabetical). One alias emitted with its `as` form:
`generateSummary as libGenerateSummary` from `lib/text-utils.js`.
None of the 28 is on the Global Constraint 8 forbidden list.

**17 PASS-IN** (declared at `index.js` top level → ctx keys):

| name | declaration |
|---|---|
| `KNOWLEDGE_LOCK_FILE` | `const :3927` |
| `appendConflictLog` | `function :3826` (public export) |
| `appendCurationLog` | `function :3714` |
| `callLlm` | `function :3842` |
| `callMergeCheck` | `function :3891` |
| `dbg` | `function :466` |
| `formatKnownValidityLabel` | `function :3366` |
| `generateSummary` | `const :722` |
| `makeQuerySummarizer` | `function :793` |
| `normalizeBoundedRecallInteger` | `function :816` |
| `normalizedLlmErrorClass` | `function :699` |
| `readKnowledgePendingSnapshot` | `function :4032` |
| `removeKnowledgePending` | `function :4071` |
| `resolveRuntimeRecallBudget` | `function :821` |
| `runMergedNamespaceRecall` | `function :855` |
| `trackKnowledgePending` | `function :4036` |
| `withDeterministicLlmContext` | `function :3873` |

**0 UNKNOWN, 0 alias mismatches.** The one near-trap is real and was handled:
`generateSummary` is simultaneously an `index.js` top-level `const` (**ctx
key**) and the *local alias target* of `lib/text-utils.js`'s export (imported as
`libGenerateSummary`). A specifier-only classifier would have imported
`generateSummary` and silently shadowed the index-local one.

`appendConflictLog` is on the Global Constraint 9 export list — it is **passed,
not imported**, so the export list is untouched (`index-public-exports` 21/21).

**Context object: 72 keys** = 55 register-scope (56 minus the arrow's own `ctx`)
+ 17 PASS-IN. `api` is *not* among them for the engine module; the adapter adds
it (73 keys at the call site) because `registerMemoryTools` reads `ctx.api`.

### 3.2 Prompt supplements — 5 module-scope names

**4 IMPORT** across 3 specifiers
(`lib/memory-context-sanitize.js`, `lib/neo-arch.js`,
`lib/relevant-memory-context.js`); **1 PASS-IN**: `findNeoRecord`
(`function :3686`). Context object: **12 keys** (11 register-scope +
`findNeoRecord`). `api` is kept — this is the adapter, and
`scripts/lint-no-api-outside-adapter.mjs` allowlists `^adapter/`.

## 4. Reverse audit — nothing escapes either range

AST walk for declarations inside the ranges whose *enclosing* scope starts
outside them:

```
$ node reverse.mjs index.js@b365cead '[[7672,8514],[7082,7087],[7090,7166]]'
introduced at enclosing-scope level: (none)
```

This is structural, not luck: `7672-8514` is a single `ExpressionStatement`
(everything inside is the arrow's own scope) and both supplement pieces are
`IfStatement`s. Unlike Task 16 there is **no return object and no `let`
rebinding** — the brief's silence here is correct.

## 5. `let` audit — forward direction

Declaration kind resolved per ctx key by an AST scope-chain walk from the call
site, not by first-textual-`grep`.

**Tool factory (55 register-scope keys, resolved 55/55):** exactly one
non-`const` binding.

- **`cfg`** — `let :4440`, reassigned exactly once at `index.js:4563`
  (`cfg = providerMigration.config;`). The call site is `index.js:7672`, a
  statement in `register()`'s own body, 3 109 lines after the reassignment and
  not inside any callback. Value is final; shorthand-property passing is safe.
  (Same binding and same reasoning as Tasks 15/16; the margin here is the
  largest of the three.)
- Everything else is `const`, `const`-destructured, a `function` declaration or
  an import. `reranker` again resolves to the `const { reranker, rerankerCfg }`
  destructuring at `:6199`, **not** the `let reranker` local inside
  `createRuntimeRerankerProvider` — a textual grep would mis-flag it.
- Objects among the keys (`pool`, `embeddings`, `emotionalPool`,
  `sharedMemoryPool`, the `*Cfg`s, `workspacePolicyGuard`, `runtimeScheduler`,
  `namespaceLayout`) are passed by reference, so in-place mutation stays shared.

**Prompt supplements (11 keys, resolved 11/11):** the only non-`const` binding
is `api` itself (`param :4401`), which the adapter is entitled to hold.

Reverse direction: §4.

## 6. `api` in the tool handlers — zero capabilities needed

The task flagged this as the thing to watch. The answer is the best possible
one: **no handler reads `api`.** `api` appears exactly once in `7672-8514`, on
line 7672, and that line is the registration call that stays in the adapter.
Every host touch inside the body already goes through `host` (`host.logger`,
`host.runtime`), which Task 7 installed. The moved body's `host` reads are
`host.logger.warn/debug/info` only.

So `engine/tools/memory-tools.js` passes the brief's
`assert.doesNotMatch(source, /(?<![.\w$/-])api\s*\./)` with no ctx capability
invented and no behaviour change. **No question for the owner arises.**

One real consequence, caught by that same assertion on the first GREEN run: the
regex also fires on **prose**. My header JSDoc said "the factory handed to
`api.registerTool`" and "what `api.registerTool` invokes"; both had to be
reworded (to "`registerTool`" / "the host's `registerTool`"). Worth knowing for
Task 18 — the engine `api` guard is a *text* guard, so engine-module comments
may not spell `api.` even when describing the adapter.

## 7. Semantic parity of the moved bodies

| check | tool body `7673-8511` | supplements `7082-7087` + `7090-7166` |
|---|---|---|
| `this` / `arguments` as expressions | **0** (10 textual hits, all inside string literals or comments — tool `description` prose and three `//` comments) | 0 |
| top-level `return` | 1, at `8511`: the arrow's own `return guardWorkspaceTools(...)` | 0 |
| top-level `await` | 0 (the arrow is not `async`; every `await` is inside an `async execute`) | 0 |
| relative `import("./lib/…")` | **0** — the only dynamic import is `import("node:fs")` (bare, no rewrite) | 0 (no `import(` at all) |
| multi-line string/template/regex crossing the range | 0 (AST scan) | 0 |
| non-blank lines below the range's own indent | 0 | 0 |
| whitespace-only lines | 0 | 0 |

## 8. Prescribed substitutions and residue

### 8.1 Tool factory

1. **dedent 2** (6 → 4: the body sat one level inside `register()` at indent 6;
   in the module it is one level inside `createMemoryTools` → `return (toolCtx) =>`).
2. **`ctx` → `toolCtx`**, 35 occurrences. Verified safe by AST before applying:
   all 35 `ctx` identifiers in `7673-8511` are *value* references
   (3 `CallExpression` arguments, 32 `PropertyAccessExpression` objects);
   **0 property keys, 0 shorthand properties**, and the textual `\bctx\b` count
   is also exactly 35, so the word-boundary rewrite and the AST rewrite are the
   same edit. (A shorthand `{ ctx }` would have silently become a *renamed key*.)

```
$ diff body-prescribed.txt body-actual.txt && echo IDENTICAL
IDENTICAL          # 839 / 839 lines
```

`body-actual.txt` is the arrow body extracted back out of the committed
`engine/tools/memory-tools.js`. A round-trip (un-rename + re-indent) reproduces
the original `index.js` lines exactly, modulo the 25 blank lines, which stay
blank rather than becoming two spaces. **No hand edits inside the body.**

### 8.2 Prompt supplements

1. **dedent 2** for piece A (4 → 2), **dedent 4** for piece B (6 → 2). Two
   different amounts because B sat one level deeper, inside the bare grouping
   block that stays in `index.js`. I deliberately did **not** reproduce that
   lone `{ … }` in the adapter to make the dedent uniform: a bare block in a
   three-statement function reads as a mistake, and it groups nothing once
   `resolveCommandLocale` and friends are not in it. It declares nothing, so
   dropping it is behaviour-neutral.
2. No other substitution (no dynamic imports, no renames).

```
$ diff ps-prescribed.txt ps-actual.txt && echo IDENTICAL
IDENTICAL          # 6 + 1 blank + 77 lines
```

### 8.3 `index.js`

`8741 → 7905` lines (**−836**): `+2` imports (beside Task 16's, at `:416-417`),
the two replacement calls (73-key and 12-key object literals, one key per line,
alphabetical), `−843 −6 −77` moved lines, and the grouping `{` preserved at its
original position:

```
    registerPromptSupplements({
      api, … sessionWorkspaceKeys,
    });

    {
      const resolveCommandLocale = (commandCtx) => {
```

The brief's Step 5 expectation (~6 400 lines, from 13 496) is stale — it was
written against the pre-PR-03 baseline and does not net out Tasks 13–16.
`git diff --stat index.js`: **+90 / −926**. Public export list untouched.

## 9. Files

- **`engine/tools/memory-tools.js`** (new, 976 lines) — 28 import statements
  (54 names), `createMemoryTools(ctx)` destructuring 72 keys one per line
  alphabetically, then `return (toolCtx) => {` + the 839 moved lines. JSDoc
  `@param`/`@returns` by hand; the header records that the destructive-op gate
  is a security boundary and that the only host contact is the per-call
  `toolCtx`.
- **`adapter/openclaw/register-tools.js`** (new, 22 lines) — imports the engine
  factory and makes the single unguarded call. **The brief's Step-3 snippet
  drops the second argument**
  (`ctx.api.registerTool(createMemoryTools(ctx))`); shipped as written it would
  have deleted the `names` metadata OpenClaw's allowlist discovery reads for a
  *factory* registration, and `tests/tool-registration-metadata.test.js` would
  have failed. The options object is carried over byte-identically:
  `names: ["memory_recall", "memory_search", "memory_store", "memory_forget", "knowledge_update"]`.
- **`adapter/openclaw/register-prompt-supplements.js`** (new, 120 lines) — the
  brief's header comment, 3 imports, `registerPromptSupplements(ctx)`
  destructuring 12 keys, then pieces A and B. All three
  `typeof api.registerX === "function"` guards kept verbatim.
- **`index.js`** — §8.3.
- **`tests/engine-memory-tools.test.js`** (new) — the brief's four tests
  verbatim, unchanged.
- **`scripts/lib/deploy-integrity.mjs`** — the three new modules added to
  `DEPLOY_FILES`.
- Three literal-source guards, §10.

## 10. Tests adapted

The guard scan ran **before** the full suite. Every `tests/**.test.js` and
`test/**.test.js` mentioning `index.js` (120 files) had its string literals
(≥ 8 chars) and regex literals (≥ 6 chars) extracted with the TS AST and counted
as `before -> after (moved N)` against `index.js` and against `index.js` minus
the three removed ranges. 23 files produced at least one `N -> 0` row; each was
then read to see whether the literal is a *source anchor* or *runtime data*.
**Three needed adaptation.**

1. **`tests/b13-acl-callsite-adapters.test.js`** — in "threads the canonical
   context through every current ACL adapter family",
   `/memoryCtx,\s*queryRefinerEnabled,\s*decisionTrace:/` went 1 → 0 (the
   model-facing recall call site moved). Redirected to
   `engine/tools/memory-tools.js`, regex byte-identical. The other three
   assertions stay pinned to `index.js`:
   `const storeAccessCtx = memoryCtx` is 2 → **1** (the bridge store path
   remains), and the `doesNotMatch(/checkAccess\(\{\s*agentId,\s*workspaceId/)`
   has 0 occurrences in the moved range, so it was not weakened. 14/14.
2. **`tests/workspace-policy-runtime-gates.test.js`** — "guards the complete
   five-tool surface before execute" anchors on
   `guardWorkspaceTools(workspaceTools, workspacePolicyGuard.decision(memoryCtx))`,
   1 → 0. Redirected to the engine module, which was also added to
   `allRuntimeSources` so the three reductions below it span it. Both count
   assertions are `>=` thresholds and can only gain; `text: "NO_REPLY"` stays
   pinned to `index.js`. 5/5.
3. **`tests/llm-result-cache-integration.test.js`** — "binds every private index
   transform to its exact scope, purpose, and deterministic config". Four
   changes, all in one test:
   - `modelStoreSection` (`name: "memory_store"` → `name: "memory_forget"`):
     both tokens 1 → 0, section redirected to the engine module.
   - `knowledgeToolSection` (`name: "knowledge_update"` →
     `names: ["memory_recall"`): the **two tokens now live in different
     files** — the start in the engine module, the end in
     `adapter/openclaw/register-tools.js`. A straight redirect would have
     thrown `missing source end token`. The end token is changed to
     `return guardWorkspaceTools(`, the factory's own return and the first
     thing after the tool array, which occurs exactly once in the engine module
     and keeps the section meaning "everything from the knowledge_update tool
     to the end of the list". `assertEveryCallIsDeterministic(…,
     "KNOWLEDGE_UPDATE", 2)` still finds its two calls.
   - the `makeQuerySummarizer` sum: `index.js` 4 → 1 in Task 16, now **1 → 0**;
     the engine module is added as a **fourth** summand. Threshold and regex
     unchanged, total still exactly **5**.
   - `assert.doesNotMatch(source, /makeQuerySummarizer\(mergingLlmCfg/)`: the
     call site it guards left `index.js`, so the same guard is asserted on the
     engine module too — the PR-03e precedent three lines above (the
     `capture-turn.js` pair). 20/20.

**Checked and *not* adapted** (20 files): every remaining `N -> 0` row is either
runtime data or an anchor in a file that does not read `index.js` as source.
Notable ones, since they look alarming in the scan output:

- `tests/tool-registration-metadata.test.js`, `tests/model-tool-auth.test.js`,
  `tests/valid-time.test.js`, `tests/tombstone-*.test.js`,
  `tests/multi-namespace-recall-runtime.test.js`,
  `tests/memory-store-*.test.js`, `tests/openclaw-default-llm-runtime.test.js`,
  `tests/retroactive-interference-runtime.test.js`,
  `tests/runtime-config-contract.test.js`, `tests/memory-forget-late-delete.test.js`
  — these *call the tools* and assert on their replies (`"No matching memory
  found."`, `/Memory forget failed/i`,
  `/allowModelDestructiveMemoryOps=true/`, `"2025-06-01"`). Behaviour is
  unchanged, so they pass unmodified; the literals only happened to be textually
  present in `index.js` too.
- `tests/config-audit.test.js` — `"security.allowModelDestructiveMemoryOps"` is
  a **schema key** asserted against `openclaw.plugin.json`, not an `index.js`
  anchor.
- `tests/openclaw-restricted-registration.test.js` — `"registerTool"`,
  `"registerMemoryPromptSupplement"`, `"registerMemoryCorpusSupplement"` are
  entries in its list of host capability names, not source anchors.
- `tests/status-command-ctx.test.js` — its
  `/const agentId = memoryCtx\.agentId;/` does go 1 → 0 in `index.js`, but Task
  16 already redirected that test to `adapter/openclaw/register-commands.js`;
  it never reads `index.js`.
- `tests/index-host-logger.test.js`, `tests/b13-sensitive-read-auth.test.js`,
  `tests/background-capture-skip.test.js`, `tests/capture-chunking.test.js`,
  `tests/emotion-refine-encoding-maxtokens.test.js`,
  `tests/llm-error-hygiene.test.js`, `tests/llm-result-cache-lifecycle.test.js`
  — all their `indexOf`/`sourceSection` anchors were checked by line number and
  none lands in `7082-8514`.

The full suite found no further hit — the pre-suite scan caught them all.

## 11. RED / GREEN

RED, before `engine/tools/memory-tools.js` existed:

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module
  '/home/claude/work/plur1bus-m1a/engine/tools/memory-tools.js'
  imported from .../tests/engine-memory-tools.test.js
ℹ tests 1  ℹ pass 0  ℹ fail 1
```

First GREEN attempt failed on test 2 only — the `api.` prose in the header
JSDoc (§6). After rewording:

```
✔ exports a factory
✔ does not mention the OpenClaw api surface
✔ keeps all five model-facing tool names
✔ keeps the destructive-op gate and its default
ℹ tests 4  ℹ pass 4  ℹ fail 0
```

## 12. Gates

| gate | result |
|---|---|
| `node --check` index.js / all three new modules | silent |
| `npm run lint` | `lint-no-api-outside-adapter: clean`, **`lint-engine-imports: clean (12 module(s))`** (the brief's expected number), typecheck clean |
| **`tests/golden-prefix.test.js`** | **9/9** — byte-identical; oracle untouched (`git status --porcelain tests/fixtures/golden-prefix/expected/` → 0 files) |
| `tests/index-public-exports.test.js` | 21/21 |
| `tests/deploy-integrity.test.js` | pass (three new `DEPLOY_FILES` entries) |
| golden + public-exports + deploy-integrity together | **63/63** |
| `tests/engine-memory-tools.test.js` | 4/4 |
| `tool-registration-metadata` + `model-tool-auth` + `llm-result-cache-integration` + `b13-acl-callsite-adapters` + `workspace-policy-runtime-gates` | **42/42** |
| `multi-namespace-recall-runtime` + `memory-store-decision-trace` + `valid-time` + `tombstone-e2e` + `openclaw-restricted-registration` + `config-audit` + `status-command-ctx` | **242/242** |

## 13. Full suite

```
$ timeout 590 npm test > /tmp/t17.txt 2>&1   → exit 0
ℹ tests 5196
ℹ pass 5193
ℹ fail 0
ℹ skipped 3
```

Required `fail 0, skipped 3` met on the first attempt. 5192 → 5196 = the four
new boundary tests; no test deleted or skipped. (`npm test` takes ~444 s, well
over a 120 s foreground tool timeout — it has to be backgrounded.)

## 14. Concerns

- **The brief's prompt-supplement range was defective in two independent ways**
  — an end line mid-expression *and* an unmatched opening `{` — and, unlike
  Task 16, the analyser fingerprint **confirmed the defective range** rather
  than disambiguating it (the brief measured the truncation). The lesson for
  Task 18 is sharper than Task 16's: matching counts prove the brief *measured*
  that range, not that the range is movable. A syntactic check
  (`node --check` on the extracted slice, or "does the slice have balanced
  braces") has to run alongside the count check.
- **The brief's `register-tools.js` snippet drops `{ names: [...] }`.** Copied
  literally it silently removes the only machine-readable declaration of the
  five tool names for a factory registration. `tool-registration-metadata`
  catches it, but the snippet is in the plan and will be read again.
- **`createMemoryTools` takes 72 keys.** Same note as Tasks 13–16: a faithful
  reflection of the closure, not a design. This is the largest context object
  of the series and the strongest argument for PR-04's grouping — roughly half
  of the 72 are flat recall/merge tuning scalars (`dedupJaccard`,
  `canonicalMinScore`, `schicht15MinImportance`, …) that belong in two or three
  sub-objects.
- **The engine `api` guard is a text guard, and it fires on comments.** Any
  engine module that wants to explain what the adapter does must avoid writing
  `api.` in prose. Worth a line in Task 18's `adapter/openclaw/README.md`.
- **The literal-source guards now span twelve files.** Tasks 13–16 each
  recommended a shared `readRuntimeSources()` helper and each declined to add
  it; I declined for the fourth time, for the same reason (a new shared test
  utility is a second thing to review inside a byte-identity gate) — but two of
  this task's three adaptations were pure redirects, and
  `llm-result-cache-integration`'s summarizer sum has now been edited by three
  consecutive tasks. Task 18 owns the documentation pass; it is the right place.
- **`knowledgeToolSection`'s new end token is a weaker anchor** than the old
  one. `names: ["memory_recall"` was unique and semantically "the end of the
  tool list"; `return guardWorkspaceTools(` is unique today but is also the
  line any future refactor of the factory's return would touch. If it moves,
  the test fails loudly (`missing source end token`), not vacuously, so the
  failure mode is acceptable.
- **`index.js` now carries ~120 more dead import bindings** (54 + 4 from this
  task on top of Tasks 13–16). Unchanged recommendation: one cleanup commit at
  the end of PR-03, gated on `deploy-integrity` and the golden corpus.
- **`/wiki` is still the only chat command registered from `index.js`**
  (Task 16's concern, unchanged by this task) and still needs the Task 18
  README entry.
- No behaviour change intended or observed.

## 15. Pattern notes for Task 18

- **Counts confirm what the brief measured, not that the range is extractable.**
  Task 16's fingerprint trick settled a genuine ambiguity; here the same trick
  endorsed an unmovable slice. Always pair it with a brace/`node --check`
  balance test on the extracted text before trusting a line pair.
- **Check for an enclosing bare block before assuming a range is one piece.**
  `index.js` uses lone `{ … }` blocks to scope the `neoEnabled` section; a range
  that starts before one and ends inside it is two disjoint pieces with two
  different dedents. Both moved cleanly once treated that way.
- **AST-classify `ctx`-style renames before running `sed`.** The rename was
  safe here only because all 35 occurrences were value references; the
  dangerous case (`{ ctx }` shorthand, or `ctx:` as a key) is invisible to
  `\bctx\b` and turns a rename into a *contract* change. Comparing the AST
  identifier count to the textual count is a one-line proof that the two edits
  coincide.
- **Grep the range for `api` before designing ctx capabilities.** The task
  budgeted for translating handler `api.*` reads into named capabilities; the
  actual answer was one line and zero capabilities, because Task 7's `host`
  migration had already done the work. Ten seconds of grep replaced a design
  decision.
- **`sourceSection(start, end)` pairs can be split across two destination
  files.** When a moved block's start and end anchors land in the engine module
  and the adapter respectively, a redirect is not enough — pick a new end token
  inside the same file, and prefer one whose disappearance fails loudly.
- **Keep the `npm test` run in the background.** 444 s exceeds the 120 s
  foreground timeout; `nohup … &` plus polling is the only way to get the
  numbers in one attempt.
