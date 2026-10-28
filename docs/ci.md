# CI: affected suites and runner policy


## PR impact selection (GP5 P2)

`ci.yml` starts a `changes` job. It reads the PR's actual Git merge-base diff with `--no-renames -z`, so both sides of
moves and non-ASCII paths count. It compares the private Engine dependency value separately. Missing history or an
invalid manifest fails the plan; unknown paths and empty diffs select the full suite. No GitHub write permission is used.

| PR paths | Selected checks |
| --- | --- |
| Only `docs/**`, standard root documents or package/module README/CHANGELOG files | Documentation and hygiene |
| `docs/errors.md`, `docs/rpc.md`, `docs/cli.md`, `docs/openapi.json`, `docs/api-surface.md` | Rust and TypeScript, as for code: `docs_consistency.rs`, `cli_surface.rs`, `error_codes_sync.rs`, the OpenAPI tests and `check-cli-exit-codes` read them |
| `docs/operations.md` | Rust (`skill_freshness.rs` checks the commands it quotes) |
| `docs/rbac.md`, `docs/channels/**`, `docs/embedding-adapters.md`, `docs/media-adapters.md`, `docs/ops/zabbix/**` | TypeScript (package tests read them) |
| `docs/user/**` | Browser suite (the web help test renders them), plus documentation/hygiene |
| `skills/**` | Rust and TypeScript (bundled skills: `skill_freshness.rs`, setup tests, `tests/system/setup.test.ts`) |
| `packages/web/**` | Documentation/hygiene, TypeScript check, served-stack browser build, all four shards and exact-partition verification |
| `crates/**`, `Cargo.toml`, Rust toolchain | Rust fmt/clippy/tests, runtime integrations, documentation/hygiene and the served-stack browser suite (`web-browser-build` compiles the CLI) |
| `crates/**/fixtures/**` or `crates/plur1bus/src/backup/restore.rs` | Rust plus TypeScript (shared fixture/source parity readers), the browser suite, runtime integrations and documentation/hygiene |
| Other `packages/**` | TypeScript unit checks, the browser suite (it builds and serves Core and the packages it bundles), runtime integrations and documentation/hygiene |
| `tests/**` | TypeScript unit checks, runtime integrations and documentation/hygiene |
| Shared RPC/config/log schemas or module API | Rust, TypeScript, browser, Python and documentation/hygiene |
| `hosts/**` or `clients/python/**` | Python/Hermes, WSL and documentation/hygiene |
| `packages/documents/**` | TypeScript/runtime checks plus golden rendering |
| Engine pin, any Cargo lock, pnpm lock, workflow or unknown path | Full suite |

The reader lists live in `TEST_READ` in `scripts/ci/changes.mjs`. Accepted gap: `error_codes_sync.rs` scans every other
`docs/**/*.md` (except `docs/superpowers` and `docs/handoff`) for error-code words, so a documentation-only pull request
that names an unknown code passes `ci-gate` and fails the Rust suite on the next push to `main`, which runs everything.

The category outputs are `rust`, `ts-core`, `web`, `python`, `docs-only`, `workflows`, `engine-pin` and `documents`.
The existing macOS label/path policy still selects the platform legs *within* each affected suite; it cannot turn a
failed classifier into a successful skip. Main pushes, scheduled nightly and manual CI runs select all suites.
`merge_group.checks_requested` starts the same workflow and selects all suites, including the full macOS policy and
all Core/browser shards. It uses the queue commit checked out by Actions and needs no PR diff, labels or PR metadata.

The `unit` job (ubuntu-24.04; the macOS and Windows legs are the separate `unit-os` job, see below) keeps setup/build and checks only the selected language's tests: TypeScript changes
omit Rust fmt/clippy/unit tests, Rust-only changes omit the TypeScript unit suite; shared Rust fixtures and the restore marker
source select both. Served-stack browser acceptance still
builds the current CLI on Ubuntu. Runtime/sandbox/service/Python/WSL and startup/budget jobs remain conservative for
Rust or TypeScript runtime changes. They do not run for documentation or isolated web changes. Markdown under source templates, skill packages and test fixtures follows its owning suite; a `.md` suffix alone is not a documentation change. No test is removed,
relaxed or converted to a skip. Independent `desktop.yml`, `container.yml`, `hermes-host.yml` and release workflows
retain their existing path rules. Their checks are not folded into this workflow's gate.

### Required check and failures

`ci-gate` is THE gate of `ci.yml`: the one check to wait for (and, once branch protection is configured, the one to
require). It runs with `always()` after the required reliable jobs: `docs-hygiene`, `unit` (the
`unit (ubuntu-24.04)` leg), P5 `core-unit-shard` and `core-unit` when TypeScript is selected, `wsl` and `web-browser` (itself the aggregate over `web-browser-build` and the four shards, and
the exact-partition check). It requires `changes` to succeed and all category outputs to be literal `true` or `false`.
Every selected required job must report `success`; `failure`, `cancelled`, `skipped`, an absent result or an unknown job in
`needs` fail the gate. An unselected job may be `skipped` or may have succeeded, but never failed or cancelled. The gate
reports even when the plan selected nothing, which is why a skipped `unit` matrix (never reports `unit (ubuntu-24.04)`)
is no reason to wait on a name.

`web-browser-macos` was an advisory dependency of the gate until the owner decision of 2026-10-28: the gate waited for its two-shard matrix outcome, although it accepted a failure. Merges then waited for hours on the macOS runner queue, so the gate no longer waits for it. It still runs when `proceed`, `web` and `macos` are all true and reports its own check.

