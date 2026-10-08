# CI: macOS runner policy

GitHub allows about five concurrent macOS jobs per account, and every PR push used to start four to six. Linux and
Windows legs are unchanged; the macOS legs beyond the unit tests are now gated.

## Which macOS legs run

| Event | `unit (macos-15)` | `system`, `service`, `python-host`, `real-hermes`, `desktop` (macOS legs) |
| --- | --- | --- |
| PR opened / synchronize / reopened | yes | only if the PR has label `ci:macos`, or it changes a platform-sensitive path (below) |
| PR `labeled` with `ci:macos` | yes | yes (the run is re-triggered; it replaces any run in progress) |
| PR `labeled` with any other label | no (the whole run is a no-op) | no |
| push to `main` | yes | yes |
| schedule (nightly, 03:23-03:41 UTC) | yes | yes |
| workflow_dispatch | yes | yes |

Workflows: `ci.yml`, `desktop.yml`, `hermes-host.yml`. Their own `paths:` filters on PRs are unchanged (`desktop.yml` and
`hermes-host.yml` only start for their paths), so adding `ci:macos` to a PR that touches none of them runs nothing extra
from those two; `ci.yml` always runs.

## Where the policy lives

`scripts/ci/macos-plan.mjs` is the one place. Each workflow starts with a cheap ubuntu `plan` job that runs it and
exposes `proceed` (false only for a `labeled` event of another label), `macos` (run the gated legs) and `python_matrix`.
Jobs use `needs: plan`, and the matrices drop their macOS entries with
`exclude: ${{ fromJSON(needs.plan.outputs.macos == 'true' && '[]' || '[{"os":"macos-15"}]') }}`
(`python-host` takes its whole matrix from `python_matrix`). The script has tests, `scripts/ci/macos-plan.test.mjs`,
which the `plan` job runs first.

Platform-sensitive paths (the `SENSITIVE` list in the script; edit it there only):
`crates/**`, `Cargo.lock`, `packages/core/src/platform*`, `packages/core/src/**/acl*`, `packages/module-api/**`,
`packages/core/src/rpc/**`, `packages/core/src/secrets/**`, `hosts/hermes/**`, `clients/python/**`, `scripts/install*`,
`.github/workflows/**`. A trailing `*` is a prefix match. `desktop.yml` additionally gates its macOS leg on
`apps/desktop/**` (`--extra`).

## Nightly

`ci.yml`, `desktop.yml` and `hermes-host.yml` each have a `schedule:` trigger (full matrix); `nightly.yml` keeps the real-model
and fuzz jobs. `nightly-report.yml` listens (`workflow_run`) for those four finishing and, only for a failed `schedule`
run, opens or comments on one issue titled `Nightly CI red: <UTC date>`. It holds `issues: write` and nothing else, runs no
repository code, and never fires for PRs, pushes or manual runs. A `workflow_run` workflow is read from the default
branch, so it starts working once this is merged.

## Using it

Add the `ci:macos` label to a PR to get the full macOS matrix before merging (for example when a change is
platform-sensitive in a way the path list misses). A required status check on a gated job name (`system (macos-15)` and
so on) would stay pending on a PR that skips it; `main` has no branch protection at the time of writing.

## Job map and failure semantics

| Job | Gate |
| --- | --- |
| `plan` | Tested runner/label policy; a non-macOS label event deliberately runs no expensive matrix |
| `unit` | Toolchain, fixture drift, lint, offline TypeScript tests, Rust fmt/clippy/tests and generated docs |
| `system` | Existing stack tests, cold recall, extension fixture tests and kill soak (unchanged test command) |
| `service` | Service manager tests; existing systemd-unavailable handling remains documented in the workflow |
| `python-host` | Python client/Hermes offline and live synthetic-host tests; Windows ARM informational policy is unchanged |
| `wsl` | Real WSL setup and synthetic migration/snapshot security tests |
| `release-scripts` | Ubuntu-only offline release tests and local actionlint validation of all workflows |
| nightly `system-real-models` | Real model acceptance and full kill soak; may fetch model weights |
| nightly `ext-fuzz` | Seeded extension inspect fuzzing |

