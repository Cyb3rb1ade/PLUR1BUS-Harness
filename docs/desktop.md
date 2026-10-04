# Desktop shell

The desktop shell is an optional Tauri 2.12 client. WP4 adds native-local and
remote pairing, OS-keychain credentials, origin-bound TLS trust, and working
Connections pages to WP3's accessible German/English shell. Open verifies and
selects a connection; the SPA window is WP5 and is explicitly shown as unavailable. WP2's provisional Rust
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
Use the scratch-profile seam below before pairing with the mock. WP4 connects
the native client; WP5 adds the SPA window and native `shell_info` bridge.
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

The bundled shell has a restrictive CSP. Its nine native commands are
`app_info`, `settings_get`, `settings_set`, `connections_list`,
`connections_rename`, `connections_remove`, `pair_code`, `pair_local`, and
`open_connection`. All require the `shell` webview at the exact bundled top-level
origin. The shared command table generates application ACL permissions granting
exactly these commands to that webview, with Rust caller checks retained.
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

WP4 networking and credentials run only in Rust: explicit pairing and connection
validation use the origin-bound TLS client, with lazy OS keychain access at the
authenticated action. The webview receives public connection metadata, never a
device token. There is no telemetry, and the SPA/session proxy remains WP5.
The window stays hidden until its page finishes loading. Stable
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


## Connections and credential boundaries (WP4)

