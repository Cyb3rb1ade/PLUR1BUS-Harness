# Desktop shell status

## WP1 — Scaffold, workspace, hygiene, desktop CI

Status: DESKTOP GREEN — draft PR open; root system/service CI still pending.
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
- Pending: root system/service jobs in
  [ci](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/actions/runs/36804333621).
  WP2 remains gated on a completely green root workflow.
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

1. Finish CI on the open draft PR and record the result.
2. Record CI results and exact tested commit. Do not start WP2 before WP1 is green.
3. WP2: provisional harness contract and isolated mock; no real harness server.
