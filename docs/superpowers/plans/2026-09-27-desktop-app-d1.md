# Desktop app D1: thin shell (written in full) · D2–D4 (outline): Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Scope note.** Track D builds the optional desktop shell from spec D74. **D1 is written in full below** (12 tasks). It is a thin shell that can ship: the SPA in a webview, attach to a local or remote harness, a token held in the keychain, a tray icon, and the updater on unsigned dev builds. **D2** (native integration and signed stable releases), **D3** (CEF panel and egress) and **D4** (computer use and the WebMCP bridge) are outlined at the end. Each gets its own full plan after the milestone before it merges.

**Goal:** A person installs the dev build on macOS arm64, Windows x64/arm64 or Linux x64/arm64 and opens it. The app either finds the local harness and pairs with one click, or pairs with a remote harness (for example `https://vps.tailnet.ts.net`) using an 8-character code. After that the app shows the harness's own SPA, already logged in. The device token sits only in the OS keychain. A tray icon shows whether the harness is ready, degraded or down. The app updates itself from a signed dev feed. Revoking the device on the harness returns the app to pairing at once.

**Architecture:** One Tauri 2.12 app in `apps/desktop/`, with its own Cargo workspace and lockfile.
- **Rust core:** connections store (non-secret JSON), token store (`keyring` native stores, or memory only), discovery of `run/api.json`, a reqwest/rustls harness client (`/meta`, device redeem, session ticket, `/events` SSE), local pairing through `plur1bus device pair --json`, tray, single-instance, updater.
- **Window `shell`:** bundled static pages for the connection manager.
- **Window `spa`:** incognito; loads the harness origin. It gets a runtime capability scoped to that one origin with a single command, `shell_info`.
- **Login:** the webview logs in through a one-time ticket in the URL fragment. The device token never reaches page JavaScript.
- **Harness side:** D1 adds only what spec §6.14 lists for D1, behind the M3 `authorize()` chokepoint.

