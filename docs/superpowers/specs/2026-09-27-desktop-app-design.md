# Desktop app (D74 shell): design

**Status:** Draft for owner review · **Date:** 2026-09-27 · **Owner:** Christian (Cyb3rb1ade) · **Track:** D (desktop), after M3; not on the v0.1.0 critical path · **Inputs:** spec `2026-09-24-m1b-2a-core-daemon-cli-design.md` D5, D8, D29, D35, D37, D44, D45, D47, D51, D52, D55, D62, D72, D73, D74 and §6.5 (installer) · ADR-004 incl. the amendment of 2026-09-27 · ADR-001, ADR-005 (secrets), ADR-007 (auth, RBAC), ADR-012 (supervisor, daemon, service install), ADR-016 (API stability, capabilities) · `docs/milestones.md` §M3, §5.2, §6, §7 · `packages/webmcp` · the web research in §4 (all facts dated, sources in §12).

## 1. Goal

A person on macOS, Windows or Linux installs one app and gets the PLUR1BUS web UI in a native window. The window is attached either to the harness on the same computer or to a harness on another host (a VPS reached over Tailscale). A tray icon shows the harness state. The app stores its credential only in the OS keychain and updates itself from signed releases. Later milestones add the D74 browser panel (CEF, with a D73 egress profile per panel, driven by agents through a loopback CDP token proxy), onboarding for computer use (D62), push-to-talk (D45), native notifications and WebMCP bridging (D55).

The shell is **optional**: the SPA served by the harness is still the only required UI (ADR-004 amendment). The shell is **a client of the harness API**, like the SPA and the CLI, and it has **no policy layer of its own**. Every decision about who may do what stays in the harness's `authorize()` chokepoint (ADR-007). The shell can take things away (for example, refusing to show a panel without a sandbox). It never grants anything the harness has not granted.

## 2. Decisions carried in, and decisions this spec makes

Carried in, binding: **D74** (Tauri + `tauri-apps/cef-rs`, a collapsible panel that detaches and re-attaches, streamed Chromium without a shell, a CDP token proxy on loopback, the `browser` skill), **D73** (egress profiles, wireproxy, SOCKS5, fail closed), **D72** (Tailscale publishing, the supervisor's port registry 18700–18799), **D62** (computer use through `cua-driver`, off by default, OS permissions belong to the person, a visible indicator and a kill switch), **D55** (WebMCP in both directions through `@plur1bus/webmcp`), **D35** (remote access only through the M3 API, TLS, device pairing, a revocable token per device, no vendor relay), **D8** (targets macOS arm64, Windows x64/arm64, Linux x64/arm64), **§6.5** (the `plur1bus setup` installer, which asks only the D29 `basic` questions), **D45/D44** (voice, the microphone button), **D47** (attachments), **D52** (no harness-native Anthropic OAuth, no reading another client's credentials), and the **ADR-004 amendment** (optional client, no own policy layer, after M3).

Decisions this spec makes (numbered **DS**, so they do not collide with the core spec's D-rows or the plans' rulings):

| # | Decision | Why |
|---|---|---|
| DS1 | **Attach, never bundle.** The app contains no supervisor, core, Node runtime or engine. It finds a local harness or pairs with a remote one. When no harness exists, D1 shows how to install one, and D2 adds an "Install here" action that downloads and runs the signed `plur1bus setup --non-interactive --json` (§6.5), the same installer the one-liner uses. | Two release trains (Tauri updater vs `plur1bus update`) must not be coupled. The shell is optional (ADR-004), and a VPS user never needs a local core. One installer, not two. |
| DS2 | **Tauri 2 stable first, the CEF runtime later.** D1 and D2 run on Tauri **2.12** with its default runtime (wry: WKWebView, WebView2, WebKitGTK). D3 moves the app to **Tauri 3 + `tauri-runtime-cef`**, but only after a gate: Tauri 3 has reached at least beta, `tauri-runtime-cef` has left alpha, and our smoke test passes on all five targets. A nightly canary job builds D1 against Tauri 3 alpha from D1 onward. | The CEF runtime exists only for Tauri 3 alpha today (§4.1). A thin shell that has to ship cannot sit on an alpha. D1 code stays small so the 2→3 move is cheap. |
| DS3 | **The SPA is loaded from the harness origin**, in a webview in **incognito** mode (nothing kept on disk). It is not bundled into the app. | The SPA version always matches the harness it talks to. No cookie or local storage stays on disk after the app quits. |
| DS4 | **Credential = a D35 device token** of kind `desktop`, bound to one harness user (ADR-007: effective rights = role ∩ token scopes). It is kept **only in the OS keychain** (`keyring` 4.x native stores). It is never on disk in plain text and never visible to page JavaScript. | D35 and ADR-007 are already decided. A desktop app with a person present needs no file fallback. |
| DS5 | **Webview login by one-time ticket.** The Rust side trades the device token for a single-use ticket (60 s, bound to the device). The webview opens `/auth/ticket#<ticket>`, and the SPA redeems it for a normal session cookie that is never persisted. The ticket travels in the URL fragment, so it never appears in server, proxy or `tailscale serve` logs. | This keeps the token out of the renderer (D55: "device token, never exposed to the agent") and reuses the SPA's cookie + CSRF model unchanged (ADR-004). |
| DS6 | **Remote transport: `https` with a certificate the OS trusts, or `http` only on loopback.** The recommended remote path is `tailscale serve` (D72, a valid `*.ts.net` certificate) in front of a harness API that stays on loopback. A self-signed harness with a pinned fingerprint (D35) is a named degradation: the webview cannot pin, so the app refuses such a connection and points to Tailscale or a real certificate. | Webviews have no cross-platform API to pin a certificate. A local TLS-terminating proxy would make the shell a network component. |
| DS7 | **IPC allow-list: capabilities per webview.** The bundled shell pages get the connection commands. The SPA webview gets a capability added at runtime, scoped to exactly the paired origin, with a closed list of `shell_*` commands. **Panel webviews get no IPC at all.** No Tauri `shell`, `fs` or `http` plugin is reachable from any webview. `withGlobalTauri: false`, `freezePrototype: true`. | Tauri 2 capabilities are the enforcement point (§4.5). The panel shows hostile content by definition. |
| DS8 | **No sandbox, no panel.** The CEF panel is enabled only where Chromium's process sandbox is active. Today that excludes Windows (tauri-runtime-cef runs CEF unsandboxed there) and AppImages on systems that restrict unprivileged user namespaces (Ubuntu ≥ 23.10). In those cases the panel shows the harness's streamed Chromium (D74 b), exactly as a plain browser does. | A browser panel that renders arbitrary pages without a renderer sandbox turns one renderer bug into code execution as the user (§4.1). |
| DS9 | **CDP only for panels, and always through the shell.** The CEF DevTools server stays **disabled** (`RemoteDebugging::Disabled`). The shell reaches each panel through CEF's in-process `send_dev_tools_message`. For a local harness, it exposes that through a WebSocket token proxy on `127.0.0.1` (port from the D72 registry). For a remote harness, it relays CDP over its authenticated device connection. The SPA webview is never a CDP target. | D74 requires loopback plus a token. The in-process API avoids an open DevTools port, which CEF itself calls "reachable by every process on the machine … no authentication". A remote agent cannot reach the laptop's loopback. |
| DS10 | **Computer-use permissions go to `CuaDriver.app`, not to the PLUR1BUS app.** The shell only guides the person through granting them (deep links into System Settings, a live status re-check) and shows D62's indicator and kill switch in the tray. | Least privilege: an app that contains a web browser should not hold Accessibility or Screen Recording. `cua-driver` supports this bundle identity directly (§4.7). |
| DS11 | **Egress for a panel is resolved by the harness.** The shell asks for a panel's egress profile and receives a proxy URL (`socks5://127.0.0.1:<port>`) or a refusal. A request context with a proxy is never rebuilt as `direct` when the proxy fails. With a **remote** harness, only profiles the client itself can reach (`direct`, `socks5` to a host reachable from the client) are offered. `wireguard` panels need a local harness. | D73 fails closed. A WireGuard key is not handed to a laptop, and the shell does not run wireproxy (no second supervisor). |
| DS12 | **Separate update keys per channel** (`dev`, `stable`), held by the owner. Private keys live only in GitHub Environments that require approval, never in the repo. Only the public keys are committed. | A leaked dev key must not be able to push to stable users. Tauri cannot turn signature checks off (§4.4). |
| DS13 | **The desktop app lives in `apps/desktop/`**, with its own Cargo workspace and lockfile, outside the root `crates/*` workspace. | The supervisor's dependency budget (no tokio, spec §4) and the root `cargo test --workspace` stay untouched. Tauri brings its own async stack. |