CI/nightly actions are pinned to full commit SHAs; comments record their versions. Workflow default is `contents: read`. PR concurrency cancels superseded runs. No new third-party retry action is introduced.

### Windows timeout and timings

`pnpm test` gets 35 minutes on windows-2025 (25 elsewhere). The Windows unit job ceiling is 90 minutes (65 elsewhere), leaving time for setup, Rust tests and docs. A timeout is a failure, not an accepted skip. No unit test is retried.

A TAP reporter preserves the root runner's nonzero-test guard while recording the sum of top-level test/suite durations per file. Nested child durations are not counted twice. The `test-timings-<os>` artifact contains per-process JSON and `top-20.txt`; the top 20 are also printed after failure. A forcibly killed process may have no completed report, so timings after timeout can be partial. These are test/suite execution times, not profiler CPU time or package-install time.

### WSL infrastructure retry

The known `setup-wsl` failure with exit `4294967295` is confined to setup. The pinned setup action is attempted at most three times, with 5 seconds then 15 seconds backoff. Only attempts temporarily use `continue-on-error`; the final status step exits nonzero if none succeeded. That job stays red and prints an infrastructure error; skipped WSL tests are never presented as passing. Once setup succeeds, every fixture/test step runs once and any test failure stays red. Cancellation does not retry tests.

### Config fixture drift

The observed 64-line change in `tier-cases.json` was missing schema descriptions, not clock, path or Map-order randomness. The old parity test intentionally removed descriptions, hiding the stale committed fixture. The regenerated fixture now includes them and the parity assertion compares all fields.

`gen-defaults.mjs --check` compares exact bytes without writing. CI invokes it **before** `pnpm gen`, and beside the lint/docs gates, so generation cannot silently repair a stale commit before detection. `pnpm --filter @plur1bus/config-schema check:fixtures` is the standalone local check. The offline generator test also generates twice into a temporary directory, compares every file and proves a stale description fails read-only checking. Root package scripts remain unchanged; run the standalone check before local `pnpm lint`/`pnpm docs:check`, whose existing prep hooks regenerate files.

### Reproducible job boundary

The existing `reproducible` job belongs to `container.yml`, not `ci.yml` or `nightly.yml`; it remains outside this change's allowed workflow scope. Reading its implementation shows two cache-independent Docker image builds and digest comparison, with `SOURCE_DATE_EPOCH` and rewritten timestamps already set. Its current `continue-on-error: true` remains an informational exception, **not a proven reproducibility pass**. No CI logs were fetched to attribute a particular historical failure to infrastructure.

The Dockerfile already records a concrete nondeterminism source: pnpm's hoisted linker can select a different top-level version of `typical`/`array-back` (#149). It uses isolated deployment there. The release assembler still uses hoisted deployment for its existing link-free runtime contract; M8a excludes pnpm timestamp/store metadata and compares two independent deployments. Remaining mismatches are real gate failures and are not retried. Changing the container workflow/Dockerfile or replacing the deploy layout requires a separate scoped change; no infrastructure diagnosis is inferred from a digest mismatch.

## Local reproduction

See [the release verification commands](release.md#local-verification) for the complete checklist. In addition:

```bash
node packages/config-schema/src/gen-defaults.mjs --check
pnpm --filter @plur1bus/config-schema test
node --test scripts/release/test/*.test.mjs
# Install actionlint separately at v1.7.7, then validate without running workflows:
actionlint -shellcheck= -config-file scripts/release/actionlint.yaml .github/workflows/*.yml
```

To collect file timings locally, set `TEST_TIMING_DIR` and `NODE_OPTIONS` to the absolute file URL of `scripts/release/timing-reporter.mjs` with `--test-reporter-destination=stdout`, run `pnpm test`, then `node scripts/release/timing-summary.mjs <directory>`. The source reporter does not change test outcomes. WSL setup reproduction requires a Windows host with the corresponding Ubuntu distribution; offline Linux/macOS tests are not evidence for that platform.
