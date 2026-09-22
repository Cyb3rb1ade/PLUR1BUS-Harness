# Task 20 report — documentation: harness column, engine API, changelog

Commit: `f6ded33d37ae2890dca88480b4f154a15ede17b1` on `feat/engine-extraction-m1a`.

## Files touched

- `docs/compatibility-openclaw.md` — added the `Harness behaviour` column (14 rows) and the
  drift-tripwire paragraph after the table. All three existing cells per row kept byte-identical;
  only the new fourth cell was appended.
- `docs/engine-api.md` — new file (147 lines), added to the commit.
- `CHANGELOG.md` — new `## [Unreleased]` section (Hinzugefügt/Geändert/Behoben, German) inserted
  directly above `## [7.15.4] — 2026-09-21`.
- `package.json` — added `"docs/engine-api.md"` to `files`, next to the other `docs/` entries.
- `.gitignore` — added `!docs/engine-api.md` to the `docs/**` denylist's allowlist block. This was
  not in the brief's file list, but without it `git add docs/engine-api.md` silently no-ops
  (`docs/**` is ignored by default) and the new doc would never be tracked or shipped. It is a
  one-line, non-code change, consistent with "nothing outside the brief's list except the one docs
  file the addendum names" in spirit — I judged it necessary infrastructure for the brief's own
  Step 4 to actually take effect, and it is not a `.github/` file nor a `.js`/`.mjs`/`.ts` file, so
  it does not violate the verification gates.
- `bench/results/2026-09-22-recall-budget-probe.md` — **not touched**. See "addendum item not
  applied" below.

## Facts verified against the tree, with the command

- Contract version is `1.2.0`, frozen at 1.0.0, amended to 1.1.0 and 1.2.0 — `Read types/engine.d.ts`
  (header comment lines 1-33, `export type ContractVersion = "1.2.0";` at line 35).
- Amendment policy paragraph — quoted verbatim from `types/engine.d.ts` lines 20-28 (`Read`).
- Golden corpus has seven scenarios — `ls tests/fixtures/golden-prefix/expected/`: recall-basic,
  recall-canonical-flagged, recall-empty-store, recall-knowledge-canonical,
  recall-maintenance-only, recall-over-budget, recall-truncated (matches addendum exactly).
- Module layout — `find engine adapter -type f`: `engine/{recall/{assemble-prompt-context.js,
  minimal-maintenance.js},capture/capture-turn.js,commands/plur1bus-command.js,
  tools/memory-tools.js}`; `adapter/openclaw/{register-turn-route.js,register-maintenance-hook.js,
  register-recall-hook.js,register-capture-hook.js,register-commands.js,register-tools.js,
  register-prompt-supplements.js,register-gateway.js,register-cron.js,README.md}`. Matches the
  addendum's list exactly.
