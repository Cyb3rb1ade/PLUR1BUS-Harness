# WP3 shell UI frame — implementation report

Status: **DONE_WITH_CONCERNS** pending the controller's five-target CI and independent review. Worktree `feat/desktop-shell-wp03-ui-frame`, based on `2998d35a7badeb69a28b33e7072adc6de053d20e`. This report covers the implementer's owned changes only; the controller owns workflow edits, status, final root gate, and the manual inspection record.

## Delivered

- Frameworkless TypeScript/esbuild shell with navigable Home, Connections, and Settings. Settings has Runtime, Updates, Version, and Advanced sections; Advanced persists appearance (`system`/`light`/`dark`) and language (`system`/`en`/`de`). Unavailable runtime/connection actions remain honest empty states. Sidecars and later-WP runtime/pairing/update functions are absent.
- Provisional Glow light and SHELL dark tokens, local fonts, English/German catalogues, OS theme/locale defaults, and a reduced-motion wordmark. Inline SVG navigation icons and platform-specific dialog button order/radius/footer follow the handoff. Mac/GNOME affirmative action is rightmost; Win/KDE affirmative action is first in DOM and visual order.
- Responsive 256 px sidebar above 1023 CSS px; 64 px rail plus 288 px navigation overlay below it. A 400 px wide related panel becomes a 360 px sheet, or a full-width sheet below 600 px. The compact Settings section selector is a full-width sheet. Dialogs and sheets trap keyboard focus and restore it after Escape/close. The sheet makes the underlying shell inert.
- Reusable button, segmented, switch, chip, banner, progress, rail, sheet, dialog, and wordmark components. `ipc.ts` alone imports Tauri `invoke`; browser tests use a separate fixture entry and never ship a runtime switch or query-parameter backdoor.
- Native commands `app_info`, `settings_get`, `settings_set` only. The native gate checks the `shell` webview label and exact `tauri://localhost` or `http://tauri.localhost` top-level origin. Settings enums/request are closed. The store reads at most 4096 bytes, writes via a same-directory temporary file and replacement, and sets mode 0600 on POSIX. A debug-only `PLUR1BUS_DESKTOP_CONFIG_DIR` redirects storage for scratch testing. The shell capability has no plugin grants; original CSP, `withGlobalTauri:false`, and prototype freeze remain.
- Spec-derived fallback bundle icons and deterministic generator. Actual PNG, ICO, and ICNS frames below 48 px contain only the red `1`; frames from 48 px contain the light `P1B`, dark plate, and teal/magenta ring. This is not a pixel match to the inaccessible canvas export.

## Tests and TDD record

The browser prerequisite is pinned `playwright@1.63.0` Chromium headless shell with `axe-core@4.13.0`. Local runs used `PLAYWRIGHT_BROWSERS_PATH=/tmp/plur1bus-wp03-playwright`, a disposable browser profile under `/tmp`, and the exact Tauri CSP as an HTTP header. Browser tests fail if Chromium is missing. CI's root unit job and five-target desktop matrix install the same browser, with cache under `${{ runner.temp }}/plur1bus-playwright` (controller-owned workflow changes).

Meaningful RED/GREEN milestones: missing catalogues, native settings module, and shell mount each failed before implementation; the first real Chromium run caught an undersized wordmark target; CSP blocked an inline axe injector, so the harness now serves axe as a same-origin external script. Focus tests then caught preference rerender losing focus, compact sheet selection losing its opener, and dialog Shift+Tab escaping to `body`; each turned green after a targeted fix. A responsive assertion caught the compact left overlay widened to 400 px; the related-panel test failed until the narrow sheet trigger was added. Icon tests decode actual bundle frames in Chromium rather than checking only generator source.

Final implementer checks on this checkout:

| Check | Result |
|---|---|
| `pnpm --filter @plur1bus/desktop-ui test` with pinned Chromium | **19/19 pass** after review and scale coverage, including separate unoccluded and dialog axe WCAG 2.1 AA runs in four locale/theme pairs, focus/failure, content-width boundaries, text enlargement, engine display scale, hit targets, icon frames, sheet/dialog variants and screenshots |
| `pnpm --filter @plur1bus/desktop-ui build` | Pass; static external JS/CSS/fonts, no inline script/style |
| `pnpm typecheck` | Pass |
| `cargo fmt --all -- --check` in `apps/desktop` | Pass |
| `cargo clippy --locked --workspace --all-targets -- -D warnings` in `apps/desktop` | Pass |
| `cargo test --locked --workspace --no-fail-fast` in `apps/desktop` | Pass; 55 Rust tests, including 5 new settings/authorization tests |
| `pnpm tauri build --debug --no-bundle -- --locked` and `pnpm tauri build --debug --bundles app -- --locked` | Pass; fresh ad-hoc signed `target/debug/bundle/macos/PLUR1BUS.app` |
| `git diff --check` | Pass |

The controller separately reported root `pnpm gen/build/lint/test` green at review-fix commit `f6f3e7e` (583 passes, 5 existing skips), and its root Rust suite passed. The later scale-only commit still needs the controller's final root gate; those earlier runs are not claimed as validation of it.

