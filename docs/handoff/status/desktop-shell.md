# Desktop shell status

## WP1 — Scaffold, workspace, hygiene, desktop CI

Status: LOCAL GREEN — draft PR and five-target CI pending.
Branch: `feat/desktop-shell-wp01-scaffold`.
Base: `origin/main` at `e515dde` (no previous WP).
PR: pending. Head: initial WP1 commit containing this record; CI SHA will be recorded after push.

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
- Pending: `ci.yml` and all five `desktop.yml` targets at the pushed SHA.
- Not run: interactive window launch; Windows/Linux local execution unavailable.
  No screenshot or cross-platform runtime claim. No real keychain/home/service tests.
- Not applicable: docs:check (no clap/schema/generated-doc inputs changed),
  WP3 a11y/layout, WP14 container e2e, real image pipeline (outside scope).
- Acceptance §8 row 13: desktop CI pending; real harness image remains out of scope.
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

1. Commit the reviewed local-green scaffold and open draft WP1 PR.
2. Record CI results and exact tested commit. Do not start WP2 before WP1 is green.
3. WP2: provisional harness contract and isolated mock; no real harness server.
