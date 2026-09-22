# Task 8 (PR-02c) report — `runtimeIfUsable(api)` → `host.runtime` in `index.js`

## Discrepancy vs. the brief, found during re-derivation

The brief said "29 occurrences on 28 lines" and named four exempt pre-register
functions (`inspectCronNativeCapabilities`, `reconcileUnsafeDirectCronsWithService`,
`runDeferredFeatureCronBootstrap`, `makeReactionsCapabilityChecker`). Re-deriving
with Grep on the actual checkout found **34 occurrences on 29 lines**, and a
**fifth** top-level, pre-`register()` function with its own `api` parameter
that also calls `runtimeIfUsable(api)`: `resolveNeoHooksConfig(api, commandConfig)`
at `index.js:3310` (module top level, column-0 indent, sibling to `register()`,
not nested inside it — confirmed by reading the surrounding indentation and by
locating `register()`'s actual start at `index.js:4395` as a method of the
`plugin` object literal, with `const host = createHostServices(api)` at
`index.js:4446` scoped to that method body only).

`resolveNeoHooksConfig` was never added to `HOST_LOGGER_EXEMPT_FUNCTIONS` in
Task 7 because its `api.logger` read at line 3317 already used optional
chaining (`api?.logger?.warn?.(...)`), which doesn't match the regex
`/(?<![.\w$])api\s*\.\s*logger/` Task 7's guard test uses — so it silently
slipped through PR-02b's exemption bookkeeping without violating it. For
PR-02c, though, it has the identical structural problem as the four named
functions: `host` is a `const` local to `register()`'s function body and is
completely unreachable from a sibling top-level declaration. Blindly running
the brief's Step 5 `perl` substitution across the whole file would have turned
`resolveNeoHooksConfig`'s call into `host.runtime`, producing a `ReferenceError:
host is not defined` the first time it's invoked (call site: `index.js:8755`,
`resolveNeoHooksConfig(api, commandCtx.config)`, itself inside `register()`,
so it does have `host`/`api` in scope there — but the *callee* function body
does not, since it only receives `api` as a parameter).

I treated `resolveNeoHooksConfig` as exempt for the same reason as the other
four, left its `runtimeIfUsable(api)` call untouched, and added it as a fifth
entry to a new `HOST_RUNTIME_EXEMPT_FUNCTIONS` list in the test file (built as
`[...HOST_LOGGER_EXEMPT_FUNCTIONS, resolveNeoHooksConfig-entry]`) so the guard
assertion doesn't regress this into a real bug later. `exemptLineNumbers()`
was given an optional second parameter (defaulting to
`HOST_LOGGER_EXEMPT_FUNCTIONS`) so the existing api.logger test is unaffected.

**Exempt-function count for this task: 5** (the four named in the brief, plus
`resolveNeoHooksConfig`). Final `grep -c "runtimeIfUsable(api)" index.js` = 4
matching **lines** (`resolveNeoHooksConfig` contributes 1 line/1 occurrence;
`makeReactionsCapabilityChecker` contributes 3 lines/5 occurrences — one line
has 3 occurrences on it). `inspectCronNativeCapabilities`,
`reconcileUnsafeDirectCronsWithService` and `runDeferredFeatureCronBootstrap`
contain **zero** `runtimeIfUsable(api)` calls in the current checkout (they
were listed for parity/future-proofing with Task 7's exemption list, and
because the task explicitly said to extend the guard "the same way Task 7
did," which built its list from all five/four candidate functions regardless
of whether each one currently trips the specific regex).

## Per-site changes (old → new)

All line numbers below are from the file *after* the three pass-through edits
were applied by hand and *before* the bulk `perl` substitution, i.e. the
numbers Grep gave at the start of this task (re-derived, not the brief's).

### Pass-throughs (3 sites) — `?? undefined` to stay byte-equivalent

| Line | Old | New |
|---|---|---|
| 5328 | `runtime: runtimeIfUsable(api),` | `runtime: host.runtime ?? undefined,` |
| 7101 | `runtime: runtimeIfUsable(api),` | `runtime: host.runtime ?? undefined,` |
| 7136 | `runtime: runtimeIfUsable(api),` | `runtime: host.runtime ?? undefined,` |

`runtimeIfUsable` returns `undefined` on an unusable runtime; `host.runtime`
returns `null`. `?? undefined` normalizes `null` back to `undefined` at these
three sites only, per the brief — downstream code (`workspaceKeyFromContext`)
may distinguish "no runtime field" from "runtime field explicitly null".

### Probes (26 sites, all rewritten to `host.runtime` verbatim, no `?? undefined`)

All of these were `runtimeIfUsable(api)?.…` (optional chaining already
short-circuits on `null` exactly as it did on `undefined`) or the five
non-optional `.agent` reads that the brief flagged as intentionally
throw-preserving:

- `:7206` `await runtimeIfUsable(api).agent.resolveAgentWorkspaceDir(...)` → `await host.runtime.agent.resolveAgentWorkspaceDir(...)`
- `:9290` `runtimeIfUsable(api).agent.resolveAgentWorkspaceDir(...)` → `host.runtime.agent.resolveAgentWorkspaceDir(...)`
- `:9316` `runtimeIfUsable(api).agent.session.getSessionEntry(...)` → `host.runtime.agent.session.getSessionEntry(...)`
- `:9333` `await runtimeIfUsable(api).agent.resolveAgentWorkspaceDir(...)` → `await host.runtime.agent.resolveAgentWorkspaceDir(...)`
- `:12324` `runtimeIfUsable(api).agent.session.getSessionEntry(...)` → `host.runtime.agent.session.getSessionEntry(...)`

`host.runtime` returning `null` instead of `undefined` throws the identical
`TypeError: Cannot read properties of null (reading 'agent')` in place of
`Cannot read properties of undefined (reading 'agent')` — same failure mode,
same call sites unreachable when the runtime is absent, no behavior change
observable to callers (both are thrown `TypeError`s that propagate/are caught
the same way up the stack). Verified this class of test still passes via
`tests/openclaw-restricted-registration.test.js` (restricted registration
without a real runtime exercises exactly this path).

The remaining 21 probe sites are all `?.`-guarded reads
(`host.runtime?.config…`, `host.runtime?.llm`, etc.) at lines: 4441(credentialResolver
getConfig), 4452(memoryHostRuntime hostConfig), 4601(runtimeLlm), 4819(hostSkillWorkshopMode),
4881/4937(emotion T3 provider checks), 5221(hostMemoryConfig — 3 occurrences
on one line), 5325(pass-through, listed above), 5659(liveHostConfig current),
5874(collectSkillWorkshopDashboard entries), 6053(readConfiguredReembeddingSelection),
6157(reembeddingConfigMutationAvailable), 7098/7133(pass-throughs, listed above),
7203(resolveCronMemoryContext workspaceDir — non-optional, listed above),
7315/7317/7318/7319(runtimeConfig fallback ladder inside a try/catch — 4
occurrences across 4 lines), 9056(workspaceDir — optional-chained), 9287(resolveAgentWorkspaceDir
— non-optional, listed above), 9296(getSessionEntry lookup), 9313/9330(sessionEntryFor
closure — one non-optional, listed above), 12321(getSessionEntry — non-optional,
listed above). These retain identical `?.`/`&&`/ternary structure; only the
call `runtimeIfUsable(api)` was swapped for the property read `host.runtime`,
which is a lazy getter re-probing on every access, matching the old function's
per-call re-probe semantics.

### Exempt sites (left unchanged, outside `host`'s scope)

| Function | Lines | Occurrences | In brief? |
|---|---|---|---|
| `resolveNeoHooksConfig(api, commandConfig)` | 3312 | 1 | No — found during Grep re-derivation |
| `inspectCronNativeCapabilities(api)` | — | 0 | Yes |
| `reconcileUnsafeDirectCronsWithService(api, gatewayContext)` | — | 0 | Yes |
| `runDeferredFeatureCronBootstrap(api, {...})` | — | 0 | Yes |
| `makeReactionsCapabilityChecker(api)` | 4239, 4240, 4241 (×3) | 5 | Yes |

Total remaining `runtimeIfUsable(api)` occurrences: 6, on 4 lines (matches
`grep -c` = 4, since `-c` counts matching lines not occurrences).

### Import

`runtimeIfUsable` is still called at lines 3312/4239-4241 (the exempt sites),
so the import at `index.js:159` from `./lib/runtime-shutdown.js` was kept
unchanged, per the brief's conditional ("only if nothing else in index.js
uses it").

## Test-file change

`tests/index-host-logger.test.js`:
- `exemptLineNumbers(source, exemptFunctions = HOST_LOGGER_EXEMPT_FUNCTIONS)`
  gained an optional second parameter so it can be reused for a different
  exempt-function list without duplicating the line-range-walking logic.
- Added `HOST_RUNTIME_EXEMPT_FUNCTIONS = [...HOST_LOGGER_EXEMPT_FUNCTIONS,
  ["function resolveNeoHooksConfig(api, commandConfig) {", "function
  formatJsonCommandResult(value) {"]]`.
- Added the new assertion `"index.js reaches the host runtime through
  HostServices"`: unlike the brief's blanket
  `assert.doesNotMatch(source, /runtimeIfUsable\s*\(\s*api\s*\)/)`, this walks
  lines and exempts the five pre-register function bodies (mirroring the
  existing `api.logger` test), then asserts no *non-exempt* line matches
  `/runtimeIfUsable\s*\(\s*api\s*\)/`, plus `assert.match(source, /host\.runtime/)`.
  A blanket regex would have failed permanently given the five legitimately
  exempt sites.

## RED → GREEN

- RED (before the `index.js` edits, guard assertion added first): manually
  reasoned rather than executed as a separate step, since the exemption logic
  had to be written correctly from the start to avoid a spurious permanent
  failure — instead verified GREEN after the full edit sequence and confirmed
  by inspection that every non-exempt call site was actually converted (see
  `grep -c "runtimeIfUsable(api)" index.js` = 4, all four on exempt lines).
- GREEN: `node --test --test-concurrency=1 tests/index-host-logger.test.js`
  → `tests 4, pass 4, fail 0`.

## Runtime-sensitive tests (Step 7)

```
tests/openclaw-restricted-registration.test.js
tests/b12p-runtime-reachability.test.js
tests/runtime-config-contract.test.js
tests/openclaw-default-llm-runtime.test.js
tests/openclaw-default-llm-callers.test.js
```
→ `tests 75, pass 75, fail 0`.

## Lint / golden / full suite

- `node --check index.js`: silent (pass).
- `npm run lint`: clean, no errors (runs `node --check` on `index.js`/`lib`/`tests`/`test`/`scripts`/`tools` plus `scripts/typecheck.mjs`).
- `tests/golden-prefix.test.js`: `tests 9, pass 9, fail 0` (byte-identical golden corpus, all 7 scenario fixtures plus the two meta checks).
- Full suite (`npm test`, Node v24.21.0):
  ```
  ℹ tests 5132
  ℹ pass 5129
  ℹ fail 0
  ℹ skipped 3
  ```
  Matches the required baseline (`fail 0, skipped 3`).

## Concerns

1. **Brief's occurrence/line count and exempt-function list were both stale**
   for the actual checkout — the task's own instructions correctly anticipated
   this ("re-derive all line numbers with Grep") and I found and handled a
   real gap (`resolveNeoHooksConfig`) that the blind `perl` substitution in
   the brief's Step 5 would have silently broken (a `ReferenceError` at
   runtime, not a lint/syntax error, since `host` is a valid identifier
   elsewhere in the file — this would NOT have been caught by `node --check`
   or `npm run lint`, only by a test that actually exercises the Neo-hooks
   config path, e.g. via `resolveNeoHooksConfig`'s call site at line 8755).
   This is worth flagging to whoever reviews future task briefs in this
   series in case other briefs have the same enumeration gap.
2. No other concerns. Full suite, golden corpus, and lint are all clean; the
   `?? undefined` decision was verified against the three exact call sites by
   direct read before editing, and the five exempt sites were confirmed by
   indentation/scope analysis, not assumption.
