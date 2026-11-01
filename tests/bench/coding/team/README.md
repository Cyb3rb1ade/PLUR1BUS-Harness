# Team-tier coding fixtures (D124 PT-2)

Eighteen original MIT tasks: twelve decomposable tasks with three separately owned packages each, and six sequential
or tightly coupled tasks. Each task has its own instruction, seed generator, starting tree, reference overlays,
package checkers and end-to-end checker. No upstream benchmark content or third-party dependencies are included.

| Task | Language | Kind |
| --- | --- | --- |
| `ts-event-ledger` | TypeScript | Decomposable |
| `ts-release-notes` | TypeScript | Decomposable |
| `ts-calendar` | TypeScript | Decomposable |
| `py-order-allocation` | Python | Decomposable |
| `py-document-index` | Python | Decomposable |
| `py-csv-import` | Python | Decomposable |
| `rs-range-set` | Rust | Decomposable |
| `rs-route-path` | Rust | Decomposable |
| `rs-frame-checksum` | Rust | Decomposable |
| `go-access-log` | Go | Decomposable |
| `go-retry-plan` | Go | Decomposable |
| `go-file-manifest` | Go | Decomposable |
| `ts-schema-migration` | TypeScript | Coupled |
| `ts-balance-reducer` | TypeScript | Coupled |
| `py-money-pipeline` | Python | Coupled |
| `py-url-pipeline` | Python | Coupled |
| `rs-frame-pipeline` | Rust | Coupled |
| `go-stock-ledger` | Go | Coupled |

## Fixture contract

`catalog.json` is the task list. The closed `plur1bus.team-task/1` manifests are validated by
`packages/core/src/collab/team-eval.ts`. K2's B1 loader intentionally skips this `team/` directory. Its future team adapter will map this additive contract
to the runner; this change supplies no second runner and no model execution.

Each manifest declares three uint32 seeds (17, 104729, 8675309), explicit file ownership and package dependencies,
an integration order and a checker scope per package plus `e2e`. Each package owns one exact seeded source path;
`__SEED__` is resolved to the instance tag, with no broad ownership glob. The parser verifies that the entry is owned and
decomposable ownership is disjoint. The initial fixture allocation is 131,072 total tokens,
100 model rounds and 2,700,000 ms. These are benchmark inputs, not changes to product defaults or measured recommendations.
At matched budgets every arm shares the same task cap across all model calls, including helpers, reviewers and repairs.
Natural budgets must come from the runner's configured defaults and remain explicit in the comparison.

Each private `seed.mjs` exports `instanceForSeed(seed)` for public instance metadata and `casesForSeed(seed)` for private
checker inputs/oracles. The common materializer expands filenames and instance identifiers from the seed and writes
only `start/`, the instruction as `TASK.md` and an allowlisted `instance.json` into the candidate tree. It never copies
checkers, seed-generator code or references into agent input. Reference overlays are for fixture self-tests only.

The initial and reference implementations use the same UTF-8 string-to-string contracts. Hidden probes call the
candidate's exported functions in separate processes; they do not trust candidate tests, printed claims or source-text
matching. Each scope builds only its package, so a broken sibling cannot contaminate its grade; `e2e` composes all
packages. Go and Rust compile with only their standard libraries. Go uses a private module containing the owned source,
ignoring candidate `go.mod`/toolchain/replace directives, with proxies and cgo disabled. Child processes receive an
allowlisted environment without ambient credentials.
Python runs isolated with bytecode writing disabled and explicit UTF-8 mode, including on Windows. Probe/build
directories are temporary and removed in `finally`.

For coupled tasks each reference overlay preserves preceding fixes and changes the shared pipeline file. The self-test
checks actual changed content and intersecting file sets. For decomposable tasks those sets are disjoint. It also grades
one isolated solution at a time for decomposable tasks and the successive partial reference stages for coupled tasks.

## Run the fixture self-test

