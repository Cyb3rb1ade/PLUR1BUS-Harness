# Desktop shell

The desktop shell is an optional Tauri 2.12 client. WP1 provides an empty native
window and static UI bundle; harness connections, runtime control and pairing are
not implemented. The binding work sequence is in
[the handoff](handoff/2026-09-30-desktop-shell-codex.md).

## Development

Use Node 24.21.0, pnpm 10.28.0 and Rust 1.95. From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --filter @plur1bus/desktop-ui build
pnpm --filter @plur1bus/desktop-ui test
cd apps/desktop
cargo fmt --all -- --check
cargo clippy --locked --workspace --all-targets -- -D warnings
cargo test --locked --workspace --no-fail-fast
pnpm tauri dev
```

Linux requires `libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev
libsecret-1-dev patchelf`. The desktop is a separate Cargo workspace with its own
lockfile at `apps/desktop/Cargo.lock`; the root workspace excludes `apps`.

`pnpm tauri build --debug --no-bundle -- --locked` compiles the native shell. Online packages
use `pnpm tauri build --bundles dmg` on macOS, `--bundles nsis` on Windows, or
`--bundles deb,rpm,appimage` on Linux. macOS uses ad-hoc signing; packages are
unsigned distribution previews. Updater artifacts are deferred until WP10's
key handling exists. No release signing credentials are needed for WP1.

## Boundaries

The bundled shell has a restrictive CSP and no granted native IPC commands.
No native plugins, networking, permissions, telemetry or keychain integration
are enabled. The window stays hidden until its page finishes loading. Stable
integration identifiers live in `src-tauri/src/ids.rs`.

The icons are explicit synthetic placeholders pending DskIcons exports. The
five-target `desktop` workflow builds preview packages with seven-day retention.
Tests use scratch directories. Do not run future pairing or runtime tests against
personal state; use the seams specified in the handoff.

See [the status record](handoff/status/desktop-shell.md) for observed checks,
limitations and remaining work.
