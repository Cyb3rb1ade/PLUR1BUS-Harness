# Desktop shell status

## WP1 — Scaffold, workspace, hygiene, desktop CI

Status: MERGED — PR #59 is now in main; root and desktop CI passed at the WP1 head.
Branch: `feat/desktop-shell-wp01-scaffold`.
Base: `origin/main` at `e515dde` (no previous WP).
PR: [#59](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/pull/59).
Implementation head: `7dd54fed81f2ef1f1857b9f05fe2c921d6ef82e3`.
This follow-up commit records verification only.

### Done and interfaces

- Separate `apps/desktop/Cargo.toml` workspace and lockfile; root excludes `apps`.
- Tauri 2.12.0 / tauri-build 2.7.0 (matching published release); CLI 2.12.0.
- `src-tauri/src/ids.rs`: bundle/keychain/product/container/label/scheme constants.
- One hidden-until-loaded shell window, 800 × 600 minimum, exact CSP, frozen
  prototype, global Tauri off, empty native command capability.
- Static UI build; explicit placeholder SVG and platform icons.
- Source hygiene includes apps; tracked index blobs are scanned for forbidden
  filenames and private key headers without logging contents.
- Five-target CI, exact Action SHAs, unsigned online artifacts retained seven days.
- Development instructions in `docs/desktop.md` and `AGENTS.md`.

### Verification (observed; macOS arm64 unless stated)

- PASS: frozen pnpm install; toolchain check; `pnpm gen`, `pnpm build`, `pnpm lint`.
- PASS: `pnpm test`: 566 passed, 5 skipped (571 total across workspaces).
  Existing skips: three source-filesystem/name/case constraints on this volume;
  two Windows-only icacls tests on macOS. No desktop test skipped.
- PASS: root fmt/Clippy; root Cargo tests: 1006 passed, 1 ignored (the existing
  long-running nightly extension fuzz test; its output explains the opt-in).
- PASS: desktop fmt/locked Clippy/locked Rust tests (8); static UI build/test (1).
- PASS: hygiene self-test (11), including planted tracked p12/OCI files and private
  headers; staged blob scan; `git diff --check`.
- PASS: root Cargo metadata contains only plur1bus, plur1bus-config,
  plur1bus-ext and plur1bus-rpc, with no desktop crate.
- PASS: Tauri debug compile and ad-hoc macOS DMG build; repeated with forwarded
  `-- --locked`. DMG is approximately 2.69 MiB; no notarization was attempted.
- PASS: fresh independent WP1 review found no critical/important bug. Its request
  for explicit locked Tauri builds was incorporated and exercised locally.
- PASS: `desktop.yml` on macos-15, windows-2025, windows-11-arm,
  ubuntu-24.04 and ubuntu-24.04-arm at implementation head `7dd54fe`:
  [PR run](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/actions/runs/36804333554)
  and [push run](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/actions/runs/36804288008).
  All five targets produced unsigned preview packages.
- PASS: root unit jobs on macOS/Linux/Windows at `7dd54fe`.
- PASS: root system/service jobs in
  [ci](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/actions/runs/36804333621).
  The full WP1 root workflow is green.
- PASS: follow-up docs head `1cc0df6`: all five desktop targets in
  [desktop](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/actions/runs/36805238055),
  and all root jobs in
  [ci attempt 2](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/actions/runs/36805238108).
  Attempt 1 timed out in the existing importer concurrent-writer SQLite test;
  attempt 2 passed with no root code change.
- PASS: manual packaged-app startup on macOS arm64 with HOME,
  CFFIXED_USER_HOME, XDG config/cache/data and TMPDIR redirected to scratch.
  Native accessibility inspection showed the PLUR1BUS window and HTML container
  at `tauri://localhost`; screenshot showed the expected blank WP1 shell at
  1100 × 800 logical pixels. Empty launch log; Command-Q exited cleanly.
  Screenshot is in the Codex run transcript; no personal data shown.
- Not run: Windows/Linux interactive execution (not available locally).
  No real keychain/service tests or personal home used for the desktop smoke.
- Not applicable: docs:check (no clap/schema/generated-doc inputs changed),
  WP3 a11y/layout, WP14 container e2e, real image pipeline (outside scope).
- Acceptance §8 row 13: desktop matrix PASS (full build/package level); real harness
  image remains out of scope. Interactive startup checked on macOS only.
- Local logs: `/tmp/desktop-wp01-{root,lint,tests,root-rust,rust,clippy,locked-build,locked-bundle,staged-lint}.log`.

### Deviations, defaults and open questions

- Handoff WP branches/draft PRs override older D1 single branch, no-push and
  Claude attribution instructions. No M3 or real image implementation.
- Handoff G-11 puts the Cargo workspace/lockfile at `apps/desktop`, superseding
  the older plan's `src-tauri` workspace. Root pnpm lockfile updated for new importers.
- Node 24.21.0 is provisioned locally through pnpm's package cache; the Linux
  `/home/claude/.node24` path is unavailable on this Mac.
- Engine fetch used a process-scoped HTTPS rewrite after SSH host verification
  failed. No Git config file changed and the engine commit pin is unchanged.
- Icons are synthetic placeholders, permitted by WP1; approved DskIcons exports
  are still required before release.
- Updater artifacts disabled until WP10 introduces placeholder/release key
  validation. Empty image resource glob omitted until resources exist. Otherwise
  unsigned WP1 bundles would require keys or absent files.
- Secret lint exempts only the existing plan's backtick-quoted minisign header
  literal. A regression test rejects an actual header in that same document.
- No application API dependency is installed before a UI consumer needs it.
- UI/a11y/layout frame belongs to WP3; no a11y claim for the WP1 blank window.

### Next

1. WP2: provisional harness contract and isolated mock; no real harness server.

## WP2 — Provisional mock harness, fake binaries and stub image

Status: GREEN — implementation, independent review and full CI passed at `ad6f0f7`.
Branch: `feat/desktop-shell-wp02-mock-harness`.
PR: [#60](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/pull/60), base `main`.
Ready-for-review transition follows the report-only commit's CI; no merge authorized.
Original verified head: `5c5038281c6597d18f38d9d78cb0c2a0554f7666`.
Part A implementation head: `8131a85f2a3df916a2cdd839b5da0401f3ae60e9`
(initial fixes `7517ccc`, independent-review fixes `8131a85`).
Verified PR head: `ad6f0f735ef5a77e5ad96d044620bf32a4683627`.
This final report-only commit records observed results and changes no implementation.
Main integration: `d33961b` merged as `90e0706025eb0b7a7621fd71f4755e61a2054d3b`
on 2026-10-02, explicitly authorized by the owner. No rebase or force push.

- `apps/desktop/mock-harness`: in-process `MockHarness::start` control, standalone
  loopback binary, provisional HTTP/SSE/WS session and host-bridge routes,
  hashed persistent device/session state, injected clock and upgrade failure.
- `apps/desktop/test-bins`: real Rust `fake-plur1bus` and `fake-container`
  processes with exact scenario matching, argv recording, fixture documents and
  explicit unknown-command errors. Pair/revoke share the mock's state.
- `apps/desktop/stub-image`: two pinned Docker Hub manifest-list digests,
  non-root read-only test image, opt-in Docker/Podman build and smoke scripts.
  Runtime smoke creates namespaced labeled objects and checks loopback/meta,
  fixture exec and stop time. The controller owns the matching CI workflow edit.
- `pnpm tauri dev` now starts/stops a temporary standalone mock. The empty WP1
  shell has no connection UI yet; WP4 supplies it. The SPA calls `shell_info`
  only when Tauri IPC is exposed; WP5 will add the native command and
  `spa-bridge` capability, so inside-app invocation remains untested in WP2.
- Part A adds `apps/desktop/desktop-contract` as the shared scope, capability,
  route and fixed-argv source for shell/mock/fake binaries. Corrected synthetic
  fixtures have Rust-source drift guards and a README. Discovery writes a
  scratch `run/api.json`; SSE filters live/replayed topics and carries optional
  reasons. Mock approvals enforce the requested scope and debug decision gate.
- Test-control routes require explicit opt-in; unknown scopes fail. Native
  fallback pairing has no bridge/key-unlock grant. Bridge calls require the
  accepted hello capability. Tickets contain 32 random bytes and persisted
  state is owner-only on POSIX. Root typechecking now includes desktop UI.

### Local verification

- PASS again after review fixes at `8131a85`: root lint/test and root Rust
  fmt/Clippy/test, with the same counts and existing skips described below.
  Logs: `/tmp/desktop-wp02-round2-root-node.log` and
  `/tmp/desktop-wp02-round2-root-rust.log`.
- PASS at final Part A implementation head: desktop fmt, locked Clippy with
  warnings denied, mock build, all 50 Rust tests (no skips), UI build/test (1),
  TypeScript typecheck. Logs: `/tmp/desktop-wp02-round2-rust.log` and
  `/tmp/desktop-wp02-round2-ui.log`. Initial Part A gate had 44 tests in
  `/tmp/desktop-wp02-fixes-desktop-rust.log`.
- PASS after main integration and the Part A TypeScript fix (macOS arm64):
  frozen install, toolchain check, gen/build, root lint including desktop UI,
  566 package tests plus the UI test and 11 hygiene tests. Five existing
  platform/filesystem skips remain; no new skip. Root Rust fmt/Clippy and
  tests passed (1006 passed, one existing opt-in nightly fuzz test ignored).
  Logs: `/tmp/desktop-wp02-fixes-root-node.log`,
  `/tmp/desktop-wp02-fixes-root-node-retry.log`,
  `/tmp/desktop-wp02-fixes-root-rust.log`. The first lint run exposed unsafe
  indexing in the existing UI build test; explicit narrowing fixed it and
  the subsequent lint/test run passed without weakening the compiler rules.
- PASS: focused red/green cycles for pairing, fake process scenarios, rate
  limit, event replay/restart, bridge grant and bridge call/result.
- PASS: desktop `cargo test --locked --workspace --no-fail-fast` (WP1 8,
  fake process 4, mock HTTP/WS 16); `cargo clippy --locked --workspace
  --all-targets -- -D warnings`; UI build/test (1); standalone mock meta and
  SIGTERM in 0.002 s; Node script syntax and no-opt-in skip.
- PASS: minimal Docker build-context Cargo metadata and verified builder/runtime
  manifest-list digests via the Docker Hub registry API on 2026-10-01.
- Local container build/run: unavailable; Docker's selected daemon socket is
  absent and Podman is not installed. Both runtimes passed at the original
  head in CI (links below); fresh CI must verify the Part A fixes before
  the WP2 gate closes.
- Root validation: controller observed frozen install, toolchain check, gen,
  build, lint, Rust fmt/Clippy/tests PASS. First `pnpm test` hit the unchanged
  core import concurrent-writer SQLite `database disk image malformed` test;
  the unchanged targeted retry passed all 10 and the unchanged full retry
  passed. No harness code was changed for it.
- PASS at original head `5c50382`: [root CI](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/actions/runs/36834472888)
  (unit, system and service jobs), [desktop PR CI](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/actions/runs/36834472957)
  (all five targets plus Docker and Podman stub smoke), and
  [desktop push CI](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/actions/runs/36834467447).
- Review correction: the original independent reviewer hit a usage limit.
  The controller's fallback was not an independent review and missed the
  fixture and contract gaps listed by the owner on 2026-10-02. Part A fixes
  those findings and will receive a fresh independent review before closure.
- Fresh independent full-WP2 review at `7517ccc`: no critical issue; two
  important findings accepted for correction. Standalone non-loopback binds
  must be limited to the explicit stub-container mode, and fake-plur1bus must
  classify allowed argv before applying scenario overrides. A minor obsolete
  inline daemon fixture was also identified. Commit `8131a85` fixes all three:
  only explicit stub mode permits `0.0.0.0`; control routes require a loopback
  peer and return 403 without peer metadata; fake-plur1bus validates argv before
  scenario lookup; the test uses the canonical fixture. The defects were
  reproduced by regression tests before correction. Independent scoped
  re-review at `8131a85` approved all three fixes, with no new critical or
  important issue and no out-of-scope observation.
- Fresh CI at report head `3c514b9`: all five desktop targets and Docker/Podman
  stub smoke PASS in
  [desktop CI](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/actions/runs/36947221960).
  All root unit, system and service jobs PASS in
  [root CI](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/actions/runs/36947225578).
- PASS at final verified head `ad6f0f7`: all five desktop build/package targets
  and both Linux runtime smoke jobs in
  [desktop PR CI](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/actions/runs/36948367257).
  All root unit, system and service jobs in
  [root CI](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/actions/runs/36948367260)
  passed. No rerun was needed for this head.

### Acceptance matrix (CI head `ad6f0f7`, implementation `8131a85`)

CI targets: `macos-15`, `windows-2025`, `windows-11-arm`, `ubuntu-24.04`,
`ubuntu-24.04-arm`. All Rust test steps passed in
[desktop CI](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/actions/runs/36948367257).

| Acceptance | Local macOS arm64 | CI targets |
|---|---|---|
| `mock_meta_is_unauthenticated` | PASS | PASS, all five targets |
| `redeem_is_single_use` | PASS | PASS, all five targets |
| `ticket_single_use_and_60s` | PASS | PASS, all five targets |
| `events_requires_events_read` | PASS | PASS, all five targets |
| `bridge_requires_bridge_serve` | PASS | PASS, all five targets |
| `frames_over_64k_close` | PASS | PASS, all five targets |
| `revoked_device_gets_401_device_revoked` | PASS | PASS, all five targets |
| Stub image build, restricted run, loopback meta, fixture exec, stop under 150 s | Not run: Docker daemon unavailable, Podman absent | PASS, Linux Docker and Podman |

### Defaults, deviations and remaining limits

- G-1/DR1: all harness API routes are provisional and mock-only; no M3 API
  server or real harness image was added.
- G-2: mock approval decisions require explicit debug opt-in. Production
  approval decisions remain a future M3/D109 contract decision.
- G-11: shared desktop contract, mock and fake binaries stay in the separate
  desktop Cargo workspace. No root crate dependency was added.
- Newly specified pair-proof, company CA and trust rollover mock scenarios
  will be added with WP4's explicit acceptance tests. They are not simulated
  by this WP2 fix set.
- WP5 owns the native `shell_info` command and hosted SPA window. The WP2 SPA
  conditionally invokes that future command; no in-app bridge demonstration
  is claimed here.
- No new owner question. WP3 uses the copied Glow specification under G-12
  because the canvas URL could not be retrieved in this environment.

### Next

- [x] Correct fixtures and add a drift guard and synthetic-data README.
- [x] Complete contract, constants, opt-in controls and mock hardening.
- [x] Include desktop TypeScript in root typechecking.
- [x] Fresh local root and desktop gates.
- [x] Independent review and scoped fix verification.
- [x] Full CI at final implementation/report head `ad6f0f7`; record results here.
- [ ] Await this report-only commit's CI, then mark PR #60 ready; owner merges.
- [ ] Start WP3, then WP4–WP6, only after the previous WP is green.
