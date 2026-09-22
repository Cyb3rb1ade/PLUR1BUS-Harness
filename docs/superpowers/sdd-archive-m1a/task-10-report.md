# Task 10 (PR-03a) — scaffold, scope analyser, dependency rule, export guard

**Status:** complete. Commit `c10d6b24` on `feat/engine-extraction-m1a` (parent `fd5bac5b`).

## Implementation

| File | State |
|---|---|
| `tools/free-identifiers.mjs` | new — TypeScript-compiler-API scope analyser |
| `scripts/lint-engine-imports.mjs` | new — dependency rule + cycle detector + `host.api` guard |
| `tests/lint-engine-imports.test.js` | new — 8 tests |
| `tests/index-public-exports.test.js` | new — 21 tests (19 names + exact-set + default export) |
| `engine/.gitkeep`, `adapter/openclaw/.gitkeep` | new |
| `package.json` | `files` += `engine/`, `adapter/`; `lint` chain += `lint-engine-imports.mjs`; `node --check` sweep += `engine adapter` |
| `.gitignore` | `!scripts/lint-engine-imports.mjs` allowlist line |
| `scripts/lib/deploy-integrity.mjs` | `DEPLOY_FILES` += `scripts/lint-engine-imports.mjs` |

Repo-rule checks: `npm pack --dry-run` lists `engine/.gitkeep` and
`adapter/openclaw/.gitkeep` (370 files total), so `files` really carries the two
new roots. `tools/` is not in `files` and not in `.gitignore`, so
`tools/free-identifiers.mjs` is tracked but never shipped — same as Task 1's
`tools/capture-golden-prefix.mjs`.

### Deviations from the brief's verbatim code (3, all deliberate)

1. **`registerStart` 4394 → 4395.** Re-derived at `fd5bac5b`:
   `grep -n 'register(api' index.js` → `4395:  register(api, registrationDependencies = {}) {`.
   The brief explicitly says to update the constant when `index.js` shifts.
2. **`typescript` is resolved with `createRequire`**, not `import ts from "typescript"`,
   per the controller's instruction to resolve it the way `scripts/typecheck.mjs`
   does. A missing optional install now exits 2 with one plain line instead of an
   `ERR_MODULE_NOT_FOUND` stack. The header comment's stale
   `scripts/dev/free-identifiers.mjs` path was corrected to `tools/…` so
   Tasks 11–17 copy a usage line that works.
3. **`scripts/lint-engine-imports.mjs` gained rule 4** (the controller addition
   from the Task 9 review): any `.api` member read inside `engine/**` is a
   violation, reported as `engine/x.js:<line>: … escape hatch …`. Regex
   `/\.\s*api\b/` over comment-stripped lines (the same `stripComments` helper
   `lint-no-api-outside-adapter.mjs` uses, so a `https://api.host` URL is
   truncated at the `//` and `foo.apiKey` does not match on the `\b`).
   `lint-no-api-outside-adapter.mjs`'s own `API_REFERENCE` has a negative
   lookbehind for `.`, so `host.api.on(…)` is invisible to it — that is exactly
   the gap this rule closes. `adapter/**` is unaffected.