Browser measurements cover CSS widths 400, 720, 960, 1023, 1024, 1440, 1600, 1601, and 2560. The 720 CSS px boundary is a narrow-viewport check; it is **not** treated as proof of text zoom. A separate test keeps `window.innerWidth` at 1440 and applies a test-only 2× multiplier to each rendered shell element's original computed font size, then checks that heading text is visually doubled and the document has no horizontal overflow. This simulates 200% **text-only** enlargement, not browser page zoom or OS text scaling. Other tests assert sidebar widths, no horizontal document overflow, visible text at least 12 px, interactive targets at least 44×44 px, modal widths/DOM order for macOS/Windows/GNOME/KDE, related and Settings sheet widths, Escape/Tab/Shift+Tab focus, and reduced-motion behavior. Axe is automated evidence only; it is not a VoiceOver/NVDA/Orca pass. Screenshots were written outside the checkout at `/tmp/plur1bus-wp03-screenshots/`: `400-dark-de-mac-settings.png`, `960-dark-en-mac-home.png`, `1440-light-en-gnome-settings.png`, `2560-light-de-win-connections.png`, plus `400-dark-de-mac-sections.png`, `400-dark-de-mac-dialog.png`, and `400-dark-de-mac-keyboard-focus.png`. The controller inspected the refreshed samples and icon rasters.

## Independent-review fix round

Reviewer findings were reproduced and fixed in browser tests. `top-level wordmark collapses to a red pivot while route content changes immediately` failed because the old implementation faded and scaled the whole label and delayed its accessible label; it now collapses non-pivot letters via `max-width`/opacity, keeps the red `1` visible, changes the route and spoken label immediately, opens the new word after 190 ms, and shows the Home `Harness` subtitle. The reduced-motion test asserts immediate full-word rendering with no collapsed letters. `settings read failure keeps independently loaded Windows and KDE chrome` failed because `Promise.all` discarded successful `app_info`; the two commands now settle independently. `rapid theme and language choices serialize without losing either` failed with two overlapping stale full-object writes; saves now queue field patches and derive each write from the last confirmed value. `a failed queued preference rolls back only that choice and reports failure` verifies that later independent choices still persist, while the failed choice reverts with an alert. Axe now runs once with Advanced unobscured and again with the dialog open in every light/dark and en/de combination. The two hero glow colors were moved from base CSS into provisional tokens. These focused tests passed before the full 18-test run.

The post-review full UI run passed **18/18** (22.45 s), `pnpm typecheck` passed, and the locked Tauri debug app bundle passed after the source changes. Its binary at `apps/desktop/target/debug/bundle/macos/PLUR1BUS.app/Contents/MacOS/plur1bus-desktop` has local mtime **2026-10-02 04:23:38**. An earlier root retry hit an existing SQLite read-only fixture error; the controller then reported a passing root run at `f6f3e7e`.

## Scale coverage follow-up

The follow-up test uses the pinned Chromium 1.63.0 headless shell, the same CSP-serving browser harness, and a fresh temporary profile for each scale. It launches with `viewport:null` so Playwright does not set a synthetic viewport. At 1×, `--force-device-scale-factor=1 --window-size=1440,900` yields `innerWidth=1440`, `innerHeight=900`, DPR 1 and a 1440×900 device-pixel PNG. At 2×, `--force-device-scale-factor=2 --window-size=720,450` yields `innerWidth=720`, `innerHeight=450`, DPR 2 and **the same 1440×900 device-pixel PNG**. Chromium's `--window-size` argument is in logical CSS px; dividing its values by the engine scale preserves the physical output size. This is an actual browser-engine display-scale run, not a `page.setViewportSize(720)` substitute and not a CDP pinch or visual-viewport-only claim. It complements the independent test-only computed-font 2× enlargement test; it is not a claim that macOS/Windows/Linux OS text-size settings were operated.

At each engine scale the test visits Home, Connections, and Settings Runtime, Updates, Version, and Advanced. Every view keeps document horizontal scroll within `clientWidth`, and all visible actionable targets remain at least 44×44 CSS px. The 2× run uses the compact 64 px rail, while 1× uses the 256 px sidebar. No production code or new dependency was needed; only the test harness and layout test changed.

Final local verification for this follow-up: focused scale test passed, full desktop UI suite **19/19** passed in 22.86 s, `pnpm typecheck` passed, and `git diff --check` passed. The last native app bundle from 04:23:38 remains current because this follow-up changed tests and this report only.

## Dependencies and platform evidence

Direct JS dependencies are exact `@tauri-apps/api@2.10.1`, `axe-core@4.13.0`, and `playwright@1.63.0`. Rust direct dependencies use exact `serde@1.0.228`, `serde_json@1.0.150`, and `tempfile@3.23.0`. The root lockfile retains the original memory-engine git+https SHA `b0e149b861686eeeb18e0852c53bffe1e7de24b9`; an incidental local codeload resolution rewrite was removed before commit. UI font OFL files are bundled with exact source revisions and TTF hashes in `docs/desktop.md`; no runtime font request exists.

Playwright 1.63.0's installed `playwright-core/lib/coreBundle.js` maps every `win32` host to `hostPlatform: "win64"` (around line 8565), maps the headless executable to `chrome-headless-shell-win64/chrome-headless-shell.exe` (around line 32836), and downloads `win64/chrome-headless-shell-win64.zip` (around line 32940). Thus the Windows ARM CI target installs the **win64/x64 headless shell** and depends on Windows 11 ARM x64 emulation, documented by [Microsoft](https://learn.microsoft.com/en-ca/windows/arm/apps-on-arm-x86-emulation). This was verified from the pinned installed package; there is no local Windows ARM runner, so actual five-target CI remains the decisive check. No platform-specific silent skip was added.

## Boundaries and open verification

The controller's fresh native macOS scratch-home run confirmed the app loads, Light/English choices write `settings.json` with mode 0600, a scratch relaunch restores them, and keyboard-open dialog Tab wrapping and Escape focus return work. No native Windows or Linux UI/assistive-technology run was performed locally. Actual connection, runtime, tray, update, and pairing behavior belongs to later work packages. The app bundle is a debug, ad-hoc signed preview, not a release artifact.