Use Node 24.21, Rust 1.95, Go 1.27.1 and Python 3.13 on PATH; missing tools fail explicitly. From the repository root:

```sh
node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning --test --test-concurrency=1 --test-timeout=120000 packages/core/test/collab/team-eval.test.ts packages/core/test/collab/team-fixtures.test.ts
```

Every package checker and the integration checker must fail on the starting tree and pass on the reference for all
three seeds. The public tree must contain neither hidden artifacts nor unexpanded seed filenames. This fixture proof
runs in the normal Core suite; the CI jobs that run Core install the corresponding language toolchains.

A B1 verifier invokes one private checker as follows, with absolute paths for the checker and candidate:

```sh
node <task>/check.mjs --candidate <candidate-tree> --seed 17 --scope all
```

`--scope` accepts a package id, `e2e` or `all`. Success requires exit code 0 **and** a `plur1bus.team-check/1` report with
`passed: true`. Reports contain case ids and counts, never expected/actual candidate text. Initialization or compilation
errors produce exit code 1 and `passed: false`. Candidate compilation failures are scoped `candidate-error` grades;
missing executables are reported as `toolchain-unavailable`. Empty case sets and undeclared seeds are refused before
candidate execution. A missing tool is a failure, never an empty successful report.

The fixture self-test executes only the authored starting/reference code. K2 remains responsible for running model
candidates inside the existing verifier sandbox, fresh worktrees, cleanup, call budgets, redaction and paired reports.
The private fixture directory must not be granted to a model's tools or copied to its working tree.

## Arm definitions and remaining integration

Arms are extensible data definitions `{ family, params }`, with separate roles and capability requirements. The initial
controls are `{ family: 'single', params: {} }`, `single` with `{ effort: 'highest' }`, `single` with `{ review: true }`,
and `{ family: 'explore+single', params: {} }`. These are planning data, not executable bindings.

`canonicalArmId` derives the ID from the family and parameters only. Object keys are sorted recursively in UTF-16 code-unit order; exact JSON
strings and array order are preserved, while numeric `-0` serializes as `0`. Unsupported data, cycles and non-finite
numbers are refused. Serialization is bounded to depth 32 (the parameter object is depth 0) and 4096 visited values. The empty `single`
control keeps B1's baseline ID `single`; other IDs use the family with `+` replaced by `-`, a hyphen and the first 32
hex digits of SHA-256 over the UTF-8 canonical JSON `{ "family": ..., "params": ... }` without whitespace. Family labels
use 1–31 lowercase ASCII letters/digits/`+`/`-`, starting with a letter, so IDs remain portable ASCII strings of at most 64 characters.
Test vectors pin the initial controls. Future families/parameter combinations get stable identities without extending
a closed ID enum; they still require an explicit runtime binding. Comparisons accept descriptors or canonical IDs,
and natural-budget maps use canonical IDs. All roles continue sharing the matched task cap. `team` (PT-4b) and `best-of-n` (PT-10) are extension
points only. Declaring an arm or satisfying a metadata capability does not execute it or grant any tool authority.

K2 owns the benchmark report schema and execution-environment allowlist. TM2 adopts those contracts from K2's PR
when available; the fixture self-test's private checker receipt is not a second live benchmark report. Both packages
extend `docs/ci.md`; whichever merges second merges `main` and resolves the documentation overlap, without rebasing.

The team loader requires an explicit directory `file:` URL, including from a bundled caller. K2's B1 runner must land before
the runtime adapter, live baseline, nightly job and the replacement of `fanout-eval.ts`
and `eval:m5`. The executable `explore+single` binding is the last TM2 commit, after #853 lands on main; first merge main,
never rebase. Capacity trials declare request concurrency 1/2/4 and writer-capacity multipliers 1/1.5/2. No throughput,
latency, peak-memory or overcommit-slowdown results have been measured by these fixture tests.
