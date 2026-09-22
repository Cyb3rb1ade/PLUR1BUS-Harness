# Task 6 (PR-02a) report — `lib/host-services.js`

## Summary

Implemented per the brief, verbatim (code and tests matched the brief's Step 1/3
listings exactly; no `.d.ts` disagreement found — see below). Pure addition,
no call-site changes. Commit `dfab23ec`.

## `.d.ts` cross-check

`types/engine.d.ts` (ContractVersion 1.1.0) `HostServices`/`PlatformCapabilities`/
`Logger`/`HostRuntime` interfaces were read before implementing:

- `Logger` requires exactly `info/warn/error/debug` — matches `normalizeLogger`.
- `PlatformCapabilities` requires `securePath/ipcAddress/isUnsafeLink/canonicalIdentityPath`
  — matches `platformCapabilities`.
- `HostServices.runtime: HostRuntime | null` and the doc comment explicitly says
  it "Replaces runtimeIfUsable(api)" — matches the accessor design.
- `HostServices.llm?` is optional and untyped as to absence-vs-undefined; brief's
  `undefined`-when-absent behaviour is compatible.
- The interface has no `api` member. The brief's sample code adds `api` as an
  escape-hatch member anyway (commented "removed at PR-14"). This is not a
  conflict: TS structural interfaces don't reject excess properties on a
  non-literal return value, and `npm run lint` (which runs `scripts/typecheck.mjs`)
  passed. No disagreement to report — the brief's extra member is additive and
  harmless against the frozen contract.

No other disagreements found. Implemented the brief's code and tests exactly.

## Files changed

- Created `lib/host-services.js` — `normalizeLogger`, `resolveStateDir`,
  `platformCapabilities`, `createHostServices(api, options?)`,
  `createStubHost(overrides?)`.
- Created `tests/host-services.test.js` — 13 tests across
  `normalizeLogger` / `createHostServices` / `createStubHost`.
