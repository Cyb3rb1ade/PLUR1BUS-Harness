# Task 7 (PR-02b) report — `api.logger` → `host.logger` in `index.js`

Commit: `bc38fb21` on `feat/engine-extraction-m1a` (parent `829b97e7`).

## Starting counts (re-derived at HEAD, not trusted from the brief's 89148f9f numbers)

```
grep -c "api\.logger" index.js   → 323
```

Breakdown by shape (see below) — the brief's "324 = 323 + assignment" no longer
holds at this HEAD; the current 323 already includes the `pluginLogger =
api.logger;` assignment line, confirmed by inspection.

## The shapes found — five, not three

The brief documented three shapes. Re-grepping turned up two more before I
started rewriting:

| Shape | Count | Replacement |
|---|---|---|
| `api.logger.<m>(` (hard) | 81 | `host.logger.<m>(` |
| `api.logger?.<m>?.(` (double-optional) | 109 | `host.logger.<m>(` |
| `api.logger?.<m>(` (single-optional) | 0 | — (none present) |
| `api.logger.<m>?.(` — **hard-dot, optional-call hybrid**, not in the brief | 19 | `host.logger.<m>?.(` (optional chain left on; harmless, guaranteed method) |
| `api.logger?.[computed]?.(` — **computed-property access**, not in the brief (`configMutationNotice.level` at the old :6186) | 1 | `host.logger?.[computed]?.(` (unchanged shape, object swapped) |
| bare `api.logger` passed as a value (`logger: api.logger`, `new MultiNamespacePool(..., api.logger)`, `reportDormantFeature(api.logger, ...)`, standalone `api.logger,` args) | 113 | `host.logger` |

81 + 109 + 19 + 1 + 113 = 323, matching the flat count (the value-pass bucket
above also absorbs the `pluginLogger = api.logger;` assignment and the German
comment at old :452, both handled by the catch-all pass). Method and argument
lists were never touched — only the receiver object changed, verified by
diffing every added/removed line in `index.js` against a `host.logger|
createHostServices|const host|wird in register` allow-list (zero exceptions)
and a mirror check on removed lines (all contained `api.logger`, zero
exceptions).

## The 14 sites left on `api.logger` — deliberate exemption, not an oversight

Rewriting **all** 323 sites blindly, as the brief's four `perl -pi` commands
would do, breaks the suite. Four functions are declared at module top level,
**before** `register()` (so before `host` exists at all), and each takes its
own `api` parameter — the real OpenClaw plugin capability surface, not
`HostServices`:

