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
