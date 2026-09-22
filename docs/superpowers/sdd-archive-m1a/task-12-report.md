# Task 12 (PR-03c) report — move the maintenance-only `before_prompt_build` branch

HEAD at start: `abea9503`. Commit produced: `bd16fb53`.

## 1. Range derivation

```
$ grep -n 'else if (neoEnabled || schicht15Enabled || gcEnabled)' index.js
13327:    } else if (neoEnabled || schicht15Enabled || gcEnabled) {
```

(This is before the import edit; after adding the `registerMaintenanceHook`
import the line shifted to 13328, as expected from a one-line insertion
above it.)

The `api.on("before_prompt_build", async (_event, ctx) => { ... });` callback
starts at line 13329 and its body runs 13330–13419; the callback's closing
`});` is at 13420 and the enclosing `} else if (...) { ... }` block's closing
`}` is at 13421. Body length: 90 lines (13330–13419), matching the brief's
header ("90 lines").

## 2. Analyser output

The tool refused to run first:

```
$ node tools/free-identifiers.mjs index.js 13329 13420
free-identifiers: registerStart is stale — re-derive with grep -n 'register(api'
```

`grep -n 'register(api' index.js` → line 4396 (was 4395; Task 11's own
`register-turn-route.js` import shifted it by one line). Updated the tool's
`registerStart` constant from 4395 to 4396 (`tools/free-identifiers.mjs`),
then re-ran:

```
$ node tools/free-identifiers.mjs index.js 13329 13420
index.js:13329-13420
MODULE-SCOPE (import these): 14
buildMaintenanceNudges consumePlur1busStartNotice formatReminderNudge
formatTemporalContinuityContext formatTimeContext getLastActivity homedir
join listDueReminders presentReminder readPendingReminders recordActivity
shouldSkipAutoRecallForInternalTurn writePendingReminders
REGISTER-SCOPE (pass via context object): 10
api automaticWorkspacePolicyDecision gcEnabled getNeoStore host neoEnabled
pool resolveCommandLocaleRecall schicht15Enabled temporalContextEnabled
```

Exactly matches the task-level expectation (14 module-scope, 10
register-scope including `host`).

Per Step 4b, `buildMaintenanceNudges` is declared inside `index.js` itself
(a public export, `index.js:3260` / `index.js:13470`'s export list — Global
Constraint 9), so it is **not** imported by the engine module; it moves from
"module-scope" to a context key instead (matching the brief's Step 5
destructuring list). `homedir`/`join` drop entirely because of the `stateDir`
substitution. The remaining 11 module-scope names resolve to real imports:

| name | source |
|---|---|
| `consumePlur1busStartNotice` | `./lib/setup/feature-profiles.js` |
| `formatReminderNudge` | `./lib/reminder-nudge.js` |
| `listDueReminders`, `presentReminder` | `./lib/reminder-store.js` |
| `readPendingReminders`, `writePendingReminders` | `./lib/reminder-pending.js` |
| `shouldSkipAutoRecallForInternalTurn` | `./lib/runtime-scheduler.js` |
| `recordActivity`, `formatTimeContext`, `getLastActivity` | `./lib/session-time.js` |
| `formatTemporalContinuityContext` | `./lib/temporal-context.js` |

