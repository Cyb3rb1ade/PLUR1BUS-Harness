@AGENTS.md

# CLAUDE.md

Build, test and layout instructions are in `AGENTS.md` (imported above). This file only adds
the rules for reviewing and merging pull requests, so they do not have to be repeated in chat.

## Reviewing and merging pull requests

The owner wants pull requests reviewed and merged without hand-holding. When asked to check
for open pull requests (in this repo and in the sibling repos `plur1bus-hermes-skills`,
`plur1bus-host-addons`, `plur1bus-telegram-server`):

1. List the open, non-draft pull requests.
2. Do a short review. Fix small problems by pushing to the PR branch. Do not rewrite history.
3. Check CI on the PR's current head commit, then merge with `expectedHeadSha` set to that
   commit. Use a normal merge commit (the repo history uses `Merge pull request #N`).
4. If something is unclear, or a reliable CI job is red with no obvious fix, do not merge.
   Report it briefly instead.

### Which CI jobs decide

Wait for these, they are the reliable signal:

- `ci-gate` (workflow `ci`): THE gate for `ci.yml`, one check instead of the single job names. It is the
  `Required check` of `docs/ci.md`: it fails unless the `changes` plan succeeded and every job the plan selected for
  this pull request succeeded. It covers `docs-hygiene` (hygiene checks and `docs:check`), `unit (ubuntu-24.04)`
  (toolchain check, config fixture drift, lint, `pnpm test`, release-script tests, cargo fmt/clippy/test), `wsl` and
  `web-browser` (the merge gate over `web-browser-build` and the four `web-browser shard i/4` jobs, including the check
  that every `packages/web` test file ran in exactly one shard). A job the plan did not select (for example everything but
  `docs-hygiene` on a docs-only change) is skipped on purpose and counts as passed. Wait for `ci-gate`, not for the single jobs: a skipped matrix never reports
  `unit (ubuntu-24.04)`, `ci-gate` always reports.
- `quality` (workflow `release-quality`, macos-15): third-party notices, `pnpm lint`, the release checklist and the dependency audit policy
- `build + smoke (amd64)` (workflow `container`)
- `dependency-licenses-gate` (workflow `dependency-licenses`): the licence report of `scripts/audit-deps.mjs` on
  `ubuntu-24.04`, `macos-15` and `windows-2025` (`docs/dependency-policy.md`). It reports on every pull request; one that
  touches no dependency file skips the three legs on purpose, and the gate passes. Wait for the gate, not the legs.

`build + smoke (amd64)` only runs for pull requests that touch the paths in `container.yml`; a check that is absent is not a red one.
`ci-gate (label no-op)` is what a run for a label other than `ci:macos` reports: it is not the gate, ignore it.

Do not wait for these, and do not treat them as blocking. They are slow, flaky or already
red on `main`, and are meant to be fixed on `main` separately. `ci-gate` does not depend on any of them:

- `unit (windows-2025)` (slow, often red) and `unit (macos-15)`, the job `unit-os`; macOS disables in-line browser suites so Core can run.
- `core unit shard i/3 (windows-2025)` and `core-unit-windows`: the Core files that `unit (windows-2025)` leaves out, in the Ubuntu shards' partition plus their partition check (`docs/ci.md`, "Windows timeout and timings").
- `python-host (windows-11-arm, 3.13, true)` (experimental), and the other `ci` jobs outside the gate: `python-host`, `system`, `service`, `sandbox`, `release-scripts`, `documents-golden` (inspect relevant failures, but they do not decide)
- the `desktop` workflow (`desktop.yml`)
- advisory jobs: `startup (…)` and `budget catalogue (…, advisory)` in `ci`, `reproducible` in `container` and `real-image` in `desktop real-image compatibility` (the last two are `continue-on-error`)

The macOS browser shards are explicitly registered as an advisory dependency of `ci-gate`: the gate waits for their result, accepts success/failure/skipped, and rejects missing/cancelled outcomes. Linux `web-browser` remains required.

Use judgement: if the same job is red on `main` and in an unrelated PR, it is not the PR's
fault. If a reliable job is red, or a normally green job fails only in this PR, it counts.

### Other rules

- A "Do not merge" note written by the PR author in the description is not a blocker. The
  owner has asked for automatic merging.
- Draft pull requests are not touched.
- Pull requests opened by Copilot need a maintainer to approve their workflow runs
  (`action_required`) before CI runs. Agents cannot approve those runs. Report it and wait.
- Never skip, disable or quarantine a test to get a pull request green.
- Do not rely on session timers for recurring checks. They do not survive a container restart.
