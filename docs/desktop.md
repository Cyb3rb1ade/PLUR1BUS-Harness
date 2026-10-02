# Desktop shell

The desktop shell is an optional Tauri 2.12 client. WP3 adds a responsive,
keyboard-accessible shell frame, English and German copy, and persistent appearance
and language preferences. Home, Connections, and Settings are navigable; unavailable
runtime and connection functions have honest empty states. WP2's provisional Rust
mock harness, fake executable surfaces, and Linux stub image remain available for
later work packages. The binding work sequence is in
[the handoff](handoff/2026-09-30-desktop-shell-codex.md).

At widths below 1024 CSS px, navigation uses a 64 px rail and a 288 px overlay.
The wide 400 px related panel opens as a 360 px sheet, or a full-width sheet
below 600 px. Settings uses Runtime, Updates, Version, and Advanced sections;
Advanced contains the working appearance and language controls.

## Development

Use Node 24.21.0, pnpm 10.28.0 and Rust 1.95. From the repository root:

```sh
pnpm install --frozen-lockfile
PLAYWRIGHT_BROWSERS_PATH=/tmp/plur1bus-wp03-playwright pnpm --filter @plur1bus/desktop-ui exec playwright install chromium --only-shell
pnpm --filter @plur1bus/desktop-ui build
PLAYWRIGHT_BROWSERS_PATH=/tmp/plur1bus-wp03-playwright pnpm --filter @plur1bus/desktop-ui test
cd apps/desktop
cargo fmt --all -- --check
cargo clippy --locked --workspace --all-targets -- -D warnings
cargo test --locked --workspace --no-fail-fast
pnpm tauri dev
```

The UI tests use pinned Playwright 1.63.0 and axe-core 4.13.0. They require the
Chromium headless shell and fail if it is absent. Browser tests launch a disposable
profile in the OS temporary directory, serve the bundle with the same CSP as Tauri,
and inject a test-only transport through a separate entry point. They do not call
the real native commands or use personal browser data. Linux CI also installs
Chromium's system packages with `pnpm --filter @plur1bus/desktop-ui exec playwright install --with-deps
chromium --only-shell`. Root `pnpm test` excludes the desktop UI; desktop CI runs
its browser suite separately. Set `PLUR1BUS_SCREENSHOT_DIR` to retain the responsive
screenshots outside the checkout.

`pnpm tauri dev` builds and starts the mock at `http://127.0.0.1:18700`
with temporary state, then stops it and removes that state when Tauri exits.
It does not connect the WP3 frame to the mock. WP4 adds the
connection flow; WP5 adds the SPA window and native `shell_info` bridge.
For a standalone
server, run `cargo run --locked -p plur1bus-mock-harness -- --port 18700`
from `apps/desktop`; bind defaults to loopback, and public binds are refused
outside the stub image's explicit `PLUR1BUS_CONTAINER=1` mode. The test-only pairing endpoint
is absent by default. For a scratch test, add `--test-control`, then call
`POST /__test/pair` with a known-scope body. `pnpm tauri dev` enables this seam
for its local fake CLI. Approval decision calls additionally need a debug build
and `PLUR1BUS_DESKTOP_APPROVALS_DECIDE=1`; regular runs can list synthetic
pending approvals but cannot decide them. The executable contract and state rules
are in [CONTRACT.md](../apps/desktop/mock-harness/CONTRACT.md).

The fake Rust binaries (`fake-plur1bus`, `fake-container`) run on all desktop
test targets and accept exact JSON scenario files through
`PLUR1BUS_FAKE_SCENARIO`. Each invocation records argv to the scratch path in
`PLUR1BUS_FAKE_RECORD`; no bearer token belongs in an exec argument.
The native discovery fixture writer is limited to a caller-owned temporary
directory and emits only `run/api.json`; WP4 adds the real native attach reader.
The [CLI fixtures](../apps/desktop/test-bins/fixtures/README.md) are synthetic
and checked against the harness's Rust output fields.

