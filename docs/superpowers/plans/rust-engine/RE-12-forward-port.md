# RE-12 — Forward-port CP-5 and CP-7 to the Node engine `main` now

**Package.** Two correctness fixes the OpenClaw plugin line shipped (7.18.28: reranker order, bounded reranker input,
cache and graph hygiene; 7.18.31: skill-miner decision cache that never caches a retryable failure) are brought to the
engine's `main`, the harness pin is bumped to the result, and the goldens the Rust recall and skill-miner work needs
are recorded from that pin. Size S; independent of every other brief and worth doing first.

**Depends on.** Nothing. **Enables.** RE-04 T3 (goldens from `main` instead of a plugin-line checkout), RE-06 T5.

**Assumes.** RE-D8 (yes, forward-port now). Write access to `Cyb3rb1ade/openclaw-plur1bus-memory` or a fork plus a
PR there; the harness pin bump is a harness PR.

**Read first.**
- Plan §3.6 (CP-5, the eight rules), §3.8 (CP-7), §3.10 (the standing triage rule — this brief is its first execution),
  §0 (why the plugin-line commits are a delta, not a merge).
- Engine repository: `main` at `98dfe2f`; plugin line tag `v7.18.31` (`6419a60e`); the files that differ for each CP:
  - CP-5: `git diff 98dfe2f..v7.18.31 -- lib/recall-pipeline.js lib/recall-budget.js tests/recall-*.test.js`
  - CP-7: `git diff 98dfe2f..v7.18.31 -- lib/jobs/skill-miner.js lib/jobs/skill-miner/ tests/skill-*.test.js`
  - The plugin-line commits touch adapter files too; **port by patch, not by cherry-pick** (a release commit of the
    plugin line carries adapter and dashboard changes `main` must not receive).
  - The engine's own checks: `npm test` (`node --test --test-concurrency=1 tests/*.test.js test/*.test.js`), `npm run lint`
    (syntax check, `scripts/typecheck.mjs`, `scripts/lint-no-api-outside-adapter.mjs`, `scripts/lint-engine-imports.mjs`),
    its `AGENTS.md`.
- Harness: `packages/core/package.json:20` (the pin), `scripts/ci/changes.mjs` (`engine-pin` output: a pin bump
  selects the engine-dependent jobs), `scripts/gen-engine-keys.mjs` (`docs/config-engine-keys.md` regenerates from the
  pinned manifest), `THIRD_PARTY.md` (the npm row `@cyb3rb1ade/plur1bus-memory@<version>` changes if the package version
  changes; the header records the platform the notices were generated on — regenerate on macOS arm64 or edit the rows
  exactly as commit `f2752561` did), `tests/system/two-session-recall.test.ts`, `memory-ops.test.ts`, `dreams.test.ts`.