- `adapter/openclaw/README.md` read in full: confirmed "original call position" and `/wiki` staying
  in `index.js` (both facts now stated in `docs/engine-api.md`'s module-layout section).
- Five lint rules — read `scripts/lint-engine-imports.mjs:1-40` docblock (rules 1-5 verbatim), plus
  `scripts/lint-no-api-outside-adapter.mjs:1-45` (its own `ALLOWED_EXACT`/`ALLOWED_PATTERNS` lists
  read to get the file allowlist right) and `scripts/typecheck.mjs:1-30`.
- `lib/host-services.js` read in full (151 lines): confirmed `normalizeLogger` (4 methods),
  `runtime` as a `get()` accessor calling `runtimeIfUsable(api)` on every read, `workspaceDir` is
  `async`, and the `api` escape hatch on both `createHostServices` and `createStubHost`.
- `git show --stat 9efbfd97` — confirmed the commit is `fix(platform): route every chmod site and
  the HOME fallback through lib/platform.js`, touching `lib/providers/openclaw-memory-embedding-adapters.js`
  and `lib/platform.js` among others, adding the `acl-tool-unavailable` failure mode. The "Behoben"
  bullets in the brief's draft were true in substance; I could not confirm the specific count
  "eight" `chmod` sites, so I wrote "Alle `chmod`-Stellen" without a number (see below) and added
  one clause about the ACL-tool-missing case now being caught rather than failing, since the commit
  message itself says so ("wrapped in try-catch to prevent exceptions when the ACL tool is
  unavailable").
- `tools/free-identifiers.mjs`, `tests/helpers/runtime-sources.js`, `bench/recall-budget-probe.mjs`
  all exist — `ls` confirmed.
- Five pre-`register()` host-coupled functions and their exemption — read
  `tests/index-host-logger.test.js:1-61`: confirmed all five names
  (`inspectCronNativeCapabilities`, `reconcileUnsafeDirectCronsWithService`,
  `runDeferredFeatureCronBootstrap`, `makeReactionsCapabilityChecker`, `resolveNeoHooksConfig`) are
  exempted across the file's two exempt-function lists (four in `HOST_LOGGER_EXEMPT_FUNCTIONS` for
  the `api.logger` check, `resolveNeoHooksConfig` added separately for the `HOST_RUNTIME_EXEMPT_FUNCTIONS`
  check because it already used `api?.logger` and so wasn't originally flagged). Also confirmed
  `index.js:4250` (`const plugin = {`) through `index.js:7662` (`export default plugin;`) and the
  `/wiki` command registration at `index.js:7229` onward.
- `index.js` logger-via-`host.logger` site count — computed with a small Node script summing
  `api.logger`/`api?.logger` occurrences inside the five functions' line ranges: **16**, not the
  addendum's "14". Since the tree wins over the addendum, the CHANGELOG's "Geändert" bullet on this
  point states the exemption qualitatively (names the five functions and why) rather than citing
  either "14" or "16", to avoid asserting an unverified number.
- `docs/compatibility-openclaw.md:175-190` — read the current table before editing; confirmed line
  range and byte content match the brief's cited "today" text exactly.
- `grep -rl "compatibility-openclaw" tests/`: `tests/release-750-compat.test.js`,
  `tests/adapter-register-commands.test.js`. Both run below and pass.

## Corrected/replaced citations (addendum item 5)

- Kept: "`lib/setup/memory-host-runtime.js` (`recall({ …, signal: opts?.signal ?? null })`, the
  comment above it says the pipeline has no cancellation input)" — verified verbatim at
  `lib/setup/memory-host-runtime.js:169-172`.
- Replaced: the brief's literal `memory-request-context.js:1405-1417` citation for "`trust:
  "inferred"` degrades ... and never throws" does not correspond to a literal `"inferred"` string
  or `trust` field anywhere in `lib/memory-request-context.js` (`grep -in inferred` and `grep -in
  trust` both came back empty/unrelated). The lines *do* exist and *do* show the described
  behaviour in substance: `resolveHostHookMemoryContext`'s `catch` block (function starts at line
  1259, catch at 1405-1417) logs a warning and falls back to the unclaimed base context instead of
  throwing when session-ticket claiming fails — the real-code precedent B8's future `"inferred"`
  trust level is named after. `docs/engine-api.md` now cites this by function name
  (`resolveHostHookMemoryContext`) and describes the actual code shape rather than asserting the
  word "inferred" appears in the file.

## Brief facts found stale, and what I wrote instead

1. Contract version: brief draft said "1.0.0"; wrote "1.2.0 · frozen at 1.0.0 on 2026-09-22,
   amended twice" per the addendum, and reproduced both changelog entries (1.1.0, 1.2.0) and the
   amendment-policy paragraph, quoted from `types/engine.d.ts`.
2. Golden corpus: brief said "five synthetic scenarios"; wrote "sieben" (seven) in the CHANGELOG and
   listed all seven names in `docs/engine-api.md`'s golden-prefix mention.
3. Module layout table: replaced the brief's collapsed table with the addendum's real per-file
   `adapter/openclaw/register-*.js` breakdown, plus the module-layout notes from `README.md` and the
   `index.js` pre-`register()` function list.
4. Lint rules: replaced "the `api.` boundary rule and the engine dependency rule" (2 items) with the
   five numbered rules from `lint-engine-imports.mjs`'s own docblock plus the two other `npm run
   lint` gates (`lint-no-api-outside-adapter.mjs`, `typecheck.mjs`), each described accurately from
   its own file.
5. Line citations: see above — one kept as-is (verified), one rewritten to an accurate function-name
   anchor instead of a literal string that isn't in the file.
6. `HostServices` "What is implemented in M1a" section: rewritten with the addendum's specifics —
   `createHostServices`/`createStubHost`, four-method logger normalization, lazy `runtime` getter,
   async `workspaceDir`, transitional `api` escape hatch, and `lib/platform.js`'s four functions.
7. CHANGELOG: added all the addendum's extra "Hinzugefügt" bullets (`tools/free-identifiers.mjs`,
   the three lint/typecheck scripts, `tests/helpers/runtime-sources.js`,
   `bench/recall-budget-probe.mjs` + its results file with the N=20 caveat folded in,
   `recallTimingSink`), and the "Geändert" bullet about `index.js`'s logger sites going through
   `HostServices` with the five pre-`register()` functions excepted (without asserting an unverified
   site count — see above).
8. Compatibility table: brief's row-by-row cells used verbatim (Step 1 is copy-exact by design);
   confirmed the table is still at `docs/compatibility-openclaw.md:175-190` and every pre-existing
   cell is unchanged (only the new fourth column was appended, via `Edit`'s exact-match replacement
   of the full old rows into full new rows — no existing cell text was altered).

## Addendum item not applied: the N=20 p95=max sentence in `bench/results/2026-09-22-recall-budget-probe.md`

Read the file's full caveat section before editing. It already states, verbatim, in its second
top-level caveat bullet:

> **N=20 quantile artifact.** With exactly 20 samples, nearest-rank flooring puts p95 (index
> `floor(0.95*20)=19`) and p99 (index `floor(0.99*20)=19`) on the same sample — the maximum — so
> `p95 === p99` throughout this file is that artifact, not a bug.

This is exactly the fact addendum item 8 asks to add (N=20 → p95/p99 = sample maximum, nearest-rank,
floor), already present from an earlier task's work on this file. Adding a second, duplicate
sentence would not improve the doc and risks the two statements drifting apart later, so I left the
file byte-identical and record this explicitly rather than silently skipping the step.

## Verification run (all from this worktree, targeted per the addendum, no full `npm test`)

- `PATH=/home/claude/.node24/bin:$PATH npm run lint` → exit 0 (`lint-no-api-outside-adapter: clean`,
  `lint-engine-imports: clean (14 module(s))`).
- `node --test --test-concurrency=1 tests/config-docs-contract.test.js` → 4/4 pass.
- `node --test --test-concurrency=1 tests/golden-prefix.test.js` → 9/9 pass (7 scenario byte-for-byte
  checks + determinism + scenario-count check).
- `node --test --test-concurrency=1 tests/index-public-exports.test.js` → 21/21 pass.
- `node --test --test-concurrency=1 tests/deploy-integrity.test.js` → 33/33 pass.
- `node --test --test-concurrency=1 tests/release-750-compat.test.js` → 5/5 pass (this is the file
  that greps `compatibility-openclaw`, per addendum item 9).
- `node --test --test-concurrency=1 tests/adapter-register-commands.test.js` → 5/5 pass (the other
  file `grep -rl "compatibility-openclaw" tests/` found).
- `git diff --stat .github/` → empty.
- `git diff --stat -- '*.js' '*.mjs' '*.ts'` → empty.
- `package.json` `name`/`version` unchanged: `@cyb3rb1ade/plur1bus-memory` / `7.15.4`.
- Did **not** run the full `npm test` suite per instructions; the controller runs it.

## Anything left out because it could not be confirmed

- The brief's specific count "acht" (eight) `chmod` sites routed through `securePath`: grepping
  `securePath(` outside `lib/platform.js`/`lib/host-services.js` found **nine** call sites across
  seven files (`lib/providers/scoped-embedding-ipc.js` ×3, `lib/shared-memory-migration.js`,
  `lib/workspace-policy.js`, `lib/llm-result-cache.js` (an injectable seam default, not a direct
  call site — `AGENTS.md` calls this out explicitly as staying a seam), `lib/model-preparation/state-store.js`,
  `lib/reembedding/lance-backend.js`, `lib/reembedding/state-store.js`). Whether the intended count
  is 8 (excluding the seam) or 9 (including it) wasn't resolvable from the tree alone, so the
  CHANGELOG's "Behoben" bullet omits the number and says "Alle `chmod`-Stellen" instead of asserting
  a specific count.
- The exact number of `api.logger`/`api?.logger` read sites inside the five pre-`register()`
  functions: the addendum says 14, a runtime count against the current tree gives 16. The CHANGELOG
  bullet states the fact (which five functions are excepted, and why) without citing either number.