The [stub image instructions](../apps/desktop/stub-image/README.md) provide
`build.mjs` and an opt-in Docker/Podman `smoke.mjs`. The smoke creates only
named, labeled test objects and checks loopback publishing, `/meta`, the
daemon-status fixture, and stop time. Do not point it at a personal runtime.

Linux requires `libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev
libsecret-1-dev patchelf`. The desktop is a separate Cargo workspace with its own
lockfile at `apps/desktop/Cargo.lock`; the root workspace excludes `apps`.

`pnpm tauri build --debug --no-bundle -- --locked` compiles the native shell. Online packages
use `pnpm tauri build --bundles dmg` on macOS, `--bundles nsis` on Windows, or
`--bundles deb,rpm,appimage` on Linux. macOS uses ad-hoc signing; packages are
unsigned distribution previews. Updater artifacts are deferred until WP10's
key handling exists. No release signing credentials are needed for WP1.

## Boundaries

The bundled shell has a restrictive CSP. Its only native commands are
`app_info`, `settings_get`, and `settings_set`; all require the `shell` webview
at the exact bundled top-level origin. Generated application ACL permissions bind
exactly these commands to the `shell` webview, with Rust caller checks retained.
The shell capability grants no plugin permissions. IPC preferences are closed `theme` (`system`/`light`/`dark`) and
`locale` (`system`/`en`/`de`) values in `settings.json` under Tauri's
`app_config_dir()` for `app.plur1bus.desktop`. Writes use a temporary file and
atomic replacement; POSIX files are mode 0600. Only debug builds accept
`PLUR1BUS_DESKTOP_CONFIG_DIR` to redirect this store to a scratch directory.
Stored files allow future fields and default omitted fields; saves preserve unknown
fields. Invalid or oversized files are moved to unique `settings-recovered-*.json`
files before any later save. Filesystem read or preservation errors block saves.
`app_info` supplies the OS locale through pinned `sys-locale`; the webview's UI
language is not used as the system locale.

Theme fallback to dark is covered by an explicit no-preference seam: real Chromium
and WebKit generally report light when the OS supplies no preference. The browser
suite checks 1× and 2× display scales; 150% and 250% remain unmeasured. Playwright's
Chromium revision is pinned through Playwright 1.63.0, without a separately recorded
archive hash. The red wordmark numeral uses the WCAG logotype contrast exception;
functional text and focus indicators have separate contrast checks.

No networking, telemetry or keychain integration is enabled. The window stays
hidden until its page finishes loading. Stable
integration identifiers live in `src-tauri/src/ids.rs`.
The independent `desktop-contract` crate supplies the provisional scope,
capability, route and fixed exec-argv names to the shell, mock and fake binaries.

The icons are specification-derived Lilita One artwork because the canvas
exports were inaccessible. Below 48 px every PNG/ICO/ICNS frame is a red `1`
alone; from 48 px it is a light `P1B` on a dark plate with a teal/magenta duo
ring. [The icon source and generator](../apps/desktop/src-tauri/icons/README.md)
record the fallback and reproducible frame generation. Local font files and OFL
licenses are bundled in `apps/desktop/ui/assets/fonts/`:

| Family | Source revision | SHA-256 of bundled TTF |
|---|---|---|
| Atkinson Hyperlegible Next | Google Fonts `95f4904fc8bcf26d3420fe315560c96417c6dec7` | `5a455d1cfa099b601ab70751bb9673e8fe1854dc4500c80e1a220d0d75e31745` |
| Lilita One | Google Fonts `b9f4a43f3684f93a02b88133755deb51508c2fcf` | `f5b641c45c69d772ee4eda687bc9fda411d5cad6b0b45371491da4580cbc8d59` |
| JetBrains Mono | Google Fonts `6e4b84c976cadb3c49a40fd9a1c203e4f7fcf2da` | `48715a42ec242c21e9f02692891e147d022299a52e48d5e413e1a942193ffeda` |

The
five-target `desktop` workflow builds preview packages with seven-day retention.
Tests use scratch directories. Do not run future pairing or runtime tests against
personal state; use the seams specified in the handoff.

See [the status record](handoff/status/desktop-shell.md) for observed checks,
limitations and remaining work.