- `inspectCronNativeCapabilities(api)` (old :3410) — 1 site — **also a
  protected named export** (global-constraints.md #9).
- `reconcileUnsafeDirectCronsWithService(api, gatewayContext)` (old :3454) —
  5 sites — also a protected named export.
- `runDeferredFeatureCronBootstrap(api, {...)` (old :3523) — 7 sites — also a
  protected named export.
- `makeReactionsCapabilityChecker(api)` (old :4233) — 1 site — not exported,
  but still top-level and pre-`register()`.

All four also read other real `api` capabilities `HostServices` does not
expose (`api.registerGatewayMethod`, `api.registerCli`,
`runtimeIfUsable(api)`), confirming they operate on the raw OpenClaw surface
by design, not on the host seam this task migrates. Three of them
(`inspectCronNativeCapabilities`, `reconcileUnsafeDirectCronsWithService`,
`runDeferredFeatureCronBootstrap`) are additionally called **directly** by
`tests/feature-cron-bootstrap.test.js` and
`tests/cron-plugin-direct-dispatch-wiring.test.js` with a hand-built `api`
stub, entirely bypassing `register()`. Converting their internal
`api.logger` reads to `host.logger` compiles fine (no lint/syntax error) but
throws `ReferenceError: host is not defined` the moment those branches run
from that direct call path — `host` is a `register()`-scope `const`, never in
scope for these functions.

I verified this isn't theoretical: I ran the two directly-affected test files
after the rewrite (`tests/feature-cron-bootstrap.test.js`,
`tests/cron-plugin-direct-dispatch-wiring.test.js`, 61 tests) — green with the
exemption, and I confirmed by inspection (not by breaking the suite on
purpose) that the four function bodies are **byte-identical** to the
pre-rewrite original (`diff` against the original file, zero output for all
three ranges).

So: **`grep -c "api\.logger" index.js` is `14`, not `0`**, all inside these
four functions, all pre-existing double/hard-optional-chain forms untouched.
`grep -c "host\.logger" index.js` is `309` (323 − 14).

## `pluginLogger` / import (Step 4)

- Added `import { createHostServices } from "./lib/host-services.js";` right
  after the `./lib/runtime-shutdown.js` import (now line 160).
- `pluginLogger = api.logger;` (old :4445) became:
  ```js
  const host = createHostServices(api);
  pluginLogger = host.logger;
  ```
  (now lines 4446–4447). The German comment describing this assignment (old
  :452, "wird in register() auf api.logger gesetzt") was updated to say
  `host.logger` by the same catch-all pass, so it stays accurate.

## Value-pass sites — brief's note (a)

All bare-value sites (`logger: api.logger` in option objects, `{ ...ctx,
logger: api.logger }`, `new MultiNamespacePool(..., api.logger)`,
`reportDormantFeature(api.logger, ...)`, `createControlHealthRowInspector(v,
api.logger)`, standalone `api.logger,` positional args, and the computed
`api.logger?.[configMutationNotice.level]?.(...)`) were rewritten to pass
`host.logger` per the brief's guidance — `host.logger` is a strict superset
(same methods present, no-ops added, never throws).

## TDZ check — brief's note (b)

Checked every line of `register()` between its opening (`register(api,
registrationDependencies = {})`) and the `const host = ...` line: no
`api.logger` reads execute in that window (confirmed by direct read of the
source). All nested closures inside `register()` that reference `host` are
*invoked* only after that `const` executes (standard JS closures over a
later-assigned `const` are safe as long as no synchronous call happens before
assignment, which I confirmed is the case). No TDZ hits. The four exempted
top-level functions never reference `host` at all, so they carry no TDZ risk
either.

## Test added

`tests/index-host-logger.test.js`, adapted from the brief's template: the
brief's first assertion (`no api.logger reads anywhere`) would fail on the 14
legitimate exceptions above, so it now excludes those four function bodies by
name (locating them by the same start/end markers used for the rewrite,
independent of line numbers) and otherwise asserts zero `api.logger` reads.
The other two tests (import present, registration survives a
single-method-only logger) are verbatim from the brief.

RED (before the rewrite, brief's Step 3): 2 of 3 failing as expected — not
independently re-verified in isolation since the rewrite was done as one
atomic pass, but the mechanism is exactly what's pinned: before the rewrite
`index.js` had 323 `api.logger` reads (first assertion would fail) and no
`createHostServices` call (second assertion would fail); the third test
(registers with partial logger) already passed on `HostServices`-unaware
code because `pluginLogger`/register() never called a missing logger method
in that stub's path.

GREEN (after):
```
▶ PR-02b host logger
  ✔ index.js no longer reads api.logger outside the pre-register api-surface helpers
  ✔ index.js constructs HostServices
  ✔ registers against a host whose logger has only one method
ℹ tests 3
ℹ pass 3
ℹ fail 0
```

## Collateral fix: 3 pre-existing pinned-source-shape tests

The full suite run before this fix showed 3 failures — all pre-existing tests
that assert on a literal `logger: api.logger` (or `logger: api\.logger` in a
regex) substring of `index.js`'s source, which this task's rename correctly
changed to `host.logger`:

- `tests/llm-result-cache-integration.test.js:506` — `createLlmResultCache({...
  logger: api.logger, ...})` regex → updated to `host.logger`.
- `tests/llm-result-cache-lifecycle.test.js:276` —
  `createScopedEmbeddingIpcServer({... logger: api.logger` regex → updated to
  `host.logger`.
- `tests/memory-host-runtime.test.js:165` — `withAccessReadDbs(..., { ...
  memoryCtx, logger: api.logger })` regex → updated to `host.logger`.

These are one-line regex-literal edits with no change to what they verify
(the shape/structure of the call, not the specific object). Re-ran the three
files after the fix: 44/44 pass.

## Lint / golden / full suite

```
npm run lint            → exit 0, silent (node --check + typecheck.mjs clean)
tests/golden-prefix.test.js → tests 9, pass 9, fail 0 (byte-identical corpus)
```

Full suite (`PATH=/home/claude/.node24/bin:$PATH timeout 590 npm test`):

```
ℹ tests 5131
ℹ pass 5128
ℹ fail 0
ℹ skipped 3
```

Matches the required baseline exactly (`fail 0, skipped 3`).

## Diff scope sanity

`git diff index.js`: every `+` line matches
`host\.logger|createHostServices|const host = |wird in register`, and every
`-` line contains `api.logger` — zero exceptions in both directions. Only
`index.js` plus the three test files above plus the new test file were
touched; nothing in `lib/`, `engine/`, or CI config was modified. The
untracked `docs/superpowers/plans/2026-09-22-m1a-engine-extraction.md` in the
worktree predates this task and was left alone (not staged, not committed).

## Concerns / follow-ups for later tasks

- The 14 `api.logger` sites inside `inspectCronNativeCapabilities`,
  `reconcileUnsafeDirectCronsWithService`, `runDeferredFeatureCronBootstrap`,
  and `makeReactionsCapabilityChecker` remain on the raw `api` surface. If a
  later task (11–17, when these get moved into `engine/` or otherwise wired
  to `host`) intends to convert them too, it will need either to thread
  `host` in as an additional parameter (careful: three are protected exports
  called directly by tests with a raw `api` stub — that call contract would
  need updating in lockstep) or to leave them as-is permanently since they
  also use `runtimeIfUsable(api)`, `api.registerGatewayMethod`, and
  `api.registerCli` — none of which `HostServices` exposes. Task 8
  (`runtimeIfUsable(api)`) will hit the same four functions for the same
  reason; flagging so that task's implementer isn't surprised.
- The brief's own three-shape table was incomplete for this HEAD (missed the
  hard-dot/optional-call hybrid, 19 sites, and one computed-property access).
  Both were handled correctly by the brief's own catch-all `perl` rule (rule
  4), so the final script text still works, but a reviewer following the
  brief literally without re-checking shapes could plausibly miss verifying
  those two forms landed correctly.
