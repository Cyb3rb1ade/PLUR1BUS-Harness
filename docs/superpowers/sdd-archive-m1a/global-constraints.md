## Global Constraints

Every task's requirements implicitly include this section.

1. **Node ≥ 24.16.0.** `package.json:engines` is `">=24.16.0 <25 || >=26.1.0"`. Use `/home/claude/.node24/bin/node` (v24.21.0) for every command. Never invoke the default `node` (v22.22).
2. **No behaviour change.** M1a contains *no* intended behaviour change. Every task ends with the full suite at the accepted baseline **and** the golden-prefix corpus byte-identical. A task that cannot keep both stops and reports rather than updating the oracle.
3. **The golden oracle is append-only during M1a.** `tests/fixtures/golden-prefix/expected/*.txt` is written exactly once, in Task 1, on unmodified `main`. No later task may regenerate, edit or delete it.
4. **No new runtime dependencies.** `typescript@^5.9.3` is already in `optionalDependencies` and is a genuine *runtime* optional dependency (`lib/code-index/workspace-indexer.js:59` does `await import("typescript")`). Leave it in `optionalDependencies`; do not move it to `devDependencies`, do not add a second copy, do not add `dependency-cruiser` or `eslint` (neither is installed and the container has no reliable npm egress for them).
5. **No secrets and no real user data in fixtures.** Fixture memory text is invented; ids are fixed literal UUIDs; no path outside `os.tmpdir()` is written; no network call is made.
6. **`@cyb3rb1ade/plur1bus-memory` stays the published package name** (`package.json:2`) for the whole of M1a. PR-14 renames it later. Do not change `name`, `version`, `openclaw.compat`, `openclaw.build`, `main`, or the `scripts.postinstall` contract.
7. **No edits to `.github/workflows/*`** (`ci.yml`, `macos-portability.yml`, `macos-scoped-embedding.yml`). New checks are wired into the existing `npm run lint` script, which the CI `lint` job already runs.
8. **`engine/**` must not import** `openclaw`, `lib/setup/*-plugin-runtime.js`, `lib/runtime-shutdown.js`, `lib/providers/openclaw-memory-embedding-adapters.js`, or `index.js`. Enforced by `scripts/lint-engine-imports.mjs` from Task 10 onward.
9. **`index.js`'s named export list must not change.** 46 test files import internals from `../index.js`. The line `export { MemoryDB, buildMaintenanceNudges, appendConflictLog, buildConflictSummaryFromLog, createRuntimeRerankerProvider, inspectCronNativeCapabilities, guardUnsafeDirectCronTurn, parseFeatureCronBootstrapLastPlanCreateCount, reconcileUnsafeDirectCronsWithService, runDeferredFeatureCronBootstrap };` (`index.js:13495`) plus the nine `export function`/`export class` declarations stay exactly as they are; if a moved module now owns one, `index.js` re-exports it.
10. **Conventional Commits**, one commit per task unless a task says otherwise. Scope names used here: `platform`, `host`, `engine`, `adapter`, `test`, `docs`, `bench`, `types`.

