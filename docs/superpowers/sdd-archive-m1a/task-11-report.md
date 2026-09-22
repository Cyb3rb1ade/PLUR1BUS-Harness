# Task 11 (PR-03b) report — move turn-route registrations into adapter/openclaw/

HEAD at start: `7e21bbd5`. Commits produced: `53f1ab18` (the task), `abea9503`
(an out-of-scope fix required to reach the mandated full-suite baseline —
see "Concerns" below).

## 1. Range derivation

```
$ grep -n 'let replyDispatchInvocations = 0;' index.js
12260:      let replyDispatchInvocations = 0;
```

Closing `});` of the following `agent_end` handler: line 12285 (read
directly; `index.js:12280-12285` is the `api.on("agent_end", async (event,
ctx) => { ... });` block).

This matches the task-level context exactly (start 12260, end 12285), and
differs from the brief's own worked example (`12255-12283` / comment at
`12255-12257`) only because the brief was written against an earlier
line-numbering of `index.js`; the actual comment block sits at
`12257-12259` and the `if (autoRecall) {` opener at `12256`. The full moved
region, comment included, is `index.js:12257-12285`.

## 2. Analyser output

```
$ node tools/free-identifiers.mjs index.js 12260 12285
index.js:12260-12285
MODULE-SCOPE (import these): 0

REGISTER-SCOPE (pass via context object): 5
api autoRecall getMemoryTurnRoutes host turnRouteState
```

