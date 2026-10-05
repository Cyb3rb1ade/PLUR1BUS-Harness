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

Status: MERGED — owner merged PR #60 on2026-10-02 at06:54:47UTC, normal merge
`e6c98cfd2084c48ac97cf0d272529ca772e716b7` (final PR head2998d35).
Branch: `feat/desktop-shell-wp02-mock-harness`.
PR: [#60](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/pull/60), base `main`.
Earlier independent review/full CI passed at `ad6f0f7`; historical evidence follows.
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

Status: MERGED — owner merged #63 at2026-10-02T17:05:27Z with normal merge
`444691bedbbc0a049ab18a038528d62230e9afe9`. Corrected published head7aeebbf
passed complete root CI (one documented unchanged HM2 timing retry) and all five
desktop targets; independent correction/R1 reviews passed.
Branch: `feat/desktop-shell-wp03-ui-frame`.
Base: `main` (PR #60 merged with merge commit `e6c98cf`).
PR: [#63](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/pull/63), MERGED.
The owner merged #63, then #64, using merge commits. Every new WP3 commit is
merged forward into WP4 (and WP5 when it exists), without rebase or force-push.
Implementation head: `c6527a9` (owner corrections plus overlay focus R1 fix).
Initial independent review found R1; its four regression cases now pass and
the scoped re-review passed (R1 addressed, no new Critical/Important breakage).
Verified local implementation at a288fd7: root567/five skips; root Rust1036/one
ignored; desktop58/no skips; UI31/no skips; all required lint/fmt/Clippy/build and
docs gates PASS. R1 adds four regressions and passes the full35-test UI suite; final typecheck
passes. Native/root source remains unchanged by that UI-only fix.
Historical verified PR head: `a735d2b` (all CI passed before owner review).
Current published head: `7aeebbfdf3eddcda11ee6168541b72971daf0c97`.
Desktop [run37009940311](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/actions/runs/37009940311) PASS on five targets plus Docker/Podman.
Root [run37009940205](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/actions/runs/37009940205) PASS after one targeted retry of the unchanged HM2 macOS timing failure.
WP3 is GREEN at this head; #63 remains draft until corrected #64 also passes.

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

Historical pre-owner-review matrix (superseded by the correction matrix below):

| WP3 Accept | Result and observed target |
|---|---|
| en/de identical keys, no empty strings | PASS — Node 24.21, macOS arm64 |
| Content-width breakpoints below 1024 and above 1600 | PARTIAL — compact edge checked; wide panel boundary was not proved before owner review |
| 400 CSS px without horizontal scroll | PASS — Chromium compact views |
| Text at least 12 px and targets at least 44 px | PASS — computed browser layout at tested widths and variants |
| Dialog width min(680, window minus 48) | PASS — Chromium platform/width matrix |
| axe WCAG 2.1 AA in both themes/locales | PASS at f6f3e7e — separate unobscured Advanced and dialog checks, all four theme/locale pairs |
| Full keyboard traversal | PARTIAL — prior focus-trap checks did not prove ordered page traversal or route focus |
| Visible focus | PARTIAL — prior selector/screenshot did not prove computed outline and 3:1 contrast |
| Text contrast at least 4.5:1 | PARTIAL — prior axe sample omitted Home/Connections and ignored incomplete nodes |

The old tests passed on all five targets at `39529e7`; the owner review identified
the coverage gaps above. Acceptance §8 row 14
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

### Owner review correction scope, 2026-10-02

WP3: application-command ACL, focus preservation, complete keyboard/focus/contrast
and wide-boundary evidence, API2.12 pin, safe settings persistence and reporting.
The importer test is restored to main: desktop PRs must not alter core tests.
Root tests will exclude desktop-ui; the desktop workflow retains its browser
accessibility/layout gates. New main is merged normally; HM2 work is preserved.

Owner follow-up (core, separate scope): the live main/WAL ordinary-file copy is
not an atomic SQLite backup; synchronous native validation cannot be bounded by
a JavaScript watchdog, and immutable fallback on a changing original may be
unsafe. Investigate a supported SQLite backup/snapshot plus bounded validation
and fail-closed behavior in a separate core issue/PR. No production fix is claimed.

Draft [Unreleased] changelog lines for owner review:
- WP2: Add a provisional desktop harness contract, isolated mock/fake binaries
  and digest-pinned Docker/Podman stub smoke coverage.
- WP3: Add the responsive Glow desktop frame with local fonts, de/en preferences,
  platform chrome, application-command ACL and accessibility/layout gates.

WP4 fixes follow the corrected WP3 forward merge; WP5 and WP6 remain unstarted.
After both corrected heads pass full CI, mark #63/#64 ready for owner review.
The owner merges them with merge commits; do not merge into main.

### WP3 owner-correction acceptance matrix (a288fd7, local macOS arm64)

| Handoff Accept (verbatim) | Exact test/file | Observed result | Targets |
|---|---|---|---|
| i18n: en and de have identical key sets and no empty strings | `both catalogues cover the same nonempty messages`, ui/test/i18n.test.ts | PASS | Node24.21 on macOS arm64; portable desktop CI test |
| layout: breakpoints follow content width (compact < 1024, wide > 1600) | `frame follows content-width boundaries without clipping text`, layout.test.ts; `layout: wide edge at 1600/1601 switches panel and trigger on Settings and Connections`, acceptance.test.ts | PASS (1023/1024 and1600/1601) | local Chromium; desktop CI pending |
| layout: 400 CSS px has no horizontal scroll | `layout: all six pages retain 12 px text and 44 px targets at every acceptance width`, acceptance.test.ts | PASS all six pages at400 plus720/960/1440/2560 | local Chromium; desktop CI pending |
| layout: text ≥ 12 px, targets ≥ 44 px on shell pages | same exact acceptance.test.ts test; `Chromium 2x display scale keeps 1440 physical pixels while all shell pages fit 720 CSS pixels`, layout.test.ts | PASS; 1×/2× only | local Chromium; desktop CI pending |
| layout: dialogs are min(680, window − 48) | `dialog layout and DOM button order follow all four platforms`, layout.test.ts; `platform chrome: GNOME fills the 800 px footer row, Windows band and short dialog height`, acceptance.test.ts | PASS width680/352; height<=132 at180 viewport; ordering/radius all4 variants | local Chromium platform CSS simulation; native cross-OS pending |
| axe-core WCAG 2.1 AA clean on a sample view in both themes and both locales | `sample shell and dialog pass axe WCAG 2.1 AA in both themes and locales`, a11y.test.ts | PASS Home/Connections/Advanced/dialog × light/dark × en/de; reviewed incompletes above | local Chromium+axe4.13.0; desktop CI pending |
| full keyboard traversal | `full keyboard traversal: ordered accessible names, wrap and visible 3:1 focus on every page`, acceptance.test.ts; Enter/Space/native-late/theme tests in focus.test.ts; dialog/sheet trap and return in layout/a11y | PASS six pages ×3widths ×2themes; ordered Tab+document wrap, Enter/Space/ShiftTab/Escape | local Chromium; manual VoiceOver/NVDA/Orca not run |
| visible focus | same full keyboard traversal test, acceptance.test.ts | PASS computed outline-style !=none, width>=2, contrast>=3 for each traversed control | local Chromium; desktop CI pending |
| 4.5:1 contrast | `every semantic ink/background token pair meets 4.5:1 in both themes`, contrast.test.ts, plus expanded axe sample | PASS (Home eyebrow corrected to ink-3) | Node token math + local Chromium; logotype exemption above |


Local gates: root567 passed/five existing skips; lint including hygiene/HM2
self-tests, frozen install/toolchain/gen/build PASS; root Rust1036 passed/one
existing ignored; root fmt/clippy/docs:check PASS. Desktop58 passed/no skips;
UI31 passed/no skips; desktop fmt/lockedclippy and serial locked Tauri debug
app+DMG build PASS. Final frozen install/lint repeated after source freeze.
Logs: `/tmp/wp03-owner-root-{node,rust}.log`, `/tmp/wp03-owner-final-lint.log`,
`/tmp/wp03-ui-full-final.log`, `/tmp/wp03-native-full.log`,
`/tmp/wp03-tauri-build.log`. No native manual or cross-OS execution is inferred.

Deviations/limits after corrections:
- API pin deviation resolved: @tauri-apps/api exact2.12.0; engine lock entry
  byte-identical. sys-locale exact0.3.2 supplies actual OS locale.
- Authorized root scope correction: restore importer test exactly main; remove
  only Chromium setup from ci.yml after excluding desktop-ui from root tests.
  All HM2 content remains. Desktop CI retains browser/accessibility/layout tests.
- Narrow Windows Winsock10053 oversized-frame abort acceptance in WP2 http.rs
  remains a recorded portability deviation; stale panic text is fixed.
- C22 measured at1×/2× and separate200% text enlargement only; native
  WebKit/WebView2 and150%/250% remain unmeasured locally.
- Playwright1.63.0 pins browser revision, not a separately verified archive hash
  (M14). Real-engine no-preference dark fallback is unverified (M6).
- VoiceOver/NVDA/Orca were not run. Browser platform CSS simulation is distinct
  from executing on native macOS/Windows/Linux.
- Wordmark red1 uses WCAG logotype exception only. Axe incomplete Home gradient
  selectors have explicit narrow reasons and independent worst-case/composited
  token contrast proof; unreviewed incomplete targets fail.

Minors M1–M5/M7–M13/M15 fixed; M6/M14 documented limitations, accepted by the
review's alternatives. Settings retains future disk fields but IPC remains closed;
corrupt/read-failed files cannot be silently overwritten. Errors remain until
dismissed; stable focus and unique overlay headings are tested.

Current unfinished work: complete root CI retry at published WP3 head; finish
WP4 owner corrections, independent review, local gates and current-head CI;
then mark both ready for review and proceed to WP5/WP6 sequentially.

WP3 independent review at a288fd7: I1/I3/I4/I5 and safe Minors approved;
Important R1 remains: nonroute/theme renders detach dialog/sheet opener nodes,
so Escape does not restore focus. Reproduced in isolated Chromium. Original
implementer is correcting it with regressions for both overlays; no push yet.

WP3 R1 correction `c6527a9`: shared stable-key return-focus resolver for dialog
and sheet. Four regression cases (overlay type × theme/native late load) failed
before the fix, then focused10/10 and fullUI35/35 passed,0skip. Finaltypecheck
PASS. Logs `/tmp/wp03-r1-{red-focus,focus-final,ui-final,typecheck-final}.log`.
Initial post-fix assertions ran before asynchronous native dialog close delivery;
the final tests wait for overlay detachment and passed from the final source.
No native/Rust change; scoped review remains pending, no current CI claim.

WP3 correction review complete: initial task review approved I1/I3/I4/I5 and
safe Minors; R1 fix scoped re-review PASS. All owner-requested implementation
fixes now approved. Publish corrected head and observe its complete current CI;
#63 stays draft until corrected #64 is also green, then both become ready.

Current correction progress: WP3 reviewed source c6527a9 plus report7aeebbf published; desktop37009940311 ALL PASS. Normal forward merge into WP4 completed as e9a5aa3; Part B corrections are in progress. No WP4 push or WP5/WP6 start yet.

### Current WP3 CI inherited HM2 timing failure

At exact7aeebbf, root37009940205: all three unit jobs PASS, including the restored macOS importer test; Python host Linux3.11/3.13, Windowsx64/ARM PASS. Python-host macOS3.13 failed in unchanged hosts/hermes/tests/test_provider.py:707: test_shutdown_counts_what_it_cannot_journal took2.302102209s against2.3s. No desktop diff touches that test/provider. Focused unchanged local probe PASS on Python3.14.7 (different from CI3.13; not equivalent-target proof), log /tmp/wp03-owner-python-mac-focused.log. Exact CI log /tmp/wp03-owner-python-mac.log. Scheduling sensitivity is an inference, not a confirmed production diagnosis. No test threshold/source/workflow was weakened. Dependent system/service and desktop jobs continue. Record any targeted CI retry and result explicitly; WP3 is not GREEN while the gate fails.

One targeted retry was requested with `gh run rerun 37009940205 --job 110846994108` after attempt 1 completed. Attempt 2 replacement macOS Python job is `110853803314`; provider step now PASS, remaining build/live-conformance steps are still running. All other root jobs succeeded in attempt 1. Desktop run37009940311 completed SUCCESS on all five targets and Docker/Podman. Final workflow completion remains required.

### WP3 final corrected-head CI

GREEN at exact `7aeebbfdf3eddcda11ee6168541b72971daf0c97`: root37009940205 attempt2 SUCCESS, replacement macOS Python job110853803314 SUCCESS; all other root jobs SUCCESS. Desktop37009940311 SUCCESS on macOS, Windows x64/ARM64, Linux x64/ARM64 and Docker/Podman smoke. The first HM2 timing failure above is retained; no source/threshold/workflow changed for the retry. PR #63 remains draft until the corrected WP4 head also passes all gates. WP3 head was already normally merged into WP4 as e9a5aa3.

## WP4 — Connections, keychain and pairing

Status: MERGED — owner merged #64 at2026-10-02T17:05:55Z with normal merge
`5962e820046d0a881dc28fa779de03945e244590`. Corrected published head a1f0029
(source eb46737) passed root37015257791 and desktop37015257725/37015254463
on all five targets plusDocker/Podman. Independent correction/R1 reviews passed.
Branch: `feat/desktop-shell-wp04-connections`.
Original stacked base: `feat/desktop-shell-wp03-ui-frame` at `7aeebbf`;
retargeted to main when #63 merged.
PR: [#64](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/pull/64), MERGED.
Published historical head: `5713e7a9df1dae82b5b0f98e076e363681f69463`.
Main `6a7d656` is included through WP3. The forward merge preserves the nine
application-command permissions, Windows CRT isolation, focus/settings fixes,
and restoration of the core importer test exactly to main. Config10/10 PASS.
Current source head: `eb467376880cb679190c5b0edf97143fa2adfc3f`.
Part B commits: `c7ee115`, `7e835bb`, `eb46737`; report/published head `a1f0029f055efa77d4331ca815fc999644fc0277`, complete current-head CI PASS.

### Delivered scope and historical verification

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
- The following older checkpoints are retained as history. Current owner
  correction summary and its exact acceptance matrix override old head/counts
  and pending checklists; current CI is required for the new source.

### Scope resolutions

Task 8's `device-<uuid>` account helper derives the account from the connection
id; new ids use UUIDv7 as the spec requires. Keychain probing is lazy, to honor
just-in-time access. Tests inject memory/probe implementations and never use
the real keychain. Bundled controller pairing remains WP8; opening the actual
SPA remains WP5. WP4 may validate/select a connection without claiming a SPA
window has opened. Provisional proof/CA/rollover details will be recorded in
the shared mock contract before implementation is accepted.

Protocol details approved for the provisional mock/client contract: Argon2id
v19, 65536 KiB memory, 3 iterations, 1 lane, 32-byte output; 16-byte salt and
32-byte nonces/proof with unpadded base64url encoding. No phone timing has
been measured. The HMAC input preserves the owner's concatenation order:
domain, canonical leaf fingerprint, optional company-CA fingerprint,
normalized origin, client nonce, server nonce, using canonical UTF-8 strings.
No extra length framing changes that expression. CA retrieval may select a
known hash via `GET /devices/ca?pin=…`; current/next trust and exact-next ack
fields will be explicit in `CONTRACT.md`. These wire details remain subject
to M3 mapping; they do not change the owner's trust model.

The specified nonce-only proof request has no code identifier. Provisional
mock rule: one active proof offer per origin; issuing a newer code supersedes
older proof offers. Older redemption codes may still work over already-trusted
TLS. A wrong or superseded code fails proof locally and is not sent. M3 must
settle concurrent proof offers; WP4 does not invent an additional request
field or implement harness policy outside the mock.

WP4 provides a bounded, authenticated `devices.trust.next` SSE consumer. An
event triggers a fresh meta-checked trust GET, durable storage, then ack;
event payloads cannot introduce pins independently. The persistent active-
connection event loop and tray lifecycle remain WP6. WP4 does not claim a
continuously subscribed native UI or startup keychain access.

### Local gates and native check (implementation aef74f1)

- Frozen pnpm install, toolchain check, generation/build and root lint PASS.
- Root Node: 590 passed (including 25 UI), five existing platform skips;
  hygiene self-tests 11 passed.
- Root Rust fmt/clippy/tests PASS: 1,006 passed, one existing ignored test.
- Desktop fmt/clippy/locked workspace tests PASS: 93 passed, one ignored
  real-keychain round trip (explicit seam-only test constraint).
- macOS debug app bundle PASS; ad-hoc signature, no notarization credentials.
- Native macOS/WKWebView, synthetic loopback mock and isolated scratch profile:
  Connections → Add remote → pair (three button actions, plus four text inputs),
  memory-only notice shown; Open validates/selects and clearly states the SPA
  is not available until the next WP. Rename persists. `connections.json` mode
  is `0600`; app stdout/stderr empty. Explicit quit/relaunch with the same
  scratch environment retains metadata but loses the memory token; Open then
  requests repair. Repair locks name/origin and focuses the first code field.
  App exit and disposal of this test's mock process were verified; no UI query
  was made after quitting that could relaunch outside the scratch environment.
- Native screenshots: [paired memory connection](img/wp04-native-memory-connection.png),
  [repair after restart](img/wp04-native-repair.png), synthetic data only.
- Manual observation awaiting review: Home still displays the WP3 empty
  connections placeholder although Connections correctly displays a saved row.
- Real keychain, Windows/Linux native manual flows, and actual screen readers
  have not been exercised. AX-tree observations are not a screen-reader pass.

Local logs: `/tmp/desktop-wp04-{preflight,root-node,root-rust,desktop-rust,native-build}.log`.
Initial local evidence above predates publication. Review was subsequently
resolved below; PR64 is published as draft and current-head CI remains pending.

### Historical acceptance matrix (local macOS, aef74f1; superseded below)


Paths below are relative to `apps/desktop/`.

| Acceptance | Evidence |
|---|---|
| Exact origins, normalization/IDN/loopback only | `src-tauri/tests/connections.rs::origin_uses_shared_case_table`; `ui/test/pairing-model.test.ts` consumes the identical 27-case JSON file. Cases reject abbreviated/hex/octal/decimal IPv4, percent-host aliases, userinfo (including empty), dot-segment paths, bare query/fragment, whitespace and backslashes. |
| Bundled/local/remote metadata and 0600 | `store_round_trips_all_three_connection_kinds`, `store_round_trips_and_writes_0600`. No bundled controller is implemented. |
| Corrupt/unknown files kept aside | `corrupt_and_unknown_files_are_kept_aside`; `.corrupt-<milliseconds>-<uuid>` avoids collision overwrite. Closed serde structs cover nested data. |
| Pin parser/persistence/type restriction | `cert_pin_round_trips_refuses_malformed_and_only_remote_https`. Stored pins canonical base64url SHA256; current cert/CA and next cert/CA are exclusive. |
| Credential deletion before row removal; failure preserves row | `remove_keeps_the_row_when_token_delete_fails`, base store roundtrip/removal, plus `secrets.rs::removing_with_unavailable_persistent_store_keeps_row_but_current_memory_credential_can_be_removed`. |
| Secret redaction, memory store, denied handling, fallback | Four focused secrets tests; no value-bearing assert_eq output. Token hints last4 only after HTTP token validation; <=4 helper inputs redact. |
| Real keychain opt-in | Test present and ignored with explicit user-prohibition reason. **NOT RUN.** No real keychain credential inspection. |
| Meta version + installation identity before bearer/code | `client.rs::meta_and_installation_identity_gate_bearer`, `unsupported_api_is_refused_before_bearer_and_errors_do_not_echo_server_data`, `pairing.rs::a_different_installation_at_the_origin_gets_no_code_or_token`. Request traces hold only route/auth-present boolean. Missing capability rejection is implemented in meta; no separate mock capability-removal test. |
| Token only in TokenStore, never files/errors/IPC | `redeem_stores_the_token_in_the_token_store_only_and_revoked_removes_it`, recursive `tests/common::assert_no_token_on_disk`, `malformed_short_redemption_is_refused_without_persistence_or_secret_in_error`, command DTO inspection. Short redemption token rejected before persistence. |
| Revocation cleanup | Pairing test checks credential deletion + persisted repair after whoami/trust/ticket; generated-TLS `revoked_on_trust_ack_removes_credential_and_marks_pairing_needed` revokes after authenticated GET trust and verifies ack failure clears just-stored token. SSE wrapper uses the same failure handler; distinct SSE401 test not separately run. |
| Redirect refusal, response bounds | `client.rs::redirects_are_not_followed_and_bodies_are_bounded` drives a real TCP responder with 302 and oversized Content-Length. |
| Insecure remote before network | `pair_code_rejects_insecure_remote_before_any_request`. |
| Native stale/nonloopback/no-token-file discovery | `discover_ignores_stale_non_loopback_and_unknown_fields_and_never_opens_tokens`, plus existing WP2 discovery tests. PID and root injected in focused test; HTTP reachability and installation validated in native command. |
| Fixed argv/native denied fallback | Injected `pair_local_spawns_fixed_args_and_parses_json_and_denied_falls_back`; actual process integration in `test-bins/tests/exec.rs::native_pairing_client_spawns_known_binary_fixed_argv_and_never_records_token`; browser denied-to-code test. |
| Exact pinned leaf, changed cert, untrusted before HTTP | `tls.rs::pinned_origin_accepts_exactly_the_pinned_leaf_and_change_is_detected_before_http`, `unpinned_self_signed_is_untrusted_before_any_request`. Errors map to persisted repair in validate_connection; observed fingerprint is public metadata for repair details. |
| Proof succeeds / relay mismatch never sends code | `pair_proof_pins_on_match_and_never_sends_the_code_on_relay_mismatch`, `substituted_ca_and_replaced_or_expired_offer_never_disclose_code`, `expired_proof_offer_never_sends_code`. Actual generated TLS servers; no redeem route observed after proof failure. |
| OS trusted skips proof | `os_trusted_origin_skips_pair_proof_with_injected_roots_only`; injected generated CA, no OS root mutation. |
| No typed pin | `the_pin_is_never_taken_from_a_typed_field` and `config.rs::every_wp4_command_is_registered_guarded_and_no_pin_or_runtime_path_is_an_ipc_input`; no pin form field. |
| Company CA origin scope, hash match, leaf renewal, unknown CA | `company_ca_verifies_normal_chain_and_renewal_and_refuses_substitution`, `company_ca_pin_is_scoped_to_the_connection_origin`; hostname failure is exercised, unknown company CA returns CaNotKnown, no CA files. CA structure/validity parser + normal rustls leaf-validity enforcement implemented; distinct expired-chain generated test not separately run. |
| Authenticated next trust, both current/next, promotion, missed rollover | `rollover_cert_to_ca_and_ca_to_cert_is_authenticated_and_promoted` covers both directions, old/current use before switch, next after switch, promotion and missed change. `new_pairing_during_staged_rollover_stores_both_trusts_before_ack` verifies both are saved on initial pairing. |
| Authenticated SSE source, event cannot independently inject trust | `authenticated_sse_trust_event_triggers_same_secure_sync`, `sse_event_cannot_inject_a_pin_detached_from_authenticated_trust_document` (all bearer trace entries preceded by meta). WP6 drives continuous subscription loop. |
| Shared proof encoding / cross-side implementation | `desktop-contract::proof_tests::canonical_proof_matches_independently_framed_hmac_and_binds_every_field` includes canonical public expected HMAC vector, runtime-constructed test key, independent literal byte concatenation, origin/leaf substitution negatives; mock/native share contract functions. |
| UI pairing table / i18n | pairing-model tests enumerate every error and retry target; existing catalogue test keeps equal nonempty DE/EN keys. |
| UI reachable flows/accessibility/layout | Four `ui/test/connections.test.ts` browser tests cover pair/select/rename/remove, invalid HTTP, native denied fallback, revoked/cert/CA/proof errors, focus, axe DE/EN×light/dark at400px, target>=44, CA/trust-next details sheet and repair readonly fields. All original19 UI tests retained and green. |


All listed automated cases passed locally unless the entry explicitly says
not run. Five-target CI and independent review are still pending.

### Additional deviations and remaining boundaries

- The mock now generates eight uniformly selected Crockford-base32 code
  characters (40 bits), displayed4+4, aligning the documented proof rationale.
- Native `pair_local` is asynchronous rather than the plan's synchronous
  pseudocode: bounded Tokio subprocess execution keeps the UI thread responsive.
- Corrupt-file names include milliseconds plus UUID to avoid overwriting a
  previous preserved corrupt file. Credential accounts retain `device-<uuid>`.
- Keyring4.2.0 with only its `v1` feature selects native macOS/Windows/Secret
  Service backends; real platform round trips remain unverified. Exact dependency
  versions and the separate desktop lockfile are committed; root engine pin is
  unchanged. No prohibited Tauri plugin was added.
- Storage/client tests had observed RED→GREEN evidence. Several expanded TLS,
  native and UI cases were added alongside implementation; an all-tests-first
  TDD history is not claimed.
- Canvas could not be opened; the owner's Glow-spec fallback was used. No
  pixel-match claim. C8/C9/C22, exact origin restrictions and just-in-time
  keychain access follow the current written decisions.
- M3 must define concurrent proof offers and map provisional encodings/routes.
  Company-CA admin upload remains D2; no real M3 API/server was added.

### Historical next-work checklist (aef74f1)

- [ ] Resolve independent WP4 review findings and perform scoped re-review.
- [ ] Re-run checks affected by fixes, publish a draft PR and verify current-head
      root plus all five desktop target CI results.
- [ ] Begin WP5 only after WP4 is green; first perform the required custom-protocol
      SSE/WebSocket spike and record each target's fallback decision.
- [ ] WP6 tray/event lifecycle and D111 logs follow green WP5.

### Independent review at aef74f1

Spec compliance failed and code quality needs fixes. Three required corrections
are in progress: persistent credential cleanup/provenance across memory-only
repair; independent current-or-next CA preparation; Home/startup connection
metadata integration. Passing local tests did not cover these paths.

Four minor findings are retained for final branch review: code repair changes
Local to Remote; success notice can outlive a failed Open/removal; the bounded
SSE parser currently handles LF rather than valid CRLF framing; revoked repair
state is not saved if keychain deletion itself fails. These are not silently
closed by the current test pass.

Fix ruling: version1 metadata gains credential provenance and an explicit pending
keychain-cleanup obligation. Rows written before provenance existed default to
legacy and require repair before loading a credential; cleanup remains pending
until deletion or safe overwrite succeeds. This conservative upgrade may require
one new pairing for existing rows, preventing a stale keychain sign-in from being
silently reused. Newly created memory-only rows remain removable without a
keychain. Required regression coverage includes old-version1 JSON and two injected
credential stores; fix results are pending.

### Fix round 1 — 41f46fd

I1 credential provenance/cleanup, I2 independent trust candidates and I3 shared
Home/startup metadata are implemented with focused regressions. Related M4 now
saves revoked repair state before attempting credential deletion. Independent
scoped re-review is pending. M1–M3 remain explicitly deferred to final review.

Observed final local gates: root build/lint/test PASS (593 passed including28 UI,
five existing skips, plus11 hygiene tests). Desktop fmt/clippy/locked tests PASS:
99 passed, one explicitly ignored keychain round trip. Root Rust remains the
earlier observed1006-pass/1-existing-ignore result; root Rust source/workspace
did not change. Debug app bundle rebuilt successfully.

One failed controller run is retained: overlapping Tauri bundle compilation and
desktop tests yielded Rustdoc E0463, missing `tauri`, after99 behavior tests
passed. The unchanged full desktop gate run serially passed including all
doc-tests. This is consistent with shared build-artifact interference, not a
proven source defect; subsequent build/test runs will be serialized. Logs:
`/tmp/desktop-wp04-fix-desktop-rust.log` and `-serial.log`.

Native macOS recheck with the same scratch legacy metadata: Home and top status
show one saved connection immediately after startup, before visiting Connections.
[Corrected Home screenshot](img/wp04-native-home-restored.png). No keychain
access, empty app log; app exit verified without a post-quit UI query.

Scoped re-review of `aef74f1..41f46fd`: I1/I2/I3/M4 ADDRESSED, no new
Critical/Important breakage. M1–M3 remain recorded for final branch review.
`origin/main` re-fetched before push: still `d33961b`; WP3 PR63 still unmerged.
WP4 therefore remains stacked on `feat/desktop-shell-wp03-ui-frame`.

### Publication and CI

Draft PR64 is attached to this task and based on WP3. First report head `c51d7fa`
started root run36968518154 and desktop PR36968518124/push36968502969. This
PR-link-only update creates a newer report head; those initial runs alone cannot
prove final-head Green. Check current-head root and all desktop targets before
starting WP5. No owner merge was performed.

### CI follow-up at 3ff7e0f

Draft PR64 remains unmerged and WP5 is unstarted. Current desktop run36968566226:
Windows ARM and Docker/Podman PASS; Windows x64 failed linking the
`fake-plur1bus` test executable. `src-tauri` build output supplied an invalid
`msvcrt.lib` (LNK4003), followed by unresolved CRT symbols/LNK1120. Root Linux
unit passed; other root/desktop jobs are still running or queued. This is not
final-head Green. Exact sanitized failure log is
`/tmp/desktop-wp04-windows-failure.log`; diagnosis/fix is in progress.

Root run36968566221 also failed: macOS `pnpm test` reached the first six
read-only SQLite primitive tests, then hung before concurrent-writer completion
and hit the15-minute limit. Linux and Windows unit jobs passed; dependent
service/system jobs were skipped after the macOS failure. The prior WP3
test-only correction is present, so this remaining path needs diagnosis rather
than an unqualified rerun. Log: `/tmp/desktop-wp04-macos-failure.log`. The older
report head's unit jobs passed on all three OSes; that does not replace this
failed current-head gate.

### CI corrections awaiting the next complete gate

- `cc2a5df`: isolates Tauri2.7.0's synthetic x86/x64 CRT shim in a private
  linker directory while preserving static CRT options and the cross-crate
  native integration test. Independent scoped review PASS; local desktop
  fmt/clippy/tests PASS (102 passed, one ignored keychain test). Real Windows
  link and packaging verification remains pending in CI.
- `8c1750b`: test-only SQLite prerequisite. The live writer appends WAL during
  probes, with automatic/final checkpoints held until IPC stop. A separate real
  `afterCopy` write/checkpoint grows the main file on all four attempts and
  requires `E_SOURCE_BUSY`, preserving the no-source-files assertion. Focused
  file11/11 and typecheck passed under external process-group timeouts; full
  root checks and independent review are in progress.
- Exact native call behind the macOS hang is unproven. A copied live main/WAL
  pair is not a supported atomic backup; production copy validation and detect's
  changing-file `immutable=1` fallback remain an owner decision. This test change
  does not claim to fix that production risk.
- Completed prior-head desktop run36968566226: macOS, Linux x64/ARM, Windows ARM,
  Docker and Podman PASS; Windows x64 FAIL. Root run36968566221: Linux/Windows
  unit PASS, macOS timeout, dependent system/service jobs skipped. Neither run
  proves Green for the two new corrections.

### Reviewed CI-fix checkpoint (8c1750b plus this report)

Both narrow corrections passed independent scoped review, with no Critical or
Important findings. Full local gates completed before the next push:

- Root build/lint/test:594 passed including28 UI, five existing platform skips;
  hygiene self-tests11 passed.
- Root Rust fmt/clippy/test:1,006 passed, one existing ignored test.
- Desktop fmt/clippy/locked tests:102 passed, one explicitly ignored real-keychain
  round trip. Windows adds the architecture-specific build-output assertion in CI.
- Source/fmt/diff checks passed. Main fetched again: still `d33961b`; PR63 is
  unmerged, so PR64 remains stacked on WP3 and draft.

Logs: `/tmp/desktop-wp04-ci-fix-root-{node,rust}.log` and
`/tmp/desktop-wp04-windows-fix-desktop-rust.log`. The initial frozen install,
toolchain/gen checks and synthetic native screenshots remain recorded above;
the CI follow-ups did not add dependencies or change UI behavior.

Historical unfinished work at the d2ea464 commit boundary:

- [ ] Verify the new PR64 head's complete root CI, including macOS Node plus
      dependent service/system/soak jobs.
- [ ] Verify all five desktop targets plus Docker/Podman; specifically Windows
      x64 linking and both Windows packaging results after `cc2a5df`.
- [ ] Resolve any new actual CI failure, with scoped review and local Green
      before another push; do not treat earlier-head passes as a final pass.
- [ ] WP5 remains unstarted. After full WP4 Green, begin its required D1 Task13
      Step0 custom-protocol SSE/WebSocket spike for WKWebView/WebView2/WebKitGTK.
- [ ] WP6 remains unstarted and follows green WP5. Carry M1–M3 into final review
      (local repair kind, stale success notice, CRLF SSE framing).
- [ ] Owner follow-up: production SQLite live-copy/immutable safety. New test
      coverage does not resolve that risk. Nonblocking review note: a heavily
      delayed runner may outlast the writer's1.5-second/500-insert cap; the test
      does not prove overlap at each individual probe.

The native test apps/mocks are stopped; real keychain and actual screen-reader
checks were not run. No merge, rebase, amend or force-push was performed.

### Owner-directed WP3 forward merge, 2026-10-02

- Normal merge of `origin/main` (`e6c98cf`, containing merged PR #60) into WP3.
- `58b6b58` applies the exact previously reviewed root SQLite test correction
  from `8c1750b`; no WP4 feature is pulled into WP3. The production SQLite
  live-copy/immutable risk remains unresolved; this is test-only.
- Fresh local gates PASS: root check/build/lint/test, root Rust fmt/clippy/test,
  desktop locked fmt/clippy/test including UI/a11y/layout via the root test run.
  Logs: `/tmp/wp03-forward-{node,root-rust,desktop}.log`. CI must verify
  the new head; earlier green runs are historical evidence only.
- WP4 at `d2ea464` passed root run36971308959 and desktop runs36971308985 and
  36971306303, including five desktop targets and Docker/Podman. It will receive
  the new WP3 history by normal merge and then repeat the required gates.
- WP5 and WP6 remain unstarted. Both #63 and #64 remain drafts.

### WP4 normal forward merge after PR #60 merged

- Merge commit `9caced7` includes all WP3 commits through `a735d2b`.
  Its tree differs from the previously green `d2ea464` only in this report.
- The report-only merge conflict preserved the WP3 update and WP4 history.
- No rebase, force-push, amend, or merge into main. Both PRs remain draft.
- Untracked `docs/handoff/.DS_Store` was present before this work and left alone.
- Fresh local root build/lint/test and root/desktop fmt, Clippy and tests PASS,
  including UI/a11y/layout. Logs: `/tmp/wp04-forward-{node,root-rust,desktop}.log`.
  New complete current-head CI remains required before WP5.

### Current WP4 owner corrections (source7e835bb)

I1: staged next pins preserve the current OS trust path until the switch;
explicit current leaf pins remain fail-closed. I2: changed certificates are
tested through stored connection validation, including actual observed pin and
no request/bearer after failed TLS; missing session-ticket capability and
installation mismatch are refused before bearer. I3: debug-only real-keychain
opt-in now overrides scratch Memory, uses a stable isolated random test service
with explicit cleanup, and safe distinct errors. I4: CA404/5xx/timeout/malformed/
oversized responses are retryable and preserve stored trust; a successful valid
different CA or actual TLS rejection may mark repair.

Local macOS arm64 gates: desktop Rust127 PASS/one ignored real-keychain test;
UI47 PASS/zero skipped, including WP3 keyboard/focus integration and native
version-error regression. Desktop locked fmt/clippy, UI build and root typecheck
PASS. Serial Tauri debug app bundle passed twice (ad-hoc signed, not notarized or launched).
Controller frozen install/check/gen/build/lint/root tests PASS:567 package tests
plus29 lint/HM2 self-tests, five existing platform skips. Root Rust1036/one
existing ignore, fmt/clippy/docscheck already PASS at the unchanged root source
from corrected WP3; no core/crate/source alteration in Part B.

Logs: `/tmp/wp04-desktop-tests.log`, `/tmp/wp04-ui-test.log`,
`/tmp/wp04-{fmt,clippy,root-typecheck,ui-build}.log`,
`/tmp/wp04-owner-root-node.log`; isolated worker logs additionally copied into
ignored scratch for recovery. Initial I1/I4 regressions failed as expected,
then passed after fixes; no acceptance assertion was weakened.

Manual evidence: the earlier synthetic native pair/restart check used
**MemoryStore only**. This correction round ran tests and native packaging,
without launching the native app or accessing the real OS keychain. Real
macOS/Windows/Linux keychain roundtrip and native pair→restart→open remain
UNVERIFIED; explicit opt-in ignored test refuses CI. No real service manager,
real home directory, credentials or user data used. Native screen readers and
additional DPI scales remain unverified.

Keychain taxonomy: NoEntry→NotFound; typed permission denial/macOS cancel or
permission OSStatus→AccessDenied; NoDefaultStore/unavailable service/generic
platform failure→Unavailable; malformed/other→Other. Fixed safe messages never
echo backend data. Windows native DWORD error type is private upstream, so
unknown Windows platform failures remain Unavailable and never Memory fallback.
Actual Windows cancellation taxonomy remains unverified. Production memory
fallback is Linux-only; explicit scratch Memory remains available on all OSes.

### Current WP4 Accept → exact test(file) → result → target

| Handoff Accept (verbatim) | Exact test and file | Result | Target |
|---|---|---|---|
| `origin_accepts_https_and_loopback_http_only` | origin_uses_shared_case_table — src-tauri/tests/connections.rs | PASS | macOS ARM64 |
| `origin_normalises_case_default_port_and_idn` | origin_uses_shared_case_table — src-tauri/tests/connections.rs | PASS | macOS ARM64 |
| `store_round_trips_bundled_local_and_remote_and_writes_0600` | store_round_trips_all_three_connection_kinds; store_round_trips_and_writes_0600 — src-tauri/tests/connections.rs | PASS | macOS ARM64 |
| `a_corrupt_file_is_kept_aside_not_overwritten` | corrupt_and_unknown_files_are_kept_aside — src-tauri/tests/connections.rs | PASS | macOS ARM64 |
| `unknown_fields_are_refused` | corrupt_and_unknown_files_are_kept_aside — src-tauri/tests/connections.rs | PASS | macOS ARM64 |
| `cert_pin_round_trips_and_refuses_a_malformed_value` | cert_pin_round_trips_refuses_malformed_and_only_remote_https — src-tauri/tests/connections.rs | PASS | macOS ARM64 |
| `cert_pin_only_on_remote_https` | cert_pin_round_trips_refuses_malformed_and_only_remote_https — src-tauri/tests/connections.rs | PASS | macOS ARM64 |
| `remove_keeps_the_row_when_the_token_delete_fails` | remove_keeps_the_row_when_token_delete_fails — src-tauri/tests/connections.rs | PASS | macOS ARM64 |
| `remove_deletes_token_then_row` | store_round_trips_and_writes_0600; remove_keeps_the_row_when_token_delete_fails — src-tauri/tests/connections.rs | PASS | macOS ARM64 |
| `secret_string_debug_and_display_are_redacted` | secret_string_debug_and_display_are_redacted — src-tauri/tests/secrets.rs | PASS | macOS ARM64 |
| `memory_store_round_trip_and_delete_missing_is_ok` | memory_store_round_trip_and_delete_missing_is_ok — src-tauri/tests/secrets.rs | PASS | macOS ARM64 |
| `access_denied_is_pairing_needed_not_a_crash` | access_denied_is_pairing_needed_not_a_crash — src-tauri/tests/secrets.rs | PASS | macOS ARM64 |
| `open_default_falls_back_to_memory_when_the_probe_fails` | open_default_falls_back_to_memory_when_the_probe_fails; only_linux_may_fall_back_after_probe_failure — src-tauri/tests/secrets.rs | PASS | macOS ARM64 |
| `meta_parses_and_rejects_an_unsupported_major` | meta_and_installation_identity_gate_bearer; unsupported_api_is_refused_before_bearer_and_errors_do_not_echo_server_data — src-tauri/tests/client.rs | PASS | macOS ARM64 |
| `redeem_stores_the_token_in_the_token_store_only` | redeem_stores_the_token_in_the_token_store_only_and_revoked_removes_it — src-tauri/tests/pairing.rs | PASS | macOS ARM64 |
| `assert_no_token_on_disk` | common::assert_no_token_on_disk called by redemption test — src-tauri/tests/common/mod.rs | PASS | macOS ARM64 |
| `a_different_installation_at_the_origin_gets_no_token` | a_different_installation_at_the_origin_gets_no_code_or_token; a_different_installation_at_the_origin_gets_no_token_on_validate — src-tauri/tests/pairing.rs | PASS | macOS ARM64 |
| `revoked_deletes_the_token_and_marks_pairing_needed` | redeem_stores_the_token_in_the_token_store_only_and_revoked_removes_it; revoked_during_trust_or_ack_and_ticket_clears_credentials — src-tauri/tests/pairing.rs | PASS | macOS ARM64 |
| `redirects_are_not_followed` | redirects_are_not_followed_and_bodies_are_bounded — src-tauri/tests/client.rs | PASS | macOS ARM64 |
| `discover_ignores_a_stale_api_json` | discover_ignores_stale_non_loopback_and_unknown_fields_and_never_opens_tokens — src-tauri/tests/pairing.rs | PASS | macOS ARM64 |
| `discover_ignores_a_non_loopback_url_in_api_json` | discover_ignores_stale_non_loopback_and_unknown_fields_and_never_opens_tokens — src-tauri/tests/pairing.rs | PASS | macOS ARM64 |
| `discover_never_opens_token_files` | discover_never_opens_token_files — src-tauri/tests/pairing.rs | PASS | macOS ARM64 |
| `pair_local_spawns_fixed_args_and_parses_json` | pair_local_spawns_fixed_args_and_parses_json_and_denied_falls_back — src-tauri/tests/pairing.rs; native_pairing_client_spawns_known_binary_fixed_argv_and_never_records_token — test-bins/tests/exec.rs | PASS | macOS ARM64 |
| `pair_local_denied_falls_back_to_code_flow` | pair_local_spawns_fixed_args_and_parses_json_and_denied_falls_back — src-tauri/tests/pairing.rs; native denial reaches code form; remote errors and repair retain accessible controls — ui/test/connections.test.ts | PASS | macOS ARM64 + Chromium |
| `pair_code_rejects_insecure_remote_before_any_request` | pair_code_rejects_insecure_remote_before_any_request — src-tauri/tests/pairing.rs | PASS | macOS ARM64 |
| `pinned_origin_accepts_exactly_the_pinned_leaf` | pinned_origin_accepts_exactly_the_pinned_leaf_and_change_is_detected_before_http; explicit_current_leaf_pin_never_falls_back_to_os_trust — src-tauri/tests/tls.rs | PASS | macOS ARM64 |
| `unpinned_self_signed_is_untrusted_before_any_request` | unpinned_self_signed_is_untrusted_before_any_request — src-tauri/tests/tls.rs | PASS | macOS ARM64 |
| `changed_certificate_is_cert_changed_and_marks_pairing_needed` | changed_certificate_is_cert_changed_and_marks_pairing_needed — src-tauri/tests/tls.rs | PASS | macOS ARM64 |
| `pair_proof_pins_on_match_and_never_sends_the_code_on_mismatch` | pair_proof_pins_on_match_and_never_sends_the_code_on_relay_mismatch; changed_certificate_is_cert_changed_and_marks_pairing_needed (stored original pin assertion) — src-tauri/tests/tls.rs | PASS | macOS ARM64 |
| `pair_proof_for_another_certificate_is_refused` | pair_proof_pins_on_match_and_never_sends_the_code_on_relay_mismatch — src-tauri/tests/tls.rs | PASS | macOS ARM64 |
| `os_trusted_origin_skips_pair_proof` | os_trusted_origin_skips_pair_proof_with_injected_roots_only — src-tauri/tests/tls.rs | PASS | macOS ARM64 |
| `the_pin_is_never_taken_from_a_typed_field` | the_pin_is_never_taken_from_a_typed_field — src-tauri/tests/pairing.rs; every_wp4_command_is_registered_guarded_and_no_pin_or_runtime_path_is_an_ipc_input — src-tauri/tests/config.rs | PASS | macOS ARM64 |
| `company_ca_pin_is_anchor_for_this_origin_only` | company_ca_pin_is_anchor_for_this_origin_only — src-tauri/tests/tls.rs | PASS | macOS ARM64 |
| `ca_from_devices_ca_endpoint_must_match_ca_pin` | successful_wrong_ca_response_marks_repair; company_ca_verifies_normal_chain_and_renewal_and_refuses_substitution — src-tauri/tests/tls.rs | PASS | macOS ARM64 |
| `leaf_renewed_by_same_ca_needs_no_repair` | company_ca_verifies_normal_chain_and_renewal_and_refuses_substitution — src-tauri/tests/tls.rs | PASS | macOS ARM64 |
| `company_ca_without_ca_pin_is_ca_not_known` | company_ca_verifies_normal_chain_and_renewal_and_refuses_substitution — src-tauri/tests/tls.rs | PASS | macOS ARM64 |
| `next_trust_is_taken_only_over_the_current_pinned_connection_with_token` | rollover_cert_to_ca_and_ca_to_cert_is_authenticated_and_promoted; sse_event_cannot_inject_a_pin_detached_from_authenticated_trust_document — src-tauri/tests/tls.rs | PASS | macOS ARM64 |
| `current_or_next_accepted_until_switch` | current_or_next_accepted_until_switch_with_os_trusted_current; rollover_cert_to_ca_and_ca_to_cert_is_authenticated_and_promoted — src-tauri/tests/tls.rs | PASS | macOS ARM64 |
| `next_becomes_current_after_switch` | current_or_next_accepted_until_switch_with_os_trusted_current; rollover_cert_to_ca_and_ca_to_cert_is_authenticated_and_promoted — src-tauri/tests/tls.rs | PASS | macOS ARM64 |
| `missed_rollover_is_cert_changed` | rollover_cert_to_ca_and_ca_to_cert_is_authenticated_and_promoted — src-tauri/tests/tls.rs (cert or CA trust failure as applicable) | PASS | macOS ARM64 |
| `missing desktop.sessionTicket capability refused` | missing_desktop_session_ticket_is_refused_without_bearer — src-tauri/tests/pairing.rs | PASS | macOS ARM64 |
| `real_keychain_round_trip` | real_keychain_round_trip — src-tauri/tests/secrets.rs | IGNORED, explicit opt-in; forbidden to worker / off CI | No real OS execution |
| pairing-model table | pairing-model maps every reachable error and requires start before success — ui/test/pairing-model.test.ts | PASS | macOS Node 24.21 |
| origin-input: same table as Rust | origin-input consumes the exact Rust case table — ui/test/pairing-model.test.ts | PASS | macOS Node 24.21 |
| `pair_bundled_creates_owner_pairs_and_stores_a_bundled_connection` | Task 9 bundled controller acceptance explicitly assigned WP8 in task-4 brief | DEFERRED WP8; native no-token argv path is separately tested now | None for bundled path |
| `pair_bundled_tolerates_an_existing_owner` | Task 9 bundled controller acceptance explicitly assigned WP8 in task-4 brief | DEFERRED WP8; native no-token argv path is separately tested now | None for bundled path |
| `pair_bundled_revokes_the_previous_device_after_storing_the_new_token` | Task 9 bundled controller acceptance explicitly assigned WP8 in task-4 brief | DEFERRED WP8; native no-token argv path is separately tested now | None for bundled path |
| `the_token_is_never_in_an_exec_argument_or_env` | Task 9 bundled controller acceptance explicitly assigned WP8 in task-4 brief | DEFERRED WP8; native no-token argv path is separately tested now | None for bundled path |
| `bundled_revoked_repairs_once_then_asks` | Task 9 bundled controller acceptance explicitly assigned WP8 in task-4 brief | DEFERRED WP8; native no-token argv path is separately tested now | None for bundled path |


### Current WP4 review Minors

| Finding | Verdict | Detail |
|---|---|---|
| M1 fallback beyond Linux | FIXED | Only production Linux probes/falls back. macOS/Windows keep Keychain backend after cancellation; get/set failure surfaces pairing/keychain error. Explicit scratch Memory works on every platform. |
| M2 versions in Incompatible | FIXED | Public numeric dotted server/client API versions included and displayed in DE/EN. Bounded validation refuses arbitrary server strings; tests verify no payload echo. |
| M3 async blocking | FIXED | Argon2 uses `spawn_blocking`; native credential actions hold the owned serialization lock while synchronous keychain operations execute on blocking workers. A current-thread Tokio regression proves other async work progresses and mutations remain serialized. |
| M4 native CLI/shim collision | DOCUMENTED OWNER QUESTION | No invented installer path or heuristic binary identification. Current native paths are pre-WP13 assumptions; installer-owned native identity/location contract must be settled before shipping WP13 shim. See `docs/desktop.md`. |
| M5 trust route required | FIXED BY EXPLICIT CONTRACT | `CONTRACT.md` now names `/devices/trust` as mandatory M3 desktop capability contract even on loopback/OS trust. No 404-as-optional heuristic. |
| M6 weak tests | FIXED | Injected discovery opener asserts the only opened file is `run/api.json`; token files cannot be touched. Held CA connection is refused by another origin's refresh/ack client before HTTP; CA does not become global. Changed installation on validation asserts no bearer. |
| M7 local repair, stale notice, SSE CRLF | FIXED | Repair preserves existing Kind, failed/action transitions clear success notice; parser accepts LF and CRLF including split delimiters. Added Rust and UI regressions. |
| M8 reporting | WORKER REPORT COMPLETE; CONTROLLER OWNS STATUS/PR | Full exact-name mapping, defaults, target distinctions and draft changelog below. Controller must update current head, final CI links, PR template and readiness. |
| M9 robustness | PARTLY FIXED / EXPLICIT DEFERRAL | Rename trims; Unix EPERM means process alive. CA `?pin=` retained to select current/next public certificate by nonsecret digest. Cross-process store serialization deferred to WP6 single-instance lifecycle; app-process mutations remain serialized. |


### Current WP4 defaults, deviations and owner questions

- §7.4 C1/C2/C4: incoming Glow tokens/isolated wordmark retained; theme follows OS with dark fallback and three choices. C8 typed proof, self-signed leaf pins, per-origin company CA, additive rollover remain the client contract; Rust SPA proxy stays WP5. C9 connections live in shell, no new SPA handover command. C22 ≥44px shell targets at every width; 1× and 2× Chromium scaling observed, no wider DPI/native-engine parity claim.
- §9 G-1 provisional mock contract remains authoritative pending M3 mapping; G-3 OS theme; G-6 pinned axe runner; G-11 separate desktop workspace/lock; G-12 copied spec values, no canvas pixel-match claim. G-9 host.keyUnlock is unimplemented in this WP and no memory-only provisioning occurs. Other wizard/runtime/update/helper defaults belong to later WPs and were not implemented here.
- Deviations preserved from prior branch: Windows CRT build-system helper; incoming mock aborted-socket compatibility, root desktop-test separation, settings changes. No new core/engine edits.
- New owner question: authoritative native install identity/path distinct from WP13 app shim. Cross-process metadata serialization intentionally deferred to WP6; not silently claimed fixed.
- Suggested draft `[Unreleased]` WP4 changelog: “Add native and remote desktop pairing with keychain-only persistent credentials, per-origin TLS trust and rollover; preserve OS trust during staged changes and retry transient CA failures without forcing re-pairing.” Controller owns PR changelog placement and WP2/WP3 lines.
- Next WP: WP5 SPA proxy/session window after controller review and final-head CI. No SPA launch is claimed by `open_connection`; it selects/verifies the stored connection only. WP6 owns persistent event lifecycle and single-instance behavior. No new branch/PR was created by worker.


The private Windows CRT shim relocation remains a build-system deviation beyond
WP4's original file list, required by the observed Windows x64 linker failure.
Both Windows CI targets must pass this head. No source/fixture/lockfile contains
real secrets. No M3 API, harness runtime controller, SPA proxy or persistent tray
subscription is claimed here.

Current unfinished checklist:

- [x] Independent review and scoped R1 re-review complete; no open Critical/Important.
- [ ] Publish reviewed status/PR body and verify exact final-head root plus
      desktop five targets/Docker/Podman CI; retain every failed attempt.
- [ ] When both corrected heads are GREEN, mark #63/#64 ready; owner merges.
- [ ] WP5 unstarted: Step0 custom-protocol SSE/WebSocket/latency/origin/capability
      spike per target, then proxy/incognito session/guard implementation and PR.
- [ ] WP6 unstarted: single instance/tray/autostart/events/quit and D111 logging
      after full WP5 Green.

### WP4 owner-correction independent review and round1

At source7e835bb, spec and quality: NEEDS FIXES. Important R1: loss of an
authorized current/next CA during endpoint outage is discarded if another pin
exists; when that other candidate does not match the active leaf, the incomplete
verifier can still persist repair. This is a source-deterministic finding, not
a new reviewer-run test result. The original implementer is adding both
CA-current/staged-leaf-before-switch and leaf-current/staged-CA-after-switch
404/503/timeout regressions, including no bearer, preserved flags/pins and
success after recovery without re-pairing. No push yet.

Minor M1: update stale desktop boundary documentation (three commands/no
networking/keychain) to nine guarded commands and implemented WP4 networking/
credentials. Minor M2: debug bundle emits expected notarization/signature
diagnostics; it is ad-hoc signed, not release signed, notarized or warning-free.
Test/Clippy logs were clean.

Reviewer boundary: task-scoped diff excludes owner-merged HM2 outside desktop
scope. Current-head CI/readiness remains controller-owned; native Windows/Linux
and real OS credential behavior are unverified. Controller fetched main6a7d656
and confirmed core readonly test is identical to main; no further core mutation.

Round1 regression reproduced the exact reviewer path: CA-current + staged leaf with503 returned cert-changed instead of retryable trust-unavailable. Provenance fix now passes focused TLS32/32; six end-to-end404/503/timeout cases cover both directions, pin/flag preservation, no bearer and recovery without re-pairing. In-memory same-row state also remains unchanged on the transient failure. Full covering gates and scoped review remain pending.

### WP4 round1 final source eb46737

R1 fix complete; scoped re-review pending. Failed CA-candidate provenance stays
with the verifier. If no available candidate validates and an authorized CA is
unavailable, the result remains retryable TrustUnavailable. An available
authorized candidate can still succeed; a valid mismatched CA and fully
available unknown-leaf rejection remain fail-closed. Transient failure changes
neither stored nor in-memory connection metadata; recovery uses the same row
and device without re-pairing. Observed fingerprint is saved only for actual
CertChanged/CaNotKnown.

| Additional round1 regression (tests/tls.rs) | Result | Target |
|---|---|---|
| current_ca_before_switch_404_is_retryable_and_recovers_without_pairing | PASS | macOS arm64 |
| current_ca_before_switch_503_is_retryable_and_recovers_without_pairing | PASS | macOS arm64 |
| current_ca_before_switch_timeout_is_retryable_and_recovers_without_pairing | PASS | macOS arm64 |
| next_ca_after_switch_404_is_retryable_and_recovers_without_pairing | PASS | macOS arm64 |
| next_ca_after_switch_503_is_retryable_and_recovers_without_pairing | PASS | macOS arm64 |
| next_ca_after_switch_timeout_is_retryable_and_recovers_without_pairing | PASS | macOS arm64 |
| valid_wrong_ca_during_rollover_still_requires_repair | PASS both directions | macOS arm64 |
| fully_available_rollover_trust_rejects_unknown_leaf_and_requires_repair | PASS both directions | macOS arm64 |
| rollover_candidates_survive_unavailable_other_ca | PASS independent candidate | macOS arm64 |

Final covering gates: focused TLS32 PASS, full desktop Rust135 PASS/one ignored
real keychain, locked fmt/Clippy/diffcheck PASS. UI unchanged since full47PASS.
Logs `/tmp/wp04-round1-{red,tls-green,desktop-tests,fmt,clippy}.log`. Final
root lint and serial locked Tauri debug build are controller-running; current
CI remains required after publication. Desktop docs now accurately list all
nine commands and implemented native networking/keychain boundary.

### WP4 reviewed publication checkpoint

Source eb46737: scoped re-review R1/M1/M2 ADDRESSED, no new Critical/Important.
Final controller root lint PASS and locked serial Tauri debug no-bundle build
PASS at this Rust head, log `/tmp/wp04-owner-round1-native-build.log`. The two
earlier app bundles are valid7e835bb packaging evidence; this final check builds
the changed native executable, without claiming a new bundle or native launch.
Root source still matches the prior full Green; importer test equals freshly
fetched origin/main6a7d656. No gate was weakened.

Publish the status checkpoint with corrected source, then observe exact final
head root CI and five desktop targets/Docker/Podman before readiness/WP5.
Both PRs remain draft until that complete gate. WP5 and WP6 are unstarted.

### WP4 final corrected-head CI and readiness

GREEN at exact a1f0029f055efa77d4331ca815fc999644fc0277: [root37015257791](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/actions/runs/37015257791), [desktop PR37015257725](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/actions/runs/37015257725), [desktop push37015254463](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/actions/runs/37015254463) all SUCCESS. Five native build/bundle targets and Docker/Podman PASS. No retry required for this WP4 head. Both corrected heads now GREEN; #63/#64 marked ready for review as owner requested. No merge into main, rebase, amend or force-push. Earlier checkpoints above remain history; real OS credential/manual limits still apply.

## WP5 — SPA proxy and profile acceptance

Branch: `fix/desktop-wp5-followups` · Base: `origin/main` at `6b0b6745`.
PR: [#78](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/pull/78) (draft follow-up; #65 merged).
Status: **GREEN · tested implementation head `943f8670803f76d75a14b6933cebe51a08ea79fd`**.
This report commit is **docs-only after `943f8670`**; no implementation changed.

Root: [37220894790](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/actions/runs/37220894790). Desktop: [37220894845](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/actions/runs/37220894845). Both are green at this head: seven target/guard jobs plus Docker/Podman; each target's executable scan passed.

### Accept table · 19 positive rows + 6 negative/security rows

`P` means PASS at the tested head; cells link to target jobs. Rows 1–19 map one-to-one to the 19 WP5 Accept names. N1–N6 are additional negative/security regressions: N1/N2 extend Accept 9, N3 extends 16, N4 extends 5, N5/N6 extend 19. They are not additional acceptance criteria.

| Acceptance | macOS arm64 | Linux x64 | Linux ARM | Windows x64 guard on | Windows x64 guard off | Windows ARM guard on | Windows ARM guard off |
|---|---|---|---|---|---|---|---|
| `navigation_table` | P [M] | P [LX] | P [LA] | P [WX+] | P [WX-] | P [WA+] | P [WA-] |
| `caller_check_rejects_other_webview_and_other_origin` | P [M] | P [LX] | P [LA] | P [WX+] | P [WX-] | P [WA+] | P [WA-] |
| `shell_info_is_the_only_spa_command` | P [M] | P [LX] | P [LA] | P [WX+] | P [WX-] | P [WA+] | P [WA-] |
| `spa_bridge_capability_is_scoped_to_the_spa_origin` | P [M] | P [LX] | P [LA] | P [WX+] | P [WX-] | P [WA+] | P [WA-] |
| `switching_connection_replaces_the_capability` | P [M] | P [LX] | P [LA] | P [WX+] | P [WX-] | P [WA+] | P [WA-] |
| `a_replayed_ticket_page_is_retried_once_then_shows_the_error` | P [M] | P [LX] | P [LA] | P [WX+] | P [WX-] | P [WA+] | P [WA-] |
| `assert_no_token_on_disk` | P [M] | P [LX] | P [LA] | P [WX+] | P [WX-] | P [WA+] | P [WA-] |
| `no_cookie_database_in_app_dirs` (Windows post-exit; macOS/Linux live) | P [M] | P [LX] | P [LA] | P [WX+] | P [WX-] | P [WA+] | P [WA-] |
| `only_the_spa_webview_is_served_others_get_403` | P [M] | P [LX] | P [LA] | P [WX+] | P [WX-] | P [WA+] | P [WA-] |
| `forwards_only_to_the_connection_origin_even_after_a_redirect` | P [M] | P [LX] | P [LA] | P [WX+] | P [WX-] | P [WA+] | P [WA-] |
| `never_adds_authorization_or_the_device_token` | P [M] | P [LX] | P [LA] | P [WX+] | P [WX-] | P [WA+] | P [WA-] |
| `page_cookies_and_authorization_are_dropped` | P [M] | P [LX] | P [LA] | P [WX+] | P [WX-] | P [WA+] | P [WA-] |
| `set_cookie_stays_in_the_jar_and_the_webview_store_is_empty` | P [M] | P [LX] | P [LA] | P [WX+] | waived (guard-off rule, live writes allowed) [WX-] | P [WA+] | waived (guard-off rule, live writes allowed) [WA-] |
| `origin_and_host_are_the_connection_origin` | P [M] | P [LX] | P [LA] | P [WX+] | P [WX-] | P [WA+] | P [WA-] |
| `sse_events_stream_without_buffering` | P [M] | P [LX] | P [LA] | P [WX+] | P [WX-] | P [WA+] | P [WA-] |
| `websocket_upgrade_is_forwarded` | P [M] | P [LX] | P [LA] | P [WX+] | P [WX-] | P [WA+] | P [WA-] |
| `pinned_origin_with_a_changed_certificate_fails_closed` | P [M] | P [LX] | P [LA] | P [WX+] | P [WX-] | P [WA+] | P [WA-] |
| `bundled_local_and_remote_use_the_same_path` | P [M] | P [LX] | P [LA] | P [WX+] | P [WX-] | P [WA+] | P [WA-] |
| `session_meta_is_fetched_once_for_many_browser_requests` | P [M] | P [LX] | P [LA] | P [WX+] | P [WX-] | P [WA+] | P [WA-] |
| N1 negative: `non_get_methods_require_exact_origin` | P [M] | P [LX] | P [LA] | P [WX+] | P [WX-] | P [WA+] | P [WA-] |
| N2 negative: `foreign_origin_and_upstream_cors_headers_cannot_grant_cors` | P [M] | P [LX] | P [LA] | P [WX+] | P [WX-] | P [WA+] | P [WA-] |
| N3 negative: `websocket_unoffered_subprotocol_fails_closed` | P [M] | P [LX] | P [LA] | P [WX+] | P [WX-] | P [WA+] | P [WA-] |
| N4 negative: `retired_listener_rejects_old_secret_and_reserves_port` | P [M] | P [LX] | P [LA] | P [WX+] | P [WX-] | P [WA+] | P [WA-] |
| N5 negative: `session_meta_revalidation_rejects_api_major_change` | P [M] | P [LX] | P [LA] | P [WX+] | P [WX-] | P [WA+] | P [WA-] |
| N6 negative: `retry_revalidates_session_meta_after_ticket_reconnect` | P [M] | P [LX] | P [LA] | P [WX+] | P [WX-] | P [WA+] | P [WA-] |

[M]: https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/actions/runs/37220894845/job/111490836295
[LX]: https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/actions/runs/37220894845/job/111490836318
[LA]: https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/actions/runs/37220894845/job/111490836384
[WX+]: https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/actions/runs/37220894845/job/111490836294
[WX-]: https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/actions/runs/37220894845/job/111490836350
[WA+]: https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/actions/runs/37220894845/job/111490836321
[WA-]: https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/actions/runs/37220894845/job/111490836266

Windows `no_cookie_database_in_app_dirs`: the 2026-10-04 owner decision covers post-exit reading only. All profile browser processes must exit before read-only SQLite/WAL zero-row and `Cookies`/`-journal`/`-wal` canary checks, then deletion. **Deviation:** guard-off permits live writes and waives condition 1 (native zero-cookie query); condition 1 applies only guard-on. Live readable-file secret scanning remains required. The uniform JS guard is defense in depth. Guarded-SPA compatibility uses Chromium/mock; WebView2 remains an explicit gap, separate from native cookie/profile acceptance.

macOS DMG previously failed before packaging at native-driver `production p95 exceeds 5ms`; the serial driver fixed that gate. W2 treated a missing WebView2 cookie DB as exit 2; release now audits/logs/deletes and exits 0.

### Follow-up changes and checks

Files: `apps/desktop/src-tauri/src/{profile_audit,windows_spa_profile,lib,spa_proxy}.rs` and `apps/desktop/scripts/check-release-seams.mjs`.

- Shared production reader: 64 KiB chunks, 64 MiB per pass, injected-clock tests between chunks/files, shared file byte limit and unreadable-file errors. Audit ≤5 s inside the 10 s exit deadline, with 1 s reserved for deletion. Real read-budget errors retain TIMEOUT and still delete.
- Startup: invalid owned `Cookies` audit still deletes (Windows test); setup-error seam still returns success. Sweep cookie inspection now receives its 5 s deadline.
- Production exit decision: OK/AUDIT/TIMEOUT/DELETE_FAILED all assert exit 0. Raw window-show errors now emit `SHELL_WINDOW_SHOW_FAILED`.
- Jar reset: nonempty positive control, actual empty jar after installation/API conflict; positive WebSocket before API conflict. Mutation proofs: removing jar clearing or losing the read-timeout kind fails the corresponding test.
- M7: CI scans debug/release executables; debug fixture marker must exist, release fixture config and guard switches must be absent.
- Local macOS: UI 51/51; locked Clippy; debug/release executable scan PASS. Native first/restart and root lint/test/Rust PASS. Desktop Rust PASS. Initial stale RPC build and missing Chromium corrected; one root read-only SQLite busy-source test failed before the serial rerun. No Core/Hermes edits.
- Local Windows target check unavailable: MSVC `assert.h` missing in `ring`; native Windows CI remains required. Guarded-SPA WebView2 compatibility remains an explicit gap.
- The native `no_cookie_database_in_app_dirs` test remains in `production_spa`; no vacuous directory-only substitute. Bundled pinned SQLite supports the Windows WAL audit.

## WP6 — IN PROGRESS (not accepted)

Branch `feat/desktop-shell-wp06-lifecycle`; first fix head `d80fc4f6`; second/final fix locally validated; [Draft PR87](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/pull/87). Windows retention confirmed in all four native CI jobs; ARM initial CI foreground refusal handled by owner-approved local-focus policy. Owner #78 `9ff52676`, main merges `b331729a`/`9009978f` (owner `77a26989`). Core/Hermes/crates/plur1bus reserved for Copilot #79; no rebase/amend/force-push/config/owner merge. WP5 ProfileExitGate/5s Linux GUI observer preserved.

### Implemented and limits

- `d635ab99`: sweep reserve/audit closure9 PASS; mutation FAIL/restored PASS. Windows sweep CI on200 success.
- `48bb9fd9`, `70edd75f`, `1c81f5d9`: typed D111 foundation, authenticated SSE state/event task, owned cancellation/generation fencing and typed revocation repair. Proxy/SPA retirement attempted even when persistence fails.
- `77baed5f`, `d6a98a60`: tray/shared guarded Quit, KeepRunning default/approval before WP5 exit gate, EN/DE44px/listener-before-pending pull; AppLauncher readback/rollback/minimized login. Glow/red1 assets. Bundled Start/Stop/WP8/runtime/updater disabled; OS acceptance partial.
- GNOME/Flatpak actor: localized Notify, owned generation/single-use ledger64, portal response/handle ordering,120s+Close3s/null readback. Awaited GUI-ack backpressure65/cancel/reconnect and real zbus order/version mutations proven; `/tmp/wp06-backpressure-restored.log`. Native recovery/listing×/packaging open.
- `e8b45008`/`45bb3373`/`d5de21f7`: remove/repair cancels matching task before credential mutation; independent fenced proxy/SPA retirement→Unpaired. Real ActivateAction rejects foreign calls, opens unapproved QuitSession;6protocolPASS. Missing Notify/closed-bus reconnect supported. Native command/actor/× open.
- `7414f3f1`, `d2995011`: private Diagnostics/shared SecretString/Set-Cookie registry before use, failclosed redaction; native hook, debug fixtures skip global hook/home. Opaque crash IDs/sanitized off-runtime reads/receipt; local Copy/Escape/errors preserve offer,44px. Native cookie/clipboard open.
- Trust supervisor: cursor/SSE outside credential owner; fenced pull/persist/ack retry and refusal retirement despite persistence failure; origin/carrier/jar retained. TLS old502→new200/foreign refusal, snapshot mutationFAIL/restored;71PASS `/tmp/wp06-active-trust-suite.log`. Native GUI/ackfailure open.
- `8bba8e87`: Settings/OS EN/DE menu/tooltip/Notify, all8 state/runtime/secret-lock words, stable IDs/Portal words. Actual decoder+Tauri setter colourPNG→MacTemplatePNG fallback. Config/settings/protocol/tray29PASS /tmp/wp06-native-language-tests.log. Native getter proof below; physical menu/theme open.
- `f484fcab`: real Wry focus/close hide/minimize/guarded Quit renderer IPC; Mac7true /tmp/wp06-native-lifecycle-restored.log. Guard-bypass mutation fails/restored pass. External profile owner validates report+cleanup; release refuses. Not real SPA/cookie/otherOS proof.
- Real second-instance Wry fixture: hiddenSPA/refocus/pinned singleton, Mac8true/Exit0 `/tmp/wp06-native-singleton.log`. Earlier CI Mac/Linux x64/ARM lifecycle8+diagnostics6 true. Local repeat blocked by ScreenIsLocked; never unlock. Focus mutation not run; Windows/final acceptance still separate.
- `4b2d9db5`: confirmed Quit takes Diagnostics, aborts ticker, awaits Writer.tick off GUI max2s, closed FAILED/TIMEOUT codes then normal exit. Real JSONL repeat2 after60s test: no-op tick FAIL101 `/tmp/wp06-shutdown-red.log`, restored PASS. Actual blocked worker TIMEOUT/released by test. Driver errors closed, no raw stack.
- Diagnostics fixture: actual panic/canaries→owned restart→redacted plain modal; cancel preserves/DismissIPC consumes; real60s ticker repeat2,GUI5s/timer125s. Mac6true `/tmp/wp06-native-diagnostics-timer.log`; mark_handled noop mutationFAIL1/restoredPASS. Release refuses; clipboard/physicalEscape open.
- Native AppKit title/tooltip/template getters:8states/runtimeMissing/SecretsLocked/ENDE protected IPC. Mac8true/Exit0 `/tmp/wp06-native-tray-restored.log`; refresh mutationFAIL1; invalidPNG→nativeTemplate→colour fallback exercised. Release markers absent. Physical menu/theme/SystemDE/settererror/otherOS open.

- Windows ACL: directory MAXIMUM_ALLOWED prevents SetSecurityInfo propagation into existing unowned children; exact owner/private ACL/reparse/share checks retained. Unchanged logging retention failed all4Windows on200, passes all4 onf443. Parallel shutdown repeat2 failed; redactor contention inferred. Test-only registry isolation plus Written/Deduplicated preconditions:5 repeatsPASS /tmp/wp06-shutdown-registry-isolation.log. Guard removal survived5; no mutation-kill claim.

### Required before acceptance

1. Native GNOME actor/bus recovery, Background Apps listing×/packaging handshake and end-to-end delivery/host/actions/Flatpak grants. Private protocol is not C17 native acceptance.
2. Active trust supervisor/GUI/ack-failure and native removal/repair measurement; D111 native clipboard/cookie redaction and remaining OS acceptance. ShowLog still Advanced; WP8 StartAgain/WP10 Updater disabled.
3. Physical menu/theme, setter-error fallback and harness-driven tray observation; native Singleton/focus repeat/mutation after unlock and platform CI. Preserve WP5 exit cleanup/5s Linux GUI observer.
4. Current source local Root/Desktop Green + Windows target attempt before push; Draft PR87 already attached; keep draft with honest limits. Completion only exact-head Root and all7 Desktop jobs green with Run links.

### Windows fix pushes (owner instruction 2026-10-05)

Maximum TWO functional fix pushes; no diagnostics-only commits, retry, input hack or blind budget raise. PR87 stays Draft; no owner merge. After second push, any red required check means STOP/report exact reason and values, then no third push. Review87/WP7 follows green acceptance only.

First fix `d80fc4f6708fe4b1181c7612ee888ad76f2b0ec6`: [Root37353009631](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/actions/runs/37353009631) SUCCESS. [DesktopPR37353009903](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/actions/runs/37353009903)/[Push37353004038](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/actions/runs/37353004038) FAILURE; Mac/Linux3 SUCCESS/Windows4 FAILURE. Product SetForegroundWindow/local SetActiveWindow/WebView2 MoveFocus on GUI avoids pinned Tao ALT/SendInput fallback. Singleton2.5.0 already calls AllowSetForegroundWindow(primaryPid) before WM_COPYDATA. Initial CI requires successful request, visible/nonminimized own active queue and child keyboard focus; OS refusal summary foreground-lock-denied. Second launch strict when launcher owns foreground; absent local focus always fails.5s unchanged; negative matrix tested. Lifecycle passes PR both ARM modes and push-on.

Lifecycle report is emitted only after runner child close0: old8true→genericfail was profile deletion, not proved child nonzero. Runner has fixed exitCode/signal/elapsedMs/report-field/deletion errno+retries; full diagnostics only on failure. Owned deletion retries sharing errors EBUSY/EPERM/ENOTEMPTY10x100ms, then asserts absent. Real helper now awaits process/pipe close before artifact read/removal;12s unchanged. First fix local Root/docs9commands, Desktop317PASS/1IGNORE, UI58, scripts39PASS/5platformSKIP, Clippy/final lint PASS; WindowsARMtarget UNAVAILABLE101 ring/MSVCassert.hSDK. `/tmp/wp06-fix-push1-validation.json`, matchingroot/desktop/ui/scripts/windowslogs.

Second/final fix (2/2, local validation complete):
- PushARMoff child0, deletion EBUSY/retries10. Capture own WebView2 browser HANDLEs while alive; after run_return wait actual browser exit using one10s production-equivalent gate, before deletion. No PID-reuse guess/enumeration/termination. Lifecycle2captured handles, Diagnostics1; closed capture/exit-timeout reason with expected count/budget. Diagnostics also sharing-only10x100ms removal. ARMPR and x64Push Diagnostics all6true before old unbounded removal failure.
- PRx64on actual SPA audit: environmentExited=true, exitWaitMs565, secretScanComplete=true, auditTimedOut=true, removed=false. Post-exit scans held canary registry mutex across filesystem traversal, serializing concurrent fixed deadlines. Copy zeroizing canary snapshot under short lock; release before I/O. Exact memchr2.8.3 byte search replaces slow debug slice loop; literal/nonASCII/binary/offset cases preserve detection.32MiB local absent-marker:243ms→109ms/equal. No deadline increase; native CI must validate correction.
- PRx64off real helper status=null/signal=SIGKILL/timedOut=true at12s. Fixed failure summary adds last validated phase; timing cause still open, no blind raise/retry. Historical main SPA_PROFILE_SWEEP_LEAF_FAILED since9ff52676/lastgreen6b0b6745 separately tracked; same code occurs in passing intentional negative test, so require actual failure evidence. CarryoverA/Bd635ab99 unchanged.

Current exact-head green/native acceptance NOT claimed. FullRoot/Desktop/UI/scripts/final lint and WindowsTargetAttempt required before final push; unavailable is not Windows execution. WP5 prefix byte-identical. Automation's existing PAUSED state preserved. No local screen unlock. Final report requires PR/head/run links/problem→fix→test and exact red observations if stopping.

Final fix local validation PASS: full Root/docs9commands, locked Desktop workspace Rust/Rustdoc362PASS/1existingIGNORE (including44 mock-harness tests), Clippy/fmt, UIbuild58tests, scripts39PASS/5platformSKIP, final Rootlint. WindowsARMtarget UNAVAILABLE101 ring/assert.hMSVCSDK. `/tmp/wp06-fix2-validation.json` and `/tmp/wp06-fix2-{root,desktop,ui,scripts,windows,final-lint}.log`. Final Windows-only HANDLE capture/wait requires native CI; no native pass claim.
