# Desktop app D1: container bundle and thin shell (written in full) · D2–D4 (outline): Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Scope note.** Track D builds the desktop app from spec D74, **D77** (the app ships the harness as containers) and **D78** (release and update policy). This plan was rewritten on 2026-09-27 when D77 overruled the original "attach, never bundle" design. **D1 is written in full below** (20 tasks): the harness image, installers per OS, runtime detection with first-class support for Apple `container` and Docker-compatible runtimes, a first-run wizard, start/stop/status, auto-pair, the tray, and the D78 update flow with a checksummed snapshot, a health gate and automatic rollback. Attaching to a remote harness (and to a native local harness) stays as a secondary mode. **D2** (native integration, OS-signed releases), **D3** (browser container, CEF panel, egress) and **D4** (computer use, WebMCP bridge) are outlined at the end; each gets its own full plan after the milestone before it merges.

**Goal:** A person downloads one installer for macOS arm64, Windows x64/arm64 or Linux x64/arm64 and clicks "Weiter, weiter, fertig". The app finds Apple `container` or a Docker-compatible runtime (or, on macOS 26+, installs the Apple `container` package it already carries inside the app; on Windows/Linux without a runtime, downloads and runs the vendor's own checksum-verified installer), loads the pinned harness image, creates its volumes and container, starts it, creates the owner and pairs itself over `exec`, and opens the harness's own SPA, already logged in. The harness runs in one container, publishes its API on host loopback only, restarts on failure and starts at login. The tray shows harness and runtime state. The device token sits only in the OS keychain. Updates arrive only as versioned releases with German/English notes; the person chooses *Jetzt / Später / Überspringen*; an upgrade snapshots the data, migrates, passes a health gate and otherwise rolls back automatically. A remote harness (for example `https://vps.tailnet.ts.net`) can still be paired with a code.

**Architecture:** One Tauri 2.12 app in `apps/desktop/`, with its own Cargo workspace and lockfile, plus container-mode additions to the harness binary and core in the root workspace, plus a harness image.
- **Rust core of the app:**
  - `runtime/` — detection, the Apple `container` adapter (CLI with `--format json`), the Docker Engine API adapter (`bollard`), and a runtime-neutral `Runtime` trait;
  - `controller/` — `bundle.json`, image acquisition by digest, volumes, network, the container spec, start/stop/status/logs, the restart watch, autostart, and the upgrade state machine;
  - `connections`, `secrets` (keychain), `client` (reqwest/rustls: `/meta`, redeem, session ticket, `/events`), `pair` (auto-pair over `exec`, native one-click, code flow), `bridge` (host bridge, `host.keyUnlock`), `updates` (signed `release.json` feed, Tauri updater, dialog state), `tray`, `logging`.
- **Windows:** `shell` (bundled static pages: wizard, connections, settings, update dialog, progress, errors) and `spa` (incognito; the harness origin; one runtime capability with `shell_info`).
- **Harness side (root workspace):** `plur1bus init` (PID 1), container-mode refusals, hidden `plur1bus state snapshot|verify|restore`, `1staid check` rows (`container`, `storage`, `engine.storeSchema`), core RPC `admin.smoke` + `plur1bus admin smoke`, product `version` in `/api/v1/meta`, CLI forwarding mode (`target.json`), and the M3-surface additions of spec §6.14 (tickets, `run/api.json`, desktop scopes, bearer SSE, the `/ws` host-bridge endpoint).
- **Image:** `plur1bus-harness`, `linux/arm64` + `linux/amd64`, assembled from natively built artefacts, cosign-signed with SBOM and provenance; `deploy/compose.yaml` and Podman quadlet units use the same image.

**Tech Stack:**
- **Rust 1.95** (`rust-toolchain.toml`), exact pins in the desktop workspace: `tauri =2.12.0`, `tauri-build` (same release), `tauri-plugin-updater =2.13.0`, `tauri-plugin-single-instance =2.5.0`, `tauri-plugin-autostart =2.6.0`, `keyring =4.2.0` (Task 8 confirms features), `bollard` (newest release on the day Task 6 starts, pinned exactly, `ssl` off, Unix socket and named pipe features on), `minisign-verify` (feed signature), `reqwest` (rustls, `stream`, no default features), `tokio`, `serde`/`serde_json`, `url`, `uuid` (v7), `sha2`, `zeroize`, `tracing` + `tracing-appender`.
- **Rust dev dependencies:** `wiremock`, `tempfile`, `minisign` (sign test feeds and updates at test time).
- **Shell pages:** TypeScript 5.9 via esbuild 0.28 (the repo's versions), no framework, no runtime dependencies, `node:test`; the axe-core runner from M3.
- **Image and CI:** Docker Buildx (assembly only, no QEMU compilation), `cosign` (keyless, GitHub OIDC), `syft` or `cargo cyclonedx` + the Node SBOM tool M8 uses (Task 4 records the choice), `actions/attest-build-provenance`, `registry:2` as a local registry in CI.

**Spec:** `docs/superpowers/specs/2026-09-27-desktop-app-design.md`. Binding sections:
- §2: DS1–DS36 (DS28–DS36 added 2026-09-27, closing §11: update-manifest hosting, D1/v0.1.0, the two installer variants, signing/Store, the `plur1bus.app` domain, Flatpak, the Windows CEF resolution, the Windows ACL follow-up);
- §4.10–§4.22: the evidence the adapters and the newly-decided channels rely on (Apple `container`, Docker-compatible runtimes, storage semantics, CI runners, MSIX/Store, Flatpak sandboxing, GitHub Releases limits, Windows named-pipe DACLs);
- §6.1–§6.3, §6.8 (autostart, moved to D1), §6.9, §6.10 (D1/D2 column and "what every installer carries"), §6.11, §6.12, §6.13, §6.14 (D1 rows);
- §6.15 (container bundle) in full, §6.16 (release and update policy) in full, including §6.16.7 (update-manifest hosting);
- §7 (D1 gates v0.1.0);
- §8: acceptance 1–15, 5a, 5b;
- §13 (added 2026-09-27): the owner's design canvas is the source of truth for UI (https://claude.ai/artifact/CRjk86mofQ9vqhb2twu8wS, page `v2 · Glow`). No canvas board exists for any D1 shell page; Tasks 12, 13, 14, 17 and 19 name the boards they borrow from (§13.4). The §13.5 conflicts are open owner questions, not rulings of this plan.

Also binding: core spec D35, D77, D78 and §6.5 (amended); ADR-004 and its 2026-09-27 amendment (no own policy layer); ADR-005 (secrets); ADR-007 (effective rights = role ∩ token scopes, deny by default); ADR-012 including §11 (container mode); ADR-013 §5 (the supervisor owns `config.json`); ADR-016 §3 (capabilities, not version sniffing); milestones §6.3 (D78).

**All eight owner questions in spec §11 are now decided** (owner, 2026-09-27, second follow-up; see spec DS28–DS36): signing (Q1: SignPath Foundation submitted and pending for direct NSIS, plus a Microsoft Store MSIX channel), bundle id and scheme (Q2: `app.plur1bus.desktop`, `plur1bus://`, domain `plur1bus.app`, not `.dev` — see DR5), Flatpak (Q3: yes, via Flathub), the Windows CEF gap (Q4: accepted as designed — the container browser stays primary on Windows until CEF's sandbox lands; **re-decided 2026-09-27**, spec DS37: the Windows panel is a native WebView2 and the container browser serves windowless cases only), D1 as a v0.1.0 gate (Q5: yes, D1 gates v0.1.0), image registry (Q6: not public yet, public on GHCR from the first tagged release — DR17), models in the offline installer (Q7: yes, included by default), and automatic patch updates (Q8: **on** by default for new installs — DR20). **None of this changes D1's own scope or schedule**: D1 still ships the direct-channel build first (DR7's OS-signing sequencing is unaffected by the Store channel existing — see DR22), still treats the offline tarball as the default install path pre-first-release (DR17), and still lands before D2's OS-signed `stable` promotion. The Store (DR22) and Flatpak (DR23) channels, and the `updates.plur1bus.app` manifest host (DR21), are D1 work items now that they are decided, not deferred to D2+.

---

## Repository, branch, and how to run anything

**Work repo (`$HARNESS`):** `/home/claude/PLUR1BUS-Harness`. Cut branch **`feat/desktop-d1`** from `main` **after M3 has merged**, using the `superpowers:using-git-worktrees` skill. Every path below is relative to that worktree.

**`$API`:** the package that holds M3's harness API server (routes, `authorize()`, device pairing). Task 2, Step 1 finds it and records its path. Harness-side API paths below are relative to `$API`.

**Node:** `export PATH=/home/claude/.node24/bin:$PATH`. **Linux build dependencies for Tauri** (CI installs them; locally once): `libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libsecret-1-dev patchelf`. **Container runtime for local tests:** Docker Engine or Podman on Linux; the real-runtime tests are skipped unless `PLUR1BUS_DESKTOP_E2E_RUNTIME=docker|podman|apple` is set.

**Green** means all of:

```bash
# root repo
pnpm install --frozen-lockfile && pnpm gen && pnpm build && pnpm lint && pnpm test \
  && cargo fmt --all -- --check && cargo clippy --workspace --all-targets -- -D warnings \
  && cargo test --workspace --no-fail-fast && pnpm docs:check
cargo build --release -p plur1bus && PLUR1BUS_BIN=target/release/plur1bus \
  node --experimental-strip-types --test tests/system/*.test.ts
# desktop
cd apps/desktop/src-tauri && cargo fmt -- --check && cargo clippy --locked --all-targets -- -D warnings \
  && cargo test --locked --no-fail-fast && cd ../../.. && pnpm --filter @plur1bus/desktop-ui test
# image (Linux with Docker or Podman)
node deploy/image/build-local.mjs && node deploy/image/smoke.mjs
```

**One desktop Rust test:** `cd apps/desktop/src-tauri && cargo test --locked --test <file> <name> -- --nocapture`. **A dev run:** `cd apps/desktop && pnpm tauri dev`. **An unsigned bundle:** `pnpm tauri build --bundles <dmg|nsis|deb,rpm,appimage>`. **A local image:** `node deploy/image/build-local.mjs` (builds the root workspace release artefacts for the host arch, then assembles the image and prints its digest).

---

## Global Constraints

Every task's requirements implicitly include this section.

- **Commits:** `git -c user.name=Cyb3rb1ade -c user.email=84099452+Cyb3rb1ade@users.noreply.github.com commit …`. Every message body ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01SxcLhve6hyM9AFm2nU9B3F`. Never `git stash`, never `--amend`, never push, never change git config (use `-c` only).
- **No secrets and no real user data** in code, fixtures, logs, test names, images or CI artefacts. Tokens, tickets, updater and feed key pairs are generated at test time. Names and hosts are synthetic (`harness.test`, `vps.example.ts.net`). Upgrade fixtures are produced by a synthetic workload only. No test touches the real keychain unless `PLUR1BUS_DESKTOP_REAL_KEYCHAIN=1` (random service name, deleted afterwards). No test reads or writes `~/.plur1bus`, the real app config directory or the person's real runtime objects: `PLUR1BUS_DESKTOP_CONFIG_DIR` (debug builds only) points into a temp directory, and every runtime object a test creates carries the label `app.plur1bus.test=<run id>` and a name prefix `p1t-<run id>-`, and is removed by a drop guard.
- **No own policy layer** (ADR-004 amendment). The shell may refuse or hide, but never grants what the harness has not granted. Every harness-side addition goes through `authorize()` and gets a row in the deny-by-default suite.
- **The device token is never on disk and never in JavaScript.** Keychain, Rust memory as `SecretString`, and the `Authorization` header of the shell's own requests only. Never in a log line, error, `Debug` output, command result, event payload, `connections.json`, `upgrades.json`, a container label, an environment variable or an `exec` argument. `assert_no_token_on_disk` (Task 8) and the redaction test (Task 15) enforce it.
- **Container rules (DS16, §6.15.5, §6.15.7), asserted by `create_spec_is_exact` (Task 7):**
  - the API is published on `127.0.0.1:<port>` only; nothing else is published;
  - no runtime socket, no `--privileged`, no host network, no device, no home-directory mount;
  - user `10001:10001`, read-only root file system, `tmpfs /tmp`; Docker: `--cap-drop ALL`, `no-new-privileges`, `--pids-limit 1024`, `RestartPolicy unless-stopped`, `StopTimeout 150`; Apple: no `--cap-add`, `stop -t 150`;
  - memory limit from the wizard (default 3 GiB), CPUs `min(4, host cores)`;
  - environment only `PLUR1BUS_CONTAINER=1`, `PLUR1BUS_HOME=/var/lib/plur1bus`, `TZ`, `LANG`, and during an upgrade `PLUR1BUS_UPGRADE_FROM` — never a secret;
  - state only on the named volumes `plur1bus-state` and `plur1bus-models`.
- **Images are referenced by digest** from `bundle.json` everywhere in app code; a tag never selects what runs. The page and every command take no image reference, mount path, port or command from JavaScript.
- **Subprocesses** only with fixed argument vectors: the Apple `container` CLI (absolute path, code signature checked), `plur1bus device pair` for a native local harness, `installer`/`open` for the Apple pkg the person confirmed, `systemctl --user enable --now podman.socket` after the person clicked it. The Docker path spawns nothing.
- **IPC allow-list** (DS7): only the commands named in this plan exist; each validates input with a `#[serde(deny_unknown_fields)]` struct and checks the calling webview's label and current origin. No `tauri-plugin-shell`, `-fs`, `-http`, `-dialog` or `-opener`. `app.withGlobalTauri: false`, `app.security.freezePrototype: true`.
- **Root workspace changes** are limited to what Tasks 3, 10 and 2 name (container mode, forwarding, API surfaces), `Cargo.toml` `exclude = ["apps"]`, `pnpm-workspace.yaml` gaining `apps/desktop/ui`, the hygiene lint, `deploy/`, workflows and docs. The supervisor's dependency budget (no tokio) holds: container-mode code in `crates/plur1bus` is synchronous std code.
- **Pins:** the desktop `Cargo.lock` is committed; CI uses `--locked` and `--frozen-lockfile`; Actions pinned by full commit SHA; the image base pinned by digest.
- **CI green** on `ci.yml`, `desktop.yml` (five targets) and `container.yml`. Windows rules from earlier plans still apply: `fileURLToPath`, no `fs.realpathSync.native`, `pnpm` through a shell.
- **Clocks:** durations on `Instant`; wall time only for `expiresAt`, reminders and quiet hours, compared with a two-second skew allowance and injected in tests.
- **Language:** English in code and docs. UI strings, release notes and progress/rollback messages in `de` and `en` from one catalogue per surface.

## Review Focus

Inputs the spec implies but no acceptance criterion names. Each is pinned by a test in the owning task.

1. **A different installation answers at a stored origin** (a rebuilt VPS, or a native harness now on the port the bundled one used). No token is sent; `/meta`'s `installationId` mismatch leads to re-pairing. → Task 9 `a_different_installation_at_the_origin_gets_no_token`.
2. **The runtime disappears mid-session** (Docker Desktop quit, `container system stop`). The tray shows `runtime stopped` with *Start runtime* where the app can start it; the app never switches to another runtime silently and never deletes anything. → Task 7 `runtime_gone_is_reported_not_switched`.
3. **The app quits or the machine loses power in the middle of an upgrade.** `upgrades.json` journals the step before it starts; on the next start the state machine resumes deterministically: before the swap → discard the partial snapshot and start the old container; after the swap → the rollback path of §6.15.8 step 8. → Task 16 `interrupted_upgrade_resumes_at_every_step`.
4. **Port 18700 is taken** (a native harness or anything else). The controller picks the next free port in 18700–18799, never stops or signals the other process, and the connection keeps working after a restart that picks a different port. → Task 7 `port_in_use_picks_the_next_and_keeps_the_connection`.
5. **The disk fills during the snapshot.** The snapshot fails, the partial snapshot volume is removed, the old container starts unchanged, and the person sees "Nicht genug Speicherplatz für die Sicherung". → Task 16 `snapshot_disk_full_restarts_the_old_version_unchanged`.
6. **The keychain refuses access** (unsigned build, cancelled prompt). "Pairing needed" for that connection; for the bundled connection the app re-pairs over `exec` automatically once, then asks. No crash, no loop. → Task 8 `access_denied_is_pairing_needed_not_a_crash`.
7. **A second runtime appears later** (the person installs Docker Desktop after using Apple `container`). Detection lists it; the bundled harness stays on its runtime; switching is only offered as backup/restore (DS14). → Task 6 `a_new_runtime_is_listed_not_adopted`.

---

## Rulings on spec gaps (binding for this plan)

| # | Gap | Ruling |
|---|---|---|
| DR1 | M3 is not planned in detail yet; spec §6.14 names the surfaces the shell needs. | Task 2, Step 1 inventories M3 as merged. Existing surfaces under other names are used under M3's name, and the mapping goes into the ADR-004 implementation note (Task 20). Only missing surfaces are added. |
| DR2 | D2 items. | Notifications, deep links, global shortcut, push-to-talk, `host.notify|localModel|filePick`, vault and backup bind mounts, the Windows WSL fallback, OS signing and `deploy/upgrade.sh` are D2. **Autostart is D1** (spec §6.8, moved by D77). |
| DR3 | Tauri 3 moves quickly. | Tauri 2.12 pinned. A nightly `canary` job builds against the latest `tauri 3.0.0-alpha.*` + `tauri-runtime-cef` with `apps/desktop/canary/tauri3.patch`; never a required check; its result goes into the test report. |
| DR4 | Bundle formats and variants. | macOS `.app` in `.dmg`; Windows **NSIS** (`installMode: "currentUser"`) for the direct channel plus **MSIX** for the Store channel (DR22); Linux `.deb`, `.rpm`, AppImage plus a **Flatpak** (DR23). Two content variants per target (offline models roughly +600 MB, spec DS30/§11 Q7): **online** (no image, no models; pulls by digest and downloads models on first run) and **offline** (adds `resources/image/plur1bus-harness-<arch>.oci.tar` and the default embedding/reranker model files). The Store and Flatpak channels ship the **online** variant only (their own distribution mechanism handles the download; an offline MSIX/Flatpak is not built in D1). `bundle.createUpdaterArtifacts: true` on the direct/online NSIS and DMG targets only; the MSIX target builds with the updater plugin excluded (DR22) so it produces no updater artifact. |
| DR5 | Bundle id, scheme, product name (Q2). | One source of truth `apps/desktop/src-tauri/src/ids.rs` (`BUNDLE_ID = "app.plur1bus.desktop"`, `KEYCHAIN_SERVICE = BUNDLE_ID`, `PRODUCT = "PLUR1BUS"`, `CONTAINER = "plur1bus-harness"`, `LABEL_PREFIX = "app.plur1bus"`); `tauri.conf.json` `identifier` equals it; a test asserts it. |
| DR6 | Shell-page technology. | Static HTML + TypeScript, no framework, no runtime dependency. Views: *Wizard* (Welcome, Runtime, Install runtime, Resources, Installing, Done), *Connections*, *Add remote*, *Settings* (Runtime, Updates, Version, Advanced), *Update dialog*, *Progress*, *Error*. The M3 theme file is the only token source. |
| DR7 | OS signing arrives in D2 (Q1, decided: SignPath Foundation submitted and pending, plus a Microsoft Store channel). | D1's **direct** bundles are OS-unsigned (macOS ad-hoc) until SignPath Foundation's application clears review — D1 does not block on that approval; it ships the SmartScreen-noted build regardless and the signature swaps in transparently once approved, with no `ids.rs`/manifest change. D1 publishes `dev` and `beta` on the direct channel; the `stable` path (feed, key, promotion workflow) is built and tested with test keys, but the **first real `stable` promotion on the direct channel waits for SignPath's approval or D2's OS signing, whichever lands first**. The **Store channel is signed by Store ingestion from D1's first Store submission** (DR22), independent of SignPath's timeline. Updater and feed signatures are always checked on the direct channel; the Store channel has no in-app updater to check (DR22). `docs/desktop.md` explains *Open anyway* / *Run anyway* for the direct channel. |
| DR8 | "No keychain" on Linux. | `open_default()` probes the store once (set/get/delete of `KEYCHAIN_SERVICE.probe-<random>`); failure → `MemoryStore` with a banner. For the **bundled** connection, memory-only is acceptable because auto-pair over `exec` re-creates a device at each app start (the previous device is revoked by the same `exec` step, so devices do not pile up). |
| DR9 | Window close semantics. | Closing `spa` or `shell` hides it; the app stays in the tray. *Quit PLUR1BUS* asks whether to stop the harness too (default: keep running). |
| DR10 | Tray subscription. | `GET /events?topics=harness.status` with the device bearer token; tray harness states `starting`, `ready`, `degraded`, `down`, `unpaired`, `updating`, `rollback`, `crashed`, combined with runtime states `ready`, `stopped`, `missing`. If M3 has no bearer-token SSE, Task 2 adds the topic and the scope check. |
| DR11 | `milestones.md`. | Already amended by the D77/D78 docs change (track D table, §6.3, §7 row, M8). Task 20 only updates it if D1's measured numbers change an estimate. |
| DR12 | Native local pairing needs the CLI to create a code as the local user. | If `plur1bus device pair --json` exits non-zero with `E_DENIED` or is missing, the shell shows the code flow with a hint. D1 adds no local-trust shortcut to the harness. (Bundled pairing uses `exec` and is unaffected.) |
| DR13 | Apple `container` details the docs leave open (digest references, loading a buildx OCI tarball, JSON shapes). | Task 5 starts with a spike on a macOS 26 Apple-silicon Mac (the owner's, or the self-hosted runner). Outcomes are recorded in the task report and as fixtures. Fallbacks, chosen by the spike: pull by tag then compare `RepoDigests`/`index digest` with `bundle.json` and refuse on mismatch; if `image load` rejects the OCI tarball, the release workflow also produces an Apple-loadable archive with `container image save` on the self-hosted runner and the offline macOS installer carries that one. |
| DR14 | Where container-mode harness code lives. | `crates/plur1bus` (`init`, `state`, forwarding, `1staid` rows) as synchronous std code; `packages/core` (`admin.smoke`, `/meta` version via M3's API package). The desktop app never links root-workspace crates; it talks to the harness only through the runtime (`exec`) and the HTTP API. |
| DR15 | Creating the owner non-interactively. | Task 2, Step 1 maps M3's owner bootstrap. If M3 has no `plur1bus user create --owner --json` (or equivalent printing `{ userId }`), Task 2 adds it, refusing when an owner already exists (`E_EXISTS`), so re-running the wizard never creates a second owner. |
| DR16 | `bollard` version. | Task 6 pins the newest release exactly and records it; it uses only `/_ping`, `/version`, images (`load`, `create` = pull, `inspect`), volumes, networks, containers (`create`, `start`, `stop`, `inspect`, `logs`, `rename`, `remove`, `wait`) and `exec`. |
| DR17 | Image registry (Q6, **decided** 2026-09-27: not public for now, public on GHCR — `ghcr.io/cyb3rb1ade/plur1bus-harness` — from the project's first release on). | D1 itself lands before that first tagged release, so it still treats the **offline tarball** as the default install path and tests pull-by-digest against a private `registry:2` container in CI, exactly as before the decision. The registry host is a `bundle.json` field, so switching it to public GHCR at the first release is a release-workflow change, not a code change to D1's controller. |
| DR18 | Apple `container` in CI (DS23). | Hosted runners cannot run it. The adapter is tested against `apps/desktop/src-tauri/tests/bin/fake-container.rs` replaying recorded `--format json` fixtures. A workflow `apple-container.yml` (`workflow_dispatch`, `runs-on: [self-hosted, macOS, ARM64, macos-26-container]`, never required) runs `apps/desktop/scripts/apple-e2e.mjs`; the same script is the recorded manual check, writing `apple-e2e-<version>.json` that the release gate requires before promotion to `stable`. |
| DR19 | Test seams. | Debug builds only: `PLUR1BUS_DESKTOP_CONFIG_DIR`, `PLUR1BUS_DESKTOP_REAL_KEYCHAIN`, `PLUR1BUS_DESKTOP_APPLE_CLI` (path to the fake CLI), `PLUR1BUS_DESKTOP_DOCKER_CANDIDATES` (JSON list replacing the socket list), `PLUR1BUS_DESKTOP_FEED_URL` + `PLUR1BUS_DESKTOP_FEED_PUBKEY`, `PLUR1BUS_DESKTOP_UPDATER_ENDPOINT` + `_PUBKEY`, `PLUR1BUS_DESKTOP_CLOCK` (fixed epoch for reminders), `PLUR1BUS_DESKTOP_ALLOW_PLACEHOLDER_KEY`, `PLUR1BUS_DESKTOP_E2E_RUNTIME`. Harness side: `PLUR1BUS_TEST_FAIL_SMOKE=1` and `PLUR1BUS_TEST_FAIL_MIGRATION=1` (each with `PLUR1BUS_ALLOW_TEST_INTERNALS=1`) for the injected upgrade failures. |
| DR20 | Automatic patch updates (Q8, decided: **on** by default). | The setting exists and works, defaults to **on** for a fresh install (an existing install that explicitly turned it off is never re-enabled by an update), and, being a patch-only path, always runs the same snapshot → health gate → automatic-rollback sequence §6.15.8 already specifies for a manual *Jetzt* — no separate "unattended" code path exists to diverge from it. |
| DR21 | Updater manifest host (DS28). | The Tauri updater's `endpoints` and `plur1bus update`'s feed URL both read `https://updates.plur1bus.app/{channel}.json`, never a `github.com` URL. Task 9 (updater) fetches this manifest, verifies its minisign signature with the channel's embedded public key, then resolves `platforms.<target>.url`/`.signature` (a GitHub Releases asset) and, for the harness upgrade, `harnessImages.<arch>` (a GHCR digest `bundle.json` reads). CI serves a fake manifest from `PLUR1BUS_DESKTOP_FEED_URL` (DR19); production points at the real host, which is out of scope for D1 to stand up (a static file the release workflow publishes, not application code). |
| DR22 | Microsoft Store MSIX channel (Q1, decided: yes, alongside SignPath). | `apps/desktop/src-tauri/tauri.conf.json` gets a Store-specific bundle target (`msix`) built by a separate CI job that produces an **unsigned** MSIX (Store ingestion signs it); that job's output is what gets uploaded to Partner Center, manually, for D1 (no automated Store submission in D1's scope — Task 20's report names Partner Center submission as a post-D1 owner action). The Store build compiles with `tauri-plugin-updater` **excluded** (Store policy, spec §4.19/DS32) and shows release notes for information only, sourced from the same `release.json` the direct channel reads. A `PLUR1BUS_DESKTOP_STORE_BUILD=1` compile-time flag (checked in `ids.rs` and the updater init) is the single switch between the two Windows build outputs from one codebase. Full-trust MSIX packaging means DS14's Docker/Podman detection code (named pipes, `bollard` over the Engine API) needs **no** Store-specific branch (spec §4.19) — this is asserted with a test that runs the detection unit tests unchanged under a simulated MSIX `AppData` redirection. |
| DR23 | Linux Flatpak (Q3, decided: yes, via Flathub). | A `flatpak/app.plur1bus.desktop.yml` manifest (GNOME runtime, matching the existing Tauri/Flatpak precedent) is added alongside the `.deb`/`.rpm`/AppImage bundle targets; Task 19 (Linux CI) adds a `flatpak-builder` build and a local-repo smoke install (`flatpak install --user`), not a Flathub submission (that is a post-D1, one-time owner/maintainer step against the upstream Flathub repo). The manifest declares **no runtime dependency** (matching AppImage's stance, DR-adjacent to the existing "Recommends" wording) and opens a `--filesystem` hole per detected runtime socket path (spec §4.20, DS34) rather than `--filesystem=host`; the Linux installer's `systemctl --user enable --now podman.socket` one-click (Task 19) runs through `flatpak-spawn --host` when `FLATPAK_ID` is set, and through a direct `Command::new("systemctl")` otherwise — one code path branching only on that env var. The D3 CEF-in-Flatpak sandbox question stays explicitly out of scope for D1/D2 (spec DS34). |
| DR24 | Windows CEF gap (Q4, decided: accepted as designed). | No plan change: D1 and D2 ship no CEF code at all (DR4's canary patch aside), so the panel is a D3 concern end to end. This entry exists only to record that the question is closed and D3's own plan does not need to revisit whether the container-browser fallback is acceptable on Windows — it is. **Superseded 2026-09-27** (spec DS37–DS39): the Windows panel is a native WebView2 over in-process CDP; still no D1/D2 impact, the D3 outline below carries the change. |
| DR25 | Windows ACL follow-up (owner 2026-09-27, spec DS36). | **Out of scope for D1**: this is a harness (root-workspace) change to the supervisor's own Windows path (`crates/plur1bus/src/supervisor`), not an `apps/desktop` change, and D1 never links root-workspace crates (DR14). It is tracked in `docs/superpowers/plans/2026-09-27-m1b-2a-h3b-config-modules-setup-repair.md`'s "2a-H3b-b — outline", item H3b-b-7, and in ADR-012 §11. D1's container image is unaffected either way: the harness inside `plur1bus-harness` runs on Linux, where this Windows-only ACL question does not arise; it matters only for a **native** Windows install (§6.5, secondary path) and for D2's Windows WSL-distro fallback, neither of which is D1 scope. |

**Out of scope for D1:** everything under D2–D4 except the Store (DR22) and Flatpak (DR23) channels named above, OS code signing beyond what SignPath/Store ingestion already provide, a real `stable` promotion on the direct channel (DR7), any CEF code apart from the canary patch, the browser and SearXNG containers, multiple SPA windows, Store submission to Partner Center and Flathub submission (both one-time owner actions after D1's build output exists), and the Windows ACL follow-up (DR25, a harness change, not a desktop one).

## Preconditions (checked in Task 2, Step 1)

M3 has merged with the harness API on loopback, the session cookie with CSRF, personal API tokens with scopes, D35 device pairing (`plur1bus device pair|list|revoke`, a redeem endpoint, hashed tokens), `/events` SSE, `/api/v1/meta` with capabilities, users with an owner role, and the deny-by-default contract suite. The ADR-005 secret store exists (M2) with an encrypted-file backend whose key can be supplied at run time. If any of these is missing, stop and report BLOCKED with the list: D1 does not build M3 or M2.

## File structure

```
Cargo.toml                                    exclude = ["apps"] (T1)
pnpm-workspace.yaml                           + apps/desktop/ui (T1)
scripts/lint-hygiene.mjs                      tracked-secret-file check, workflow checks (T1, T18)
scripts/release-notes-lint.mjs                (T18)
release-notes/                                <version>.de.md, <version>.en.md, TEMPLATE.{de,en}.md (T18)
crates/plur1bus/src/
  commands/init.rs                            PID 1 (T3)
  commands/state.rs                           state snapshot|verify|restore (T3)
  commands/firstaid.rs                        + container, storage, engine.storeSchema rows (T3)
  container.rs                                PLUR1BUS_CONTAINER detection, refusals (T3)
  forward.rs                                  host CLI forwarding via target.json (T10)
packages/core/src/admin-smoke.ts              admin.smoke (T3)
packages/rpc-schema/schema/rpc.schema.json    + admin.smoke (T3)
$API/…                                        tickets, api.json, installationId, version, desktop scopes, bearer SSE,
                                              owner bootstrap (DR15), /ws host bridge, bridge.serve, host.keyUnlock (T2)
deploy/
  image/Dockerfile, image/assemble.mjs, image/build-local.mjs, image/smoke.mjs, image/size-budget.json (T4)
  compose.yaml, quadlet/plur1bus-harness.container, quadlet/*.volume (T4)
tests/upgrade/workload.mjs, tests/upgrade/verify.mjs (T18)
apps/desktop/
  package.json, canary/{tauri3.patch,README.md} (T1, T18)
  bundle/bundle.json.tmpl, bundle/release.schema.json (T7, T15)
  scripts/{apple-e2e.mjs,record-apple-fixtures.mjs,render-feed.mjs,repro-check.mjs} (T5, T15, T18)
  ui/  package.json, build.mjs, index.html, src/{main,ipc,i18n,views/*,models/*}.ts, src/i18n/{en,de}.json, test/*.test.ts (T12)
  src-tauri/
    Cargo.toml, Cargo.lock, build.rs, tauri.conf.json, capabilities/shell-ui.json, icons/, keys/{dev,beta,stable}.pub (T1, T15)
    resources/image/ (offline variant only, filled by CI) (T17)
    src/main.rs, lib.rs, ids.rs (T1)
    src/runtime/{mod,detect,apple,docker,spec}.rs (T5, T6)
    src/controller/{mod,bundle,acquire,lifecycle,watch,autostart,upgrade,journal}.rs (T7, T16)
    src/connections.rs, secrets.rs (T8)
    src/client.rs, pair.rs, discovery.rs (T9)
    src/bridge.rs (T11)
    src/commands.rs, policy.rs, spa.rs (T9, T12, T13)
    src/tray.rs, events.rs (T14)
    src/logging.rs, updates.rs (T15)
    src/install/{apple_pkg,podman_socket}.rs (T17)
    tests/*.rs, tests/bin/{fake-container.rs,fake-plur1bus.rs}, tests/fixtures/{apple/,docker/,origin-cases.json,feeds/} 
.github/workflows/desktop.yml, container.yml, apple-container.yml, desktop-release.yml, release.yml, release-promote.yml (T18)
docs/desktop.md, docs/releasing.md (new), docs/api-surface.md, docs/adr/ADR-004-…, AGENTS.md (T20)
```

## Task map

| # | Task | Produces (used by) |
|---|---|---|
| 1 | Scaffold `apps/desktop` (own workspace, config, CSP, ids, hygiene lint) | skeleton, `ids.rs` (all) |
| 2 | Harness API side: tickets, `run/api.json`, `installationId`, `version`, desktop scopes, bearer SSE, owner bootstrap, `/ws` host bridge with `host.keyUnlock` | endpoints (9, 11, 13, 14, 16) |
| 3 | Harness container mode: `plur1bus init`, refusals, `state snapshot|verify|restore`, `1staid check` rows, `admin.smoke` | image behaviour (4, 7, 16) |
| 4 | Harness image, `container.yml` build/sign/SBOM/size gate, `compose.yaml`, quadlet | image digests (7, 16, 17, 18) |
| 5 | Apple `container` spike and adapter | `AppleRuntime` (6, 7) |
| 6 | Docker Engine API adapter and runtime detection | `DockerRuntime`, `detect` (7, 12) |
| 7 | Runtime controller: `bundle.json`, acquire, volumes, network, container spec, lifecycle, restart watch, autostart | `Controller` (9, 12, 14, 16, 17) |
| 8 | Connections store and token store | `Store`, `TokenStore` (9, 11, 13, 14) |
| 9 | Harness client and pairing: auto-pair over `exec`, native one-click, code flow | `HarnessClient`, `pair_*` (11, 12, 13, 14) |
| 10 | Host CLI forwarding (`target.json`) | host `plur1bus` (17) |
| 11 | Host bridge client with `host.keyUnlock` | `Bridge` (14) |
| 12 | Shell pages: wizard, connections, settings, update dialog, progress | `ui/dist` (13, 17, 19) |
| 13 | SPA window: incognito, ticket login, navigation guard, `spa-bridge` | `open_spa` (14) |
| 14 | Tray, single instance, window lifecycle, `/events` + runtime state | `TrayState` (15, 16) |
| 15 | Log redaction; release feed, channels and the update dialog logic; Tauri updater | `updates` (16) |
| 16 | Harness upgrade: snapshot, swap, migrate, health gate, automatic and manual rollback, journal | `upgrade` (18) |
| 17 | Installers per OS (online/offline), Apple `container` install offer, Podman socket enable, uninstall | bundles (18) |
| 18 | CI: `desktop.yml`, `container.yml` e2e, `apple-container.yml`, release gate (`release.yml`), promotion, notes lint, canary | — |
| 19 | Accessibility and i18n pass | — |
| 20 | Docs, ADR notes, AGENTS.md, demo guide, test report | — |

Order: 1 → 2 and 3 (parallel) → 4 → 5 and 6 (parallel) → 7 → 8 → 9 → 10, 11 (parallel) → 12 → 13 → 14 → 15 → 16 → 17 → 18 → 19 → 20.

---

### Task 1: Scaffold `apps/desktop`

**Files:**
- Create: `apps/desktop/package.json`, `apps/desktop/src-tauri/{Cargo.toml,build.rs,tauri.conf.json}`, `apps/desktop/src-tauri/src/{main.rs,lib.rs,ids.rs}`, `apps/desktop/src-tauri/capabilities/shell-ui.json`, `apps/desktop/src-tauri/icons/*`, `apps/desktop/ui/index.html` (placeholder), `apps/desktop/src-tauri/tests/config.rs`
- Modify: `Cargo.toml` (`exclude = ["apps"]`), `pnpm-workspace.yaml`, `scripts/lint-hygiene.mjs`, `.gitignore` (`apps/desktop/src-tauri/target/`, `apps/desktop/ui/dist/`, `apps/desktop/src-tauri/resources/image/*.tar`)

**Interfaces:**
- `ids.rs` per DR5.
- `tauri.conf.json`: `identifier` = `BUNDLE_ID`; `app.withGlobalTauri: false`; `app.security.freezePrototype: true`; `app.security.csp` exactly the shell-page CSP of spec §6.9; `app.security.capabilities: ["shell-ui"]`; one window `shell` (`url: "index.html"`, `visible: false` until ready); `build.frontendDist: "../ui/dist"`; bundle targets per DR4; `bundle.windows.nsis.installMode: "currentUser"`; `bundle.macOS.signingIdentity: "-"`; `bundle.createUpdaterArtifacts: true`; `bundle.resources: ["resources/image/*"]` (empty in the online variant).
- `lint-hygiene.mjs`: fails when `git ls-files` contains `*.p12`, `*.p8`, `*.pfx`, `*.key`, `*.pem`, `*.keystore`, `*.oci.tar`, or a file containing `untrusted comment: minisign secret key` or `-----BEGIN (ENCRYPTED )?PRIVATE KEY-----`. Allow-list: the committed public keys under `keys/`.

- [ ] **Step 1: Write the failing tests.** `tests/config.rs`: `identifier_matches_ids_rs`, `csp_is_the_spec_string`, `global_tauri_is_off_and_prototype_frozen`, `no_forbidden_plugins_in_cargo_toml` (none of `tauri-plugin-{shell,fs,http,dialog,opener}`), `nsis_is_current_user_only`. Root: `node scripts/lint-hygiene.mjs --self-test` plants a tracked `x.p12` and a tracked `x.oci.tar` in a temp git repo and expects failure.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** `src-tauri/Cargo.toml` starts with an empty `[workspace]` table and `rust-version = "1.95"`. `main.rs` calls `plur1bus_desktop::run()`. `cargo generate-lockfile`.
- [ ] **Step 4: Run** the desktop part of Green, `pnpm tauri build --debug --no-bundle`, and the root Green (it must not see the desktop crate) → PASS.
- [ ] **Step 5: Commit** `feat(desktop): scaffold Tauri 2.12 app in apps/desktop (own workspace, CSP, ids, hygiene lint)`.

---

### Task 2: Harness API side — tickets, discovery, identity, desktop scopes, bearer SSE, owner bootstrap, host bridge

**Files:** (under `$API` unless noted; exact paths recorded in Step 1)
- Create: `src/desktop/ticket.ts`, `src/desktop/api-file.ts`, `src/desktop/bridge.ts` (the `/ws` host-bridge endpoint), `test/desktop-ticket.test.ts`, `test/api-file.test.ts`, `test/desktop-bridge.test.ts`; the `/auth/ticket` page inside the SPA build
- Modify: route table (`POST /api/v1/auth/session-ticket`, `POST /api/v1/auth/ticket/redeem`, `GET /ws` upgrade for bridge clients), device kind `desktop`, scopes `ui.session`, `events.read`, `bridge.serve`; `/api/v1/meta` (`installationId`, `version`, capabilities `desktop.sessionTicket`, `host.bridge`); `/events` (device bearer token with `events.read`; topic `harness.status`, including `secrets: locked|unlocked`); the owner bootstrap (DR15); the ADR-005 secret store (`unlockWithKey`); the deny-by-default suite; `docs/api-surface.md`

**Interfaces:**
- `run/api.json`: `{ url, pid, instanceId, installationId, apiVersion }`, atomic write (tmp + rename, `0600`) after `listen()`, removed on clean stop, overwritten when stale. `installationId` is created once and stored in the state root (so it survives image upgrades on the volume).
- `/api/v1/meta` (unauthenticated): `{ apiVersion, version, installationId, capabilities }`; `version` is the product SemVer (D78).
- **Tickets** exactly as spec DS5/§6.2: `POST /api/v1/auth/session-ticket` (Bearer device token with `ui.session`; 32 random bytes base64url; stored as SHA-256 with `{ deviceId, userId, expiresAt = now + 60 s, used }`; ≤ 5 open per device) and `POST /api/v1/auth/ticket/redeem { ticket }` (unauthenticated, login rate limit; valid → session cookie without `Expires`/`Max-Age` + `{ csrf }`; otherwise `401 E_AUTH reason=ticket-invalid`). Audit `desktop.ticket.issue|redeem` without the value. Revoked device → `401 E_AUTH reason=device-revoked`.
- **Owner bootstrap** (DR15): `plur1bus user create --owner --json` → `user.create/1 { userId }`, `E_EXISTS` when an owner exists.
- **Host bridge endpoint** (spec DS17, §6.15.4): `GET /ws` with `Authorization: Bearer <device token>` having `bridge.serve`. Messages (JSON text frames, each ≤ 64 KiB): client `bridge.hello { capabilities: string[] }` → server `bridge.welcome { accepted: string[] }` (intersection with what the device's grant names and what the harness supports; D1 supports only `host.keyUnlock`); server `bridge.call { callId, capability, op, args }` → client `bridge.result { callId, ok, value?, error? }`. For `host.keyUnlock` the harness calls `op: "get"` at start and whenever the secret store is locked; the value is the 32-byte secret-store key, base64url, never logged. The capability `host.keyUnlock` can only be named in a device's grant at pairing time through the CLI (`plur1bus device pair --grant host.keyUnlock`), which only a local shell or the app's `exec` can run; the API and the SPA cannot add it to a grant. (A peer-address check would not work: in container mode every request on the published port arrives from the runtime's gateway, spec §6.15.4.) The harness calls `secretStore.unlockWithKey(key)`; a wrong key leaves the store locked and `harness.status` and `1staid check` report `secrets: locked, reason: key-mismatch`.
- The first `host.keyUnlock` against an empty store (fresh install) is `op: "provision"`: the app creates a random key, stores it in the keychain under `KEYCHAIN_SERVICE` / account `secret-store-<installationId>`, and returns it; the harness initialises the encrypted store with it.

- [ ] **Step 1: Inventory M3 and M2 (DR1, DR15, preconditions).** Locate `$API`, routes, device pairing, scopes, `/meta`, `/events`, the owner bootstrap, the deny-by-default suite, and the ADR-005 store's encrypted-file backend. Write "spec §6.14 row → M3/M2 name or MISSING" into the report. Stop with BLOCKED if a precondition is missing.
- [ ] **Step 2: Write the failing tests.**
  - tickets: `ticket issue needs a desktop device token with ui.session`, `a ticket redeems exactly once`, `an expired ticket is refused` (injected clock), `redeem sets a session cookie without Expires or Max-Age`, `the ticket value never appears in logs or audit`, `at most five open tickets per device`;
  - `api.json is written with mode 0600 after listen and removed on stop` (mode check skipped on win32);
  - `meta exposes installationId, version and desktop.sessionTicket without auth`;
  - `events accepts a device bearer token with events.read and refuses one without`; `harness.status carries secrets locked|unlocked`;
  - `user create --owner creates exactly one owner and refuses a second with E_EXISTS`;
  - bridge: `bridge needs bridge.serve`, `welcome accepts only granted and supported capabilities`, `keyUnlock provisions an empty store and unlocks it on restart`, `a wrong key keeps the store locked and says key-mismatch`, `keyUnlock is refused for a device whose grant does not name it, and the API cannot add it to a grant`, `the key never appears in logs or audit`, `frames over 64 KiB close the socket`;
  - the deny-by-default suite covers every new route (unauthenticated, Viewer, wrong scope).
- [ ] **Step 3: Run** → FAIL.
- [ ] **Step 4: Implement.** Ticket storage in memory. Update `docs/api-surface.md` (routes, scopes, rate-limit class, `/events` topic, the bridge protocol).
- [ ] **Step 5: Run** → PASS; root Green.
- [ ] **Step 6: Commit** `feat(api): desktop tickets, run/api.json, installationId and version in meta, desktop scopes, owner bootstrap, host bridge with host.keyUnlock (desktop D1)`.

---

### Task 3: Harness container mode — `plur1bus init`, refusals, state snapshots, `1staid check` rows, `admin.smoke`

**Files:**
- Create: `crates/plur1bus/src/commands/init.rs`, `crates/plur1bus/src/commands/state.rs`, `crates/plur1bus/src/container.rs`, `crates/plur1bus/tests/{init,state,container_mode}.rs`, `packages/core/src/admin-smoke.ts`, `packages/core/test/admin-smoke.test.ts`, `tests/system/container-mode.test.ts`
- Modify: `crates/plur1bus/src/commands/{mod.rs,firstaid.rs,service.rs,update.rs,admin.rs}`, `packages/rpc-schema/schema/rpc.schema.json` (`admin.smoke`, `x-server: "core"`, `x-stability: "experimental"`, closed params `{}`), `packages/core/src/admin-ops.ts`, `packages/webmcp` test (`admin.smoke` refused as a WebMCP tool, covered by `FORBIDDEN_PREFIX`), generated docs (`pnpm docs:gen`)

**Interfaces:**
- `container.rs`: `pub fn container_mode() -> bool` (`PLUR1BUS_CONTAINER == "1"`); `service install|uninstall` and `update` return `E_NOT_AVAILABLE` with `reason: "container-managed"` in container mode (exit code of the existing `E_NOT_AVAILABLE` mapping).
- `plur1bus init` (hidden; refused outside container mode or when not PID 1, exit 2):
  - installs `SIGCHLD` handling and reaps with `waitpid(-1, WNOHANG)` in a loop;
  - spawns `plur1bus supervise --home $PLUR1BUS_HOME` and respawns it on exit with the ADR-012 §10.3 backoff; five exits within 10 minutes → `init` exits 70 after logging the last exit status;
  - on SIGTERM/SIGINT: calls `daemon.stop { budgetMs: 120000 }` through the supervisor socket, waits for the supervisor to exit (≤ 130 s), then reaps and exits 0; a second signal skips to `SIGKILL` of the process group;
  - with `PLUR1BUS_UPGRADE_FROM` set, writes it into the supervisor's environment so the core logs `upgrade from <v>` once; no other behaviour change (migrations are driven from outside, Task 16).
- `plur1bus state snapshot --src <dir> --dst <dir> --json` / `state verify --dir <dir> --json` / `state restore --src <snapshot> --dst <dir> --json` (hidden, container mode, refused when `run/supervisor.sock` in `--src` answers — the state must be stopped):
  - `snapshot` copies regular files, directories and symlinks (not followed) preserving mode and mtime; refuses special files; writes `MANIFEST.sha256` (lines `sha256  size  mode  path`, sorted by path, relative) and `SNAPSHOT.json { schema: "state.snapshot/1", from, createdAt, fileCount, bytes, manifestSha256 }`; then runs `verify` on the destination; result `state.snapshot/1` with the same fields;
  - `verify` re-hashes every file and compares with `MANIFEST.sha256` (missing, extra, size, mode, hash); result `{ ok, mismatches: [{ path, kind }] }`, exit 1 on any mismatch;
  - `restore` verifies the snapshot first, refuses a non-empty `--dst`, copies everything except `MANIFEST.sha256` and `SNAPSHOT.json`, then verifies the destination against the manifest.
- `1staid check --json` new rows: `container` (in container mode only: memory limit from cgroup, free space of the state and models volumes, `secrets` locked/unlocked from the core's status, image digest from `/etc/plur1bus/image.json` baked at build time); `storage` (the state root and each store path: `fail` when `statfs` reports virtiofs `0x6a656a63`, FUSE `0x65735546` or overlayfs `0x794c7630`, on every OS where `statfs` exists; `skip` elsewhere); `engine.storeSchema { current, required }` (`warn` when they differ).
- The core refuses to open a store on those file systems (`E_NOT_AVAILABLE reason=unsafe-filesystem`), tested with an injected `statfs` result.
- `admin.smoke` (core RPC) → `{ ok, steps: [{ name, ok, ms, detail? }] }`, steps: `sqlite.quick_check` (each store), `lance.open` (each table), `models.load`, `capture` (agent `__smoke`, fixed synthetic text), `recall` (rank 1 within `core.recall.hardBudgetMs`), `purge` (forget + hard delete; asserts zero `__smoke` rows remain). `__smoke` is a reserved agent id: refused by `agent create`, excluded from lists, exports, dreaming and shares. CLI `plur1bus admin smoke --json` (exit 1 when `ok` is false). With `PLUR1BUS_TEST_FAIL_SMOKE=1` + `PLUR1BUS_ALLOW_TEST_INTERNALS=1` the `recall` step fails.
- `admin migrate` with `PLUR1BUS_TEST_FAIL_MIGRATION=1` + `PLUR1BUS_ALLOW_TEST_INTERNALS=1` exits non-zero before touching the store.

- [ ] **Step 1: Write the failing tests.**
  - `container_mode`: `service_install_refuses_in_container_mode`, `update_refuses_in_container_mode`, both with `reason=container-managed` in `--json`.
  - `init` (Linux only, run as PID 1 inside a new PID namespace via `unshare --pid --fork --mount-proc` when available, else skipped with a reason): `init_reaps_orphans`, `init_respawns_a_killed_supervisor_and_the_core_is_adopted` (kill `supervise`; the core pid is unchanged and `daemon status` shows it adopted — ADR-012 acceptance 3 in container mode), `init_exits_70_after_five_crashes_in_ten_minutes` (time-scaled), `sigterm_runs_daemon_stop_and_exits_0`.
  - `state`: `snapshot_then_verify_is_clean`, `verify_reports_each_mismatch_kind`, `restore_refuses_a_corrupted_snapshot`, `restore_refuses_a_non_empty_destination`, `snapshot_refuses_a_running_state` (fake supervisor socket), `symlinks_are_copied_not_followed`, `special_files_are_refused`.
  - `firstaid`: `storage_row_fails_on_virtiofs_fuse_overlay` (injected `statfs`), `engine_store_schema_row_reports_current_and_required`, `container_row_only_in_container_mode`.
  - core: `admin smoke passes on a healthy home and leaves no __smoke rows`, `admin smoke reports the failing step` (test seam), `__smoke is refused by agent create and absent from lists and exports`, `a store on an unsafe filesystem is refused`.
  - WebMCP: `admin.smoke is never a WebMCP tool`.
  - system: `tests/system/container-mode.test.ts` runs the release binary with `PLUR1BUS_CONTAINER=1` and asserts the refusals, `state` round trip on a stopped home, and `admin smoke` on a running daemon.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** `init` and `state` use std only (no tokio). `pnpm gen`, `pnpm docs:gen`.
- [ ] **Step 4: Run** → PASS; root Green.
- [ ] **Step 5: Commit** `feat(harness): container mode — plur1bus init as PID 1, container-managed refusals, verified state snapshots, storage and schema rows in 1staid check, admin.smoke (desktop D1)`.

---

### Task 4: Harness image, compose and quadlet

**Files:**
- Create: `deploy/image/Dockerfile`, `deploy/image/assemble.mjs`, `deploy/image/build-local.mjs`, `deploy/image/smoke.mjs`, `deploy/image/size-budget.json`, `deploy/image/README.md`, `deploy/compose.yaml`, `deploy/quadlet/plur1bus-harness.container`, `deploy/quadlet/plur1bus-state.volume`, `deploy/quadlet/plur1bus-models.volume`, `.github/workflows/container.yml` (build part; e2e jobs arrive in Task 18)

**Interfaces:**
- **Dockerfile:** `FROM node:24-bookworm-slim@sha256:<pinned>`; no build steps that compile; copies the artefacts `assemble.mjs` staged (the `plur1bus` release binary for the arch, the bundled core, first-party modules, the skill, the pinned Node runtime is the base image's); creates user `10001:10001`; `ENV PLUR1BUS_CONTAINER=1 PLUR1BUS_HOME=/var/lib/plur1bus PLUR1BUS_MODELS_DIR=/var/lib/plur1bus-models`; `VOLUME` for both; `EXPOSE 18700`; `USER 10001:10001`; `ENTRYPOINT ["/usr/local/bin/plur1bus", "init"]`; writes `/etc/plur1bus/image.json { version, gitSha, builtAt }` (the digest is not knowable at build time; `1staid check` reads it from the runtime label `app.plur1bus.image.digest` the controller sets). OCI labels: `org.opencontainers.image.{source,version,revision,licenses}`.
- The HTTP API module binds `0.0.0.0:18700` when `PLUR1BUS_CONTAINER=1` (ADR-012 §11); the default config written at first start in the container sets it.
- **`assemble.mjs`** takes `--arch arm64|amd64` and the paths of the release artefacts built natively on `ubuntu-24.04` / `ubuntu-24.04-arm`, stages them, and runs `docker buildx build --platform linux/<arch> --output type=oci,dest=plur1bus-harness-<arch>.oci.tar` plus a `--push` variant for the registry (DR17). A manifest list joins both arches.
- **`smoke.mjs`**: runs the image with the exact flags of Global Constraints (via `docker` or `podman` CLI, test-only), waits for `daemon status --json` ready through `exec`, runs `1staid check --json` (no `fail`) and `admin smoke --json` with `PLUR1BUS_ALLOW_TEST_INTERNALS=1` and `flat-embedder` (no model download in CI; the real-model smoke is the nightly), checks that only `127.0.0.1:<port>` is bound on the host, stops with a 150 s timeout, and removes everything it created.
- **`size-budget.json`**: `{ "plur1bus-harness": { "compressedBytesMax": 367001600 } }` (350 MB + the recorded margin is applied by the gate: fail above budget × 1.10).
- **`container.yml` (build part):** matrix `ubuntu-24.04` (amd64), `ubuntu-24.04-arm` (arm64); builds the root release artefacts, assembles the image, runs `smoke.mjs`, measures the compressed size, uploads the OCI tarball as an artefact. On a release tag (from `release.yml`): pushes by digest, `cosign sign --yes <ref>@<digest>` (keyless), generates the SBOM per arch and attaches it with `cosign attest --type cyclonedx`, and adds `actions/attest-build-provenance`.
- **`compose.yaml`** and **quadlet** exactly as spec §6.15.11 (service `harness` by digest placeholder `${PLUR1BUS_IMAGE}`, `init: false`, `restart: unless-stopped`, `stop_grace_period: 150s`, `read_only: true`, `tmpfs: [/tmp]`, `cap_drop: [ALL]`, `security_opt: [no-new-privileges:true]`, `user: "10001:10001"`, `ports: ["127.0.0.1:18700:18700"]`, both volumes, `TZ`).

- [ ] **Step 1: Write the failing checks.** `deploy/image/test/compose.test.mjs` (node:test): `compose.yaml has exactly the spec flags`, `quadlet matches compose` (same user, read-only, caps, port binding, volumes, stop timeout), `Dockerfile entrypoint is plur1bus init and user is 10001`. Run → FAIL.
- [ ] **Step 2: Implement** the Dockerfile, scripts, compose and quadlet files, and the build part of `container.yml`.
- [ ] **Step 3: Run** the checks, then `node deploy/image/build-local.mjs && node deploy/image/smoke.mjs` on the local Linux host with Docker **and** with Podman rootless → PASS. Record the compressed size per arch available locally.
- [ ] **Step 4: Commit** `feat(deploy): multi-arch harness image (plur1bus init, non-root, read-only), smoke, size budget, compose and quadlet (desktop D1)`.

---

### Task 5: Apple `container` spike and adapter

**Files:**
- Create: `apps/desktop/src-tauri/src/runtime/{mod.rs,apple.rs,spec.rs}`, `apps/desktop/src-tauri/tests/{apple_runtime,runtime_contract}.rs`, `apps/desktop/src-tauri/tests/bin/fake-container.rs`, `apps/desktop/src-tauri/tests/fixtures/apple/<cli-version>/*.json`, `apps/desktop/scripts/record-apple-fixtures.mjs`

**Interfaces:**
```rust
// runtime/mod.rs — runtime-neutral, used by the controller
pub enum RuntimeKind { Apple, Docker }
pub struct RuntimeInfo { pub kind: RuntimeKind, pub endpoint: String, pub version: String, pub engine: String }
pub enum RuntimeError { NotFound, TooOld { found: String, min: String }, NoAccess(String), WrongMode, Stopped,
                        NotFoundObject(String), Conflict(String), Timeout(&'static str), Failed(String) }
pub struct ExecOutput { pub code: i32, pub stdout: Vec<u8>, pub stderr: Vec<u8> }
pub struct ContainerState { pub exists: bool, pub running: bool, pub exit_code: Option<i32>, pub image_digest: Option<String>,
                            pub labels: BTreeMap<String, String>, pub ip: Option<IpAddr> }
#[async_trait] pub trait Runtime: Send + Sync {
  fn info(&self) -> &RuntimeInfo;
  async fn ping(&self) -> Result<(), RuntimeError>;
  async fn ensure_started(&self) -> Result<(), RuntimeError>;            // Apple: `container system start`; Docker: Err(Stopped) if no answer (the app cannot start Docker Desktop)
  async fn image_present(&self, digest: &str) -> Result<bool, RuntimeError>;
  async fn image_load(&self, tar: &Path) -> Result<String /*digest*/, RuntimeError>;
  async fn image_pull(&self, reference: &str, digest: &str) -> Result<(), RuntimeError>;   // verifies digest (DR13)
  async fn volume_ensure(&self, name: &str, size_gib: u32, labels: &Labels) -> Result<(), RuntimeError>;
  async fn volume_remove(&self, name: &str) -> Result<(), RuntimeError>;
  async fn network_ensure(&self, name: &str, internal: bool) -> Result<(), RuntimeError>;
  async fn create(&self, spec: &ContainerSpec) -> Result<(), RuntimeError>;
  async fn start(&self, name: &str) -> Result<(), RuntimeError>;
  async fn stop(&self, name: &str, timeout: Duration) -> Result<(), RuntimeError>;
  async fn rename(&self, from: &str, to: &str) -> Result<(), RuntimeError>;
  async fn remove(&self, name: &str) -> Result<(), RuntimeError>;
  async fn state(&self, name: &str) -> Result<ContainerState, RuntimeError>;
  async fn list_labeled(&self, label: &str) -> Result<Vec<String>, RuntimeError>;
  async fn logs_tail(&self, name: &str, lines: u32) -> Result<String, RuntimeError>;
  async fn exec(&self, name: &str, argv: &[&str], stdin: Option<&[u8]>, timeout: Duration) -> Result<ExecOutput, RuntimeError>;
  async fn run_oneshot(&self, spec: &ContainerSpec, timeout: Duration) -> Result<ExecOutput, RuntimeError>;  // throwaway, --network none, removed after
}
// runtime/spec.rs — the one place container flags are defined (Global Constraints)
pub struct ContainerSpec { pub name: String, pub image_digest: String, pub host_port: Option<u16>, pub memory_mib: u32, pub cpus: u32,
                           pub volumes: Vec<(String, String, bool /*ro*/)>, pub env: Vec<(String, String)>, pub labels: Labels,
                           pub network: Option<String>, pub cmd: Option<Vec<String>>, pub restart: bool }
pub fn harness_spec(b: &Bundle, port: u16, res: &Resources, extra_env: &[(String, String)]) -> ContainerSpec;
pub fn oneshot_spec(image_digest: &str, cmd: Vec<String>, volumes: Vec<(String, String, bool)>) -> ContainerSpec;
```
- `apple.rs`: `AppleRuntime::detect() -> Result<AppleRuntime, RuntimeError>` resolves `/usr/local/bin/container` (or `PLUR1BUS_DESKTOP_APPLE_CLI` in debug builds), checks its code signature (`codesign --verify --strict` + the Team ID recorded from the spike), runs `container system version --format json`, compares with `bundle.json`'s minimum (`TooOld`), and `container system status` (`Stopped`). Every call is `container <sub> … --format json` where available, parsed into closed serde structs that **ignore unknown fields** (Apple adds fields) but require the ones we use. `create` maps `ContainerSpec` to `container create --name … -m <mib>M -c <cpus> --read-only --user 10001:10001 --tmpfs /tmp -p 127.0.0.1:<port>:18700 -v <vol>:<path>[:ro] -e K=V -l K=V --network <n> <digest-ref>`; `stop` passes `-t 150`; no restart flag exists (the controller's watch restarts, Task 7).

- [ ] **Step 1: Spike (DR13)** on macOS 26, Apple silicon, the newest `container` 1.x: install, `container system start --enable-kernel-install`; record with `record-apple-fixtures.mjs` the JSON of `system version|status`, `image list|inspect`, `volume create|list|inspect`, `network create|list`, `create`, `list --all`, `inspect` (running and exited), `logs`, `exec` exit codes; test (a) `run …@sha256:<digest>`, (b) `image load --input` of the Task 4 OCI tarball, (c) `-p 127.0.0.1:…` and that the port is not reachable from another host on the LAN, (d) `stop -t 150` honoured, (e) container IP reachable from the host, (f) a volume survives `container system stop && start` and a reboot, (g) `exec -i` stdin and exit code passthrough. Write the results table and the chosen DR13 fallbacks into the task report. Commit the fixtures under `tests/fixtures/apple/<version>/`.
- [ ] **Step 2: Write the failing tests** against `fake-container` (reads `FAKE_CONTAINER_FIXTURES` and a scripted scenario file; records every argv it receives):
  - `detect_parses_version_and_refuses_too_old`, `detect_reports_stopped_and_ensure_started_runs_system_start`, `detect_refuses_an_unsigned_binary` (the signature check is behind a trait; the test injects a failure);
  - `create_passes_exactly_the_spec_flags` (argv equality with a golden list), `stop_uses_150_seconds`, `exec_passes_stdin_and_exit_code`, `image_pull_verifies_the_digest_and_refuses_a_mismatch`, `unknown_json_fields_are_ignored_required_ones_are_not`;
  - `runtime_contract.rs`: a shared contract suite (`fn contract<R: Runtime>(r: R)`) run here against the fake Apple CLI and in Task 6 against the Docker mock: create/start/state/exec/stop/rename/remove/labels/one-shot semantics and error mapping (`NotFoundObject`, `Conflict`).
- [ ] **Step 3: Run** → FAIL.
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run** → PASS; desktop Green. On the spike Mac, run the contract suite against the real CLI with `PLUR1BUS_DESKTOP_E2E_RUNTIME=apple` and record the result.
- [ ] **Step 6: Commit** `feat(desktop): Apple container runtime adapter (CLI --format json), recorded fixtures, runtime contract suite`.

---

### Task 6: Docker Engine API adapter and runtime detection

**Files:**
- Create: `apps/desktop/src-tauri/src/runtime/{docker.rs,detect.rs}`, `tests/{docker_runtime,detect}.rs`, `tests/fixtures/docker/*.json` (recorded `/version` replies: Docker Engine, Docker Desktop, rootless, Podman, OrbStack, Colima, a Windows-containers engine)
- Modify: `Cargo.toml` (`bollard` pinned per DR16)

**Interfaces:**
```rust
pub struct DockerRuntime { /* bollard::Docker over unix socket or named pipe; 2 s connect timeout; no TCP endpoints */ }
impl DockerRuntime { pub async fn connect(endpoint: &Endpoint) -> Result<DockerRuntime, RuntimeError>; }
pub enum Endpoint { Unix(PathBuf), Pipe(String) }
pub struct Candidate { pub endpoint: Endpoint, pub source: &'static str }   // "DOCKER_HOST", "context:<name>", "default", "rootless", "podman", "orbstack", "colima", "docker-desktop"
pub fn candidates(env: &Env, home: &Path) -> Vec<Candidate>;   // spec §4.11 order; DOCKER_HOST tcp:// is ignored with a note (never used)
pub enum DetectState { Ready, Stopped, TooOld, NoAccess, WrongMode }
pub struct Detected { pub kind: RuntimeKind, pub endpoint: String, pub source: String, pub version: String, pub engine: String, pub state: DetectState }
pub async fn detect_all(env: &Env, home: &Path) -> Vec<Detected>;   // Apple first on macOS, then each candidate: /_ping + /version within 2 s; de-duplicated by resolved socket path
pub fn choose_default(found: &[Detected], current: Option<&Detected>) -> Option<usize>;  // DS14: one usable → it; several → the running one; tie on macOS 26+ → Apple; never switches away from `current`
```
- `engine` is derived from `/version` (`Components[].Name`, `Platform.Name`) for diagnostics only; behaviour never branches on it except `WrongMode` (`Os != "linux"`).
- Docker contexts are read from `~/.docker/config.json` `currentContext` and `~/.docker/contexts/meta/*/meta.json` (only `unix://` and `npipe://` endpoints).
- `NoAccess` carries the fix text key (`docker-group-root-equivalent`, recommending rootless or Podman).

- [ ] **Step 1: Write the failing tests.**
  - `docker_runtime`: the Task 5 contract suite against a wiremock Engine API (bollard pointed at a Unix socket served by a test `hyper` server on Linux/macOS; a named-pipe variant on Windows), plus `create_body_is_exactly_the_spec` (JSON body equality: `HostConfig.PortBindings` `127.0.0.1` only, `ReadonlyRootfs`, `CapDrop ["ALL"]`, `SecurityOpt ["no-new-privileges"]`, `PidsLimit 1024`, `RestartPolicy unless-stopped`, `StopTimeout 150`, `User "10001:10001"`, `Tmpfs {"/tmp":""}`, `Memory`, `NanoCpus`, `Mounts` volumes only, no `Binds` to host paths, no `Privileged`, no `NetworkMode host`), `image_load_returns_the_digest`, `pull_verifies_the_digest`;
  - `detect`: a table over fixture environments (`DOCKER_HOST` set; context `orbstack`; rootless `$XDG_RUNTIME_DIR/docker.sock`; Podman user socket; macOS `~/.docker/run/docker.sock`; Windows `npipe:////./pipe/docker_engine` and `podman-machine-default`; nothing at all) → expected `Detected` lists; `a_windows_containers_engine_is_wrong_mode`; `permission_denied_is_no_access_with_the_rootless_hint`; `tcp_docker_host_is_ignored_with_a_note`; `the_same_socket_via_two_sources_is_listed_once`; `choose_default_table` (including the macOS 26 tie → Apple); Review Focus 7 `a_new_runtime_is_listed_not_adopted`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; desktop Green; with `PLUR1BUS_DESKTOP_E2E_RUNTIME=docker` and `=podman` locally, the contract suite against the real engines → PASS (record).
- [ ] **Step 5: Commit** `feat(desktop): Docker Engine API adapter (bollard) and runtime detection for Apple container and Docker-compatible runtimes`.

---

### Task 7: Runtime controller — bundle, acquire, volumes, network, lifecycle, restart watch, autostart

**Files:**
- Create: `apps/desktop/src-tauri/src/controller/{mod.rs,bundle.rs,acquire.rs,lifecycle.rs,watch.rs,autostart.rs}`, `apps/desktop/bundle/bundle.json.tmpl`, `tests/{bundle,controller,watch}.rs`
- Modify: `Cargo.toml` (`tauri-plugin-autostart =2.6.0`), `lib.rs`

**Interfaces:**
```rust
// bundle.rs — embedded at build time from bundle.json (generated by the release workflow from the tmpl)
pub struct Bundle { pub version: String, pub registry: Option<String>, pub repository: String,
                    pub images: BTreeMap<Arch, String /*sha256:…*/>, pub tarball: BTreeMap<Arch, Option<String /*file name*/>>,
                    pub apple: AppleReq { min: String, tested: String, pkg_url: String, pkg_sha256: String, team_id: String },
                    pub supported_image_majors: Vec<u64>, pub docker_min_api: String }
pub fn embedded() -> &'static Bundle;   // build.rs refuses a release build whose bundle has placeholder digests unless PLUR1BUS_DESKTOP_ALLOW_PLACEHOLDER_KEY
// controller/mod.rs
pub struct Resources { pub memory_mib: u32, pub cpus: u32 }
pub enum HarnessStatus { NotInstalled, Stopped, Starting, Ready { port: u16 }, Crashed { exit_code: Option<i32>, log_tail: String }, RuntimeDown }
pub struct Controller { runtime: Arc<dyn Runtime>, bundle: &'static Bundle, dirs: AppDirs /* config dir for installed.json */ }
impl Controller {
  pub async fn install(&self, res: Resources, progress: impl Fn(InstallStep)) -> Result<Installed, CtlError>;
      // acquire image (tarball if present, else pull) → volumes → network `plur1bus` → pick port → create → start → wait ready
  pub async fn start(&self) -> Result<(), CtlError>;  pub async fn stop(&self) -> Result<(), CtlError>;
  pub async fn status(&self) -> HarnessStatus;         // runtime state + GET /api/v1/meta + exec `plur1bus daemon status --json`
  pub async fn logs_tail(&self, lines: u32) -> Result<String, CtlError>;
  pub async fn exec_json(&self, argv: &[&str], timeout: Duration) -> Result<serde_json::Value, CtlError>;  // used by pair, upgrade
  pub async fn uninstall(&self, what: UninstallScope) -> Result<(), CtlError>;  // Containers | Images | Volumes (separate calls)
}
pub enum InstallStep { Image, Volumes, Network, Container, Start, Owner, Pairing, Done }   // Owner/Pairing emitted by Task 9
// installed.json (app config dir, 0600, no secret): { runtime, endpoint, container, port, imageDigest, resources, installedVersion }
// watch.rs
pub fn spawn_watch(ctl: Arc<Controller>, tx: watch::Sender<HarnessStatus>) -> JoinHandle<()>;
  // every 5 s while the app runs: runtime ping; container state; restart a dead container (Apple always; Docker only if the
  // runtime's own policy did not within 20 s) with 1 s → 60 s backoff; five failures in 10 min → Crashed (no further restarts
  // until the person presses Start); runtime unreachable 60 s → RuntimeDown (never switches runtime); on wake-from-sleep
  // (a >30 s gap between ticks) re-check /meta and on Apple, after 30 s of failure, `container system stop && start`.
// autostart.rs
pub fn set_enabled(app: &AppHandle, on: bool) -> Result<(), CtlError>;   // LaunchAgent / Run key / XDG autostart via the plugin
pub async fn on_login(app: &AppHandle, ctl: &Controller);                // start minimised → ensure_started (Apple) or wait ≤ 120 s for the socket (Docker) → start harness
```
- Port choice: the first port in 18700–18799 that is free on `127.0.0.1` **and** not published by another container; stored in `installed.json`; on start, if the stored port is taken by something else, pick again and recreate (Review Focus 4). Nothing else ever touches another process.
- Every object created carries labels `app.plur1bus.role=harness|state|models|network`, `app.plur1bus.version=<bundle version>`, `app.plur1bus.image.digest=<digest>`.
- `install` is idempotent: re-running after a partial failure reuses existing labelled volumes (never recreates them) and replaces a half-created container.

- [ ] **Step 1: Write the failing tests** (both adapters' fakes; the same scenarios parameterised over `RuntimeKind`):
  - `bundle`: `embedded_bundle_parses`, `release_build_refuses_placeholder_digests`, `arch_maps_to_the_right_image`.
  - `controller`: `install_happy_path_emits_steps_in_order`, `install_prefers_the_tarball_and_checks_its_digest`, `install_pulls_by_digest_when_no_tarball`, `a_tarball_with_the_wrong_digest_is_refused_before_anything_is_created`, `create_spec_is_exact` (golden `ContainerSpec` → golden argv/body for each adapter), `install_is_idempotent_after_a_partial_failure` (fail at each step, rerun, assert volumes kept), Review Focus 4 `port_in_use_picks_the_next_and_keeps_the_connection`, `status_combines_runtime_meta_and_daemon_status`, `stop_uses_150_seconds`, `uninstall_scopes_are_separate_and_volumes_need_their_own_call`.
  - `watch` (injected clock): `apple_dead_container_is_restarted_with_backoff`, `five_failures_in_ten_minutes_is_crashed_and_stops_restarting`, `docker_restart_policy_is_given_20_seconds_first`, Review Focus 2 `runtime_gone_is_reported_not_switched`, `wake_gap_triggers_meta_recheck_and_apple_system_restart_after_30s`.
  - `autostart`: `on_login_starts_runtime_then_harness` (fakes), `docker_socket_wait_is_bounded_to_120s`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; desktop Green; with `PLUR1BUS_DESKTOP_E2E_RUNTIME=docker|podman`, `tests/controller_e2e.rs` runs install → status ready → kill the container's PID 1 → restarted → stop → uninstall against the Task 4 image → PASS (record).
- [ ] **Step 5: Commit** `feat(desktop): runtime controller — digest-pinned bundle, image acquisition, volumes, exact container spec, restart watch, autostart`.

---

### Task 8: Connections store and token store

**Files:**
- Create: `apps/desktop/src-tauri/src/{connections.rs,secrets.rs}`, `tests/{connections,secrets}.rs`, `tests/fixtures/origin-cases.json`
- Modify: `Cargo.toml` (`keyring =4.2.0` with native stores, `zeroize`)

**Interfaces:**
```rust
pub struct Origin(String);   // normalised "scheme://host[:port]", lower-case host, IDN as punycode
pub enum OriginError { Invalid, Scheme, InsecureRemote, HasUserinfo, HasPath }
impl Origin { pub fn parse(input: &str) -> Result<Origin, OriginError>; pub fn is_loopback(&self) -> bool; pub fn as_str(&self) -> &str; }
pub enum Kind { Bundled, Local, Remote }
pub struct BundledRef { pub runtime: RuntimeKind, pub endpoint: String, pub container: String, pub image_digest: String }
pub struct Connection { pub id: Uuid, pub name: String, pub kind: Kind, pub origin: Origin, pub installation_id: String,
                        pub device_id: String, pub token_hint: String, pub bundled: Option<BundledRef> }
pub struct Store { path: PathBuf }   // <config dir>/connections.json, { version: 1, active, uiLocale, connections: [...] }, unknown fields refused
impl Store { pub fn open(dir: &Path) -> Store; pub fn load(&self) -> Result<Vec<Connection>, StoreError>;
             pub fn upsert(&self, c: Connection) -> Result<(), StoreError>; pub fn remove(&self, id: Uuid, tokens: &dyn TokenStore) -> Result<(), StoreError>;
             pub fn active(&self) -> Result<Option<Uuid>, StoreError>; pub fn set_active(&self, id: Uuid) -> Result<(), StoreError>; }
pub struct SecretString(zeroize::Zeroizing<String>);   // Debug/Display "***"; no Serialize; expose()
pub enum StoreKind { Keychain, MemoryOnly }
pub enum TokenError { AccessDenied, Unavailable(String), Other(String) }
pub trait TokenStore: Send + Sync { fn get(&self, account: &str) -> Result<Option<SecretString>, TokenError>;
  fn set(&self, account: &str, v: &SecretString) -> Result<(), TokenError>; fn delete(&self, account: &str) -> Result<(), TokenError>; fn kind(&self) -> StoreKind; }
pub struct KeyringStore; pub struct MemoryStore; pub fn open_default() -> Box<dyn TokenStore>;   // DR8
pub fn token_account(id: Uuid) -> String;                     // "device-<uuid>"
pub fn secret_store_account(installation_id: &str) -> String; // "secret-store-<installationId>" (Task 11)
pub fn token_hint(t: &SecretString) -> String;
pub fn load_token_or_pairing_needed(t: &dyn TokenStore, id: Uuid) -> Result<SecretString, PairingNeeded>;
pub fn assert_no_token_on_disk(dir: &Path, secret: &str);    // test helper (cfg(test) + tests/common)
```
Origin rules and the file format as spec §6.2: `https` with any host; `http` only for `127.0.0.1`, `[::1]`, `localhost`; no userinfo, path other than `/`, query or fragment; default port dropped; atomic tmp + rename, `0600` on Unix; corrupt file kept aside as `.corrupt-<ms>`.

- [ ] **Step 1: Confirm the `keyring` 4.2 store features** on docs.rs and record them; if native stores need the `db-keystore` fallback, pin the newest 3.x with `apple-native`, `windows-native`, `linux-native-sync-persistent` and record why.
- [ ] **Step 2: Write the failing tests.** `origin_accepts_https_and_loopback_http_only` (table from `origin-cases.json`), `origin_normalises_case_default_port_and_idn`, `store_round_trips_bundled_local_and_remote_and_writes_0600`, `a_corrupt_file_is_kept_aside_not_overwritten`, `unknown_fields_are_refused`, `remove_keeps_the_row_when_the_token_delete_fails`, `remove_deletes_token_then_row`, `secret_string_debug_and_display_are_redacted`, `memory_store_round_trip_and_delete_missing_is_ok`, Review Focus 6 `access_denied_is_pairing_needed_not_a_crash`, `open_default_falls_back_to_memory_when_the_probe_fails`, and behind `PLUR1BUS_DESKTOP_REAL_KEYCHAIN=1` `real_keychain_round_trip`.
- [ ] **Step 3: Run** → FAIL.
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run** → PASS; desktop Green; the real-keychain test once on macOS or Windows if available.
- [ ] **Step 6: Commit** `feat(desktop): connection store (bundled, local, remote) and keychain token store with memory-only fallback`.

---

### Task 9: Harness client and pairing — auto-pair over `exec`, native one-click, code flow

**Files:**
- Create: `apps/desktop/src-tauri/src/{client.rs,pair.rs,discovery.rs,commands.rs}`, `tests/{client,pairing}.rs`, `tests/bin/fake-plur1bus.rs`
- Modify: `capabilities/shell-ui.json`, `lib.rs`

**Interfaces:**
```rust
// client.rs — reqwest (rustls, 10 s timeout, no redirects, no cookie store)
pub struct Meta { pub api_version: String, pub version: String, pub installation_id: String, pub capabilities: Vec<String> }
pub struct Redeemed { pub device_id: String, pub token: SecretString }
pub struct Ticket { pub ticket: SecretString, pub expires_at: SystemTime }
pub enum ClientError { Revoked, Unauthorized, Incompatible { server: String, client: String }, MissingCapability(&'static str),
                       InstallationMismatch, Network(String), Protocol(String) }
impl HarnessClient { pub fn new(origin: Origin) -> Self; pub async fn meta(&self) -> Result<Meta, ClientError>;
  pub async fn redeem(&self, code: &str, name: &str) -> Result<Redeemed, ClientError>;
  pub async fn session_ticket(&self, expected_installation: &str, token: &SecretString) -> Result<Ticket, ClientError>;
  pub async fn whoami(&self, expected_installation: &str, token: &SecretString) -> Result<(), ClientError>; }   // used by the health gate
pub const SUPPORTED_API_MAJOR: u64 = 1;
// pair.rs
pub async fn pair_bundled(ctl: &Controller, tokens: &dyn TokenStore, store: &Store, progress: impl Fn(InstallStep)) -> Result<Connection, PairError>;
  // exec `plur1bus user create --owner --json` (E_EXISTS is fine) → exec `plur1bus device pair --json --kind desktop --name "<hostname> desktop" --scope ui.session,events.read,bridge.serve --grant host.keyUnlock`
  // → redeem over http://127.0.0.1:<port> → keychain → store (kind Bundled). If an older bundled device exists for this installation,
  // exec `plur1bus device revoke <oldDeviceId> --json` after the new token is stored (DR8).
pub fn resolve_cli() -> Option<PathBuf>;   // native attach: known install locations only, absolute path required
pub fn pair_local(cli: &Path, name: &str) -> Result<PairCode, PairError>;   // fixed args, 15 s timeout, parses device.pair/1
pub enum PairError { CliMissing, Denied, Runtime(String), Failed(String) }
// discovery.rs — native local harness only: run/api.json under PLUR1BUS_HOME / ~/.plur1bus / %LOCALAPPDATA%\PLUR1BUS; never reads run/*.token
// commands.rs (shell-ui; each checks label == "shell"): runtime_detect, bundle_install, pair_local, pair_code, connections_list|rename|remove, open_connection, app_info
```
Every authenticated call first runs `meta()` and refuses when the `installationId` differs from the stored one (Review Focus 1), the API major is unsupported, or `desktop.sessionTicket` is missing. `401 reason=device-revoked` → `Revoked` → delete the token, mark `pairing needed`; for a bundled connection, re-run `pair_bundled` once automatically.

- [ ] **Step 1: Write the failing tests** (wiremock harness + controller with the fake runtimes):
  - `meta_parses_and_rejects_an_unsupported_major`, `redeem_stores_the_token_in_the_token_store_only` (+ `assert_no_token_on_disk`), Review Focus 1 `a_different_installation_at_the_origin_gets_no_token`, `revoked_deletes_the_token_and_marks_pairing_needed`, `redirects_are_not_followed`;
  - `pair_bundled_creates_owner_pairs_and_stores_a_bundled_connection` (asserts the exact exec argv lists), `pair_bundled_tolerates_an_existing_owner`, `pair_bundled_revokes_the_previous_device_after_storing_the_new_token`, `the_token_is_never_in_an_exec_argument_or_env` (inspect the fake runtime's recorded calls), `bundled_revoked_repairs_once_then_asks`;
  - native attach: `discover_ignores_a_stale_api_json`, `discover_ignores_a_non_loopback_url_in_api_json`, `discover_never_opens_token_files`, `pair_local_spawns_fixed_args_and_parses_json`, `pair_local_denied_falls_back_to_code_flow`;
  - `pair_code_rejects_insecure_remote_before_any_request`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; desktop Green; with a real runtime (`PLUR1BUS_DESKTOP_E2E_RUNTIME`), `install` + `pair_bundled` against the Task 4 image yields a working token (record).
- [ ] **Step 5: Commit** `feat(desktop): harness client and pairing — automatic over exec for the bundled harness, one-click native, code flow for remote`.

---

### Task 10: Host CLI forwarding

**Files:**
- Create: `crates/plur1bus/src/forward.rs`, `crates/plur1bus/tests/forward.rs`
- Modify: `crates/plur1bus/src/main.rs` (forwarding decision before command dispatch), `docs/cli.md` via `pnpm docs:gen` (help text mentions container mode)

**Interfaces:**
- `target.json` at `~/.config/plur1bus/target.json` (Windows `%APPDATA%\PLUR1BUS\target.json`), written by the app (Task 17), no secret: `{ "version": 1, "mode": "container", "runtime": "apple" | "docker", "endpoint": "<unix path | npipe name | /usr/local/bin/container>", "container": "plur1bus-harness" }`.
- When `target.json` has `mode: "container"` and `PLUR1BUS_CONTAINER` is not set: `--help` and `--version` are answered locally (T1 unchanged); every other invocation is forwarded as an `exec -i` of `plur1bus <args…>` in the container, streaming stdin/stdout/stderr and returning the remote exit code. Apple: spawns `<endpoint> exec -i <container> plur1bus …` (fixed argv, the path from `target.json` must be `/usr/local/bin/container`); Docker: speaks the Engine API exec endpoints over the socket/pipe with a minimal synchronous HTTP/1.1 client over std (no tokio in the root crate; the attach stream is demultiplexed per Docker's 8-byte frame header). `--json` bytes pass through unchanged (R13).
- `--home` given explicitly, or `PLUR1BUS_NO_FORWARD=1`, disables forwarding (native use on the same machine).
- Forwarding errors (runtime down, container missing) print one line naming the runtime and the app's *Start harness* action, exit 69.

- [ ] **Step 1: Write the failing tests.** `help_and_version_are_local_in_container_mode`, `commands_are_forwarded_with_args_stdin_and_exit_code` (fake Apple CLI; and a fake Docker socket server in the test implementing `/exec/*` with the frame format), `json_bytes_pass_through_unchanged`, `explicit_home_or_no_forward_disables_forwarding`, `runtime_down_is_one_line_and_exit_69`, `apple_endpoint_must_be_the_pkg_path`. Measure forwarded `daemon status --json` latency against the real image when `PLUR1BUS_DESKTOP_E2E_RUNTIME` is set and print it (reported, not asserted).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; root Green.
- [ ] **Step 5: Commit** `feat(cli): forward commands to the bundled harness container via target.json (help and version stay local)`.

---

### Task 11: Host bridge client with `host.keyUnlock`

**Files:**
- Create: `apps/desktop/src-tauri/src/bridge.rs`, `tests/bridge.rs`
- Modify: `lib.rs`, `commands.rs` (`bridge_settings` for the per-capability switch; D1 has one: `host.keyUnlock`, on by default for a bundled connection)

**Interfaces:**
```rust
pub struct Bridge;
impl Bridge { pub fn spawn(conn: Connection, client: HarnessClient, tokens: Arc<dyn TokenStore>, settings: BridgeSettings) -> JoinHandle<()>; }
  // ws://127.0.0.1:<port>/ws (bundled only in D1), Bearer device token; bridge.hello { capabilities: enabled ones };
  // on bridge.call host.keyUnlock: op "get" → keychain secret_store_account(installationId) → bridge.result; op "provision" → only if no
  // entry exists: 32 random bytes → keychain → result; an existing entry is never overwritten (E_EXISTS).
  // reconnect 1 s → 30 s with jitter; Revoked → stop and hand over to pairing.
```
The key never appears in logs (redaction test, Task 15), in `Debug`, or anywhere but the keychain, memory, and the loopback frame.

- [ ] **Step 1: Write the failing tests** (a test WebSocket server implementing the Task 2 protocol): `hello_lists_only_enabled_capabilities`, `provision_creates_and_stores_a_key_once`, `provision_never_overwrites_an_existing_key`, `get_returns_the_stored_key`, `capability_off_answers_E_DENIED`, `reconnects_with_backoff`, `revoked_stops_and_requests_pairing`, `remote_connections_do_not_start_the_bridge_in_d1`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; desktop Green; against the real image: fresh install → harness reports `secrets: unlocked` after the bridge connects; restart the container → `locked` → `unlocked` (record).
- [ ] **Step 5: Commit** `feat(desktop): host bridge client with host.keyUnlock (secret-store key held in the OS keychain)`.

---

### Task 12: Shell pages — wizard, connections, settings, update dialog, progress

**Files:**
- Create: `apps/desktop/ui/{package.json,build.mjs,index.html}`, `apps/desktop/ui/src/{main.ts,ipc.ts,i18n.ts}`, `apps/desktop/ui/src/views/{wizard,connections,add-remote,settings,update-dialog,progress,error}.ts`, `apps/desktop/ui/src/models/{wizard-model,pairing-model,update-model,origin-input}.ts`, `apps/desktop/ui/src/i18n/{en,de}.json`, `apps/desktop/ui/test/*.test.ts`
- Modify: `tauri.conf.json` (`build.beforeBuildCommand`), `capabilities/shell-ui.json` (the commands of Tasks 7, 9, 15, 16), `commands.rs` (`harness_start|stop|status|logs_tail`, `runtime_start`, `settings_get|set`)

**Interfaces:**
- `ipc.ts` is the only module that touches `invoke` (bundled `@tauri-apps/api/core`).
- `wizard-model.ts`: `welcome → runtime(detected[]) → [installRuntime(apple-pkg | podman-socket | guide)] → resources(defaults, advanced collapsed) → installing(step, progress) → done | error(kind, step)`. Defaults accepted and a runtime present = three primary actions ("Weiter", "Weiter", "Fertig"). Error kinds: `runtime-missing`, `runtime-too-old`, `runtime-no-access`, `wrong-mode`, `digest-mismatch`, `disk-space`, `pull-failed`, `start-timeout`, `pair-failed`.
- `pairing-model.ts`: native one-click and code flow as before (`cli-missing`, `denied`, `insecure-origin`, `installation-mismatch`, `incompatible`, `network`, `revoked`, `keychain-memory-only`).
- `update-model.ts`: `idle → available(release) → [later | skip | installing(step)] → done | rolledBack(step, from, to) | recoveryFailed`, with `held` as a global flag; steps mirror §6.15.8.
- Views: *Wizard*; *Connections* (list with kind badges, active marker, rename, remove, *Open*, *Add remote*, *Attach native local*); *Settings* → *Runtime* (detected list, the chosen one, endpoint shown, *Re-check*, memory slider), *Updates* (channel `stable`/`beta`, *Version halten*, *Nur Patch-Updates automatisch* default on, quiet hours, *Jetzt prüfen*), *Version* (installed version, *Zurück zu <from>* when possible with the snapshot time and the loss warning), *Advanced* (logs tail, *Diagnose kopieren* — redacted); *Update dialog* (version, date, security marker, notes in the UI language rendered from Markdown as plain paragraphs and lists only — no HTML, no links other than `https:` shown as text with a copy button, migration note for majors, *Jetzt*/*Später*/*Überspringen*); *Progress*; *Error*.
- *Settings → Runtime* also shows a **Host capabilities** block (added 2026-09-27 with spec §13, gap A9): one switch per bridge capability the app offers — in D1 only `host.keyUnlock` (DS17: "enabled by the person in the app"; acceptance 7 needs the *off* state) — and the harness's `secrets-locked` state in words; plus the container health rows of gap A11 (runtime state, memory limit, volume free space, image digest, `crashed` with exit code and log tail from Task 7).
- **Store variant of the update dialog** (DR22, spec §13 gap A12): when `PLUR1BUS_DESKTOP_STORE_BUILD=1`, the dialog shows the notes for information only, with no *Jetzt/Später/Überspringen* for the app; the harness-image upgrade flow and its progress view are unchanged.
- **Board references (design canvas, spec §13.4).** No canvas board exists for these pages (gaps A1–A5, A11–A15); they apply the visual system of spec §13.1 through the M3 theme file (DR6; the token question is spec §13.5 C1) and borrow layouts: *Wizard* → `V2SetupRail` (rail, step list, glass) and `V2Setup` (choice cards, *Back/Continue*, the "Same as … in the terminal" line); *Install runtime* licence steps → `V2SetupMemory` (licence-confirm pattern); *Settings* → `V2General` (section nav, rows, segmented control) and `V2Advanced` (table, for *Advanced*); *Connections* → the *Harnesses this app can open* block of `V2Devices`; *Update dialog* → `V2Home` "What's new" and the `V2Modules` update card for layout only, content per spec §6.16.3 (spec §13.5 C6); *Progress*, *Error* → `V2FirstAid` check rows; wordmark → `V2LogoMorph`, static, red pivot `1`.
- Strings only from `i18n/{en,de}.json`; locale follows the OS with an override.

- [ ] **Step 1: Write the failing tests.** `wizard-model: happy path is three primary actions`, `wizard-model: no runtime on macOS 26 offers the Apple pkg; on macOS 15 shows the guide`, `wizard-model: each error kind maps to a message and a retry target`, `pairing-model` table, `update-model: later, skip, hold, rolled back and recovery failed transitions`, `origin-input: same table as Rust` (`origin-cases.json`), `notes renderer strips HTML and never creates links`, `i18n: en and de have identical key sets and no empty strings`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** Visible focus, labels, `aria-live="polite"` for progress and errors, full keyboard use.
- [ ] **Step 4: Run** → PASS. `pnpm tauri dev` against the fake runtime shows the wizard end to end; record.
- [ ] **Step 5: Commit** `feat(desktop): first-run wizard, connections, settings, update dialog and progress views (de/en, M3 theme)`.

---

### Task 13: SPA window — incognito, ticket login, navigation guard, `spa-bridge`

**Files:**
- Create: `apps/desktop/src-tauri/src/{policy.rs,spa.rs}`, `tests/{policy,spa}.rs`
- Modify: `commands.rs` (`open_connection`, `shell_info`), `lib.rs`

**Interfaces:** as spec DS3/DS5/DS7 and §6.9:
```rust
pub enum NavDecision { Allow, OpenExternal, Block }
pub fn spa_navigation(conn: &Origin, url: &Url) -> NavDecision;   // same origin → Allow; other https/http, mailto → OpenExternal; else Block
pub fn check_spa_caller(label: &str, current: &Url, conn: &Origin) -> Result<(), PolicyError>;
pub async fn open_spa(app: &AppHandle, conn: &Connection, tokens: &dyn TokenStore) -> Result<(), UiError>;
  // token or PairingNeeded → session_ticket (meta + installation check) → WebviewWindow "spa": incognito, drag_drop_enabled(false),
  // <origin>/auth/ticket#t=<ticket>, on_navigation → spa_navigation, on_new_window → Block → add_capability(spa-bridge, exactly <origin>/*,
  // webviews ["spa"], ["allow-shell-info"]) replacing any previous one → /auth/ticket-failed: retry once, then the shell error page
#[tauri::command] fn shell_info(webview: Webview) -> Result<ShellInfo, UiError>;   // { product, version, platform, arch, features: [] }
```
External links open through a Rust-side opener that accepts only `https:`, `http:` and `mailto:` URLs already classified.

**Board references (spec §13.4):** the SPA itself is M3's (canvas boards `V2*`, spec §13.2); this task draws only the shell error page for `/auth/ticket-failed`, which follows the `V2FirstAid` check-row layout like Task 12's *Error* view. The canvas's in-SPA connection switcher (`V2Devices`) is not built here: it needs a `shell_*` command beyond `shell_info` (spec §13.5 C9).

- [ ] **Step 1: Write the failing tests.** `navigation_table`, `caller_check_rejects_other_webview_and_other_origin`, `shell_info_is_the_only_spa_command`, `spa_bridge_capability_is_scoped_to_the_connection_origin`, `switching_connection_replaces_the_capability` (Tauri mock runtime; if it cannot express remote-origin capabilities, test through `policy.rs` plus a recorded manual check and write a ruling), `a_replayed_ticket_page_is_retried_once_then_shows_the_error`, and after an open/close cycle `assert_no_token_on_disk(app_dirs, token)` and `no_cookie_database_in_app_dirs`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; desktop Green; manually: the bundled SPA opens logged in as the owner after the wizard, quit/restart logs in again, a foreign link opens the system browser. Record.
- [ ] **Step 5: Commit** `feat(desktop): SPA in an incognito webview with ticket login, navigation guard and origin-scoped spa-bridge`.

---

### Task 14: Tray, single instance, window lifecycle, harness and runtime state

**Files:**
- Create: `apps/desktop/src-tauri/src/{tray.rs,events.rs}`, `tests/{events,tray_state}.rs`
- Modify: `Cargo.toml` (`tauri` feature `tray-icon`, `tauri-plugin-single-instance =2.5.0`), `lib.rs`, `tauri.conf.json`

**Interfaces:**
```rust
pub enum HarnessState { Starting, Ready, Degraded, Down, Unpaired, Updating, Rollback, Crashed }
pub enum RuntimeState { Ready, Stopped, Missing }
pub struct TrayState { pub harness: HarnessState, pub runtime: Option<RuntimeState>, pub secrets_locked: bool, pub update_available: bool, pub held: bool }
pub fn map_status(ev: &serde_json::Value) -> HarnessState;     // M3's harness.status (DR10); unknown → Degraded
pub fn combine(ctl: &HarnessStatus, ev: HarnessState, upd: &UpdateModelState) -> TrayState;
pub struct EventStream;   // GET /events?topics=harness.status, Bearer, backoff 1 s ×2 → 30 s ±20 %, Last-Event-ID; Revoked → Unpaired
```
- **Tray menu:** header `PLUR1BUS — <connection>` with harness and runtime state in words; *Open PLUR1BUS*; *Start harness* / *Stop harness* (bundled); *Start runtime* (Apple only, when stopped); *Update available: <version>…* (when available); *Connections…*; *Settings…*; *Quit PLUR1BUS* (asks whether to stop the harness; default keep running).
- **Icon:** one per state, monochrome template on macOS; the tooltip states it in words.
- **Single instance:** a second launch focuses `spa` (or `shell` when nothing is paired) and exits.
- **Linux without an AppIndicator host:** the window stays in the taskbar; one-time hint.
- **Board references (spec §13.4):** the canvas has no tray board (gap A13). State words and colours follow spec §13.1's status pairs (ok, warn, error, off); the macOS template icon stays monochrome, so a state is never carried by colour alone.

- [ ] **Step 1: Write the failing tests.** `map_status_table`, `combine_table` (crashed beats ready; runtime missing beats harness; updating/rollback override), `stream_reconnects_with_backoff_and_last_event_id`, `revoked_stream_goes_unpaired_and_stops`, `harness_down_at_start_shows_error_page_and_reconnects`, `quit_asks_and_defaults_to_keep_running` (command-level test), `start_stop_harness_menu_calls_the_controller`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; desktop Green; manually: the tray follows *Stop harness* / *Start harness*, a killed container (restart watch) and quitting Docker Desktop/stopping `container system`. Record.
- [ ] **Step 5: Commit** `feat(desktop): tray with harness and runtime state, start/stop, single instance, hide-on-close`.

---

### Task 15: Log redaction; release feed, channels, update dialog logic; Tauri updater

**Files:**
- Create: `apps/desktop/src-tauri/src/{logging.rs,updates.rs}`, `apps/desktop/bundle/release.schema.json`, `apps/desktop/scripts/render-feed.mjs`, `apps/desktop/src-tauri/keys/{dev,beta,stable}.pub` (placeholders until the owner provides keys; release builds refuse placeholders), `tests/{logging,updates,updater}.rs`, `tests/fixtures/feeds/*.json`
- Modify: `Cargo.toml` (`tauri-plugin-updater =2.13.0`, `minisign-verify`, `tracing`, `tracing-appender`), `tauri.conf.json` (`plugins.updater.pubkey` set by `build.rs` from the channel key; Windows `installMode: "passive"`), `build.rs`, `tray.rs`, `lib.rs`

**Interfaces:**
```rust
// logging.rs
pub fn init(dir: &Path) -> WorkerGuard;   // daily files, 7 kept, 5 MiB each
pub fn redact(line: &str) -> Cow<'_, str>; // Authorization/Cookie/Set-Cookie values; "token"/"ticket"/"csrf"/"code"/"key" JSON values;
                                           // URL query and fragment; any 43+ char base64url run; PLUR1BUS_* env values
// updates.rs
pub enum Channel { Dev, Beta, Stable }     // Dev only in dev builds (cfg); Beta/Stable selectable at run time (DS12)
pub struct Release { pub version: Version, pub channel: Channel, pub kind: Kind /*Major|Minor|Patch*/, pub security: bool, pub date: String,
                     pub notes: Notes { de: String, en: String }, pub migration_note: Option<Notes>, pub min_from_version: Version,
                     pub bundle_digest: String, pub tauri_manifest_digest: String }
pub struct UpdateSettings { pub channel: Channel, pub held: bool, pub auto_patch: bool /*default true for a fresh install, DR20*/, pub quiet_hours: (NaiveTime, NaiveTime),
                            pub skipped: BTreeSet<Version>, pub later_until: Option<SystemTime>, pub check_on_start: bool }
pub async fn fetch(channel: Channel) -> Result<Option<Release>, UpdateError>;   // GET release.json + release.json.minisig; verify with the channel key;
                                                                                // validate against release.schema.json; None when not newer
pub fn decide(r: &Release, running: &Version, s: &UpdateSettings, now: SystemTime, agent_run_active: bool) -> Offer;
pub enum Offer { None, Show, AutoInstall, NeedsIntermediate(Version) }
  // None: held, not newer, skipped (unless security and 7 days passed since skip), later_until in the future, beta→stable downgrade;
  // NeedsIntermediate: running < min_from_version; AutoInstall: auto_patch && kind == Patch && in quiet hours && !agent_run_active; else Show
pub async fn install_app(app: &AppHandle, r: &Release) -> Result<(), UpdateError>;   // Tauri updater with the channel's key; checks that the
                                                                                     // updater manifest digest equals r.tauri_manifest_digest; writes
                                                                                     // upgrades.json { pending: r.version } before restarting
```
- Checks: at start (unless off) and on demand, at most every 6 hours.
- The update dialog (Task 12) calls `update_check`, `update_install` (= *Jetzt*), `update_later`, `update_skip`, `update_settings`.
- `build.rs` fails a `--release` build with a placeholder key unless `PLUR1BUS_DESKTOP_ALLOW_PLACEHOLDER_KEY` (unsigned PR artefacts only).

- [ ] **Step 1: Write the failing tests.**
  - logging: `redact_removes_tokens_tickets_cookies_keys_and_url_fragments`, `the_log_file_never_contains_a_planted_token_or_key`.
  - updates (throwaway minisign keys, wiremock feeds, injected clock): `a_signed_release_is_offered`, `a_bad_signature_is_refused`, `a_key_from_another_channel_is_refused`, `a_lower_or_equal_version_is_not_offered`, `min_from_version_asks_for_the_intermediate_release`, `held_offers_nothing`, `later_waits_24h_or_next_start`, `skip_never_offers_that_version_again`, `a_skipped_security_release_returns_after_7_days`, `auto_patch_is_on_by_default_for_a_fresh_install`, `auto_patch_turned_off_stays_off_after_an_update`, `auto_patch_never_installs_minor_or_major`, `auto_patch_waits_for_quiet_hours_and_no_active_run`, `leaving_beta_never_downgrades`, `schema_invalid_release_json_is_refused`.
  - updater: `a_correctly_signed_update_is_accepted`, `a_tampered_payload_is_refused`, `a_manifest_digest_mismatch_is_refused`, `pending_is_written_before_restart`, `release_build_refuses_the_placeholder_key`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; desktop Green.
- [ ] **Step 5: Commit** `feat(desktop): redacting logger, signed release feed with beta/stable channels, update decisions (later, skip, hold, auto-patch on by default), signed app updater`.

---

### Task 16: Harness upgrade — snapshot, swap, migrate, health gate, rollback, journal

**Files:**
- Create: `apps/desktop/src-tauri/src/controller/{upgrade.rs,journal.rs}`, `tests/{upgrade,journal}.rs`, `tests/upgrade_e2e.rs` (real runtime, gated)
- Modify: `controller/mod.rs`, `commands.rs` (`harness_upgrade_status`, `harness_rollback`), `lib.rs` (on start: resume a journalled upgrade before anything else), `tray.rs`

**Interfaces:**
```rust
pub enum Step { Preflight, Stopping, Snapshotting, Swapping, Migrating, Gating, Done,
                RollingBack, RestoringSnapshot, StartingPrevious, GatingPrevious, RolledBack, RecoveryFailed }
pub struct Journal { pub from: Version, pub to: Version, pub from_digest: String, pub to_digest: String, pub step: Step,
                     pub snapshot_volume: Option<String>, pub manifest_sha256: Option<String>, pub failed_step: Option<Step>, pub diagnostic: Option<String> }
// journal.rs: upgrades.json (0600, no secret); write-then-rename before each step starts
pub struct GateReport { pub ready: bool, pub meta_ok: bool, pub token_ok: bool, pub firstaid_ok: bool, pub smoke_ok: bool, pub failures: Vec<String> }
impl Controller {
  pub async fn upgrade(&self, to: &Bundle, tokens: &dyn TokenStore, conn: &Connection, ui: impl Fn(Step)) -> Result<Outcome, CtlError>;
  pub async fn resume(&self, ...) -> Result<Outcome, CtlError>;               // Review Focus 3
  pub async fn rollback_manual(&self, ...) -> Result<Outcome, CtlError>;
  async fn gate(&self, version: &Version, conn: &Connection, tokens: &dyn TokenStore) -> GateReport;
}
pub enum Outcome { Upgraded { to: Version }, RolledBack { failed_step: Step, from: Version, to: Version }, RecoveryFailed { diagnostic: String } }
```
Sequence exactly spec §6.15.8:
1. *Preflight:* image present or acquired and digest-verified; free space ≥ state used × 1.2 + image; `exec plur1bus 1staid check --json` on the old harness has no `fail` (else `Outcome` error `preflight-failed` with the row; nothing changed).
2. *Stopping:* `stop(150 s)`.
3. *Snapshotting:* `run_oneshot(oneshot_spec(from_digest, ["plur1bus","state","snapshot","--src","/src","--dst","/dst","--json"], [(state,/src,ro),(pre-<from>,/dst,rw)]))`; parse `state.snapshot/1`; record `manifestSha256`; then remove the previous upgrade's snapshot volume, `-previous` container and `plur1bus-state-failed-*` volume. Failure → remove the partial volume, start the old container unchanged, report (Review Focus 5).
4. *Swapping:* rename old → `plur1bus-harness-previous`; create new with `harness_spec(..., extra_env = [PLUR1BUS_UPGRADE_FROM])` and the same port; start.
5. *Migrating:* wait for `daemon status` ready (config migrations run in the supervisor); `1staid check --json` → `engine.storeSchema`; if `current != required`, `exec plur1bus admin migrate --from <current> --to <required> --yes --json`.
6. *Gating:* within 300 s: ready; `/meta` `version == to` and API major supported; `whoami` with the device token; `1staid check` no `fail`; `exec plur1bus admin smoke --json` → `ok`.
7. *Done:* clear `pending`, update `installed.json`, tray green, one notification-equivalent in-app message (native notifications are D2).
8. *Failure from Swapping on:* diagnostic (step, exit code, `logs_tail(200)` through `redact`); stop + remove new; `run_oneshot(previous digest, state verify --dir /snap)`; create fresh `plur1bus-state` after renaming the failed one — runtimes cannot rename volumes, so: create `plur1bus-state-failed-<to>`, copy state into it with `state snapshot` (verified), remove and recreate `plur1bus-state`, then `state restore --src /snap --dst /state` (verified); rename `-previous` back; start; gate on `from`; mark `to` as skipped; `RolledBack`. Any failure inside step 8 → `RecoveryFailed`, nothing deleted.
9. *Manual rollback:* only while `-previous` and the snapshot exist; same as step 8 without the failed-volume copy being optional (it is always made).

- [ ] **Step 1: Write the failing tests** (fake runtimes with scripted exec results; the same scenarios for both adapters):
  - `happy_path_runs_every_step_in_order_and_keeps_previous_and_snapshot`;
  - `preflight_fail_changes_nothing`;
  - injected failures, each asserting automatic rollback, the old version gated, `to` skipped, and the person-facing message naming the step: `new_image_never_ready`, `migration_fails` (harness seam `PLUR1BUS_TEST_FAIL_MIGRATION`), `firstaid_fails_after_upgrade`, `smoke_fails` (`PLUR1BUS_TEST_FAIL_SMOKE`), `token_rejected_after_upgrade`, `gate_times_out`;
  - `corrupted_snapshot_before_restore_is_recovery_failed_and_deletes_nothing`;
  - Review Focus 5 `snapshot_disk_full_restarts_the_old_version_unchanged`;
  - Review Focus 3 `interrupted_upgrade_resumes_at_every_step` (for each `Step`, write that journal state, restart the controller, assert the deterministic resume);
  - `patch_upgrade_with_a_schema_change_is_refused` (defence in depth: a `Patch` release whose `engine.storeSchema` differs aborts before migrating and rolls back);
  - `manual_rollback_restores_the_snapshot_and_warns_first`;
  - `the_device_token_survives_an_upgrade_and_a_rollback`;
  - `diagnostic_is_redacted`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; desktop Green; `upgrade_e2e.rs` with `PLUR1BUS_DESKTOP_E2E_RUNTIME=docker|podman`: install image A (built from `HEAD~` with a lower version label), write synthetic data through the API, upgrade to image B, verify data, then B′ with `PLUR1BUS_TEST_FAIL_SMOKE=1` baked into its env → automatic rollback to B with the data intact → PASS (record).
- [ ] **Step 5: Commit** `feat(desktop): harness upgrade with verified snapshot, migrations, health gate, automatic and manual rollback, crash-safe journal (D78)`.

---

### Task 17: Installers per OS, runtime installation help, uninstall

**Files:**
- Create: `apps/desktop/src-tauri/src/install/{apple_pkg.rs,podman_socket.rs,vendor_installer.rs,target_json.rs,cli_shim.rs}`, `tests/install.rs`, `apps/desktop/src-tauri/linux/{deb-recommends.txt,rpm-weak.txt}`, `apps/desktop/resources/apple/container.pkg` (bundled, staged by the release workflow per DR13/Task 5)
- Modify: `tauri.conf.json` (per-OS bundle settings, resources entry for the bundled Apple pkg, `bundle.linux.deb.recommends: ["podman | docker.io"]`, `bundle.linux.rpm` weak dependency on `podman`), `controller/mod.rs` (`uninstall`), `commands.rs` (`runtime_install_apple`, `runtime_install_vendor`, `runtime_enable_podman_socket`, `uninstall_*`), `.github/workflows/desktop.yml` (variants, filled in Task 18)

**Interfaces:**
- **Apple pkg (macOS 26+, no runtime found) — bundled, not downloaded (DS27).** The signed `.pkg` ships inside the app's `resources/` (staged by the release workflow, pinned by `bundle.apple.pkg_sha256`/`bundle.apple.team_id`, licence text — Apache-2.0 — shown once before the button is enabled); the install step re-verifies its SHA-256 and `pkgutil --check-signature` names Apple's Developer ID with `bundle.apple.team_id` (a bundled file must still match what shipped — this catches a corrupted or tampered app bundle, not a network transfer), then `open -W <pkg>` (Installer asks for the admin password; the app never runs `sudo`), re-detect, `container system start --enable-kernel-install`. Any mismatch → refuse with the reason; nothing is downloaded, so there is nothing to delete.
- **Vendor installer (Windows/Linux GUI path, no runtime found) — download and run, DS27.** `vendor_installer.rs`: for the chosen vendor (Docker Desktop or Podman Desktop on Windows; named but not auto-run on Linux, which prefers the package manager instead), download `bundle.vendor[os].installer_url` over HTTPS, verify its SHA-256/signature against `bundle.vendor[os].sha256` (and, where the vendor publishes one, its own code-signing signature), then run it with no silent/unattended flags — the vendor's own installer UI runs, showing **the vendor's own licence** for the person to accept there. The button's copy names the licence terms up front (Docker Desktop's small-business/personal/education thresholds, §4.11) before the download starts. Any checksum mismatch → refuse with the reason, delete the download, never run an unverified installer.
- **Podman socket (Linux):** when `podman` exists and `$XDG_RUNTIME_DIR/podman/podman.sock` does not answer, the button runs `systemctl --user enable --now podman.socket` (fixed argv), then re-detects.
- **CLI shim:** copies the bundled host `plur1bus` binary to `~/.local/bin/plur1bus` (macOS/Linux) or `%LOCALAPPDATA%\PLUR1BUS\bin\plur1bus.exe`; offers (checkbox, default on) to add that directory to the user's `PATH` (shell profile line with a marker comment on macOS/Linux; `HKCU\Environment\Path` on Windows); never writes to a system directory; an existing non-PLUR1BUS file at the path is not overwritten.
- **`target.json`** written after install (Task 10's format) and updated on runtime/endpoint changes.
- **Variants (DR4):** the release workflow builds the online bundle and, for the offline bundle, places `plur1bus-harness-<arch>.oci.tar` (or the Apple archive per DR13) into `resources/image/` and sets `bundle.tarball[arch]`.
- **Uninstall** from *Settings → Advanced → Uninstall PLUR1BUS*, and from the OS uninstaller (NSIS uninstall section and the deb/rpm `prerm` only remove the app; they print where to find the data): three separate confirmations — containers; images; volumes (shows the size; default *keep*). The CLI shim and its `PATH` line are removed with the containers step. The keychain entries are removed with the volumes step.
- **Board references (spec §13.4):** the canvas has no installer, runtime-install or uninstall board (gaps A1, A2, A15). The Apple pkg licence and the vendor-licence note use the licence-confirm pattern of `V2SetupMemory` (licence named on the choice, confirm before install); the three uninstall confirmations use the destructive button colour of spec §13.1 (`#B42318`), with *keep data* as the default.

- [ ] **Step 1: Write the failing tests.** `apple_pkg_is_bundled_not_downloaded` (asserts no network call), `apple_pkg_refuses_wrong_sha_or_signature` (injected verifier), `apple_pkg_never_uses_sudo` (argv inspection), `vendor_installer_refuses_wrong_checksum` (injected verifier, download deleted), `vendor_installer_never_passes_silent_flags` (argv inspection), `vendor_installer_shows_the_vendor_licence_before_download`, `podman_socket_uses_fixed_argv`, `cli_shim_never_overwrites_a_foreign_file`, `path_line_is_added_once_with_marker_and_removed_on_uninstall`, `target_json_matches_the_forwarder_format` (parse with the same schema as Task 10), `uninstall_scopes_confirm_separately_and_keep_data_by_default`, `offline_variant_uses_the_bundled_tarball`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; desktop Green; build the online and offline bundles for the local OS; manual fresh-install run on each available OS through the wizard with defaults (record the click count and times).
- [ ] **Step 5: Commit** `feat(desktop): installers (online/offline), bundled Apple container pkg with signature checks, Windows/Linux vendor-installer download+verify, Podman socket enable, CLI shim, staged uninstall`.

---

### Task 18: CI — targets, container e2e, Apple strategy, release gate, promotion

**Files:**
- Create: `.github/workflows/{desktop.yml,apple-container.yml,desktop-release.yml,release.yml,release-promote.yml}`, `apps/desktop/canary/{tauri3.patch,README.md}`, `apps/desktop/scripts/{apple-e2e.mjs,repro-check.mjs}`, `tests/upgrade/{workload.mjs,verify.mjs}`, `scripts/release-notes-lint.mjs`, `release-notes/TEMPLATE.{de,en}.md`, `docs/releasing.md`
- Modify: `.github/workflows/container.yml` (e2e jobs), `scripts/lint-hygiene.mjs` (workflow checks)

**Interfaces:**
- **`desktop.yml`:** `pull_request`/`push` on `apps/desktop/**` and the workflow file, plus nightly. Matrix `macos-15`, `windows-2025`, `windows-11-arm`, `ubuntu-24.04`, `ubuntu-24.04-arm` (bare metal): toolchain, Linux deps, `pnpm install --frozen-lockfile`, UI tests, fmt, clippy `-D warnings`, `cargo test --locked` (fake runtimes everywhere), real-keychain smoke on macOS and Windows, `pnpm tauri build` online variant with `PLUR1BUS_DESKTOP_ALLOW_PLACEHOLDER_KEY=1`, artefacts 7 days. Nightly `canary` (DR3) and `repro` (Linux x64 `.deb` built twice, advisory).
- **`container.yml` e2e jobs** on `ubuntu-24.04` and `ubuntu-24.04-arm`, each for **Docker rootful**, **Docker rootless** (`dockerd-rootless-setuptool.sh install` in the job) and **Podman rootless** (user socket): run `controller_e2e.rs`, `upgrade_e2e.rs` and the pull-by-digest path against `registry:2` (DR17), with `PLUR1BUS_DESKTOP_E2E_RUNTIME` set. Each job asserts that the harness port is bound only on `127.0.0.1` (probe the runner's non-loopback addresses).
- **`apple-container.yml`:** `workflow_dispatch` only, `runs-on: [self-hosted, macOS, ARM64, macos-26-container]`, never required. Runs `apple-e2e.mjs --image <tarball or digest>`: fake-free run of install (including `container system start` and `image load`), auto-pair, SPA ticket, kill PID 1 → restart watch, upgrade A→B, injected failure → rollback, uninstall; writes `apple-e2e-<version>.json { version, cliVersion, macOS, steps: [{ name, ok, ms }], operator: "self-hosted" | "manual" }`. The same script run by the owner on his Mac is the **recorded manual check**.
- **`desktop-release.yml`:** `workflow_dispatch` for `dev` builds (environment `desktop-dev`, dev key), replacing the assets of the prerelease `desktop-dev`.
- **`release.yml` (the D78 release gate):** trigger `workflow_dispatch` with `version` (SemVer) and `kind`; the workflow itself creates the tag `v<version>-beta.<n>` only after the gate:
  1. the root `ci.yml` suite on five targets, the kill soak (200 turns; requires a green nightly 1 000-turn run on the same commit), `desktop.yml`, `container.yml` incl. e2e;
  2. **upgrade tests:** for N−1 and N−2 (and the previous major's last release for a major) download `upgrade-fixture-<version>-<arch>.tar.zst` from those releases (for the first releases, before two exist, generate them from the tagged images with `tests/upgrade/workload.mjs`), restore into a volume, run the real controller upgrade to the candidate (Docker adapter), then `tests/upgrade/verify.mjs` (every synthetic fact recalled, config values kept, the fixture module installed, the device token valid), then the injected failing migration → rollback with a matching manifest; for `kind: patch` additionally assert no schema version changed;
  3. `scripts/release-notes-lint.mjs <version>` and the `release.json` schema check;
  4. build and sign: app bundles (online and offline variants), `bundle.json`, images (push by digest, cosign, SBOM attestation, provenance), `release.json` + `.minisig` with the **beta** key (environment `desktop-beta`), `latest.json`; generate this release's own `upgrade-fixture-<version>-<arch>.tar.zst` with the workload and attach it;
  5. publish the GitHub prerelease `v<version>-beta.<n>`.
- **`release-promote.yml`:** `workflow_dispatch` with the beta tag; environment `desktop-release` (owner approval); refuses unless the canary period has passed (7 days minor/major, 48 h patch, or 24 h for `security: true` with an approval note input), no open issue labelled `regression` against the beta, and `apple-e2e-<version>.json` is attached with all steps ok; re-signs `release.json` and the updater artefacts with the **stable** key, re-tags the same images as `:<version>` (digests unchanged, asserted), and publishes `v<version>`. Per DR7 it additionally refuses until D2's OS signing is configured (a repository variable `OS_SIGNING_READY=true`).
- **`release-notes-lint.mjs`:** both files exist; required headings per language; ≤ 25 lines (minor/major) or ≤ 10 (patch); first line starts with `Sicherheit:` / `Security:` when `security: true`; a major has `Migration` sections; no line matching `^(feat|fix|chore|refactor|docs|ci|test)(\(.+\))?!?:`, no `\b[0-9a-f]{7,40}\b`, no bare `#\d+`.
- **`tests/upgrade/workload.mjs`:** drives a running harness through the API and CLI only: creates three synthetic agents, captures 50 synthetic facts from a fixed seed, runs sessions, sets five config keys, installs the fixture module, pairs a synthetic device; writes the expected-state file used by `verify.mjs`. No real data.
- **Hygiene lint:** every `uses:` pinned by 40-hex SHA, no `pull_request_target`, signing/publishing jobs use an environment, `id-token: write` only on jobs that sign.

- [ ] **Step 1: Write the checks first.** Lint self-tests: `workflows_pin_actions_by_sha`, `no_pull_request_target`, `release_jobs_use_an_environment`; `release-notes-lint` self-tests (a commit-log-style note fails; a missing language fails; a good pair passes; a patch over 10 lines fails; a major without migration fails). `tests/upgrade/verify.mjs --self-test` against a state the workload just built. Run → FAIL.
- [ ] **Step 2: Write** the workflows, scripts, template notes and `docs/releasing.md` (calendar rule: a stable minor every 4 weeks, beta cut one week before; the owner may change it there).
- [ ] **Step 3: Run** the lints and self-tests → PASS; `actionlint` if available. Pushing is not allowed (Global Constraints): record that the first real runs happen when the owner pushes, and dry-run the upgrade test locally with two locally built images.
- [ ] **Step 4: Commit** `ci: desktop five-target build, container e2e on Docker rootful/rootless and Podman, Apple self-hosted/manual check, D78 release gate with upgrade tests and notes lint, promotion by re-signing`.

---

### Task 19: Accessibility and i18n pass

**Files:**
- Modify: `apps/desktop/ui/**` (fixes), the M3 a11y runner config (every view reachable through a debug-only `?view=` parameter), `tray.rs` (labels from the catalogue)
- Create: `apps/desktop/ui/test/a11y.test.ts` (if M3's runner is invoked from tests)

- [ ] **Step 1: Run** axe-core over every view (wizard steps, settings pages, update dialog with a long note, rollback message, errors) in both themes and both locales → record violations. Themes are the canvas light and dark sets (spec §13.1, boards `V2Main`/`V2MainDark`/`V2Sidebar`); the glow animations must stop under `prefers-reduced-motion`, and the "needs you" blink (1.4 s) must never be the only signal. The canvas's text below 12 px conflicts with ADR-004's floor (spec §13.5 C3): apply whichever the owner decides, and record it.
- [ ] **Step 2: Fix** until clean; keyboard traversal (Tab order, Enter/Space, Escape), 4.5:1 contrast.
- [ ] **Step 3: Tray and menus** from the catalogue; states spoken in words.
- [ ] **Step 4: Manual screen-reader pass** (VoiceOver, NVDA, Orca where available) over the wizard, the update dialog, a rollback message and opening the SPA; record findings and name any OS not checked.
- [ ] **Step 5: Run** desktop Green and the a11y runner → PASS.
- [ ] **Step 6: Commit** `fix(desktop): WCAG 2.1 AA and keyboard pass on wizard, settings and update views; localized tray`.

---

### Task 20: Docs, ADR notes, AGENTS.md, demo guide, test report

**Files:**
- Create: `docs/desktop.md`
- Modify: `docs/adr/ADR-004-harness-api-and-web-ui.md` (implementation note), `docs/adr/ADR-012-process-model-and-languages.md` (implementation record under §11), `docs/api-surface.md`, `docs/milestones.md` (only if measured numbers change an estimate, DR11), `AGENTS.md`, `deploy/image/README.md`

- [ ] **Step 1: `docs/desktop.md`:** what the app is (runtime controller + client, no own policy); supported runtimes per OS and what to install when none is found (with the Docker Desktop and OrbStack licence notes); installing per OS (online/offline, *Open anyway* / *Run anyway* for D1's unsigned builds); what runs where (one harness container, loopback-only API, volumes, what stays on the host); the host CLI; pairing a remote harness (`tailscale serve`); where tokens and the secret-store key live; updates (channels, notes, *Jetzt/Später/Überspringen*, *Version halten*, automatic patches on by default (and how to turn them off), what an upgrade does, automatic and manual rollback, the manual recovery page for `Wiederherstellung fehlgeschlagen`); uninstall and what stays; known degradations.
- [ ] **Step 2: ADR-004 note:** the DR1 mapping, DS3/DS5 as built, the runtime-capability approach and how it was proven, the `keyring` choice, that the shell adds no policy.
- [ ] **Step 3: ADR-012 §11 implementation record:** `plur1bus init` as built, `state` commands, `1staid check` rows, `admin.smoke`, forwarding latency measured, the Apple spike results (DR13) that affect the process model.
- [ ] **Step 4: AGENTS.md:** `apps/desktop` (own workspace, Green commands), `deploy/`, the debug-only seams (DR19), the container-mode env vars, the rule that no key file or OCI tarball is ever committed, and how to run the container e2e locally.
- [ ] **Step 5: Demo guide and test report** (milestones §6.1 item 7) in the PR description draft: demo — fresh install on Linux with Podman (three clicks → SPA as owner), the same on macOS with Apple `container` (recorded), kill the container → restart, *Stop/Start harness*, host `plur1bus daemon status`, a beta update with notes → *Jetzt* → upgraded, an injected failing upgrade → automatic rollback with the message, *Version halten*, remote pairing, revoke → re-pair; the report maps spec §8 criteria 1–15, 5a, 5b to tests or recorded checks, lists image sizes, forwarding latency, canary and repro results, the Apple record, screen-reader findings, and everything skipped with the reason.
- [ ] **Step 6: Run** `pnpm docs:check`, `pnpm lint`, all Greens.
- [ ] **Step 7: Commit** `docs(desktop): user guide, ADR-004 and ADR-012 implementation notes, AGENTS.md, deploy README`.

---

## D2 — Native integration and signed stable releases (outline; own full plan after D1 merges)

Same Global Constraints. Tasks named, not detailed:

1. **Notifications** (`tauri-plugin-notification`) and `host.notify` over the bridge: the harness decides what is notified; minimal lock-screen text; clicks go through `spa_navigation`. Upgrade results use them too.
2. **Global shortcut and push-to-talk** (`tauri-plugin-global-shortcut`): person-chosen binding; `ptt:down/up` to the SPA; microphone only for the connection origin; Wayland fallback.
3. **Deep links** (`plur1bus://pair`, `plur1bus://open`) with single-instance and spoofing tests.
4. **Host bridge capabilities** `host.localModel` (D51 b, OpenAI-compatible relay to a host server on 127.0.0.1, macOS's only path to a large local model per design DS26) and `host.filePick`.
5. **Bind mounts:** Obsidian vaults (one read-write bind mount per vault, multiple vaults supported, chosen with a native folder picker — a local folder, an iCloud/Sync folder, or a host-mounted NAS share) and a backup folder; container recreate on add/remove; the Obsidian bridge detects changes by **polling** (mtime scan), never inotify, because host→container notifications are not reliable over a virtiofs bind mount (design §4.18); `admin obsidian detect` sees mounted vaults only. No canvas board yet (spec §13.3 A8); `V2AgentMemory` and `V2MemorySettings` show the vault rows the picker feeds.
6. **Windows WSL fallback** (spec §4.12): a PLUR1BUS WSL distro built from the image rootfs, `wsl --import` per user, started by the app with `plur1bus init`, caveats shown.
7. **macOS Developer ID + notarisation; Windows signing** (owner's choice, Q1); **Linux GPG**; set `OS_SIGNING_READY=true` → first real `stable` promotion.
8. **`deploy/upgrade.sh`** for compose (the D78 sequence: snapshot, migrate, gate, rollback) and its CI test on Linux.
9. **Docs, ADR note, demo, report.**

## D3 — Browser container, native panel and egress (outline)

*Amended 2026-09-27 (owner; spec DS37–DS39, §4.23):* the in-app panel is native on every OS — a second embedded **WebView2** on Windows, **CEF** on macOS and Linux — and agents drive it over in-process CDP; the `plur1bus-browser` container serves **windowless cases only** (app closed, remote harness, headless). *History:* this outline was "Browser container, CEF panel and egress" with a streamed-Chromium panel on Windows.

Preconditions: the harness has shipped the D72 port registry, D73 egress with `egress.resolve`, and D74 b streamed Chromium (for the windowless path). The **Tauri 3 gate** (Tauri 3 ≥ beta, `tauri-runtime-cef` out of alpha, canary plus five-target smoke green for 14 consecutive nights) now gates only the **macOS/Linux** CEF panel; the Windows WebView2 panel does not wait for it.

0. **Spike (first, time-boxed, report before step 2):**
   - Tauri 2 multi-webview (a child webview in the main window) is behind the `unstable` feature as of Tauri 2.12.0 (2026-09-27, spec §4.23): build the Windows panel with it, and in parallel with **wry directly** as the fallback; pick one on measured criteria (resize/detach/re-attach, focus, IPC isolation — Tauri ≥ 2.12.0 for the per-webview channel fix).
   - **WebView2 CDP coverage** through `CallDevToolsProtocolMethod`/`…ForSession` + `GetDevToolsProtocolEventReceiver`: `Input.dispatchMouseEvent` (click, drag, wheel — **unverified**, no source found), `Input.dispatchKeyEvent`/`insertText` (trusted per webdriverio PR #620; accelerators do **not** fire, WebView2Feedback #1278; no frame parameter), `Page.navigate`, `Page.captureScreenshot`, `DOM.*`, `Accessibility.getFullAXTree`, `Runtime.evaluate`, `Network.*` events, `Target.setAutoAttach { flatten: true }` for iframes, `Page.setInterceptFileChooserDialog`. Record pass/fail per method; any fail goes to the owner before the Windows panel is built on it.
   - WebView2 per-profile proxy argument, SOCKS5 host-name resolution, and a WebRTC non-proxied-UDP block (spec §6.4).
1. **`plur1bus-browser` image and container (windowless only):** streamed Chromium, 2 GiB cap, started on demand, stopped after 15 min idle; Docker: internal network only, web through the harness egress proxy; Apple: shared network, the IP handed over through the bridge (`browser.attach`), proxy policy-enforced (named degradation); its own release cadence inside D78 (security patches within 14 days). The `browser` tool falls back to it when no app window is attached.
2. **Windows WebView2 panel** (wry runtime stays): second webview, own user data folder per egress profile, `on_navigation` `http(s)`-only, `on_download` quarantine, file-chooser policy, no capability, no `--remote-debugging-port` (refuse start if `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` sets one); Evergreen runtime with a minimum-version check; offline installer uses `offlineInstaller` (spec DS39).
3. **Runtime move on macOS/Linux** to Tauri 3 + `tauri-runtime-cef` after the gate; CEF pinned with SHA; size measured. **Sandbox gating (DS8)** for CEF; restricted AppImage per spec §11 Q9 (open; interim: panel off, windowless container).
4. **Panel webviews** (collapse, detach, re-attach, F6), no IPC for panels, scheme allow-list, download quarantine — one SPA-side panel UI for both engines, states *loading* / *agent-driving* (*Take over* / *Stop*) / *error* / *login-required*.
5. **Profiles and egress (DS11)**, fail-closed tests, publishing per-profile proxy ports to host loopback for panels.
6. **CDP** token proxy / remote relay over the host bridge, method allow-list, hostile-client tests; one engine-agnostic `browser` tool over WebView2, CEF and the container, with per-engine capability reporting for the gaps the spike finds.
7. **Agent visibility and handover**; **CEF update duty** (macOS/Linux) and the WebView2 Evergreen canary (Windows); **accessibility**; **docs, demo, report**.

## D4 — Computer-use onboarding and WebMCP bridge (outline)

1. **`host.computerUse`** over the bridge: the app relays MCP calls to the host `cua-driver`; tray indicator and kill switch.
2. **macOS onboarding (DS10)**, Linux/Windows guidance. Board: the computer-use block of `V2SkillsLibrary` (two grants, indicator, stop; spec §13.4).
3. **WebMCP consumer in panels (D55 b)** with payload limits and the harness allowlist and approvals.
4. **Flatpak** if the owner says yes (Q3).
5. **Docs, ADR note, demo, report.**

---

## Self-review (done while writing)

- **Spec coverage (D1):**
  - DS1 → Tasks 4, 7, 9, 12, 17 (bundle as containers; remote and native attach kept in Tasks 9, 12).
  - DS2 → Task 1, Task 18 (canary). DS3/DS5 → Tasks 2, 13. DS4 → Task 8. DS6 → Tasks 8, 9. DS7 → Tasks 1, 9, 12, 13.
  - DS12 → Tasks 15, 18. DS13 → Task 1.
  - DS14 → Tasks 5, 6. DS15 → Task 4 (one harness container; browser in D3). DS16 → Tasks 7, 10 (loopback, no socket, exact spec). DS17 → Tasks 2, 11. DS18 → Tasks 3 (storage row), 7 (volumes). DS19 → Task 3. DS20 → Tasks 4, 7, 18. DS21 → Task 16. DS22 → Task 20 (docs keep the native path; Task 3 refusals). DS23 → Tasks 5, 18. DS24 → Tasks 15, 16, 18.
  - §6.15.1–§6.15.12 → Tasks 3–7, 10, 11, 16, 17, 18. §6.16 → Tasks 12, 15, 16, 18. §6.8 autostart → Task 7. §6.14 D1 rows → Tasks 2, 3.
  - DS8–DS11 are D3/D4 and outlined there.
- **Acceptance (spec §8):** 1 → Tasks 7, 9, 17, 18 (Docker e2e, loopback probe, token scan). 2 → Tasks 5, 18 (fake CLI + Apple record). 3 → Task 6. 4 → Tasks 3, 7. 5 → Task 16 (+ Task 18 e2e). 5a → Tasks 12, 15. 5b → Task 18. 6 → Task 10. 7 → Tasks 2, 11. 8 → Tasks 8, 9. 9 → Task 9. 10 → Task 13. 11 → Task 13. 12 → Task 15. 13 → Task 18. 14 → Task 19. 15 → Task 15.
- **Review Focus:** 1 → Task 9, 2 → Task 7, 3 → Task 16, 4 → Task 7, 5 → Task 16, 6 → Task 8, 7 → Task 6.
- **Type consistency:** `Runtime`/`ContainerSpec`/`RuntimeError` (Task 5) are used in Tasks 6, 7, 16; `Detected`/`choose_default` (Task 6) in Tasks 7, 12; `Controller`/`HarnessStatus`/`InstallStep` (Task 7) in Tasks 9, 12, 14, 16, 17; `Origin`/`Connection`/`Store`/`TokenStore`/`SecretString` (Task 8) in Tasks 9, 11, 13, 14, 16; `HarnessClient`/`Meta` (Task 9) in Tasks 11, 13, 14, 16; `Release`/`UpdateSettings`/`Offer` (Task 15) in Tasks 12, 16; `Journal`/`Step`/`Outcome` (Task 16) in Tasks 12, 14.
- **Constraints:** no secret file or tarball committed (Task 1 lint); no policy in the shell (every permission is an `$API` scope, Task 2); the token and the secret-store key never on disk outside the keychain (Tasks 8, 11, 15); no runtime socket or host mount in any container (Task 7 `create_spec_is_exact`, Task 4 compose test); consumers never receive an untested build (Task 18 gate, promotion by re-signing).