- Modified `scripts/lib/deploy-integrity.mjs` — added `"lib/host-services.js"`
  to `DEPLOY_FILES`, with a comment explaining it's not yet reachable from
  `index.js` (that's Task 7) and is added early so Task 7 doesn't trip the
  coverage tests.

## DEPLOY_FILES tolerance check (per task instructions)

Read `tests/deploy-integrity.test.js` before adding the entry. The relevant
tests are:

- `"contains every reachable relative runtime import from index.js"` — walks
  `index.js`'s import graph and asserts every **reachable** file is in
  `DEPLOY_FILES` (one-directional: reachable ⊆ listed). Does not assert the
  reverse.
- `"every file in DEPLOY_FILES exists on disk in the repo"` — only requires
  the file to exist, which it now does.
- `"all direct lib/ imports in index.js are covered by DEPLOY_FILES"` — only
  checks `index.js`'s literal `from "./lib/..."` import strings are covered.

None of these assert that every listed file must be reachable, so a
listed-but-not-yet-imported `lib/host-services.js` is tolerated today. Ran
`tests/deploy-integrity.test.js` standalone to confirm: 33/33 pass. Added it
now per the task instructions so Task 7's `index.js` rewrite doesn't need to
touch this file.

## TDD: RED

```
$ /home/claude/.node24/bin/node --test --test-concurrency=1 tests/host-services.test.js
...
✖ failing tests:
test at tests/host-services.test.js:1:1
✖ tests/host-services.test.js (47.96974ms)
  'test failed'
```
(Failure: `ERR_MODULE_NOT_FOUND` for `../lib/host-services.js`, as expected —
the module did not exist yet.)

## TDD: GREEN

```
$ /home/claude/.node24/bin/node --test --test-concurrency=1 tests/host-services.test.js
...
▶ createStubHost
  ✔ is inert and complete by default (0.351068ms)
  ✔ applies overrides, including a partial logger (0.801206ms)
✔ createStubHost (1.296712ms)
ℹ tests 13
ℹ suites 3
ℹ pass 13
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```

## Lint (includes typecheck)

```
$ PATH=/home/claude/.node24/bin:$PATH npm run lint
> node --check index.js && find lib tests test -name '*.js' -exec node --check {} + \
  && find scripts tools -name '*.mjs' -exec node --check {} + && node scripts/typecheck.mjs
(exit 0, no output)
```

## deploy-integrity.test.js (standalone)

```
$ /home/claude/.node24/bin/node --test --test-concurrency=1 tests/deploy-integrity.test.js
ℹ tests 33
ℹ suites 5
ℹ pass 33
ℹ fail 0
ℹ skipped 0
```

## Golden-prefix corpus

```
$ /home/claude/.node24/bin/node --test --test-concurrency=1 tests/golden-prefix.test.js
✔ golden prefix corpus (1238.111151ms)
ℹ tests 9
ℹ suites 1
ℹ pass 9
ℹ fail 0
ℹ skipped 0
```
Byte-identical: the golden oracle files were not touched (this task made no
edits under `tests/fixtures/golden-prefix/`), and the corpus test itself
passed clean.

## Full suite

```
$ PATH=/home/claude/.node24/bin:$PATH timeout 590 npm test
...
ℹ tests 5127
ℹ suites 910
ℹ pass 5124
ℹ fail 0
ℹ cancelled 0
ℹ skipped 3
ℹ todo 0
ℹ duration_ms 432802.002997
```
Matches the accepted baseline (`fail 0, skipped 3`).

## Behaviour-neutrality

- `lib/host-services.js` is not imported by `index.js` or any other production
  module yet — confirmed no call sites changed (`git diff` outside the three
  files above is empty; the only untracked file left in the tree,
  `docs/superpowers/plans/2026-09-22-m1a-engine-extraction.md`, predates this
  task and was intentionally left untouched/unstaged as unrelated).
- `runtime` and `llm` are implemented as `Object.defineProperty` accessors
  (not plain values), so `runtimeIfUsable(api)` is re-invoked on every read —
  verified directly by the "re-probes the runtime on every read instead of
  caching it" and "returns null for a runtime proxy that throws" tests.
- `normalizeLogger` returns a frozen 4-method object; missing methods are a
  shared `noop`, present methods are bound to the original logger object so
  `this` inside a user-supplied logger method still resolves correctly
  (covered by the "keeps the methods the host does supply, bound to it" test).
- `resolveStateDir` reads only `env.OPENCLAW_HOME`, never `process.env.HOME`,
  per host-contract §f.2 (Windows has no `HOME`).

## Self-review against AGENTS.md

- Naming: `camelCase` functions/variables (`normalizeLogger`, `resolveStateDir`,
  `createHostServices`, `createStubHost`), `UPPER_SNAKE_CASE` constant
  (`LOG_METHODS`) — consistent.
- JSDoc: every new export has `@param`/`@returns` plus a one-line description,
  matching "JSDoc for new or changed exports in the current phase."
- Async style: no promises/async in this file; not applicable.
- Error handling: no `try/catch` in this file (the one place that could throw,
  reading a possibly-throwing runtime proxy, is delegated entirely to
  `runtimeIfUsable`, which already owns that catch). No silent swallowing was
  introduced.
- No destructive operations, no LanceDB/filesystem/security-sensitive code
  paths touched by this file — the security-guideline sections (`safeUuid`,
  `safeAgentId`, `resolveInside`, `isAuthorized`, etc.) don't apply here.
- Global constraints: Node 24 used throughout via
  `PATH=/home/claude/.node24/bin:$PATH` / direct binary invocation; golden
  oracle untouched; no new runtime dependencies added; no secrets/real user
  data; no `.github/workflows` edits; `index.js` named-export list untouched
  (file wasn't even touched); Conventional Commit used with the `host` scope
  from the approved scope list.

## Concerns / follow-ups for later tasks

- None blocking. One thing worth flagging to Task 7: `createHostServices`'s
  `api` escape-hatch member is explicitly commented as temporary ("removed at
  PR-14") — Task 7 should not grow new call sites that lean on `host.api`
  beyond what's needed to shrink `index.js`'s direct `api` usage, since the
  brief frames this as the seam that's supposed to replace `api` reads.
- `lib/host-services.js` is listed in `DEPLOY_FILES` but not yet reachable
  from `index.js`; this is intentional (see above) and Task 7 should confirm
  the deploy-integrity tests still pass once the real import lands (they
  should — reachability only ever adds more required entries, it doesn't
  remove tolerance for already-listed ones).

---

## Fix (coordinator review, controller ruling): `workspaceDir` async, contract 1.2.0

**Finding:** `HostServices.workspaceDir(agentId)` was declared `string | undefined`
(sync) in `types/engine.d.ts:151`, but every real `resolveAgentWorkspaceDir` in
the repo is async (all 5 `index.js` call sites `await` it; ~25 test fixtures
define it `async`), so `createHostServices(api).workspaceDir(id)` returned a
Promise against any real host instead of the path itself. This is a defect in
the frozen contract, ruled fixed now rather than deferred.

### Changes

1. `types/engine.d.ts`:
   - `workspaceDir(agentId: AgentId): string | undefined` →
     `workspaceDir(agentId: AgentId): Promise<string | undefined>`.
   - `ContractVersion` bumped `"1.1.0"` → `"1.2.0"`.
   - Changelog line added: `1.2.0 — HostServices.workspaceDir becomes async (Task 6).`
2. `types/engine.conformance.ts`: `minimalHost.workspaceDir` changed from
   `() => undefined` to `async () => undefined` so the compile-time assertion
   still matches the (now async) `HostServices` interface.
3. `lib/host-services.js`:
   - `createHostServices`'s `workspaceDir` is now `async workspaceDir(agentId) { ...; return await resolver(api?.config, agentId); }`.
   - `createStubHost`'s default `workspaceDir` is now `async () => undefined`.
   - Removed the previously-unconditional `Object.entries(overrides)`
     re-application loop in `createStubHost` (it only ever excluded
     `"logger"`, so it silently re-assigned every other already-handled key
     to the same value). Replaced with a `STUB_HANDLED_KEYS` allowlist so the
     loop now only applies overrides for keys `createStubHost` doesn't
     already have an explicit line for (future-proofing for a test-only
     extra member), never re-touching a handled key.
   - Added the same "transitional, removed at PR-14" comment on the stub's
     `api` member that `createHostServices`'s `api` member already carried.
   - Updated the file's header doc comment: contract version reference
     (1.1.0 → 1.2.0) and a new paragraph explaining why `workspaceDir` is
     async.
4. `tests/host-services.test.js`:
   - The two existing `workspaceDir`-touching assertions
     (`createHostServices` "resolves a workspace dir..." and `createStubHost`
     "is inert and complete by default") now `await` the call.
   - Added `"awaits an async resolveAgentWorkspaceDir, as every real host
     provides"`: mocks an `async resolveAgentWorkspaceDir`, asserts
     `host.workspaceDir(id)` returns a real `Promise` (`instanceof Promise`)
     and that awaiting it yields the resolved string.

### Commands + output

`tests/host-services.test.js` (all 14, including the new async-resolver test):

```
$ /home/claude/.node24/bin/node --test --test-concurrency=1 tests/host-services.test.js
...
ℹ tests 14
ℹ suites 3
ℹ pass 14
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```

`npm run lint` (includes `scripts/typecheck.mjs`, which runs `tsc --noEmit`
over `types/` — this is what actually re-checks `engine.conformance.ts`
against the bumped `types/engine.d.ts`):

```
$ PATH=/home/claude/.node24/bin:$PATH npm run lint
> node --check index.js && find lib tests test -name '*.js' -exec node --check {} + \
  && find scripts tools -name '*.mjs' -exec node --check {} + && node scripts/typecheck.mjs
(exit 0, no output — tsc passed clean)
```

`tests/golden-prefix.test.js`:

```
$ /home/claude/.node24/bin/node --test --test-concurrency=1 tests/golden-prefix.test.js
✔ golden prefix corpus (1279.952075ms)
ℹ tests 9
ℹ suites 1
ℹ pass 9
ℹ fail 0
ℹ skipped 0
```
Byte-identical: no golden fixture files were touched by this fix; the corpus
test itself passed clean.

Full suite was not re-run for this fix, per coordinator instruction (no call
sites of `workspaceDir`/`HostServices` exist yet outside this task's own
tests — `lib/host-services.js` still isn't imported by `index.js`, that's
Task 7).

### Commit

`829b97e7 fix(host): make HostServices.workspaceDir async; bump engine contract to 1.2.0`
(files: `lib/host-services.js`, `tests/host-services.test.js`,
`types/engine.conformance.ts`, `types/engine.d.ts`).

### Self-review

- No behaviour change to any shipped call site (none exist yet for this
  module), so the global "no behaviour change" constraint isn't implicated —
  this changes an as-yet-unconsumed contract and its one implementation.
- `ContractVersion` bump follows the amendment policy in `types/engine.d.ts`'s
  own header: a changed return type on an existing member is exactly the kind
  of change the policy says "forces a bump," and the changelog line, the
  `engine.conformance.ts` assertion and the implementation all moved together
  in this one commit, per that same policy.
- Conventional Commit `fix(host): ...` used, `host` is an approved scope,
  Fable trailer lines included.
- Re-ran the affected tests only (`host-services.test.js`, lint/typecheck,
  golden) as instructed; did not re-run the ~7.5 min full suite since no
  production call sites changed.
