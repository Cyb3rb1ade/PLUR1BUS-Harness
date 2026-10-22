# Desktop and HM4 workflow follow-ups

Base: `main` at `68f43bc646a90bc2cf5b7e19132b8dd8b794985a`.
Branch: `codex/workflow-followups`.

The desktop workflow now triggers for exact changes to
`packages/core/src/tools/web/ip.ts` and
`packages/core/test/fixtures/net/ip-classification-vectors.json` on both pull requests and pushes.
The vector fixture and desktop parity consumer are pending in PR #736; this change prepares
the triggers without importing that implementation. The scheduled advisory canary installs
`libgtk-4-dev` alongside its existing native packages.

Every step in `hermes-host.yml`'s `hm4-contract` job has an explicit timeout: actions and
scoped-client/Python tests get 5 minutes, frozen installation and prep get 10 each, the first
Rust profile/dry-run test gets 20, and rollback/inode coverage gets 10. These are upper bounds,
not benchmarks or observed hosted-runner durations. The existing 60-minute job ceiling remains.
All existing commands, action pins and toolchain versions are retained.

All Windows-applicable steps after `desktop-rust-tests` explicitly use `always()`, including
fixture and diagnostic tests, packaging tests, native probes, debug/release builds, the
release-seam check and unsigned bundle upload. Failed Cargo tests still fail the job; no error
suppression or `continue-on-error` was introduced. The libtest loader still requires actual
Cargo failure. Linux/macOS eligibility, macOS native-diagnostics failure exceptions, existing
step timeouts and existing unconditional artifact uploads are preserved. Builds after a red
Windows test provide diagnostic unsigned artifacts, not a successful acceptance result.

## Local verification

- Node `v24.21.0`; no dependency installation was needed.
- Four new static regression tests failed on the original workflows for the four requested
  changes and pass after the edits. They inspect actual trigger/job/step blocks and evaluate
  all 23 desktop post-Cargo conditions across Windows/Linux/macOS, success/failure/cancellation,
  Cargo success/failure/skipped and native-diagnostics success/failure/skipped. They also protect
  platform timeouts and the job's failure behavior.
- `node --test scripts/release/test/*.test.mjs scripts/ci/cache-policy.test.mjs`:
  45 tests, 44 passed, 0 failed, 1 pre-existing audit-policy TODO.
- `actionlint -shellcheck= -config-file scripts/release/actionlint.yaml .github/workflows/*.yml`:
  passed with the workflow-pinned actionlint `v1.7.7` (also passed with local `1.7.12`).
- `node scripts/lint-hygiene.mjs`, `node scripts/check-doc-links.mjs` and `git diff --check`: passed.

The tests establish static step eligibility and workflow syntax only. Native desktop suites,
Windows GUI execution, the canary's hosted GTK4 compile and HM4 hosted runtimes were not run;
those remain validation gates. No CI status was queried or polled. Engine pins, lockfiles,
existing action pins and runtime source are unchanged. No merge or deployment was performed.