None of these paths match the Global Constraint 8 forbidden list. The final
`createMinimalMaintenance(ctx)` destructuring is the same 11-key set the
brief's Step 5 gives, verbatim: `host, automaticWorkspacePolicyDecision,
buildMaintenanceNudges, gcEnabled, getNeoStore, neoEnabled, pool,
resolveCommandLocaleRecall, schicht15Enabled, stateDir,
temporalContextEnabled` — `api` stays out of the engine ctx and is only used
in the adapter module (confirmed: the moved body has zero references to
`api`).

## 3. Moved-block diff

Extracted the original body (`index.js:13330-13419`, 90 lines) to a
scratch file, dedented 4 spaces (8→4, matching the new nesting: one level
inside `createMinimalMaintenance`'s returned function vs. three levels
inside `register()`/`else if`/`api.on(...)`), applied the three prescribed
substitutions (`\b_event\b`→`event`, `\bctx\b`→`hookCtx`, the
`consumePlur1busStartNotice(process.env.OPENCLAW_HOME || join(homedir(),
".openclaw"))` call → `consumePlur1busStartNotice(stateDir)`), and diffed
that against the actual function body extracted from
`engine/recall/minimal-maintenance.js`:

```
$ diff new-body.txt actual-body.txt && echo IDENTICAL
IDENTICAL
```

90/90 lines match exactly, including the pre-existing inconsistent
indentation inside the `pool.withDb(agentId, async (db) => { ... })`
callback (its inner statements sit at the same indent as the `await
pool.withDb(...)` line itself in the original — preserved verbatim, not
"fixed").

`index.js` side (the branch replaced by the `registerMaintenanceHook(...)`
call):

```diff
     } else if (neoEnabled || schicht15Enabled || gcEnabled) {
       // Auto-recall is off — record hook dispatch and run non-recall maintenance/nudges only.
-      api.on("before_prompt_build", async (_event, ctx) => {
-        const agentId = ctx?.agentId;
-        ... (90-line body, see above)
-      });
+      registerMaintenanceHook({
+        api,
+        host,
+        automaticWorkspacePolicyDecision,
+        buildMaintenanceNudges,
+        gcEnabled,
+        getNeoStore,
+        neoEnabled,
+        pool,
+        resolveCommandLocaleRecall,
+        schicht15Enabled,
+        stateDir: host.stateDir,
+        temporalContextEnabled,
+      });
     }
```

## 4. RED / GREEN

RED (before creating the engine module):

```
$ node --test --test-concurrency=1 tests/engine-minimal-maintenance.test.js
✖ tests/engine-minimal-maintenance.test.js
ℹ tests 1
ℹ pass 0
ℹ fail 1
```

(Module-not-found failure, as expected — `../engine/recall/minimal-maintenance.js`
did not exist yet.)

GREEN (after creating both modules and wiring `index.js`):

```
$ node --test --test-concurrency=1 tests/engine-minimal-maintenance.test.js
▶ createMinimalMaintenance
  ✔ returns undefined when the workspace policy refuses the turn
  ✔ returns undefined when there is no workspace directory
  ✔ records the neo hook dispatch when neo is enabled
  ✔ survives a neo store that throws, logging instead of failing the turn
ℹ tests 4
ℹ pass 4
ℹ fail 0
```

`node --check index.js`: silent (valid syntax).
`node scripts/lint-engine-imports.mjs`: `lint-engine-imports: clean (3 module(s))`.
`tests/index-public-exports.test.js`: `tests 21, pass 21, fail 0` (export list unchanged, as required).
`tests/golden-prefix.test.js`: `tests 9, pass 9, fail 0`, including
`recall-maintenance-only produces the recorded prependContext byte for byte`
— the acceptance-gate scenario for this branch, green.
`tests/deploy-integrity.test.js`: `tests 33, pass 33, fail 0` (both new
files added to `DEPLOY_FILES`; "all direct lib/ imports in index.js are
covered" and "every file in DEPLOY_FILES exists on disk" both pass).
`npm run lint`: clean (`lint-no-api-outside-adapter: clean`,
`lint-engine-imports: clean (3 module(s))`).

## 5. Full suite

First run (before the fix described in §6):

```
ℹ tests 5175
ℹ pass 5171
ℹ fail 1
ℹ skipped 3
✖ failing tests: checks automatic capture, recall, outcome, and maintenance paths
  (tests/workspace-policy-runtime-gates.test.js)