Everything else in `ci.yml` is deliberately outside the gate and not in its `needs`, so it can neither fail nor delay it:
`unit-os` (`unit (macos-15)` and `unit (windows-2025)`: slow, and the macOS leg has a known failing package; since the
Actions concurrency change below it only runs under the full-platform policy), the Windows Core shards
`core-unit-shard-windows` (`core unit shard i/3 (windows-2025)`) and their partition check `core-unit-windows`, which
follow the same policy,
`python-host` (including the experimental `windows-11-arm` leg), `system`, `service`, `sandbox`, `release-scripts`,
`documents-golden`, `host-tool-eval` (the deterministic host tool/policy scenarios of D106 P4, fake OS ports, no live model), the build and shards of the browser suite (their verdict is in `web-browser`) and the advisory
`perf-startup` and `perf-budgets` jobs. They still run for their selected suites and show up as checks; a red one is a
reason to look, not an automatic block. To promote a job, add it to `selections` in `scripts/ci/gate.mjs`, to the gate's
`needs` and remove it from `UNGATED`; the workflow contract test fails until all three agree. Other workflows
(`release-quality`'s `quality`, `container`'s `build + smoke (amd64)`) are separate checks that are not folded in.

A `labeled` event for any label other than `ci:macos` is a no-op run: `changes` sets `proceed=false`, nothing runs and
its concurrency group differs from the real run's, so it never cancels it. Its gate job is named `ci-gate (label no-op)`
instead of `ci-gate`, so it can never appear as a fresh green `ci-gate` on a head commit whose real run is still
running or red. `ci:macos` itself re-triggers a real run, which reports `ci-gate`.

### Merge queue: owner activation (GP5 P6)

