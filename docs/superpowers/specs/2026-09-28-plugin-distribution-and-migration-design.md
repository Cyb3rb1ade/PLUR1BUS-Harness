# Host-mode plugin distribution and cross-platform migration: design

**Status:** Draft for owner review · **Date:** 2026-09-28 · **Owner:** Christian (Cyb3rb1ade) · **Decision rows:** core spec D86–D91 (`2026-09-24-m1b-2a-core-daemon-cli-design.md` §2) · **Milestones:** new track HM (HM1–HM4) and additions to M7, D2 (`docs/milestones.md`) · **Inputs:** ADR-002 (P9, P10), ADR-006 (licence gate), ADR-012, ADR-016; core spec D8, D28, D77, D78, D79–D85; `docs/host-adapters.md`; `docs/import.md` §8–§9; desktop spec DS22, DS28–DS34, §6.15; extensions spec §7.3; the 2a-H3b-b release branch `feat/h3bb-t10-release` @ `9955b72`.

**Owner requirements, 2026-09-28 (translated from German):**
1. "The plugin for OpenClaw and Hermes, for people who don't want to use PLUR1BUS standalone, also needs installation packages for Linux, macOS and Windows."
2. "The migration assistant from Hermes with PLUR1BUS installed, or from OpenClaw with PLUR1BUS installed, must work on all platforms."

The owner was not available while this was written. Every open choice has a default the design runs on; the owner's choices are in §C with a recommendation each.

## 0. Terms

- **Host mode** — PLUR1BUS memory inside another agent system (OpenClaw or Hermes) without the standalone harness: no harness channels, web UI, agents or scheduler of its own. The host owns the conversation; PLUR1BUS owns memory.
- **Harness mode** — the standalone PLUR1BUS Harness (native install §6.5 of the core spec, or the D77 container bundle).
- **Source** — an OpenClaw state dir or Hermes home the migration assistant reads.
- Targets are D8's five: `linux-x64`, `linux-arm64` (glibc), `darwin-arm64`, `win-x64`, `win-arm64`.

## 1. Verified facts this design rests on

Evidence: the local checkouts are OpenClaw `b9421f4` (2026-09-21, `package.json` version `2026.9.5`), hermes-agent `743ee72` (2026-09-21, version `0.21.4`), the plugin `openclaw-plur1bus-memory` `5ffe71d5` (version `7.16.11`), all read 2026-09-28. Web sources carry their own date.