**Tech Stack:**
- **Rust 1.95** (the repo's `rust-toolchain.toml`), with exact pins: `tauri =2.12.0`, `tauri-build` (same release), `tauri-plugin-updater =2.13.0`, `tauri-plugin-single-instance =2.5.0`.
- **Rust libraries:** `keyring =4.2.0` (native stores; Task 4 confirms the 4.x store feature names on docs.rs and records them), `reqwest` (rustls, `stream`, no default features), `tokio`, `serde`/`serde_json`, `url`, `uuid` (v7), `zeroize`, `tracing` + `tracing-appender`.
- **Rust dev dependencies:** `wiremock`, `tempfile`, `minisign` (to sign test updates at test time).
- **Shell pages:** TypeScript 5.9 compiled by esbuild 0.28 (the repo's versions), no framework and no runtime dependencies, tested with `node:test`. The a11y gate uses the same axe-core runner M3 introduced.
- **Harness side:** whatever M3's API package uses.

**Spec:** `docs/superpowers/specs/2026-09-27-desktop-app-design.md`. Binding sections:
- §2: DS1–DS13;
- §6.1: discovery, compatibility, separate lifecycles;
- §6.2: connections, pairing, keychain, tickets, scopes;
- §6.3: D1 rows;
- §6.9: security model, as far as D1 builds it;
- §6.10: D1/D2 column;
- §6.11: `dev` channel;
- §6.12: CI, secrets, reproducibility;
- §6.13: accessibility;
- §6.14: D1 rows;
- §8: acceptance 1–9.

Also binding: ADR-004 and its 2026-09-27 amendment (no own policy layer), ADR-007 (effective rights = role ∩ token scopes, deny by default), ADR-016 §3 (capabilities, not version sniffing), and D35 (device pairing, hashed token, revocable).

**Owner questions still open** (spec §11): signing accounts, bundle id and scheme, Flatpak, the Windows CEF gap. None of them blocks D1: D1 ships unsigned dev builds under the placeholder id `dev.plur1bus.desktop` (ruling DR5).

---

## Repository, branch, and how to run anything

**Work repo (`$HARNESS`):** `/home/claude/PLUR1BUS-Harness`. Cut branch **`feat/desktop-d1`** from `main` **after M3 has merged**, using the `superpowers:using-git-worktrees` skill. Every path below is relative to that worktree.

**`$API`:** the package that holds M3's harness API server (routes, `authorize()`, device pairing). Task 2, Step 1 finds it and records its path in the task report. Every harness-side path below is written relative to `$API`.

**Node:** `export PATH=/home/claude/.node24/bin:$PATH`. **Linux build dependencies for Tauri** (CI installs them; locally once): `libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libsecret-1-dev patchelf`.

**Green** means all of:

```bash
# root repo, unchanged
pnpm install --frozen-lockfile && pnpm gen && pnpm build && pnpm lint && pnpm test \
  && cargo fmt --all -- --check && cargo clippy --workspace --all-targets -- -D warnings \
  && cargo test --workspace --no-fail-fast && pnpm docs:check
# desktop
cd apps/desktop/src-tauri && cargo fmt -- --check && cargo clippy --locked --all-targets -- -D warnings \
  && cargo test --locked --no-fail-fast && cd ../../.. && pnpm --filter @plur1bus/desktop-ui test
```

**One desktop Rust test:** `cd apps/desktop/src-tauri && cargo test --locked --test <file> <name> -- --nocapture`. **A dev run:** `cd apps/desktop && pnpm tauri dev`. The Tauri CLI is a dev dependency of `apps/desktop/package.json`, pinned to the same release as `tauri`. **An unsigned bundle:** `pnpm tauri build --bundles <dmg|nsis|deb,rpm,appimage>`.

---

## Global Constraints

Every task's requirements implicitly include this section.

- **Commits:** `git -c user.name=Cyb3rb1ade -c user.email=84099452+Cyb3rb1ade@users.noreply.github.com commit …`. Every message body ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01SxcLhve6hyM9AFm2nU9B3F`. Never `git stash`, never `--amend`, never push, never change git config (use `-c` only).
- **No secrets and no real user data** in code, fixtures, logs, test names or CI artefacts. Tokens, tickets and updater key pairs are generated at test time. Connection names and hosts are synthetic (`harness.test`, `vps.example.ts.net`). No test touches the real keychain unless `PLUR1BUS_DESKTOP_REAL_KEYCHAIN=1` is set (CI's keychain smoke only, with a random service name that is deleted afterwards). No test reads or writes `~/.plur1bus` or the real app config directory: `PLUR1BUS_HOME` and `PLUR1BUS_DESKTOP_CONFIG_DIR` (a test seam, honoured only in debug builds) point into a temp directory.
- **No own policy layer** (ADR-004 amendment). The shell may refuse or hide, but it never decides a permission the harness has not decided. Every harness-side addition goes through `authorize()` and gets a row in the deny-by-default suite.
- **The device token is never on disk and never in JavaScript.** It exists in the keychain, in Rust memory as `SecretString`, and in the `Authorization` header of the shell's own requests. It never appears in a log line, an error message, `Debug` output, a command result, an event payload or `connections.json`. Task 4's scan test and Task 9's redaction test enforce this.
- **IPC allow-list** (spec DS7):
  - Only the commands named in this plan exist.
  - Every command validates input with a `#[serde(deny_unknown_fields)]` struct and checks the calling webview's label and current origin.
  - No `tauri-plugin-shell`, `-fs`, `-http`, `-dialog` or `-opener` crate is a dependency. External links open through `tauri::webview::open_url`-equivalent Rust code (the D1 choice is made in Task 7) from an allow-listed Rust path, never from a JS-callable plugin.
  - `app.withGlobalTauri: false`, `app.security.freezePrototype: true`.
- **Root workspace untouched** except `Cargo.toml` `exclude = ["apps"]`, `pnpm-workspace.yaml` gaining `apps/desktop/ui`, the hygiene lint, and docs. The supervisor's dependency budget (no tokio) is unaffected because the desktop crate is a separate workspace (DS13).
- **Pins:** `Cargo.lock` of the desktop workspace is committed. Every CI command uses `--locked`, and pnpm uses `--frozen-lockfile`. GitHub Actions are pinned by full commit SHA.
- **CI green** on the existing `ci.yml` and on the new `desktop.yml` for all five targets (Task 10). Windows rules from earlier plans still apply: `fileURLToPath`, no `fs.realpathSync.native`, and `pnpm` through a shell.
- **Clocks:** durations on `Instant`. Wall time only for `expiresAt`, and it is always compared with a two-second skew allowance.
- **Language:** English in code and docs. UI strings in `en` and `de`, from one catalogue per surface.

## Review Focus

Five inputs that the spec implies but no acceptance criterion names. Each is pinned by a test in the owning task.

1. **A different installation answers at a stored origin** (DNS moved, or the VPS was rebuilt). The shell must not send the old token. It reads `/meta` unauthenticated first, sees the `installationId` mismatch, and asks to pair again. → Task 5 `a_different_installation_at_the_origin_gets_no_token`.
2. **The person navigates back to `/auth/ticket` after login** (history, reload). The used ticket is refused. The shell issues one fresh ticket; if that fails too, it shows its error page, never a blank webview and never a loop. → Task 7 `a_replayed_ticket_page_is_retried_once_then_shows_the_error`.
3. **The keychain refuses access** after an unsigned dev update (macOS ties item ACLs to the code signature) or because the person cancels the prompt. The shell treats this as "pairing needed" for that connection, keeps the connection row, and does not crash or retry in a loop. → Task 4 `access_denied_is_pairing_needed_not_a_crash`.
4. **Removing a connection when deleting the keychain entry fails.** The row is kept and the error is shown, so no token is left orphaned without a visible row. On success, the keychain entry goes first, then the row. → Task 3 `remove_keeps_the_row_when_the_token_delete_fails`.
5. **The harness is down when the app starts with a remote connection.** The tray shows `down`, and the `spa` window shows the shell's error page with *Retry*, never a blank or half-loaded SPA. SSE reconnects with backoff (1 s → 30 s), sending `Last-Event-ID`. → Task 8 `harness_down_at_start_shows_error_page_and_reconnects`.

---

## Rulings on spec gaps (binding for this plan)

| # | Gap | Ruling |
|---|---|---|
| DR1 | M3 is not planned in detail yet. Spec §6.14 names the surfaces the shell needs. | Task 2, Step 1 inventories M3 as merged. If M3 already provides a surface under another name, D1 uses M3's name and records the mapping in the ADR-004 implementation note (Task 12). Only missing surfaces are added, in `$API`. |
| DR2 | Notifications, deep links, autostart, global shortcut, "Install here" (spec §6.3). | D2. D1 has no `tauri-plugin-notification`, `-deep-link`, `-autostart` or `-global-shortcut`. |
| DR3 | Tauri 3 moves quickly. | D1 pins Tauri 2.12 exactly. A nightly `canary` job in `desktop.yml` builds the same sources against the latest `tauri 3.0.0-alpha.*` + `tauri-runtime-cef` with a patch file `apps/desktop/canary/tauri3.patch`. It may fail. Its result goes into the D1 test report, and the job is never a required check. |
| DR4 | Bundle formats. | macOS `.app` + `.dmg`; Windows NSIS only (`installMode: "currentUser"`, no admin; no MSI); Linux `.deb`, `.rpm`, AppImage. `bundle.createUpdaterArtifacts: true`. |
| DR5 | Bundle id, scheme and product name are owner questions. | One source of truth: `apps/desktop/src-tauri/src/ids.rs` (`BUNDLE_ID = "dev.plur1bus.desktop"`, `KEYCHAIN_SERVICE = BUNDLE_ID`, `PRODUCT = "PLUR1BUS"`), and `tauri.conf.json` `identifier` equal to it. A test asserts they match. Renaming later is one edit plus re-pairing. |
| DR6 | Shell-page technology. | Static HTML + TypeScript with no framework and no runtime dependency, at most five views (connections, add local, add remote, pairing progress, error). The M3 theme file is imported at build time as the only token source (ADR-004 action 3). If M3 moved it, Task 6 follows. |
| DR7 | Dev builds are OS-unsigned (spec §6.11). | macOS dev bundles are ad-hoc signed (`signingIdentity: "-"`). Windows and Linux dev bundles are unsigned. `docs/desktop.md` says how to open them (Gatekeeper *Open anyway*, SmartScreen *More info → Run anyway*). Updater signatures are **always** checked (they cannot be turned off). |
| DR8 | How to detect "no keychain" on Linux. | `open_default()` probes the store once with a set/get/delete of a random entry under `KEYCHAIN_SERVICE` + `.probe`. On failure it returns `MemoryStore` with `StoreKind::MemoryOnly`. The shell pages show the banner from spec §6.2 (5). |
| DR9 | Window close semantics. | Closing `spa` or `shell` hides the window. The app stays in the tray. *Quit* is in the tray menu (and Cmd-Q on macOS). The first time a window is hidden, a small in-window hint says where the app went (no OS notification in D1). |
| DR10 | What the tray subscribes to. | `GET /events?topics=harness.status` with the device bearer token. Tray states: `connecting`, `ready`, `degraded`, `down`, `unpaired`, mapped from M3's status event. If M3 has no bearer-token SSE, Task 2 adds the topic and the scope check. |
| DR11 | `milestones.md` §7 lists "Desktop shell" as out of scope for v0.1.0. | Task 12 changes that row to "not required for v0.1.0; optional track D (ADR-004 amendment 2026-09-27; spec 2026-09-27 desktop)" and adds a track-D paragraph after §M8. The v0.1.0 release checklist is unchanged. |
| DR12 | Local pairing needs the CLI to create a pairing code as the local user. | If `plur1bus device pair --json` exits non-zero with `E_DENIED` or is missing, the shell shows the code flow with a hint ("run `plur1bus device pair` as the harness owner"). D1 does not add a local-trust shortcut to the harness. |

**Out of scope for D1:** everything under D2–D4, OS code signing, a stable channel, any CEF code (apart from the canary patch), and multiple SPA windows (one `spa` window, bound to the active connection).

## Preconditions (checked in Task 2, Step 1)

M3 has merged with the harness API on loopback, the session cookie with CSRF, personal API tokens with scopes, D35 device pairing (`plur1bus device pair|list|revoke`, a redeem endpoint, tokens stored hashed), `/events` SSE, `/api/v1/meta` with capabilities, and the deny-by-default contract suite. If any of these is missing, stop and report BLOCKED with the list: D1 does not build M3.

## File structure

```
Cargo.toml                                   exclude = ["apps"] (T1)
pnpm-workspace.yaml                          + apps/desktop/ui (T1)
scripts/lint-hygiene.mjs                     tracked-secret-file check (T1)
apps/desktop/
  package.json                               @tauri-apps/cli pinned; scripts tauri, build:ui (T1)
  ui/  package.json (@plur1bus/desktop-ui), src/{main,views,pairing-model,origin-input,i18n}.ts,
       index.html, test/*.test.ts, build.mjs  (T6)
  canary/tauri3.patch, canary/README.md      (T10)
  src-tauri/
    Cargo.toml ([workspace] of its own), Cargo.lock, build.rs, tauri.conf.json,
    capabilities/shell-ui.json               (T1, T7)
    icons/                                   placeholder icons from the logo package, or generated neutral placeholders (T1)
    src/main.rs, lib.rs, ids.rs              (T1)
    src/connections.rs                       (T3)
    src/secrets.rs                           (T4)
    src/discovery.rs, client.rs, pair.rs     (T5)
    src/commands.rs                          shell-ui + spa-bridge commands (T5, T7)
    src/policy.rs, spa.rs                    (T7)
    src/tray.rs, events.rs                   (T8)
    src/logging.rs                           (T9)
    src/updater.rs                           (T9)
    tests/{config,connections,secrets,client,pairing,policy,spa,events,logging,updater}.rs
$API/…                                       run/api.json, meta.installationId, session tickets, desktop device scopes, bearer SSE (T2)
.github/workflows/desktop.yml, desktop-release.yml (T10)
docs/desktop.md (new), docs/api-surface.md, docs/adr/ADR-004-harness-api-and-web-ui.md, docs/milestones.md, AGENTS.md (T12)
```

## Task map

| # | Task | Produces (used by) |
|---|---|---|
| 1 | Scaffold `apps/desktop` (own workspace, config, CSP, ids, hygiene lint) | app skeleton, `ids.rs` (all) |
| 2 | Harness side: `run/api.json`, `meta.installationId`, session tickets, desktop scopes, bearer SSE | endpoints (5, 7, 8) |
| 3 | Connections store and origin rules | `Connection`, `Origin`, `Store` (5, 7, 8) |
| 4 | Token store: keychain or memory only | `TokenStore`, `SecretString` (5, 7, 8) |
| 5 | Discovery, harness client, pairing (local one-click, code) | `discover`, `HarnessClient`, `pair_local` (6, 7, 8) |
| 6 | Shell pages: connection manager and pairing UI | `ui/dist` (7, 11) |
| 7 | SPA window: incognito, ticket login, navigation guard, `spa-bridge` capability | `open_spa`, `policy` (8) |
| 8 | Tray, single instance, window lifecycle, `/events` status | `HarnessState` (9) |
| 9 | Log redaction; updater on the `dev` channel | `redact`, `updater::check` (10) |
| 10 | CI: `desktop.yml` five targets, canary; `desktop-release.yml` dev channel; SBOM, provenance | — |
| 11 | Accessibility and i18n pass; manual screen-reader record | — |
| 12 | Docs, ADR-004 implementation note, milestones §7, AGENTS.md, demo guide, test report | — |

---

### Task 1: Scaffold `apps/desktop`

**Files:**
- Create: `apps/desktop/package.json`, `apps/desktop/src-tauri/{Cargo.toml,build.rs,tauri.conf.json}`, `apps/desktop/src-tauri/src/{main.rs,lib.rs,ids.rs}`, `apps/desktop/src-tauri/capabilities/shell-ui.json`, `apps/desktop/src-tauri/icons/*`, `apps/desktop/ui/index.html` (placeholder "PLUR1BUS" page), `apps/desktop/src-tauri/tests/config.rs`
- Modify: `Cargo.toml` (`exclude = ["apps"]`), `pnpm-workspace.yaml`, `scripts/lint-hygiene.mjs`, `.gitignore` (`apps/desktop/src-tauri/target/`, `apps/desktop/ui/dist/`)

**Interfaces:**
- `ids.rs`: `pub const BUNDLE_ID: &str = "dev.plur1bus.desktop"; pub const KEYCHAIN_SERVICE: &str = BUNDLE_ID; pub const PRODUCT: &str = "PLUR1BUS";`
- `tauri.conf.json`:
  - `identifier` = `BUNDLE_ID`; `app.withGlobalTauri: false`; `app.security.freezePrototype: true`.
  - `app.security.csp` exactly the shell-page CSP from spec §6.9.
  - `app.security.capabilities: ["shell-ui"]`.
  - One window `shell` (`url: "index.html"`, `visible: false` until ready).
  - `build.frontendDist: "../ui/dist"`, `bundle.targets` per DR4, `bundle.windows.nsis.installMode: "currentUser"`, `bundle.macOS.signingIdentity: "-"`, `bundle.createUpdaterArtifacts: true`.
  - No `plugins` except those added by later tasks.
- `capabilities/shell-ui.json`: `windows: ["shell"]`, `permissions: ["core:default"]` minus anything not needed. Custom command permissions are added by Tasks 5 and 7.
- `lint-hygiene.mjs`: fails when `git ls-files` contains `*.p12`, `*.p8`, `*.pfx`, `*.key`, `*.pem`, `*.keystore`, or any file containing `untrusted comment: minisign secret key` or `-----BEGIN (ENCRYPTED )?PRIVATE KEY-----`. Allow-list: the `tauri.conf.json` public-key fields.

- [ ] **Step 1: Write the failing tests.** `tests/config.rs`:
  - `identifier_matches_ids_rs`
  - `csp_is_the_spec_string` (parse `tauri.conf.json`, compare exactly)
  - `global_tauri_is_off_and_prototype_frozen`
  - `no_forbidden_plugins_in_cargo_toml` (parses `Cargo.toml`; none of `tauri-plugin-{shell,fs,http,dialog,opener}`)
  - `nsis_is_current_user_only`

  In the root repo, the lint test `scripts/lint-hygiene.mjs` gets a fixture run (`node scripts/lint-hygiene.mjs --self-test`) that plants a temporary tracked `x.p12` in a temp git repo and expects failure.
- [ ] **Step 2: Run** → FAIL (no crate).
- [ ] **Step 3: Implement** the scaffold. `src-tauri/Cargo.toml` starts with an empty `[workspace]` table and has `rust-version = "1.95"`. `main.rs` calls `plur1bus_desktop::run()`, and `run()` builds the app with the `shell` window only. Generate `Cargo.lock` with `cargo generate-lockfile`.
- [ ] **Step 4: Run** the desktop part of Green, `pnpm tauri build --debug --no-bundle` on the local OS, and the root Green (it must not see the desktop crate) → PASS.
- [ ] **Step 5: Commit** `feat(desktop): scaffold Tauri 2.12 shell in apps/desktop (own workspace, CSP, ids, hygiene lint)`.

---

### Task 2: Harness side — discovery file, installation id, session tickets, desktop scopes, bearer SSE

**Files:** (under `$API` unless noted; exact paths are recorded in Step 1)
- Create: `src/desktop/ticket.ts` (issue/redeem store), `src/desktop/api-file.ts`, `test/desktop-ticket.test.ts`, `test/api-file.test.ts`, the static page for `/auth/ticket` inside the SPA build (a route of the SPA, not a separate app)
- Modify: route table (`POST /api/v1/auth/session-ticket`, `POST /api/v1/auth/ticket/redeem`), the device-kind enum (`desktop`) and scope list (`ui.session`, `events.read`), `/api/v1/meta` (`installationId`, capability `desktop.sessionTicket`), `/events` (bearer device token with `events.read`; topic `harness.status`), the deny-by-default suite, `docs/api-surface.md`

**Interfaces:**
- `run/api.json`:
  - Content: `{ "url": "http://127.0.0.1:<port>", "pid": <int>, "instanceId": "<per start>", "installationId": "<stable>", "apiVersion": "<semver>" }`.
  - Written atomically (tmp + rename, mode `0600`) after `listen()`; removed on clean stop.
  - A stale file is overwritten at the next bind.
  - `installationId` is created once at first start and stored in the state root.
- `POST /api/v1/auth/session-ticket`:
  - Auth: `Authorization: Bearer <device token>` with scope `ui.session`; any other principal gets `E_DENIED`.
  - Result: `{ ticket, expiresAt }`, where `ticket` is 32 random bytes base64url.
  - Stored hashed (SHA-256) with `{ deviceId, userId, expiresAt = now + 60 s, used: false }`.
  - At most 5 unexpired tickets per device (the oldest is dropped).
- `POST /api/v1/auth/ticket/redeem { ticket }`:
  - Unauthenticated, rate limited like login.
  - Valid, unused and unexpired → marks it used, creates a normal session for `userId`, attributes it to `deviceId` in the audit log, and returns a `Set-Cookie` without `Expires`/`Max-Age` plus `{ csrf }`.
  - Otherwise `401 E_AUTH reason=ticket-invalid` (one reason for all failure causes).
- `/auth/ticket` page: reads `location.hash` (`#t=…`), clears it with `history.replaceState`, POSTs redeem, then goes to `/`. On failure it goes to `/auth/ticket-failed`, which the shell's navigation guard recognises (Task 7).
- Audit events: `desktop.ticket.issue`, `desktop.ticket.redeem` (never the ticket value).
- Revoked device → every bearer call returns `401 E_AUTH reason=device-revoked`.

- [ ] **Step 1: Inventory M3 (DR1, preconditions).**
  - Locate `$API`, the route table, the device pairing implementation, the scope list, `/meta`, `/events` and the deny-by-default suite.
  - Write the mapping "spec §6.14 row → M3 name or MISSING" into the task report.
  - If any precondition is missing, stop with BLOCKED.
- [ ] **Step 2: Write the failing tests.**
  - `ticket issue needs a desktop device token with ui.session` (user session → `E_DENIED`; API token without scope → `E_DENIED`; revoked device → `device-revoked`).
  - `a ticket redeems exactly once`.
  - `an expired ticket is refused` (injected clock).
  - `redeem sets a session cookie without Expires or Max-Age`.
  - `the ticket value never appears in logs or audit` (capture the logger, search for the value).
  - `at most five open tickets per device`.
  - `api.json is written with mode 0600 after listen and removed on stop` (skip the mode check on win32).
  - `meta exposes installationId and desktop.sessionTicket without auth`.
  - `events accepts a device bearer token with events.read and refuses one without`.
  - The deny-by-default suite covers the two new routes (unauthenticated, Viewer, wrong scope).
- [ ] **Step 3: Run** → FAIL.
- [ ] **Step 4: Implement.** Ticket storage is in memory (tickets live 60 s; a restart drops them, which is correct). Update `docs/api-surface.md` with the two routes, their scope and rate-limit class, and the `/events` topic.
- [ ] **Step 5: Run** → PASS; root Green.
- [ ] **Step 6: Commit** `feat(api): desktop session tickets, run/api.json discovery, installationId, desktop device scopes (desktop D1)`.

---

### Task 3: Connections store and origin rules

**Files:**
- Create: `apps/desktop/src-tauri/src/connections.rs`, `tests/connections.rs`

**Interfaces:**
```rust
pub struct Origin(String);                       // normalised "scheme://host[:port]", lower-case host, IDN as punycode
pub enum OriginError { Invalid, Scheme, InsecureRemote, HasUserinfo, HasPath }
impl Origin { pub fn parse(input: &str) -> Result<Origin, OriginError>; pub fn is_loopback(&self) -> bool; pub fn as_str(&self) -> &str; }
pub enum Kind { Local, Remote }
pub struct Connection { pub id: Uuid, pub name: String, pub kind: Kind, pub origin: Origin,
                        pub installation_id: String, pub device_id: String, pub token_hint: String }
pub struct Store { path: PathBuf }
impl Store {
  pub fn open(dir: &Path) -> Store;                               // <dir>/connections.json
  pub fn load(&self) -> Result<Vec<Connection>, StoreError>;      // missing file → empty; corrupt → StoreError::Corrupt (file kept as .corrupt-<ms>)
  pub fn upsert(&self, c: Connection) -> Result<(), StoreError>;  // atomic tmp+rename, 0600 on unix
  pub fn remove(&self, id: Uuid, tokens: &dyn TokenStore) -> Result<(), StoreError>; // token first, then row
  pub fn active(&self) -> Result<Option<Uuid>, StoreError>; pub fn set_active(&self, id: Uuid) -> Result<(), StoreError>;
}
```
Rules (spec §6.2):
- `https` with any host;
- `http` only for `127.0.0.1`, `[::1]`, `localhost`;
- no userinfo, path other than `/`, query or fragment;
- a default port is dropped;
- the file format is `{ "version": 1, "active": <uuid|null>, "connections": [...] }`, with unknown fields refused.

- [ ] **Step 1: Write the failing tests.**
  - `origin_accepts_https_and_loopback_http_only` (table: `http://10.0.0.5` → `InsecureRemote`, `http://localhost:18700` ok, `https://vps.example.ts.net` ok, `https://u:p@x` → `HasUserinfo`, `https://x/app` → `HasPath`, `ftp://x` → `Scheme`)
  - `origin_normalises_case_default_port_and_idn`
  - `store_round_trips_and_writes_0600` (unix)
  - `a_corrupt_file_is_kept_aside_not_overwritten`
  - `unknown_fields_are_refused`
  - Review Focus 4: `remove_keeps_the_row_when_the_token_delete_fails` and `remove_deletes_token_then_row` (both with a fake `TokenStore` from Task 4's trait; Task 3 defines a local test double until Task 4 lands)
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; desktop Green.
- [ ] **Step 5: Commit** `feat(desktop): connection store and origin rules (https or loopback http only)`.

---

### Task 4: Token store — keychain or memory only

**Files:**
- Create: `apps/desktop/src-tauri/src/secrets.rs`, `tests/secrets.rs`
- Modify: `Cargo.toml` (`keyring =4.2.0` with the native store features for macOS, Windows and Linux Secret Service, `zeroize`)

**Interfaces:**
```rust
pub struct SecretString(zeroize::Zeroizing<String>);  // Debug/Display → "***"; no Serialize; expose() -> &str
pub enum StoreKind { Keychain, MemoryOnly }
pub enum TokenError { AccessDenied, Unavailable(String), Other(String) }   // messages never contain the secret
pub trait TokenStore: Send + Sync {
  fn get(&self, id: Uuid) -> Result<Option<SecretString>, TokenError>;
  fn set(&self, id: Uuid, token: &SecretString) -> Result<(), TokenError>;
  fn delete(&self, id: Uuid) -> Result<(), TokenError>;   // missing entry is Ok
  fn kind(&self) -> StoreKind;
}
pub struct KeyringStore; pub struct MemoryStore;
pub fn open_default() -> Box<dyn TokenStore>;           // DR8 probe
pub fn token_hint(t: &SecretString) -> String;           // last 4 characters
```
Keychain entry: service `ids::KEYCHAIN_SERVICE`, account = the connection UUID as a string. The probe account is `KEYCHAIN_SERVICE + ".probe-" + random`, deleted after the probe.

- [ ] **Step 1: Confirm the `keyring` 4.2 store features** on docs.rs (4.x split the stores into separate crates). Record the exact feature names and store constructors in the task report and use them. If 4.2 cannot select native stores without the `db-keystore` fallback, pin the newest 3.x with `apple-native`, `windows-native` and `linux-native-sync-persistent`, and record why.
- [ ] **Step 2: Write the failing tests.**
  - `secret_string_debug_and_display_are_redacted`
  - `memory_store_round_trip_and_delete_missing_is_ok`
  - Review Focus 3: `access_denied_is_pairing_needed_not_a_crash` (a fake store returns `AccessDenied`; the caller helper `load_token_or_pairing_needed` returns `PairingNeeded`, and the connection row is untouched)
  - `open_default_falls_back_to_memory_when_the_probe_fails` (injected failing backend)
  - Behind `PLUR1BUS_DESKTOP_REAL_KEYCHAIN=1`: `real_keychain_round_trip`, with a random service name that is deleted in a drop guard. CI runs it on macOS and Windows (Task 10).
  - The plan-wide scan helper `assert_no_token_on_disk(dir, token)` (reads every file under the directory, including subdirectories, and fails on any occurrence), used here and in Tasks 5 and 7.
- [ ] **Step 3: Run** → FAIL.
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run** → PASS; desktop Green; the real-keychain test once on the local OS if it is macOS or Windows.
- [ ] **Step 6: Commit** `feat(desktop): token store on the OS keychain with memory-only fallback, redacted SecretString`.

---

### Task 5: Discovery, harness client, pairing

**Files:**
- Create: `apps/desktop/src-tauri/src/{discovery.rs,client.rs,pair.rs,commands.rs}`, `tests/{client,pairing}.rs`
- Modify: `capabilities/shell-ui.json` (permissions for `connections_list`, `connections_rename`, `connections_remove`, `pair_local`, `pair_code`, `open_connection`, `app_info`), `lib.rs` (managed state: `Store`, `Box<dyn TokenStore>`, `HarnessClient` factory)

**Interfaces:**
```rust
// discovery.rs
pub fn state_root() -> PathBuf;   // PLUR1BUS_HOME, else ~/.plur1bus (POSIX) or %LOCALAPPDATA%\PLUR1BUS (D5)
pub struct LocalHarness { pub origin: Origin, pub pid: u32, pub instance_id: String, pub installation_id: String, pub api_version: String }
pub async fn discover(root: &Path) -> Option<LocalHarness>;   // reads run/api.json; checks origin is loopback; GET /meta must answer
                                                              // with the same installationId; else None. Never reads run/*.token.
// client.rs
pub struct Meta { pub api_version: String, pub installation_id: String, pub capabilities: Vec<String> }
pub struct Redeemed { pub device_id: String, pub token: SecretString }
pub struct Ticket { pub ticket: SecretString, pub expires_at: SystemTime }
pub enum ClientError { Revoked, Unauthorized, Incompatible { server: String, client: String }, MissingCapability(&'static str),
                       InstallationMismatch, Network(String), Protocol(String) }
pub struct HarnessClient { /* reqwest::Client: rustls, timeout 10 s, redirect::Policy::none(), no cookies */ }
impl HarnessClient {
  pub fn new(origin: Origin) -> Self;
  pub async fn meta(&self) -> Result<Meta, ClientError>;                                      // unauthenticated
  pub async fn redeem(&self, code: &str, name: &str) -> Result<Redeemed, ClientError>;        // D35 redeem, kind "desktop"
  pub async fn session_ticket(&self, expected_installation: &str, token: &SecretString) -> Result<Ticket, ClientError>;
}
pub const SUPPORTED_API_MAJOR: u64 = 1;   // M3's major; Task 5 sets it from Step 1 of Task 2
// pair.rs
pub fn resolve_cli() -> Option<PathBuf>;  // known install locations only: <state root>/bin, the platform's user bin dir, then PATH lookup of "plur1bus" (absolute result required)
pub struct PairCode { pub code: String, pub expires_at: SystemTime }
pub fn pair_local(cli: &Path, name: &str) -> Result<PairCode, PairError>;  // spawn with fixed args: device pair --json --kind desktop --name <name>; 15 s timeout; parse `device.pair/1`
pub enum PairError { CliMissing, Denied, Failed(String) }
// commands.rs (shell-ui capability; each checks webview label == "shell")
#[tauri::command] async fn pair_local(...) -> Result<ConnectionView, UiError>;   // discover → pair_local → redeem → keychain → store
#[tauri::command] async fn pair_code(input: PairCodeInput { origin: String, code: String, name: String }) -> Result<ConnectionView, UiError>;
#[tauri::command] fn connections_list() -> Vec<ConnectionView>;   // ConnectionView has no token, only token_hint and store kind
```
Every authenticated call first runs `meta()`. It refuses when `installation_id` differs from the stored one (Review Focus 1), when the API major is unsupported, or when `desktop.sessionTicket` is missing. `401 reason=device-revoked` → `ClientError::Revoked` → the caller deletes the token and marks the connection `pairing needed`.

- [ ] **Step 1: Write the failing tests** (wiremock harness).
  - `meta_parses_and_rejects_an_unsupported_major`
  - `redeem_stores_the_token_in_the_token_store_only` (then `assert_no_token_on_disk(config_dir, token)`)
  - Review Focus 1: `a_different_installation_at_the_origin_gets_no_token` (wiremock asserts that no request carried `Authorization`)
  - `revoked_deletes_the_token_and_marks_pairing_needed`
  - `redirects_are_not_followed`
  - `discover_ignores_a_stale_api_json` (dead pid / refused connection)
  - `discover_ignores_a_non_loopback_url_in_api_json`
  - `discover_never_opens_token_files` (the temp state root contains `run/core.token` with a sentinel; the test wraps file access through a seam `discovery::read_file`, and a debug-build counter asserts that only `run/api.json` was read)
  - `pair_local_spawns_fixed_args_and_parses_json` (a fake `plur1bus` script in a temp dir: POSIX shell script, and a `.cmd`-free Windows `.exe` built from a tiny test binary target `tests/bin/fake-plur1bus.rs`)
  - `pair_local_denied_falls_back_to_code_flow` (DR12)
  - `pair_code_rejects_insecure_remote_before_any_request`
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; desktop Green.
- [ ] **Step 5: Commit** `feat(desktop): local discovery, harness client and pairing (one-click local, code flow), installation check before any token`.

---

### Task 6: Shell pages — connection manager and pairing UI

**Files:**
- Create: `apps/desktop/ui/{package.json,build.mjs,index.html}`, `apps/desktop/ui/src/{main.ts,views.ts,pairing-model.ts,origin-input.ts,i18n.ts,ipc.ts}`, `apps/desktop/ui/src/i18n/{en,de}.json`, `apps/desktop/ui/test/{pairing-model,origin-input,i18n}.test.ts`
- Modify: `apps/desktop/src-tauri/tauri.conf.json` (`build.beforeBuildCommand: "pnpm --filter @plur1bus/desktop-ui build"`)

**Interfaces:**
- `ipc.ts` is the only module that touches `window.__TAURI_INTERNALS__.invoke`, through `@tauri-apps/api/core` bundled by esbuild (a build-time dependency, not a runtime CDN). It exposes typed wrappers for the Task 5 commands.
- `pairing-model.ts`: a pure state machine `idle → discovering → local-found | local-missing → pairing → paired | error(kind)`, and a code path `code-entry → validating → pairing → paired | error`. Errors: `cli-missing`, `denied`, `insecure-origin`, `installation-mismatch`, `incompatible`, `network`, `revoked`, `keychain-memory-only` (banner, not an error).
- `origin-input.ts`: the same rules as `Origin::parse`, for instant feedback only. The Rust side stays authoritative.
- Views (DR6): *Connections* (list, active marker, rename, remove, *Open*), *Add local* (one click; shows the one-line installer command from `docs/desktop.md` when no harness is found), *Add remote* (origin, code, name; a hint recommending `tailscale serve`), *Pairing progress*, *Error*.
- Theme: import the M3 theme file (the `--oc-*` bridge with its MIT header) at build time. No token values are copied.
- Strings come only from `i18n/{en,de}.json`. Locale follows the OS (`navigator.language`) with an override stored in the connections file (`uiLocale`).

- [ ] **Step 1: Write the failing tests.**
  - `pairing-model: local happy path, cli-missing falls back to code entry, revoked returns to code entry`
  - `origin-input: same table as the Rust origin tests` (the table lives in `apps/desktop/src-tauri/tests/fixtures/origin-cases.json` and is read by both sides)
  - `i18n: en and de have identical key sets and no empty strings`
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** Visible focus, labels bound to inputs, `aria-live="polite"` for progress and errors, and every action reachable from the keyboard.
- [ ] **Step 4: Run** → PASS. `pnpm tauri dev` shows the connection manager, and a manual local pairing against a dev harness works. Record this in the report.
- [ ] **Step 5: Commit** `feat(desktop): connection manager and pairing views (de/en, theme from the M3 token source)`.

---

### Task 7: SPA window — incognito, ticket login, navigation guard, `spa-bridge`

**Files:**
- Create: `apps/desktop/src-tauri/src/{policy.rs,spa.rs}`, `tests/{policy,spa}.rs`
- Modify: `commands.rs` (`open_connection`, `shell_info`), `lib.rs`

**Interfaces:**
```rust
// policy.rs (pure, unit-tested)
pub enum NavDecision { Allow, OpenExternal, Block }
pub fn spa_navigation(conn: &Origin, url: &Url) -> NavDecision;
  // same origin → Allow; https/http elsewhere → OpenExternal; `mailto:` → OpenExternal; everything else (file:, data:, javascript:, plur1bus:, ipc:, tauri:, blob: of another origin) → Block
pub enum PolicyError { WrongWebview, WrongOrigin }
pub fn check_spa_caller(label: &str, current: &Url, conn: &Origin) -> Result<(), PolicyError>;  // label == "spa" && origin(current) == conn
// spa.rs
pub async fn open_spa(app: &AppHandle, conn: &Connection, tokens: &dyn TokenStore) -> Result<(), UiError>;
  // 1. token or PairingNeeded; 2. client.session_ticket (runs meta + installation check);
  // 3. create or reuse WebviewWindow "spa": incognito(true), drag_drop_enabled(false), initial URL = <origin>/auth/ticket#t=<ticket>,
  //    on_navigation → spa_navigation (OpenExternal via the platform opener in Rust), on_new_window → Block;
  // 4. app.add_capability(spa-bridge for exactly <origin>/*, webviews ["spa"], permissions: ["allow-shell-info"]);
  //    an existing spa-bridge capability for another origin is replaced before the navigation;
  // 5. when the webview reaches <origin>/auth/ticket-failed: retry once with a fresh ticket, then load the shell error page (Review Focus 2).
#[tauri::command] fn shell_info(webview: Webview) -> Result<ShellInfo, UiError>;   // check_spa_caller first
pub struct ShellInfo { pub product: &'static str, pub version: String, pub platform: String, pub arch: String,
                       pub features: Vec<&'static str> }   // D1: []  (later: "panel", "ptt", …)
```
The SPA feature-detects the shell with `window.__TAURI_INTERNALS__?.invoke`. That detection belongs to the SPA and is not part of this plan, apart from the `/auth/ticket` page from Task 2.

- [ ] **Step 1: Write the failing tests.**
  - policy: `navigation_table` (same origin, another https origin, `javascript:`, `file:`, `plur1bus://open`, `data:` top level → the decisions above) and `caller_check_rejects_other_webview_and_other_origin`.
  - spa (Tauri mock runtime, feature `tauri/test`):
    - `shell_info_is_the_only_spa_command` (every other registered command called from label `spa` → rejected);
    - `spa_bridge_capability_is_scoped_to_the_connection_origin` (inspect the runtime capability set after `open_spa`);
    - `switching_connection_replaces_the_capability`.

    If the mock runtime cannot express remote-origin capabilities, test through `policy.rs` plus a recorded manual check, and write a ruling in the report.
  - wiremock + mock runtime: Review Focus 2 `a_replayed_ticket_page_is_retried_once_then_shows_the_error`.
  - After a full open/close cycle: `assert_no_token_on_disk(app_dirs, token)` and `no_cookie_database_in_app_dirs` (incognito: no `Cookies`/`cookies.sqlite`/WebKit `Cookies.binarycookies` file for the harness origin appears under the app data directory).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** For external links, use a Rust-side platform opener (`open` on macOS, `ShellExecuteW` on Windows, `xdg-open` on Linux) through a tiny wrapper that accepts only `https:`, `http:` and `mailto:` URLs that `spa_navigation` has already classified.
- [ ] **Step 4: Run** → PASS; desktop Green. Manually: pair locally, the SPA opens logged in, quit and restart logs in again, a link to another site opens the system browser. Record this.
- [ ] **Step 5: Commit** `feat(desktop): SPA in an incognito webview with ticket login, navigation guard and origin-scoped spa-bridge`.

---

### Task 8: Tray, single instance, window lifecycle, `/events` status

**Files:**
- Create: `apps/desktop/src-tauri/src/{tray.rs,events.rs}`, `tests/events.rs`
- Modify: `Cargo.toml` (`tauri` feature `tray-icon`, `tauri-plugin-single-instance =2.5.0`), `lib.rs`, `tauri.conf.json`

**Interfaces:**
```rust
pub enum HarnessState { Connecting, Ready, Degraded, Down, Unpaired }
pub fn map_status(ev: &serde_json::Value) -> HarnessState;   // from M3's harness.status event (DR10); unknown → Degraded
pub struct EventStream;   // GET /events?topics=harness.status, Bearer device token, Accept: text/event-stream
impl EventStream { pub fn spawn(client: HarnessClient, token: SecretString, tx: watch::Sender<HarnessState>) -> JoinHandle<()>; }
  // backoff 1 s ×2 up to 30 s with ±20 % jitter; sends Last-Event-ID; Revoked → Unpaired and stops
```
- **Tray menu:** header `PLUR1BUS — <connection name>` with a state label; *Open PLUR1BUS*; *Connections…*; *Switch connection ▸* (one item per connection); *Check for updates* (Task 9); *Quit*.
- **Icon:** one icon per state, monochrome template on macOS. A tooltip says the state in words, so colour never carries the meaning alone.
- **Single instance:** a second launch focuses the existing `spa` window (or `shell` when nothing is paired) and exits.
- **Window close** hides (DR9). *Quit* stops the event streams before exit.
- **Linux without an AppIndicator host:** the tray build returns an error, the app keeps `skip_taskbar(false)`, and the shell page shows a one-time hint.

- [ ] **Step 1: Write the failing tests.**
  - `map_status_table`
  - `stream_reconnects_with_backoff_and_last_event_id` (wiremock: first response closes after one event with `id: 7`; the second request must carry `Last-Event-ID: 7`)
  - `revoked_stream_goes_unpaired_and_stops`
  - Review Focus 5: `harness_down_at_start_shows_error_page_and_reconnects` (state `Down` within 2 s; `open_spa` loads the shell error page, not the harness URL; after the mock comes up, the state becomes `Ready` and *Retry* succeeds)
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; desktop Green. Manually on each OS you have: the tray reflects `plur1bus daemon stop` / `start` within one backoff step.
- [ ] **Step 5: Commit** `feat(desktop): tray with harness state from /events, single instance, hide-on-close`.

---

### Task 9: Log redaction; updater on the `dev` channel

**Files:**
- Create: `apps/desktop/src-tauri/src/{logging.rs,updater.rs}`, `tests/{logging,updater}.rs`, `apps/desktop/src-tauri/keys/dev.pub` (the owner's dev **public** key; until the owner provides one, CI generates a throwaway key per run and the committed file holds a clearly marked placeholder that fails release builds)
- Modify: `Cargo.toml` (`tauri-plugin-updater =2.13.0`, `tracing`, `tracing-appender`), `tauri.conf.json` (`plugins.updater.pubkey` filled from `keys/dev.pub` by `build.rs`; `endpoints: ["https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/releases/download/desktop-dev/latest.json"]`; Windows `installMode: "passive"`), `tray.rs` (*Check for updates*), `lib.rs`

**Interfaces:**
```rust
// logging.rs
pub fn init(dir: &Path) -> WorkerGuard;   // daily files, 7 kept, 5 MiB cap each
pub fn redact(line: &str) -> Cow<'_, str>;
  // removes: Authorization/Cookie/Set-Cookie header values; "token"/"ticket"/"csrf"/"code" JSON values; URL query and fragment of every URL;
  // any 43+ char base64url run; the value of PLUR1BUS_* env vars
// updater.rs
pub const CHANNEL: &str = "dev";                      // D2 adds "stable" through a build-time cfg, never at run time
pub async fn check(app: &AppHandle, manual: bool) -> Result<UpdateOutcome, UpdateError>;
pub enum UpdateOutcome { UpToDate, Installed { version: String }, Declined }
```
- Checks run at start (unless `settings.updates.checkOnStart == false`, stored in the connections file) and from the tray.
- An update is shown in the shell page with its version and release notes. Install happens only after the person confirms.
- `build.rs` fails a `--release` build when `keys/dev.pub` still holds the placeholder and `PLUR1BUS_DESKTOP_ALLOW_PLACEHOLDER_KEY` is not set. CI sets that variable only for unsigned PR artefacts, which have no feed.

- [ ] **Step 1: Write the failing tests.**
  - `redact_removes_tokens_tickets_cookies_and_url_fragments` (a planted `SecretString`, ticket, `Set-Cookie`, `https://h/auth/ticket#t=…`, `?code=…`)
  - `the_log_file_never_contains_a_planted_token` (drive the client against wiremock with a planted token, then scan the log directory with `assert_no_token_on_disk`)
  - updater, run at test time:
    1. generate a throwaway minisign key pair;
    2. build a fake update archive and `latest.json` served by wiremock;
    3. point the plugin at them through the debug-only seam `PLUR1BUS_DESKTOP_UPDATER_ENDPOINT` + `PLUR1BUS_DESKTOP_UPDATER_PUBKEY`;
    4. tests: `a_correctly_signed_update_is_accepted`, `a_tampered_payload_is_refused`, `a_signature_from_another_key_is_refused`, `a_lower_version_is_not_offered`.
  - `release_build_refuses_the_placeholder_key` (runs `build.rs` logic as a unit)
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; desktop Green.
- [ ] **Step 5: Commit** `feat(desktop): redacting logger and signed updater on the dev channel`.

---

### Task 10: CI — five targets, canary, dev release, SBOM, provenance

**Files:**
- Create: `.github/workflows/desktop.yml`, `.github/workflows/desktop-release.yml`, `apps/desktop/canary/{tauri3.patch,README.md}`, `apps/desktop/scripts/{repro-check.mjs,render-latest-json.mjs}`

**Interfaces:**
- **`desktop.yml`**
  - Triggers: `pull_request` and `push` with paths `apps/desktop/**`, `.github/workflows/desktop.yml`, plus `schedule` nightly.
  - Job `test`, matrix: `macos-15` (aarch64-apple-darwin), `windows-2025` (x86_64-pc-windows-msvc), `windows-11-arm` (aarch64-pc-windows-msvc), `ubuntu-24.04` (x86_64-unknown-linux-gnu), `ubuntu-24.04-arm` (aarch64-unknown-linux-gnu, bare metal). Steps: toolchain from `rust-toolchain.toml`; Linux deps; `pnpm install --frozen-lockfile`; UI tests; `cargo fmt --check`; `clippy --locked -D warnings`; `cargo test --locked`; real-keychain smoke on macOS and Windows (`PLUR1BUS_DESKTOP_REAL_KEYCHAIN=1`); `pnpm tauri build` with `PLUR1BUS_DESKTOP_ALLOW_PLACEHOLDER_KEY=1`, uploading unsigned bundles as artefacts (7-day retention).
  - Job `canary` (schedule only, `continue-on-error: true`): applies `canary/tauri3.patch` (bumps to the latest `tauri 3.0.0-alpha.*` and enables `tauri-runtime-cef`) and runs `cargo build` on the five targets.
  - Job `repro` (schedule only, Linux x64): builds the unsigned `.deb` twice from clean checkouts with `SOURCE_DATE_EPOCH=$(git log -1 --format=%ct)` and `RUSTFLAGS=--remap-path-prefix=$PWD=.`, then compares SHA-256. Advisory (spec §6.12).
- **`desktop-release.yml`**
  - Trigger: `workflow_dispatch` with input `channel: dev`. D2 adds `stable` and the tag trigger.
  - `environment: desktop-dev` (required reviewer: owner), secret `TAURI_SIGNING_PRIVATE_KEY` + `_PASSWORD`.
  - Builds the five targets and signs the updater artefacts.
  - `render-latest-json.mjs` writes `latest.json` from the `.sig` files.
  - Replaces the assets of the prerelease `desktop-dev`, generates a CycloneDX SBOM per target (`cargo cyclonedx` pinned), and adds provenance with `actions/attest-build-provenance` (SHA-pinned).
  - `permissions:` minimal (`contents: write` on the release job only, `id-token: write` + `attestations: write` for attestation).
- Fork PRs never see a secret (no `pull_request_target` anywhere).

- [ ] **Step 1: Write the checks first.** `node scripts/lint-hygiene.mjs` extension: `workflows_pin_actions_by_sha` (every `uses:` in `desktop*.yml` is `owner/repo@<40 hex>`), `no_pull_request_target`, `release_jobs_use_an_environment`. Run → FAIL (no workflows).
- [ ] **Step 2: Write the workflows and scripts.**
- [ ] **Step 3: Run** the lint → PASS. Push is not allowed (Global Constraints), so validate with `actionlint` if available, and record that the first real run happens when the owner pushes the branch.
- [ ] **Step 4: Commit** `ci(desktop): five-target build and test, Tauri 3 canary, dev release with signed updater feed, SBOM and provenance`.

---

### Task 11: Accessibility and i18n pass

**Files:**
- Modify: `apps/desktop/ui/**` (fixes), the M3 a11y runner config (add `apps/desktop/ui/dist/index.html` with each view reachable through a `?view=` debug parameter honoured only in debug builds), `apps/desktop/src-tauri/src/tray.rs` (menu labels from the catalogue)
- Create: `apps/desktop/ui/test/a11y.test.ts` (if M3's runner is invoked from tests). The screen-reader checklist lives in the test report (Task 12), not in a new doc.

- [ ] **Step 1: Run** the axe-core runner over every view in both themes and both locales → record the violations. Expected: some.
- [ ] **Step 2: Fix** until clean. Check keyboard traversal (Tab order, Enter/Space, Escape closes dialogs) and 4.5:1 contrast in both themes.
- [ ] **Step 3: Tray and menus.** Labels come from the catalogue (de/en). The state is spoken in words (tooltip and menu header), never only as colour.
- [ ] **Step 4: Manual screen-reader pass** where hardware is available (VoiceOver, NVDA, Orca): pairing local, pairing remote, opening the SPA, the error page. Record findings in the report and name any OS that could not be checked.
- [ ] **Step 5: Run** desktop Green and the a11y runner → PASS.
- [ ] **Step 6: Commit** `fix(desktop): WCAG 2.1 AA and keyboard pass on the shell pages; localized tray`.

---

### Task 12: Docs, ADR note, milestones, AGENTS.md, demo guide, test report

**Files:**
- Create: `docs/desktop.md`
- Modify: `docs/adr/ADR-004-harness-api-and-web-ui.md` (implementation note under the 2026-09-27 amendment), `docs/milestones.md` (DR11), `docs/api-surface.md` (checked from Task 2), `AGENTS.md`

- [ ] **Step 1: `docs/desktop.md`** covers:
  - what the app is and is not (an optional client; no policy of its own);
  - installing a dev build per OS (DR7 steps);
  - pairing locally and remotely, with the recommended `tailscale serve` setup (the harness API stays on loopback; D72) and why self-signed pinned remotes are refused (DS6);
  - where the token lives per OS, and the memory-only mode on Linux;
  - revoking a device;
  - update channels and the key-loss procedure (spec §6.11);
  - known degradations per target (spec §6.10, D1 column).
- [ ] **Step 2: ADR-004 note.** Record:
  - the DR1 mapping (spec §6.14 → M3 names);
  - DS3/DS5 as built (incognito SPA, fragment ticket, non-persistent cookie);
  - the runtime capability approach and whether the mock-runtime test or the manual check proved it (Task 7);
  - the `keyring` version and features chosen (Task 4);
  - that the shell adds no policy.
- [ ] **Step 3: `milestones.md`.** Change the §7 row and add the track-D paragraph (DR11) with D1–D4 from spec §7 and their dependencies.
- [ ] **Step 4: AGENTS.md.** Add `apps/desktop` to the layout table (own workspace, the Green commands above), the debug-only seams (`PLUR1BUS_DESKTOP_CONFIG_DIR`, `PLUR1BUS_DESKTOP_REAL_KEYCHAIN`, `PLUR1BUS_DESKTOP_UPDATER_ENDPOINT`, `PLUR1BUS_DESKTOP_UPDATER_PUBKEY`, `PLUR1BUS_DESKTOP_ALLOW_PLACEHOLDER_KEY`), and the rule that no desktop key file is ever committed.
- [ ] **Step 5: Demo guide and test report** (milestones §6.1 item 7), in the PR description draft:
  - demo: local one-click pairing → SPA; remote pairing over a tailnet URL; revoke → back to pairing; quit/restart → logged in; tray states; a dev update;
  - the report maps spec §8 criteria 1–9 to tests or manual records, lists the canary result, the repro-check result and the screen-reader findings, and states what was skipped and why.
- [ ] **Step 6: Run** `pnpm docs:check`, `pnpm lint`, and both Greens.
- [ ] **Step 7: Commit** `docs(desktop): user guide, ADR-004 implementation note, milestones track D, AGENTS.md`.

---

## D2 — Native integration and signed stable releases (outline; own full plan after D1 merges)

Same Global Constraints. Tasks named, not detailed:

1. **Notifications** (`tauri-plugin-notification`). The harness decides what is notified (`/events` topic `notifications`, scope `events.read`). Lock-screen text is minimal by default, with a preview setting. Clicking opens the SPA route through the same `spa_navigation` check.
2. **Global shortcut and push-to-talk** (`tauri-plugin-global-shortcut`).
   - Person-chosen binding, no default.
   - `ptt:down/up` goes to the SPA as a Tauri event, allowed only for the `spa` webview on its origin.
   - The microphone permission is granted only to the connection origin (`NSMicrophoneUsageDescription`; WebView2 `PermissionRequested`; WebKitGTK `permission-request`).
   - On Wayland: an in-window shortcut plus a tray item, and the portal as a later option.
   - Commands `shell_ptt_bind`, `shell_notify_prefs` join `spa-bridge`.
3. **Deep links** (`tauri-plugin-deep-link` + single-instance).
   - `plur1bus://pair` pre-fills and needs confirmation; `plur1bus://open?path=` checks the route allow-list; everything else is ignored.
   - Command-line links take the same path.
   - Tests for spoofed arguments and IDN origins.
4. **Autostart** (`tauri-plugin-autostart`, LaunchAgent on macOS): off by default, starts minimised, never starts the harness.
5. **"Install here"** (spec §6.1). Download `plur1bus` for the target from the release manifest, check SHA-256 plus the OS signature (`codesign --verify --strict` + `spctl --assess`; `WinVerifyTrust`), then run `plur1bus setup --non-interactive --json` with progress. Needs H3b-b-1.
6. **macOS signing and notarisation** in `desktop-release.yml`: environment `desktop-release`, `APPLE_CERTIFICATE`/`_PASSWORD`, App Store Connect API key for notarytool, stapling, hardened runtime, minimal entitlements.
7. **Windows signing** with the owner's choice (spec §11 Q1): SignPath Foundation through its GitHub Action with CI origin verification, or an OV certificate on a cloud HSM through `signCommand`. The NSIS installer and the exe are both signed; the SmartScreen note stays in the docs.
8. **Linux:** GPG-signed AppImage (`SIGN=1`, `APPIMAGETOOL_FORCE_SIGN=1`), signed `.deb`/`.rpm` checksums file, and a published public key.
9. **`stable` channel:** its own updater key (DS12), tag `desktop-v*` trigger, release notes, and a rotation drill documented.
10. **Docs, ADR note, demo, report.**

## D3 — CEF panel and egress (outline)

Precondition, the **Tauri 3 gate**: Tauri 3 is at least beta, `tauri-runtime-cef` has left alpha, and the canary plus the five-target smoke are green for 14 consecutive nights. The harness has shipped the D72 port registry lease API, D73 egress profiles with `egress.resolve`, and D74 b streamed Chromium.

1. **Runtime move:** apply the canary patch for real, migrate APIs, pin CEF version + SHA, measure the installed size per target, and add `DowngradePolicy::KeepProfile`.
2. **Sandbox gating (DS8):** `SandboxPolicy::Required` for panels. Detect Windows (unsandboxed upstream) and restricted AppImage, then fall back to streamed Chromium with an explanation. Tests per target.
3. **Panel webviews:** a side panel that collapses, resizes, detaches into its own window and re-attaches without losing state. F6 focus handoff. `shell_panel_*` commands in `spa-bridge`. Panels get no capability at all. Scheme allow-list, download quarantine.
4. **Profiles and egress (DS11):** `data_store_identifier = panel-<profile>`, `proxy_url` from `egress.resolve`, `DisableNonProxiedUdp` while any proxied panel exists, fail-closed tests (tunnel down → requests fail, never direct), and the remote-harness profile filter.
5. **CDP:**
   - the token proxy on a leased loopback port (Bearer token, `Origin` rejected, `Host` pinned) and the remote relay over `/ws` (scope `panel.serve`, `panel.register`);
   - the method allow-list; only panel targets; `RemoteDebugging::Disabled` asserted;
   - tests with a hostile local client (a browser-origin request, a wrong Host, a wrong token, a forbidden method).
6. **Agent visibility and handover:** the "Agent is using this panel" bar, *Take over*, *Stop*, and the `browser` skill handover API (login, CAPTCHA). Downloads need an approval.
7. **CEF update duty:** the 14-day rule in the release process, the 60-day panel support window enforced from release metadata, and the canary kept.
8. **Accessibility** of the panel (VoiceOver, NVDA, Orca) and **docs, ADR note, demo, report**.

## D4 — Computer-use onboarding and WebMCP bridge (outline)

1. **macOS onboarding (DS10):** detect `CuaDriver.app`; read grant status from its diagnose command; `x-apple.systempreferences:` deep links for Accessibility and Screen & System Audio Recording; a 2-s re-check while focused; guidance for the TCC flapping issue.
2. **Linux and Windows guidance:** explain the Wayland portal consent; Windows needs no grant.
3. **Tray indicator and kill switch** for running computer-use sessions (harness API from spec §6.14, D4 row).
4. **WebMCP consumer in panels (D55 b):** native detection over CDP, otherwise a main-world shim through `Page.addScriptToEvaluateOnNewDocument` + `Runtime.addBinding`; `pageToolsToMcp`, `normalizePageToolResult`; payload limits (64 KiB, 64 tools); the harness bridge applies `isOriginAllowed` and D30 approval. Tests with a hostile page.
5. **Flatpak** if the owner says yes (spec §11 Q3): a `flatpak-builder` manifest from the `.deb`, and the CEF sandbox inside Flatpak (a zypak-style launcher, or panel off inside Flatpak).
6. **Docs, ADR note, demo, report.**

---

## Self-review (done while writing)

- **Spec coverage (D1):**
  - DS1 → Tasks 5, 6 (no bundled harness; installer command shown).
  - DS2 → Task 1 (Tauri 2.12 pinned), Task 10 (canary).
  - DS3/DS5 → Tasks 2, 7. DS4 → Task 4. DS6 → Tasks 3, 5. DS7 → Tasks 1, 5, 7. DS12 → Tasks 9, 10. DS13 → Task 1.
  - §6.1 → Task 5. §6.2 → Tasks 2–5, 7. §6.9 (D1 parts) → Tasks 1, 7, 9. §6.10 D1 column → Tasks 1, 10. §6.11 dev channel → Tasks 9, 10. §6.12 → Task 10. §6.13 → Tasks 6, 11. §6.14 D1 rows → Task 2.
  - DS8–DS11 are D3/D4 and outlined there.
- **Acceptance (spec §8):**
  - 1 → Tasks 4, 5, 7 (`assert_no_token_on_disk`, keychain).
  - 2 → Tasks 3, 5. 3 → Task 5 (`revoked_…`), Task 8 (stream). 4 → Task 7. 5 → Tasks 2, 7. 6 → Task 9 (+ manual macOS record in Task 12). 7 → Task 10. 8 → Task 11. 9 → Task 9.
- **Review Focus:** 1 → Task 5, 2 → Task 7, 3 → Task 4, 4 → Task 3, 5 → Task 8.
- **Type consistency:**
  - `Origin`/`Connection`/`Store` (Task 3) are used in Tasks 5, 7, 8.
  - `TokenStore`/`SecretString`/`assert_no_token_on_disk` (Task 4) are used in Tasks 3 (test double), 5, 7, 9.
  - `HarnessClient`/`Meta`/`ClientError` (Task 5) are used in Tasks 7, 8.
  - `spa_navigation`/`check_spa_caller` (Task 7) are reused in D2 for notification clicks and deep links.
  - `HarnessState` (Task 8) feeds the tray and D4's computer-use indicator.
- **Constraints:** no secret file is committed (Task 1 lint, Task 9 placeholder guard); no policy is added to the shell (every permission is an `$API` scope checked by `authorize()`, Task 2); no client imitation (the webviews keep their default user agents; no claude.ai sign-in surface).