The workflow is prepared for merge groups. Queue activation remains an explicit owner decision; no repository setting
is changed here, and the Controller/Watcher process continues unchanged until the owner enables an available queue.
The read-only repository API on 2026-10-21 reports a public repository with `owner.type=User`. GitHub currently offers
GitHub.com merge queues for organization-owned repositories, so this repository first needs an owner-approved change
of ownership or future feature availability. Do not move it automatically for this feature. See
[GitHub's merge queue documentation](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue).

Only after a green Windows baseline and refreshed open PR heads, and when eligible, an administrator can open Settings → Branches (or the existing main ruleset), select the exact `main`
branch, require the GitHub Actions `ci-gate` check and enable **Require merge queue**. Use the aggregate check rather
than filtered/matrix job names, which can deliberately skip on PRs. Any other required workflow must also report for
merge groups before activating the queue. Start with queue build concurrency 1 to limit runner demand; increase it
only after a measured queue/throughput comparison. A successful PR check does not substitute for the queue commit's check.

Open owner decision: whether to enable a queue after integration and after resolving feature availability. Recommendation:
retain the current Controller/Watcher for this personal repository; review any organization move separately. If a queue
becomes available and is approved, use exact `main`, `ci-gate` and initial build concurrency 1. No existing permission,
branch-protection or merge-method setting is silently changed.

The [CI throughput handoff](handoffs/2026-10-21-ci-throughput.md) preserves the historical P1 baseline and the executable
preflight for a genuine measurement after P1–P5 integration. No after measurement or speedup is claimed yet.

`gate.test.mjs` exercises result combinations, and `workflow-contract.test.mjs` evaluates the actual job-level boolean
conditions against the skip policy, proves the gate's `needs` are exactly the gated jobs and every other job is on the
`UNGATED` list, proves `unit-os` preserves the unit steps with full TypeScript coverage on macOS while Ubuntu and Windows exclude only the separately sharded Core package (the Windows shards use the Ubuntu partition, follow the full-platform policy and stay outside the gate), and evaluates the gate's job name for every event. Matrix
failures of gated jobs remain failures. Performance jobs still run their existing diagnostic commands and
known-gap behavior; no numerical budget is promoted from advisory to a hard assertion.

**Required-check migration gate:** only after a green Windows baseline and refreshed heads for all open PRs, configure
the `ci-gate` check from the `ci` workflow as the required check for this workflow, replacing individual matrix names. This PR does not change branch protection or repository rules. The controller (`CLAUDE.md`, "Which CI jobs decide") waits for `ci-gate`, `quality` and, when present, `build + smoke (amd64)`; merge-queue setup belongs to P6.

Local checks: `node --test scripts/ci/*.test.mjs` and
`actionlint -shellcheck= -config-file scripts/release/actionlint.yaml .github/workflows/*.yml`.

## macOS runner policy

GitHub allows about five concurrent macOS jobs per account, and every PR push used to start four to six. Actions
concurrency overall is the bottleneck as well (about five concurrent jobs against 80 to 100 queued), and a Rust or core
PR push started 17 jobs that do not decide a merge (`CLAUDE.md`, "Which CI jobs decide"). Since the owner decision of
2026-10-22 the non-deciding **non-Linux** legs of `ci.yml` (macOS, Windows, Windows ARM) follow the same full-platform
policy as the macOS legs; the Linux legs and everything the gate waits for run on every selected push.

The policy output is called `macos` for historical reasons; it now means "run the full platform matrix", and it also
switches on the Windows and Windows ARM legs listed below. It is not a macOS-only switch.

## Which macOS legs run

For `ci.yml`, the impact filter above is applied first: a documentation-only PR does not run a unit matrix.
The table below describes platform selection inside an affected suite.

| Event | `unit (macos-15)`, `unit (windows-2025)` (job `unit-os`) and the other non-Linux legs listed below | `system`, `service`, `python-host`, `real-hermes`, `desktop` (macOS legs) |
| --- | --- | --- |
| PR opened / synchronize / reopened | only if the PR has label `ci:macos`, or it changes a platform-sensitive path (below) | same |
| PR `labeled` with `ci:macos` | yes (the run is re-triggered; it replaces any run in progress) | yes |
| PR `labeled` with any other label | no (the whole run is a no-op) | no |
| push to `main` | yes | yes |
| schedule (nightly, 03:23-03:41 UTC) | yes | yes |
| workflow_dispatch | yes | yes |

Legs of `ci.yml` that follow this policy (everything else in the file, including every `ubuntu-24.04` and
`ubuntu-24.04-arm` leg, runs whenever its suite is selected):

| Job | Non-Linux legs that wait for the policy | Always on a selected push |
| --- | --- | --- |
| `unit-os` | `unit (macos-15)`, `unit (windows-2025)`: the whole job is conditional (`needs.changes.outputs.macos == 'true'`), because all its legs are non-Linux | none (the Linux leg is `unit`) |
| `core-unit-shard-windows`, `core-unit-windows` | `core unit shard i/3 (windows-2025)` and its partition check: conditional like `unit-os`, whose Windows leg leaves Core to them | none (the Linux shards are `core-unit-shard`) |
| `system` | `macos-15` | `ubuntu-24.04` |
| `service` | `macos-15`, `windows-2025` | `ubuntu-24.04` |
| `sandbox` | `macos-15`, `windows-2025`, `windows-11-arm` | `ubuntu-24.04`, `ubuntu-24.04-arm` |
| `perf-startup` (`startup (...)`) | `darwin-arm64`, `win32-x64`, `win32-arm64` | `linux-x64`, `linux-arm64` |
| `perf-budgets` (`budget catalogue (...)`) | `macos-15`, `windows-2025`, `windows-11-arm` | `ubuntu-24.04`, `ubuntu-24.04-arm` |

Not moved: `unit (ubuntu-24.04)`, `wsl` (a required Windows job), `web-browser*`, the `python-host` matrix (its Windows legs
are unchanged), `docs-hygiene`, and the other workflows (`release-quality`, `container*`, `desktop.yml`, `hermes-host.yml`).
Nothing in `ci-gate` depends on the moved legs, so a PR without the policy gets the same gate verdict as before. A PR that
changes nothing platform-sensitive therefore shows no `unit (macos-15)`, `unit (windows-2025)`, `core unit shard i/3 (windows-2025)`, `core-unit-windows`, `service (windows-2025)`,
`sandbox (macos-15|windows-*)`, `startup (darwin-arm64|win32-*)` or `budget catalogue (macos-15|windows-*)` check; an absent
check is not a red one. Add `ci:macos` to get them before merging. The mixed matrices use
`exclude: ${{ fromJSON(needs.changes.outputs.macos == 'true' && '[]' || '[...]') }}`; `perf-startup` has no base `os` list, so
it selects its whole `include` list by the same expression (an `exclude` cannot remove `include` entries).
`scripts/ci/workflow-contract.test.mjs` evaluates these matrices and conditions for both values of the policy.

Workflows: `ci.yml`, `desktop.yml`, `hermes-host.yml`. Their own `paths:` filters on PRs are unchanged (`desktop.yml` and
`hermes-host.yml` only start for their paths), so adding `ci:macos` to a PR that touches none of them runs nothing extra
from those two; `ci.yml` always runs.

## Where the policy lives

`scripts/ci/macos-plan.mjs` owns the platform policy. In `ci.yml`, the cheap Ubuntu `changes` job invokes it through
`changes.mjs` and exposes `proceed` (false only for a `labeled` event of another label), `macos` and `python_matrix`.
Its jobs use `needs: changes`; matrices use `needs.changes.outputs.macos`, and `python-host` reads
`fromJSON(needs.changes.outputs.python_matrix)`. `desktop.yml` and `hermes-host.yml` retain their separate `plan` jobs
and references to that job's outputs. The policy's tests are `scripts/ci/macos-plan.test.mjs`.

Platform-sensitive paths (the `SENSITIVE` list in the script; edit it there only):
`crates/**`, `Cargo.lock`, `packages/core/src/platform*`, `packages/core/src/**/acl*`, `packages/module-api/**`,
`packages/core/src/rpc/**`, `packages/core/src/secrets/**`, `hosts/hermes/**`, `clients/python/**`, `scripts/install*`,
`.github/workflows/**`. A trailing `*` is a prefix match. `desktop.yml` additionally gates its macOS leg on
`apps/desktop/**` (`--extra`).

## Self-hosted macOS runner

Since the owner decision of 2026-10-28 the deciding macOS jobs, `quality` (`release-quality.yml`) and the macOS leg of
`dependency-licenses`, can run on a macOS VM on the owner's Mac instead of waiting in GitHub's macOS queue. Their
`runs-on` picks the label `plur1bus-macos-vm` only while the repository variable `MACOS_SELF_HOSTED` is `true`, and only
for code from this repository: a push, a manual or scheduled run, or a pull request whose head branch is in this
repository. A fork's pull request and a merge group always run on `macos-15`. `scripts/ci/macos-vm-runner.test.mjs`
checks that no other job uses the label and that every route to it admits only those events.

The pieces are in `scripts/ci/macos-vm-runner/`:

- `guest-provision.sh` prepares the template, a stopped Parallels macOS VM: a hidden user `ghrunner` without admin
  rights who runs every job, the Command Line Tools, the pinned runner (checked against its SHA-256), Rust 1.95 with
  cargo-deny 0.20.2, no Spotlight, no automatic updates, no sleep, and a pf anchor that lets jobs reach the internet
  but not the host, its LAN, a tailnet or link-local addresses. `plur1bus-runner-once`, the per-job entry point it
  installs, refuses a job while that anchor is not loaded.
- `orchestrator.sh` runs on the Mac as a LaunchAgent (`install-host.sh` installs it). For each job it clones the
  template (an APFS clone: about a second and no disk space until the job writes), starts the clone, asks GitHub for a
  single-use just-in-time runner configuration with the owner's `gh` login and passes it to the clone on stdin. The
  runner takes exactly one job, then the clone is deleted, so no job sees what an earlier one left. The configuration
  is never on a command line or in a log. Parallels' rollback mode (`--undo-disks`) is not used: it is accepted but has
  no effect on a macOS guest.
- The orchestrator sets `MACOS_SELF_HOSTED=true` once its first runner is registered, and `false` when it stops or
  after three failed attempts in a row. While it runs on AC power it keeps the Mac from sleeping (`caffeinate -s`;
  `PLUR1BUS_RUNNER_CAFFEINATE=0` turns that off).

A job routed to the VM waits while the Mac sleeps or is off. Stop the orchestrator before a longer break
(`launchctl bootout gui/$(id -u)/com.plur1bus.ci-runner`): new runs then go to GitHub-hosted runners again, and a job
that was already queued for the VM needs a re-run. `prlctl exec` needs the Parallels guest tools, which stop
answering when the VM is isolated, so `--isolate-vm` stays off; clipboard, shared folders, cloud, profile,
application and SmartMount sharing are switched off one by one instead.

To change the template (a new runner version, another toolchain), stop the orchestrator, start the template, run
`guest-provision.sh` in it as its header describes, shut it down and run `install-host.sh` again. Never start the
template while the orchestrator runs.

## Nightly

`ci.yml`, `desktop.yml` and `hermes-host.yml` each have a `schedule:` trigger (full matrix); `nightly.yml` keeps the real-model
and fuzz jobs. `nightly-report.yml` listens (`workflow_run`) for those four finishing and, only for a failed `schedule`
run, opens or comments on one issue titled `Nightly CI red: <UTC date>`. It holds `issues: write` and nothing else, runs no
repository code, and never fires for PRs, pushes or manual runs. A `workflow_run` workflow is read from the default
branch, so it starts working once this is merged.

## Using it

Add the `ci:macos` label to a PR to get the full platform matrix (macOS, and also the Windows and Windows ARM legs listed
above) before merging, for example when a change is platform-sensitive in a way the path list misses. A required status check on a gated job name (`system (macos-15)` and
so on) would stay pending on a PR that skips it; migrate to the aggregate `ci-gate` only after the Windows baseline and open-head refresh gate above. This change does not inspect or modify current protection settings.

## Job map and failure semantics

| Job | Gate |
| --- | --- |
| `changes` (`plan` in Desktop/Hermes workflows) | Tested runner/label policy; a non-macOS label event deliberately runs no expensive matrix |
| `docs-hygiene` | Gated. Hygiene, source quality, i18n, doc links and `pnpm docs:check` (generated documents), for every selected run |
| `unit` | Gated (ubuntu-24.04). Toolchain, fixture drift, lint, offline TypeScript tests outside Core, Rust fmt/clippy/tests |
| `core-unit-shard`, `core-unit` | Gated. Three measured Ubuntu Core shards plus the exact-partition check; missing manifests, failure and cancellation block |
| `unit-os` | Not gated; only under the full-platform policy. The same steps as `unit` on `macos-15` and `windows-2025`, check names `unit (macos-15)` and `unit (windows-2025)`: full offline TypeScript workspace tests on macOS, every package but Core on Windows |
| `core-unit-shard-windows`, `core-unit-windows` | Not gated; only under the full-platform policy. Core on `windows-2025` in the three measured Ubuntu shards (`core unit shard i/3 (windows-2025)`) plus their exact-partition check |
| `web-browser-macos` | Not gated (since 2026-10-28). Runs for proceed + web + macos and reports its own check |
| `web-browser` | Gated. Aggregate over `web-browser-build` and the four `web-browser shard i/4` jobs plus the exact-partition check |
| `system` | Not gated. Existing stack tests, cold recall, extension fixture tests and kill soak (unchanged test command); the macOS leg follows the full-platform policy |
| `service` | Not gated. Service manager tests; existing systemd-unavailable handling remains documented in the workflow; the macOS and Windows legs follow the full-platform policy |
| `python-host` | Not gated. Python client/Hermes offline and live synthetic-host tests; Windows ARM informational policy is unchanged |
| `wsl` | Gated. Real WSL setup and synthetic migration/snapshot security tests |
| `release-scripts` | Not gated. Ubuntu-only offline release tests and local actionlint validation of all workflows |
| `sandbox`, `documents-golden` | Not gated. Kernel sandbox probes on five runners (the three non-Linux ones follow the full-platform policy); golden-set visual diff |
| `perf-startup`, `perf-budgets` | Not gated. Advisory timings and budget catalogue; the macOS, Windows and Windows ARM legs follow the full-platform policy |
| `ci-gate` | THE gate: the required jobs above |
| nightly `system-real-models` | Real model acceptance and full kill soak; may fetch model weights |
| nightly `ext-fuzz` | Seeded extension inspect fuzzing |

CI/nightly actions are pinned to full commit SHAs; comments record their versions. `node scripts/lint-hygiene.mjs` (rule HYG-016) rejects any workflow `uses:` that is not a full SHA, a local `./` action or a `docker://` image with a `@sha256:` digest. It also rejects known annotated tag-object SHAs from the small offline denylist in `scripts/workflow-pin-gate.mjs`. That list cannot establish the type of an arbitrary Git object: when updating a pin, verify it through the Git API or `git ls-remote <repository> 'refs/tags/<tag>' 'refs/tags/<tag>^{}'` and use the peeled commit, with a version comment. Add newly discovered tag objects to the list with verification evidence and a regression test. Dependabot (`.github/dependabot.yml`) proposes action updates once a week in one group, and only releases that are at least 14 days old (`cooldown.default-days: 14`, owner decision 2026-10-28), so a compromised release has time to be noticed before it reaches a workflow that holds credentials. Workflow default is `contents: read`. PR concurrency cancels superseded runs. No new third-party retry action is introduced.

### Core sharding and job budgets (GP5 P5)

For selected TypeScript suites, Ubuntu runs `packages/core` in three `core-unit-shard` jobs. The existing Ubuntu
unit job runs every other package through the same root test runner and its nonzero-test guard. macOS keeps the full
unsharded offline workspace test run; macOS browser tests run explicitly in `web-browser-macos`. Windows splits like
Ubuntu (see "Windows timeout and timings" below). New Core files are always included, even before their timing is measured.

`.github/ci/core-test-timings.json` records all 601 Core file durations from the historical successful Ubuntu run
39516791460 at `1dae60f2ae` (artifact 12310137290). `selectShard` assigns the longest measured file first to the
least-loaded shard, with deterministic ties, a 100 ms floor and a 1000 ms estimate for new files. Only the Core
job sets `PLUR1BUS_TEST_SHARD_TIMINGS`; browser sharding remains round-robin. No test or assertion was removed.

Each Core shard writes its executed file list and uploads a timing report. `core-unit` checks the manifests against
the live file inventory and requires the entire matrix to succeed. The final `ci-gate` requires both the shard
matrix and the partition gate when TypeScript was selected. A missing/cancelled/failed shard cannot become a pass.
Every `ci.yml` job has an explicit budget; new Core shards allow 20 minutes per job and 15 minutes for tests, with
5 minutes for the partition gate. Existing platform and integration budgets remain in place until new measurements
justify changing them. The [P5 handoff](handoffs/2026-10-21-gp5-p5-core-shards.md) lists all budgets, the global Top 20,
the measured partition and its limits. The projected balance is not a hosted before/after result.

The Rust engine crate (`crates/plur1bus-engine`, RE-00, PR #759) brings the Lance, DataFusion and Arrow closure into the
workspace build. `unit (ubuntu-24.04)` took 20 min 45 s on `main` (scheduled run 40077418934, head 955161d3) and
36 min 08 s on the PR's first run with a cold cache for that closure (run 40060694169), within the 65-minute job
ceiling (90 on Windows, unchanged). Its `cargo test --workspace --no-fail-fast` step took 16 min 26 s of its 20-minute
budget on that cold run against 7 min 54 s on `main` (`cargo clippy` 7 min 39 s against 1 min 24 s), too thin a margin
for a closure that only grows, so the test execution step has 30 minutes in `unit` and `unit-os`; their separate test-build step now has 25 minutes (see below). The PR's second run (40086339873,
after a lockfile change) measured the same, job 35 min 17 s, `cargo test` 16 min 06 s, `cargo clippy` 7 min 25 s:
`rust-cache` did not shorten the Rust steps, so these figures are the working assumption, not a cold-cache outlier.
RE-R6 of the Rust-engine plan tracks the cost; the next measurement after RE-02, the first code that links Lance, decides whether the engine tests get
their own job.

To run a weighted Core shard locally after preparation:

```bash
PLUR1BUS_TEST_SHARD=1/3 PLUR1BUS_TEST_SHARD_TIMINGS="$PWD/.github/ci/core-test-timings.json" \
  pnpm --filter @plur1bus/core test
```

### Windows timeout and timings

The unit test step gets 35 minutes on windows-2025 (25 elsewhere). The Windows unit job ceiling is 90 minutes (65 elsewhere), leaving time for setup, Rust tests and docs. A timeout is a failure, not an accepted skip. No unit test is retried.

Core does not fit into that step on Windows: windows-2025 needs about 4.4 s per Core test file (main run 40116614656
ran 343 of the 666 files in 25 minutes; Ubuntu needs about 1 s, macOS about 0.7 s), so `unit (windows-2025)`'s
`pnpm test` hit the 35-minute limit with Core half done, and every step after it (the Rust tests among them) was
skipped. The Windows leg of `unit-os` therefore leaves Core out with Ubuntu's command
(`node scripts/run-ts-tests.mjs --filter=!@plur1bus/core`), and `core-unit-shard-windows` runs it in the same three
measured shards as Ubuntu (same `PLUR1BUS_TEST_SHARD` and timings file, so the same partition), about 222 files or
16 minutes each. Each shard job has 40 minutes, its test step 30. `core-unit-windows` checks the Windows manifests
with `test-shards.mjs verify` and requires every Windows shard to succeed. The Windows artifacts are named
`windows-core-unit-manifest-<i>` and `core-test-timings-windows-2025-<i>`, so the gated Ubuntu `core-unit` download
pattern `core-unit-manifest-*` never sees them. Both jobs follow the full-platform policy like `unit-os` and stay
outside `ci-gate`. Nothing is skipped: every Core file still runs on Windows, once.

#### Independent Rust results and separate build timing (package I)

In `unit` and `unit-os`, the empty-filter guard, release-script tests, Windows installer tests and every Rust/tokenizer
step after the Node tests explicitly use `!cancelled()`. Rust steps also require `needs.changes.outputs.rust == 'true'`.
A failed Node test, fmt or clippy step therefore cannot hide later Rust results; cancellation still stops work. Failures
remain failures of the job. `ci-gate` and the existing job names/dependencies are unchanged.

`cargo test --workspace --no-run` has a separate 25-minute build budget. The following
`cargo test --workspace --no-fail-fast` retains its 30-minute execution budget. Run 2487 on Windows spent about
20 minutes compiling and then 10 minutes testing before the former combined 30-minute step was killed. The 25-minute
build budget covers that measured build; the existing 30-minute test budget now applies entirely to test execution.
The 90-minute Windows / 65-minute macOS job ceilings remain. These ceilings are not promises that all step maxima can
be consumed together: a complete hosted run is still required to establish the total, especially on macOS where Rust
was previously skipped. A separate Rust job requires an owner decision if the measured total does not fit.

Baseline: [main run 2487](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/actions/runs/40572184733), 2026-10-27.
A dash means no completed measurement, not zero time or a pass.

| System / run | Node tests | clippy | Rust test build | Rust test execution |
| --- | --- | --- | --- | --- |
| macOS 15 / 2487 | 20.8 min, failed | skipped | skipped | skipped |
| Windows 2025 / 2487 | passed; duration unavailable | 14 min | about 20 min (inside combined step) | at least 10 min; combined step timed out |
| macOS 15 / package I | pending hosted run | pending | pending | pending |
| Windows 2025 / package I | pending hosted run | pending | pending | pending |

The new steps expose actual build/execution durations separately. Local Linux timings and simulations cannot establish
macOS or Windows completion; two consecutive hosted passes remain the acceptance criterion.

A TAP reporter preserves the root runner's nonzero-test guard while recording the sum of top-level test/suite durations per file. Nested child durations are not counted twice. The `test-timings-<os>` artifact contains per-process JSON and `top-20.txt`; the top 20 are also printed after failure. A forcibly killed process may have no completed report, so timings after timeout can be partial. These are test/suite execution times, not profiler CPU time or package-install time.

### WSL infrastructure retry

The known `setup-wsl` failure with exit `4294967295` is confined to setup. The pinned setup action is attempted at most three times, with 5 seconds then 15 seconds backoff. Only attempts temporarily use `continue-on-error`; the final status step exits nonzero if none succeeded. That job stays red and prints an infrastructure error; skipped WSL tests are never presented as passing. Once setup succeeds, every fixture/test step runs once and any test failure stays red. Cancellation does not retry tests.

### Config fixture drift

The observed 64-line change in `tier-cases.json` was missing schema descriptions, not clock, path or Map-order randomness. The old parity test intentionally removed descriptions, hiding the stale committed fixture. The regenerated fixture now includes them and the parity assertion compares all fields.

`gen-defaults.mjs --check` compares exact bytes without writing. CI invokes it **before** `pnpm gen`, and beside the lint/docs gates, so generation cannot silently repair a stale commit before detection. `pnpm --filter @plur1bus/config-schema check:fixtures` is the standalone local check. The offline generator test also generates twice into a temporary directory, compares every file and proves a stale description fails read-only checking. Root package scripts remain unchanged; run the standalone check before local `pnpm lint`/`pnpm docs:check`, whose existing prep hooks regenerate files.

### Reproducible job boundary

The existing `reproducible` job belongs to `container.yml`, not `ci.yml` or `nightly.yml`; it remains outside this change's allowed workflow scope. Reading its implementation shows two cache-independent Docker image builds and digest comparison, with `SOURCE_DATE_EPOCH` and rewritten timestamps already set. Its current `continue-on-error: true` remains an informational exception, **not a proven reproducibility pass**. No CI logs were fetched to attribute a particular historical failure to infrastructure.

The Dockerfile already records a concrete nondeterminism source: pnpm's hoisted linker can select a different top-level version of `typical`/`array-back` (#149). It uses isolated deployment there. The release assembler still uses hoisted deployment for its existing link-free runtime contract; M8a excludes pnpm timestamp/store metadata and compares two independent deployments. Remaining mismatches are real gate failures and are not retried. Changing the container workflow/Dockerfile or replacing the deploy layout requires a separate scoped change; no infrastructure diagnosis is inferred from a digest mismatch.

## Dependency and browser caches

The existing `actions/setup-node` pnpm cache stores the directory reported by `pnpm store path --silent`, with a
key derived from the root `pnpm-lock.yaml`, runner OS and architecture. It saves in a successful job's post step.
The existing `Swatinem/rust-cache` key includes Cargo lockfiles/manifests, toolchain files, `rustc` identity, OS and
architecture; its default failure-cache option is off. Keep these actions instead of adding overlapping caches.
The pinned implementations and reviewed paths are recorded in the [GP5 P4 handoff](handoffs/2026-10-21-gp5-p4-ci-caches.md).

For `unit` and `unit-os`, Rust cache writes are explicitly limited to successful `refs/heads/main` runs
(`save-if`), while PRs still restore the compatible default-branch cache. `cache-on-failure` remains explicitly `false`;
the existing cache-policy regression requires failed jobs not to publish caches. Run 2487 reported no restored cache on
both Ubuntu and Windows. With the default failure-save setting, a consistently red job cannot seed its own cache.
The reviewed pinned implementation includes the job, OS/architecture, toolchain and manifests in its key, with a
lockfile-independent restore prefix; a different job's successful cache is therefore not evidence of a reusable unit
cache. Main-only writes bound the producers without removing key dimensions or caching additional paths.

The Actions cache inventory request on 2026-10-27 returned HTTP 403, so current cache bytes, hit age and repository
quota usage could not be measured. Eviction at the 10-GB quota is a hypothesis, not a diagnosis; no cache was deleted
and no quota/repository setting was changed. Confirm inventory and first successful main save/next restore before
claiming a cache hit or speedup. The policy deliberately does not promise a cache for a still-failing main job.

The Playwright cache key includes OS, architecture and the lockfile hash. Chromium installation still runs to
install Linux libraries and download missing browser files. The combined cache action saves only on success.
Standalone model-cache saves also require success, a cache miss and a populated model directory; failed or
cancelled Nightly runs no longer publish model caches. Cache paths exclude home-wide archives, git configuration,
package-manager credentials and Harness runtime homes. Keep credentials in the existing install-step mechanism.

`node --test scripts/ci/cache-policy.test.mjs` checks save conditions for success, failure and cancellation,
cache hits/misses, empty/populated directories, browser-key isolation and the reviewed cache paths/options.
The existing `release-scripts` job runs these offline checks. No hosted speedup is claimed without a later P1
measurement. `sccache` remains an evaluated option: current dependency caches already exist, and P1 has not yet
isolated compiler misses that justify another pinned tool and cache lifecycle.

## Local reproduction

Prepare the checkout before running Rust tests with TypeScript child processes or the TS suite:

```bash
pnpm test:prep
cargo test --workspace
pnpm test
```

Use Node 24.21 and pnpm 10 on `PATH`. `scripts/test-prep.mjs` runs the workspace install with
`--frozen-lockfile`, then `pnpm gen` and `pnpm build`; this creates generated RPC files, schema
`dist` files and `packages/core/dist/core.js`. It checks the actual audit source imports, the built
Core entry and resolution of the private Engine from Core before reporting readiness. A failed
stage stops preparation with a nonzero exit; no test is skipped or retried by this command.

The pinned private `@cyb3rb1ade/plur1bus-memory` dependency needs authenticated read access to its
repository or an already cached copy of that exact package. Without it, Core integration and
Engine-dependent TS tests cannot run. An install or Engine-check failure explains this requirement;
the dependency and lockfile remain required. The mixed Rust/TS audit tests and live-endpoint repair
test now diagnose missing workspace/build prerequisites before starting their integration work.
The package test runner adds setup guidance to a missing-Engine resolution error and preserves
its failing result.

`test:prep` prepares JavaScript dependencies and artifacts. Rust binaries and the matching browser
still need the commands documented for their suites below; browser or native acceptance is not
implied by a successful preparation. The existing CI continues to use the real pinned Engine.

### Actions throughput snapshot (GP5 P1)

`node scripts/ci/timings.mjs --repo Cyb3rb1ade/PLUR1BUS-Harness --workflow ci.yml --runs 50 --out /tmp/ci-baseline`
reads the most recent 50 runs once through the authenticated `gh api` client. It needs Actions read access and never
polls for completion or changes repository settings. The output prefix produces raw `.json` and a `.md` summary;
`--input /tmp/ci-baseline.json` reproduces the summary offline. Workflow and run/job pagination are explicit, and only
the selected run's latest attempt is measured. An API error fails the collection instead of publishing partial data.

Percentiles use nearest rank. Job wait is `started_at - created_at`, which can include dependency or environment delay
as well as runner queue time. Skipped jobs and missing/invalid times contribute no timing sample. Incomplete runs are
reported separately; cancelled jobs can have partial execution times. Runs/day uses the span of selected run creation
times, with a one-day minimum; a latest-N window is not an unbiased calendar-day sample. A newer different head on the
same branch/event makes a cancelled run a supersession candidate, not a proven concurrency cancellation. Compare
equivalent workflow/event mixes after changes; do not claim speedups from a mostly unfinished or cancelled sample.

The initial measurement and its limitations are in [the P1 handoff](handoffs/2026-10-21-ci-baseline.md).

See [the release verification commands](release.md#local-verification) for the complete checklist. In addition:

```bash
node packages/config-schema/src/gen-defaults.mjs --check
pnpm --filter @plur1bus/config-schema test
node --test scripts/release/test/*.test.mjs
# Install actionlint separately at v1.7.7, then validate without running workflows:
actionlint -shellcheck= -config-file scripts/release/actionlint.yaml .github/workflows/*.yml
```

To collect file timings locally, set `TEST_TIMING_DIR` and `NODE_OPTIONS` to the absolute file URL of `scripts/release/timing-reporter.mjs` with `--test-reporter-destination=stdout`, run `pnpm test`, then `node scripts/release/timing-summary.mjs <directory>`. The source reporter does not change test outcomes. WSL setup reproduction requires a Windows host with the corresponding Ubuntu distribution; offline Linux/macOS tests are not evidence for that platform.

## macOS browser suites

`packages/web/test/browser-runtime.ts` also looks for the system Chrome (`/Applications/Google Chrome.app`), which every macOS runner has. `unit (macos-15)` therefore ran the whole browser suite in-line (`--test-concurrency=1`, 20+ minutes against 85 seconds on Linux, where no Chromium is found), and the 25-minute `pnpm test` step timed out inside `packages/web`: `packages/core`, which runs last, never started. Observed on main runs 39295005315 and 39345213479; the macOS state of core is unknown until a run reaches it.

The fix is an explicit, documented switch, not a removed browser path: `PLUR1BUS_WEB_BROWSER=off` makes every browser suite of `packages/web` report `skipped` with the reason `browser suites off (PLUR1BUS_WEB_BROWSER=off); they run in the web-browser job`. The `unit-os` job sets it on macOS only (the identical Linux `unit` steps leave it empty) (`runner.os == 'macOS'`); Linux and Windows are unchanged. Combined with `PLUR1BUS_WEB_E2E_REQUIRED=1` it is a startup failure, so required mode can never be switched off. The switch is tested in `packages/web/test/browser-required.test.ts`.

The coverage moves to `web-browser (macos-15, i/2)` (job `web-browser-macos`): two round-robin shards (`PLUR1BUS_TEST_SHARD=i/2`), frozen dependencies, `pnpm gen && pnpm build`, lockfile-matched Playwright Chromium (`PLUR1BUS_WEB_E2E_REQUIRED=1`, cached in `~/Library/Caches/ms-playwright`). It runs only when `changes` reports `proceed`, `web` and `macos` all true (macOS policy: push to main, schedule, dispatch, label `ci:macos`, platform-sensitive paths). It is not part of `ci-gate` (owner decision 2026-10-28; until then the gate waited for its outcome as an advisory dependency) and not part of the required Linux `web-browser` aggregate, and it writes no shard manifest. The served-stack tests (`real-transport`, `real-accounts`, `surfaces-e2e`) need the Rust CLI and stay with the Linux shards (they skip here with a reason).

## M3 web browser checks

`web-browser` in `ci.yml` (a gated job, see `ci-gate` above) runs on Ubuntu with Node 24.21.0 and frozen workspace dependencies. Its package-local Playwright CLI installs Chromium plus Linux libraries; this selects the browser revision belonging to the lockfile's exact Playwright version. `PLUR1BUS_WEB_E2E_REQUIRED=1` refuses a missing matching browser and disables the system-Chrome fallback. The job builds Core and the current-branch CLI with the pinned Rust toolchain, sets an absolute `PLUR1BUS_BIN`, and sets `PLUR1BUS_WEB_TRANSPORT_REQUIRED=1`; served-stack account/transport tests cannot silently skip. The complete web suite runs, including axe, keyboard, token contrast, four responsive widths and zoom. Commit 175969ea introduced the job as informational. A separate gate commit removes continue-on-error after the complete required local browser run passed (1,994 total, 1,988 passed, zero failed/skipped, six explicit TODO). A subsequent strictly additive Core budget-write rule and promoted web case passed their separate 79-test acceptance (78 passed, zero failed/skipped, one hardware TODO); five web TODOs remain. The frontend production tree did not change in that late merge. Hosted CI was not polled and is not claimed green.

Since the owner decision of 2026-10-18 the suite runs in four shards. `web-browser-build` compiles the current-branch CLI once and passes it to the shards as the `web-browser-cli` artifact. Each `web-browser shard i/4` installs frozen dependencies, runs the esbuild `pnpm gen && pnpm build`, installs Chromium through the same package-local Playwright CLI (browser files cached by lockfile hash) and runs `pnpm --filter @plur1bus/web test` with `PLUR1BUS_TEST_SHARD=i/4`. `PLUR1BUS_WEB_E2E_REQUIRED=1`, `PLUR1BUS_WEB_TRANSPORT_REQUIRED=1` and the absolute `PLUR1BUS_BIN` are set in every shard. `scripts/test-package.mjs` deals the sorted `test/**/*.test.ts` list round-robin (`scripts/ci/test-shards.mjs`), so file k goes to shard (k mod 4) + 1, and writes a manifest of the files it ran. The `web-browser` job keeps the gate's check name. It fails unless `plan`, `web-browser-build` and every shard succeeded, and its shard check (`test-shards.mjs verify`) fails unless the manifests of shards 1 to 4 are disjoint, none is empty, and together they equal the package's full test list. A malformed `PLUR1BUS_TEST_SHARD` stops the run instead of running every file. Locally, `PLUR1BUS_TEST_SHARD=2/4 pnpm --filter @plur1bus/web test` runs one shard.

The registry-driven `shipped-conformance.test.ts` includes every shipped page automatically. Browser reflow at 200% uses 720 CSS px and device scale 2 for the equivalent 1440 physical-pixel window; CSS `zoom` alone leaves media queries unchanged. The shipped-page matrix also checks enlarged text with CSS zoom at 200%; the existing pattern cases remain. Target measurements use the WCAG 2.5.5 inline-prose exception, while standalone links and controls remain measured ([W3C target-size explanation](https://www.w3.org/WAI/WCAG22/Understanding/target-size-enhanced.html)). Browser fixture tests establish UI accessibility and layout, while served-stack acceptance is recorded independently in `docs/demos/m3.md`.

The macOS unit lint step uses a 4096 MiB V8 heap. This increases the available memory without reducing the checked files or changing the gate. Verification on the local Mac does not prove a hosted runner's memory behavior; CI is not polled.


## Superseded-run cancellation (GP5 P3)

The cancellation behavior requested by GP5 was already present on main at `1dae60f2ae` (including #655's workflow
hygiene work). P3 preserves it and adds offline regression checks; it introduces no concurrency mutation.

- `ci`, `desktop` and `hermes-host` group by workflow and PR number (falling back to ref). That is stable across new
  commits on one PR and distinct across PRs. Unrelated label events use the existing `-noop` suffix so they cannot
  cancel a useful run; `ci:macos` intentionally replaces it with the requested platform run.
- `cancel-in-progress` is true only for `pull_request`, false for main pushes, schedules, manual and merge-group runs.
- `container` and `release-smoke` already use the same PR-only cancellation. P3 leaves their workflows unchanged.
  Release-smoke tests a candidate; it does not publish it.
- `harness-release` explicitly uses `cancel-in-progress: false`, including reusable/manual invocations. `nightly` has
  no PR trigger, and its schedule/manual events cannot activate its existing PR-only cancellation expression.

`node --test scripts/release/test/concurrency.test.mjs` evaluates the actual concurrency expressions with synthetic
Actions contexts: different commits/PRs/refs/workflows, all relevant event types and both label cases. It checks the
existing policy without dispatching or polling Actions. The release-script suite already runs this file in CI.

No repository rules, release policy, controller merging or watcher behavior change in P3.
