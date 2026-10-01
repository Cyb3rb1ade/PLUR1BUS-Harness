# Desktop app shell: handoff to Codex

**Status:** Handoff brief · **Date:** 2026-09-30 · **Owner:** Christian (Cyb3rb1ade) · **Written by:** Claude,
for OpenAI Codex · **Start prompt:** `docs/handoff/codex-start-prompt.md`.

**Binding sources.** Read these; the ones marked *in full* must be read end to end.

- `docs/superpowers/specs/2026-09-27-desktop-app-design.md` — *in full*: DS1–DS39, §4, §6, §7, §8, §13.
- `docs/superpowers/plans/2026-09-27-desktop-app-d1.md` — *in full*: 20 tasks, DR1–DR26, Review Focus 1–7.
- Core spec `2026-09-24-m1b-2a-core-daemon-cli-design.md`, rows D35, D74, D77, D78 and §6.5.
- Basics spec `2026-09-28-basics-quality-bar-design.md`, rows D98, D101, D106–D108.
- **D109** (draft): read it with
  `git show origin/docs/d109-permissions:docs/superpowers/specs/2026-09-28-basics-quality-bar-design.md`,
  section "D109".
- `docs/milestones.md`, track D.
- ADR-004 (both amendments), ADR-005 "Secret storage", ADR-007 "Enforcement" and "Authentication", ADR-012 §11,
  ADR-016 §3.
- `AGENTS.md`.

Every "§" below without a file name means the desktop spec.

---

## 1. Purpose, scope, non-goals

**Purpose.** Build the rough frame of the PLUR1BUS desktop app and every function that belongs to the frame
itself. The frame must run on five targets:

- macOS arm64;
- Windows x64 and arm64;
- Linux x64 and arm64.

The frame's job:

- detect a container runtime and control the harness container through it;
- pair with a harness and keep the device token in the OS keychain;
- open the harness's own web UI (the SPA) in a native window, already logged in;
- show state in the tray;
- update itself safely.

The harness features that live behind this frame are built by others: the HTTP API (M3), container mode and the
image (D1 plan Tasks 2–4), host tools, the browser panel, and computer use.

**What "shell" means here.** The shell is the Tauri app in `apps/desktop/`:

- its Rust core;
- its bundled static pages;
- the helper process frame;
- its packaging and CI.

It is two things and nothing more (§1):

- a **runtime controller** for the harness containers;
- a **client** of the harness API, with no policy layer of its own. It may hide or refuse things. It never
  grants anything the harness has not granted (ADR-004 amendment, ADR-007).

**In scope:**

| Area | Spec anchors |
|---|---|
| Tauri app skeleton in `apps/desktop`; the `shell` and `spa` windows and their lifecycle; single instance; tray / menu bar | DS2, DS7, DS13, §5, §6.3, §6.8, DR9, DR10 |
| Autostart at login and the installer checkboxes | §6.8, D101 |
| Deep links and the `plur1bus://` scheme (frame and validation); `.p1x` file-association hook | §6.9 "Deep links", DS33, milestones D1/X3 rows |
| Shell pages: first-run wizard frame, Connections, Settings (Runtime, Updates, Version, Advanced, Computer access), update dialog, progress, error | §6.15.10, §6.16.3, §13.6, DR6, DR26, D107 "Permissions page" |
| Runtime detection (Apple `container`, Docker-compatible) and the container controller: start, stop, status, logs, restart watch | DS14, DS16, DS19, §6.15.1–§6.15.7 |
| Keychain secrets; connections; pairing flows (bundled over `exec`, native one-click, remote code); the SPA window with ticket login | DS3–DS6, §6.1, §6.2 |
| Host-bridge client skeleton, with `host.keyUnlock` as its only capability; the D107 `PLUR1BUS Host` helper **frame with no capabilities**; frames for the permissions page and the approvals inbox | DS17, §6.15.4, D107, D109 |
| The updater (signed feed, channels, dialog, Tauri updater) and the D78 upgrade and rollback state machine | DS12, DS21, DS24, DS28, §6.11, §6.15.8, §6.16 |
| Logging with redaction, crash handling, i18n (de/en) | §6.9 "Logs", §6.13 |
| Theming (light/dark), the responsive rules, accessibility | §6.13, §13.1, §13.7 |
| Packaging per OS, signing hooks, CI | §6.10, §6.12, §6.15.10, DS30–DS34, DS39 |

**Out of scope** (do not build; placeholders only where named):

- the harness API server, users, device pairing, tickets and `/events` on the server side (M3 and D1 Task 2).
  You build a **mock** of them (WP2);
- harness container mode (`plur1bus init`, `state snapshot|verify|restore`, `admin.smoke`, the `1staid` rows),
  the real harness image, `compose.yaml` and quadlet (D1 Tasks 3–4);
- the host CLI forwarder inside `crates/plur1bus` (D1 Task 10). You only write `target.json` and install the
  shim file;
- host tools D106, the D107 ecosystem capabilities (Shortcuts, AppleScript, EventKit, COM, D-Bus and so on),
  computer use (D62, D4), and remote desktop control (D108);
- the browser container, the CEF or WebView2 panel and the CDP proxy (D3). The only exception is a disabled
  *Sidecars & Folders* nav entry, which D1 hides (DR26);
- WebMCP (D55);
- the D78 release gate (`release.yml`, `release-promote.yml`, notes lint, upgrade fixtures). That is release
  engineering on the real image; Claude takes it over after review;
- OS signing credentials, Partner Center submission and Flathub submission. These are owner actions; you build
  the hooks.

**D1 plan tasks, classified for you:**

