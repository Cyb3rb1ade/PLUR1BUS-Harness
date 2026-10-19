# Release phase 1 — CI repair evidence (2026-10-15)

Base: `origin/main` at `6e2beb9e0fd80abab26675a07958a4ef1ad6b5cb`.
Branch: `codex/release-p1-ci-green`. No release or M8 acceptance is claimed.

## Inventory and decisions

- The latest completed main CI run, [38756175942](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/actions/runs/38756175942), fails macOS unit at lint/tsc, Windows unit at toolchain detection, and Windows x64/arm64 Python at offline client tests. This was a single historical read, not a CI polling loop.
- #483 is merged. Its entry-point fix makes the Windows pnpm launcher bug visible. Execute the fixed `pnpm --version` command through `cmd.exe /d /s /c`; native cargo still executes directly. Canonicalize the entry-point paths too: macOS `/tmp` resolves to `/private/tmp` in `import.meta.url`.
- Run the toolchain regression suite in every unit leg, including a real installed-pnpm probe and the existing empty-PATH refusal.
- Preserve the complete strict compiler program. Incremental measured on macOS arm64 / Node 24.21: cold 2,719,219,712 bytes maximum RSS, warm 1,191,542,784. Non-incremental: 2,604,531,712. A cache miss still exceeds the runner's approximately 2 GiB V8 heap. Project references are not configured (the three package tsconfigs only extend the root config); introducing composite declaration output and explicit dependency boundaries would be a separate build-system migration. Allocate 4096 MiB V8 old space only to the lint step; no timeout, compiler setting, or input is relaxed.
- Python: move the POSIX `resource` import into its existing POSIX-only test; all portable audit regressions can now load on Windows. Offline conformance fixtures provide both the expected PID and a matching recording-stream peer PID. Production authentication remains fail closed.
- Current CoreML fake-helper tests already inject `{ os: 'darwin', arch: 'arm64' }`. Production availability rejects unsupported platforms with `backend_unavailable` / `coreml_unavailable_platform`; native-helper tests retain their existing explicit hardware prerequisites. Do not replace fake protocol coverage with skips or make CoreML appear available in production on Windows.

## Gates and evidence limits

No job was promoted to gating: three consecutive successful runs of each repaired job are not yet available. Unit macOS/Windows and Python Windows x64 already lack `continue-on-error` on this base; Python Windows ARM remains informational. Repository branch-protection settings were not changed. A green local run is not evidence of Windows execution or three green CI runs.

Desktop #504 remains open; its jobs are untouched. Web a11y (#497), sandbox expectations, engine code and unrelated channel/provider implementations are untouched.

## Validation

Local environment: macOS arm64, verified Node 24.21.0 tarball, pnpm frozen lockfile installation. Logs live outside the repository under `/tmp/release-p1-*.log`. Completed: full strict typecheck; `NODE_OPTIONS=--max-old-space-size=4096 pnpm lint` (99 lint regression tests); 5 toolchain regression tests; Python client offline (140 tests, 17 existing platform/dependency skips); media (435 tests, 431 pass, 2 existing native-helper skips, 2 existing known-gap todos); actionlint; diff whitespace check. Hermes on the host default Python 3.14 exposes `test_audit_d11.DeepJsonTest`/journal deep-JSON serialization failure outside this phase; rerun with CI Python 3.13 is recorded separately. Full workspace TS tests and the release binary build were started with output logs. existing skips/todos remain visible and are not newly introduced by this change.

## Owner questions / KNOWN-GAP todos

- Record three successful native runs per repaired job before a separate, reasoned gating commit; no automatic rerun/poll loop is configured.
- Audit threshold for phase 3: proposed `high`, awaiting owner decision.
- May required sandbox tools such as bwrap be installed on runners? No sandbox test is weakened here.
- Phase 2 must establish native Linux arm64 and Windows arm64 smoke coverage; phase 1's unit matrix currently covers Linux x64, macOS arm64, Windows x64 only. Runner availability is not established by local tests.
- Real Windows execution (including six mandatory named-pipe tests), Rust unit/clippy/docs gates and remaining downstream failures must be read from the PR's run. Do not infer them from these repairs.
- Conflict hotspots: the unit lint/toolchain steps in `ci.yml`, toolchain entry-point guard, Python conformance fixtures. Keep D1's desktop workflow independent.

## First own PR results (single read, 2026-10-15)

Run 38761885193: Python Linux 3.11/3.13 and macOS 3.13 passed. Windows client offline and mandatory named-pipe gate now passed; the next provider-offline step exposed three native-path test assumptions on x64 and ARM. Fix only the tests: a Windows PATH fixture uses `.exe`; explicit-home resolution expects the native absolute path; native filesystem agent classification uses the actual platform/default-root convention. Shared synthetic POSIX/Windows vectors remain intact. Unit jobs were still running at that read; no success or three-run evidence inferred.

Audit decision follow-up (2026-10-15): the owner selected production High/Critical blocking, development/lower severities warning, and an owner-only advisory allowlist with at most 90 days expiry. Implemented in phase 3; see [dependency policy](dependency-policy.md). The earlier threshold question above is resolved.