**Rules that apply.** The engine repository's rules (its `AGENTS.md`); no adapter or UI change rides along; every
rule of CP-5 and CP-7 gets a test on `main` (port the plugin line's tests with the code). In the harness: exact commit
pin, never a range; `pnpm install` updates the lock; `pnpm gen && pnpm docs:gen` after the bump.

## Files

- Engine `main`: `lib/recall-pipeline.js`, `lib/recall-budget.js`, `lib/jobs/skill-miner.js`, `lib/jobs/skill-miner/candidate-matching.js`
  (new on `main`), the ported tests, `package.json` version (patch bump), `CHANGELOG`/release notes if the repository
  keeps one
- Harness: `packages/core/package.json`, `pnpm-lock.yaml`, `docs/config-engine-keys.md` (generated), `THIRD_PARTY.md`,
  `THIRD_PARTY-LICENSES.txt` (only if the npm row changes), `tests/fixtures/recall/golden/G-RERANK-*.json` (recorded
  after the bump by RE-04's recorder — if RE-04 T3 has not started, record them here into `tests/engine-parity/golden/recall/`)

## Interfaces

**Consumes:** nothing. **Produces:** a new engine commit `<pin2>` on `main` with CP-5 and CP-7; the harness pinned to it;
the eight G-RERANK goldens and the skill-miner goldens recorded from `<pin2>`.

## Tasks

### T1 — CP-5 on engine `main` (one pull request in the engine repository)

- [ ] **Step 1: failing tests.** Port the plugin line's recall tests that cover the eight rules (identify them by the
  diff of `tests/recall-*.test.js`; where a rule has no plugin-line test, write one on `main`: `preserveOrder keeps the
  reranker order through the tier budget`, `the namespace merge keeps the reranker order`, `rerank input is bounded by
  max(topN, rerankCandidates)`, `a duplicate reranker index counts once`, `an empty reranker result is valid only with
  emptyResultIsValid`, `the provider ACL filter runs before rerank` (a reranker spy), `a failed knowledge section is not
  cached`, `a graph-only hit that fails hydration is excluded and traced`). Run `npm test` — the new tests fail.
- [ ] **Step 2: apply** `git diff 98dfe2f..v7.18.31 -- lib/recall-pipeline.js lib/recall-budget.js | git apply --3way`;
  resolve against `main`'s host-neutral code (the plugin line calls adapter helpers `main` does not have — keep the
  engine behaviour, drop the adapter call).
- [ ] **Step 3:** `npm test`, `npm run lint` green. **Commit** on a branch, open the PR, report its number.

### T2 — CP-7 on engine `main` (one pull request in the engine repository)

- [ ] **Step 1: failing tests** ported or written: `a retryable failure is not cached`, `a definitive decision expires
  after seven days`, `cache version 1 rows are ignored`, `clusterFingerprint is permutation-invariant`, `the prompt sees
  only related skills`, `supersedeBase supersedes the base version`, `SKILL_EXTRACTION_PROMPT_VERSION is "3"`.
- [ ] **Step 2: apply** the skill-miner diff the same way; `candidate-matching.js` is new, copy it.
- [ ] **Step 3:** `npm test`, `npm run lint`; bump the package patch version; open the PR, report its number.

### T3 — Harness pin bump and goldens (one pull request in this repository)

- [ ] **Step 1:** after both engine PRs merged: `packages/core/package.json` → `#<pin2>`; `pnpm install` (network to
  GitHub; the lock's tarball URL and integrity change); `pnpm gen`; `pnpm docs:gen`; notices if the npm row changed.
- [ ] **Step 2: failing tests first:** none new in the harness — the acceptance is that the existing suites stay green:
  `pnpm test`, `cargo test --workspace`, `tests/system/two-session-recall.test.ts`, `memory-ops.test.ts`, `dreams.test.ts`
  (locally with the AGENTS.md commands; CI's `engine-pin` selection runs them too).
- [ ] **Step 3: record goldens** from `<pin2>`: the eight `G-RERANK-n` (RE-04 T3's recorder, or the parity runner's
  `--record` if RE-09 T1 exists) and the skill-miner decision-cache goldens; commit them with `recordedFrom: <pin2>`.
- [ ] **Step 4: commit** `RE-12/T3: pin engine <pin2> (CP-5, CP-7) and record goldens`; open the PR, report its number.

## Acceptance

- Engine `main` has CP-5 and CP-7 with tests; `npm test` and `npm run lint` green there.
- The harness pin names `<pin2>`; `ci-gate` and `quality` green on the bump PR; `docs/config-engine-keys.md` regenerated
  (it may be unchanged — say so).
- Goldens committed and cited by RE-04 T3 and RE-06 T5 instead of a plugin-line checkout.

## Out of scope

CP-1, CP-3, CP-4a/b, CP-6 on the Node engine (they are features or adapter lessons, not fixes; the owner may commission
them separately through §3.10's template); any Rust code.

## Hand-off

Three PRs, T1 and T2 in the engine repository (they can be one PR if the owner prefers; keep the tests per CP separate),
T3 in this repository after both merged. Report the three PR numbers; the controller merges T3 under CLAUDE.md's rules.
