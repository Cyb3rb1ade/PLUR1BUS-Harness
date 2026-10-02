# Desktop shell

The desktop shell is an optional Tauri 2.12 client. WP1 provides an empty native
window and static UI bundle. WP2 adds a provisional, test-only Rust mock harness,
fake executable surfaces, and a Linux stub image. The shell's connection,
runtime control, and pairing UI arrive in later work packages. The binding work sequence is in
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

`pnpm tauri dev` builds and starts the mock at `http://127.0.0.1:18700`
with temporary state, then stops it and removes that state when Tauri exits.
It does not yet connect the empty WP1 window to the mock. WP4 adds the
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

The bundled shell has a restrictive CSP and no granted native IPC commands.
No native plugins, networking, permissions, telemetry or keychain integration
are enabled in the shell yet. The window stays hidden until its page finishes loading. Stable
integration identifiers live in `src-tauri/src/ids.rs`.
The independent `desktop-contract` crate supplies the provisional scope,
capability, route and fixed exec-argv names to the shell, mock and fake binaries.

The icons are explicit synthetic placeholders pending DskIcons exports. The
five-target `desktop` workflow builds preview packages with seven-day retention.
Tests use scratch directories. Do not run future pairing or runtime tests against
personal state; use the seams specified in the handoff.

See [the status record](handoff/status/desktop-shell.md) for observed checks,
limitations and remaining work.