Also strengthened: the cycle test now asserts that **both** files of the
`b.js ↔ c.js` cycle are named in the output, not just the entry point (the
brief's single `[bc]` alternation would pass while naming only one).

## Analyser verification

### Task 11's range — `reply_dispatch` + `agent_end` (`index.js:12260-12285`)

Start: `grep -n 'let replyDispatchInvocations = 0;'` → 12260. End: closing `});`
of the following `agent_end` handler → 12285.

```
$ node tools/free-identifiers.mjs index.js 12260 12285
index.js:12260-12285
MODULE-SCOPE (import these): 0

REGISTER-SCOPE (pass via context object): 5
api autoRecall getMemoryTurnRoutes host turnRouteState
```

This is exactly the plan's expected key set (`api, host, autoRecall,
getMemoryTurnRoutes, turnRouteState`), with no module-scope imports needed.

Cross-check, same block minus the `let` line (the shape the brief's spot check
was measured in, at `89148f9`):

```
$ node tools/free-identifiers.mjs index.js 12261 12285
REGISTER-SCOPE (pass via context object): 6
api autoRecall getMemoryTurnRoutes host replyDispatchInvocations turnRouteState
```

The brief's measured set was `api autoRecall getMemoryTurnRoutes
replyDispatchInvocations turnRouteState` — identical plus `host`, which Task 9
introduced. `replyDispatchInvocations` correctly drops out once its declaration
is inside the range.

### Second spot check — the reminder/nudge `before_prompt_build` branch

Brief's `13354-13443` at `89148f9`; re-derived here as `13356-13447`
(`api.on("before_prompt_build"` … its closing `});` before the `}` at 13448):

```
$ node tools/free-identifiers.mjs index.js 13356 13447
MODULE-SCOPE (import these): 14
buildMaintenanceNudges consumePlur1busStartNotice formatReminderNudge
formatTemporalContinuityContext formatTimeContext getLastActivity homedir join
listDueReminders presentReminder readPendingReminders recordActivity
shouldSkipAutoRecallForInternalTurn writePendingReminders
REGISTER-SCOPE (pass via context object): 10
api automaticWorkspacePolicyDecision gcEnabled getNeoStore host neoEnabled pool
resolveCommandLocaleRecall schicht15Enabled temporalContextEnabled
```

MODULE-SCOPE matches the brief's expected 14 names **exactly**. REGISTER-SCOPE
is the brief's 9 plus `host`. Two independent ranges reproducing the measured
table (modulo Task 9's `host`) is good evidence the analyser is sound.

The remaining four ranges of the brief's Step-2 table were not re-derived: their
`89148f9` line numbers have all drifted by Tasks 2–9, and re-deriving a 1,800-line
range by eye risks certifying a wrong range rather than the tool. The two exact
matches above cover both halves of the module/register classification.

Classification sanity check: `grep -nE '^(function|const|let|class) ' index.js`
finds exactly one column-0 declaration after `registerStart` —
`const NEO_EMBED_TIMEOUT` at 5300 — and it is merely mis-indented, lexically
inside `register`. It is therefore absent from `sf.statements`/`moduleScope` and
is correctly reported as REGISTER-SCOPE. No genuine module-level declaration
lives after line 4395, so the `declLine < registerStart` guard is inert at this
commit.

## RED → GREEN

RED (both test files written before either script existed):
`ℹ tests 29 / ℹ pass 22 / ℹ fail 7`. The 22 passes were the export guard, which
already held on unmodified `index.js` — the point of that file is to freeze the
surface, not to change it. All 8 `lint-engine-imports` tests were red except
`rejects any dotted .api. read`, which only asserts a non-zero exit and was
satisfied by the missing-module crash; the `host.api` test proper
(`engine/__probe__/hatch.js:2` + `/escape hatch/`) was red on both assertions.

GREEN after the two scripts landed: `ℹ tests 29 / ℹ pass 29 / ℹ fail 0`.

## Verification

| Check | Result |
|---|---|
| `node --test tests/lint-engine-imports.test.js tests/index-public-exports.test.js` | tests 29, pass 29, fail 0 |
| `npm run lint` | exit 0 — `lint-no-api-outside-adapter: clean`, `lint-engine-imports: clean (0 module(s))` |
| `tests/golden-prefix.test.js` + `tests/deploy-manifest-covers-shipped-scripts.test.js` | tests 12, pass 12, fail 0 |
| `tests/fixtures/golden-prefix/expected/` | untouched (`git status` empty for that path) |
| Full suite (`npm test`) | **tests 5164, pass 5161, fail 0, skipped 3** |
| `npm pack --dry-run` | `engine/.gitkeep`, `adapter/openclaw/.gitkeep` present |
| Worktree after commit | clean (only the pre-existing untracked `docs/superpowers/plans/2026-09-22-m1a-engine-extraction.md`) |

No product code moved; no behaviour change.

## Concerns / notes for Tasks 11–17

1. **`registerStart = 4395` is a hand-maintained constant.** Every later task that
   moves code out of `index.js` shifts it. It only decides MODULE vs REGISTER
   bucketing, so a stale value degrades quietly rather than loudly: it can only
   mislabel a *module-level* name as REGISTER-SCOPE, and only if a top-level
   declaration ever appears after `register`. None does today. Still, re-`grep`
   it at the start of each move.
2. **The analyser ignores globals deliberately.** `declarationLine()` returns
   `null` for anything it never saw declared (`process`, `console`, `JSON`,
   `Promise`, …), and those are dropped. A genuinely undeclared identifier
   therefore also disappears silently — if a move's context object looks one key
   short, that is the place to look.
3. **Rule 4 (`.api` in `engine/**`) is line-based, not AST-based.** A future
   engine module legitimately importing from a path containing `.api.`
   (`./thing.api.js`) would be flagged. No such file exists; if one appears, move
   the check onto the specifier list rather than loosening the regex.
4. **The lint test writes probe files into the real tree** (`engine/__probe__/`,
   `adapter/__probe__/`) and removes them in `t.after`. The suite runs with
   `--test-concurrency=1`, so nothing else walks those roots at the same time; a
   hard crash mid-test could leave the probes behind and then fail
   `npm run lint`. `rm -rf engine/__probe__ adapter/__probe__` is the fix if that
   ever happens.
5. `lint-engine-imports` currently reports `clean (0 module(s))`. That number
   should start climbing from Task 11 onward; if it stays at 0 after a move, the
   move did not create a file under `engine/` or `adapter/`.

---

# Fix report — Task 10 review follow-up

**Commit:** `7e21bbd5` `chore(engine): validate analyser arguments, self-check registerStart, isolate lint fixtures in tmpdir` (4 files, +152/-45).

## What changed

**1. `tools/free-identifiers.mjs` — argument validation.** A `fail()` helper
prints `free-identifiers: <reason>` plus the usage line and exits 2. Guards, in
order: missing file; missing `startLine`/`endLine`; non-integer either
(`Number("12,285")` is `NaN`); `startLine < 1`; `endLine < startLine`;
unreadable file; `endLine` past the last line. The line count ignores the
trailing `""` that `split("\n")` produces for a newline-terminated file, so
`endLine == lineCount` is accepted.

**2. `registerStart` self-check.** If the file is an `index.js` and
`sourceLines[registerStart - 1]` does not match `/\bregister\s*\(\s*api\b/`, the
tool exits 2 with `registerStart is stale — re-derive with grep -n
'register(api'`. Gated on the filename because for any other file the constant
is irrelevant (nothing can be module-scope *and* after it) and the check would
be pure noise. Dead `declaredInRange` set removed (declaration and its one write
site in `declareInCurrent`).

**3. Fixtures moved out of the working tree.** `scripts/lint-engine-imports.mjs`
takes an optional root as `process.argv[2]` (`resolve`d; default unchanged =
repo root). `tests/lint-engine-imports.test.js` replaces `probe()` with
`fixture()`, which `mkdtempSync(join(tmpdir(), "lint-engine-"))`, creates
`engine/` and `adapter/` under it, writes the files and removes the whole
tmpdir in `t.after`. The `rmSync(dirname(full))` pattern is gone. Only "passes
on the current tree" still points at the repo.

**4. Minor — `.mjs`.** `walk()` matches `/\.m?js$/`; `package.json:scripts.lint`'s
second sweep is now `find scripts tools engine adapter -name '*.mjs' -exec node
--check {} +`.

**5. Minor — `require()`.** `IMPORT_PATTERNS` gains
`/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g`. `\brequire` cannot match inside
`createRequire` (capital R), so the resolver helper itself is not flagged.

Three tests were added beyond the two the review asked for: an
engine↔adapter cycle across both roots, and the `.mjs` and `require()`
negatives.

## Commands and output

```
$ node --test --test-concurrency=1 tests/lint-engine-imports.test.js tests/index-public-exports.test.js
  ✔ passes on the current tree
  ✔ allows an adapter module importing an engine module
  ✔ rejects engine code importing the adapter lifecycle
  ✔ rejects engine code importing the openclaw package
  ✔ rejects an import of index.js
  ✔ rejects an import cycle
  ✔ rejects an engine↔adapter cycle across the two roots
  ✔ lints .mjs files under engine/ too
  ✔ sees a require() specifier, not just an import
  ✔ rejects engine code reading host.api
  ✔ rejects any dotted `.api.` read in engine code
  ✔ allows the adapter to use host.api
ℹ tests 33   ℹ pass 33   ℹ fail 0
```

```
$ npm run lint
lint-no-api-outside-adapter: clean
lint-engine-imports: clean (0 module(s))
LINT EXIT: 0
```

Spot checks, both unchanged by the fixes:

```
$ node tools/free-identifiers.mjs index.js 12260 12285
index.js:12260-12285
MODULE-SCOPE (import these): 0

REGISTER-SCOPE (pass via context object): 5
api autoRecall getMemoryTurnRoutes host turnRouteState

$ node tools/free-identifiers.mjs index.js 13356 13447
index.js:13356-13447
MODULE-SCOPE (import these): 14
buildMaintenanceNudges consumePlur1busStartNotice formatReminderNudge formatTemporalContinuityContext formatTimeContext getLastActivity homedir join listDueReminders presentReminder readPendingReminders recordActivity shouldSkipAutoRecallForInternalTurn writePendingReminders
REGISTER-SCOPE (pass via context object): 10
api automaticWorkspacePolicyDecision gcEnabled getNeoStore host neoEnabled pool resolveCommandLocaleRecall schicht15Enabled temporalContextEnabled
```

Bad arguments — all exit 2 (the four the review named, plus `startLine 0`):

```
$ node tools/free-identifiers.mjs
free-identifiers: no file given
Usage: node tools/free-identifiers.mjs <file> <startLine> <endLine>
exit=2

$ node tools/free-identifiers.mjs index.js 12260 12,285
free-identifiers: endLine is not an integer: "12,285"
exit=2

$ node tools/free-identifiers.mjs index.js 12285 12260
free-identifiers: endLine must be >= startLine (got 12285-12260)
exit=2

$ node tools/free-identifiers.mjs index.js 12260 999999
free-identifiers: endLine 999999 is past the end of index.js (13498 lines)
exit=2

$ node tools/free-identifiers.mjs index.js 0 5
free-identifiers: startLine must be >= 1 (got 0)
exit=2
```

Self-check and boundary behaviour:

```
# index.js copied with one extra line at the top, so register moves to 4396
$ node tools/free-identifiers.mjs <tmp>/index.js 12261 12286
free-identifiers: registerStart is stale — re-derive with grep -n 'register(api'
exit=2

# a non-index file is not subject to the check
$ node tools/free-identifiers.mjs lib/host-services.js 1 20
lib/host-services.js:1-20 … exit=0

# endLine == last line is accepted
$ node tools/free-identifiers.mjs index.js 13497 13498
index.js:13497-13498 … exit=0
```

After the test run, `engine/` and `adapter/openclaw/` contain nothing but their
`.gitkeep` files, and `git status` shows only the four modified sources (now
committed). Full suite not re-run: no product code was touched, and the only
non-test change outside the two tools is the `find` argument list in
`scripts.lint`, which `npm run lint` exercises directly.

## Remaining note

Concern 4 of the original report (probe files in the real tree) is resolved and
withdrawn. Concerns 1–3 and 5 stand, with concern 1 downgraded: a stale
`registerStart` is now loud rather than quiet, but it still has to be re-derived
by hand after each move.
