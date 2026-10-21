# Desktop shell

The desktop shell is an optional Tauri 2.12 client for a native-local, remote,
or bundled container harness. Pairing, credentials, TLS trust, the SPA proxy,
container control, host bridge, update policy and rollback run in Rust. The
German/English shell follows the OS language by default; Settings → General
lets you choose System, English or Deutsch and System, Light or Dark appearance.
The separate Rust mock and stub image prove the provisional harness contract.
WP12 deep links and WP13 installer surfaces are implemented in the October 15
D1 draft stack (#498, #501). Packaging previews and synthetic tests are locally
validated; real-image migration/API acceptance, native cross-platform installation
and signed distribution remain open. Start with the [current status](handoff/status/desktop-shell.md)
and [real-image boundary](handoff/status/2026-10-15-d1-p3.md); older per-PR sections
below describe their historical implementation boundaries.

At widths below 1024 CSS px, navigation uses a 64 px rail and a 288 px overlay.
The wide 400 px related panel opens as a 360 px sheet, or a full-width sheet
below 600 px. Settings uses General, Runtime, Updates, Version, Advanced, and
Computer access sections. General holds the theme and language controls
(Appearance and Language); Advanced contains CLI, diagnostics, owned shortcut and uninstall controls. The stored
`theme` and `locale` keys are unchanged.

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
PLUR1BUS_DESKTOP_ALLOW_PLACEHOLDER_KEY=1 cargo clippy --locked --workspace --release -- -D warnings
cargo test --offline --locked --workspace --no-fail-fast -- --test-threads=1
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
Use the scratch-profile seam below before pairing with the mock. The native client connects to it; the SPA window uses the `shell_info` bridge.
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
unsigned distribution previews. Unsigned builds disable updater artifacts. Only an explicitly signed release
build uses `--config src-tauri/tauri.release.conf.json` to enable them.
CI does not use this overlay or any signing secret.

## Boundaries

The bundled shell has a restrictive CSP. Its native command allow-list is in
`apps/desktop/desktop-contract`; pairing, runtime, updates and host commands require the `shell` webview at the exact bundled top-level
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
device token. There is no telemetry. The SPA/session proxy is described below.
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
Tests use scratch directories. Do not run pairing or runtime tests against
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
mutations share one native async mutex; listing does not acquire credentials and never waits for
that mutex (it reads the store kind that the last finished credential action published).

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

### Transport choice (groundwork)

The [transport-choice spec](superpowers/specs/2026-10-21-desktop-transport-choice-design.md) is being built in
packages. The std-only crate `apps/desktop/net` (`plur1bus-desktop-net`) classifies addresses against the shared IANA
vectors. `src-tauri/src/transport/` validates host input, resolves once through an injected resolver, and returns the
category, hints and the exact address set to connect to (`check_target`, `gate`). It also keeps each remote
connection's path in the sidecar `connection-transport.json`. That file is tolerant of unknown fields, read-only when
written by a newer version, and moved aside as `.corrupt-<ms>-<uuid>` when corrupt. `connections.json` is never written.

The Tailscale check (spec §5) runs inside `check_target` for the Tailscale path, `*.ts.net` names and tailnet
addresses. `CliTailscale` runs `status --json` only from the fixed absolute candidates (never `PATH`; ownership, mode,
symlink and reparse-point checks), with a cleared environment, a 4 s timeout, an 8 MiB stdout cap, and caches the
parsed view for 10 s; inside Flatpak it runs nothing. A matched `*.ts.net` or short name connects to the peer's
Tailscale addresses without a DNS query. `TcpProber` connects to at most four addresses (3 s each, no bytes sent) and
compares the local address with this device's Tailscale addresses. Only the state code, the matched peer's first
`DNSName` label and its online flag reach the report; the status is never logged. Debug-only seams, ignored by release
builds: `PLUR1BUS_DESKTOP_TAILSCALE_STATUS=<file>` (a status document instead of the CLI) and
`PLUR1BUS_DESKTOP_TAILSCALE_BIN=<path>` (a fake CLI, `test-bins` `fake-tailscale`, which reads its scenario from
`fake-tailscale.scenario` beside itself). Tests use synthetic fixtures under `src-tauri/tests/fixtures/tailscale/` and
never run a real `tailscale`. IPC, pinned connect and UI follow in later packages; until then nothing in the app calls
this module.

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
Store writes are serialized within this app process; the WP6 single-instance lifecycle prevents a second app process from writing. The existing Windows CRT shim
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
the proxy origin. The shell's `shell_info` capability remains Tauri-IPC guarded, but
the authenticated SPA policy exposes no IPC transport. Harness nonce/hash rules
remain in force. Foreign CSP reporting directives and Reporting/NEL destinations are removed
to prevent native User-Agent disclosure. External CDN assets need safe origin-relative routing before a real SPA
can use them. Foreign navigation uses the classified Rust http/https/mailto
opener; popups never open a window: a popup aimed at the harness origin is remapped onto the proxy origin
in the SPA window like any navigation, so the upstream is never loaded directly. Failed tickets are retried once, then the error view
offers Copy log and Retry with 44px controls. Runtime and data are untouched.

The 2026-10-04 owner decision covers only the Windows post-exit read.
Windows debug runs separately disable the cookie guard to test the profile
independently of JavaScript suppression. This fixture-only deviation waives
condition 1 (live native zero-cookie query); condition 1 applies with the guard on. The guard defaults on on every
platform and is disabled only by the named CI fixture variant. Guard-on proves
the Rust-jar-only browser policy; guard-off allows WebView cookie APIs so the
native profile proof can observe them, then requires process exit, zero
SQLite/WAL rows and Canary bytes, and owned folder deletion. This is defence in
depth and keeps the three platforms on one policy path; it does not weaken the
release policy, which stays guarded and deletes even after a failed audit.
The guarded-SPA test uses Chromium against a mock server, not WebView2; the
guarded-SPA compatibility on WebView2 remains an **explicit gap**. The
Windows acceptance leg proves cookie/profile state, not SPA guard compatibility. The injected guard also blocks `document.cookie`, the
Cookie Store API and service-worker registration while enabled.

Ticket retries add only the nonsecret `shell-retry=1` query to force a document
reload; a fragment change alone would not rerun redemption. The error page uses
the saved shell language and theme and consumes the shared Glow token stylesheet.
No ticket or device token crosses shell IPC. Revalidation failures, including
transient network failures, retire the session; reconnect requires a fresh ticket.

The shell command list contains only `shell_info`, guarded by exact label/current
URL, with an empty features list; the authenticated SPA exposes no IPC command.
Tauri 2.12 capabilities are additive: on switch
or close an origin-specific deny-shell-info retires the prior grant. Retired
ports stay reserved for this process, preventing permission reuse. This costs
one small retained listener per switch, until process exit. Retirement cancels the
whole WebSocket pump, including blocked sends and close handshakes, and drops both
sockets without waiting for a stalled peer. Ordinary close is best effort with
one shared grace of at most one second; active forwarding has no per-frame timeout.
Bytes already accepted by the operating system cannot be recalled.

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


### Runtime adapter development (WP7)

The native adapters use Apple’s signed `/usr/local/bin/container` executable or a local Docker-compatible Unix socket / Windows named pipe. TCP Docker endpoints are ignored. Docker Desktop, Engine, Podman, Colima, OrbStack and Rancher use the same Engine API path; an existing chosen endpoint is never replaced automatically. WSL-backed Docker/Podman are supported through that API; a standalone WSL distribution is D2.

Tests use synthetic Apple fixtures and `test-bins/fake-container`, plus a local wire fixture for the Engine API. Synthetic Apple data is explicitly unrecorded. The Owner recorder requires an isolated `p1t-` HOME and matching `CFFIXED_USER_HOME`; it records public version/status only and does not start services or enumerate user objects.

WP7 is not yet accepted: Apple has no rename CLI command, full Apple/real-engine contract evidence remains open, and Docker offline archives without repository manifest digests are refused. See the WP7 acceptance matrix in `docs/handoff/status/desktop-shell.md`. CI is not polled under the Owner instruction.


### Host bridge and native frames (WP9)

The bundled connection owns a Rust-only WebSocket to `ws://127.0.0.1:<port>/ws`.
Its bearer and 32-byte secret-store key stay in native memory and OS credential
storage. The bridge resumes on app startup and after the controller reconciles
a changed published port, independently of the active SPA connection. Metadata
identity is checked before each reconnect. Remote and native-local connections
never start a bridge. Reconnect uses the existing 1–30 second exponential base
with jitter; text messages and frames are bounded to 64 KiB. Revocation retires
the device token and requests pairing. Provisioning is serialized with pairing
and removal and never overwrites an existing key (`E_EXISTS`). Memory-only
storage refuses provisioning; Settings explains how to install/unlock Secret
Service. The host switch persists with appearance settings and can be changed
from Runtime or Computer access.

`plur1bus-host` is a separate bundled stdio sidecar, built by the UI prebuild for
the same target as Tauri and staged under ignored `src-tauri/binaries/`. It has
no host capabilities or OS grants. Only `hello`, `os.permissions.status` and
`shutdown` exist. Its native supervisor clears the environment, retaining only
PATH, HOME/USERPROFILE and LANG, bounds exchanges, kills owned children on
cancellation and restarts with backoff. The Computer access page is an empty
permission frame; no grant-request method exists. Pane inputs use a closed
native enum. Linux has no universal D1 permissions pane and returns
`E_NOT_AVAILABLE`; native pane behavior on Windows/Linux remains unverified.

The native Approvals window displays a bounded projection of authenticated
`approval.requested`/`approval.resolved` events: effect and exact targets precede
risk, reversibility, grant options, the short action hash and the agent's
unverified reason. The default action opens the paired SPA approval route.
Nonce/raw arguments do not enter IPC. Its separate local capability permits
only app information, reading preferences and the three approval commands;
Rust also checks the window label and exact bundled origin. Decisions remain
G-2's debug mock only (`PLUR1BUS_DESKTOP_APPROVALS_DECIDE=1`), additionally
requiring a bundled loopback connection advertising the test mock capability.
D109's real Core approval RPC and OS attestation do not supply this provisional
desktop bearer route/scope, so no production decision integration is claimed.

WP10–WP12 (signed feed/updater, harness upgrade/rollback, deep links) are not
implemented by the WP9 delivery. No root updater, RPC schema or core changes
are included. The desktop Cargo lockfile adds only the local helper package;
the pnpm lockfile and all registry dependency versions are unchanged.

## Signed desktop update metadata (WP10)

Settings → Updates exposes Stable/Beta, automatic patches (on for a new
installation), local quiet hours (03:00–05:00), a held version, and startup
checks. Checks reserve a six-hour interval before requesting the feed; no
installation identifier or device credential is sent. Hold suppresses offers;
Skip remembers the exact version, with security releases offered again after
seven days. Later suppresses for at least 24 hours; an early restart does not bypass that
floor (§6.16.3). The next startup consumes an expired reminder.

The shell verifies the exact `{channel}.json` bytes and `.minisig` before
parsing the desktop schema. Its `version`, `channel`, `minFromVersion`, and
optional `native` extension remain compatible with the current native
`plur1bus update` release-manifest schema (#314). The root updater is unchanged. #314's separate signed channel key-list rotation
and persisted highest-seen native replay guard are not shared stores: desktop
trust uses its baked channel key and a running-version downgrade check. Deploy
replacement desktop trust in a release signed by the old key before rotating
the shared feed signer.
The desktop adds bilingual notes, migration notes for majors, release kind and
date, and SHA-256 pins for `bundle.json` and a separate Tauri `latest.json`.
The publisher helper is `apps/desktop/scripts/render-feed.mjs`; it hashes exact
file bytes, preserves native assets, and refuses mismatched product versions.

`tauri-plugin-updater` is pinned to 2.13.0. Its actual static manifest accepts
`notes` as a string and `platforms` keyed by updater target; the bilingual notes
stay in the signed feed (handoff G7/G8). Installation checks the SHA-256 of
`latest.json`, its product version, and the plugin's second response against
the pinned JSON before downloading. The plugin then verifies the archive with
the selected channel's independent updater key. Rust writes private, atomic
`upgrades.json { pending: version }` before invoking the installer, which can
exit the process on Windows. Windows updater install mode is passive. The update owner lock is held only
to decide and to claim the single install slot, not across the download. Settings, Later and Skip stay available
while it runs, and the offer is decided again with the current settings before the install is approved.
Signed feeds are checked for rollback: the newest accepted feed per channel (`lastSeen` in `updates.json`) is
kept, and a feed with a lower version, or the same version with an older date, is refused with `update-manifest`.

Only public **placeholders** are committed in `src-tauri/keys/`: one feed key
and one updater key per channel. A release build refuses them unless explicitly
marked as an unsigned PR artifact with `PLUR1BUS_DESKTOP_ALLOW_PLACEHOLDER_KEY=1`.
Feed keys accept minisign's raw public key or public file; updater keys also
accept Tauri's base64-wrapped public file. The debug-only feed/updater URL and
public-key seams are never read by a release binary. Direct builds enable
updater artifacts; Store packaging uses `--no-default-features --features store`
and `src-tauri/tauri.store.conf.json`, omits the updater plugin at runtime, and
shows notes plus a fixed native Microsoft Store search action. The final Store
listing URI belongs to the packaging follow-up.

Key rotation must be delivered in an update trusted by the previous key. If a
channel key is lost, its consumers must reinstall once from an independently
verified installer; a feed cannot restore trust by announcing a replacement key.

**Update states (Settings → Updates).** An offer whose `minFromVersion` is newer than the installed version shows "Install {version}
first": the page says so and the install stays blocked. A check or an install that the shell rejects with `update-signature`,
`update-digest` or `update-manifest` shows that the update could not be verified and links to this section. Nothing is installed,
and there is no install-anyway action: the install button stays disabled, also in the offer dialog. Other failures keep their own
text. The shell reports these as plain IPC error codes (`src-tauri/src/updates.rs`, `UpdateError::code`); the UI reads them in
`src/models/update-model.ts` (`isVerifyFailure`).

**Crash offer and pairing failures.** A crash found at start-up is shown once through `crash_offers`. The dialog says the details
stay local, copies them on request, and acknowledges the offer only on Dismiss (`crash_handled`); nothing is uploaded. Still missing:
an "open diagnostics" action and a crash-specific "try again" action, because the shell exposes no command for either. Pairing
failures keep their reason and the one action it allows (enter a code, repair, or retry) in Connections and Add remote.

**WP boundary:** bundled installs cannot execute an app-only update. They show
an explicit unavailable message until WP11 provides the shared snapshot,
migration, health gate and rollback path. The automatic-patch decision function
is tested, but native automatic execution is conservatively held back while
there is no proven active-run signal or when its activity signal is unavailable. An attached
installation may install an explicitly approved app update. The Version page, crash resume and harness rollback are implemented below;
deep-link actions remain unfinished WP12 work.

## Harness upgrade and Desktop recovery (WP11)

The shell replaces the app first and records approved release metadata in the
private configuration-root `upgrades.json`. The new app checks its exact embedded
bundle hash and product version before continuing the bundled harness upgrade.
The controller's separate `bundled/upgrades.json` is an atomic, 0600 write-ahead
journal. Recovery runs before autostart/monitoring; the restart watcher and other
container mutations cannot restart or recreate a container in the middle of it.

Upgrade uses a verified image, firstaid and free-space preflight, graceful stop,
a cold SHA-256 snapshot, same-port container swap, conditional store migration,
and the ready/meta/device-token/firstaid/smoke health gate. Patch releases refuse
store-schema changes. The previous container and snapshot remain after success.
Settings → Version shows the app/harness/image and backup metadata; manual rollback
requires confirmation that post-backup changes will be lost. Details are rendered
as plain text and copied locally. Native progress uses the same path for automatic
patches; missing activity data never counts as an idle harness.

Before restoring, the shell verifies the pre-update snapshot, saves the failed
state to its own verified volume, then replaces the live state volume. Engine
volumes cannot be removed while stopped containers reference them, so the old
container is recreated from journalled settings during restore. Every destructive
substep is journalled and can resume without overwriting the saved failed state.
The device token stays in the credential store and is only read for authentication.
A rollback skips the failed product version and keeps both data copies.

If the view says **Recovery failed**, retain `upgrades.json`, the pre-update volume
and the `*-state-failed-*` volume. Do not retry installation, purge volumes, or
change runtime/endpoint. Automatic mutations stop in this state. Copy the redacted
step/details from Settings → Version for the controller/operator to inspect the
saved snapshot manifest and the runtime state before selecting a recovery action.
No diagnostic is uploaded automatically. The stopped/new container may already
have been removed after both data copies verified; the journal records that phase.

The handoff still mocks harness `state snapshot|verify|restore`, migrations,
firstaid and smoke; real harness integration is D1 Task 3. The shell requires a
`storage` row's detail `{stateUsedBytes, freeBytes, imageBytes}` and an
`engine.storeSchema` detail `{current, required}` in `1staid.check/1`. `imageBytes`
is the conservative incoming-image budget. Automatic execution additionally
requires `daemon.status/1` to report `activity.activeRuns: 0`; unsupported activity
reporting keeps automatic execution waiting. Quiet-hour/hold/opt-out choices are
rechecked after app replacement.

Run the explicit synthetic acceptance on an already available local engine:

```sh
PLUR1BUS_DESKTOP_E2E_RUNTIME=docker node apps/desktop/scripts/upgrade-e2e.mjs docker
PLUR1BUS_DESKTOP_E2E_RUNTIME=podman node apps/desktop/scripts/upgrade-e2e.mjs podman
```

The script builds three local, private stub images (A, B, failing B′), uses a unique
`p1t-` namespace, verifies the upgrade/rollback and persisted synthetic device state,
and removes its named containers/volumes/network after success. A failed assertion
retains synthetic runtime evidence. Podman can use a supplied local
`PLUR1BUS_DESKTOP_E2E_ENDPOINT`; otherwise the script starts and stops its own
scratch-socket API process. Network access is needed for image build dependencies;
the acceptance itself uses only the local engine and loopback harness. The
workflow_dispatch `upgrade_e2e` gate runs the same test for Docker and Podman.
WP12 deep links and WP13 packaging/installer work remain outside this PR boundary.


## Runtime and preview installation

| OS | Local container runtime | Preview app installation |
| --- | --- | --- |
| macOS | Existing Docker Desktop/OrbStack or Podman machine; Apple `container` requires macOS 26 and a signed CLI on supported Apple hardware | Open the ad-hoc DMG and copy PLUR1BUS to Applications. For a trusted unsigned preview use System Settings → Privacy & Security → Open Anyway. |
| Windows | Existing Docker Desktop (Linux engine / WSL2) or Podman machine | Run the unsigned NSIS installer; Windows may require More info → Run anyway for a trusted preview. |
| Linux | Existing Docker Engine (rootful/rootless) or rootless Podman; Secret Service for durable credentials | Install the `.deb`/`.rpm` with the OS package manager or run the AppImage. WebKitGTK 4.1 and an AppIndicator host are needed. |

The shell detects existing runtimes; it never silently switches between them.
No automatic runtime download/install is claimed: WP13 is unfinished in the
current base. Stable/beta update channel selection exists in Settings → Updates;
Store/MSIX and Flatpak distribution require their remaining packaging work and
credentials. Preview packages are online builds; real offline OCI payloads,
vendor checksums, notarization and Store acceptance are not included.

## Storage and removal

Paths resolve through Tauri for identifier `app.plur1bus.desktop`:

| Data | macOS | Windows | Linux |
| --- | --- | --- | --- |
| Configuration and public connection metadata | `~/Library/Application Support/app.plur1bus.desktop/` | `%APPDATA%\app.plur1bus.desktop\` | `$XDG_CONFIG_HOME/app.plur1bus.desktop/` (default `~/.config/`) |
| Local redacted logs/crash receipts | `~/Library/Logs/app.plur1bus.desktop/` | `%LOCALAPPDATA%\app.plur1bus.desktop\logs\` | Tauri `app_log_dir()` |
| Shell webview data | WKWebView default | WebView2 local app data | WebKitGTK default |
| SPA webview data | Incognito, ephemeral owned profile | Incognito, ephemeral owned profile | Incognito, ephemeral owned profile |
| Harness data/models | Runtime-managed `plur1bus-state` / `plur1bus-models` named volumes | Same | Same |
| Host CLI / forwarder target (planned WP13) | `~/.local/bin/plur1bus`, `~/.config/plur1bus/target.json` | `%LOCALAPPDATA%\PLUR1BUS\bin\plur1bus.exe`, `%APPDATA%\PLUR1BUS\target.json` | Same as macOS |

Settings/connection files contain no device token. OS credential service is
`app.plur1bus.desktop`, accounts `device-<connection uuid>` and
`secret-store-<installationId>`. Secret Service absence yields a visible
memory-only fallback. Host-bridge secrets remain locked until the app reconnects;
disabling the bridge keeps them locked. No private signing key ships with the app.
Bundled installation and upgrade journals live below the configuration root in
`bundled/`; snapshots and failed-state copies are runtime volumes.

Quit the app before removing its app bundle/NSIS installation/Linux package.
App removal retains harness volumes and connection metadata; do not delete them
when you only intend to remove the client. Removing a connection through the UI
also removes its credential entry. The controller has tested app-only,
app-and-images and Everything policies (Everything needs `plur1bus-state`
confirmation); the end-user tiered uninstall wizard is unfinished WP13 work.
Do not manually purge recovery snapshots while Recovery failed is shown.

## WP14 CI and isolated acceptance

`container-shell.yml` covers Linux x64/ARM64 × Docker rootful, Docker rootless
and Podman rootless. Setup downloads/builds fixtures before tests. The acceptance
requires a local socket and prebuilt images; Cargo runs `--offline`. A loopback
`registry:2` proves pull-by-digest and refusal of a missing digest. Tests check
container restart/stop/uninstall, pairing and persisted device state through
A → B → failing B′ → rollback, plus refusal of non-loopback access.
Use a disposable local engine, never a personal harness installation:

```sh
# Setup: build A, B and failing B′; requires build dependencies/network.
for version in 0.1.0 0.1.1 0.1.2; do
  failure=0
  if [ "$version" = 0.1.2 ]; then failure=1; fi
  docker build -f apps/desktop/stub-image/Dockerfile --build-arg STUB_VERSION="$version" --build-arg STUB_FAIL_SMOKE="$failure" -t "p1t-stub-harness:wp11-$version" apps/desktop
done
docker pull registry:2
# Compile test binaries before switching to offline acceptance.
cargo test --manifest-path apps/desktop/Cargo.toml --locked -p plur1bus-desktop --test controller_e2e --test upgrade_e2e --no-run
PLUR1BUS_DESKTOP_E2E_RUNTIME=docker node apps/desktop/scripts/container-e2e.mjs docker
# Plan only: no engine, build, network or mutation.
node apps/desktop/scripts/container-e2e.mjs podman --dry-run
```

For Podman replace the setup runtime and select `PLUR1BUS_DESKTOP_E2E_RUNTIME=podman`. Its temporary API
socket and exact-port registry policy belong to the test. An externally supplied
Podman endpoint must already permit that loopback registry. Named synthetic evidence remains on failed
assertions; cleanup never prunes the engine. A successful controller uninstall
removes A, so prepare that image again before another full run.
`apple-container.yml` is dispatch-only on an owner-managed macOS 26 runner.
`apple-e2e.mjs` writes a versioned JSON skip/availability report; it explicitly
reports scaffold, never real Apple acceptance. Nightly Tauri 3/CEF compile and
two-build Linux `.deb` comparison are advisory; see [canary notes](../apps/desktop/canary/README.md).
Action lint permits only the declared custom Apple runner label and inherited
SC2016/SC2129 diagnostics; no new workflow diagnostics remain.

## Accessibility and known limits

Shell routes, pairing, every bundled-wizard step, runtime controls, update/Store
views and offers, version/recovery, approvals, crash, quit and ticket failure
have offline axe WCAG 2.1 AA checks in light/dark and English/German. Responsive
checks cover 400/960/1440/2560 CSS pixels; existing scale tests prove 200% display
reflow and text enlargement. Modal dialogs trap Tab/Shift-Tab and restore the
opener; asynchronous status/errors use live regions. Glow-token contrast tests
cover compositing/interpolation; the brand numeral alone has the logotype
exception. Tray labels use the native EN/DE catalogue, tested independently.

Chromium automation does not prove spoken VoiceOver/NVDA/Orca behavior, native
five-platform focus or genuine signed updates. Those manual passes, Apple
hardware, signing/notarization, Store credentials and real harness image/store
migration acceptance remain open. WP12 deep links and WP13 installer/uninstall
views do not exist in this base and therefore cannot receive an accessibility
pass. Every §8 row is classified in the [final report](handoff/status/desktop-shell.md).

## Previous unclean exits

Native startup writes a private running marker in the diagnostic directory. Orderly shutdown and the final native exit event (including updater restarts) remove it; a remaining marker on the next start produces a local `crash_last_report` with the previous session start timestamp, kind, fixed summary and diagnostic availability. `crash_dismiss` acknowledges the previous marker while keeping the current session marker. The crash dialog connects “Open diagnostics” to `diagnostics_open`, which opens only the native-owned diagnostic directory, and “Restart” to the existing native app restart mechanism through `crash_restart`. Each command requires the local shell capability and origin check and uses `try_state`. No upload is performed or exposed.

## Deep links and extension file hooks

Installed bundles register `plur1bus://` and `.p1x`. A pairing link prepares a
confirmation form with its origin prominently displayed; it never pairs by
itself or replaces an existing connection. A certificate fingerprint carried by
the link is shown and checked for that origin before the code is sent. Submit
explicitly to add a fresh connection. Failed attempts may be retried explicitly;
closing the view discards the offer.

`plur1bus://open?path=%2Fsettings%2Fgeneral` changes only a permitted route in the
active connection's already-open SPA. Links cannot choose another origin, reach
API/auth routes, traverse directories, or create a connection. Chat links,
catalogue install links (for example `plur1bus://install?id=plur1bus/zabbix-triage`)
and `.p1x` file opens show “not available in this version”; no file is read and
nothing is downloaded or installed. Unknown inputs are discarded with an
argument-free diagnostic. The same checks apply to first- and second-launch argv.
Portable AppImage desktop integration and Flatpak exports are packaging work;
installed-bundle and native acceptance limits are in the [phase 1 report](handoff/status/2026-10-15-d1-p1.md).

## D1 packaging preview (2026-10-15)

WP13 implementation and limitations: [phase 2 handoff](handoff/status/2026-10-15-d1-p2.md). Direct native bundles support online and offline content; Store and Flatpak are online-only. `node apps/desktop/scripts/build-bundle.mjs --target aarch64-apple-darwin --variant offline --ci-fixture` builds a clearly labelled preview without usable host CLI, Apple installer, harness or model weights. Other supported targets are Windows x64/arm64 and Linux x64/arm64 triples. Run on the matching native toolchain.

Production inputs are explicit environment paths: `PLUR1BUS_DESKTOP_RELEASE_MANIFEST`, `PLUR1BUS_DESKTOP_HOST_CLI`, `PLUR1BUS_DESKTOP_APPLE_PKG`, `PLUR1BUS_DESKTOP_OFFLINE_IMAGE`, `PLUR1BUS_DESKTOP_OFFLINE_MODELS`. Missing inputs fail closed. Metadata checksums must describe the actual release artifacts. Staging writes a separate provenance manifest and never downloads executable payloads. Use `--channel dev|beta|stable`; it selects the initial update channel while preserving saved user choices. Dev builds are debug previews; beta/stable use their independent signed feed keys.

`--distribution store|flatpak --variant online` builds without updater features and stages the native format plan. `--execute-formats` runs MakeAppx/flatpak-builder explicitly; Windows requires `PLUR1BUS_MSIX_PUBLISHER` and the SDK on PATH. Set `PLUR1BUS_MSIX_IDENTITY` only from the owner’s assigned Store identity. Unsigned MSIX cannot be treated as an installed Store release. Flatpak runtime/ABI/portal acceptance requires a native Linux environment; no broad host filesystem permission is requested.

Signing: `APPLE_SIGNING_IDENTITY` selects the macOS identity, otherwise `-` uses ad-hoc. No notarization credentials are provided by the scripts. Windows `signCommand` stays empty until SignPath is configured. AppImage signing is release-operated with [linuxdeploy AppImage plugin’s documented](https://github.com/linuxdeploy/linuxdeploy-plugin-appimage/blob/master/README.md) `LDAI_SIGN` and `LDAI_SIGN_KEY`; [appimagetool](https://github.com/AppImage/appimagetool/blob/main/README.md) additionally documents `APPIMAGETOOL_SIGN_PASSPHRASE` for its noninteractive signing; do not store key material in this repository or treat an unsigned preview as verified publisher identity.

Uninstall offers **App only** by default, **App and images**, or **Everything**. Only Everything removes owned state/models/snapshots and corresponding device credentials, and requires typing `plur1bus-state`. Review the summary first. Package-manager/NSIS app removal itself leaves harness data intact. CLI shim installation refuses an existing foreign `plur1bus`; the native CLI’s authoritative identity/location and forwarding are separate pending contracts.

## Real image, migration and rollback (2026-10-15)

The controller now uses the actual M8 image layout (`/state`, `/state/models`), preserving existing volume names. Upgrade checks the old image's cold-snapshot CLI contract before stopping it. Missing support returns `upgrade-contract-unavailable`; the old harness remains running. [Phase 3 handoff](handoff/status/2026-10-15-d1-p3.md) lists the exact missing pairing/session/snapshot/smoke/forwarding interfaces and the native identity proposal, which is **not implemented**.

Production native/stub→real store migration, real-image schema migration and SIGKILL rollback acceptance remain blocked on those authoritative interfaces. Existing synthetic upgrade/crash tests are useful state-machine evidence, not proof of real-store migration. Reuse M8's engine-aware backup archive rather than copying live databases or using the native updater's memory-excluding snapshot. No migration button or guessed native-state location is exposed. User guidance: [English](user/en/desktop.md), [Deutsch](user/de/desktop.md).

`node apps/desktop/scripts/real-image-probe.mjs --runtime docker --image sha256:<local-content-id> --report <private-report.json>` tests a locally built immutable image; registry inputs require `reference@sha256:<digest>`. Apple and Podman are separate runtime choices. It creates and cleans only labelled random test resources, prints fixed verdicts, and reports missing contracts explicitly. `desktop-real-image.yml` is informational and never substitutes for the full authenticated desktop gate.

## Native attach server contracts (2026-10-18)

The server side of SSH-design §9 P1–P3 is implemented independently of a desktop SSH client. `plur1bus device pair --kind desktop --json` returns `device.pair/1`: a person-bound, desktop-only, one-use code valid for ten minutes. Never read `run/api-owner.token` for this flow.

1. Read the private `run/api.json` through the locally authenticated server connection. The supervisor publishes address, port, API version, fingerprint, PID and instance only after verifying the loopback listener. `/api/v1/meta` exposes only version, capabilities and `pairingRequired`.
2. Generate an Ed25519 device key and send the CLI code, `kind: desktop`, device name and canonical base64 DER SPKI public key to `POST /api/v1/desktop/pair`. The response contains the device record and a fixed-scope bearer token shown once, valid for thirty days. Store it in the client's credential store.
3. Send `{token, origin}` to `POST /api/v1/desktop/redeem`. The origin must be an exact origin served by that listener. The response is a thirty-second, one-use ticket bound to that origin and device.
4. The SPA sends `{ticket, deviceId}` to `POST /api/v1/desktop/ticket` with the matching Origin header. This sets an HttpOnly, SameSite=Strict cookie (Secure over TLS). Credentials never belong in a URL. Existing CSRF and rate limits still apply.

The initial scope covers direct chat/session use and agent/model/status reads. It excludes settings, secrets, user administration, permission grants and credential minting. The exact actions are versioned in `DESKTOP_SCOPES`; current person roles/object rights and stored device scope can only narrow them. A desktop session cannot call a legacy RPC without a reviewed action rule. Device revocation and person disable/role-version changes invalidate the token and sessions; re-enabling a person does not revive old credentials. A revoke notification conservatively invalidates that person's current API sessions as well.

The supervisor starts the first-party `api` role on `127.0.0.1` using the atomically installed `runtime/core/api.js`; development can set `PLUR1BUS_API_JS`. It monitors the HTTP listener, restarts unexpected exits with the existing backoff policy, closes its stdin lifeline on stop, and removes `run/api.json`. The publication is private (0600 on POSIX, owner ACL on Windows). The API process takes an exclusive per-home lock. `1staid check` appends `api.supervised`: ok when ready, fail for an unhealthy API, info when the supervisor/API role is absent.

A fresh installation exposes the single first-owner account bootstrap on loopback only. Its private `run/api-bootstrap.token` proof is consumed under a database write lock; competing requests cannot create two accounts. Audit failure rolls the account transaction back. After consumption the path stays closed across restarts. Remote TLS listeners cannot use it, and the production entry never creates or accepts an attach owner-token file.

**Owner transport decision (2026-10-18):** `fingerprint: null` is allowed only when the published address is a literal IPv4 loopback address in 127.0.0.0/8 or IPv6 ::1. The supervisor currently publishes only verified 127.0.0.1 listeners. A client must reject every non-loopback descriptor unless it has both HTTPS and a certificate pin; there is no HTTP fallback. Network/Tailnet retain their real certificate pins. Loopback keeps session-cookie, CSRF and Host/Origin checks against DNS rebinding, with private 0600 `run/api.json` publication. Native client conformance remains part of subsequent client acceptance.

**KNOWN GAP / Owner questions:** Confirm the initial restricted scope; the reply to that question repeated the Engine deferral and did not authorize additional actions. If a second factor is enrolled or the configured policy requires TOTP/WebAuthn, native redemption currently fails closed with `second-factor-required`; a device/origin/scope-preserving MFA continuation remains open, with an executable todo regression in `packages/api/test/desktop-attach.test.ts`. P1–P3 remote acceptance remains open until that continuation is resolved. Static SPA assets must already be installed under `runtime/web`, or supplied to the standalone API with `--web-root`; this change does not create a Desktop SSH client or a new image/package distribution.

## D1 CI and owner acceptance (2026-10-15)

[Phase 4 handoff](handoff/status/2026-10-15-d1-p4.md) and [manual worksheet](demos/d1.md) distinguish implementation from release acceptance. The package matrix builds five native targets in beta/stable, preserves direct online/offline artifacts separately, and assembles unsigned online MSIX/Flatpak. Preview provenance explicitly records fixtures and unvalidated native installation/Flatpak runtime ABI. A built package is not an installed-package pass.

Install and tests must share one absolute `PLAYWRIGHT_BROWSERS_PATH`. Use `node apps/desktop/scripts/ui-browser.mjs install` (Linux build hosts: add `--with-deps`) and `node apps/desktop/scripts/ui-browser.mjs verify`, then the normal UI test command in that same environment. These commands resolve the UI's exact pinned Playwright package, install its headless revision and verify the actual launched browser version. The Windows toolchain check executes the pnpm batch shim through fixed cmd.exe arguments; version floors remain enforced. Windows/Linux native runs and full D1 manual evidence are still open; this stack has not polled CI or merged a PR.