## 3. Non-goals

- A second policy layer, a local account system, or any cache of harness data outside the webview's memory.
- Running the harness in the app process, or a mobile app (milestones §7).
- macOS x64 (D8 drops it) and Linux musl builds.
- Telemetry. The updater's request to a static manifest is the only automatic network call the shell makes, and it can be turned off.
- Computer use on the laptop driven by a **remote** harness. That needs the D51 node bridge and is not part of track D.
- Imitating other clients. The panel keeps CEF's default user agent. The shell does no fingerprint evasion, and it never offers a claude.ai sign-in (D52).

## 4. Evidence (researched 2026-09-27)

### 4.1 Tauri and the CEF runtime

- **Tauri 2.12.0** is the current stable release (crates.io, 2026-09-26). **Tauri 3.0.0-alpha.3** was published the same day. The 3.x alpha line started on 2026-09-13.
- **`tauri-runtime-cef` 3.0.0-alpha.4** (2026-09-26; alpha.0 on 2026-09-13) is a complete Tauri runtime ("Tauri runtime interface for Chromium Embedded Framework"). It replaces wry and depends on `tauri ^3.0.0-alpha.3` and `cef =152.3.0` (CEF 152.0.6). Nothing exists for Tauri 2.
- From its source (alpha.4):
  - It supports several webviews, each with its own profile (`data_store_identifier`, "giving the same isolation `data_directory` does") and its own proxy (`WebviewAttributes::proxy_url`, applied to that webview's request context).
  - It has a runtime-wide `ProxyConfig` and a WebRTC policy that includes `DisableNonProxiedUdp`.
  - `RemoteDebugging` is `Disabled` by default. The docs say a port "is reachable by every process on the machine, and the protocol has no authentication". A `Pipe` mode exists.
  - Each webview has `send_dev_tools_message` plus a message observer.
  - A `DowngradePolicy` handles rolling back to an older CEF.
- **Sandbox, quoted from `src/sandbox.rs`:**
  - "Windows currently runs unsandboxed, whatever the policy says." Since Chromium M138, the sandbox entry point needs CEF's prebuilt `bootstrap.exe` host, which loads the app as a DLL, and "a Tauri application is built as an executable".
  - Linux deb/rpm install the setuid `chrome-sandbox`. An AppImage cannot (its payload is mounted `nosuid`), so it depends on unprivileged user namespaces, "which Ubuntu 23.10 and later restrict through AppArmor".
  - macOS always keeps the sandbox.
- **`cef-rs`** (`tauri-apps/cef-rs`, Apache-2.0 OR MIT) lists x86_64 and ARM64 on Windows, Linux and macOS. `cef-dll-sys` 154.2.0 ships bindings for `aarch64-pc-windows-msvc`, `aarch64-unknown-linux-gnu`, `aarch64-apple-darwin` and the x64 triples. It also ships the `download-cef`, `export-cef-dir` and `bundle-cef-app` helpers. The `cef` crate reached 154.2.0+154.0.28 on 2026-09-27.
- **What we could not find:** any upstream statement that `tauri-runtime-cef` is tested on Windows arm64. Bindings and CEF binaries exist for it, but runtime evidence does not.

### 4.2 CEF size and update cadence

CEF's build index (`cef-builds.spotifycdn.com/index.json`, read 2026-09-27) shows stable **154.0.28 (Chromium 154.0.8037.58)**, built 2026-09-25/26. Compressed **minimal** distributions: macOS arm64 **132 MB**, Windows x64 **173 MB**, Windows arm64 **169 MB**, Linux x64 **326 MB**, Linux arm64 **424 MB**. D3 measures the installed size after pruning.

Cadence: new majors 147 (2026-04-24), 148 (05-24), 149 (06-16), 150 (07-08), 151 (07-29), 152 (09-05) and 154 (09-22), each with several patch builds. An extended-stable branch, 144, had 26 builds between 2026-01-20 and 2026-09-13. So a new major arrives roughly every 3–4 weeks, and the Rust bindings follow within a day. **Consequence:** shipping CEF is a standing duty to ship security updates (§6.11).

### 4.3 Signing and notarisation

- **macOS.** Distribution needs a *Developer ID Application* certificate ("Only the Apple Developer Account Holder can create" it) and notarisation, which "is required when using a Developer ID Application certificate". Tauri reads `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD` and `APPLE_SIGNING_IDENTITY`. For notarytool it reads either an App Store Connect API key (`APPLE_API_ISSUER`, `APPLE_API_KEY`, `APPLE_API_KEY_PATH`) or an Apple ID. Ad-hoc signing (`signingIdentity: "-"`) is enough for development on Apple Silicon. Hardened runtime is on by default (`bundle.macOS.hardenedRuntime`). The owner holds an Apple Developer account (D8).
- **Windows.**
  - Microsoft (2026-05-06): "EV certificates no longer bypass SmartScreen … Paying a premium for EV solely to avoid SmartScreen warnings is no longer justified." OV and EV build reputation the same way.
  - **Azure Artifact Signing** (formerly Trusted Signing) starts at $9.99/month, needs a paid Azure subscription and issues short-lived certificates. It is available to organisations in the EU, but "**Individual developers must be located in the United States or Canada**" (quickstart, updated 2026-05-21). So it is not open to the owner as an individual in Germany.
  - **SignPath Foundation** signs OSI-licensed projects for free. The certificate is issued to "SignPath Foundation" as publisher. Binaries must be verifiable CI builds from the repository, with author/reviewer/approver roles and MFA. D8 already proposes it.
  - Tauri supports Artifact Signing, Azure Key Vault (relic) and any `signCommand`.
- **Linux.** Tauri builds `.deb`, `.rpm` and AppImage. AppImage can be GPG-signed (`SIGN`, `SIGN_KEY`, `APPIMAGETOOL_SIGN_PASSPHRASE`, `APPIMAGETOOL_FORCE_SIGN`), but "AppImage does not validate the signature". Flatpak is not built by the Tauri bundler: it uses a `flatpak-builder` manifest that repackages the `.deb` on the GNOME runtime, followed by Flathub review (Tauri docs, updated 2026-09-21).

### 4.4 Updater

`tauri-plugin-updater` 2.13.0 (2026-09-26): "needs a signature … This cannot be disabled". The key pair is created with `tauri signer generate`. The public key goes in `plugins.updater.pubkey`, and the private key comes from `TAURI_SIGNING_PRIVATE_KEY` (+ `_PASSWORD`). If the key is lost, "you will NOT be able to publish new updates to the users that have the app already installed". TLS is enforced in production. The manifest is either static JSON or a dynamic endpoint. On Windows, `installMode` is `passive`, `basicUi` or `quiet`.

### 4.5 Security primitives

Tauri 2 capabilities bind permissions to windows and webviews, and a `remote.urls` list opens IPC to remote origins. The docs warn that "on Linux and Android, Tauri is unable to distinguish between requests from an embedded `<iframe>` and the window itself". Capabilities "do not" protect against WebView vulnerabilities or loose scopes. Config offers `app.security.csp`, `freezePrototype`, the isolation pattern, `incognito` and `dragDropEnabled` per window.

### 4.6 Tray, deep links, autostart, shortcuts, keychain

- Plugin releases of 2026-09-26: deep-link 2.5.0, autostart 2.6.0, global-shortcut 2.4.0, notification 2.5.0, single-instance 2.5.0, stronghold 2.4.0.
- **Deep links.**
  - macOS supports static registration only; "Dynamic registration at runtime is not supported".
  - Windows passes the URL as a command-line argument to a new process, so it needs single-instance.
  - Linux uses a `.desktop` file, and moving an AppImage breaks the registration.
  - "The user could trigger a fake deep link manually by including the URL as argument."
- **Autostart** uses a LaunchAgent on macOS (`MacosLauncher::LaunchAgent`).
- **Global shortcuts** come from `global-hotkey` 0.8.0, which is "Linux (X11 Only)". Wayland has no global shortcut without the portal.
- **Keychain.** `keyring` 4.2.0 (2026-08-29) uses native stores: the Apple keychain, Windows Credential Manager, and Linux Secret Service (dbus or zbus) or keyutils. ADR-005's `@napi-rs/keyring` uses the same backends.

### 4.7 Computer use

`cua-driver`'s README says: "install `CuaDriver.app`, grant permissions to it, and start its daemon". Running a raw `cua-driver serve` outside the app "is unsupported: it has no stable bundle identity for TCC attribution". An embedded mode (`EmbeddedCuaDriverHost`) would put the grants on the host app instead. A known issue (NousResearch/hermes-agent #99732, cua-driver 0.20.0 on macOS 27.0) reports grants that read as false after a daemon respawn, even though System Settings shows them on. The workaround is to toggle the grant again. macOS 15 introduced a recurring confirmation for screen recording (monthly since 15.0 final, per 9to5Mac 2024-08-14).

### 4.8 Remote reach

`tailscale serve` needs tailnet HTTPS certificates (Let's Encrypt, `device.tailnet.ts.net`) and proxies to `127.0.0.1:<port>`. It adds `Tailscale-User-Login`/`-Name`/`-Profile-Pic` headers, and the docs advise that a service trusting them should listen only on localhost (KB 1312, validated 2026-01-20).

### 4.9 Accessibility

WKWebView, WebView2 and WebKitGTK expose the SPA through the platform accessibility APIs (NSAccessibility, UIA, AT-SPI). Chromium, and therefore CEF, does the same for the panel. We found no dated source that proves CEF-on-Linux parity with Orca, so D3 verifies it by hand (§6.13).

## 5. Architecture

```
┌──────────────────────────── PLUR1BUS Desktop (Tauri) ─────────────────────────────┐
│ Rust core: connections · keychain (keyring) · harness client (reqwest/rustls)      │
│            tray · updater · single-instance · deep links · [D3] panel manager,     │
│            CDP token proxy / relay · [D4] computer-use onboarding                  │
│                                                                                    │
│  window "shell" (bundled pages)   window "spa" (incognito)      [D3] panel webviews│
│  connection manager, pairing,     https://<harness origin>/     CEF, one profile   │
│  errors · capability shell-ui     capability spa-bridge         per egress profile,│
│                                   (runtime, origin-scoped)      NO IPC, sandbox on │
└──────────────┬──────────────────────────────┬──────────────────────────┬───────────┘
               │ device token (Bearer)        │ session cookie (ticket)  │ proxy_url
               ▼                              ▼                          ▼
        Harness API (M3): /api/v1 · /events SSE · /ws · /       D73 wireproxy / SOCKS5
        authorize() — the only policy layer (ADR-007)            (supervised by the harness)
               │
        local: 127.0.0.1 (run/api.json)   remote: https://host.tailnet.ts.net (tailscale serve → loopback)
```

With Tauri 2 (D1, D2), the `shell` and `spa` windows use the system webview. After the D3 gate, every webview is CEF, so the SPA and the panel share one engine and one update duty.

## 6. Design

### 6.1 Relationship to the daemon

- **Discovery (local).** The shell reads `<state root>/run/api.json` (D5 root: `PLUR1BUS_HOME`, `~/.plur1bus`, `%LOCALAPPDATA%\PLUR1BUS`). The file holds `{ url, pid, instanceId, installationId, apiVersion }` and is written by the harness API server at bind time (`instanceId` changes with every start; `installationId` is stable for the installation). It contains no secret. The shell **never reads `run/*.token`** (those are core/supervisor RPC credentials, ADR-012). A stale file (dead pid, refused connection) counts as "no local harness".
- **Compatibility.** The shell reads `GET /api/v1/meta` (unauthenticated) → `{ apiVersion, installationId, capabilities }` and feature-detects what it needs, following ADR-016 §3 (capabilities, not version sniffing): `desktop.sessionTicket`, later `panel.cdp`, `egress.resolve`, `computerUse`. A different API major is refused with a message naming both versions.
- **No local harness.** D1 shows the one-line installer command from the docs and a *Retry* button. D2 adds *Install here*. That action downloads the `plur1bus` binary for the running target from the release manifest over HTTPS, checks the SHA-256 in the manifest and the OS code signature (macOS `codesign --verify --strict` + Gatekeeper assessment, Windows `WinVerifyTrust`), then runs `plur1bus setup --non-interactive --json` and shows its progress. The shell stores nothing from that run. When setup finishes, discovery applies.
- **Lifecycles are separate.** Quitting the app never stops the harness. Uninstalling the app never removes the harness. The app updates itself (§6.11), and the harness updates through `plur1bus update` (M8). Neither updater touches the other.

### 6.2 Connections and authentication

A **connection** is `{ id (UUIDv7), name, kind: local|remote, origin, installationId, deviceId, tokenHint (last 4) }`. Connections are stored in `connections.json` in the app config directory, written atomically with mode `0600`, and hold no secret. One connection is bound to one harness user. Switching user means switching connection. Before any authenticated call, the shell compares `/meta`'s `installationId` with the stored one. If they differ (a different harness now answers at that address), it sends no token and asks the person to pair again.

**Origin rules:**
- `https://host[:port]`, or `http://127.0.0.1|[::1]|localhost[:port]`.
- No userinfo, path, query or fragment.
- The origin is shown as punycode when it is IDN.
- `http` to any other host is refused (DS6).

**Pairing (D35):**
1. *Local, one click.* The shell runs `plur1bus device pair --json --kind desktop --name "<hostname> desktop"` with fixed arguments. The binary path comes from the known install location, never from input. The CLI authenticates to the core over its local socket, as it does for every command. The shell redeems the returned code at `POST /api/v1/devices/redeem` and receives `{ deviceId, token }`. If the CLI has no local principal that may pair devices (M3 decides this), the shell falls back to flow 2. Pairing trust never comes from "the request arrived on loopback": behind `tailscale serve`, every remote request arrives on loopback too (§4.8).
2. *Code flow.* The person enters the origin and an 8-character code. They get the code from `plur1bus device pair` on the host, or from *My area → Devices* in the SPA on any logged-in device. D2 adds `plur1bus://pair?origin=…&code=…`, which only pre-fills this form (§6.9).
3. The token goes **straight from the HTTP response into the keychain**: service `dev.plur1bus.desktop` (bundle id, owner question), account = connection id. The token is held in memory as a `SecretString` (zeroized on drop, `Debug` prints `***`). The harness stores only a hash (D35).
4. **Revocation.** Any `401 E_AUTH reason=device-revoked` from the harness deletes the keychain entry and returns the shell to the pairing screen for that connection.
5. **Linux without Secret Service.** The token is kept in memory for the session only. A banner explains that the app must be paired again after a restart. There is no plain-text or passphrase fallback in track D (DS4).

**Webview session (DS5).** At every SPA open, the shell calls `POST /api/v1/auth/session-ticket` with `Authorization: Bearer <device token>` and gets `{ ticket, expiresAt }` (single use, 60 s, bound to `deviceId`). It then navigates the incognito `spa` webview to `<origin>/auth/ticket#t=<ticket>`. That page POSTs the ticket to `/api/v1/auth/ticket/redeem`, receives the session cookie (`HttpOnly`, `SameSite=Lax`, `Secure` on TLS, no `Expires`) and the CSRF token, and replaces the URL so the fragment is gone. Everything the SPA does afterwards goes through ADR-004 as for any browser. The **Rust side** uses the device token for its own calls only: `/events` for tray and notifications, ticket issue, and later panel registration.

**Device scopes** (named for M3's scope list): `ui.session`, `events.read`, and from D3 on `panel.serve` (the device may serve CDP for panels to the harness). The harness applies role ∩ scopes. The shell never asks for scopes it does not use.

### 6.3 What the shell adds over the SPA

| Feature | Milestone | Where the logic lives |
|---|---|---|
| Native window, connection manager, local/remote attach, keychain token | D1 | shell |
| Tray/menubar: harness state, open, switch connection, quit | D1 | shell (state from `/events`) |
| Signed self-update (dev channel D1, stable D2) | D1/D2 | shell |
| Native notifications for harness events (approval needed, run finished, degraded) | D2 | harness decides what is notified. The shell shows it with minimal lock-screen text ("Bernd needs approval"); a preview is an opt-in setting |
| Global shortcut, push-to-talk (D45/D44) | D2 | shell sends `ptt:down/up` to the SPA. The SPA's existing recorder captures audio, and the microphone permission is granted only to the harness origin |
| Drag-and-drop files to attachments (D47) | D1 | **no shell code**: `dragDropEnabled: false` on the `spa` window, so the SPA gets HTML5 drop events and handles them as in a browser, `.mcpb` → D46 import included |
| Deep links `plur1bus://pair`, `plur1bus://open` | D2 | shell (validation, §6.9) |
| Autostart (opt-in, off by default) | D2 | shell |
| "Install here" (§6.1) | D2 | the §6.5 installer |
| CEF side panel: collapse, detach, re-attach; per-panel egress (D73) | D3 | shell renders it; the harness resolves egress |
| CDP token proxy (local) / relay (remote) for the `browser` skill | D3 | shell transports it; the harness authorizes and approves |
| WebMCP consumer bridge for panel pages (D55 b) | D4 | shell collects the tools; the harness bridge applies the allowlist and D30 approval |
| Computer-use onboarding (macOS Accessibility and Screen Recording, Wayland portal) + indicator and kill switch | D4 | shell guides; `cua-driver` and the harness act |

### 6.4 The CEF panel (D3)

- **Layout.** The panel is a second webview in the main window: a right-hand side panel that can be resized and collapsed, and detached into its own window. Re-attaching moves the same webview back, so its state is kept. The panel's tab strip, address bar and handover banner are drawn by the SPA as ordinary DOM. The SPA calls `shell_panel_*` commands (DS7) to open, navigate, resize, detach and attach. The page content itself is never in the SPA's DOM.
- **Profiles.** Each panel gets `data_store_identifier = panel-<egressProfileId>`, so every egress profile has its own cookie jar and cache. Logins made through one egress path never appear on another. A panel can be marked *ephemeral*; its profile is then deleted when it closes.
- **Egress (DS11).**
  1. The shell calls `POST /api/v1/egress/resolve { profile, for: "panel" }` → `{ proxyUrl }`, or `E_NOT_AVAILABLE reason=tunnel-down|not-client-reachable`.
  2. `proxyUrl` goes into `WebviewAttributes::proxy_url`. For `socks5://`, Chromium sends host names to the proxy, so DNS does not bypass the tunnel.
  3. As long as any non-direct panel profile exists, the runtime-wide WebRTC policy is `DisableNonProxiedUdp`.
  4. A proxy that dies makes requests fail. The shell shows the tunnel state from `/events` and never rebuilds the context as `direct`.
- **Schemes.** A panel may load only `https:` and `http:` (never `file:`, `chrome:`, `devtools:`, `data:` at top level, `plur1bus:`, `ipc:` or `tauri:`). Downloads go to a per-profile quarantine directory. Keeping or opening a download needs a harness approval when an agent started it, and a click when the person did.
- **Support window.** The panel refuses to load pages when its CEF is more than **60 days** behind the newest stable major on the update feed, and says why. This is enforced by the shell from its release metadata, with no network probe. The SPA keeps working.
- **Where there is no panel (DS8)** (Windows, restricted AppImage, D1/D2 on any OS), the SPA shows the harness's streamed Chromium (D74 b) in the same place. The `browser` skill works against either one.

### 6.5 CDP token proxy and the `browser` skill (D3)

- **Transport.** The shell opens a CDP session per panel with `send_dev_tools_message` plus an observer. The DevTools server stays disabled.
- **Local harness.** A WebSocket server on `127.0.0.1:<port>` (port leased from the D72 registry through `ports.lease`). Path `/cdp/<panelId>`. The client authenticates with a 32-byte random token in `Authorization: Bearer`. A request with an `Origin` header, or with a `Host` other than `127.0.0.1:<port>`, is rejected (no browser page, no DNS rebinding). The token and port go to the harness over the device connection (`panel.register`). They are never written to a file.
- **Remote harness.** The harness sends CDP frames over the shell's authenticated `/ws` connection (dialled outward, like the D51 node bridge). The shell forwards them to the named panel.
- **Filter (both paths).** Only panel targets are reachable. A method allow-list by domain applies:
  - allowed: `Page`, `DOM`, `Accessibility`, `Runtime`, `Input`, `Network` read and `Emulation` subset;
  - denied: `Browser`, `Target`, `SystemInfo`, `Storage`, `Tracing`, `IO`, `Network.getAllCookies`, and `Page.setInterceptFileChooserDialog` unless the harness attached an approval;
  - events outside the panel's session are dropped.
- **Visibility.** While an agent drives a panel, the panel shows a persistent "Agent is using this panel" bar with *Take over* and *Stop*. *Stop* closes the CDP session at once.
- **Skill.** The `browser` skill (harness side, D74) calls a handover when it meets a login or a CAPTCHA. The shell then pauses the CDP session and gives the panel to the person until they press *Done*. Credentials the person types stay in the panel profile. Page text reaches agents only as tool output, sanitised and marked untrusted (D55, D62 rule: page content is data, never instructions).

### 6.6 Computer-use onboarding (D4)

This shows only when the harness is local and D62 is enabled for at least one agent.

- **macOS.**
  1. Check that `CuaDriver.app` is installed (link to its upstream installer otherwise).
  2. Read the grant state from the driver's diagnose command.
  3. Explain the two grants in plain language.
  4. Open *Privacy & Security → Accessibility* and then *→ Screen & System Audio Recording* through `x-apple.systempreferences:` links.
  5. Re-check every 2 s while the window is focused.
  6. Name the known flapping issue (§4.7) with the re-toggle fix.
- **Windows.** UI Automation needs no grant. The screen shows only D62's safety summary.
- **Linux.** Wayland asks for consent through the desktop portal when a session starts. The shell explains the prompt before it appears. X11 needs no grant.
- **Every OS.** While a computer-use session runs, the tray icon changes and the menu offers *Stop computer use*, which calls the harness's kill switch. The PLUR1BUS app itself never requests either grant (DS10).

### 6.7 WebMCP (D55)

- **Provider direction.** The SPA registers its own tools when the webview offers `document.modelContext`. That behaviour belongs to the SPA and is unchanged in the shell. System webviews do not offer it today, so this adds nothing in D1/D2.
- **Consumer direction (D4, panel only).**
  1. If the embedded Chromium exposes WebMCP natively, the shell reads page tools over the panel's CDP session.
  2. Otherwise, it installs a small main-world shim with `Page.addScriptToEvaluateOnNewDocument`. The shim defines `document.modelContext.registerTool` and reports registrations through a `Runtime.addBinding` binding, so the panel gets no Tauri IPC.
  3. Descriptors go through `pageToolsToMcp(origin, tools)` (`@plur1bus/webmcp`: names limited to `[A-Za-z0-9_.-]` and 128 characters, always `untrustedContentHint`), then to the harness browser bridge. The bridge applies `isOriginAllowed` and the D30 approval to every call.
  4. `execute` results pass through `normalizePageToolResult`.
  5. A hostile page can call the binding with anything. Each payload is capped at 64 KiB, and a page may register at most 64 tools.

### 6.8 Native integration details (D2)

- **Tray.** On Linux the tray needs an AppIndicator host (GNOME: extension). When none is found, the app keeps its window in the taskbar and says so once.
- **Global shortcut and push-to-talk.** No default binding: the person chooses one. On Wayland there is no global shortcut (§4.6). Push-to-talk then works while the window is focused, plus a tray item. The GlobalShortcuts portal is a later option.
- **Microphone.** The macOS Info.plist carries `NSMicrophoneUsageDescription`. Webview media requests are granted only for the connection's origin.
- **Autostart** starts the app minimised to the tray. It never starts the harness.

### 6.9 Security model

- **Trust zones.**
  - The Rust core is trusted.
  - The bundled shell pages are trusted code with no remote content.
  - The SPA is trusted for its own origin, because it is served by the harness the person paired.
  - Panel pages are **hostile**.
  - Deep links and anything on the command line are **untrusted input**.
- **IPC allow-list (DS7).**
  - `shell-ui` → `connections_list|add|remove|rename`, `pair_local`, `pair_code`, `open_connection`, `app_info`, `update_check|install`.
  - `spa-bridge` (runtime `add_capability`, `remote.urls = [<exact origin>/*]`, `webviews: ["spa"]`) → `shell_info`; in D2 `shell_notify_prefs`, `shell_ptt_bind`; in D3 `shell_panel_open|navigate|close|detach|attach|resize|handover_done`.
  - Every command checks, again, the calling webview's label and current top-level origin (defence in depth for the Linux iframe caveat, §4.5), and validates its input against a closed serde struct (`deny_unknown_fields`).
- **Navigation.** The `spa` webview may navigate only within its origin. Other links open in the system browser (D3: optionally in the panel). `window.open` of foreign origins is blocked.
- **CSP.**
  - Shell pages: `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src ipc: http://ipc.localhost; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`.
  - The SPA's CSP is the harness's (ADR-004, nonce-based, `frame-ancestors 'none'`).
- **No Node, no plugins with ambient power.** Tauri has no Node runtime. The app does not include `tauri-plugin-shell`, `-fs` or `-http` at all. The single subprocess (`plur1bus device pair` / `setup`) is spawned from Rust with fixed arguments.
- **Remote content isolation.** Panels have no IPC, no CDP towards the SPA, their own profiles, and no access to the device token or the session cookie. No shell code parses page text for commands. Page-originated strings shown in native UI (window titles, notification text) are truncated and shown as plain text only.
- **Deep links.**
  - `plur1bus://pair?origin&code` pre-fills the pairing form. The person must confirm with the origin displayed prominently. It never replaces an existing connection and never pairs on its own.
  - `plur1bus://open?path=` accepts only a relative path matching the SPA route allow-list, on the active connection.
  - Everything else is ignored and logged without its arguments.
  - Links arriving through the command line are treated the same way.
- **Updater (§6.11)** signatures are always checked, with one key per channel (DS12).
- **Logs.** App log directory, size-rotated. Tokens, tickets, cookies, `Authorization` headers and every URL's query and fragment are redacted by a single formatter with a test. Page content and page URLs from panels are never logged.
- **OS sandboxing.**
  - *macOS:* hardened runtime and notarisation. **No App Sandbox**: local pairing and "Install here" run `plur1bus`, and CEF under the App Sandbox is not supported by the runtime. CEF helpers carry only the entitlements Chromium needs for JIT. No `disable-library-validation`.
  - *Windows:* per-user NSIS install without admin (`installMode: currentUser`). WebView2's own renderer sandbox. No CEF panel until its sandbox works (DS8). MSIX/AppContainer is not planned.
  - *Linux:* deb/rpm install `chrome-sandbox` setuid (D3). AppImage gets the panel only when the runtime finds a working sandbox. Flatpak is an open question (§11).

### 6.10 Packaging per target (D8)

| Target | D1/D2 (Tauri 2, system webview) | D3+ (CEF runtime) |
|---|---|---|
| macOS arm64 | `.app` in `.dmg`; WKWebView | CEF framework + helpers in the bundle, sandboxed; panel on |
| Windows x64 | NSIS per-user `.exe`; WebView2 Evergreen (present on Windows 11; the installer bootstraps it elsewhere) | CEF payload beside the exe; **unsandboxed upstream → panel off, streamed Chromium** until `bootstrap.exe` hosting lands |
| Windows arm64 | NSIS `.exe` (aarch64-pc-windows-msvc); WebView2 arm64 | as x64. Bindings and CEF binaries exist, but there is no upstream runtime evidence → **best-effort**, built and smoke-tested on `windows-11-arm` |
| Linux x64 | `.deb`, `.rpm`, AppImage; WebKitGTK 4.1; tray needs AppIndicator; global shortcut X11 only | deb/rpm: sandbox via setuid helper, panel on. AppImage: panel only with working userns (off on Ubuntu ≥ 23.10 by default). Flatpak: owner question |
| Linux arm64 | same as x64; built bare-metal on `ubuntu-24.04-arm` (never in Docker, milestones §5.2) | same as x64; largest CEF payload (§4.2) |

The bundle identifier, URL scheme and product name are owner decisions (§11). Placeholders: `dev.plur1bus.desktop`, `plur1bus`, "PLUR1BUS".

### 6.11 Updates

- **Channels.** `dev` (D1: OS-unsigned builds, macOS ad-hoc) and `stable` (D2: OS-signed). The feed is a static JSON manifest attached to a GitHub release: a prerelease tag `desktop-dev` for dev, the latest `desktop-v*` for stable. Each channel has its own compiled-in public key (DS12). The key is chosen from the build's channel and never switched at run time.
- **Checks.** At start (with an off switch) and on demand. No identifiers are sent. An update is offered only when its version is higher than the running one.
- **Key custody.** The owner generates both keys offline, keeps them in a password manager, and stores them in the GitHub Environments `desktop-dev` and `desktop-release` (required reviewer: the owner). Rotation ships a release, signed with the old key, whose config carries the new public key. The key-loss procedure is documented in `docs/desktop.md`: users must reinstall once.
- **CEF duty (D3+).** A Chromium security fix in the stable channel is shipped within **14 days** of the matching `cef` crate release. The panel's 60-day support window (§6.4) is the fail-safe.

### 6.12 CI, secrets, reproducibility

- **Workflows.**
  - `desktop.yml`: path filter `apps/desktop/**` plus nightly. Matrix `macos-15` (aarch64-apple-darwin), `windows-2025` (x86_64-pc-windows-msvc), `windows-11-arm` (aarch64-pc-windows-msvc), `ubuntu-24.04`, `ubuntu-24.04-arm`. Steps: fmt, clippy `-D warnings`, `cargo test --locked`, the TS tests of the shell pages, unsigned bundles as artefacts.
  - `desktop-release.yml`: tag `desktop-v*` or `desktop-dev` dispatch. Signing jobs run only in the approved Environment.
  - The **canary** job (nightly, from D1): build against Tauri 3 alpha + `tauri-runtime-cef` on all five targets. It is allowed to fail and is reported in the D-milestone test report.
- **Secrets are owner-held, never in the repo.** Only the release workflow sees `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_API_ISSUER`, `APPLE_API_KEY` and the `.p8` content, `TAURI_SIGNING_PRIVATE_KEY[_PASSWORD]` per channel, the Windows signing credentials (SignPath API token, or an OIDC federated identity where the chosen service supports it) and the Linux GPG key. Pull requests from forks run `pull_request` (never `pull_request_target`) and get no secret. Actions are pinned by commit SHA. `scripts/lint-hygiene.mjs` gains a check that fails when `*.p12`, `*.p8`, `*.key`, `*.pem`, `*.keystore` or a minisign secret-key header is tracked.
- **Reproducibility.**
  - Inputs are pinned: `rust-toolchain.toml`, `cargo --locked`, `pnpm --frozen-lockfile`, and in D3 the CEF version plus the SHA-1 from CEF's index and our own recorded SHA-256.
  - Build settings: `SOURCE_DATE_EPOCH` = commit time, `--remap-path-prefix`.
  - Outputs: a CycloneDX SBOM per target and GitHub build-provenance attestations for every artefact.
  - A nightly job builds the unsigned Linux x64 bundle twice and compares hashes. It is advisory until it has been stable for 14 days, then a gate. Signed artefacts are not expected to be bit-identical (signatures and notarisation tickets).

### 6.13 Accessibility

- Shell pages meet the M3 bar: axe-core WCAG 2.1 AA clean, full keyboard use, visible focus, 4.5:1 contrast in both themes, de/en. They use the M3 theme file as their only token source (ADR-004: "No second copy anywhere").
- Tray menus are native menus, so screen readers read them.
- Every shell action is reachable from the keyboard, and the global shortcut is optional.
- Each D milestone's test report includes a manual screen-reader pass: VoiceOver (macOS), NVDA (Windows) and Orca (Linux) over pairing, opening the SPA, and in D3 the panel's focus handoff (SPA ↔ panel with F6, which the shell implements) and the handover banner.

### 6.14 Harness API additions the shell needs

They all sit behind `authorize()`, and all are documented in `docs/api-surface.md` (ADR-004 action 2).

| Addition | Milestone | Notes |
|---|---|---|
| `run/api.json` discovery file | D1 (or M3) | `{ url, pid, instanceId, installationId, apiVersion }`, mode 0600, removed on clean stop |
| Device kind `desktop` + scopes `ui.session`, `events.read` | D1 (or M3) | D35 pairing, redeem |
| `POST /api/v1/auth/session-ticket`, `POST /api/v1/auth/ticket/redeem`, page `/auth/ticket` | D1 | single use, 60 s, device-bound, never logged; capability `desktop.sessionTicket` |
| `GET /api/v1/meta` with `installationId` and capabilities | M3 (field added in D1 if missing) | ADR-016 §3 |
| `/events` usable with a device bearer token | D1 (or M3) | tray state |
| `egress.resolve`, `ports.lease`, `panel.register`, CDP relay over `/ws`, scope `panel.serve` | D3 | D72, D73, D74 |
| Computer-use status and kill switch over the API | D4 | D62 |

## 7. Milestones (track D)

Track D starts after **M3 is approved**. It runs next to M4–M8, is off the critical path, and does not gate v0.1.0. The milestones §7 row "Desktop shell … out of scope" becomes "not required for v0.1.0; optional track D (ADR-004 amendment)".

| M | Content | Depends on | Effort (ad) |
|---|---|---|---|
| **D1 — Thin shell** | Tauri 2.12 app; SPA in an incognito webview from the harness origin; attach local (one-click pairing) or remote (code); keychain token; ticket login; tray with harness state; single-instance; updater on the `dev` channel with OS-unsigned builds; five-target CI; §6.14 D1 rows | M3 (API, device pairing) | 8–12 |
| D2 — Native integration + signed stable | notifications, global shortcut + push-to-talk, deep links, autostart, "Install here", macOS Developer ID + notarisation, Windows signing (owner's choice), Linux GPG, `stable` channel | D1; §6.5 installer (H3b-b-1); M2/M3 voice UI for push-to-talk | 6–9 |
| D3 — CEF panel + egress | gate → Tauri 3 + `tauri-runtime-cef`; panel collapse/detach/attach; per-profile request contexts; egress resolve (fail closed); CDP token proxy + remote relay; `browser` skill handover; sandbox gating (DS8); CEF update duty | D2; Tauri 3 gate; D72 port registry; D73 egress; D74 b streamed Chromium in the harness | 10–16 |
| D4 — Computer use + WebMCP bridge | macOS/Wayland onboarding, tray indicator + kill switch; WebMCP consumer in panels; Flatpak if the owner says yes | D3; D62 skill; harness browser bridge (D37/D55) | 6–10 |

## 8. Acceptance criteria for D1 (each is a test or a recorded manual check)

1. With a local harness running, **one-click pairing** opens the SPA logged in as the CLI's user. Afterwards the app's data and config directories contain no byte sequence equal to the token (test scans them). The keychain entry exists.
2. **Remote pairing** with `https://<host>` and a code yields the same result. An `http://` origin that is not loopback is refused before any request is sent.
3. After `plur1bus device revoke`, the next shell request returns the app to the pairing screen and the keychain entry is gone.
4. The SPA webview can invoke `shell_info` and nothing else. Calls from another origin, from a navigated-away page, or to any other command are rejected. A link to another origin opens in the system browser.
5. After quitting and restarting, the SPA is logged in again through a fresh ticket without re-pairing, and no session cookie survived on disk. A ticket is refused on second use and after 60 s.
6. A **tampered update** (payload or signature) is refused. A correctly signed `dev` update installs and restarts: automated on Linux and Windows, a recorded manual check on macOS.
7. `desktop.yml` builds and tests on all five targets. The Tauri 3 canary result is reported.
8. The shell pages pass axe-core WCAG 2.1 AA and full keyboard traversal. The screen-reader pass is recorded.
9. The log-redaction test passes: a planted token, ticket, cookie and URL fragment never reach the log file.

## 9. Data flow examples

- **Local first run.** App start → `run/api.json` found → `GET /meta` ok → *Pair* → `plur1bus device pair --json` → code → `POST /devices/redeem` → token → keychain → `POST /auth/session-ticket` → webview `/auth/ticket#t=…` → SPA logged in → the Rust side subscribes to `/events` → the tray turns green.
- **VPS.** On the VPS: `tailscale serve` → `https://vps.tailnet.ts.net` → loopback harness API. `plur1bus device pair` on the VPS (over SSH) prints a code. In the app: *Add remote* → origin + code → the same redeem/ticket path. Nothing crosses the internet outside the tailnet. No vendor relay (D35).
- **Agent drives the panel (D3, local).** Skill → harness `panel.cdp` → token proxy `127.0.0.1:<leased port>/cdp/<id>` → method filter → `send_dev_tools_message` → the page. The panel bar shows "Agent is using this panel". The person presses *Stop* → the session closes.

## 10. Risks

| Risk | Effect | Mitigation |
|---|---|---|
| Tauri 3 / `tauri-runtime-cef` stays alpha for long | D3 slips | D1/D2 ship on Tauri 2. The streamed Chromium (D74 b) covers the panel everywhere in the meantime. The canary makes the gap visible early |
| Windows CEF sandbox never lands in the runtime | no native panel on Windows | DS8 fallback is permanent. Re-evaluate at each Tauri 3 release |
| CEF update duty (≈ every 3–4 weeks) | security debt if releases lag | 14-day rule, 60-day panel shutoff, the canary keeps the pipeline warm |
| Linux webview variance (WebKitGTK) in D1 | SPA rendering bugs only on Linux | SPA supports current WebKitGTK as a tested browser. D3 moves Linux to Chromium |
| Keychain unavailable on minimal Linux desktops | re-pair after every restart | clear banner. The SPA in a normal browser remains available |
| TCC flapping with `cua-driver` on macOS 27 | computer use silently stops | status re-check and named re-toggle guidance (§6.6). Upstream issue tracked |
| Deep-link phishing (pair to an attacker's harness) | person uses a hostile SPA | confirmation screen with the origin, never auto-pair, never replace a connection |

## 11. Open questions for the owner

1. **Signing accounts.** macOS: use your Developer ID with an App Store Connect API key for notarytool in the `desktop-release` environment? Windows: **SignPath Foundation** (free; publisher shows "SignPath Foundation"; matches D8), or an **OV certificate on a cloud HSM** (your name as publisher; yearly cost)? Azure Artifact Signing is closed to individuals outside the US and Canada.
2. **Bundle identifier and URL scheme.** `dev.plur1bus.desktop` and `plur1bus://`, or other names? Reverse-DNS assumes you control `plur1bus.dev`. The identifier also names the keychain service and cannot change after the first stable release without re-pairing.
3. **Linux Flatpak.** Ship it via Flathub (review, a repackaged `.deb` on the GNOME runtime; the CEF sandbox inside Flatpak needs extra work in D3+), or only `.deb`, `.rpm` and AppImage?
4. **Windows CEF gap.** Is it acceptable that on Windows x64 and arm64 the panel is the streamed Chromium until `tauri-runtime-cef` supports Chromium's sandbox, and that Windows arm64 is best-effort for the CEF runtime?

## 12. Sources (all read 2026-09-27)

- crates.io API: `tauri`, `tauri-runtime-cef`, `cef`, `cef-dll-sys`, `tauri-plugin-{updater,deep-link,autostart,global-shortcut,notification,single-instance,stronghold}`, `keyring`, `global-hotkey` — https://crates.io/api/v1/crates/<name>. Crate sources read: `tauri-runtime-cef-3.0.0-alpha.4` (`CHANGELOG.md`, `src/runtime.rs`, `src/sandbox.rs`, `src/devtools.rs`, `src/webview.rs`), `cef-dll-sys-154.2.0+154.0.28` (`build.rs`, `src/bindings/`).
- tauri-apps/cef-rs — https://github.com/tauri-apps/cef-rs · releases — https://github.com/tauri-apps/cef-rs/releases
- tauri-runtime-cef v3.0.0-alpha.4 release — https://github.com/tauri-apps/tauri/releases/tag/tauri-runtime-cef-v3.0.0-alpha.4
- CEF builds index — https://cef-builds.spotifycdn.com/index.json
- Tauri docs: updater https://v2.tauri.app/plugin/updater/ · capabilities https://v2.tauri.app/security/capabilities/ · macOS signing https://v2.tauri.app/distribute/sign/macos/ · Windows signing https://v2.tauri.app/distribute/sign/windows/ · Linux signing https://v2.tauri.app/distribute/sign/linux/ · Flatpak https://v2.tauri.app/distribute/flatpak/ · deep linking https://v2.tauri.app/plugin/deep-linking/ · autostart https://v2.tauri.app/plugin/autostart/ · config https://v2.tauri.app/reference/config/
- Microsoft: SmartScreen reputation (2026-05-06) https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation · Artifact Signing FAQ (2026-08-14) https://learn.microsoft.com/en-us/azure/artifact-signing/faq · quickstart (2026-05-21) https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart
- SignPath Foundation terms — https://signpath.org/terms.html
- cua-driver README — https://github.com/trycua/cua/blob/main/libs/cua-driver/README.md · TCC issue — https://github.com/NousResearch/hermes-agent/issues/99732
- macOS Sequoia screen-recording prompt — https://9to5mac.com/2024/08/14/macos-sequoia-screen-recording-prompt-monthly/
- Tailscale Serve (KB 1312, 2026-01-20) — https://tailscale.com/kb/1312/serve
