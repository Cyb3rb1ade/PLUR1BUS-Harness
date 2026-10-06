# Windows CI really runs the TypeScript tests

**Goal.** Since a288fd7e (Oct 2) the Windows `unit` leg ran zero TypeScript tests: the root `test` script used
`--filter '!@plur1bus/desktop-ui'`; cmd.exe keeps the single quotes literal, pnpm printed "No projects matched" and
exited 0. Make the root scripts shell-neutral, make a vacuous run fail, then fix what is red on Windows.

**Files.** `package.json` (root `test`, `lint`), `scripts/run-ts-tests.mjs` (+ `.test.mjs`), `.github/workflows/ci.yml`
(guard evidence only), then whatever Windows turns up in `packages/*/test` and `packages/*/src`.

## Tasks
1. `scripts/run-ts-tests.mjs`: spawns `pnpm -r --filter=!<pkg> test` with an argv array (no shell quoting), tees the
   output, sums node's `tests N` summaries and fails on "No projects matched" or a total of 0.
2. Root `test` -> `node scripts/run-ts-tests.mjs`; unit-test the guard in `lint`.
3. Prove the guard: one commit with a deliberately broken filter (CI run must fail), reverted in the next.
4. Run Windows CI; for every red TS test: product bug -> product fix; genuinely POSIX-only -> explicit skip with a reason.
   Record each as test -> cause -> fix/skip in the PR.

## Acceptance -> test
| Acceptance | Test |
|---|---|
| Root scripts are shell-neutral | `scripts/run-ts-tests.test.mjs` (no quote in any argv element) |
| Guard fails on 0 tests / "No projects matched" | `scripts/run-ts-tests.test.mjs`; broken-filter CI run |
| Windows count == Linux count minus documented skips | `run-ts-tests: N tests in total` line in each OS's log |

## Rulings
- Guard counts node-test summary lines rather than a pnpm reporter, so it works for every package's `test-package.mjs`.
- `@plur1bus/desktop-ui` stays excluded (browser tests run in desktop.yml).
