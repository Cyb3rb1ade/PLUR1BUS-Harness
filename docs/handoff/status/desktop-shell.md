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
READY FOR REVIEW since 2026-10-02; not merged.
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
- PASS at final report-only head `2998d35a7badeb69a28b33e7072adc6de053d20e`:
  [desktop CI](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/actions/runs/36949748139)
  (five platforms, Docker and Podman) and
  [root CI](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/actions/runs/36949748146)
  (all unit/system/service jobs). PR #60 was then marked ready; owner merges.

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
- [x] Report-only commit CI passed; PR #60 marked ready; owner merges.
- [x] Start WP3 after the complete WP2 gate.
- [ ] WP4–WP6 remain sequential, each after the preceding WP is green.

## WP3 — Shell UI frame

Status: GREEN — full root/desktop CI passed at `87915bb`, including the reviewed
Windows ARM64 test portability correction described below.
Branch: `feat/desktop-shell-wp03-ui-frame`.
Base: `feat/desktop-shell-wp02-mock-harness` at
`2998d35a7badeb69a28b33e7072adc6de053d20e`; PR #60 is ready but not merged.
PR: [#63](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/pull/63), draft,
base `feat/desktop-shell-wp02-mock-harness`. All WP3 and root-test review
findings are addressed. The PR remains a draft; no merge was performed.
Implementation head: `f6f3e7e7ebb59981c962e56eac0289a42c8bf224`
(initial frame `c392a63`, review fixes `f6f3e7e`).
Verified local head: `861a5ee8cf8f9510d5b6b6c2cc860790152bd124`, including
scale coverage `648a09f`, workflow correction `a634c9a` and the root-test fix.
Final root gen/build/lint/test PASS: 584 passed, five existing skips; 11 hygiene
tests pass. Log: `/tmp/desktop-wp03-root-snapshot-gate.log`. Desktop Rust remains
55 passed with locked fmt/Clippy/build; UI is 19/19. No desktop test is skipped.
Verified PR head: `87915bb45e75c0b7e7f00fe035b0a25ee22840fa`.
Internal agent scratch reports were removed from the tracked tree in `2d6a75c`;
their local copies are retained.

### Scope and decisions

- Frameworkless frame, reusable accessible components, Glow token source,
  bundled OFL fonts, de/en, OS defaults and persisted appearance/language.
- Minimal typed `settings_get`/`settings_set` and platform information are
  necessary for WP3 persistence; later command surfaces remain later WPs.
- G-12: the canvas could not be retrieved. The owner's explicit fallback is
  spec §13.1 and §13.6–§13.8. Artwork follows those values; no pixel match to
  unobserved canvas exports is claimed.
- C1/C2/C3/C4/C22: Glow-only tokens, system theme with dark fallback, 12 px
  text floor, isolated wordmark morph and 44 px targets at every shell width.
- Existing app icon assets follow red `1` below 48 px, `P1B` at 48 px up.
  Stateful tray icons and remaining installer/MSIX assets belong to WP6/WP13.

### Local verification history

- PASS: frozen pnpm install and toolchain check after adding the pinned UI test
  dependencies (`playwright` 1.63.0, `axe-core` 4.13.0, Tauri JS API 2.10.1).
  Browser binaries are installed under `/tmp/plur1bus-wp03-playwright`, with
  a matching temporary location in CI. No personal browser profile is used.
- Browser target caveat: Playwright 1.63.0 maps Windows hosts to its `win64`
  Chromium headless-shell build. Windows 11 ARM will exercise the UI through
  x64 emulation; the Tauri application remains a separate ARM64 build. Runner
  success is now observed in the five-target desktop run linked below.
- PASS: root `pnpm gen`, `pnpm build`, `pnpm lint`, `pnpm test`: 576 passed,
  five existing platform/filesystem skips; no desktop skips. Hygiene tests:
  11 passed. Log: `/tmp/desktop-wp03-root-node.log`.
- PASS: unchanged root Rust fmt/Clippy/test. Log:
  `/tmp/desktop-wp03-root-rust.log`.
- PASS: 11 UI tests using an isolated Chromium browser and the production CSP:
  both locales/themes with axe WCAG 2.1 AA, keyboard and save-failure focus,
  responsive boundaries, 44 px targets, four platform dialog orders, and every
  PNG/ICO/ICNS icon frame. Included in the root test result above.
- PASS: final implementation UI suite 13/13, adding system-theme/reduced-motion
  coverage and the related-panel sheet at narrow widths. Desktop locked
  Clippy/fmt and 55 Rust tests pass; locked Tauri debug compile and `.app` bundle
  pass. Later review fixes and the final root result are recorded below.
- Final root attempt 1: frozen install/toolchain/gen/build/lint passed, but the
  pre-existing importer concurrent-writer SQLite test spun at approximately
  99% CPU and stopped producing output. The controller terminated only that
  test process after 44 seconds; the root test command failed. This matches
  the previously observed WP1/WP2 importer instability. No importer source
  was changed. Retry 1 finished with the same test failing at its `SELECT`
  (line 96): `ERR_SQLITE_ERROR`, `database disk image is malformed`. The
  earlier root pass remains recorded; this attempt did not satisfy the push
  gate. Later review fixes and the final passing run are recorded below. Logs:
  `/tmp/desktop-wp03-root-final.log` and
  `/tmp/desktop-wp03-root-test-retry.log`.
- PASS: controller visual inspection of synthetic compact/normal/wide captures,
  Advanced preferences, compact navigation, sheet, dialog and keyboard focus;
  separate inspection of the 32 px and 256 px app icons. No canvas pixel-match
  or screen-reader pass is claimed.
- PASS: fresh locked, ad-hoc-signed debug `.app` on macOS arm64, built after
  the last production source edit. At `tauri://localhost`, bundled fonts and
  Glow styles rendered; native IPC saved Light/English into scratch settings
  with POSIX mode 0600. Both choices survived a scratch-profile relaunch.
  Keyboard traversal reached the dialog opener; Enter opened it, Tab wrapped
  within its buttons and Escape returned focus to the opener. Launch/relaunch
  logs were empty, and Command-Q exited with no remaining desktop process.
  After the final sheet addition, another fresh bundle was launched with the
  same scratch profile: preferences remained restored and the related sheet
  opened/closed correctly. Its launch log was also empty.
- Manual-test deviation: the UI tool's state read after the first Command-Q
  automatically relaunched the app without the scratch environment. It was
  immediately closed, with no preference changes or other actions performed.
  The persistence verification then used a new explicit scratch launch. Future
  quit checks use process inspection, never a post-quit UI state request.
- Not run: actual VoiceOver/NVDA/Orca operation or Windows/Linux interactive
  startup. Native accessibility-tree inspection is not a screen-reader pass.
- Representative synthetic screenshots are under `docs/handoff/status/img/`
  with prefix `wp03-`; they contain no real connections or personal data.

### Delivered interfaces and WP3 acceptance

- `apps/desktop/ui/src/{main,ipc,i18n,router,shell}.ts`: frame routes,
  catalogues, native transport boundary and persisted preference controls.
- `apps/desktop/ui/src/theme/`: one Glow token source, base layout and four
  platform variants. `ui/assets/fonts/` bundles the three licensed font families.
- `apps/desktop/ui/src/components/`: reusable button, segmented control, switch,
  sidebar/rail, sheet, dialog, progress, chip, banner and isolated wordmark.
- `apps/desktop/src-tauri/src/{commands,settings}.rs`: three guarded shell
  commands, closed settings types and atomic native persistence. No harness
  token, network request or arbitrary filesystem command enters the UI.

| WP3 Accept | Result and observed target |
|---|---|
| en/de identical keys, no empty strings | PASS — Node 24.21, macOS arm64 |
| Content-width breakpoints below 1024 and above 1600 | PASS — Chromium, all four platform variants, including exact boundaries |
| 400 CSS px without horizontal scroll | PASS — Chromium compact views |
| Text at least 12 px and targets at least 44 px | PASS — computed browser layout at tested widths and variants |
| Dialog width min(680, window minus 48) | PASS — Chromium platform/width matrix |
| axe WCAG 2.1 AA in both themes/locales | PASS at f6f3e7e — separate unobscured Advanced and dialog checks, all four theme/locale pairs |
| Full keyboard traversal | PASS — browser tests; native macOS page/dialog path also observed |
| Visible focus | PASS — browser assertions and inspected focus screenshot |
| Text contrast at least 4.5:1 | PASS at f6f3e7e — unobscured page and dialog axe checks |

The UI acceptance rows also passed on all five desktop CI targets at `39529e7`;
independent reviews passed. Acceptance §8 row 14
is shell-side automated/keyboard coverage; actual screen-reader operation is
still unperformed and must not be inferred from the accessibility tree.

### Remote verification

- PASS at `39529e7d2ec283aa74313ffd67f9ed6f17159986`:
  [desktop PR run](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/actions/runs/36956888806).
  `macos-15`, `windows-2025`, `windows-11-arm`, `ubuntu-24.04` and
  `ubuntu-24.04-arm` each passed UI tests, desktop fmt/Clippy/Rust tests,
  locked debug compilation and unsigned packaging. All five expected preview
  artifacts were observed, with seven-day retention. Docker and Podman stub
  smoke jobs also passed.
- PASS: root [CI run](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/actions/runs/36956888812):
  all three unit jobs, both system jobs (including the 200-turn soak), and
  all three service jobs passed at the same head.
- The separate [desktop push run](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/actions/runs/36956885042)
  also passed all five desktop jobs and Docker/Podman smoke at the same head.
  No subsequent WP has started. No rerun was required for these three runs.

### Independent review round 1

Review at `c392a63` required fixes: red-1 pivot wordmark; independent platform
loading when settings are unreadable; serialized preference changes to prevent
lost updates; axe checks on the unobscured page as well as modal; actual text
enlargement coverage; move hero gradient colors into the token source. The
implementation worker addressed these with regression tests below. Existing
passing tests do not supersede these findings.

Fix commit `f6f3e7e` addresses these findings with an 18-test UI suite: red
pivot with immediate page routing and delayed word opening; independently
settled native reads; serialized field patches with failure rollback; separate
axe runs on Advanced and its dialog; shared gradient tokens. Text enlargement
keeps the viewport at 1440 px and doubles each element's original computed
font size through the test fixture. This is text-only layout simulation, not
an observed OS text-scaling or browser-zoom operation. Typecheck and a fresh
locked debug `.app` build pass. The controller observed the corrected Home
wordmark/Harness subtitle in the scratch app and a clean exit. Scoped re-review
completed for the code fixes with no new Critical/Important breakage. It keeps
actual browser/system zoom on all shell pages open at that point; the test-only
follow-up below closes it. The full root gen/build/lint/test at `f6f3e7e` then passed: 583
tests passed, five existing platform/filesystem skips, plus 11 hygiene tests.
Log: `/tmp/desktop-wp03-review-fixed-root.log`. The earlier SQLite failures
remain recorded; a later pass does not claim to fix that existing instability.

First remote attempt at `9f3c2d8` failed before jobs started: the controller
placed `runner.temp` in job-level `env`, where GitHub rejected that context.
Both [desktop](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/actions/runs/36955834795)
and [root](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/actions/runs/36955835644)
reported invalid workflows, with no tests executed. The correction writes the
browser path from `$RUNNER_TEMP` into `$GITHUB_ENV` in a preparation step.
Official actionlint 1.7.12 validates the two changed workflows; its temporary
binary was checked against the release checksum. No repository dependency added.

Test-only follow-up `648a09f` adds actual Chromium engine display scaling:
`viewport: null`, 1x gives 1440 CSS px/DPR 1, 2x gives 720 CSS px/DPR 2, and
both screenshots are 1440x900 device pixels. Home, Connections, Runtime, Updates,
Version and Advanced retain 44 px targets and avoid horizontal overflow.
The 19-test UI suite and typecheck pass; scoped independent review accepts the
remaining finding with no new Critical/Important breakage. This is not an
observed native OS text-size setting or browser UI zoom command.

The final root run after this test-only addition hung again in the unchanged
concurrent-writer SQLite test (100% CPU, terminated after 70 seconds), so the
next push was held. Log: `/tmp/desktop-wp03-final-scale-root.log`. A focused
read-only investigation checked the test's live-writer/immutable-read
assumption; no root production changes were made.

Root-gate diagnosis: the test queries the live source through the default
`immutable=1` fallback while its child writes/checkpoints. SQLite's immutable
contract explicitly assumes the file will not change and otherwise permits
incorrect results or `SQLITE_CORRUPT` ([upstream](https://www.sqlite.org/uri.html)).
A minimal test-only correction is committed as `861a5ee`: request the existing exact-read
policy (`onBusy: "throw"`), accept only its documented `E_SOURCE_BUSY` from
opening, query every successful checked copy, and require a successful query
after the writer stops. The source-directory assertion and stable immutable
tests stay intact. This is a root-verification dependency of WP3, not a harness
feature or production implementation change.
The focused test passes 10/10 and root typecheck passes. A writer-ready
handshake, watchdog and failure cleanup keep the child lifecycle explicit.
Independent review approved the test-only correction with no blocking finding.
Full root gen/build/lint/test then passed at `861a5ee` (counts above).

Open follow-up for the owner: the documented detect-time immutable fallback can
encounter this same live-checkpoint risk in production. The test correction
does not resolve it. Choosing fail-closed or snapshot semantics would change
the importer contract and remains outside this desktop work package.

The report-only head `2d6a75c` exposed a second platform-specific test issue in
[desktop CI](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/actions/runs/36958260818).
Windows ARM64 `frames_over_64k_close` received a rejected connection as Winsock
10053 (`ConnectionAborted`), which its assertion did not yet accept. The server
still enforces both 64 KiB limits. Commit `428ced1` adds a Windows-only guard
requiring both that error kind and raw code 10053; unrelated I/O errors, EOF,
timeouts and other frames still fail. Independent review approved the change.
The focused test and full root/desktop local gates pass again (same counts
above); logs: `/tmp/desktop-wp03-winarm-{root-node,root-rust,desktop-rust}.log`.
Post-fix Windows behavior passed in both CI runs, including native ARM64
packaging. Review minor retained:
the test panic text still says "reset" without naming the Windows abort.
The earlier green run remains historical evidence, not a pass for this head.
The corrected current head `87915bb` passed all gates:
[root](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/actions/runs/36959664252),
[desktop PR](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/actions/runs/36959664176),
[desktop push](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/actions/runs/36959661573).
All five desktop targets, Docker/Podman smoke, all root unit/system/service
jobs and both 200-turn system soaks passed without reruns of these runs.
`gh pr checks 63` confirmed every check passed before WP4 began.

### Next

- [x] Implement frame, native preferences and isolated IPC.
- [x] Bundle fonts and update existing app icon assets.
- [x] Real browser layout/keyboard/axe tests; browser prerequisites in CI.
- [x] Local gates, native visual check, independent review and draft PR.
- [x] Full root/desktop CI at `39529e7`.
- [x] Correct the report-only follow-up's Windows portability failure and
  verify complete CI at `87915bb`.
- [x] Start WP4 on its own stacked branch only after that complete gate.
- [ ] WP5–WP6 remain unstarted and follow WP4 sequentially.

## WP4 — Connections, keychain and pairing

Status: IN PROGRESS — implementation not yet verified.
Branch: `feat/desktop-shell-wp04-connections`.
Base: `feat/desktop-shell-wp03-ui-frame` at
`87915bb45e75c0b7e7f00fe035b0a25ee22840fa`; PR #63 is green, draft and unmerged.
PR: not yet opened; no WP4 push before root and desktop Green.
`origin/main` was fetched before branching and remains `d33961b`.

### Scope and pending acceptance

- Connection store, shared Rust/TypeScript origin table, UUIDv7, closed schema,
  atomic owner-only writes and corruption preservation.
- Zeroized/redacted tokens, native keychain adapter and memory-only fallback,
  lazy access at pairing, injectable stores; real-keychain round trip not run
  because the owner requires tests to use seams.
- Native discovery and known-path fixed-argv pairing, code-flow fallback,
  meta compatibility/installation checks before every authenticated request,
  redirect refusal and revocation cleanup.
- Generated-certificate mock and client tests for self-signed proof/pinning,
  company CA delivered by pairing, origin-scoped trust, renewal and rollover.
- Connections/Add remote/repair/revoked/trust states in both locales and themes,
  reachable UI actions, 44 px targets, keyboard and accessibility tests.
- Independent review, full local/CI gates, manual scratch-profile checks,
  acceptance-by-acceptance results and draft PR remain pending.

### Scope resolutions

Task 8's `device-<uuid>` account helper derives the account from the connection
id; new ids use UUIDv7 as the spec requires. Keychain probing is lazy, to honor
just-in-time access. Tests inject memory/probe implementations and never use
the real keychain. Bundled controller pairing remains WP8; opening the actual
SPA remains WP5. WP4 may validate/select a connection without claiming a SPA
window has opened. Provisional proof/CA/rollover details will be recorded in
the shared mock contract before implementation is accepted.