Add remote takes a name, origin and one-use code in two four-character fields.
Only HTTPS or literal loopback HTTP origins are allowed. The same adversarial
origin-case fixture drives Rust and TypeScript. No pin, CLI path, runtime endpoint
or arbitrary fetch route is accepted over IPC. A self-signed certificate gets a
nonce-only Argon2id/HMAC proof before any code is sent; a company CA is received by
hash during pairing and scoped to that connection's origin. Unexpected trust changes
show repair actions and current/observed fingerprints, with no “trust anyway”.
Current/next trust, acknowledgement, limits and the provisional M3 choices are in
[the mock contract](../apps/desktop/mock-harness/CONTRACT.md#wp4-pairing-proof-and-trust-provisional-until-m3).

Public metadata lives in atomic, owner-only `connections.json`, version 1, with
UUIDv7 connection ids, active selection, `uiLocale`, current/next pins and repair
state. Corrupt or unknown-field files are kept as `.corrupt-<milliseconds>-<uuid>`.
Credentials are separate: service `app.plur1bus.desktop`, account `device-<uuid>`.
The hint is the last four characters of a validated token; malformed short tokens
are refused. `SecretString` zeroizes and redacts Debug/Display and cannot serialize.

Keyring **4.2.0**, default features disabled, feature **v1**, selects native macOS
Keychain Services, Windows Credential Manager and Linux Secret Service. There is no
database/plaintext fallback. Startup and listing do not construct/probe a token
store. Explicit pairing or opening lazily probes it. Removal accesses the selected
store directly; an inaccessible persisted credential keeps its row. On failure, credentials remain in the app process's memory for this session only and
a banner explains restart behavior. Public rows survive restart, their memory
credentials do not, and opening returns pairing-needed; a new code repairs the
same row with its name/origin locked. Bundled automatic re-pair belongs to WP8.
Each row records `credentialProvenance` (`keychain`, `memory-only`, or `legacy`)
and `pendingKeychainCleanup`. A same-ID memory repair of a keychain/legacy row
retains the persistent cleanup obligation. Restart never loads a keychain token
for a memory-only row. Removal must delete the outstanding keychain account before
removing metadata; denied deletion keeps the row and obligation, even with a live
memory token. A successful keychain repair overwrites the same account and clears
the obligation. A genuinely new memory-only row can be removed after restart
without keychain access.

Existing version-1 files without provenance load as `legacy`, require one explicit
re-pair before credential access, and conservatively retain persistent cleanup.
This upgrade rule avoids reusing an old token left by a pre-provenance memory repair.
Unknown provenance values and inconsistent legacy cleanup flags are rejected by
the closed metadata schema. A revoked authenticated response first persists repair
state, then deletes its credential; denied deletion cannot erase that repair state.
Native ticket/event orchestration preserves the same rule for WP5/WP6 callers.

Native attach reads only `<state-root>/run/api.json`, checks PID liveness, loopback
origin and live meta/installation identity, then invokes the known absolute
`~/.local/bin/plur1bus` or `%LOCALAPPDATA%\PLUR1BUS\bin\plur1bus.exe` with fixed
`device pair --json --kind desktop --name <name>` args. No token file is opened.
Output is limited to 8192 bytes, errors never include it, and the process is killed
on its 15-second timeout. Denial falls back to the code form. All connection/token
mutations share one native async mutex; listing does not acquire credentials.

Home, the top summary and Connections share one public metadata snapshot loaded
at startup and refreshed after connection actions. Loading and read errors remain
distinct from a successfully loaded empty list. This never probes credentials.

The authenticated trust document is pulled after redeem and on every open.
Current and staged-next trust candidates are prepared independently: an unavailable
old CA does not block a stored next leaf, and an unavailable next CA does not block
a valid current leaf. Only candidates passing their exact pin or CA hash plus
chain/hostname/validity checks can authenticate. Existing authenticated next-CA
metadata remains staged while its candidate is unavailable; new announcements
still require CA validation before persistence and acknowledgement. Explicit pins
never broaden to system-root fallback when a CA candidate is unavailable.
The bounded SSE primitive re-pulls, persists and acknowledges the same document;
WP6 supplies its continuous subscription/reconnect lifecycle. The WP4 UI itself
is not continuously subscribed. CA upload/admin states remain D2.

### Scratch profile without keychain access

For a debug build, set `PLUR1BUS_DESKTOP_CONFIG_DIR` to an absolute temporary
directory before launching. This **forces MemoryStore**, with no real keychain
probe. It also redirects native discovery to `<scratch>/native/run/api.json` and
known CLI lookup to `<scratch>/bin/plur1bus` (`plur1bus.exe` on Windows). Settings and
connection metadata go to the same scratch profile. Legacy/pending persistent
cleanup in a scratch profile is refused without constructing/accessing a real
keychain; the row remains until persistent cleanup can actually be completed.
Release builds ignore this seam. A standalone mock with `--test-control --port 0` prints its loopback origin;
POST `/__test/pair` with `{"scopes":["ui.session","events.read"],"grant_key_unlock":false}`
to obtain a code, then enter the origin/code in Add remote. This endpoint returns
no device token. Never run the ignored `real_keychain_round_trip` without explicit
opt-in; it was not run for WP4.

Automated tests use temporary metadata, in-memory credentials, generated TLS
material, injected roots/liveness/executors, and the fake native executable. No
certificate is installed into the real OS trust store. The client exposes root
injection only in debug builds. Generated TLS covers relay/CA substitution,
renewal/hostname validation, both rollover directions, missing rollover, staged
new pairing and authenticated SSE wakeups. Browser tests cover reachable pairing,
repair and certificate/CA states, focus, axe, 44 px targets and 400 px layout;
they do not claim a design-canvas pixel match or native five-platform execution.

### WP4 review corrections and manual keychain checks

Production credential initialization remains lazy: startup/listing never probes
the OS store. Only Linux may fall back to a session MemoryStore on a failed
credential probe. macOS/Windows retain Keychain semantics and denied/cancelled
operations fail with a helpful pairing error. Scratch profiles explicitly use
MemoryStore on every OS unless the debug-only
`PLUR1BUS_DESKTOP_REAL_KEYCHAIN=1` is selected. That opt-in **requires**
`PLUR1BUS_DESKTOP_CONFIG_DIR`; it cannot select the production service.

`DebugKeychainProfile` stores a random `app.plur1bus.test.<uuid>` service name in
`test-keychain-service` and account names in `test-keychain-accounts.json` in that
scratch directory. These are public metadata; no token is written. The service
survives app restart so a manual pair → restart → open can test persistence.
After the complete manual check, call the debug `cleanup_debug_keychain(dir)`
hook with the opt-in still enabled (or use the ignored round-trip test, whose
cleanup guard removes the test entries even after a failed assertion). The
service must not be cleaned at app shutdown before the restart check. There is
no new IPC command for credentials or cleanup.

The earlier native scratch check exercised **MemoryStore only**. Real macOS
Keychain, Windows Credential Manager and Linux Secret Service round-trip and
native restart checks remain unverified; ordinary tests use injected stores,
never a real keychain. The ignored real test refuses `CI` environments.

Credential mutations remain serialized while their synchronous keychain work
runs on blocking workers. Argon2 also runs via `spawn_blocking`. API-version
incompatibility includes only bounded public numeric server/client versions.
CA availability errors preserve stored trust and are retryable; valid differing
CA responses and actual rejected TLS trust can require repair. Current OS trust
remains valid while a next pin is staged; explicit current pins stay fail-closed.

Native CLI install discovery remains an owner question for WP13: the currently
specified `~/.local/bin/plur1bus` and Windows local-app-data location also belong
to the future app shim. No alternative native install location is invented here.
Until installer-owned native identity metadata is specified, these paths remain
the pre-WP13 native assumption and must be revisited before the shim ships.
Store writes are serialized within this app process; cross-process serialization
is deferred to the WP6 single-instance lifecycle. The existing Windows CRT shim
relocation remains a documented build-system deviation needed by Windows x64.

### SPA proxy and session (WP5)

Opening a paired connection creates an incognito SPA window (minimum 800 × 600)
and logs in through a fresh, single-use 60-second ticket in the URL fragment.
Rust owns the device token, origin-bound HTTP/SSE/WebSocket transport and session
cookie jar. Page Authorization and Cookie are dropped; Set-Cookie stays in Rust
memory. Closing erases the jar; restarting needs a fresh ticket. A replacement
installation is refused before saved session cookies are forwarded.

All five measured engines use the approved ephemeral 127.0.0.1 fallback. Custom
protocols buffered SSE and rejected WS in the recorded spike. Every request needs
a fresh 256-bit per-window secret in the native User-Agent, exact Host and exact
Origin when present. That carrier is dropped from proxy-generated upstream
headers and targets. This is a
local bearer boundary shared with the paired SPA (its JavaScript can read the
native User-Agent), with no claim of defense against a compromised OS user.
Other app webviews use different native User-Agents.

The proxy filters ambient header, target, redirect and resource forwarding, but
cannot prevent page code from deliberately copying a renderer-readable carrier
into an arbitrary request body or WebSocket frame; this follows the binding's
"adds nothing the SPA could not send itself" boundary. The carrier authenticates
only this paired browser session and grants no device scope or shell IPC
authority. The device bearer and Rust session cookies remain Rust-only and are
never accepted or added by the proxy.
The controller-only wording that would require absolute confidentiality of this
renderer-readable carrier is therefore an explicit source-precedence deviation,
not a claim made by this implementation; arbitrary encoded payloads remain an
intentional paired-SPA limitation.

A second CSP intersects the harness policy and limits resource destinations to
the proxy origin, with IPC for shell_info. Harness nonce/hash rules remain in
force. Foreign CSP reporting directives and Reporting/NEL destinations are removed
to prevent native User-Agent disclosure. External CDN assets need safe origin-relative routing before a real SPA
can use them. Foreign navigation uses the classified Rust http/https/mailto
opener; popups are blocked. Failed tickets are retried once, then the error view
offers Copy log and Retry with 44px controls. Runtime and data are untouched.

Ticket retries add only the nonsecret `shell-retry=1` query to force a document
reload; a fragment change alone would not rerun redemption. The error page uses
the saved shell language and theme and consumes the shared Glow token stylesheet.
No ticket or device token crosses shell IPC.

The SPA command list contains only shell_info, guarded by exact label/current
URL, with an empty features list. Tauri 2.12 capabilities are additive: on switch
or close an origin-specific deny-shell-info retires the prior grant. Retired
ports stay reserved for this process, preventing permission reuse. This costs
one small retained listener per switch, until process exit.

Run the native fixture with Node 24.21:
`node apps/desktop/scripts/native-spa.mjs --output <dir>` from a GUI session
(Linux under Xvfb). It builds the pinned Rust driver and native example. Rust owns pairing/redeem
and credentials; Node only launches the driver. It isolates HOME/CFFIXED_USER_HOME,
XDG and profiles, uses MemoryStore and stdin credentials, and runs two distinct
app processes against the same mock. It writes sanitized browser/ACL/cookie/disk
observations as `first.json`, `restart.json`, and `index.json`; raw native output
is discarded. Each process opens two logged-in windows, tests actual old-origin
and other-webview ACL denial, verifies all ten MiB download bytes, times 100
paired direct/proxy asset requests with metadata and CSP filtering included, and
checks a controlled foreign handler receives zero fetch/image/WS/redirect calls.
It proves one ticket retry and a terminal 44px error, fresh tickets after full
process restart, empty native cookie stores, no cookie databases, and no bearer,
ticket, launch carrier, cookie, or browser CSRF on disk. No external browser or
real keychain is opened. Production acceptance on the other four targets remains
a separate CI gate; Step0 measurements are not production acceptance.