| # | Fact | Source |
|---|---|---|
| F1 | OpenClaw runs **natively on Windows** (PowerShell installer `iwr -useb https://openclaw.ai/install.ps1 \| iex`, Gateway as a Scheduled Task, Startup-folder fallback) **and in WSL2** ("the most Linux-compatible Gateway runtime"). The native **Windows Hub** app's default *Set up locally* provisions an **app-owned WSL distro `OpenClawGateway`** and installs the Gateway inside it. | `docs/platforms/windows.md` @ `b9421f4` |
| F2 | OpenClaw state dir: `OPENCLAW_STATE_DIR`, else `<home>/.openclaw` (legacy `.clawdbot` if only that exists); `<home>` = `OPENCLAW_HOME` → `HOME` → `USERPROFILE` → `os.homedir()`; named profiles use `<home>/.openclaw-<profile>`; config `OPENCLAW_CONFIG_PATH` else `<state>/openclaw.json`. Same rule on every OS (Windows: `%USERPROFILE%\.openclaw` unless `HOME` is set). | `src/config/state-dir.ts`, `src/config/paths.ts:223-245`, `src/cli/profile-utils.ts:31-42`, `packages/normalization-core/src/home-dir.ts:30-60` @ `b9421f4` |
| F3 | `openclaw plugins install` takes `clawhub:<pkg>[@ver]`, npm specs (exact version or dist-tag only), `npm-pack:<tgz>`, git, archives. **Dependencies install in one managed npm project per plugin with `--ignore-scripts`**; `--pin` applies to npm installs only; explicit ClawHub version selectors stay pinned by themselves; ClawHub ClawPack artefacts are digest-verified by OpenClaw; install records keep npm integrity, shasum and ClawPack digest; incompatible `pluginApi`/`minGatewayVersion` is refused before install; `plugins inspect <id> --runtime --json`, `plugins update`, `plugins uninstall [--keep-files] [--force]` exist; plugins live under `<state>/extensions` and `<state>/npm/…`. | `docs/cli/plugins/install.md:12-24,52-69,136-137,168-170,191`, `docs/cli/plugins/uninstall-and-update.md:23-58`, `docs/cli/plugins/inspect-and-diagnose.md:16-26`, `src/security/installed-plugin-dirs.ts:46`, `src/cli/plugins-cli.ts:180-205` @ `b9421f4` |
| F4 | The plugin README's install line `openclaw plugins install clawhub:… --acknowledge-clawhub-risk --pin` uses a flag **OpenClaw 2026.9.5 no longer defines** (options: `--link --force --pin --accept-capabilities --dangerously-force-unsafe-install --acknowledge-install-policy-warning --marketplace`), and the README states "Node.js 22.22 or newer" while the package and OpenClaw require Node `>=24.16 <25 \|\| >=26.1`. | plugin `README.md:1125-1142`, `package.json` `engines`; OpenClaw `src/cli/plugins-cli.ts:188-208`, `docs/install/node.md:10-18` |
| F5 | Native deps of the plugin and their prebuilt coverage for all five targets: `@lancedb/lancedb` 0.26.2 ships `darwin-arm64`, `linux-{x64,arm64}-{gnu,musl}`, `win32-{x64,arm64}-msvc` as optionalDependencies; `onnxruntime-node` 1.24.3 (via `@huggingface/transformers` 4.2.0, optional) ships CPU binaries **inside its tarball** for `darwin/arm64`, `linux/{x64,arm64}` (glibc, `GLIBC_2.27` floor, no musl), `win32/{x64,arm64}` (with DirectML); its install script only fetches CUDA extras, so `--ignore-scripts` does not remove the CPU runtime; `sharp` 0.35.4 ships `@img/*` prebuilds for all five; `node:sqlite` is built into Node. Nothing needs a compiler on any D8 target; Alpine/musl is unsupported (onnxruntime). | `node_modules/*/package.json` and `onnxruntime-node/bin/napi-v6/*` in the plugin checkout; `readelf -V libonnxruntime.so.1` |
| F6 | The plugin's CI runs the full suite on `ubuntu-latest` only; `windows-latest` runs two test files (verified-path, shared memory); `macos-latest` runs two portability jobs. No job installs the packed plugin into a real OpenClaw on any OS. | `.github/workflows/{ci,windows-verified-path,macos-portability,macos-scoped-embedding}.yml` @ `5ffe71d5` |
| F7 | The plugin's existing installer `scripts/install-memory-system.sh` is **bash + rsync + jq + python3**, targets `~/.openclaw` or SSH remotes, restarts via `systemctl --user` — it does not run on native Windows. The plugin's `postinstall` (`setup-feature-crons.mjs`) never runs under `openclaw plugins install` (F3 `--ignore-scripts`). The NC licence gate exists: `PLUR1BUS_ACCEPT_NONCOMMERCIAL_LICENSE=1`, else fallback to `multilingual-e5-small`; recorded as `modelPreparation.acceptNonCommercialLicense`. | `scripts/install-memory-system.sh:1-45,769-816,1206`; `scripts/auto-capture-lancedb.mjs:165`; ADR-006 §"Non-interactive install" |
| F8 | **Hermes runs natively on Windows** ("CLI, gateway, TUI, and tools all work natively"; PowerShell `iex (irm https://hermes-agent.nousresearch.com/install.ps1)`), and in WSL2 with the Linux installer. Home: `HERMES_HOME` (with `expanduser` + `expandvars`), else `%LOCALAPPDATA%\hermes` on Windows (fallback `~\AppData\Local\hermes`), `~/.hermes` elsewhere; profile mode sets `HERMES_HOME=<root>/profiles/<name>`; a sticky `active_profile` file lives in the root. | `README.md:37-59`; `hermes_constants.py:45-57,78-106,177-200` @ `743ee72` |
| F9 | Hermes memory providers: bundled `plugins/memory/<name>/`, user **`$HERMES_HOME/plugins/<name>/`** (directory with `__init__.py` + `plugin.yaml`), project dir (opt-in), and pip packages in entry-point group **`hermes_agent.memory_providers`**; one provider active by name in `memory.provider`; bundled wins on collision. `hermes plugins install <catalog-name\|git-url\|owner/repo>` clones into the user plugin dir. User plugins declare Python deps in `pyproject.toml` or `plugin.yaml` `python_dependencies`; **`hermes update` rebuilds the venv and re-applies only those declarations** (memory plugins dropped last on conflict); `python_runtime: external` opts out. | `plugins/memory/__init__.py:1-8,27`; `website/docs/developer-guide/memory-provider-plugin.md:15-66`; `hermes_cli/plugins_cmd.py:795-855`; `hermes_cli/plugin_python_deps.py:1-15,120,421` @ `743ee72` |
| F10 | The Hermes plugin catalogue is human-merged, pins full 40-char SHAs, and **forbids self-updating code** in a listed plugin. | `plugin-catalog/README.md` rules 1–6 @ `743ee72` |
| F11 | Hermes provisions Node **26 on POSIX but 22 on Windows** — below the engine's `>=24.16` floor, so the engine cannot run on Hermes' own Node on Windows. | `scripts/install.sh:61`, `scripts/install.ps1:395` @ `743ee72` |
| F12 | The harness core daemon already serves `memory.recall`, `memory.capture`, `memory.checkpoint` (stable) plus `agent.open/close/status` over local RPC 1.3.0. | `docs/rpc.md:33-45,212-495,1153-1352` @ `bf35866` |
| F13 | The H3b-b release workflow builds per-target core payloads on the target's own runner (native addons), the Rust `plur1bus` launcher with the payload hash baked in, macOS codesign + notarisation (environment `macos-signing`), `release-native.json`, `SHA256SUMS`; `install.sh`/`install.ps1` verify SHA-256 before anything runs, never use sudo/admin, and do **not** yet verify the feed's minisign signature (HB19). | `.github/workflows/harness-release.yml`, `scripts/release/{assemble-payload,release-native}.mjs`, `scripts/install/install.{sh,ps1}` on `feat/h3bb-t10-release` @ `9955b72` |
| F14 | GitHub `windows-2025` runners carry WSL (2.6.1.0 in image `20250929.44.1`, Oct 2025) but no distro; installing one in-job works (`wsl --install --from-file`, or `Vampire/setup-wsl`, which defaults to WSL 2). WSL on `windows-11-arm` is not documented. | [runner-images#11265](https://github.com/actions/runner-images/issues/11265) (Dec 2024–Jan 2025), [#13222](https://github.com/actions/runner-images/issues/13222) (Oct 2025), [#11784](https://github.com/actions/runner-images/issues/11784) (Mar 2025), [Vampire/setup-wsl](https://github.com/vampire/setup-wsl) (read 2026-09-28) |
| F15 | Microsoft recommends against cross-OS file access for performance; Linux files are reached from Windows at `\\wsl$\<distro>\…` (Windows 11 also `\\wsl.localhost\<distro>\…`, knowledge ≤ 2026-06). | [learn.microsoft.com/windows/wsl/filesystems](https://learn.microsoft.com/en-us/windows/wsl/filesystems) (updated 2022-03-03, read 2026-09-28) |
| F16 | The harness state root is `~/.plur1bus`, `%LOCALAPPDATA%\PLUR1BUS` or `$PLUR1BUS_HOME`; `plur1bus setup` already has `--non-interactive --accept-nc-licence --no-service`. | `docs/cli.md:114,262` @ `bf35866` |
| F17 | In the D77 container bundle the harness (and so the importer) runs **inside a Linux container** with state on named volumes, never on host bind mounts; the desktop spec has no import path from host-side sources. The canvas has **no import or migration board** (`V2Agents` lists "import" as an action; the canvas setup rail has no import step, desktop spec §13 C12). | core spec D77; desktop spec §6.15, §13 C12, row `V2Agents`; canvas index (185 boards, read 2026-09-28) |

## A. Plugin distribution (host mode)

### A.1 Matrix per host and OS (D86)

| Host | OS / target | Host runs | Channel | Installer |
|---|---|---|---|---|
| OpenClaw | linux-x64, linux-arm64 (glibc ≥ 2.27) | native | ClawHub `clawhub:@cyb3rb1ade/plur1bus-memory@<ver>` (primary), npm `@cyb3rb1ade/plur1bus-memory@<ver> --pin` (fallback), verified GitHub-Release tarball via `npm-pack:` (offline) | `install-plugin.sh` |
| OpenClaw | darwin-arm64 | native | same | `install-plugin.sh` |
| OpenClaw | win-x64, win-arm64 | **native** (CLI/Gateway from `install.ps1`) | same, through the Windows `openclaw.cmd` | `install-plugin.ps1` — **beta** until the HM1 Windows jobs are green for four weeks |
| OpenClaw | Windows + WSL2 (own distro or Hub's `OpenClawGateway`) | Linux inside WSL | same, inside the distro | `install-plugin.ps1` **delegates** to `install-plugin.sh` inside the distro (A.3 step 1) |
| Hermes | linux-x64/arm64, darwin-arm64 | native | Hermes directory plugin `$HERMES_HOME/plugins/plur1bus/` + the `plur1bus` core as a sidecar (A.6) | `install-plugin.sh --host hermes` |
| Hermes | win-x64, win-arm64 | **native** (F8) | same under `%LOCALAPPDATA%\hermes\plugins\plur1bus\` | `install-plugin.ps1 -Host hermes` |
| Hermes | Windows + WSL2 | Linux inside WSL | same, inside the distro | `.ps1` delegates as for OpenClaw |

Alpine/musl, darwin-x64 and 32-bit targets are out (D8, F5). The OpenClaw plugin stays one npm package for every OS: the native addons are resolved by npm from optional platform packages (F5), so there is no per-OS plugin build.

### A.2 OpenClaw: prebuilt-native verification (HM1)

New workflow `plugin-dist.yml` in the plugin repo, on tags and nightly:

1. **pack once** on `ubuntu-24.04`: `npm ci && npm test && npm pack`; record SHA-256 and npm integrity.
2. **install matrix** — `ubuntu-24.04`, `ubuntu-24.04-arm`, `macos-15`, `windows-2025`, `windows-11-arm`, each with Node 24.21.0 and OpenClaw pinned twice (the plugin's `minGatewayVersion` and `latest`): install OpenClaw with its own installer into a temp `OPENCLAW_STATE_DIR`, then `openclaw plugins install npm-pack:<tgz> --force --accept-capabilities` (exercises the same `--ignore-scripts` managed npm project as ClawHub, F3).
3. **load and self-test**: `openclaw plugins inspect memory-lancedb-namespaced --runtime --json` must report `loaded`; `openclaw plur1bus selftest --json` (new, A.4) must pass with the local E5 model (MIT) downloaded into the temp state dir; a failure prints which native addon failed to load (`@lancedb/lancedb-<triple>`, `onnxruntime_binding.node`, `sharp`).
4. **full suite on Windows and macOS** — the existing `npm test` extended from Linux-only to `windows-2025`, `windows-11-arm`, `macos-15` (tests that are POSIX-only by nature keep an explicit skip with a reason; F6 shows two Windows files today).
5. **WSL leg** (`windows-2025`, non-blocking, F14): same steps 2–3 inside an Ubuntu 24.04 distro, driven from PowerShell through `wsl.exe`, to prove the delegation path of A.3.

Windows is **native** for the plugin on both Windows targets (the Windows port of ADR-002 P9 lands in the plugin, which already carries named-pipe IPC and ACL `securePath` in `lib/platform.js`); **WSL** is a supported second path because it is how Windows Hub installs OpenClaw by default (F1). The docs say which one the user has: `install-plugin.ps1` tells them.

### A.3 Installers `install-plugin.sh` / `install-plugin.ps1` (D87)

One-liners, hosted beside the harness installers and signed the same way (A.5):

```
curl -fsSL https://plur1bus.app/install-plugin.sh | sh -s -- [--host openclaw|hermes] [flags]
iex "& { $(irm https://plur1bus.app/install-plugin.ps1) } [-Host openclaw|hermes] [flags]"
```

The shell script stays POSIX `sh` (like `install.sh`); the PowerShell script runs on Windows PowerShell 5.1 and pwsh 7, is ASCII-only, hashes with .NET (the H3b-b fix `9955b72`). Both are thin: they fetch the signed plugin feed and hand over to a Node or Rust step only where the host already provides it. Flow:

1. **Detect the host.** OpenClaw: `openclaw --version` on `PATH`, plus the state dir per F2 (`OPENCLAW_STATE_DIR`, profile, `HOME`/`USERPROFILE`). Hermes: `hermes --version`, home per F8. On Windows additionally enumerate WSL distros (`wsl.exe -l -q` with `WSL_UTF8=1`) and probe `openclaw`/`hermes` inside each (`wsl.exe -d <d> -e sh -lc 'command -v openclaw'`), including `OpenClawGateway`. Several candidates → an explicit list and a choice (`--target native|wsl:<distro>`); non-interactive with several candidates → exit 2 naming them. A WSL target makes the `.ps1` run the `.sh` inside that distro with the same pinned version and expected hash, so there is one Linux code path.
2. **Check compatibility** before touching anything: host version against the plugin's `openclaw.compat.{pluginApi,minGatewayVersion}` (OpenClaw re-checks, F3), Node range (F4), target in the matrix, free disk (package + model), and for OpenClaw `openclaw config validate` (`plugins install` fails closed on invalid config and points at `openclaw doctor --fix`; the installer surfaces that message instead of retrying).
3. **Install.** OpenClaw: `openclaw plugins install clawhub:@cyb3rb1ade/plur1bus-memory@<ver>` (exact selector = pinned, trusted source, no `--force`); `--source npm` uses `@cyb3rb1ade/plur1bus-memory@<ver> --pin`; `--offline <tgz>` verifies the tarball against the signed feed and uses `npm-pack:<tgz> --force --accept-capabilities`. An existing install is never overwritten by `install`: the script switches to `update` (step 6). Then run what `postinstall` would have done (F7): `node <plugin>/scripts/setup-feature-crons.mjs`, which is idempotent and fails closed. Hermes: A.6.
4. **Licence gate** (A.9), then write the embedding/reranker choice into the plugin config through the host's own config command (`openclaw config set plugins.entries.memory-lancedb-namespaced.config…`), never by editing `openclaw.json` directly (OpenClaw honours `$include` write-through, F3).
5. **Verify** (A.4). Any failure: roll back to the pre-install state (uninstall the new install record, or restore the previous version through `plugins update … @<previous>`), print the failing check and exit non-zero.
6. **Update** `--update [--version <v>]`: read the installed version from the install record (`plugins inspect --json`), show the release notes from the feed (D78: notes first), take the plugin's existing LanceDB snapshot (the mechanism the bash installer already uses, `<state>/memory/.snapshots/`, max 5) through a new Node entry `scripts/snapshot-store.mjs`, `openclaw plugins update memory-lancedb-namespaced@<v>` (keeps the pin semantics), verify, restore the snapshot and previous version on failure.
7. **Uninstall** `--uninstall [--purge]`: `openclaw plugins uninstall memory-lancedb-namespaced --force` (OpenClaw resets the memory slot to `memory-core`, F3); the memory store and model cache stay unless `--purge` (which asks twice interactively and requires `--yes-delete-memories` non-interactively).
8. **Report**: one summary line per step; `--json` for automation; exit codes `0` ok, `1` failed and rolled back, `2` needs a choice, `3` incompatible host, `4` verification failed after rollback failed (manual action printed).

**No `.pkg` or `.msi` for the plugin in v1** (owner decision C1). Reasons: the files belong to OpenClaw's managed plugin root and install index (F3), so an OS package would either duplicate them or fight OpenClaw's own `plugins update/uninstall`; Add/Remove Programs would show an entry that can drift from `openclaw plugins list`; an MSI without SignPath (pending, desktop spec DS31) warns harder than a script; the per-user one-liner already needs no admin. Revisit when the desktop app gains an "Install into my OpenClaw/Hermes" action (D2), which is the natural GUI for this and reuses the same scripts.

### A.4 Verification checks

| Check | How | New work |
|---|---|---|
| Plugin loads | `openclaw plugins inspect memory-lancedb-namespaced --runtime --json` → `loaded`, no `sdk-incompatible` diagnostic | — |
| Integrity | the install record's npm integrity / ClawPack digest (F3) equals the value in the signed feed; mismatch → uninstall and fail | installer only |
| Engine self-test | `openclaw plur1bus selftest --json`: opens a throw-away store in a temp dir under the state root, embeds two probe texts with the configured provider, captures, recalls, reranks if enabled, deletes the store; reports each native addon's load result and timings | **new plugin CLI** (`registerCli`), ~1–2 ad |
| Embedding model | pinned artefacts (`lib/providers/local-model-artifacts.js`) present in the model cache, or reachable (HEAD on the pinned revision) and `--download-models` given; offline without the model → warn, E5 fallback stays usable once downloaded | selftest flag |
| Gateway picks it up | with a running Gateway the install is applied live (F3); otherwise the script says the plugin is active on the next start and offers `openclaw gateway restart` | — |
| Hermes | `hermes memory status` names `plur1bus`; the provider's `is_available()` true; the sidecar answers `core.status`; one recall/capture round-trip through the provider in a temp profile | A.6 |

### A.5 Signing and checksums (reuse of the H3b-b pipeline)

- **Feed**: `https://updates.plur1bus.app/plugin/{channel}.json` (same host as the harness feed, D78/DS28), one entry per host adapter and version: ClawHub spec, npm integrity, tarball URL + SHA-256, Hermes wheel/zip + SHA-256, sidecar `release-native.json` reference, minimum host versions, notes de/en. Signed with **minisign by the same release key and GitHub Environment as `release-native.json`** (C6). The scripts verify SHA-256 of every download; the minisign check of the feed itself follows the harness's HB19 limit (HTTPS only in the bare script; the Node/Rust step verifies the signature where available), stated in the script header.
- **npm**: publish with `npm publish --provenance` from `release.yml` (GitHub OIDC), so `npm audit signatures` verifies; ClawHub gets the same tarball (ClawPack digest, F3).
- **Scripts**: `install-plugin.sh`/`.ps1` are release artefacts in `SHA256SUMS`; the `.ps1` is Authenticode-signed through SignPath once approved (DS31), unsigned with the documented note until then (as `install.ps1`).
- **Sidecar** (Hermes, A.6): the unchanged `plur1bus` launcher and core payload from `harness-release.yml`, macOS-signed and notarised there; nothing new to sign.
- **GitHub artefact attestations** (`actions/attest-build-provenance`) for the tarball, the Hermes package and both scripts.

### A.6 Hermes host-mode adapter (D88)

**Shape.** A **directory memory provider** `plur1bus` in `$HERMES_HOME/plugins/plur1bus/` (F9) — `plugin.yaml` (name, `python_dependencies: ["plur1bus-memory-client==<x.y.z>"]`), `__init__.py` with `register(ctx)` and a `MemoryProvider` subclass, `config_schema.py`, `cli.py` (`hermes plur1bus status|selftest`) — plus the **harness core as a local sidecar**: the unchanged `plur1bus` binary set up with `plur1bus setup --profile host --non-interactive [--accept-nc-licence]` (`--profile` is a new setup option), which installs supervisor + core only (no channel modules, no web UI, no scheduler jobs beyond the engine's own maintenance), registers the user service (launchd / `systemd --user` / Task Scheduler, core spec §6.5) and serves RPC on the local socket/named pipe. The Python provider holds no engine, store or model (D28 rule 1 holds: the engine lives in the core); it maps hooks onto the stable RPC (F12):

| `MemoryProvider` hook (F9 doc) | RPC |
|---|---|
| `initialize(session_id, hermes_home, agent_identity, user_id, chat_id, platform, agent_context, …)` | `core.auth` with the host-mode client token, `agent.open` with `agentId = hermes-<profile>` (one agent per Hermes profile, `agent_identity`; the RPC `AgentId` pattern is `^[a-z0-9][a-z0-9_-]{0,63}$`, so the profile name is lower-cased, `.` becomes `-`, and a collision after folding is refused with both names), principal from `user_id`/`chat_id`/`platform` (D22/D24) |
| `prefetch` / `system_prompt_block` | `memory.recall` with the turn text and a deadline; blocks rendered as the host expects |
| `sync_turn` | `memory.capture` — skipped when `agent_context` is `cron` or `subagent` (Hermes doc rule) |
| `on_pre_compress` | `memory.checkpoint` (idempotent over the transcript digest, ADR-002 C1) |
| `get_tool_schemas` / `handle_tool_call` | the D21 operations over `memory.list/show/forget/correct/share` |
| `on_session_end` | `agent.close` |
| `is_available()` (no network) | the sidecar's socket/pipe exists and its token file is readable |

**Why a directory plugin, not a pip entry-point package:** `hermes update` rebuilds the venv and re-applies only directory plugins' declared deps (F9), so an entry-point package would silently vanish after a Hermes update — which Hermes itself calls data loss for memory providers. The client kit is still published to PyPI as `plur1bus-memory-client` so the directory plugin can declare it.

**Why a core sidecar, not an engine inside Hermes:** the engine is Node ≥ 24.16 and Hermes' own Node is 22 on Windows (F11); a Python re-implementation of the engine is out of scope (T7: one engine, one store handle). The sidecar reuses the release pipeline, signing, service registration and D78 updates that already exist, and it *is* the harness core, which makes the upgrade to harness mode a profile switch (A.8).

**Windows.** Native Windows is supported because Hermes supports it (F8): the provider talks to the named pipe (`open(r'\\.\pipe\…', 'r+b')` in the client kit), the sidecar is `%LOCALAPPDATA%\PLUR1BUS` (F16) under the user's Task Scheduler entry. WSL: the Linux path inside the distro, installed by delegation (A.3 step 1); a Windows-native Hermes never talks to a sidecar inside WSL or vice versa (no cross-boundary pipes).

**Install paths.** (a) `install-plugin.sh/.ps1 --host hermes` (default): installs the sidecar through the harness's own `install.sh`/`install.ps1` with `--profile host`, copies the verified provider directory, runs `hermes memory setup` non-interactively for `plur1bus` (or writes `memory.provider: plur1bus` through `hermes config set`), verifies (A.4). (b) Later, `hermes plugins install plur1bus` from the Hermes catalogue (C4): the catalogue build contains no updater (F10 rule 3); on first use without a sidecar it prints the one-liner instead of downloading anything itself.

**Milestone.** This was an M8 item after M3's client kits. It moves earlier (C3) because the owner now requires it, and it no longer depends on M3: it needs only the 2a RPC (done) and a Python **IPC** client (a subset of the planned kit; the HTTP half stays in M3). It fits after 2a-H3b-b (the sidecar is exactly the H3b-b installer with a profile) and beside 2b, as HM2.

### A.7 Coexistence on one machine (D89)

- **One engine per store (T7).** OpenClaw host mode keeps its store at the plugin's `baseDbPath` (default `<openclaw-state>/memory/lancedb-namespaced`); the harness keeps its own under its state root. They are never pointed at the same directory: the harness's `setup` refuses a `store.path` inside an OpenClaw state dir, and the plugin's selftest refuses a `baseDbPath` inside a harness home (both detect the other's marker files).
- **Hermes host mode is the harness core** (A.6). If a full harness already exists on the machine, `install-plugin --host hermes` does not install a second core: it binds the Hermes provider to the existing core as a D28 tier-1 client (a new agent binding `hermes-<profile>`), after asking. If a host-mode core exists and the full harness is installed later, the harness installer finds the same state root and upgrades the profile (A.8).
- **Names and pipes.** Embedding-owner pipes and sockets are already keyed by a hash of the state root (`lib/platform.js:92`), service names carry the home suffix (core spec S10); two installations do not collide.
- **Models.** Each keeps its own model cache (a shared cache would need cross-process locking the engine does not have); the installer reports the duplicate size.
- **Two memories, one person.** When both OpenClaw host mode and the harness serve the same person, they hold separate memories until the user migrates (B) or switches the plugin to a thin client (D28). `plur1bus doctor` and the plugin selftest both print a one-line notice when they detect the other.

### A.8 Upgrading host mode to the harness

| From | To harness mode | Data |
|---|---|---|
| OpenClaw host mode | Install the harness (desktop bundle or native), run the migration assistant (B) against the OpenClaw source: the PLUR1BUS stores are taken over without re-embedding when the identity matches (`import.md` §2.3.1). Then the assistant offers, for the plugin: **disable and keep files** (default, C9), **switch to thin client** once the D28 thin OpenClaw plugin exists, or keep both separate. | copied, source untouched |
| Hermes host mode | `plur1bus setup --profile full` on the same state root: modules, web UI, scheduler are added; the agents `hermes-<profile>` already exist; Hermes keeps working as a tier-1 client of the same core. Importing Hermes' non-memory state (soul, skills, cron) is the migration assistant's Hermes path. | in place, no copy |

### A.9 Licence gate for NC embedding models in the plugin installer

Same rule as ADR-006 and the harness's `setup`: interactive → the use-class question ("personal, non-commercial?"); yes pre-selects Jina v5 Text Nano with an explicit CC BY-NC-4.0 confirmation; no → E5-small (MIT). Non-interactive → **E5-small**, unless `--accept-nc-licence` (alias of the existing `PLUR1BUS_ACCEPT_NONCOMMERCIAL_LICENSE=1`, F7) is given; never a silent acceptance. The confirmation (who = OS user, when, model + revision, licence) is written to the plugin config (`modelPreparation.acceptNonCommercialLicense`, F7) and to the plugin's audit log; for Hermes host mode it goes through `plur1bus setup --accept-nc-licence` into the harness audit log. The Jina reranker (also NC) follows the same gate; the Apache-2.0 BGE reranker needs none.

## B. Cross-platform migration assistant (D90, D91)

### B.1 Source roots per OS

| Source | Linux / macOS | Windows native | WSL-hosted, seen from Windows | Windows-hosted, seen from WSL |
|---|---|---|---|---|
| OpenClaw | `OPENCLAW_STATE_DIR` → `<home>/.openclaw-<OPENCLAW_PROFILE>` → `<home>/.openclaw` → legacy `<home>/.clawdbot`; `<home>` = `OPENCLAW_HOME` → `HOME` → `os.homedir()`; config `OPENCLAW_CONFIG_PATH` (F2) | same rule with `<home>` = `OPENCLAW_HOME` → `HOME` (if set, e.g. Git Bash) → `USERPROFILE` → `os.homedir()`: normally `C:\Users\<u>\.openclaw` | `\\wsl.localhost\<distro>\home\<u>\.openclaw` (or `\\wsl$\…`), with `<u>`, `$HOME` and every override read **inside** the distro; Hub's `OpenClawGateway` included | `/mnt/c/Users/<u>/.openclaw` via `wslpath` of `%USERPROFILE%` (read with `cmd.exe /c echo %USERPROFILE%`) |
| Hermes | `HERMES_HOME` (expanduser + expandvars; a `…/profiles/<name>` value resolves to its root) → `~/.hermes` (F8) | `HERMES_HOME` → `%LOCALAPPDATA%\hermes` → `%USERPROFILE%\AppData\Local\hermes` | `\\wsl.localhost\<distro>\home\<u>\.hermes` | `/mnt/c/Users/<u>/AppData/Local/hermes` |
| Either | `--source <path>` always wins: a local dir, a mounted volume (`/Volumes/…`, `/mnt/…`, NFS/SMB), a UNC path (`\\server\share\…`), or `wsl:<distro>:<posix-path>` | | | |

### B.2 Discovery algorithm

`import --detect` without `--source` enumerates **all** candidates and reports each (it never picks silently when there are several): (1) the native root per B.1; (2) on Windows, every WSL distro from `wsl.exe -l -q` (UTF-16 output; run with `WSL_UTF8=1`, decode defensively), each probed with one `wsl.exe -d <d> -e sh -lc '…'` call that prints `$HOME`, `OPENCLAW_*`, `HERMES_HOME` and marker-file existence as NUL-separated JSON — the login shell is needed because overrides usually live in `~/.profile`; a stopped distro is **not** started without consent (listing is free, probing boots the VM: the wizard asks, the CLI needs `--probe-wsl`); (3) inside WSL (`WSL_DISTRO_NAME` set), the Windows-side roots via `/mnt/<drive>`; (4) nothing on network paths unless given. Each candidate carries `origin: native|wsl:<distro>|windows-from-wsl|mounted|network`, `pathFlavour: posix|win32`, and a `running` flag (B.5).

### B.3 Access strategy: live read vs snapshot

Two ways to read a source; the report says which one it used.

- **Live read** (default for `detect` of native, same-flavour sources): today's code, read-only primitives of `readonly.ts`.
- **Snapshot** (default for WSL-hosted sources, network paths, the container bundle, and every `--apply` of stores): a producer copies the selected source subtree into a staging directory **on the harness's own volume** (`<home>/import/<run>/snapshot/`, not `os.tmpdir()`, which on Windows can sit on a small `C:`), writes `snapshot.json` (source origin, flavour, source-side home and root, file list with sizes, mtimes and SHA-256 for small files) and the importer then runs against the snapshot with a path map (B.4). Producers:
  - *native*: an in-process copier (Node, `copyFile` per file, links resolved per B.6);
  - *WSL*: `wsl.exe -d <d> --exec tar -C <root> -cf - <paths>` streamed into the extractor — Linux-side symlinks and permissions are resolved by Linux, the 9P share is avoided for bulk data (F15), and SQLite/LanceDB files are read in one pass;
  - *container bundle* (F17): the desktop app is the producer on the host (host bridge method `host.importSnapshot`, D2), streaming the same tar into the container's import volume; the in-container importer never sees host paths directly. This closes a gap: without it the D77 bundle cannot import anything from the machine it runs on.

### B.4 Path normalisation inside source configs

A `SourcePathMapper` built from the candidate: `{ flavour, sourceHome, sourceRoot, accessRoot, accessHome, extraMounts[] }`. Every path read from `openclaw.json`, `config.yaml`, `plugins.entries.*.config` (`baseDbPath`, `embedding.local.cacheDir`, `workspace`, `agentDir`, `skills.load.extraDirs`, Hermes `skills.external_dirs`) goes through it instead of the host's `path` module:

1. Parse with the **source's** flavour (`path.posix` or `path.win32`), never the host's. Today `expandConfigPath` uses the host's `isAbsolute`/`resolve`: on Windows a POSIX `/home/u/.openclaw/workspace` counts as absolute and resolves to `C:\home\u\…`; on Linux a `C:\Users\u\ws` counts as relative and resolves under the root. Both are silent misreads.
2. Expand `~` against `sourceHome` (the WSL user's `$HOME`, not the Windows profile), `${OPENCLAW_HOME}` against the source root (existing rule), `%VAR%`/`$VAR` only from the environment captured **on the source side** (WSL probe) — otherwise unresolved, as today.
3. Rebase: a path under `sourceRoot` or `sourceHome` → the same relative path under `accessRoot`/`accessHome` (UNC, `/mnt/c`, snapshot dir); a path under a known extra mount (`/mnt/<x>` ↔ `<X>:\`) → mapped; anything else → **unmapped**, reported with the config key, never guessed. The wizard offers a manual mapping; the CLI takes `--map <source-prefix>=<local-prefix>` (repeatable).
4. Compare identities (principal hashing, `import.md` §2.4) on the **source-side** normalised string, never on the access path, so `C:\Users\X` vs `c:\users\x` stays the fail-closed case `import.md` already defines.

### B.5 Read-only guarantees on Windows

- **Opening for read never locks the source out.** Node/libuv opens with `FILE_SHARE_READ|WRITE|DELETE` (knowledge ≤ 2026-06, asserted by a test that renames and deletes a file the importer holds open), so OpenClaw keeps working while we read.
- **SQLite.** The existing copy-then-open (`openSqliteReadOnly`, 256 MiB limit) stays the rule — opening the live file, even read-only, would write read marks into its `-shm`. New: copy `db`, then `-wal`, record size+mtime of both before and after, `PRAGMA quick_check` on the copy; any change or failure → retry three times with backoff, then report `source-busy` (detect: warning and the immutable fallback; apply: stop, B.5 last bullet). Databases above the limit keep `immutable=1` (WAL ignored — reported as such). The copy stays below SQLite's 1 GiB lock-byte page, so Windows byte-range locks held by a writer cannot fail the copy.
- **LanceDB.** `detect` reads in place through the engine's pinned `@lancedb/lancedb` at one table version; a concurrent compaction that removes an old version → reopen at the latest and retry. `apply` copies a store by manifest: the newest `_versions/*.manifest` first, then every file it references, then re-checks that the manifest is still newest; a change → repeat (at most 3), else `source-busy`.
- **Running source detection.** OpenClaw: `openclaw gateway status --json` where the CLI is reachable (native or via `wsl.exe`), else the Scheduled Task / `systemd --user` / launchd unit state; Hermes: its gateway PID/lock files under the home. `--apply` against a running source that holds a PLUR1BUS store **requires it stopped** (C7): the wizard shows the exact stop command for that OS and re-checks; the CLI fails with `E_SOURCE_BUSY` unless `--allow-live-copy` accepts the retry strategy above.
- **Our own writes** go only to the harness home and the snapshot dir. Windows Defender/Search can hold fresh files briefly: `rename`/`rm` in the target retry on `EPERM`/`EBUSY`/`EACCES` for up to 10 s with backoff (today's `renameSync` calls fail at once).

### B.6 File-system hazards

| Hazard | Rule |
|---|---|
| **Line endings / BOM** | Parsers already accept CRLF and BOM (`yaml-lite.ts:52,149`, `json5.ts`). Copies stay byte-exact (the folder hash is the copy check). For *matching* (adopt vs conflict, catalogue identity) a second `textHash` normalises CRLF→LF and strips a leading BOM for text files, so a skill checked out with `core.autocrlf` on Windows matches its LF twin. |
| **Symlinks in skills** | Resolution happens on the **source side** (Linux for WSL via the tar producer; native otherwise); the harness never *creates* links — skills are copied as files (already true). Windows sources: symlinks and junctions are treated alike (`lstat` + `realpath`), escapes skipped (existing rule). Windows runners run as admin, so the symlink tests that are skipped on win32 today run there behind a capability probe (developer mode or `SeCreateSymbolicLinkPrivilege`). SMB: Windows evaluates remote symlinks only if `R2R`/`R2L` symlink evaluation is enabled; an unreadable link is reported as `symlink-unresolvable`, not followed. |
| **Case-insensitive targets** (Windows NTFS, default APFS) | Skill ids are already lower-cased. New: case-fold collision checks for (a) Hermes profile names (`PROFILE_RE` allows `A–Z`; `Work` and `work` on a Linux source would merge on the target), (b) OpenClaw agent ids (already lower-cased — keep), (c) file names inside one skill (`README.md` and `readme.md` would overwrite each other and then fail the hash check as "source-changed-during-copy", a misleading reason) → problem `case-collision` with both names, the item is skipped until renamed via the mapping. |
| **Unportable names** | Windows reserved device names (`CON`, `PRN`, `AUX`, `NUL`, `COM1–9`, `LPT1–9`, with any extension), trailing dot or space, `<>:"\|?*` and control characters → problem `unportable-name` on a Windows or container-from-Windows target; the file is listed, never silently renamed. |
| **Long paths** | Node's `fs` applies the `\\?\` namespace internally on Windows (knowledge ≤ 2026-06), and the Rust side uses verbatim paths; child tools do not (`git`, `tar.exe`, PowerShell 5.1). The importer calls none of those on Windows paths; the WSL producer runs Linux `tar`. Test: a skill and a workspace nested past 300 characters under a harness home with a long user name. |
| **Non-ASCII user names** | `C:\Users\Jürgen`: Node and Python handle UTF-16 paths; hazards are `wsl.exe` output encoding (UTF-16LE → `WSL_UTF8=1`), 8.3 short names in `%TEMP%` (compare with `realpathSync.native`), PowerShell 5.1 script encoding (scripts ASCII-only, data via .NET APIs), and SQLite URIs (built with `pathToFileURL`, already percent-encoded). Fixtures use a non-ASCII home on every OS. |
| **Mounted/network sources** | Read through the snapshot producer (B.3); per-volume case sensitivity is probed (create/lookup two case variants in the snapshot dir, not in the source); SQLite over SMB/NFS is only ever copied, never opened in place. |

### B.7 Tests

- **Layout fixtures generated in CI on each OS** (not committed trees): a new `test/import/layouts.ts` builds, per run, (a) Linux layout, (b) macOS layout (same paths, case-insensitive checks active), (c) **Windows-native layout** (`%USERPROFILE%\.openclaw`, `%LOCALAPPDATA%\hermes`, backslash paths in `openclaw.json`, CRLF + BOM files, a junction and a file symlink, a reserved name, a 300-character path, a non-ASCII home), (d) **WSL-origin layout read from Windows** (POSIX paths in configs under a `\\wsl.localhost` access root, simulated by the mapper on every OS), (e) **Windows-origin layout read from Linux/WSL** (`/mnt/c` mapping). Every layout carries a PLUR1BUS store in both embedding identities (M7 acceptance 2, 5) and skills with conflicts.
- **All three CI OSes** (`ubuntu-24.04`, `macos-15`, `windows-2025`) run every layout that the host can express; `windows-11-arm` runs (c) in the nightly.
- **Busy source**: a child process holds the SQLite DB open with a writer loop and runs a LanceDB compaction while detect and apply run; asserts no write to the source (tree digest, `tree.ts`) and a `source-busy` or consistent result.
- **WSL job** (`windows-2025`, F14): install Ubuntu 24.04 in-job (`Vampire/setup-wsl` pinned by SHA), generate layout (a) inside the distro with real symlinks, run the Windows-side `import --detect --probe-wsl` and `--skills --apply` against it, assert discovery, mapping and the tar producer. **Non-blocking for the first four weeks** (C8), then required. `windows-11-arm` is excluded until WSL there is verified.

### B.8 UI wizard (desktop D1/D2, web UI M3)

No canvas board draws import or migration (F17). Screens for the designer, in flow order; each reuses the named board's layout and the canvas visual system:

1. **Entry points** — setup rail step "Bring your memory" (after memory & embeddings; `V2SetupRail`, `V2SetupMemory`), `V2Agents` action *Import*, Settings › *Import & migration*.
2. **Source picker** — detected cards: OpenClaw / Hermes, origin badge (Native, WSL · Ubuntu, WSL · OpenClawGateway, Windows from WSL, Network), version + tested/untested badge, *PLUR1BUS installed* badge with store count, *running* state; *Probe WSL distros* button (boots VMs, asks first); *Add a source manually* (folder picker via `host.filePick`, UNC field, WSL distro dropdown).
3. **Source is running** — why it matters, the OS-specific stop command, *Check again*, *Copy while running (slower, may retry)*.
4. **Detect report** — agents, stores (identity match → take over / mismatch → re-embed), skills with conflicts (`V2SkillsLibrary` row style), secrets as opt-in toggles, **portability problems** (unmapped paths, case collisions, unportable names, unresolvable links), each with its fix action.
5. **Path mapping editor** — source prefix ↔ local prefix rows, live preview of the affected config keys.
6. **Re-embedding and licence** — per mismatched store; the ADR-006 use-class question if an NC model is chosen.
7. **Plan** — the dry-run diff grouped by entity; *Apply*.
8. **Progress** — snapshot → verify → copy → index, per step, cancellable before the commit point.
9. **Result** — outcomes, report download (no content, no secrets), *Roll back*.
10. **Host-mode follow-up** — "PLUR1BUS plugin found in OpenClaw": *Disable plugin, keep files* (default) / *Keep both* / *Switch to thin client* (when available); for Hermes host mode: *Upgrade this core to the full harness*.
11. **Plugin install (D2)** — "Install PLUR1BUS into my OpenClaw/Hermes" from the desktop app: host picker, licence step, progress, verification result (drives the A.3 scripts).

Desktop D1 hosts the SPA, so screens 2–10 are SPA pages (M3/M7); the host-side pieces (WSL enumeration and probing, file pick, `host.importSnapshot`, screen 11) are D2 host-bridge methods.

### B.9 Mapping to the current code, and the changes needed now

Current state (`packages/core/src/import/` @ `bf35866`): `detect` and `skills` are implemented, tested on all three CI OSes, but with Linux-layout fixtures and win32-skipped symlink tests. Gaps found:

| # | File | Gap | Change |
|---|---|---|---|
| G1 | `sources/hermes.ts` `resolveHermesRoot` | Default is `~/.hermes` on every OS; Windows' `%LOCALAPPDATA%\hermes` (F8) is never found. `HERMES_HOME` gets no `expandvars` and no `~\` expansion; a `…/profiles/<name>` value is treated as the root. | Per-OS default with the `LOCALAPPDATA` fallback; `%VAR%`/`$VAR` expansion from the captured env; profile-path → root + `--profile`. |
| G2 | `sources/openclaw.ts` `resolveOpenclawRoot` | `<home>` ignores `HOME` on Windows (`os.homedir()` uses `USERPROFILE`), unlike OpenClaw (F2); legacy `.clawdbot` fallback missing. | Home order `OPENCLAW_HOME → HOME → USERPROFILE → os.homedir()`; legacy dir when only it exists. |
| G3 | `sources/openclaw.ts` `expandConfigPath`, `sources/hermes.ts` external dirs | Host-flavoured `isAbsolute`/`resolve` misread foreign paths (B.4 rule 1). | `SourcePathMapper` (new `import/paths.ts`), used by both sources; unmapped paths reported. |
| G4 | `source.ts`, `types.ts` | One source, one host path, no origin/flavour; `ctx.homedir` is the harness user's home even for a WSL source (wrong `~/.agents/skills` personal root). | `SourceCtx` gains `origin`, `flavour`, `sourceHome`, `mapper`; candidates list for `--detect` without `--source`. |
| G5 | — | No WSL discovery or probing; no `wsl:<distro>:<path>` source syntax. | New `import/wsl.ts` (enumerate, probe, `wslpath`), CLI `--probe-wsl`. |
| G6 | — | No snapshot producer; container bundle cannot import (F17). | New `import/snapshot.ts` (native copier, WSL tar stream, `snapshot.json`), host-bridge method `host.importSnapshot` in D2. |
| G7 | `readonly.ts` `openSqliteReadOnly` | Copy is not checked for consistency; temp copy in `os.tmpdir()`. | Before/after size+mtime, `quick_check`, retry, `source-busy`; staging under the harness home. |
| G8 | `skills-import.ts` | `renameSync`/`rmSync` fail at once on transient Windows locks. | Retry wrapper (EPERM/EBUSY/EACCES, 10 s). |
| G9 | `skills-scan.ts`, `sources/hermes.ts` | No case-fold collision check for files inside a skill or for Hermes profile names; no unportable-name check. | Problems `case-collision`, `unportable-name` in the scan and the profile list. |
| G10 | `skills-scan.ts` | Only a byte hash; CRLF twins never match. | Add `textHash` for matching; keep `sha256` for copy verification. |
| G11 | `skills-scan.ts` `inside()` | Exact-case prefix check; on case-insensitive volumes a differently-cased link target is reported as an escape (safe, but noisy). | Compare `realpathSync.native` results. |
| G12 | `test/import/fixtures.ts` | Linux layout only; `link()` is a no-op on win32; symlink tests skipped. | `layouts.ts` per B.7; symlink capability probe instead of `POSIX`. |
| G13 | `docs/import.md` | No per-OS source table, no WSL, no path mapping, no Windows read-only rules. | Add §2.0/§3.0 tables from B.1, a §8.x "Cross-platform sources" section pointing here. |

**Follow-up implementation plan (task list; to become `docs/superpowers/plans/2026-09-28-import-cross-platform.md`):**

1. [ ] G1 + G2: per-OS root resolution for both sources, with unit tests over injected env/platform (win32, darwin, linux).
2. [ ] G3 + G4: `SourcePathMapper` and the widened `SourceCtx`; route every config path through it; tests with POSIX-in-Windows and Windows-in-POSIX configs.
3. [ ] G9 + G10 + G11: case-collision, unportable-name, `textHash`, native realpath comparison.
4. [ ] G7 + G8: SQLite copy verification and retry, staging under the harness home, rename/rm retry wrapper.
5. [ ] G12: `layouts.ts` generated per OS, symlink capability probe, long-path and non-ASCII-home fixtures, busy-source test.
6. [ ] G5: `wsl.ts` with enumeration, probe, `wslpath`; `--probe-wsl`; the WSL CI job (non-blocking).
7. [ ] G6: `snapshot.ts` (native copier, WSL tar stream, `snapshot.json`); detect/skills run against a snapshot.
8. [ ] G13: `docs/import.md` and `docs/cli.md` updates.
9. [ ] (D2) `host.importSnapshot` host-bridge method and the container-bundle import path.

Tasks 1–5 are small and belong **now** (before 2b, on the `import --detect/--skills` code already shipped); 6–7 go with M7; 9 with D2.

## Milestone placement and effort

New **track HM — host-mode plugins (D86–D91)**, beside 2b and M2–M3; the WSL and snapshot work joins M7; host-side import joins D2.

| M | Content | Depends on | Effort (ad) |
|---|---|---|---|
| **HM1** — directly after 2a-H3b-b | OpenClaw plugin distribution: `plugin-dist.yml` five-target install matrix + Windows/macOS full suite + WSL leg; `openclaw plur1bus selftest`; `install-plugin.sh/.ps1` for OpenClaw (detect incl. WSL delegation, compat, install, licence gate, verify, update with snapshot, uninstall); Node port of the bash installer's snapshot step; README fixes (F4); plugin feed + minisign + npm provenance + attestations | H3b-b release pipeline; plugin repo | 6–9 |
| **HM2** — after HM1, beside 2b | Hermes host-mode adapter: `plur1bus-memory-client` IPC subset (Python, socket + named pipe), directory provider + `plugin.yaml` + `cli.py`, `plur1bus setup --profile host`, `install-plugin --host hermes` on three OSes + WSL delegation, conformance run against the RPC, CI on three OSes | 2a RPC; HM1 scripts | 8–12 |
| **HM3** — with HM1 | Import cross-platform, part now: plan tasks 1–5 (G1–G4, G7–G12) | `feat/import-detect` code | 3–5 |
| **HM4** — after HM2 | Coexistence guards (A.7), Hermes-on-existing-harness binding, host-mode → harness upgrade (`--profile full`), Hermes catalogue submission | HM2; M3 for the thin-client option | 2–3 |
| M7 (addition) | Plan tasks 6–7: WSL discovery/probe, snapshot producer, busy-source strategy for LanceDB, WSL CI job made required | HM3 | +3–5 (M7 becomes 17–27) |
| D2 (addition) | `host.importSnapshot`, WSL enumeration in the host bridge, screen 11 (plugin install from the app) | D1; HM1–HM2 | +2–3 (D2 becomes 10–15) |

Track HM totals **19–29 ad**; HM1–HM3 (17–26) are counted in the v0.1.0 total (C3), HM4 is not. None of it is on the critical path (HM runs beside 2b and M2–M3); M7's and D2's additions sit where those milestones already are. M8's "Hermes `MemoryProvider`" line moves to HM2; M8's "thin OpenClaw plugin" stays in M8 (it needs M3's HTTP API).

## C. Owner decisions

| # | Question | Recommended default |
|---|---|---|
| C1 | `.pkg`/`.msi` installers for the plugins, or one-liners only? | **One-liners only in v1** (A.3 reasons); GUI install via the desktop app in D2; revisit after SignPath approval. |
| C2 | Hermes host-mode shape: Python provider + harness core sidecar, a Node engine inside Hermes, or a Python engine? | **Provider + core sidecar** (A.6: Node 22 on Windows, T7, reuse of release/update/signing, trivial upgrade). |
| C3 | Pull the Hermes adapter forward from M8 to HM2 (after H3b-b, beside 2b)? | **Yes** — owner requirement; depends only on the 2a RPC and a Python IPC client. |
| C4 | List the Hermes provider in the Hermes plugin catalogue? | **Yes, after the first stable HM2 release**, catalogue build without any updater (F10). |
| C5 | OpenClaw on Windows: support native and WSL, or WSL only? | **Both**; native marked beta until the HM1 Windows jobs are green for four weeks. |
| C6 | Key for the plugin feed: the harness release key or the extension key (D82)? | **Harness release key** — the plugin is a product release under D78, not an add-on. |
| C7 | Migration `--apply` of stores while the source runs? | **Require the source stopped**; `--allow-live-copy` as an explicit opt-in with the retry strategy. |
| C8 | WSL CI job blocking from day one? | **Non-blocking for four weeks**, then required on `windows-2025`; `windows-11-arm` excluded until verified. |
| C9 | After migrating an OpenClaw host-mode user to the harness, what happens to the plugin by default? | **Disable, keep files** (reversible); thin-client switch offered once it exists. |
| C10 | Container-bundle import: host-side snapshot or read-only bind mounts? | **Host-side snapshot** (`host.importSnapshot`) — keeps D77's no-bind-mount rule, works for WSL and network sources alike. |
| C11 | NC licence flag name in the plugin installers? | **`--accept-nc-licence`** (same as `plur1bus setup`), with the existing `PLUR1BUS_ACCEPT_NONCOMMERCIAL_LICENSE=1` still honoured. |
| C12 | Stopped WSL distros: may `detect` boot them to probe? | **Only with consent** (wizard prompt, CLI `--probe-wsl`); listing without probing is always free. |

## Sources

Local checkouts (read 2026-09-28): OpenClaw `b9421f4` (2026-09-21), hermes-agent `743ee72` (2026-09-21), openclaw-plur1bus-memory `5ffe71d5`, PLUR1BUS-Harness `bf35866` (origin/main) and `feat/h3bb-t10-release` @ `9955b72`; file and line references inline in §1.

Web (read 2026-09-28): [actions/runner-images#11265](https://github.com/actions/runner-images/issues/11265) (WSL on windows-2025, Dec 2024–Jan 2025) · [actions/runner-images#13222](https://github.com/actions/runner-images/issues/13222) (WSL 2.6.1.0 preinstalled, Oct 2025) · [actions/runner-images#11784](https://github.com/actions/runner-images/issues/11784) (WSL 2 install fix, Mar 2025) · [Vampire/setup-wsl](https://github.com/vampire/setup-wsl) · [Microsoft Learn: working across Windows and Linux file systems](https://learn.microsoft.com/en-us/windows/wsl/filesystems) (updated 2022-03-03).

Knowledge (≤ 2026-06, re-check while implementing): libuv's share flags on Windows opens; Node `fs` namespacing of long paths; `\\wsl.localhost` prefix; SMB symlink evaluation defaults; SQLite lock-byte page at 1 GiB.