| Task | For Codex | Reason |
|---|---|---|
| 1 Scaffold `apps/desktop` | **in** (WP1) | pure shell |
| 2 Harness API side | **out**; mocked in WP2 | harness feature (M3 surface) |
| 3 Harness container mode | **out**; mocked in WP2's stub image | harness binary and core |
| 4 Harness image, compose, quadlet | **out**; a *stub* image for tests is in (WP2) | harness artefact |
| 5 Apple `container` spike and adapter | **partial** (WP7): adapter, fake CLI, contract suite | the spike needs macOS 26 on Apple silicon (owner's Mac). Fixtures stay "synthetic" until recorded |
| 6 Docker adapter and detection | **in** (WP7) | shell |
| 7 Runtime controller | **in** (WP8) | shell; placeholder digests plus the stub image |
| 8 Connections and token store | **in** (WP4) | shell |
| 9 Harness client and pairing | **in** (WP4 remote/native, WP8 bundled) | shell, against the mock |
| 10 Host CLI forwarding | **out** (root crate); `target.json` writer and shim copy are **in** (WP13) | the forwarder is harness code |
| 11 Host bridge with `host.keyUnlock` | **in** (WP9), plus the D107 helper frame | shell side of DS17 |
| 12 Shell pages | **in** (WP3 frame, pages in WP4, WP8, WP10, WP11) | shell |
| 13 SPA window | **in** (WP5) | shell |
| 14 Tray, single instance, lifecycle | **in** (WP6) | shell |
| 15 Redaction, feed, dialog logic, updater | **partial**: redaction in WP6, feed and updater in WP10 | release keys are placeholders |
| 16 Harness upgrade state machine | **in** (WP11), against fakes and the stub image | the state machine is shell; the commands it calls are harness (mocked) |
| 17 Installers, runtime install help, uninstall | **partial** (WP13) | mechanism and configuration yes; the real Apple pkg, vendor checksums and the offline image tarball are placeholders |
| 18 CI | **partial** (WP1, WP14): `desktop.yml`, container e2e on the stub image, `apple-container.yml` scaffold, canary | release gate and promotion are out |
| 19 Accessibility and i18n pass | **in** (WP3 base, WP15 pass) | shell |
| 20 Docs, ADRs, test report | **partial** (WP15): `docs/desktop.md` shell parts, an `AGENTS.md` section, the status report | ADR implementation notes are Claude's after review |

---

## 2. Repo facts

### 2.1 Layout (today, `origin/main` @ `9297ba1`)

| Path | What |
|---|---|
| `crates/plur1bus` | Rust CLI and supervisor (binary `plur1bus`). Relevant here: `daemon status --json`, `1staid check --json`, `update --check` (reads the signed `https://updates.plur1bus.app/{channel}.json`, see §6.5), and `crate::container::container_mode()`, which already refuses `setup` and `update` with `E_NOT_AVAILABLE reason=container-managed`. |
| `crates/plur1bus-{rpc,config,ext}` | libraries. **The desktop app never links root-workspace crates** (DR14). |
| `crates/plur1bus/schema/release-manifest.schema.json` | how the harness reads `{channel}.json`: an open top level with `version`, `channel`, `minFromVersion` and an optional `native`. The desktop's `release.json` fields must stay compatible with it (§6.5). |
| `packages/*` | TypeScript core, schemas, module API, webmcp. **No HTTP API package exists; M3 has not started.** |
| `scripts/lint-hygiene.mjs` | scans `packages crates tests scripts`. WP1 adds `apps` to `ROOTS`, plus the tracked-secret-file check (D1 plan Task 1). |
| `.github/workflows/` | `ci.yml` (jobs `unit`, `system`, `service`), `nightly.yml`, `harness-release.yml` (uses repository variables `PLUR1BUS_RELEASE_PUBKEY_STABLE` and `_BETA`, the minisign keys of the feed) |
| `docs/superpowers/{specs,plans}` | specs and plans; `docs/adr/` holds the ADRs |
| `apps/` | **does not exist yet.** You create `apps/desktop/`. |

**Target layout** (this adjusts DR5, DR13 and the plan's file list in one respect: one desktop Cargo workspace
at `apps/desktop/`, so the mock and the helper share the lockfile):

```
apps/desktop/
  Cargo.toml, Cargo.lock        own workspace: members src-tauri, host-helper, mock-harness, test-bins
  package.json                  @plur1bus/desktop (tauri CLI, scripts)
  src-tauri/                    the app crate (plur1bus-desktop)
    tauri.conf.json, build.rs, capabilities/shell-ui.json, icons/, keys/{dev,beta,stable}.pub (placeholders)
    src/{main,lib,ids,commands,policy,spa,tray,events,logging,crash,deeplink,settings}.rs
    src/runtime/{mod,spec,detect,apple,docker}.rs
    src/controller/{mod,bundle,acquire,lifecycle,watch,autostart,upgrade,journal}.rs
    src/{connections,secrets,client,pair,discovery,bridge,helper,updates}.rs
    src/install/{apple_pkg,vendor_installer,podman_socket,target_json,cli_shim,shortcuts}.rs
    tests/*.rs, tests/fixtures/{apple,docker,feeds,origin-cases.json}
    windows/nsis/installer.nsi (custom template, D101), linux/, macos/
  host-helper/                  plur1bus-host: the D107 helper frame (stdio JSON lines, no capabilities)
  mock-harness/                 plur1bus-mock-harness: the provisional M3 contract (lib + bin), §6
  test-bins/                    fake-container (Apple CLI replay), fake-plur1bus (exec surface)
  stub-image/                   Dockerfile + build script for the test-only stub harness image
  ui/                           @plur1bus/desktop-ui: static shell pages (TS, esbuild, no framework)
  bundle/                       bundle.json.tmpl, release.schema.json
  flatpak/app.plur1bus.desktop.yml
  scripts/                      record-apple-fixtures.mjs, apple-e2e.mjs (scaffold), render-feed.mjs
```

Root changes are limited to:

- `Cargo.toml` `exclude = ["apps"]`;
- `pnpm-workspace.yaml` gaining `apps/desktop` and `apps/desktop/ui`;
- `scripts/lint-hygiene.mjs` (plus its test);
- `.gitignore` additions;
- `.github/workflows/desktop.yml` and `container-shell.yml`;
- `docs/desktop.md`, an `AGENTS.md` section, `docs/handoff/status/`.

### 2.2 Toolchain pins

| Tool | Pin | Where |
|---|---|---|
| Node | 24.21.0 (engines `>=24.16.0 <25 \|\| >=26.1.0`) | `package.json` |
| pnpm | 10.28.0 | `packageManager` |
| Rust | 1.95 with clippy and rustfmt | `rust-toolchain.toml` (applies to the desktop workspace too) |
| TypeScript / esbuild | 5.9.3 / 0.28.2 | root devDependencies; reuse, do not add a second version |
| Tauri | `tauri =2.12.0`, `tauri-build` of the same release, `@tauri-apps/cli` and `@tauri-apps/api` exact versions matching 2.12 | desktop workspace. **2.12.0 is the floor** (per-webview IPC channel fix, §4.23) |
| Tauri plugins | `tauri-plugin-updater =2.13.0`, `-single-instance =2.5.0`, `-autostart =2.6.0`, `-deep-link =2.5.0` | never `-shell`, `-fs`, `-http`, `-dialog`, `-opener` (DS7, plan Global Constraints) |
| Rust crates | `keyring =4.2.0` (confirm the native-store features, plan Task 8 Step 1); `bollard` = newest release on the day, pinned exactly (DR16); `minisign-verify`, `reqwest` (rustls, `stream`, no default features), `tokio`, `serde`/`serde_json`, `url`, `uuid` (v7), `sha2`, `zeroize`, `tracing`, `tracing-appender`; dev: `wiremock`, `tempfile`, `minisign`; mock: `axum` + `tokio-tungstenite` | every version exact (`=x.y.z`); `Cargo.lock` committed; CI uses `--locked` |
| a11y | `axe-core` exact pin as a devDependency of `desktop-ui`, plus a headless runner you choose and pin (for example Playwright's Chromium) | M3's runner does not exist yet, so ship your own (gap G-6 in §9) |
| Linux build dependencies | `libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libsecret-1-dev patchelf` | CI and local |

Verify each version on crates.io or npm before pinning. The spec's versions were current on 2026-09-26/27. Take
a newer patch only for a published security fix, and record it.

### 2.3 Build, test, run

```bash
# root (unchanged)
pnpm install --frozen-lockfile && pnpm gen && pnpm build && pnpm lint && pnpm test
cargo fmt --all -- --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace
# desktop
cd apps/desktop && cargo fmt --all -- --check && cargo clippy --locked --workspace --all-targets -- -D warnings \
  && cargo test --locked --workspace --no-fail-fast && cd ../.. && pnpm --filter @plur1bus/desktop-ui test
cd apps/desktop && pnpm tauri dev                       # dev run; WP2 onward it talks to the mock by default
cargo run -p plur1bus-mock-harness -- --port 18700      # mock harness (from apps/desktop)
pnpm tauri build --debug --no-bundle                    # compile check
pnpm tauri build --bundles <dmg|nsis|deb,rpm,appimage>  # unsigned bundle (PLUR1BUS_DESKTOP_ALLOW_PLACEHOLDER_KEY=1)
node apps/desktop/stub-image/build.mjs                  # stub harness image (Linux with Docker or Podman)
```

One desktop test: `cd apps/desktop && cargo test --locked -p plur1bus-desktop --test <file> <name> -- --nocapture`.

Real-runtime tests are skipped unless `PLUR1BUS_DESKTOP_E2E_RUNTIME=docker|podman|apple` is set (DR19).

### 2.4 Green definition

A WP is green when all of these pass locally, and on CI once pushed:

1. **Root:** `pnpm lint` (typecheck, hygiene, hygiene self-test), `pnpm test`, and
   `cargo fmt --check`/`clippy -D warnings`/`test` for the root workspace. `pnpm docs:check` too, if you touched
   anything it covers (you should not). The root workspace must not see the desktop crates.
2. **Desktop:** fmt, clippy `-D warnings` and `cargo test --locked` for the desktop workspace; the UI tests
   (`node:test` via `--experimental-strip-types`, the same runner shape as `scripts/test-package.mjs`); from WP3
   on, the a11y and layout tests.
3. **CI:** `ci.yml` stays green. `desktop.yml` is green on all five targets (`macos-15`, `windows-2025`,
   `windows-11-arm`, `ubuntu-24.04`, `ubuntu-24.04-arm`). From WP14 on, `container-shell.yml` is green.

A skipped test says why in its output (`skip: <reason>`), never passes silently (milestones §5.3).

### 2.5 Branches, commits, PRs

- **Branch per WP:** `feat/desktop-shell-wpNN-<slug>`, for example `feat/desktop-shell-wp01-scaffold`. Cut it
  from `origin/main` if the previous WP merged; otherwise stack it on the previous WP branch.
- **Commit:**
  `git -c user.name=Cyb3rb1ade -c user.email=84099452+Cyb3rb1ade@users.noreply.github.com commit -m "<type>(desktop): …"`.
  - Use Conventional Commits, as the repo does (`feat(desktop): …`, `test(desktop): …`, `ci: …`,
    `docs(desktop): …`).
  - Keep attribution trailers your environment adds. Do not add Claude trailers.
- **Never** amend, force-push, merge, use `git stash`, or change git config. **The owner merges.**
- **PRs are drafts**, one per WP, with the template in §10.

### 2.6 Coding and documentation standards (D98 applied to this repo)

- `AGENTS.md` conventions hold: English in code and docs, `erasableSyntaxOnly` TypeScript (no `enum`, no
  parameter properties), JSON Schema as the source of truth wherever a schema exists.
- Formatter, linter, type checker and tests must pass before a WP is done. If one cannot pass, the PR names it
  and says why.
- Public Rust items and exported TS functions get a doc comment. Behaviour changes update `docs/desktop.md`.
  `CHANGELOG.md` gets an entry under `[Unreleased]` in Keep a Changelog form per merged WP; leave a draft line
  in the PR if the owner prefers to write it.
- Every closed serde struct that crosses a trust boundary uses `#[serde(deny_unknown_fields)]`. That covers IPC
  input, `connections.json` and `upgrades.json`. Apple CLI JSON is the exception: it ignores unknown fields but
  requires the fields it uses (plan Task 5).
- Clocks: use `Instant` for durations. Wall time is only for `expiresAt`, reminders and quiet hours, compared
  with a 2 s skew allowance and injected in tests.

---

## 3. Hard rules

These apply to every WP. A violation blocks the PR.

1. **No secrets, tokens or real user data** in the repo, logs, fixtures, test names, images or CI artefacts.
   - Keys, tokens, tickets and feed or updater key pairs are generated at test time.
   - Hosts are synthetic (`harness.test`, `vps.example.ts.net`).
   - Only public keys are committed, and the committed ones are placeholders that release builds refuse.
   - The hygiene lint fails on tracked `*.p12 *.p8 *.pfx *.key *.pem *.keystore *.oci.tar`, a minisign secret
     key header, or a PEM private key.
2. **No remote hosting, no vendor relay** (D35, D106, D108).
   - The shell talks only to the harness origins the person paired and to the runtime endpoint it detected.
   - The only other automatic network call is the update feed, and it can be turned off (§3 non-goal
     "Telemetry").
3. **No telemetry.**
   - No analytics, no crash upload, no identifiers on the feed request.
   - Crash reports stay local; the person copies them by hand.
4. **Tests never touch a real home, a real service manager, the real keychain or the person's runtime
   objects.** Use the DR19 seams (debug builds only):
   - `PLUR1BUS_DESKTOP_CONFIG_DIR`;
   - `PLUR1BUS_DESKTOP_REAL_KEYCHAIN=1`, opt-in, with a random service name that is deleted afterwards;
   - `PLUR1BUS_DESKTOP_APPLE_CLI`;
   - `PLUR1BUS_DESKTOP_DOCKER_CANDIDATES`;
   - `PLUR1BUS_DESKTOP_FEED_URL` and `_FEED_PUBKEY`;
   - `PLUR1BUS_DESKTOP_UPDATER_ENDPOINT` and `_PUBKEY`;
   - `PLUR1BUS_DESKTOP_CLOCK`;
   - `PLUR1BUS_DESKTOP_ALLOW_PLACEHOLDER_KEY`;
   - `PLUR1BUS_DESKTOP_E2E_RUNTIME`;
   - `PLUR1BUS_DESKTOP_HELPER` (the path to a fake helper).

   Every runtime object a test creates carries the label `app.plur1bus.test=<run id>` and the name prefix
   `p1t-<run id>-`, and a drop guard removes it. Autostart and shortcut writers go through a trait with a
   fake; a real LaunchAgent, Run key or XDG autostart file is written only in the manual check.
5. **No Input Monitoring or keystroke capture, ever** (D107, D109 `input.monitor` = never). The global
   shortcut is D2 and out of scope anyway.
6. **Never type passwords.**
   - The app never runs `sudo`.
   - The Apple pkg opens Installer, which asks for the admin password itself (DS27).
   - Vendor installers run with their own UI and no silent flags.
   - Nothing pipes a credential into a subprocess (D109 §9, `credential.entry` = never).
7. **OS permissions just in time.**
   - Nothing is requested at install or first start beyond what the feature in hand needs. Keychain access
     happens at pairing; notifications are D2.
   - The permissions page shows status and opens the exact system pane; it never pre-requests (D107).
8. **The device token lives only in the OS keychain**, and in Rust memory as a `SecretString`
   (zeroized, `Debug` prints `***`).
   - It never appears in a file, log, error, IPC result, event payload, JavaScript, container label,
     environment variable or `exec` argument (plan Global Constraints).
   - `assert_no_token_on_disk` and the redaction test enforce this.
   - The same holds for the secret-store key of `host.keyUnlock`.
9. **Pinned dependencies.** Exact versions, committed lockfiles, `--locked`/`--frozen-lockfile`. In new
   workflows, Actions are pinned by full commit SHA. Images are pinned by digest.
10. **IPC is a closed allow-list** (DS7).
    - Only the commands named in this brief exist, each registered in one table with a test.
    - Each command re-checks the calling webview's label and top-level origin, and validates its input with a
      `deny_unknown_fields` struct.
    - No command takes an image reference, mount path, port, command line or URL to fetch from JavaScript.
    - `app.withGlobalTauri: false`, `app.security.freezePrototype: true`.
11. **Subprocesses** only with fixed argument vectors:
    - the Apple `container` CLI (absolute path, code signature checked);
    - `plur1bus device pair` for a native local harness (known install path);
    - `open`/`installer` for the Apple pkg;
    - `systemctl --user enable --now podman.socket` after a click, through `flatpak-spawn --host` inside a
      Flatpak;
    - the helper binary.

    The Docker path spawns nothing.
12. **Container rules** (DS16, §6.15.7), asserted by `create_spec_is_exact`:
    - loopback-only publish on `127.0.0.1:<18700–18799>`;
    - no runtime socket, `--privileged`, host network, device or home mount;
    - user `10001:10001`, read-only root file system, `tmpfs /tmp`;
    - Docker: `CapDrop ALL`, `no-new-privileges`, `PidsLimit 1024`, `unless-stopped`, `StopTimeout 150`;
    - Apple: `stop -t 150`, no `--cap-add`;
    - environment only `PLUR1BUS_CONTAINER`, `PLUR1BUS_HOME`, `TZ`, `LANG` (plus `PLUR1BUS_UPGRADE_FROM`);
    - state only on `plur1bus-state` and `plur1bus-models`.

---

## 4. Architecture of the shell

### 4.1 Components and processes

```
┌──────────────── PLUR1BUS (Tauri 2.12 main process, Rust, tokio) ────────────────────────────┐
│ ids · settings · logging+redaction · crash · single-instance · deeplink · tray/events        │
│ connections (connections.json) · secrets (keyring: device tokens, secret-store keys)        │
│ client (reqwest/rustls: /meta, redeem, session-ticket, whoami, /events SSE)                  │
│ pair (bundled over exec · native one-click · code) · discovery (run/api.json, native only)   │
│ runtime (detect · AppleRuntime CLI · DockerRuntime bollard) · controller (bundle, lifecycle, │
│   watch, autostart, upgrade+journal) · bridge (ws /ws, host.keyUnlock) · helper supervisor   │
│ updates (feed verify, decide, Tauri updater) · install (shortcuts, CLI shim, target.json)    │
├───────────────┬───────────────────────────┬─────────────────────────┬────────────────────────┤
│ webview       │ webview "spa" (incognito) │ child process           │ tray / menu bar         │
│ "shell"       │ origin = paired harness   │ plur1bus-host (D107)    │ native menus            │
│ bundled pages │ SPA of the harness        │ stdio JSON lines,       │                         │
│ IPC: shell-ui │ IPC: spa-bridge (shell_info)│ capabilities: [] in D1 │                         │
└───────────────┴───────────────────────────┴─────────────────────────┴────────────────────────┘
       │ runtime API/CLI (never from JS)   │ HTTP to harness origin      │ ws://127.0.0.1:<p>/ws
       ▼                                   ▼                             ▼
 container runtime ── plur1bus-harness container (real: D1 Task 4; now: stub image / mock harness)
```

- **Runtime controller vs client** (§5):
  - The controller never calls the harness API with a device token.
  - The client never touches the runtime.
  - Only pairing crosses over, and only through `exec` with fixed argv.
- **Helper (`plur1bus-host`, D107 frame).**
  - A separate binary in the same bundle (Tauri `externalBin`), started by the main process on demand.
  - It talks newline-delimited JSON over stdin/stdout only: no socket, no port, no inherited environment
    beyond `PATH`, `HOME`/`USERPROFILE` and `LANG`.
  - D1 protocol: `hello → { version, capabilities: [] }`, `os.permissions.status → { grants: [] }`,
    `shutdown`.
  - The main process restarts it with a backoff and shows it on the Computer access page.
  - Capabilities arrive in D2. The frame exists so signing and entitlements (§6.9 OS sandboxing), bundle
    placement and the bridge plumbing are settled now.
- **Bridge.** One outbound WebSocket per bundled connection. In D1 it offers `host.keyUnlock`, owned by the
  main process, plus whatever the helper reports (nothing yet). Remote connections do not start the bridge in
  D1 (plan Task 11).

### 4.2 IPC and the security model

- **Trust zones** (§6.9):
  - the Rust core is trusted;
  - shell pages are trusted and load no remote content;
  - the SPA is trusted for its own origin;
  - deep links and argv are untrusted input;
  - panels (D3) are hostile and get no IPC.
- **Capabilities:**
  - `capabilities/shell-ui.json` binds the `shell` webview to the shell commands.
  - `spa-bridge` is added at run time with `add_capability`: `webviews: ["spa"]`,
    `remote.urls: ["<exact origin>/*"]`, and only `shell_info` in D1.
  - The runtime capability is replaced on every connection switch.
  - No capability lists a `panel-*` label.
- **The command table.** One table in `commands.rs`, tested. Labels are shown here as "window → commands".
  - `shell` →
    - `app_info`;
    - `connections_list|rename|remove`, `open_connection`, `pair_local`, `pair_code`;
    - `runtime_detect`, `runtime_start`, `runtime_install_apple|vendor`, `runtime_enable_podman_socket`;
    - `bundle_install`, `harness_start|stop|status|logs_tail`;
    - `harness_upgrade_status`, `harness_rollback`;
    - `update_check|install|later|skip`, `update_settings`;
    - `settings_get|set`, `bridge_settings`, `helper_status`, `permissions_open_pane`, `approvals_list`;
    - `uninstall_containers|images|volumes`, `quit_decision`, `diagnostics_copy`.
  - `spa` → `shell_info`.

  Adding a command means a spec reference, a row in the table and a test. Everything else is refused.
- **Defence in depth.** Every command checks `webview.label()` and the current top-level URL again. This
  covers the Linux iframe caveat in §4.5.
- **CSP.**
  - Shell pages use exactly §6.9's string:
    `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src ipc: http://ipc.localhost; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`.
  - Fonts are bundled files (`font-src` falls back to `'self'`). No Google Fonts at run time (ADR-004 "fonts
    bundled locally").
  - The SPA's CSP is the harness's own.
- **Isolation between shell pages and the SPA.** They are different webviews with different origins:
  - `shell` loads `tauri://localhost` or `http://tauri.localhost`, is persistent and holds no secrets;
  - `spa` loads the harness origin, is `incognito`, has `drag_drop_enabled(false)`, `on_navigation` limited to
    the same origin, other `http(s)`/`mailto` links opened externally, and `window.open` to foreign origins
    blocked.

  No shared storage. The token never enters either webview; only the single-use ticket reaches the SPA, in the
  URL fragment (DS5).
- **Updater and feed.** Signatures are always verified. Channel keys are embedded, and release builds refuse
  placeholder keys (`build.rs`). The Store build (`PLUR1BUS_DESKTOP_STORE_BUILD=1` at compile time) compiles
  the updater plugin out (DS32).
- **Logs.** One redacting formatter covers `Authorization`, `Cookie`/`Set-Cookie`, JSON values for
  `token|ticket|csrf|code|key`, URL query and fragment, base64url runs of 43 or more characters, and
  `PLUR1BUS_*` env values. Planted-secret tests go through the real file sink. Panel page content is never
  logged (D3).
- **Crash handling** (no spec text exists, so this is the ruling here):
  - a Rust panic hook writes `crash-<utc>.txt` (redacted: backtrace, version, target, last 200 log lines)
    into the log directory;
  - the next start shows "PLUR1BUS closed unexpectedly" with *Copy details* and *Open folder*; nothing is sent
    anywhere;
  - a webview process failure (WebView2 `ProcessFailed`, WebKit web process termination) reloads the shell
    page once, then shows the error view;
  - the harness containers are independent and keep running.

### 4.3 Data locations

Resolve paths through Tauri's path resolver with identifier `app.plur1bus.desktop`, and record the actual
per-OS paths in `docs/desktop.md`. Expected paths:

| Data | macOS | Windows | Linux |
|---|---|---|---|
| app config (`connections.json`, `installed.json`, `upgrades.json`, `settings.json`) — `0600`, atomic tmp + rename, no secrets | `~/Library/Application Support/app.plur1bus.desktop/` | `%APPDATA%\app.plur1bus.desktop\` | `$XDG_CONFIG_HOME/app.plur1bus.desktop/` |
| logs and crash files | `~/Library/Logs/app.plur1bus.desktop/` | `%LOCALAPPDATA%\app.plur1bus.desktop\logs\` | Tauri `app_log_dir()` |
| shell webview data | Tauri default (no secrets) | WebView2 UDF under local app data | WebKitGTK default |
| SPA webview | incognito (nothing on disk; acceptance 11 scans for a cookie DB) | same | same |
| keychain | service `app.plur1bus.desktop`; accounts `device-<connection uuid>`, `secret-store-<installationId>` | Credential Manager, same names | Secret Service; memory-only fallback with a banner (DR8) |
| CLI shim | `~/.local/bin/plur1bus` | `%LOCALAPPDATA%\PLUR1BUS\bin\plur1bus.exe` | `~/.local/bin/plur1bus` |
| `target.json` for the forwarder | `~/.config/plur1bus/target.json` | `%APPDATA%\PLUR1BUS\target.json` | `~/.config/plur1bus/target.json` |
| autostart | LaunchAgent (plugin) | HKCU Run key via the plugin (NSIS) / `StartupTask` (MSIX) | `~/.config/autostart/app.plur1bus.desktop.desktop`; Flatpak: Background portal |
| harness state | runtime-managed named volumes `plur1bus-state`, `plur1bus-models`; never a host path (DS18) | same | same |

---

## 5. Work packages, in dependency order

**Priority subset: WP1–WP6 ("first").** Together they give a working *attach-mode* desktop client that runs on
all five targets:

- pair a remote or native harness (the mock until M3);
- open the SPA logged in;
- show the tray;
- keep the token in the keychain.

Each of WP1–WP6 merges on its own value. WP7–WP11 add the bundled container path and the safe updater.
WP12–WP15 finish packaging, CI and polish. If the budget runs out, stop at a WP boundary with a green draft PR
and the status file current.

Board names refer to the design canvas (§7). "Accept" lists the tests that must exist and pass. Test names
follow the D1 plan where it has them, so Claude can map them.

### WP1 — Scaffold, workspace, hygiene, desktop CI *(first)*

- **Goal.** The app builds, starts and shows an empty shell window on five targets. CI proves it.
- **Files:**
  - `apps/desktop/{Cargo.toml,package.json}`;
  - `src-tauri/{Cargo.toml,build.rs,tauri.conf.json,capabilities/shell-ui.json,icons/*}`;
  - `src-tauri/src/{main,lib,ids}.rs`, `src-tauri/tests/config.rs`;
  - `ui/{package.json,build.mjs,index.html}`;
  - root `Cargo.toml` (`exclude`), `pnpm-workspace.yaml`, `.gitignore`;
  - `scripts/lint-hygiene.mjs` + test;
  - `.github/workflows/desktop.yml`.
- **Interfaces:**
  - `ids.rs`: `BUNDLE_ID = "app.plur1bus.desktop"`, `KEYCHAIN_SERVICE = BUNDLE_ID`, `PRODUCT = "PLUR1BUS"`,
    `CONTAINER = "plur1bus-harness"`, `LABEL_PREFIX = "app.plur1bus"`, `SCHEME = "plur1bus"` (DR5, DS33).
  - `tauri.conf.json`:
    - `identifier` = the bundle id;
    - `withGlobalTauri: false`, `freezePrototype: true`;
    - CSP exactly as in §4.2;
    - one window `shell` (`visible: false` until ready, `minWidth: 800`, `minHeight: 600`, DR26);
    - `bundle.windows.nsis.installMode: "currentUser"`, `bundle.macOS.signingIdentity: "-"`.
  - Icons exported per §7.3 (placeholders are acceptable in WP1 if the canvas exports are not available;
    record that).
  - `desktop.yml`:
    - triggers: `pull_request`/`push` on `apps/desktop/**` and the workflow file, plus a nightly;
    - matrix of the five targets;
    - steps: toolchain, Linux dependencies, `pnpm install --frozen-lockfile`, UI tests, fmt, clippy, `cargo test
      --locked`, `pnpm tauri build --debug --no-bundle`;
    - unsigned online bundles as artefacts, kept 7 days, with `PLUR1BUS_DESKTOP_ALLOW_PLACEHOLDER_KEY=1`;
    - Actions pinned by SHA;
    - no `pull_request_target`.
- **Accept:**
  - `identifier_matches_ids_rs`, `csp_is_the_spec_string`, `global_tauri_is_off_and_prototype_frozen`;
  - `no_forbidden_plugins_in_cargo_toml`, `nsis_is_current_user_only`, `min_window_is_800x600`;
  - `lint-hygiene --self-test` fails on a planted tracked `x.p12` and `x.oci.tar`;
  - the root Green does not build any desktop crate;
  - `desktop.yml` green on five targets.
- **Pointers:** D1 plan Task 1; §6.9 CSP; DS2, DS7, DS13, DS33; `DskIcons` (§13.8).

### WP2 — Provisional harness contract, mock harness, fake binaries, stub image *(first)*

- **Goal.** One executable definition of what the shell expects from a harness (§6), usable by:
  - Rust tests, in process;
  - `pnpm tauri dev`, standalone;
  - real-runtime e2e, as a stub container image.

  When M3 lands, Claude maps the names (DR1) and deletes whatever the real harness covers.
- **Files:**
  - `apps/desktop/mock-harness/` (lib + bin);
  - `apps/desktop/mock-harness/CONTRACT.md` (the §6 contract, marked *provisional*);
  - `apps/desktop/test-bins/{fake-plur1bus,fake-container}` (plus fixture directories);
  - `apps/desktop/stub-image/{Dockerfile,build.mjs,README.md}`.
- **Interfaces:**
  - `MockHarness::start(opts) -> MockHandle { origin, installation_id, control }`. `control` scripts
    behaviour:
    - revoke a device;
    - set `harness.status` or `secrets` state;
    - make `/meta` answer a different `installationId` or API major;
    - drop the SSE stream;
    - inject failures for the upgrade gate.
  - The bin serves the same routes on `--port`, with a placeholder SPA at `/` that:
    - redeems `/auth/ticket#t=…`;
    - shows the logged-in user;
    - when it runs inside the app, calls `shell_info` through the IPC that Tauri exposes to an origin holding
      the `spa-bridge` capability, to demonstrate the bridge. In a plain browser it skips the call.
  - `fake-plur1bus`: argv → recorded JSON document plus exit code for the exec surface in §6.3, driven by a
    scenario file. It records every argv it receives, so tests can assert that no token ever appears in argv.
  - **Stub image** (test-only, name `p1t-stub-harness`):
    - `FROM` a pinned-digest `debian:bookworm-slim` (or `node:24-bookworm-slim`);
    - holds the mock-harness bin as the entrypoint on `0.0.0.0:18700` and `fake-plur1bus` as
      `/usr/local/bin/plur1bus`;
    - user `10001:10001`, runs read-only with `tmpfs /tmp`.

    It honours `SIGTERM` within 150 s and keeps its state (installation id, devices, the secret-store
    "provisioned" flag) under `/var/lib/plur1bus` on the volume, so restarts and upgrades behave like the real
    thing.

    **Optional stretch** (only if cheap): run the real `plur1bus daemon status --json` and `1staid check --json`
    from `main` inside the stub, so status rows show real documents. Do not implement container mode or
    `init`.
- **Accept:**
  - `mock_meta_is_unauthenticated`, `redeem_is_single_use`, `ticket_single_use_and_60s`;
  - `events_requires_events_read`, `bridge_requires_bridge_serve`, `frames_over_64k_close`;
  - `revoked_device_gets_401_device_revoked`;
  - stub image: build, `run` with the §3 rule 12 flags, `/api/v1/meta` on `127.0.0.1` only, `exec plur1bus
    daemon status --json` returns the fixture, and stop completes under 150 s. This runs on Linux with Docker
    and with Podman; record which ran.
- **Pointers:** §6.2, §6.14 (D1 rows), §6.15.4 "Host bridge protocol", §6.15.8; D1 plan Task 2 "Interfaces"
  (copy the shapes), Task 3 (exec documents); DR1, DR15, DR19.

### WP3 — Shell UI frame: theme, fonts, i18n, responsive, platform chrome, a11y base *(first)*

- **Goal.** A frame every shell page plugs into, built the way §13 draws it:
  - a view router;
  - light and dark themes;
  - de/en;
  - the binding responsive rules;
  - platform button order;
  - an a11y test harness.
- **Files:**
  - `ui/src/{main,ipc,i18n,router}.ts`;
  - `ui/src/theme/{tokens.css,base.css,chrome-{mac,win,gnome,kde}.css}`;
  - `ui/assets/fonts/*` plus `OFL.txt` per family;
  - `ui/src/i18n/{en,de}.json`;
  - `ui/src/components/*` (button, segmented, switch, sheet, rail/sidebar, dialog, progress list, chip, banner);
  - `ui/test/{i18n,layout,a11y}.test.ts`.
- **Interfaces:**
  - `ipc.ts` is the only module that calls `invoke` (bundled `@tauri-apps/api/core`).
  - `tokens.css` is the single provisional token source, from §13.1: the light Glow values and the dark shell
    set. It carries a header saying it gets replaced by the M3 theme file (C1 open, §7.4).
  - Themes follow `prefers-color-scheme`, dark as the fallback, with a three-state override
    (system/light/dark) stored in `settings.json` (default of G-3 in §9).
  - Locale follows the OS (German systems → `de`, everything else → `en`), with a manual override (owner,
    2026-09-27).
  - Platform chrome (DR26):
    - affirmative button first on Windows and KDE, rightmost on macOS and GNOME;
    - pills on macOS and GNOME, 6 px radius on Windows and KDE;
    - Windows dialogs get a footer band;
    - GNOME compact buttons fill the width;
    - OS words: *menu bar*, *notification area*, *top bar*, *system tray*.
  - Wordmark as drawn (`SETT1NGS`, `CONNECT1ONS`, C4 open). `prefers-reduced-motion` stops every animation.
- **Accept:**
  - `i18n: en and de have identical key sets and no empty strings`;
  - `layout: breakpoints follow content width (compact < 1024, wide > 1600)`;
  - `layout: 400 CSS px has no horizontal scroll`;
  - `layout: text ≥ 12 px, targets ≥ 44 px on shell pages`;
  - `layout: dialogs are min(680, window − 48)`;
  - axe-core WCAG 2.1 AA clean on a sample view in both themes and both locales;
  - full keyboard traversal;
  - visible focus;
  - 4.5:1 contrast.
- **Pointers:** §13.1, §13.7 (all 12 rules), §6.13; DR6, DR26; D1 plan Tasks 12 and 19; C1, C2, C3, C4, C22.

### WP4 — Connections, keychain, harness client, remote and native pairing, Connections pages *(first)*

- **Goal.** Pair a harness by code (remote) or one click (native local), and store the token only in the
  keychain.
- **Files:**
  - `src-tauri/src/{connections,secrets,client,pair,discovery,commands}.rs`;
  - `tests/{connections,secrets,client,pairing}.rs`, `tests/fixtures/origin-cases.json`;
  - `ui/src/views/{connections,add-remote}.ts`, `ui/src/models/{pairing-model,origin-input}.ts`.
- **Interfaces:** exactly D1 plan Task 8 and Task 9 for the remote and native paths:
  - `Origin`, `Connection`, `Store`, `TokenStore`, `SecretString`, `open_default()`;
  - `HarnessClient::{meta,redeem,session_ticket,whoami}`;
  - `pair_local`, `pair_code`;
  - discovery of `run/api.json` (native attach only; never read `run/*.token`).

  Every authenticated call first runs `meta()` and refuses on an `installationId` mismatch (Review Focus 1),
  an unsupported API major, or a missing `desktop.sessionTicket` capability. `401 reason=device-revoked`
  deletes the token and marks pairing as needed.
- **Accept:**
  - the plan Task 8 list (origin table, `0600`, corrupt file kept aside, unknown fields refused,
    `secret_string_debug_and_display_are_redacted`, `access_denied_is_pairing_needed_not_a_crash`,
    `open_default_falls_back_to_memory_when_the_probe_fails`, a real keychain round trip behind the opt-in);
  - the plan Task 9 remote and native list (`a_different_installation_at_the_origin_gets_no_token`,
    `redeem_stores_the_token_in_the_token_store_only` + `assert_no_token_on_disk`, `redirects_are_not_followed`,
    `pair_code_rejects_insecure_remote_before_any_request`, `discover_*`, `pair_local_*`);
  - UI: the `pairing-model` table, `origin-input: same table as Rust`.
- **Pointers:** §6.1, §6.2, DS4, DS6; D1 plan Tasks 8 and 9; boards `DskB-Connections-*` (list, add-remote,
  add-error, repair, revoked, no-keychain).

### WP5 — SPA window: incognito, ticket login, navigation guard, `spa-bridge` *(first)*

- **Goal.** *Open* shows the harness SPA logged in, without the token ever entering the webview.
- **Files:** `src-tauri/src/{policy,spa}.rs`, `tests/{policy,spa}.rs`; the error view for
  `/auth/ticket-failed`.
- **Interfaces:** plan Task 13: `spa_navigation`, `check_spa_caller`, `open_spa`, and `shell_info` returning
  `{ product, version, platform, arch, features: [] }`. The external opener accepts only classified `https:`,
  `http:` and `mailto:` URLs, and is implemented in Rust (no opener plugin).
- **Accept:**
  - `navigation_table`, `caller_check_rejects_other_webview_and_other_origin`;
  - `shell_info_is_the_only_spa_command`, `spa_bridge_capability_is_scoped_to_the_connection_origin`;
  - `switching_connection_replaces_the_capability`. If the Tauri mock runtime cannot express this, test through
    `policy.rs` plus a recorded manual check, and say so;
  - `a_replayed_ticket_page_is_retried_once_then_shows_the_error`;
  - `no_cookie_database_in_app_dirs` + `assert_no_token_on_disk` after an open/close cycle;
  - against the mock: quit and restart logs in again through a fresh ticket (acceptance 11).
- **Pointers:** DS3, DS5, DS7, §6.9; D1 plan Task 13; acceptance 10 and 11.

### WP6 — App lifecycle: single instance, windows, tray, quit, autostart, logging, crash *(first)*

- **Goal.** The app behaves like a resident desktop app:
  - a second launch focuses the first;
  - closing a window hides it;
  - the tray shows state in words and icons;
  - *Quit* asks about the harness;
  - autostart is a real toggle;
  - logs are redacted;
  - crashes are recorded locally.
- **Files:** `src-tauri/src/{tray,events,logging,crash,settings}.rs`, `controller/autostart.rs` (plugin
  wrapper behind a trait), `tests/{events,tray_state,logging,crash}.rs`, `ui/src/views/quit-dialog.ts`.
- **Interfaces:**
  - `TrayState`, `map_status`, `combine`, `EventStream` (plan Task 14): `GET /events?topics=harness.status`,
    Bearer token, backoff 1 s ×2 up to 30 s ±20 %, `Last-Event-ID`, revoked → `Unpaired`.
  - Tray menu per plan Task 14:
    - header `PLUR1BUS — <connection>` with the harness and runtime state in words;
    - *Open PLUR1BUS*;
    - *Start/Stop harness* (bundled only, wired in WP8);
    - *Start runtime* (Apple);
    - *Update available…*;
    - *Connections…*;
    - *Settings…*;
    - *Quit PLUR1BUS*.
  - Icons: the four glyph classes of C18 (ring = busy, dot = update, triangle = attention, plain = ready),
    template images on macOS, light and dark `.ico` on Windows, symbolic SVG on Linux.
  - Quit dialog: a shell-page modal, not a native dialog (no dialog plugin). Default *keep PLUR1BUS running*
    (DR9).
  - Linux without an AppIndicator host: the window stays in the taskbar, with a one-time hint (C17 default).
  - `autostart::set_enabled` and `on_login` (start minimised to the tray). The runtime and harness start is
    wired in WP8.
  - `logging::init`/`redact`, and the crash hook as in §4.2.
- **Accept:**
  - `map_status_table`, `combine_table`;
  - `stream_reconnects_with_backoff_and_last_event_id`, `revoked_stream_goes_unpaired_and_stops`;
  - `quit_asks_and_defaults_to_keep_running`;
  - `second_instance_focuses_the_first`;
  - `autostart_toggle_calls_the_launcher` (fake);
  - `redact_removes_tokens_tickets_cookies_keys_and_url_fragments`,
    `the_log_file_never_contains_a_planted_token_or_key`;
  - `panic_writes_a_redacted_crash_file_and_the_next_start_offers_it`;
  - manual record: tray follows the mock's `harness.status` on each available OS.
- **Pointers:** §6.8, DR9, DR10, D101 "Autostart starts minimised"; D1 plan Tasks 14 and 15 (logging half);
  boards `DskB-Tray-{mac,win,gnome,kde}`; C17, C18, G2.
- **Logging follows D111** *(amended 2026-10-01 (D111); spec
  `docs/superpowers/specs/2026-10-01-logging-and-diagnostics-design.md`)*:
  - JSONL, keys in order `ts` (RFC 3339 UTC, ms), `level`, `source{kind:"desktop",id:"shell"|"controller"|"updater",version}`,
    `event` (registered `desktop.*` codes, spec §3.2), `msg` (constant per event), then optional `trace_id`, `span_id`,
    `duration_ms`, `err{code,reason,retryable,hint}`, `attrs`; files `0600` / user-only DACL.
  - Levels `trace|debug|info|warn|error|fatal` (default `info`, `trace` only time-limited); a panic is `fatal`
    (`desktop.app.crashed`, written at the next start beside the crash file, which stays as specified in §4.2).
  - Harness and runtime output shown by `harness_logs_tail` is foreign text: rendered as plain text, never parsed for
    levels or events.
  - Redaction stays in the one formatter and adds D111 §4: URL userinfo, vendor key shapes, JWTs, PEM keys, deny-list
    paths; base64url runs of ≥ 43 characters are redacted **unless pure hex** (hashes stay readable).
    `the_log_file_never_contains_a_planted_token_or_key` also asserts the record schema.

### WP7 — Runtime detection and adapters

- **Goal.** Find every usable container runtime and speak to it through one trait.
- **Files:** `src-tauri/src/runtime/{mod,spec,detect,apple,docker}.rs`,
  `tests/{apple_runtime,docker_runtime,detect,runtime_contract}.rs`,
  `tests/fixtures/{apple/<ver>,docker}/*.json`, `scripts/record-apple-fixtures.mjs`.
- **Interfaces:** plan Task 5 (`Runtime` trait, `ContainerSpec`, `harness_spec`, `oneshot_spec`, `RuntimeError`)
  and Task 6 (`DockerRuntime`, `candidates`, `detect_all`, `choose_default`, `DetectState`).
  - Candidate order per §4.11. `DOCKER_HOST=tcp://…` is ignored with a note.
  - Each probe (`/_ping` + `/version`) has 2 s.
  - `Os != linux` → `WrongMode`; permission denied → `NoAccess` with the rootless/Podman hint.
  - Nothing is ever switched silently (Review Focus 7).
  - Apple fixtures you create without a Mac go under `tests/fixtures/apple/synthetic-1.3/` with a README that
    marks them *unrecorded*. The owner records the real ones with `record-apple-fixtures.mjs` (DR13, DR18).
- **Accept:**
  - the plan Task 5 list minus the spike;
  - the plan Task 6 list (the detection table over fixture environments, `a_windows_containers_engine_is_wrong_mode`,
    `permission_denied_is_no_access_with_the_rootless_hint`, `the_same_socket_via_two_sources_is_listed_once`,
    `choose_default_table` incl. the macOS 26 tie → Apple, `a_new_runtime_is_listed_not_adopted`,
    `create_body_is_exactly_the_spec`);
  - the shared `runtime_contract` suite against both fakes;
  - with `PLUR1BUS_DESKTOP_E2E_RUNTIME=docker|podman`, the contract suite against real engines (record the
    result).
- **Pointers:** DS14, DS23, §4.10, §4.11, §6.15.1, §6.15.2; boards `DskB-Install-*` detect / detect-none,
  `DskB-Settings-*` runtime; G1.

### WP8 — Controller, bundled install and auto-pair, wizard, Settings → Runtime

- **Goal.** "Weiter, weiter, fertig" against the stub image:
  - detect;
  - acquire by digest;
  - create volumes and the container;
  - start;
  - auto-pair over `exec`;
  - open the SPA.

  Plus the restart watch and autostart wiring.
- **Files:**
  - `src-tauri/src/controller/{mod,bundle,acquire,lifecycle,watch}.rs`, `pair.rs` (`pair_bundled`),
    `install/target_json.rs`;
  - `bundle/bundle.json.tmpl`;
  - `tests/{bundle,controller,watch}.rs`, `tests/controller_e2e.rs` (gated);
  - `ui/src/views/{wizard,settings-runtime,progress,error}.ts`, `ui/src/models/wizard-model.ts`.
- **Interfaces:**
  - plan Task 7: `Bundle` (placeholder digests; `build.rs` refuses them in release builds unless
    `…ALLOW_PLACEHOLDER_KEY`), `Controller::{install,start,stop,status,logs_tail,exec_json,uninstall}`,
    `HarnessStatus`, `InstallStep`, `installed.json`, `spawn_watch`, `on_login`;
  - plan Task 9 `pair_bundled`: exact argv for `user create --owner --json` and
    `device pair --json --kind desktop --name … --scope ui.session,events.read,bridge.serve --grant host.keyUnlock`,
    and revoking the old device after the new token is stored;
  - `target.json` writer (plan Task 10 format).

  Wizard: follow the §6.15.10 behaviour with the board layout, per the C13/C14 defaults in §7.4. Error kinds as
  plan Task 12.

  Settings → Runtime:
  - detected list, chosen runtime and endpoint;
  - *Re-check*;
  - health rows;
  - memory limit 2–16 GiB (default 3);
  - *Start PLUR1BUS when I log in*;
  - log tail with redaction;
  - the *Unlock secrets with …* switch (wired in WP9).
- **Accept:**
  - the plan Task 7 list (`create_spec_is_exact` golden argv/body for both adapters,
    `install_is_idempotent_after_a_partial_failure`, `port_in_use_picks_the_next_and_keeps_the_connection`,
    `runtime_gone_is_reported_not_switched`, watch backoff, five failures in 10 min → `Crashed`, 20 s grace for
    Docker's policy, wake-gap handling, `docker_socket_wait_is_bounded_to_120s`);
  - the plan Task 9 bundled list (`pair_bundled_*`, `the_token_is_never_in_an_exec_argument_or_env`,
    `bundled_revoked_repairs_once_then_asks`);
  - `wizard-model: happy path is three primary actions` (or the count the C13 default gives; record it), and
    every error kind maps to a message and a retry target;
  - `controller_e2e` on the stub image with Docker and Podman: install → ready → kill PID 1 → restarted → stop
    → uninstall; the port is bound only on `127.0.0.1` (probe the non-loopback addresses).
- **Pointers:** DS1, DS14–DS20, §6.1 "Bundled", §6.2 step 0, §6.15.3–§6.15.7, §6.15.10; D1 plan Tasks 7, 9, 12;
  acceptance 1 (mock level), 3, 4 (controller half); boards `DskB-Install-*` (all states), `DskB-Settings-*`
  runtime / runtime-crashed; C13, C14, C15, G1.

### WP9 — Host bridge, `host.keyUnlock`, helper frame, Computer access and Approvals frames

- **Goal:**
  - the bridge transport runs;
  - the secret-store key lives in the keychain and unlocks the (mock) harness on every start;
  - the D107 helper and the D109 surfaces exist as frames.
- **Files:**
  - `src-tauri/src/{bridge,helper}.rs`, `apps/desktop/host-helper/`;
  - `tests/{bridge,helper}.rs`;
  - `ui/src/views/{settings-computer-access,approvals}.ts`.
- **Interfaces:**
  - Bridge per plan Task 11:
    - `ws://127.0.0.1:<port>/ws`, Bearer token;
    - `bridge.hello { capabilities }` → `bridge.welcome { accepted }`;
    - `bridge.call`/`bridge.result`;
    - reconnect 1 s → 30 s with jitter;
    - frames ≤ 64 KiB;
    - revoked → stop and hand over to pairing.
  - `host.keyUnlock`:
    - `op: "provision"` only when no keychain entry exists (never overwrite; `E_EXISTS`);
    - `op: "get"` otherwise;
    - switch off → `E_DENIED`.

    **On `MemoryOnly` (Linux without Secret Service) the app refuses to provision** and the harness stays
    locked with a banner (G-9 default, §9). The alternative would lose the key at the next restart.
  - Helper: the stdio protocol in §4.1, `helper_status` for the page.
  - **Computer access page** (Settings → Computer access, D107):
    - lists OS grants from `os.permissions.status`, with status, the features that need each grant, and an
      *Open system settings* button;
    - D1 shows the empty state: "No feature needs a system permission yet";
    - `permissions_open_pane` accepts only a closed enum of panes, mapped in Rust to `x-apple.systempreferences:`,
      `ms-settings:privacy-*` or the portal;
    - it never requests a grant.
  - **Approvals frame** (D109 §5 card layout):
    - a native window fed by mock `approval.requested`/`approval.resolved` events on `/events`;
    - each card shows capability, effect, exact targets, risk, reversibility, grant options, the action-hash
      short form, and last "the agent's reason (unverified)";
    - the default action is *Open in PLUR1BUS* (routes the SPA to the approval);
    - the approve/deny buttons exist but are wired only to the mock behind the debug flag
      `PLUR1BUS_DESKTOP_APPROVALS_DECIDE=1`, until the owner answers G-2 (§9).
- **Accept:**
  - the plan Task 11 list (`hello_lists_only_enabled_capabilities`, `provision_creates_and_stores_a_key_once`,
    `provision_never_overwrites_an_existing_key`, `get_returns_the_stored_key`, `capability_off_answers_E_DENIED`,
    `reconnects_with_backoff`, `revoked_stops_and_requests_pairing`, `remote_connections_do_not_start_the_bridge_in_d1`);
  - `memory_only_store_refuses_provision`;
  - `helper_hello_reports_no_capabilities`, `helper_is_restarted_with_backoff`, `helper_gets_no_inherited_env`;
  - `permissions_open_pane_accepts_only_known_panes`;
  - `approval_card_shows_targets_before_reason`;
  - acceptance 7 against the stub (restart → `secrets: locked` → the bridge reconnects → `unlocked`; switch off
    → stays locked).
- **Pointers:** DS17, §6.15.4, D107 "Permission handling", D109 §5 and §7; D1 plan Task 11; board
  `DskB-Settings-*` *Unlock secrets with …*; `V2Inbox`/`V2Approvals` for the card language.

### WP10 — Update feed, channels, update dialog, Tauri updater

- **Goal.** Offer only signed, newer releases on the chosen channel, with de/en notes. The person chooses
  *Jetzt / Später / Überspringen* or *Version halten*. Automatic patches are on by default and run in the
  quiet hours.
- **Files:** `src-tauri/src/updates.rs`, `bundle/release.schema.json`, `scripts/render-feed.mjs`,
  `tests/{updates,updater}.rs`, `tests/fixtures/feeds/*`, `ui/src/views/{update-dialog,settings-updates}.ts`,
  `ui/src/models/update-model.ts`.
- **Interfaces:**
  - plan Task 15 `Channel`, `Release`, `UpdateSettings` (`auto_patch` defaults to true on a fresh install,
    DR20), `fetch`, `decide`, `Offer`, `install_app`;
  - the feed is `https://updates.plur1bus.app/{channel}.json` + `.minisig` (DS28, the same URL
    `plur1bus update --check` uses), verified with the embedded channel **feed** key;
  - the app bundle is fetched and verified by `tauri-plugin-updater` with its own per-channel key, through a
    `latest.json` whose digest `release.json` pins (G-7 and G-8 defaults, §9);
  - checks at start (switchable) and on demand, at most every 6 h, sending no identifiers;
  - the notes renderer handles plain paragraphs and lists only, strips HTML, and never creates links;
  - Store build: notes only, *Open Microsoft Store*.
- **Accept:**
  - the plan Task 15 updates and updater lists (bad signature, other-channel key, lower version,
    `min_from_version`, hold, later 24 h/next start, skip, security re-offer after 7 days, auto-patch on by
    default / stays off after an update / never minor or major / waits for quiet hours and no active run,
    no beta→stable downgrade, schema-invalid refused, tampered payload refused, manifest digest mismatch refused,
    `pending` written before restart, release build refuses the placeholder key);
  - `update-model` transitions;
  - `notes renderer strips HTML and never creates links`;
  - `store_build_has_no_updater_plugin`.
- **Pointers:** DS12, DS24, DS28, DS32, §6.11, §6.16.1–§6.16.3, §6.16.7; D1 plan Task 15; acceptance 5a and 12;
  boards `DskB-Update-*` (offer, security, major, store), `DskB-Settings-*` updates.

### WP11 — Harness upgrade and rollback state machine, Version page

- **Goal.** After an approved release, upgrade the bundled harness by digest:
  - snapshot, swap, migrate;
  - gate;
  - roll back automatically on any failure;
  - resume deterministically after a crash.
- **Files:** `src-tauri/src/controller/{upgrade,journal}.rs`, `tests/{upgrade,journal}.rs`,
  `tests/upgrade_e2e.rs` (gated, stub image A → B → B′ failing), `ui/src/views/{upgrade-progress,settings-version}.ts`.
- **Interfaces:**
  - plan Task 16: `Step`, `Journal` (`upgrades.json`, write-then-rename before each step), `GateReport`,
    `Controller::{upgrade,resume,rollback_manual,gate}`, `Outcome`;
  - the sequence exactly as §6.15.8 steps 1–9;
  - the commands it runs inside containers (`1staid check --json`, `state snapshot|verify|restore`,
    `admin migrate`, `admin smoke --json`) are answered by `fake-plur1bus` / the stub image with scripted
    results. Their real implementation is D1 Task 3.
- **Accept:** the whole plan Task 16 list, against both runtime fakes:
  - the happy path;
  - `preflight_fail_changes_nothing`;
  - each injected failure → automatic rollback naming the step;
  - `corrupted_snapshot_before_restore_is_recovery_failed_and_deletes_nothing`;
  - `snapshot_disk_full_restarts_the_old_version_unchanged`;
  - `interrupted_upgrade_resumes_at_every_step`;
  - `patch_upgrade_with_a_schema_change_is_refused`;
  - manual rollback;
  - the token survives;
  - `diagnostic_is_redacted`;
  - `upgrade_e2e` on Docker and Podman with the stub image.
- **Pointers:** DS21, §6.15.8, §6.16.3; D1 plan Task 16; acceptance 5 (at stub level); boards `DskB-Update-*`
  progress, done, rolled, recovery; `DskB-Settings-*` version, rollback-confirm.

### WP12 — Deep links, `plur1bus://`, `.p1x` association hook

- **Goal.** Register the scheme on every OS, route links through single instance, and validate everything as
  untrusted input.
- **Files:** `src-tauri/src/deeplink.rs`, `tests/deeplink.rs`, `tauri.conf.json` (`plugins.deep-link`, file
  association for `.p1x`), `ui/src/views/pair-confirm.ts`.
- **Interfaces:** `parse(url) -> DeepLink { Pair { origin, code }, Open { path }, Chat { rest }, Install { catalogue_id } } | Ignored`.
  - `pair` pre-fills the code form. The confirmation screen shows the origin prominently. It never pairs by
    itself and never replaces a connection (§6.9).
  - `open` accepts only a relative path matching the SPA route allow-list, on the active connection.
  - `chat/*` (D92, milestones D1 row) and `install` (X3, catalogue ids only, D84) are parsed and answered with
    "not available in this version" until their features land.
  - A `.p1x` file opens a confirm view with *not available yet*. The X3 hook fills it later (`DskB-P1x-*`,
    C19).
  - Everything else is ignored and logged without arguments. The same rules apply to argv.
- **Accept:**
  - `pair_link_prefills_and_never_pairs`;
  - `open_link_rejects_absolute_and_foreign_paths`;
  - `unknown_links_are_ignored_and_logged_without_args`;
  - `argv_links_take_the_same_path`;
  - `second_instance_forwards_the_link`;
  - `install_link_accepts_catalogue_ids_only`.
- **Pointers:** §4.6 "Deep links", §6.9 "Deep links", DS33; milestones D1 row (D92), X3 row; C19, G4, G5.

### WP13 — Packaging per OS, installer choices, runtime install help, uninstall, signing hooks

- **Goal.** Build installable bundles per target and channel, with D101's choices, the runtime-install flows
  and a staged uninstall.
- **Files:**
  - `tauri.conf.json` bundle sections;
  - `src-tauri/windows/nsis/installer.nsi` (the custom template) + `hooks.nsh`;
  - MSIX configuration (`StartupTask`, `desktop7:Shortcut`);
  - `apps/desktop/flatpak/app.plur1bus.desktop.yml`;
  - `src-tauri/src/install/{apple_pkg,vendor_installer,podman_socket,cli_shim,shortcuts}.rs`;
  - `tests/install.rs`;
  - `ui/src/views/{install-runtime,settings-advanced,uninstall}.ts`.
- **Interfaces:**
  - **D101:**
    - NSIS *Options* page before install, with desktop icon, Start menu and *Start PLUR1BUS with Windows*, all
      ticked. `/S` takes all three on; `/NODESKTOP /NOSTARTMENU /NOAUTOSTART` opt out;
    - MSIX: `desktop7:Shortcut` + `StartupTask Enabled="true"`. A user's disable is final;
    - macOS, deb/rpm and AppImage: a first-run toggle *Open at login*, on;
    - AppImage: offers menu integration, and the autostart path is refreshed each start;
    - Flatpak: Background portal `RequestBackground { autostart: true }`, showing whether it was granted;
    - the installer writes only the initial choice, and the app's toggles own it afterwards;
    - updates never re-create a deleted icon;
    - uninstall removes what it created.
  - **Variants** (DR4, DS30): an online variant (no image) and an offline variant (`resources/image/*.oci.tar`).
    The offline variant is built only with a *stub* tarball in CI, to prove the mechanism.
  - **Apple pkg:** bundled, verified by SHA-256 + `pkgutil --check-signature` + team id, then `open -W`, then
    `container system start --enable-kernel-install`. The pkg is a placeholder and verification is behind a
    trait.
  - **Vendor installer:** HTTPS download, checksum against `bundle.json`, no silent flags, and the licence note
    shown before the download (DS27).
  - **Podman socket:** fixed argv, `flatpak-spawn --host` when `FLATPAK_ID` is set.
  - **CLI shim:** copies the bundled host `plur1bus` from the root release artefacts (placeholder in CI), adds a
    `PATH` line with a marker, and never overwrites a foreign file.
  - **Uninstall:** follows the C16 default in §7.4.
  - **Signing hooks** (no credentials):
    - macOS `signingIdentity` from an environment variable, else ad-hoc;
    - Windows `signCommand` hook left empty until SignPath (DS31);
    - AppImage GPG variables documented.
  - **Icons:** from `DskIcons` (§7.3).
- **Accept:**
  - the plan Task 17 list (`apple_pkg_is_bundled_not_downloaded`, `apple_pkg_refuses_wrong_sha_or_signature`,
    `apple_pkg_never_uses_sudo`, `vendor_installer_refuses_wrong_checksum`,
    `vendor_installer_never_passes_silent_flags`, `vendor_installer_shows_the_vendor_licence_before_download`,
    `podman_socket_uses_fixed_argv`, `cli_shim_never_overwrites_a_foreign_file`,
    `path_line_is_added_once_with_marker_and_removed_on_uninstall`, `target_json_matches_the_forwarder_format`,
    `offline_variant_uses_the_bundled_tarball`);
  - D101 per channel (`nsis_options_page_writes_the_choices`, `silent_flags_opt_out`,
    `update_keeps_a_deleted_icon_deleted`, `uninstall_removes_created_entries`, `msix_manifest_has_startup_task_and_shortcut`,
    `flatpak_requests_background`);
  - bundles build for each target in `desktop.yml`;
  - a manual install of each available bundle, with click count and time recorded.
- **Pointers:** §6.10, §6.15.10, DS27, DS30–DS34, DS39 (`webviewInstallMode`: online `downloadBootstrapper`,
  offline `offlineInstaller`), D101; D1 plan Task 17, DR4, DR22, DR23; boards `DskB-Install-*` licence,
  install runtime, mode; `DskB-Settings-*` uninstall-1..3; C14, C16, G6.

### WP14 — CI extension: container e2e on the stub image, Apple scaffold, canary

- **Goal.** Prove the controller, pairing and upgrade on real Docker and Podman in CI, and keep the Tauri 3
  canary visible.
- **Files:** `.github/workflows/container-shell.yml`, `.github/workflows/apple-container.yml` (scaffold),
  `apps/desktop/scripts/apple-e2e.mjs` (scaffold), `apps/desktop/canary/{tauri3.patch,README.md}`, the
  `desktop.yml` nightly jobs.
- **Interfaces:**
  - `container-shell.yml` runs on `ubuntu-24.04` and `ubuntu-24.04-arm` × {Docker rootful, Docker rootless
    (`dockerd-rootless-setuptool.sh install`), Podman rootless}. It builds the stub image, runs `controller_e2e`
    and `upgrade_e2e` plus a pull-by-digest path against a `registry:2` container, and asserts the port is
    loopback-only.
  - `apple-container.yml`: `workflow_dispatch`, `runs-on: [self-hosted, macOS, ARM64, macos-26-container]`,
    never required. It runs `apple-e2e.mjs`, which writes `apple-e2e-<version>.json`.
  - Nightly `canary`: Tauri 3 alpha + `tauri-runtime-cef`, allowed to fail. Nightly `repro`: the Linux x64
    `.deb` built twice, advisory.
- **Accept:** both workflows lint clean (`actionlint` if available), SHA-pinned, no `pull_request_target`, no
  secrets used. First real runs happen when the owner pushes. Dry-run the e2e locally and record it.
- **Pointers:** DS23, §6.12, §6.15.12; D1 plan Task 18 (the non-release parts), DR3, DR17, DR18.

### WP15 — Accessibility and i18n pass, docs, final report

- **Goal:** every view is clean and documented, and Claude can pick up from the report.
- **Files:** fixes across `ui/`, `docs/desktop.md` (shell parts), an `AGENTS.md` section `apps/desktop`,
  `docs/handoff/status/desktop-shell.md`.
- **Interfaces:**
  - `docs/desktop.md` covers:
    - what the app is;
    - runtimes per OS and what to install;
    - install per OS and channel (*Open anyway* / *Run anyway* for unsigned builds);
    - where tokens and keys live;
    - the data paths from §4.3;
    - updates and rollback as built;
    - uninstall;
    - the seams;
    - known degradations.
  - `AGENTS.md` covers:
    - the desktop Green;
    - the seams (DR19 + `PLUR1BUS_DESKTOP_HELPER`, `PLUR1BUS_DESKTOP_APPROVALS_DECIDE`);
    - how to run the mock and the stub e2e;
    - the rule that no key file or OCI tarball is committed.
- **Accept:**
  - axe-core over every view in both themes and locales;
  - layout at 400, 960, 1440 and 2560 CSS px and at 200 % zoom;
  - keyboard traversal;
  - tray strings from the catalogue;
  - a manual screen-reader pass where available (VoiceOver, NVDA, Orca), with every OS not checked named;
  - the §8 checklist filled in the status file.
- **Pointers:** §6.13, §13.7 rule 12; D1 plan Tasks 19 and 20; acceptance 14.

---

## 6. Interfaces the shell consumes, and the stub/mock strategy

### 6.1 Why a mock

The D1 plan cuts `feat/desktop-d1` "after M3 has merged". Its preconditions require:

- the M3 API;
- device pairing;
- `/events`;
- `/meta` with capabilities;
- users;
- the ADR-005 secret store.

Otherwise it stops with BLOCKED. **None of these exist on `main` today:**

- there is no API package;
- there is no `docs/api-surface.md`;
- there is no M3 spec or plan;
- `plur1bus user`, `device` and `login` are stubs.

Waiting would idle track D for the whole of M2 and M3. So the shell is built against the **provisional
contract** below, taken from §6.2, §6.14, §6.15.4, §6.15.8 and D1 plan Tasks 2–3, and executed by the WP2 mock.
When M3 exists:

1. DR1 applies: existing surfaces are used under M3's names, and the mapping goes into the ADR-004 note.
2. The mock is kept only for what the real harness does not provide in tests.
3. The client code changes in one place: `client.rs` and the exec argv constants in `pair.rs`/`upgrade.rs`.

Keep every path, field name and scope in constants so this is a small diff.

### 6.2 HTTP (provisional; origin `http://127.0.0.1:<port>` bundled, `https://…` remote)

| Route | Auth | Request → response | Notes |
|---|---|---|---|
| `GET /api/v1/meta` | none | → `{ apiVersion: "1.x.y", version: "<product semver>", installationId, capabilities: string[] }` | the shell needs `desktop.sessionTicket` and `host.bridge`. A different API major is refused, naming both versions (ADR-016 §3) |
| `POST /api/v1/devices/redeem` | none (rate-limited) | `{ code, name, kind: "desktop" }` → `{ deviceId, token }` | code: 8 characters shown as `XXXX-XXXX`, single use, about 1 h (C10 settled). The token goes straight into the keychain |
| `POST /api/v1/auth/session-ticket` | `Bearer <device token>` with `ui.session` | → `{ ticket, expiresAt }` | single use, 60 s, device-bound, at most 5 open per device |
| `GET /auth/ticket#t=<ticket>` | none | SPA page: POSTs the ticket, then `replaceState` | the fragment never reaches server logs |
| `POST /api/v1/auth/ticket/redeem` | none | `{ ticket }` → `Set-Cookie` session (no `Expires`/`Max-Age`, `HttpOnly`, `SameSite=Lax`, `Secure` on TLS) + `{ csrf }` | `401 E_AUTH reason=ticket-invalid` |
| `GET /api/v1/auth/whoami` | Bearer | → `{ userId, deviceId, scopes }` | health gate step 6 |
| `GET /events?topics=harness.status[,approval]` | Bearer with `events.read` | SSE, `Last-Event-ID` | `harness.status` data: `{ state: starting\|ready\|degraded\|down, secrets: locked\|unlocked, reason? }`. `approval.*` is provisional (G-2) |
| `GET /ws` (upgrade) | Bearer with `bridge.serve` | JSON text frames ≤ 64 KiB | the bridge protocol in §6.4 |
| any, with a revoked token | — | `401 E_AUTH reason=device-revoked` | the shell deletes the token and marks pairing as needed |
| *(G-2, provisional)* `GET /api/v1/approvals?state=pending`, `POST /api/v1/approvals/{id}/decision` | Bearer with `approvals.decide` | D109 §5 request shape; `{ decision: approve\|deny, scope }` | **not in any spec.** The mock only, behind the debug flag |

**Device scopes** (§6.2): `ui.session`, `events.read`, `bridge.serve` (bundled only). The shell never asks for
scopes it does not use.

**Native discovery** (attach mode only): `<state root>/run/api.json` =
`{ url, pid, instanceId, installationId, apiVersion }`, under `PLUR1BUS_HOME`, `~/.plur1bus` or
`%LOCALAPPDATA%\PLUR1BUS`. Ignore it when stale or when the URL is not loopback. Never open `run/*.token`.

### 6.3 Exec surface inside the bundled container (provisional; D1 Tasks 2–3)

The shell calls these through `Runtime::exec` / `run_oneshot` with fixed argv. Each prints one `--json`
document carrying a top-level `schema` (ADR-016 §8); failures are `error/1`.

| argv | Result `schema` | Used by |
|---|---|---|
| `plur1bus user create --owner --json` | `user.create/1 { userId }`; `E_EXISTS` if an owner exists (fine) | auto-pair (§6.2 step 0) |
| `plur1bus device pair --json --kind desktop --name "<host> desktop" --scope ui.session,events.read,bridge.serve --grant host.keyUnlock` | `device.pair/1 { code, expiresAt }` | auto-pair |
| `plur1bus device revoke <deviceId> --json` | `device.revoke/1` | replacing an older bundled device (DR8) |
| `plur1bus daemon status --json` | exists today (`daemon.status/1`-shaped: `{ supervisor, children[] }`) | readiness |
| `plur1bus 1staid check --json` | exists today (`1staid.check/1 { checks[] }`); D1 adds `container`, `storage`, `engine.storeSchema { current, required }` rows | pre-flight, gate, health rows |
| `plur1bus state snapshot --src /src --dst /dst --json` / `state verify --dir … --json` / `state restore --src … --dst … --json` | `state.snapshot/1 { from, createdAt, fileCount, bytes, manifestSha256 }`, `{ ok, mismatches[] }` | upgrade steps 3 and 8 (one-shot container, `--network none`) |
| `plur1bus admin migrate --from <c> --to <r> --yes --json` | exit 0 / non-zero | upgrade step 5 |
| `plur1bus admin smoke --json` | `{ ok, steps: [{ name, ok, ms, detail? }] }` | health gate |

A native local harness uses `plur1bus device pair --json --kind desktop --name …` through the known install
path (DR12). `E_DENIED` or a missing binary falls back to the code flow.

### 6.4 Host bridge protocol (DS17, plan Task 2)

The client sends `bridge.hello { capabilities: string[] }`. The server answers
`bridge.welcome { accepted: string[] }`: the intersection of the device grant, what the harness supports and
what the person enabled.

The server sends `bridge.call { callId, capability, op, args }`. The client answers
`bridge.result { callId, ok, value?, error? }`.

In D1 the only capability is `host.keyUnlock`, with `op: "provision" | "get"`. The value is a 32-byte key,
base64url, never logged. There is no generic "run this" operation, ever. The helper's capabilities (D2) join
`hello` through the same path.

### 6.5 Update feed

- `GET https://updates.plur1bus.app/{channel}.json` + `{channel}.json.minisig` (DS28). This is the document
  `plur1bus update --check` already reads (`crates/plur1bus/schema/release-manifest.schema.json`: an open top
  level, `version`, `channel`, `minFromVersion`, optional `native`).
- The shell adds its fields per §6.11: `kind`, `security`, `date`, `notes { de, en }`, `migrationNote?`,
  `bundle` (the `bundle.json` digest), `tauri` (the `latest.json` digest). Keep `bundle/release.schema.json` a
  superset that the harness schema still accepts.
- The Tauri updater reads a per-channel `latest.json` whose SHA-256 must equal `release.tauri` (G-8).
- Seams: `PLUR1BUS_DESKTOP_FEED_URL`/`_FEED_PUBKEY`, `PLUR1BUS_DESKTOP_UPDATER_ENDPOINT`/`_PUBKEY`.

### 6.6 Stub and mock tiers

| Tier | What | Where it runs |
|---|---|---|
| A. in-process | `MockHarness` lib, wiremock, `fake-plur1bus`/`fake-container` binaries, runtime fakes | every `cargo test` on all five targets |
| B. standalone | `plur1bus-mock-harness` bin on a loopback port | `pnpm tauri dev`, manual checks, the SPA-window tests |
| C. stub image | mock + `fake-plur1bus` in a pinned Linux image with the real container flags | `PLUR1BUS_DESKTOP_E2E_RUNTIME=docker\|podman`, `container-shell.yml` |
| D. real harness | the D1 Task 4 image with container mode | later, when Tasks 2–4 and M3 exist. Claude switches the e2e over |

---

## 7. UI source of truth

### 7.1 The canvas

- **URL:** https://claude.ai/artifact/CRjk86mofQ9vqhb2twu8wS (the owner's Design artifact).
- **Pages:**
  - **`v2 · Desktop & responsive`** (id `desk`, 63 boards): every D1 shell page in the native frames of macOS
    15, Windows 11, GNOME 47 and KDE Plasma 6, light and dark, at normal (1280 window), compact 960 and wide
    2560. Also the tray, the icon set `DskIcons` and the responsive rules `RspRules`;
  - **`v2 · Glow`** (56 boards): the harness SPA (M3 onward). You need it only for the visual language and the
    approvals card (`V2Inbox`, `V2Approvals`);
  - `v1` is superseded.
- **Behaviour vs looks.** The canvas owns how screens look and what they contain. The spec, the D1 plan and
  ADR-004 own behaviour, security and decisions (§13).
- **If you cannot open the artifact** (it needs a claude.ai login): §13.1, §13.6, §13.7 and §13.8 carry the
  values copied from the board sources. Work from those and ask the owner for PNG exports into
  `docs/ui/desk/` (G-12).

**Boards for the shell** (§13.6):

| Board family | States | WP |
|---|---|---|
| `DskB-Install-*` | welcome, licence, detect, detect-none, runtime, mode, progress-online, progress-offline, done, error | WP8, WP13 |
| `DskB-Update-*` | offer, security, major, progress, done, rolled, recovery, store | WP10, WP11 |
| `DskB-Settings-*` | runtime, runtime-crashed, updates, version, rollback-confirm, advanced, uninstall-1..3 | WP8–WP11, WP13 |
| `DskB-Connections-*` | list, add-remote, add-error, repair, revoked, no-keychain | WP4 |
| `DskB-Tray-{mac,win,gnome,kde}` | ready, starting, error, update | WP6 |
| `DskIcons` | — | WP1, WP6, WP13 |
| `RspRules` | — | WP3, WP15 |

Not D1:

- `DskB-Sidecars-*` (D2/D3/D75): hide its nav entry;
- `DskB-P1x-*` (X3): WP12 builds only the hook view;
- `RspB-Browser-*` (D3).

**Undrawn, so build them from the nearest board and record them as reference screens:**

- G1: the macOS 26 path; runtime states `too-old` and `wrong-mode`; the wizard error kinds;
- G2: the other tray states and the quit dialog;
- G6: installer artwork;
- plus the Computer access page and the approvals window, which come from D107/D109 text and the `V2Inbox`
  card language.

### 7.2 Responsive rules (binding, §13.7, condensed; read the full 12 rules)

- **Logical px.** Layout follows the window's content width.
- **Minimums:** text 12 px, targets 44 px on shell pages, window 800 × 600.
- **Breakpoints:**
  - compact < 1024 (must work down to 400);
  - normal 1024–1600;
  - wide > 1600 (add one panel, never stretch text).
- **Collapse order:** right panel → sheet, sidebar 256 → rail 64 (overlay 288), list + detail → push, header
  actions → More.
- **Maximum widths:** settings content ≤ 880, dialogs `min(680, window − 48)` × `min(760, window − 48)`,
  wizard content ≤ 960, sheets 360 (full width below 600).
- **Shell pages:**
  - wizard window ≤ 1100 × 800 normal, ≤ 1280 × 860 wide; rail 292; *Your choices* 316; cards in two columns
    from 560;
  - settings: sidebar 256 (rail 64 compact), 400 panel wide;
  - connections: sidebar 240 (256 wide), detail panel wide, full-window sheet in compact;
  - below 600 the footer hint moves above the buttons.
- **Checks:** at 400, 960, 1440 and 2560 CSS px and at 200 % text zoom of a 1440 window. Reduced motion stops
  every animation.

### 7.3 Icon set (§13.8)

- **Master artwork:** `icons/master.svg` (1024 grid), `small.svg` (≤ 32 px, ring dropped at ≤ 24), `glyph.svg`
  (tray, never a 1 px stroke).
- **Tauri `bundle.icon`:** `32x32.png`, `128x128.png`, `128x128@2x.png`, `icon.icns` (16–512 at 1×/@2×),
  `icon.ico` (16, 20, 24, 32, 40, 48, 64, 256).
- **macOS tray:** template PNG per state at 16/18 pt, 1×/2×/3×.
- **Windows tray:** `.ico` per state, light and dark, 16/20/24/32.
- **MSIX:** `Square44x44Logo` scale-100/150/200/400 + targetsize-16/24/32/48/256 unplated, `StoreLogo`
  50/75/100/200, `Square150x150Logo`, `Square310x310Logo`. Check what Tauri's MSIX target requires beyond these.
- **Linux:** hicolor `{16,22,24,32,48,64,128,256,512}` `app.plur1bus.desktop.png`, plus `scalable` and
  `symbolic` SVG. Tray icons are symbolic SVG at 16/22/24.
- **Tray states:** four glyph classes, told apart by shape (C18).

### 7.4 Open owner conflicts C13–C18, quoted from §13.5, with the default you implement

Across all six the rule is DR26: **the spec's behaviour, the board's layout and copy**, until the owner decides.

- **C13 Wizard steps (shell).**

  > §6.15.10 / D1 plan DR6: *Welcome → Runtime → (Install runtime) → Resources → Installing* (image, volumes, network, container, start, owner, pairing) *→ Done*, three primary clicks. Board: *Welcome → Licences* ("I agree") *→ Runtime → Install runtime → Offline or online → Installing* (copy/download, verify, unpack, volumes, start, health check) *→ Done*; no *Resources* step (fixed 3 GB · 4 processors at install; the 2–16 GB limit, default 3 GB, sits in *Settings → Runtime*); owner creation and pairing are folded into the health check ("sign-in works"). With a runtime present this is five actions. *Reading 1:* the board replaces the §6.15.10 list and the D77 licence screen is its own step. *Reading 2:* the spec order stands; licences fold into *Welcome*, *Resources* returns.

  **Default:** reading 2.
  - Steps: Welcome (with the licence summary and an *I agree* checkbox gating *Weiter*) → Runtime → (Install
    runtime) → Resources (defaults, *Advanced* collapsed) → Installing → Done. Three primary actions with a
    runtime present.
  - The progress list shows the board's six rows and reports network, owner and pairing as sub-steps.
  - The `wizard-model` keeps the step list in one table, so switching to reading 1 is data, not code.

- **C14 Offline or online.**

  > DS30 / DR4: two separate installers; the online one carries no image. Board: one wizard step "Offline or online?" choosing where the image comes from. *Reading 1:* the step appears only in the offline installer (it can still pull), the online installer skips it. *Reading 2:* one installer carries both paths, which changes DS30 and DR4 (the small installer is no longer small).

  **Default:** reading 1. The step is shown only when `bundle.tarball[arch]` is present.

- **C15 Online verification.**

  > DS20: the app checks image digests against `bundle.json`; cosign and SBOM serve VPS and audits, "without a cosign verifier in the app". Board (*Offline/online*): "cosign signature and SBOM verified". *Reading 1:* copy error; the app shows the digest check only. *Reading 2:* the app verifies cosign signatures too (new dependency; DS20 changes).

  **Default:** reading 1. The copy says "checked against the signed list (digest)". No cosign dependency.

- **C16 Uninstall.**

  > §6.15.10 / Task 17: three confirmations in order — containers, images, volumes with size, keep data by default. Board: one choice of three levels (*App only* keeps data · *App and images* · *Everything, including your data* — adds the pre-update backup volume and the keychain entries), one summary, typed `plur1bus-state` only for *Everything*, then a progress list; default *App only*. *Reading 1:* the tiered choice plus typed confirmation replaces the three confirmations. *Reading 2:* the three confirmations stand and the board is redrawn.

  **Default:** reading 2 in behaviour (containers, images and volumes each confirmed separately, data kept by
  default), laid out with the board's summary and progress list (D1 plan Task 17). Keep the three scopes as
  separate commands, so reading 1 is a UI change only.

- **C17 GNOME without a tray.**

  > §6.8 / Task 14: no AppIndicator host → the window stays in the taskbar with a one-time hint; notifications are D2 (DR2). Board: a notification banner for **every** state change (*Open/Dismiss*, *Show log/Start again*, *Later/Update…*) plus the *Background Apps* section of Quick Settings (GNOME 44+, Flatpak build only, × = *Quit PLUR1BUS…*); deb/rpm/AppImage keep the window in the dash and say so once; with the AppIndicator extension the KDE-style menu appears. *Reading 1:* adopt; `tauri-plugin-notification` and the XDG Background portal move into D1 for GNOME. *Reading 2:* D1 keeps the one-time hint; banners arrive with D2's notifications.

  **Default:** reading 2. The Flatpak Background portal request (D101) is still made for autostart.

- **C18 Tray states.**

  > DR10 / Task 14: 8 harness × 3 runtime states in words, *Start/Stop harness*, *Start runtime* (Apple), one icon per state. Board: 4 states — *Running*, *Starting* (models warming, *Stop* disabled), *Needs attention* (*Start PLUR1BUS*, *Show log…*, *Copy details*), *Update available* — and 4 glyph badges told apart by shape (ring = busy, dot = update, triangle = attention; macOS tints template icons, so colour is lost). *Reading 1:* the 4 glyphs are icon classes onto which DR10's states map (`starting`/`updating` → ring, `degraded`/`down`/`unpaired`/`crashed`/`rollback` → triangle, update → dot), the header keeps all states in words, and the rest is gap G2. *Reading 2:* the tray is reduced to four states, which changes DR10.

  **Default:** reading 1.

Other conflicts that touch you (§13.5):

- **C1** token source: the provisional `tokens.css` from the Glow values.
- **C2** default theme: follow the OS, dark as fallback.
- **C4** wordmark: the morph as drawn, isolated in one component.
- **C9** and **C20**: no `shell_*` command beyond `shell_info`.
- **C22** 44 px targets: on shell pages, yes.

---

## 8. Acceptance checklist (§8) mapped to work packages

"Mock" means proven against the WP2 mock or stub image. "Full" still needs the real harness (D1 Tasks 2–4,
M3), and Claude closes those.

| # | Criterion (short) | WP | Level reachable by Codex |
|---|---|---|---|
| 1 | Fresh install, Docker path (rootful, rootless, Podman): exact flags, auto-pair, SPA logged in, loopback only, no token on disk, keychain entry | WP8, WP13, WP14 | mock (stub image); full after Task 4 |
| 2 | Fresh install, Apple path (fake CLI in CI; real on macOS 26) | WP7, WP8, WP14 | fake CLI; real run is the owner's (DR18) |
| 3 | Detection states and DS14 default, never switched silently | WP7 | full |
| 4 | Supervision in the container (supervisor killed → core adopted; PID 1 → restart; refusals; 150 s stop) | WP8 (controller half) | controller half with the stub; the harness half is Task 3 |
| 5 | Upgrade and rollback incl. each injected failure and the corrupted snapshot | WP11 | mock (scripted commands); full after Task 3 |
| 5a | Update dialog and policy (Später, Überspringen, Version halten, bad signature, `minFromVersion`, auto-patch default, no downgrade) | WP10 | full |
| 5b | Release gate | — | **out** (Claude, after review) |
| 6 | Host CLI (`--help` local, forwarded `--json` byte for byte) | — / WP13 (`target.json`) | forwarder is Task 10, out |
| 7 | Host bridge: locked until the app reconnects; switch off stays locked; ungranted capability refused | WP9 | mock; full after Task 2 |
| 8 | Remote pairing by code; non-loopback `http://` refused before any request | WP4, WP5 | mock; full after M3 |
| 9 | Revoke → pairing screen, keychain entry gone | WP4, WP6 | mock |
| 10 | SPA can call `shell_info` only; other origin or navigated page refused; foreign links open externally | WP5 | full (shell-side) |
| 11 | Restart → fresh ticket login, no cookie on disk; ticket single use and 60 s | WP5 | shell-side full; ticket rules mock |
| 12 | Tampered update refused; signed beta installs after *Jetzt*; other-channel key refused | WP10 | full with test keys; the macOS install is a recorded manual check |
| 13 | `desktop.yml` five targets; `container.yml` image build, sign, size gate; Tauri 3 canary reported | WP1, WP14 | desktop yes; the real image pipeline is Task 4 |
| 14 | axe-core WCAG 2.1 AA, keyboard traversal, screen-reader pass recorded | WP3, WP15 | full |
| 15 | Log redaction with planted token, ticket, cookie and fragment | WP6 | full |

Also carry the D1 plan's **Review Focus 1–7** (installation mismatch, runtime gone, interrupted upgrade, port
taken, disk full at snapshot, keychain refused, second runtime). Each maps to a named test in WP4, WP7, WP8 and
WP11.

---

## 9. Open questions for the owner (each with the default Codex implements)

| # | Question | Default |
|---|---|---|
| G-1 | Build the shell now against a provisional contract and a mock, although D1 formally starts after M3? | **Yes.** Everything harness-facing sits behind constants and the mock; the DR1 mapping happens when M3 lands. |
| G-2 | D109 names the desktop app a **T3** approval surface, but no scope or endpoint lets the app decide approvals. The SPA inside the app is a normal cookie session that the harness cannot tell apart from a browser. Add a device scope `approvals.decide` plus a decision route, or mark ticket-redeemed sessions as `surface: desktop`? | The native approvals window lists requests and opens the SPA route to decide. Decide buttons exist against the mock only, behind `PLUR1BUS_DESKTOP_APPROVALS_DECIDE=1`. M3/D109 picks the mechanism. |
| G-3 | Theme default: ADR-004 says dark default with light per OS; the canvas draws light as default (C2). | Follow the OS; dark when the OS states no preference; three-state override. |
| G-4 | Deep links: §6.3/DR2 put `plur1bus://pair\|open` in D2, milestones put `plur1bus://chat/*` (D92) in D1, and X3 needs `plur1bus://install` and `.p1x` in D1. | Scheme registration, parsing and validation in D1 (WP12). `pair`/`open` active; `chat`/`install`/`.p1x` answer "not available yet". |
| G-5 | D101 says "the app's *Settings › General* toggles own" the desktop icon and autostart after install, but the shell's settings have no *General* section (that is the SPA's `V2General`). | *Start PLUR1BUS when I log in* in shell Settings → Runtime (as drawn); a Windows-only *Desktop icon* toggle in Settings → Advanced. No new `shell_*` command. |
| G-6 | Accessibility gates reference "the M3 axe-core runner", which does not exist. | The shell ships its own pinned axe-core runner in `desktop-ui` tests; M3 can adopt or replace it. |
| G-7 | Keys: DS12 says "separate update keys per channel". The harness feed already uses repository variables `PLUR1BUS_RELEASE_PUBKEY_{STABLE,BETA}` (minisign), and Tauri's updater has its own key pair. | Two key sets per channel: the **feed** key, shared with `plur1bus update --check`, verifies `{channel}.json`; the **Tauri updater** key verifies app bundles. Both are placeholders in the repo; release builds refuse placeholders. |
| G-8 | §6.16.7 shows one merged manifest with `notes: { de, en }` and `platforms`. `tauri-plugin-updater` expects its own shape (a string `notes`, `platforms`), and §6.11 describes `release.json` pinning a separate Tauri `latest.json` by digest. | Follow §6.11: `{channel}.json` (D78 fields, verified first) pins `latest.json` by SHA-256, and the plugin reads `latest.json`. §6.16.7's example is read as illustrative. Codex verifies the plugin's accepted shape at the pinned version and records it. |
| G-9 | Linux without Secret Service (DR8, memory-only token store): `host.keyUnlock` would provision a key that is lost at the next app restart, leaving the harness's encrypted store permanently locked. | Refuse to provision on memory-only. The harness stays `secrets-locked` with a banner naming the fix (install or unlock a Secret Service keyring), or ADR-005's operator choice. Owner may pick otherwise. |
| G-10 | Hygiene: §6.12/Task 18 want every `uses:` pinned by SHA, but the existing `ci.yml`, `nightly.yml` and `harness-release.yml` use tags (`actions/checkout@v4`). A global lint would break `main`. | The SHA lint applies to `desktop.yml`, `container-shell.yml` and `apple-container.yml` only. Pinning the existing workflows is a separate owner call. |
| G-11 | Workspace location: DS13 and the plan put the lockfile in `src-tauri/`. The mock, helper and test binaries want to share it. | One desktop workspace at `apps/desktop/Cargo.toml`, lockfile `apps/desktop/Cargo.lock`, still outside the root workspace (DS13's intent kept). |
| G-12 | Codex may be unable to open the claude.ai canvas. | Work from spec §13's copied values. Owner exports the `desk` boards as PNGs into `docs/ui/desk/` if pixel checks are wanted. |
| G-13 | Crash handling has no spec text. | Local crash file, *Copy details* at the next start, no upload (§4.2). |
| G-14 | The D107 helper is placed in D2, but the brief asks for its frame now. | The frame ships in D1 with zero capabilities and a stdio protocol. Signing and entitlements are wired through the WP13 hooks; notarisation is D2. |
| C13–C18 | See §7.4. | As written there. |

---

## 10. How to report back

1. **Status file:** `docs/handoff/status/desktop-shell.md`, one file, one section per WP, updated in the WP's
   last commit. Per WP:
   - WP id, branch, PR number, base branch, head commit;
   - done: interfaces delivered, matching the WP's "Interfaces", with file paths;
   - tests: every "Accept" name with pass/fail/skipped, the skip reason, and the targets it ran on;
   - manual checks: what, on which OS, and the result (click counts, screenshots under
     `docs/handoff/status/img/` — no personal data in them);
   - deviations from this brief or the spec, each with its reason;
   - defaults applied from §7.4 and §9;
   - open questions that are new;
   - the next WP and anything half-done: unfinished steps as a checklist, so Claude can continue.
2. **PR description** (draft PR, one per WP):

   ```
   ## <WPnn> <title>
   Brief: docs/handoff/2026-09-30-desktop-shell-codex.md §5 <WPnn> · Base: <branch>
   ### What
   ### Tests (name → result → targets)
   ### Manual checks
   ### Deviations and defaults applied
   ### Not done / follow-ups
   ### Acceptance (§8 rows touched, level: mock|full)
   ```
3. **Leave in the repo:**
   - `apps/desktop/mock-harness/CONTRACT.md`, kept in sync with §6: this is what Claude maps onto M3;
   - recorded or synthetic fixtures with a README saying which;
   - `docs/desktop.md` and the `AGENTS.md` section, from WP15, or partial earlier;
   - no scratch files, no binaries, no key material, no OCI tarballs.
4. **When blocked:**
   - write `BLOCKED: <reason>` at the top of the WP's status section;
   - push the green part;
   - open the draft PR anyway;
   - stop, rather than widening scope or weakening a rule in §3.