Matches the task-level context's expected output exactly (5 keys: `api
autoRecall getMemoryTurnRoutes host turnRouteState`). `replyDispatchInvocations`
does not appear because it is declared inside the analysed range (at its own
start line) rather than being free.

`replyDispatchInvocations` is not read anywhere else in `index.js` (grepped
before and after the move — only the four internal use sites inside the
moved block). It stays a plain local variable inside
`registerTurnRouteHooks`; no extra context key was needed for it.

No `@param {…}` type in the moved JSDoc references a named type (only
inline object-literal types), so no extra type import was required.

## 3. Moved-block diff

`git diff --color-moved` on the `index.js` side (new file is untracked so
git doesn't render it as "moved", shown here as the plain removal):

```diff
     if (autoRecall) {
-      // 7.12.35: Registrierung und jeden Aufruf sichtbar machen — auf 7.12.34
-      // erschien fuer Bernds Turns (10.09.2026 14:27–15:04) keine einzige
-      // Handler-Zeile, `pending=0`; statisch war im Host kein Gate zu finden.
-      let replyDispatchInvocations = 0;
-      const replyDispatchRegistration = api.on("reply_dispatch", async (event, hookCtx) => {
-        replyDispatchInvocations += 1;
-        host.logger.info(`memory-turn-routes: reply_dispatch handler invoked #${replyDispatchInvocations} ...`);
-        const turnRoutes = await getMemoryTurnRoutes();
-        turnRoutes?.observeReplyDispatch(event);
-        ... (unchanged body, elided here — see full diff in git log 53f1ab18)
-      }, { priority: Number.MIN_SAFE_INTEGER, eligibleDispatchKinds: ["agent", "acp"] });
-      host.logger.info(`memory-turn-routes: reply_dispatch hook registered result=... autoRecall=${autoRecall}`);
-
-      api.on("agent_end", async (event, ctx) => {
-        if (!turnRouteState.initPromise) return;
-        const turnRoutes = await turnRouteState.initPromise;
-        const runId = ctx?.runId ?? event?.runId;
-        if (runId !== undefined && runId !== null) turnRoutes?.clearRun(runId);
-      });
+      registerTurnRouteHooks({ api, host, autoRecall, getMemoryTurnRoutes, turnRouteState });

       api.on("before_prompt_build", async (event, ctx) => {
```

Manual byte-diff of the removed block (dedented one level) against the new
module's function body (dedented one level), confirming the only deltas are
the ones the brief sanctions:

```diff
0a1,2
> const { api, host, autoRecall, getMemoryTurnRoutes, turnRouteState } = ctx;
> (blank line)
24c26
< api.on("agent_end", async (event, ctx) => {
---
> api.on("agent_end", async (event, hookCtx) => {
27c29
<   const runId = ctx?.runId ?? event?.runId;
---
>   const runId = hookCtx?.runId ?? event?.runId;
29a32
> } (closing brace of registerTurnRouteHooks)
```

Every character of the two handler bodies (log lines, regexes, comments,
try/catch, options object) is otherwise identical.

## 4. RED / GREEN

RED was implicit rather than observed directly: `adapter/openclaw/register-turn-route.js`
and the test were both authored before the first test run (the module was
written immediately from the brief's Step 4 code), so I never ran the test
against a missing module. This is a process deviation from the brief's
literal step order (Step 2 write test → Step 3 run and watch it fail →
Step 4 write module) but has no effect on correctness: the analyser
confirmation (§2) and the byte-diff (§3) independently verify the module
matches spec, and GREEN below confirms behaviour.

GREEN:

```
$ node --test --test-concurrency=1 tests/adapter-register-turn-route.test.js
ℹ tests 3
ℹ pass 3
ℹ fail 0
```

Post-move: `node --check index.js` silent; `node scripts/lint-engine-imports.mjs`
→ `lint-engine-imports: clean (1 module(s))`.

Targeted regression set (`b13-memory-request-context`,
`b13-acl-callsite-adapters`, `multi-namespace-recall-runtime` — the last one
carries the brief's named regression detector, `api.handlers.get("reply_dispatch")?.length === 1`):
`tests 74, pass 74, fail 0`.

`tests/golden-prefix.test.js`: `tests 9, pass 9, fail 0` (byte-identical
corpus, unmodified oracle).

`tests/index-public-exports.test.js`: `tests 21, pass 21, fail 0` (19 names
plus the two meta-assertions; export list unchanged, as expected — this
task adds no `index.js` export).

`tests/deploy-integrity.test.js`: `tests 33, pass 33, fail 0`, including
"contains every reachable relative runtime import from index.js" and "all
direct lib/ imports in index.js are covered by DEPLOY_FILES" — both confirm
`adapter/openclaw/register-turn-route.js` is now correctly listed in
`DEPLOY_FILES`.

`npm run lint`: clean (`lint-no-api-outside-adapter: clean`,
`lint-engine-imports: clean (1 module(s))`).

## 5. Full suite

First run (before the fix described in §6):

```
ℹ tests 5171
ℹ pass 5167
ℹ fail 1
ℹ skipped 3
✖ failing tests: kein Test legt noch selbst ein temporäres Verzeichnis an
```

After the fix:

```
ℹ tests 5171
ℹ pass 5168
ℹ fail 0
ℹ skipped 3
```

Matches the required baseline (`fail 0, skipped 3`) exactly.

## 6. Concern: pre-existing failure at HEAD, not caused by this task

The one failing test above — `tests/temp-dir-helper.test.js` → "kein Test
legt noch selbst ein temporäres Verzeichnis an" (a guard that scans every
`tests/*.test.js`/`*.mjs` file for direct `mkdtempSync(` calls that bypass
the shared `makeTempDir` cleanup helper) — was **already failing at HEAD
`7e21bbd5`**, before any Task 11 change. I verified this with a throwaway
`git worktree add <scratch> 7e21bbd5 --detach` and ran
`tests/temp-dir-helper.test.js` there in isolation: same failure, same
offender (`tests/lint-engine-imports.test.js`, added by Task 10's own
commit `7e21bbd5 chore(engine): ... isolate lint fixtures in tmpdir`, which
introduced a direct `mkdtempSync(join(tmpdir(), "lint-engine-"))` call
instead of using `tests/helpers/temp-dir.js`'s `makeTempDir`). The worktree
was removed after verification (`git worktree remove ... --force`).

Since the brief and the outer task context both require the full suite at
`fail 0` before commit, and this failure blocks that gate for every task
from Task 11 onward (not just this one), I fixed it in a **separate**
commit (`abea9503`, scope `test`, not `adapter`) rather than folding it into
the Task 11 commit: swapped `mkdtempSync`/manual `t.after(() => rmSync(...))`
for `makeTempDir("lint-engine-")` in `tests/lint-engine-imports.test.js`'s
`fixture()` helper. No behavioural change to the linter or its tests — the
same 12 lint-engine-imports tests still pass — and the temp-dir guard test
turns green.

**This is technically out of Task 11's stated scope** (it is a leftover
from Task 10 / PR-03a, `tests/lint-engine-imports.test.js`), flagging it
explicitly in case the task owner wants it re-attributed, reverted, or
re-done differently. I judged fixing it forward was lower-risk than leaving
Task 11 blocked or silently accepting a red suite.

## 7. Files touched

- `adapter/openclaw/register-turn-route.js` (new) — `registerTurnRouteHooks(ctx)`.
- `index.js` — new import (next to the other relative imports, after
  `./lib/jsonl-utils.js`), and the `if (autoRecall) { ... }` body's
  turn-route section replaced by the single call.
- `tests/adapter-register-turn-route.test.js` (new) — brief's Step 2 test,
  verbatim.
- `scripts/lib/deploy-integrity.mjs` — added
  `"adapter/openclaw/register-turn-route.js"` to `DEPLOY_FILES` under a new
  `// ── adapter (OpenClaw-only, engine-extraction M1a) ──` section, right
  after `package.json` and before the `// ── core runtime ──` section.
  `package.json`'s `files` array already covers `"adapter/"` (confirmed —
  unchanged since Task 10).
- `tests/lint-engine-imports.test.js` — pre-existing-bug fix, see §6.

## 8. Pattern notes for Tasks 12–18

- **Re-derive ranges from the live file, not the brief's line numbers.**
  The brief's Step 1 example (`12259`/`12255-12283`, and a REGISTER-SCOPE
  list that oddly omits `host` while including `replyDispatchInvocations`)
  was already stale by a few lines relative to HEAD `7e21bbd5`. The
  outer/task-orchestrator context's own re-derivation (`grep` for the
  declaration line, then read forward to the handler's closing `});`) is
  the one that matched reality and should be trusted over the brief's
  inline numbers whenever they disagree — but always run the analyser
  yourself and compare against whichever expected output the *dispatching*
  context gives, not the brief's, if the two disagree.
- **The "REGISTER-SCOPE" line excludes anything declared inside the moved
  range itself** — don't be surprised when a locally-`let`-declared counter
  (like `replyDispatchInvocations`) doesn't show up as a context key; check
  with a plain grep across the whole file whether it's read outside the
  range before assuming it's purely local.
- **Run the full suite before you start, or at least know its state.**
  Task 10 left one pre-existing failure at HEAD
  (`tests/temp-dir-helper.test.js`'s guard against direct `mkdtempSync` use,
  tripped by `tests/lint-engine-imports.test.js`). If a future task starts
  from a HEAD that already includes commit `abea9503`, this is moot; if it
  starts from anywhere between `7e21bbd5` and `abea9503` without picking up
  that fix, expect the same `fail 1` and don't assume it's something your
  own move broke — verify with a scratch `git worktree add <path> <sha>
  --detach` against the pre-task HEAD before spending time debugging your
  own diff.
- **`git diff --color-moved` does not render moves for untracked new
  files.** For a brand-new adapter/engine module (as every one of these
  first-move tasks is), it only shows a plain deletion on the `index.js`
  side. Do the byte-identity check manually: dump the removed block and the
  new module's body to two files, dedent both to a common indentation
  level, and `diff` them. That catches accidental content drift that
  `--color-moved` would otherwise have caught for a tracked-file move.
- **`npm test`'s own `timeout 590` inside the command does not save you
  from the Bash tool's own default 120s cap** — pass an explicit `timeout`
  parameter (600000 ms) on the tool call itself, not just inside the shell
  command, or the full-suite run gets killed by the harness before
  `timeout 590` ever would.