```

After the fix:

```
ℹ tests 5175
ℹ pass 5172
ℹ fail 0
ℹ skipped 3
```

Matches the required baseline (`fail 0, skipped 3`) exactly.

## 6. In-scope fix: workspace-policy-runtime-gates literal-text guard

`tests/workspace-policy-runtime-gates.test.js`'s "checks automatic capture,
recall, outcome, and maintenance paths" test asserts
`indexSource.match(/automaticWorkspacePolicyDecision\(/g).length >= 4` — a
plain grep over `index.js`'s own source text. Before this task, `index.js`
had exactly 4 call sites (lines 11311, 12223, 12264, and the one inside the
branch this task moves). Moving that branch's call site into
`engine/recall/minimal-maintenance.js` drops the in-`index.js` count to 3,
failing the assertion — a direct, expected consequence of this task's move,
not a pre-existing or unrelated failure, so I fixed it in the same commit
(unlike Task 11's out-of-scope `abea9503` fix, which predated Task 11's own
diff).

Fix: the test now reads both `index.js` and
`engine/recall/minimal-maintenance.js` and asserts the **sum** of
`automaticWorkspacePolicyDecision(` occurrences across both files is `>= 4`,
preserving the guard's original intent (every automatic decision point is
checked) without hard-coding a stale expectation that everything lives in
`index.js`. Re-ran in isolation: `tests 5, pass 5, fail 0`.

This is the first task in the PR-03 sequence to trip this particular guard;
Tasks 13–18 that move other `automaticWorkspacePolicyDecision(`/
`workspacePolicyGuard.automatic(` call sites out of `index.js` should check
this test file's count-based assertions before running the full suite, and
extend the same both-files-summed pattern rather than re-deriving it.

## 7. Files touched

- `engine/recall/minimal-maintenance.js` (new) — `createMinimalMaintenance(ctx)`,
  byte-identical to the moved branch body modulo the three prescribed
  substitutions (see §3).
- `adapter/openclaw/register-maintenance-hook.js` (new) —
  `registerMaintenanceHook(ctx)`, calls `ctx.api.on("before_prompt_build",
  createMinimalMaintenance(ctx))`.
- `index.js` — new import (next to `registerTurnRouteHooks`'s import), and
  the `else if (neoEnabled || schicht15Enabled || gcEnabled) { ... }` branch
  body replaced by the single `registerMaintenanceHook({...})` call.
- `tests/engine-minimal-maintenance.test.js` (new) — brief's Step 2 test,
  verbatim.
- `tests/workspace-policy-runtime-gates.test.js` — in-scope fix, see §6.
- `scripts/lib/deploy-integrity.mjs` — added
  `"adapter/openclaw/register-maintenance-hook.js"` (adapter section) and
  `"engine/recall/minimal-maintenance.js"` under a new
  `// ── engine (host-neutral, engine-extraction M1a) ──` section — the
  first `engine/` entry in `DEPLOY_FILES` (this is the first engine module
  actually wired into a runtime `index.js` import; Task 10 only scaffolded
  the directory and its dependency rule).
- `tools/free-identifiers.mjs` — re-derived `registerStart` 4395 → 4396 (see §2).

## 8. Concerns

- **`tools/free-identifiers.mjs`'s `registerStart` will drift again.** Every
  task that adds an import above `register(api, ...)` shifts it by one more
  line. Tasks 13–18 should expect the same "stale, re-derive" refusal and
  treat it as routine, not a bug.
- **The workspace-policy-runtime-gates count-based assertion is fragile
  across the rest of PR-03.** See §6's note for Tasks 13–18: any task moving
  another `automaticWorkspacePolicyDecision(`/`workspacePolicyGuard.automatic(`
  call site out of `index.js` will trip the same guard and should extend the
  cross-file sum rather than re-inventing a fix.
- No behavioural change intended or observed; `recall-maintenance-only`
  (the golden scenario exercising exactly this branch) is byte-identical,
  and the full suite is at the required `fail 0, skipped 3` baseline.

## 9. Pattern notes for Tasks 13–18

- Re-derive `registerStart` in `tools/free-identifiers.mjs` before every
  analyser run once `index.js`'s import block has grown since the last time
  it was checked — the tool's own self-check catches a stale value loudly,
  but only if you run it (don't skip straight to guessing the range from a
  memorized line number).
- Any name the analyser lists as MODULE-SCOPE that has no `import ... from`
  hit in `index.js` is very likely a name declared inside `index.js` itself
  (check `index.js:13470`'s export list and any `function <name>(` /
  `class <name>` declaration) — pass it through the context object instead
  of trying to import it from a module it doesn't live in.
- Before declaring the full suite green, grep `index.js` for the identifier
  count(s) any moved call site participates in against literal-text guard
  tests (`grep -rl "<identifier>(" tests/*.test.js` is a fast first pass) —
  `tests/workspace-policy-runtime-gates.test.js` is one instance but may not
  be the only text-count-based test PR-03's moves will trip.
