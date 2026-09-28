# HM1 — OpenClaw plugin distribution on five targets, `openclaw plur1bus selftest`, signed one-line installers — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Scope note.** This is the plan for milestone row **HM1** of track HM (`docs/milestones.md` §2, "Track HM"): D86 (OpenClaw half), D87 and the upgrade/coexistence half of D89 that an installer needs. It answers owner requirement 1 of 2026-09-28 ("the plugin for OpenClaw and Hermes needs installation packages for Linux, macOS and Windows") for **OpenClaw**. The Hermes adapter is HM2, the importer fixes are HM3, the harness-side coexistence guards and host→harness upgrade are HM4; none of them is planned here. It has **12 tasks**: **11 land in the plugin/engine repository** `Cyb3rb1ade/openclaw-plur1bus-memory`, **1 lands in this harness repository**. Every task header says which.

**Goal:** A person with OpenClaw on Linux, macOS or Windows (native or WSL2) runs one signed command. It finds their OpenClaw, checks compatibility, installs the PLUR1BUS plugin through OpenClaw's own `plugins install`, applies the ADR-006 licence gate, proves the install with `openclaw plur1bus selftest`, and can later update it in place (store snapshot first, automatic rollback) or uninstall it. CI proves the packed plugin installs and loads in real, disposable OpenClaw instances (minimum and latest) on all five D8 targets.

**Architecture:** Three layers. (1) **Bootstraps** `install-plugin.sh` (POSIX sh) and `install-plugin.ps1` (PowerShell 5.1/7, ASCII) only find OpenClaw and its Node, fetch the plugin feed and its minisign signature, verify the signature with a small inline Node verifier (OpenClaw always brings Node ≥ 24.16, so unlike the harness one-liner, HB19, the plugin bootstrap *can* verify the feed), download the installer bundle named by the feed, check its SHA-256, and hand over. The `.ps1` also enumerates WSL distros and delegates into one by piping the verified `.sh` into it. (2) **One Node installer** (`plur1bus-plugin-installer.mjs`, bundled, zero runtime dependencies) holds all logic once for every OS: detect, compatibility, install, licence, verify, update with snapshot, rollback, uninstall, legacy-deploy adoption, report. It never touches OpenClaw files directly; every change goes through the `openclaw` CLI. (3) **Plugin-side** pieces the installer calls: `openclaw plur1bus selftest` (new `registerCli` root) and `scripts/snapshot-store.mjs` (Node port of the bash installer's snapshot step). Two new workflows in the plugin repo: `plugin-dist.yml` (pack once, install matrix, selftest, installer end-to-end, full suite, WSL leg) and `plugin-release.yml` (release artefacts, unsigned feed, attestations, npm provenance). The feed is signed **offline by the owner with the harness release key** (C6), exactly like `release.json` today (`docs/manual-release.md`).

**Tech Stack:** Plugin repo: Node 24.21 (engines `>=24.16.0 <25 || >=26.1.0`), plain ESM JavaScript with JSDoc, `node:test`, `node:crypto` (Ed25519, BLAKE2b-512), `@lancedb/lancedb` 0.26.2, `@huggingface/transformers` 4.2.0 (onnxruntime-node, sharp) — all existing. **New dev dependency (Task 5 only, HM1-R20):** `esbuild` exact-pinned, used only to bundle the installer. **New runtime dependencies:** none. OpenClaw under test: `2026.8.1` (the plugin's `openclaw.compat.minGatewayVersion` at `b0e149b8`) and npm dist-tag `latest` (`2026.9.6` on 2026-09-28). Harness repo: Markdown only.

**Spec:** `docs/superpowers/specs/2026-09-28-plugin-distribution-and-migration-design.md` (authority): §0, §1 facts F1–F7, F13–F16, §A.1–A.5, §A.7 (plugin half), §A.9, "Milestone placement" row HM1, §C. Core spec rows **D8, D78, D86, D87, D89** (`docs/superpowers/specs/2026-09-24-m1b-2a-core-daemon-cli-design.md` §2). `docs/milestones.md` Track HM row HM1 (6–9 ad). Reused harness conventions: `.github/workflows/harness-release.yml`, `scripts/install/install.{sh,ps1}`, `docs/manual-release.md`, rulings HB10 and HB19 of `docs/superpowers/plans/2026-09-27-m1b-2a-h3b-b.md`. Executors read the spec and this plan together.

**Owner decisions still open.** The spec's C1–C12 are not decided; this plan runs on the spec's defaults and says so where it depends on them (HM1-R1). New decisions this plan raises, each with a default below: **O1** first public npm publish to npmjs.org under `@cyb3rb1ade` with trusted publishing (HM1-R14); **O2** the owner's VPS legacy deploy and its `protect-plur1bus-deploy.sh` cron guard (HM1-R9); **O3** effort above the HM1 share (HM1-R23); **O4** hosting of `install-plugin.*` at `https://plur1bus.app/` and the feed at `https://updates.plur1bus.app/plugin/{channel}.json` (HM1-R2); **O5** plugin version 7.17.0 for the HM1 release (HM1-R19).

---

## Prerequisites (must hold before Task 1 starts)

| # | Prerequisite | Why | Check |
|---|---|---|---|
| P1 | The 2a-H3b-b release pipeline is on harness `main`: `.github/workflows/harness-release.yml`, `scripts/install/install.{sh,ps1}`, `docs/manual-release.md`. | Tasks 7, 10 and 12 copy its conventions (feed fetch, .NET SHA-256, ASCII PowerShell, offline minisign signing). | Met at harness `049b9a3`: all four files exist. |
| P2 | Plugin repo `main` is at or after `b0e149b8` (merge of #199), version `7.16.11`, `openclaw.compat.minGatewayVersion` `2026.8.1`. | Every path and line in this plan was read there. | `git -C $PLUGIN merge-base --is-ancestor b0e149b8 origin/main`. Before starting, list open plugin PRs (`gh pr list -R Cyb3rb1ade/openclaw-plur1bus-memory`) and re-run the conflict scan for any that touch `adapter/openclaw/register-commands.js`, `openclaw.plugin.json`, `package.json` or `.github/workflows/`. |
| P3 | `openclaw@2026.8.1` and `openclaw@latest` are installable from npm. | Task 1 and Task 8 install them. | Met 2026-09-28: `npm view openclaw@2026.8.1 version` → `2026.8.1`; dist-tags `latest` = `beta` = `2026.9.6`. |
| P4 | The harness channel public keys exist as harness repository variables `PLUR1BUS_RELEASE_PUBKEY_STABLE`/`_BETA` (manual-release §1). The owner copies the same two values into plugin repository variables of the same names. | Task 10 renders them into the bootstraps (HM1-R3). Public values, not secrets. | Owner step; Task 10's dry run warns and renders a `TEST ONLY` key when they are missing, a real run refuses. |
| P5 | Only for Task 10's non-dry run: O1 decided, and if yes the owner owns the npm scope `@cyb3rb1ade` on npmjs.org and has added this repository and `plugin-release.yml` as a trusted publisher, plus a GitHub Environment `npm-publish` with the owner as required reviewer. | `npm publish --provenance` through OIDC. `npm view @cyb3rb1ade/plur1bus-memory` returned **404** on 2026-09-28: the package is not on npmjs.org today (the README's "npm-compatible registry" line refers to GitHub Packages, which needs authentication to install). | Owner step; everything else runs without it. |

---

## Repositories, branches, and how to run anything

**Plugin/engine repo (`$PLUGIN`, 11 tasks):** `Cyb3rb1ade/openclaw-plur1bus-memory`. The reference clone `/home/claude/work/engine-main` (main @ `b0e149b8`) is read-only. The executor cuts branch **`feat/hm1-plugin-distribution`** from `origin/main` in its own worktree (`superpowers:using-git-worktrees`). Every plugin path below is relative to that worktree. Proposed PR split: **PR-A** Tasks 1–7 and 9 (selftest, snapshot, feed, installer, bootstraps, cross-OS suite), **PR-B** Tasks 8, 10, 11 (workflows, release, docs) after PR-A merges.

**Harness repo (`$HARNESS`, 1 task):** `/home/claude/PLUR1BUS-Harness`. Branch **`docs/hm1-plugin-release`** from `origin/main`, one PR with Task 12 only.

**Reference OpenClaw checkout (`$OPENCLAW`):** `/home/claude/refs/openclaw` @ `b9421f4f` (version `2026.9.5`), read-only. Its `docs/` tree is the source of `https://docs.openclaw.ai/<same path>`.

**Node:** `export PATH=/home/claude/.node24/bin:$PATH` (must print `v24.21.0`).

**Green (plugin repo):**

```bash
npm ci && npm run lint && npm test
```

One test file: `node --test --test-concurrency=1 tests/<file>.test.js`. `npm run lint` already `node --check`s every `scripts/**/*.mjs`, so new `scripts/dist/*.mjs` files are covered. `scripts/lint-no-api-outside-adapter.mjs` allows `api.` only in `index.js`, `adapter/**`, `lib/setup/*-plugin-runtime.js` and three named files: the selftest's OpenClaw binding is therefore `lib/setup/selftest-plugin-runtime.js`, and everything under `lib/selftest/` and `lib/snapshot/` stays `api`-free.

**Green (harness repo, Task 12):** `node scripts/lint-hygiene.mjs` and `pnpm docs:check`.

**Verified OpenClaw surface** (read 2026-09-28 in `$OPENCLAW/docs`, same pages online; the first two were also fetched live):

| Surface | Fact used by this plan | Source |
|---|---|---|
| `plugins install` | Locators `clawhub:<pkg>[@ver]`, `npm:<pkg>[@exact\|@tag]`, `npm-pack:<path.tgz>`; npm specs registry-only, no ranges; deps in one managed npm project per plugin with `--ignore-scripts`; `--pin` npm only; `--force` confirms a non-ClawHub source *and* overwrites an existing install, does not bypass `security.installPolicy`; `--accept-capabilities` needed for local/unverified sources; installing an id that is already installed **stops and points at `plugins update`**; with a running local Gateway the install is applied through it (paths must be on the Gateway host), otherwise it waits for the next start; invalid config → fails closed, points at `openclaw doctor --fix`; a valid host config with the new plugin's config absent records the install **disabled**; compat (`pluginApi`/min gateway) checked before install; install records keep ClawHub source, artefact kind, npm integrity, shasum, ClawPack digest. | [docs.openclaw.ai/cli/plugins/install](https://docs.openclaw.ai/cli/plugins/install), [docs.openclaw.ai/cli/plugins](https://docs.openclaw.ai/cli/plugins) |
| `plugins update` / `uninstall` | `update <ids-or-npm-specs...>`, `--all`, `--dry-run`; reuses the recorded source; an explicit npm spec overrides; `uninstall <ids> [--dry-run] [--keep-files] [--force]`, `--force` required without a TTY; uninstall resets a `memory` slot it owns to `memory-core` and leaves an `enabled: false` marker. | [docs.openclaw.ai/cli/plugins/uninstall-and-update](https://docs.openclaw.ai/cli/plugins/uninstall-and-update) |
| `plugins inspect` | `inspect <id> [--runtime] [--json]`; with `--runtime` human output says `loaded`, **JSON keeps the underlying registry status and a separate `imported` field**; `sdk-incompatible` diagnostic code; CLI roots a plugin registers appear under `cliCommands`. | [docs.openclaw.ai/cli/plugins/inspect-and-diagnose](https://docs.openclaw.ai/cli/plugins/inspect-and-diagnose) |
| `config` | `config get/set/patch/unset/file/schema/validate`; `OPENCLAW_CONFIG_READONLY=1` or `OPENCLAW_NIX_MODE=1` block every config writer including plugin install/update/uninstall. `plugins.slots.memory` selects the memory plugin. | [docs.openclaw.ai/cli/config](https://docs.openclaw.ai/cli/config), `docs/gateway/config-extensions.md:344` |
| Manifest `cliCommands` | Each row requires `name`, `description`, `hasSubcommands`. | [docs.openclaw.ai/plugins/manifest](https://docs.openclaw.ai/plugins/manifest) (`docs/plugins/manifest.md:242`) |
| Installers | `install-cli.sh --prefix <path> --version <ver> --json` (private Node under `<prefix>/tools/node-v<ver>`, wrapper `<prefix>/bin/openclaw`, no onboarding unless `--onboard`); `install.ps1 -Tag <ver> -NoOnboard` (global npm install, Node fallback `%LOCALAPPDATA%\OpenClaw\deps\portable-node`). | [docs.openclaw.ai/install/installer](https://docs.openclaw.ai/install/installer) |

**Not verified — Task 1 spikes them** (never assumed by a later task; each later task reads Task 1's fact sheet): the exact JSON field paths of `plugins inspect --json` (status, `imported`, install record integrity, installed version); whether `plugins update` accepts `clawhub:<pkg>@<ver>` or only ids/npm specs for an exact-version upgrade; whether an update or `install --force` keeps `plugins.entries.<id>.config`; whether `plugins install` sets `plugins.slots.memory`; how OpenClaw treats an untracked directory at `<state>/extensions/memory-lancedb-namespaced` (the bash installer's rsync deploy, F7); whether a root CLI `plur1bus` with `hasSubcommands: true` registers and whether a CLI action can run without a Gateway; `openclaw --version` and `gateway status --json` output; where `node` lives for each OpenClaw install method; whether a ClawHub install records the same npm integrity as the GitHub-Release tarball.

---

## Global Constraints

Every task's requirements implicitly include this section.

- **Commits** (both repos): `git -c user.name=Cyb3rb1ade -c user.email=84099452+Cyb3rb1ade@users.noreply.github.com commit …`; every message body ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01SxcLhve6hyM9AFm2nU9B3F`. Never `git stash`, `--amend`, push to `main`, or change git config.
- **Credentials: existence probes only.** No code, test or log reads, copies or prints a credential's content: not `openclaw.json` as a whole, not `plugins.entries.<id>.config` as a whole, not `auth-profiles.json`, not `<state>/credentials/**`, not a SecretRef's target. The installer reads exactly these config paths with `openclaw config get`: `plugins.slots.memory`, `plugins.entries.memory-lancedb-namespaced.config.baseDbPath`, `…config.embedding.provider`, `…config.embedding.model`, `…config.modelPreparation.profile`, `…config.reranker.enabled`, `…config.reranker.provider`. It writes only through `openclaw config set` (HM1-R10). Snapshots never contain config or credentials (HM1-R8).
- **No client imitation.** Nothing talks to ClawHub, npm or the Gateway except through the `openclaw` CLI; nothing forges OpenClaw's headers, tokens or protocol. Downloads the scripts do themselves are the feed, its `.minisig`, the installer bundle, the bootstraps and (`--offline`) nothing.
- **Never touch a real OpenClaw installation of the user.** Local tests use `openclaw`, `node` and `wsl.exe` **shims** in a temp dir and a temp `HOME`/`USERPROFILE`/`LOCALAPPDATA`/`OPENCLAW_STATE_DIR`; the shared test helper `tests/helpers/installer-sandbox.js` throws if the `openclaw` that `PATH` resolves is not its own shim. Real OpenClaw runs only in CI on disposable runners, with `OPENCLAW_HOME` and `OPENCLAW_STATE_DIR` under `$RUNNER_TEMP`; `tests/helpers/assert-disposable.mjs` fails the job otherwise (HM1-R11).
- **No data loss on upgrade (D89).** An existing install is never reinstalled over by `install`: tracked installs switch to `update`, untracked ones need `--adopt-legacy` (HM1-R9). Every update and adoption takes a verified snapshot first and restores it on failure. No step deletes a store, a snapshot or a legacy directory except `--uninstall --purge` with two confirmations or `--yes-delete-memories`.
- **Five targets only** (D8): `linux-x64`, `linux-arm64` (glibc ≥ 2.27), `darwin-arm64`, `win-x64`, `win-arm64`. musl/Alpine, darwin-x64 and 32-bit refuse with exit 3 `unsupported-target` before any change (F5).
- **Scripts:** `install-plugin.sh` is POSIX `sh` (no bashisms; `shellcheck -s sh` clean where available). `install-plugin.ps1` runs on Windows PowerShell 5.1 and pwsh 7, is **ASCII-only** (a test asserts every byte < 0x80), hashes with .NET `SHA256` (not `Get-FileHash`, harness fix `9955b72`), and never needs admin. Neither uses `sudo` or writes outside the user's home and the OpenClaw state dir.
- **Exit codes** (spec A.3 step 8), for bootstraps and installer alike: `0` ok, `1` failed and rolled back (or nothing changed), `2` needs a choice (several candidates, legacy deploy, prompt without TTY), `3` incompatible host or environment, `4` verification failed **and** rollback failed (manual steps printed).
- **`--json`**: one document on stdout, schema `plur1bus.plugin-installer/1`; human lines go to stderr. Selftest JSON schema `plur1bus.selftest/1`; snapshot tool `plur1bus.snapshot/1`; feed `plur1bus.plugin-feed/1`.
- **Test seams** are honoured only with `PLUR1BUS_PLUGIN_INSTALLER_TEST=1`: `PLUR1BUS_PLUGIN_FEED` (feed URL, `file://` allowed), `PLUR1BUS_PLUGIN_PUBKEY` (a `TEST ONLY` minisign public key replacing the rendered channel keys), `PLUR1BUS_PLUGIN_WSL_EXE` (path of a `wsl.exe` shim). Without the flag they are ignored and `file://` feeds are refused.
- **Signing keys in fixtures** are throwaway, generated for the fixture, labelled `TEST ONLY` in the minisign untrusted comment; their secret keys are never committed (tests that need to sign use `tests/helpers/minisign-sign.js`, which generates an ephemeral key per run).
- **Atomic writes and retries:** temp `<name>.tmp-<pid>` → `fsync` → `rename`; on Windows `rename`/`rm` retry `EPERM`/`EBUSY`/`EACCES` with backoff for up to 10 s (Defender, spec B.5).
- **Versions:** plugin id stays `memory-lancedb-namespaced`, package `@cyb3rb1ade/plur1bus-memory`; `openclaw.compat` unchanged. HM1 ships as **7.17.0** (HM1-R19).
- **English** in code, docs and messages; release notes in German and English (D78).

## Review Focus

Five inputs the spec implies but no acceptance line names, most likely first. Each is pinned by a named test in its owning task.

1. **The owner's VPS: a plugin deployed by `install-memory-system.sh` (rsync into `<state>/extensions/memory-lancedb-namespaced`, untracked by OpenClaw) with `protect-plur1bus-deploy.sh` restoring that directory every 15 minutes.** A naive update would be silently reverted. Expected: `--update` detects the untracked deploy and exits 2 naming `--adopt-legacy`; with the guard present, `--adopt-legacy` exits 3 `legacy-deploy-guard` and changes nothing; without it, adoption snapshots, keeps the legacy directory renamed, installs tracked, verifies, and on failure puts everything back. → Task 6 `legacy deploy with the protect guard refuses adoption and changes nothing`, `adoption keeps the legacy dir and the store and rolls back on a failed verify`.
2. **The Gateway keeps writing to the store while the update snapshot is taken.** Expected: a consistent snapshot (every copied `_versions` manifest's referenced files present), a retry when a compaction removes files mid-copy, and `source-busy` after three tries — never a torn snapshot that a later rollback restores. → Task 3 `a table compacted during the copy is retried and then refused as source-busy`.
3. **Read-only or invalid OpenClaw config** (`OPENCLAW_CONFIG_READONLY=1`, `OPENCLAW_NIX_MODE=1`, or `config validate` failing). Expected: exit 3 before any install, snapshot or config write, with OpenClaw's own remedy (`openclaw doctor --fix`, or "change it in your deployment system") printed; no retry loop. → Task 5 `readonly or invalid config stops before any change`.
4. **State dirs with spaces, non-ASCII and profiles** (`/tmp/p b/Jürgen/.openclaw-work`, `C:\Users\Jürgen A\.openclaw`, `OPENCLAW_PROFILE=work`, `OPENCLAW_STATE_DIR` set, legacy `.clawdbot`). Expected: detection follows F2 exactly, and install, selftest's temp store and the snapshot all work there. → Task 5 `state dir resolution follows OpenClaw for profiles, legacy dir, spaces and non-ASCII`; Task 3 `snapshots a store under a path with spaces and non-ASCII`; Task 7 `ps1 passes a non-ASCII state dir through unchanged`.
5. **An update interrupted halfway** (Ctrl-C after the snapshot, network loss during `plugins update`, killed installer). Expected: the next run finds the installer state file, reports the interrupted step, and either completes the update or restores the previous version and snapshot; no `*.tmp-*` or half-restored store remains. → Task 6 `a killed update is completed or rolled back by the next run`.

---

## Rulings on spec gaps (binding for this plan)

| # | Gap | Ruling |
|---|---|---|
| HM1-R1 | C1–C12 are open. | The plan runs on the spec defaults: **C1** one-liners only, no `.pkg`/`.msi`; **C5** Windows native and WSL, native labelled beta (HM1-R18); **C6** feed signed with the harness release key; **C8** WSL CI leg non-blocking for four weeks; **C11** `--accept-nc-licence`, `PLUR1BUS_ACCEPT_NONCOMMERCIAL_LICENSE=1` still honoured; **C12** a stopped WSL distro is probed only with consent (`-ProbeWsl` or an interactive yes). C2–C4, C7, C9, C10 do not touch HM1. An owner override of C1, C5, C6 or C11 changes Tasks 5, 7, 10 and 12. |
| HM1-R2 | Where the installer scripts live. The harness hygiene lint (spec D9, `scripts/lint-hygiene.mjs`) forbids "openclaw" in harness `scripts/`, `tests/`, `packages/`, `crates/`. | **Plugin repo.** Sources under `scripts/dist/`, built into `dist-installer/` by the release workflow, published as plugin GitHub Release assets. The owner's publish step copies `install-plugin.sh`/`.ps1` to `https://plur1bus.app/` beside the harness one-liners and the signed feed to `https://updates.plur1bus.app/plugin/{channel}.json` (O4; harness Task 12 documents it). The harness repository gains no script. |
| HM1-R3 | Spec A.3: "thin" scripts that hand over to a Node step. HB19: the harness one-liner cannot verify minisign. | Bootstraps + one bundled Node installer. The bootstrap verifies `{channel}.json.minisig` over `{channel}.json` **before** trusting any URL or hash in it, using `scripts/dist/minisign.mjs` inlined at render time and run with the OpenClaw-provided `node` (`node --input-type=module -e`). The channel public keys are rendered into both bootstraps at release (Task 10) from plugin repo variables equal to the harness ones (P4). A missing, malformed or wrong signature is exit 1, nothing downloaded. This is stronger than HB19 and recorded as such in Task 12. |
| HM1-R4 | Who signs the plugin feed. | The owner, **offline**, with the channel's secret key (`minisign -S -s stable.key -m stable.json`), exactly as `docs/manual-release.md` §4 signs `release.json`. CI never holds a secret key; `plugin-release.yml` produces the **unsigned** feed. Promotion `beta` → `stable` re-signs identical bytes (D78). |
| HM1-R5 | Spec A.4 names `openclaw plur1bus selftest`. Every existing plugin CLI root is flat (`plur1bus-obsidian`, …) with `hasSubcommands: false`, and `tests/openclaw-restricted-registration.test.js:181-185` asserts that. | Register root **`plur1bus`** with `hasSubcommands: true` and subcommand `selftest` (room for later `plur1bus status`). The manifest test allows `hasSubcommands: true` for `plur1bus` only. If Task 1 finds the root name `plur1bus` refused or colliding, fall back to root `plur1bus-selftest` (`hasSubcommands: false`) and every later task uses Task 1's recorded name. |
| HM1-R6 | Selftest must not touch credentials or a user's store, and must work without a Gateway. | Runs in the CLI process, no Gateway call. Opens a throw-away store `mkdtemp(<stateDir>/plur1bus-selftest-)`, deletes it unless `--keep`. Embeds with the **configured local profile** when `embedding.provider` is `local-transformers`, else the pinned E5 profile (`E5_EMBEDDING_PROFILE`, revision `614241f622f53c4eeff9890bdc4f31cfecc418b3`, MIT). A remote provider (`openai`, `openai-compatible`) is **not** called unless `--remote` is given (the step reports `skipped: remote-provider`). Reranks only for `reranker.enabled && reranker.provider === "local-transformers"` with artefacts present. Models download only with `--download-models`; an absent model otherwise gives `model.state: "missing"`, the embed/capture/recall steps `skipped`, and a warning, not a failure (spec A.4 "offline → warn"). |
| HM1-R7 | Spec A.3 step 3: run what `postinstall` would have done (`setup-feature-crons.mjs`), because `--ignore-scripts` skips it. The plugin's own `gateway_start` bootstrap already provisions the same jobs (`featureCronSetup.auto`, default `true`), and the script needs a reachable Gateway and always exits 0. | The installer runs `node <pluginDir>/scripts/setup-feature-crons.mjs --json` **only when `openclaw gateway status --json` reports a running Gateway**; its warnings are reported, never fatal. With no Gateway the step is `skipped: gateway-start-reconciles`. `<pluginDir>` comes from the install record (Task 1 field). |
| HM1-R8 | The Node port of the snapshot step (spec A.3 step 6). The bash installer writes `<state>/memory/.snapshots/*.tar.gz` (max 5); `backup-snapshot.sh` writes `<home>/.snapshots/plur1bus-<ts>/` and includes `vault`. Node has no tar. | Directory snapshots with a SHA-256 manifest at `<stateDir>/memory/.snapshots/plur1bus-<UTC yyyymmddTHHMMSSZ>-<label>/` (`snapshot.json`, schema `plur1bus.snapshot/1`). Content: the resolved `baseDbPath` → `store/`; `memory/_archive`, `memory/run-state.json`, `memory/merge-proposals.jsonl` when present. **Not** `vault` (Obsidian user files, not replaced by an update, can be large) and never config or credentials. Per LanceDB table directory the copy order is data, `_indices`, `_deletions`, `_transactions`, then `_versions` last; afterwards the newest source manifest is re-read and must be unchanged, and every file the copied newest manifest names must exist in the copy; `ENOENT` mid-copy or a changed manifest restarts that table, three tries, then `source-busy`. Free space ≥ 1.1 × the bytes to copy (`fs.statfs`) or `insufficient-disk`. Max **5** Node snapshots; the bash tool's `*.tar.gz` are listed as `kind: "legacy-tar"`, never pruned or restored by the Node tool. No native dependency, so the installer bundle can include it. |
| HM1-R9 | D89 "upgrade in place without data loss", and the owner's VPS: a legacy rsync deploy (F7), plus `protect-plur1bus-deploy.sh` (plugin `scripts/`, live copy under `<state>/scripts/`, run from cron every 15 min) that restores the deploy from `<state>/plur1bus-release` whenever it differs. **O2.** | `detectLegacyDeploy` = the directory `<stateDir>/extensions/memory-lancedb-namespaced` exists **and** `plugins inspect … --json` shows no install record (Task 1 field). Result: `install`/`--update` exit 2 `legacy-deploy`, naming `--adopt-legacy`. Guard = file `<stateDir>/scripts/protect-plur1bus-deploy.sh` exists, or (POSIX) a line of `crontab -l` contains `protect-plur1bus-deploy` (the line is matched, never printed). Guard present → `--adopt-legacy` exits 3 `legacy-deploy-guard` and prints the steps (disable the cron line, then re-run). Adoption: snapshot → rename the legacy dir to `<stateDir>/extensions/.plur1bus-legacy-<ts>` (kept) → `openclaw plugins install <spec> --force` → verify → on failure rename back and restore the snapshot. `memory-lancedb-stock` and `plur1bus-release` are left untouched. |
| HM1-R10 | Which config the installer may change. | Only through `openclaw config set`, only these keys: `plugins.slots.memory` (fresh install and adoption; the previous value is kept in the installer state file and restored on uninstall if it was not `memory-core`); `plugins.entries.memory-lancedb-namespaced.config.modelPreparation.profile` and `.acceptNonCommercialLicense` (licence gate); `.embedding.provider` = `local-transformers` and `.embedding.model` = the chosen profile's model **only when `embedding.provider` is unset**. An update never changes an existing embedding choice. `openclaw.json` is never opened by the installer. If Task 1 shows an install records the plugin disabled because its config is absent, the installer writes the licence keys first and then runs `openclaw plugins enable memory-lancedb-namespaced`. |
| HM1-R11 | "Install OpenClaw with its own installer into a temp state dir" (A.2) and "tests never touch a real installation". | CI legs: POSIX `curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh \| bash -s -- --prefix "$RUNNER_TEMP/oc" --version <v> --json`; Windows `& ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -Tag <v> -NoOnboard` (a global npm install, acceptable only because the runner is disposable). Both with `OPENCLAW_HOME=$RUNNER_TEMP/oc-home`, `OPENCLAW_STATE_DIR=$RUNNER_TEMP/oc-state`, and `node tests/helpers/assert-disposable.mjs` as the first step after. No Gateway service is installed or started. Local runs: shims only. |
| HM1-R12 | Which OpenClaw versions. | `min` = `package.json` `openclaw.compat.minGatewayVersion` read at run time (`2026.8.1` today); `latest` = `npm view openclaw dist-tags.latest` at run time. The job summary records both resolved versions. |
| HM1-R13 | Upgrade test without a published previous release made by this pipeline. | Blocking leg: pack the same commit twice, once as `<v>-ci.0` (`npm version --no-git-tag-version`), install that, seed a store, upgrade to `<v>` through the installer, assert no data loss. Non-blocking nightly leg: upgrade from the newest GitHub Release `.tgz` of the plugin repo; becomes blocking once 7.17.0 is released. |
| HM1-R14 | Spec A.1/A.5: npm fallback with `--provenance`. The package is not on npmjs.org (P5). **O1.** | Default: first public publish to **npmjs.org** from `plugin-release.yml` with trusted publishing (`id-token: write`, `npm publish <tgz> --provenance --access public`), environment `npm-publish`. The installer's `--source npm` uses `npm:@cyb3rb1ade/plur1bus-memory@<ver> --pin` (explicit `npm:`, per the install docs). GitHub Packages publishing stays as today (manual, release checklist). If O1 is "no", `--source npm` is removed and the fallback is `--offline` with the verified GitHub-Release tarball. |
| HM1-R15 | ClawHub publishing and the integrity check (A.4 "integrity"). | ClawHub publish stays the existing manual checklist step (`docs/release-checklist.md` "ClawHub"). The feed carries the tarball's npm `integrity` (sha512) and SHA-256. The installer compares the install record's npm integrity to the feed. If Task 1 shows a ClawHub install records a different digest, `build-plugin-feed.mjs --clawpack-digest <d>` adds `clawpackDigest`, filled after the manual ClawHub publish, and ClawHub installs compare that instead. |
| HM1-R16 | Hermes in the same scripts (A.1). | `--host hermes` exits 3 `host-not-yet-supported` naming HM2. The feed's `hosts` object reserves `hermes`; the bootstraps pass `--host` through unchanged. |
| HM1-R17 | D89/A.7 coexistence in HM1. | Plugin side only: the installer's compatibility step and the selftest refuse a `baseDbPath` inside a harness home (`$PLUR1BUS_HOME`, else `~/.plur1bus`, else `%LOCALAPPDATA%\PLUR1BUS`, recognised by the existence of its `manifest.json`, HB9) with `store-inside-harness-home`, and print one notice line when a harness home exists at all. The harness `setup` refusal of a store inside an OpenClaw state dir stays **HM4** (it would need OpenClaw paths in harness code, D9). |
| HM1-R18 | C5 "native beta until green four weeks". | Feed field `hosts.openclaw.windowsNativeBeta` (default `true`). The installer prints "Windows native support is in beta" on win32 while it is `true`. The owner flips it by re-signing the feed; no client release needed. |
| HM1-R19 | Release version. **O5.** | 7.17.0 (minor: new CLI and scripts, no store migration). Task 10 bumps `package.json` and `openclaw.plugin.json` together (the manifest test compares them). |
| HM1-R20 | The installer must be one downloadable file with no dependencies. | Sources in `scripts/dist/installer/*.mjs` plus `lib/snapshot/store-snapshot.js`, bundled with `esbuild` (devDependency, exact pin) `--bundle --platform=node --format=esm --target=node24.16` into `dist-installer/plur1bus-plugin-installer.mjs`. A test asserts the bundle imports only `node:` builtins. |
| HM1-R21 | The E5 model (≈ 490 MB) on ten matrix legs. | `actions/cache` keyed `e5-614241f6-${{ runner.os }}-${{ runner.arch }}` on the model cache dir; selftest runs with `--download-models`, so a cold cache still passes. |
| HM1-R22 | Full suite on Windows/macOS (A.2 step 4) may expose engine bugs. | Task 9 makes the suite green by **test-level** means only: an explicit `{ skip: process.platform === "win32" && "<reason>" }` for tests that are POSIX-only by nature. A real engine defect becomes a GitHub issue and a skip whose reason cites it; fixes are follow-up tasks, not HM1. macOS legs are required from day one; Windows legs join the required set once green. |
| HM1-R23 | Effort vs the HM1 share (6–9 ad). **O3.** | The task estimates sum to **9.5 ad** (range 8–11). The excess over 9 comes from three items the spec did not price: the first npm publish with provenance (HM1-R14), legacy-deploy adoption with the guard (HM1-R9), and the bundled Node installer with an inline feed verifier (HM1-R3/R20). Dropping legacy adoption (O2 "migrate the VPS by hand") saves ~0.5 ad. |

**Out of scope:** Hermes host mode (HM2), importer fixes (HM3), harness-side coexistence guards and host→harness upgrade (HM4), `.pkg`/`.msi` (C1), Authenticode signing of the `.ps1` (SignPath pending, DS31; the script stays unsigned with the documented note, as `install.ps1`), the desktop app's "Install into my OpenClaw" (D2), ClawHub publishing from CI, the thin-client plugin (M8).

---

## File structure

```
PLUGIN REPO (Cyb3rb1ade/openclaw-plur1bus-memory)
docs/distribution/openclaw-cli-facts.md (new)                                   T1
tests/fixtures/openclaw-cli/*.json|*.txt (new; captured, redacted)              T1
lib/selftest/{run-selftest,addon-probes,selftest-host}.js (new)                 T2
lib/setup/selftest-plugin-runtime.js (new)                                      T2
adapter/openclaw/register-commands.js (one call)                                T2
openclaw.plugin.json (cliCommands row; version in T10)                          T2, T10
tests/{selftest-run,selftest-cli}.test.js (new); tests/openclaw-restricted-registration.test.js   T2
lib/snapshot/store-snapshot.js (new), scripts/snapshot-store.mjs (new)          T3
tests/snapshot-store.test.js (new)                                              T3
scripts/dist/{minisign.mjs,plugin-feed.schema.json,build-plugin-feed.mjs} (new) T4
tests/helpers/minisign-sign.js (new), tests/fixtures/minisign/* (new, TEST ONLY) T4
tests/dist-{minisign,feed}.test.js (new)                                        T4
scripts/dist/installer/{main,detect,compat,openclaw-cli,licence,verify,state,report}.mjs (new)   T5
scripts/dist/installer/{update,uninstall,legacy}.mjs (new)                      T6
scripts/dist/build-installer.mjs (new); package.json (esbuild devDep, scripts)  T5
tests/helpers/installer-sandbox.js (new), tests/dist-installer-*.test.js (new)  T5, T6
scripts/dist/{install-plugin.sh.in,install-plugin.ps1.in,render-bootstraps.mjs} (new)   T7
tests/dist-bootstrap-{sh,ps1}.test.js (new)                                     T7
.github/workflows/plugin-dist.yml (new)                                         T8, T9 (suite job)
tests/helpers/{assert-disposable,seed-store,store-digest,sign-feed-for-ci}.mjs (new)   T8
tests/*.test.js (skip annotations only); .github/workflows/ci.yml               T9
.github/workflows/plugin-release.yml (new); package.json (version)              T10
README.md, docs/distribution.md (new), docs/release-checklist.md, CHANGELOG.md, AGENTS.md   T11

HARNESS REPO (Cyb3rb1ade/PLUR1BUS-Harness)
docs/manual-release.md, docs/milestones.md,
docs/superpowers/specs/2026-09-28-plugin-distribution-and-migration-design.md (status line)   T12
```

## Task map, batches, model tiers and effort

| # | Repo | Task | Produces (used by) | Tier | ad |
|---|---|---|---|---|---|
| 1 | plugin | Spike: verify the unverified OpenClaw behaviour on disposable instances; fact sheet + captured fixtures | fact sheet, fixtures (2, 5, 6, 7, 8) | opus | 0.5 |
| 2 | plugin | `openclaw plur1bus selftest` | `runSelftest`, CLI root (5, 8) | opus | 1.25 |
| 3 | plugin | Node snapshot step `lib/snapshot/store-snapshot.js` + `scripts/snapshot-store.mjs` | `createSnapshot`, `restoreSnapshot` (6) | opus | 0.75 |
| 4 | plugin | Minisign verifier, feed schema, feed builder | `verifyMinisign`, feed shape (5, 7, 10) | opus | 0.5 |
| 5 | plugin | Node installer: detect, compat, install, licence gate, verify, rollback, report; bundle | `runInstaller`, `createOpenclawCli`, bundle (6, 7, 8) | opus | 1.25 |
| 6 | plugin | Installer: update with snapshot, uninstall/purge, legacy adoption, resume | — | opus | 1.0 |
| 7 | plugin | Bootstraps `install-plugin.sh` / `.ps1` incl. WSL delegation | rendered bootstraps (8, 10) | opus | 1.0 |
| 8 | plugin | `plugin-dist.yml`: pack once, 5 × 2 install matrix, selftest, installer e2e + upgrade, WSL leg | reusable workflow (10) | opus | 1.25 |
| 9 | plugin | Full suite on `windows-2025`, `windows-11-arm`, `macos-15` | — | sonnet | 0.75 |
| 10 | plugin | `plugin-release.yml`: artefacts, unsigned feed, attestations, npm provenance; 7.17.0 | release artefacts (12) | sonnet | 0.75 |
| 11 | plugin | README fixes (F4), `docs/distribution.md`, release checklist, CHANGELOG, AGENTS.md | — | sonnet | 0.25 |
| 12 | harness | `manual-release.md` plugin-feed section, milestones, spec status | — | sonnet | 0.25 |
| | | **Total** | | | **9.5** (HM1 share 6–9, HM1-R23) |

**Parallel batches** (no two tasks in a batch touch the same file; checked below):

- **Batch A:** Tasks **1, 3, 4**.
- **Batch B:** Tasks **2, 5** (after Task 1; Task 5 also after Task 4).
- **Batch C:** Tasks **6, 7, 9** (Task 6 after 3 and 5; Task 7 after 4 and 5; Task 9 after 2).
- **Batch D:** Task **8** (after 2, 5, 6, 7).
- **Batch E:** Tasks **10, 11, 12** (Task 10 after 8; Task 11 after 6 and 7; Task 12 after 10's dry run).

## Conflict scan

| File | Tasks | Kind of change | Seq / resolution |
|---|---|---|---|
| `openclaw.plugin.json` | 2, 10 | T2 adds the `plur1bus` `cliCommands` row; T10 bumps `version` | B → E |
| `package.json` | 5, 10 | T5 adds `esbuild` devDep and `build:installer`/`build:bootstraps` scripts; T10 bumps `version` | B → E |
| `tests/openclaw-restricted-registration.test.js` | 2, 9 | T2 allows `hasSubcommands: true` for `plur1bus`; T9 may add a win32 skip | B → C |
| `adapter/openclaw/register-commands.js` | 2; open engine PRs (P2) | one added call beside `registerObsidianVaultRuntime` | re-check at start |
| `.github/workflows/plugin-dist.yml` | 8, 9 | T8 creates it; T9's suite job goes into **`ci.yml`**, not here | disjoint |
| `.github/workflows/ci.yml` | 9 only | new `test-cross` matrix job | — |
| `scripts/dist/installer/*.mjs` | 5, 6 | T6 adds `update/uninstall/legacy.mjs` and registers them in `main.mjs`'s mode switch | B → C |
| `tests/helpers/installer-sandbox.js` | 5, 6, 7 | T5 creates; T6/T7 import only | B → C |
| `docs/release-checklist.md` | 11 only | — | — |
| harness `docs/milestones.md` | 12; other harness plans in flight | HM1 row status text only | whichever merges second rebases |

---

### Task 1 (plugin repo): Spike the unverified OpenClaw behaviour on disposable instances

**Files:**
- Create: `docs/distribution/openclaw-cli-facts.md`, `tests/fixtures/openclaw-cli/{version-2026.8.1.txt,version-latest.txt,inspect-not-installed.json,inspect-installed.json,inspect-runtime-loaded.json,inspect-legacy-untracked.json,gateway-status-stopped.json,config-get-slot.txt,update-dry-run.txt,install-already-installed.txt}`

**Interfaces:**
- Produces: the fact sheet, one section per question below, each with the exact command, OpenClaw version, OS, the captured output (secrets and host paths replaced by `<redacted>`/`<state>`) and a one-line "use this" rule that later tasks quote. Field paths are written as JSON pointers (e.g. `/install/integrity`). Fixtures are those outputs verbatim after redaction; Task 5's shim replays them.

- [ ] **Step 1: Set up two disposable instances** in a temp dir on the sandbox (Linux x64): `install-cli.sh --prefix $T/oc-<v> --version <v> --json` for `2026.8.1` and `latest`, with `OPENCLAW_HOME=$T/home-<v>`, `OPENCLAW_STATE_DIR=$T/state-<v>`; record where the private `node` lands (`<prefix>/tools/node-v*/bin/node`) and what the wrapper execs. Refuse to continue if `OPENCLAW_STATE_DIR` is not under `$T`.
- [ ] **Step 2: Answer, with captured output:** (a) `openclaw --version` format; (b) `plugins inspect memory-lancedb-namespaced --json` before install, after `plugins install npm-pack:<tgz> --force --accept-capabilities`, and with `--runtime` — the pointers of status, `imported`, installed version, install source, npm integrity, shasum, install path; (c) whether install sets `plugins.slots.memory`, and whether the entry is recorded disabled when the plugin config is absent; (d) `plugins install` of an already installed id (message, exit code); (e) exact-version upgrade: `plugins update memory-lancedb-namespaced`, `plugins update npm:@cyb3rb1ade/plur1bus-memory@<v>`, `plugins update clawhub:@cyb3rb1ade/plur1bus-memory@<v>` (which forms are accepted; use `--dry-run` where a registry is involved); (f) whether `update` and `install --force` keep `plugins.entries.<id>.config` (set a harmless key such as `config.language` first, compare with `config get` of that key only); (g) an untracked copy at `<state>/extensions/memory-lancedb-namespaced` (rsync of the unpacked tarball): what `inspect --json`, `install`, `install --force` and `update` do; (h) `gateway status --json` with no Gateway; (i) a root CLI `plur1bus` with `hasSubcommands: true` and a subcommand registered by a scratch copy of the plugin: appears under `cliCommands` in `inspect --runtime --json`, runs as `openclaw plur1bus selftest` without a Gateway, and whether `api.config`/`api.pluginConfig` is readable inside the action; (j) `OPENCLAW_CONFIG_READONLY=1` with `plugins install`: exit code and message; (k) on the GitHub Release tarball vs a ClawHub install of the same version (ClawHub `7.5.3` per the README, if still listed): do the recorded npm integrities match (HM1-R15). Anything that needs Windows or macOS (Node location for `install.ps1`, `openclaw.cmd` shim) is answered by dispatching a throw-away workflow run of the same commands on `windows-2025` and `macos-15` from the branch, and the run URL goes into the fact sheet.
- [ ] **Step 3: Verify** every fixture parses (`node -e` JSON parse for `.json`), no fixture contains `apiKey`, `token`, `Bearer`, a home path or an email (`rg -n -i 'apikey|token|bearer|/home/|/Users/|@' tests/fixtures/openclaw-cli` returns nothing).
- [ ] **Step 4: Commit** `docs(dist): OpenClaw CLI facts for plugin distribution, captured on disposable instances (HM1 spike)`.

---

### Task 2 (plugin repo): `openclaw plur1bus selftest`

**Files:**
- Create: `lib/selftest/run-selftest.js`, `lib/selftest/addon-probes.js`, `lib/selftest/selftest-host.js`, `lib/setup/selftest-plugin-runtime.js`, `tests/selftest-run.test.js`, `tests/selftest-cli.test.js`
- Modify: `adapter/openclaw/register-commands.js` (call `registerSelftestRuntime({ api })` whenever `typeof api.registerCli === "function"`, independent of `registerGatewayMethod`), `openclaw.plugin.json` (`cliCommands` gains `{ "name": "plur1bus", "description": "PLUR1BUS maintenance commands (selftest)", "hasSubcommands": true }`), `tests/openclaw-restricted-registration.test.js` (`hasSubcommands` may be `true` only for `plur1bus`)

**Interfaces:**
- Consumes: Task 1 facts (i) (root name, config access in a CLI action). `createStubHost(overrides)` and `resolveStateDir(env)` from `lib/host-services.js`; `createEngine(host, config)` from `engine/create-engine.js`; `E5_EMBEDDING_PROFILE`, `pinnedLocalModelProfile(model)`, `validatePinnedModelArtifacts(profile, cacheDir)`, `ensurePinnedModelArtifacts(profile, cacheDir, { acceptNonCommercialLicense })` from `lib/providers/local-model-artifacts.js`.
- Produces:
  ```js
  // lib/selftest/addon-probes.js
  /** @returns {Promise<Array<{name: "@lancedb/lancedb"|"onnxruntime-node"|"sharp", ok: boolean, package?: string, error?: string}>>} */
  export async function probeNativeAddons({ importer = (s) => import(s) } = {});
  // lib/selftest/run-selftest.js
  export const SELFTEST_SCHEMA = "plur1bus.selftest/1";
  export const SELFTEST_STEPS = ["coexistence", "store.open", "embed", "capture", "recall", "rerank", "store.delete"];
  /** @returns {Promise<SelftestReport>} */
  export async function runSelftest({ stateDir, pluginConfig = {}, downloadModels = false, remote = false, keep = false,
                                      env = process.env, platform = process.platform, importer, fetchImpl, now });
  // SelftestReport = { schema, ok, pluginVersion, node, target: "<platform>-<arch>", addons: [...],
  //   model: { profile, revision, state: "present"|"downloaded"|"missing"|"skipped" },
  //   steps: [{ id, ok, ms, skipped?: string, detail?: string }], harnessHome: string|null, warnings: string[], errors: string[] }
  // lib/setup/selftest-plugin-runtime.js
  export function registerSelftestRuntime({ api, write = (c) => process.stdout.write(c), run = runSelftest });
  ```
  CLI: `openclaw plur1bus selftest [--json] [--download-models] [--remote] [--keep] [--state-dir <dir>]`; exit `0` when `ok`, `1` when a non-skipped step or an addon failed, `2` usage. Human output: one line per addon and step, then `selftest ok` / `selftest failed: <first error>`. `addons[].package` names the platform package that failed to load (`@lancedb/lancedb-<triple>`, `onnxruntime_binding.node` path, `@img/sharp-<platform>`). `ok` ignores `skipped` steps; `model.state: "missing"` adds warning `model-missing` (HM1-R6). The `coexistence` step fails with `store-inside-harness-home` per HM1-R17.

- [ ] **Step 1: Write the failing tests.** `selftest-run.test.js` (temp state dir, `importer` fake, a fake embedder through `createStubHost` overrides so no model is needed): `reports every addon and names the failing platform package` (importer throws for `@lancedb/lancedb` → `ok: false`, `package` set); `round trip captures and recalls two probe texts and deletes the temp store` (after the run no `plur1bus-selftest-*` dir remains under `stateDir`); `--keep leaves the temp store and reports its path`; `a missing model without --download-models skips embed, capture and recall with a warning and stays ok`; `a remote provider is skipped unless remote is true` (no `fetchImpl` call); `rerank runs only for an enabled local reranker with artefacts`; `a baseDbPath inside a harness home fails coexistence` (temp `PLUR1BUS_HOME` with `manifest.json`); `works under a state dir with spaces and non-ASCII`; `never includes config values in the report` (plugin config with `embedding.apiKey: "sk-TEST-DO-NOT-LOG"` → `JSON.stringify(report)` lacks it). `selftest-cli.test.js`: `registers root plur1bus with subcommand selftest`, `--json prints one plur1bus.selftest/1 document and exits 1 on failure`. Restricted registration: `manifest cliCommands and registerCli descriptors must not drift apart` stays green with the new row.
- [ ] **Step 2: Run** `node --test --test-concurrency=1 tests/selftest-run.test.js tests/selftest-cli.test.js tests/openclaw-restricted-registration.test.js` → FAIL.
- [ ] **Step 3: Implement.** The host comes from `createStubHost({ stateDir: tempDir, config: () => engineConfig, logger })`; the engine config is the plugin config with `baseDbPath` replaced by the temp dir and the embedding profile per HM1-R6. The model cache dir is the one the plugin's local provider resolves for that profile, so a download is reused by real use. The CLI action lazy-imports `lib/selftest/run-selftest.js`.
- [ ] **Step 4: Run** the three files → PASS; then Green. Run once against a real disposable OpenClaw on the sandbox: `openclaw plugins install npm-pack:<fresh pack> --force --accept-capabilities && openclaw plur1bus selftest --json --download-models` in Task 1's temp instance; paste the JSON into the report.
- [ ] **Step 5: Commit** `feat(cli): openclaw plur1bus selftest — native addon probes and a throw-away store round trip (D86, spec A.4)`.

---

### Task 3 (plugin repo): Node snapshot step

**Files:**
- Create: `lib/snapshot/store-snapshot.js`, `scripts/snapshot-store.mjs`, `tests/snapshot-store.test.js`

**Interfaces:**
- Produces:
  ```js
  export const SNAPSHOT_SCHEMA = "plur1bus.snapshot/1";
  export const MAX_SNAPSHOTS = 5;
  export class SnapshotError extends Error { /** @param {"source-busy"|"insufficient-disk"|"digest-mismatch"|"not-found"|"unsafe-path"} reason */ constructor(reason, message) }
  /** @returns {Promise<{id: string, dir: string, bytes: number, files: number}>} */
  export async function createSnapshot({ stateDir, baseDbPath, label, pluginVersion, now = Date.now, maxKeep = MAX_SNAPSHOTS, fsImpl });
  /** @returns {Promise<Array<{id: string, kind: "snapshot"|"legacy-tar", createdAt: string, label?: string, bytes: number}>>} */
  export async function listSnapshots({ stateDir });
  export async function verifySnapshot({ dir });                    // re-hash vs snapshot.json; throws digest-mismatch
  export async function restoreSnapshot({ stateDir, baseDbPath, id }); // verify → stage <baseDbPath>.restore-<pid> → rename current to <baseDbPath>.pre-restore-<ts> → rename in
  export async function pruneSnapshots({ stateDir, maxKeep = MAX_SNAPSHOTS }); // oldest Node snapshots only
  ```
  CLI `node scripts/snapshot-store.mjs <create|list|verify|restore|prune> --state-dir <d> [--base-db-path <p>] [--label <l>] [--id <id>] [--json]`; exit 0 ok, 1 `SnapshotError` (reason printed), 2 usage. Content, copy order, retry and disk rule: HM1-R8. `restore` keeps `.pre-restore-<ts>` (the caller deletes it after its own verify). `unsafe-path`: a symlinked source directory that resolves outside its parent, or a `baseDbPath` equal to or containing `stateDir`.

- [ ] **Step 1: Write the failing tests** (temp dirs; LanceDB tables built with the repo's `@lancedb/lancedb`): `snapshot contains the store and memory files and a manifest whose hashes match`; `never copies the vault or openclaw.json`; `keeps at most five Node snapshots and never prunes legacy tar.gz`; `restore brings back the exact rows after the store was changed` (row count and sorted ids equal); `restore of a tampered snapshot fails with digest-mismatch and leaves the store untouched`; `a table compacted during the copy is retried and then refused as source-busy` (an `fsImpl` wrapper deletes a data file on the first copy of a table; three failures → `source-busy`; one failure → success) — Review Focus 2; `insufficient disk space refuses before copying` (`fsImpl.statfs` fake); `snapshots a store under a path with spaces and non-ASCII` — Review Focus 4; `a killed create leaves no half snapshot under its final name` (throw mid-copy → only `*.tmp-*` removed, no `plur1bus-*` dir without `snapshot.json`).
- [ ] **Step 2: Run** `node --test tests/snapshot-store.test.js` → FAIL.
- [ ] **Step 3: Implement.** Stage into `<final>.tmp-<pid>`, write `snapshot.json` last, rename. The module imports only `node:` builtins (asserted by Task 5's bundle test).
- [ ] **Step 4: Run** → PASS; Green.
- [ ] **Step 5: Commit** `feat(snapshot): Node port of the store snapshot step with SHA-256 manifest, LanceDB-consistent copy and restore (spec A.3 step 6)`.

---

### Task 4 (plugin repo): Minisign verifier, feed schema, feed builder

**Files:**
- Create: `scripts/dist/minisign.mjs`, `scripts/dist/plugin-feed.schema.json`, `scripts/dist/build-plugin-feed.mjs`, `tests/helpers/minisign-sign.js`, `tests/fixtures/minisign/{test.pub,feed.json,feed.json.minisig,feed-prehashed.json.minisig}` (real `minisign` CLI output, key labelled `TEST ONLY`, secret key discarded), `tests/dist-minisign.test.js`, `tests/dist-feed.test.js`

**Interfaces:**
- Produces:
  ```js
  // scripts/dist/minisign.mjs — node:crypto only; must stay a single self-contained file (it is inlined into the bootstraps)
  /** @returns {{keyId: Buffer, key: import("node:crypto").KeyObject}} */
  export function parsePublicKey(line);            // base64("Ed" | keyId[8] | pk[32]); the .pub file's second line
  /** @returns {{ok: true, trustedComment: string} | {ok: false, reason: "malformed"|"unsupported-algorithm"|"key-id-mismatch"|"bad-signature"|"bad-global-signature"}} */
  export function verifyMinisign({ message, signatureText, publicKey });
  // "Ed": Ed25519 over the message; "ED": over BLAKE2b-512(message); then the global signature over sig[64] || trustedComment
  export function mainVerify(argv);                // node minisign.mjs <pubkey-line> <file> <sig-file> → exit 0/1, reason on stderr
  // tests/helpers/minisign-sign.js (tests only)
  export function generateTestKeyPair();          // { publicKeyLine, sign(message, { prehash }) → signatureText }
  ```
  Feed (`plur1bus.plugin-feed/1`, JSON Schema draft 2020-12, closed objects except `notes`):
  `{ schema, channel: "stable"|"beta", generatedAt, installer: { version, url, sha256 }, bootstrap: { sh: { url, sha256 }, ps1: { url, sha256 } }, hosts: { openclaw: { windowsNativeBeta: boolean, latest, releases: [{ version, pluginId: "memory-lancedb-namespaced", clawhub: "clawhub:@cyb3rb1ade/plur1bus-memory@<v>", npm?: "npm:@cyb3rb1ade/plur1bus-memory@<v>", tarball: { url, sha256, integrity }, clawpackDigest?: string, compat: { pluginApi, minGatewayVersion }, node, security: boolean, notes: { de, en } }] } } }` — `hosts.hermes` reserved (not allowed yet). `build-plugin-feed.mjs --channel --version --tgz <path> --tarball-url <url> --installer <path> --installer-url <url> --bootstrap-sh <p> --bootstrap-sh-url <u> --bootstrap-ps1 <p> --bootstrap-ps1-url <u> --notes-de <md> --notes-en <md> [--previous <feed.json>] [--clawpack-digest <d>] [--no-npm] --out <json>` reads `compat`/`node`/version from the tarball's `package.json`, computes `sha256` and `integrity` (`sha512-<base64>`), appends to `--previous`'s releases (newest first, version unique), validates against the schema, writes atomically.

- [ ] **Step 1: Write the failing tests.** `dist-minisign.test.js`: `verifies the committed legacy and prehashed fixtures`; `rejects a flipped message byte, a flipped trusted comment, another key id, and a truncated signature` (each with its `reason`); `round-trips with the test signer for both algorithms`; `the module imports only node:crypto and node:buffer` (static scan of its import lines). `dist-feed.test.js`: `builds a valid feed from a packed tarball with sha256 and sha512 integrity`; `appends to a previous feed newest first and refuses a duplicate version`; `rejects hosts.hermes`; `integrity equals npm pack --json's integrity for the same tarball`.
- [ ] **Step 2: Run** both → FAIL.
- [ ] **Step 3: Implement** with `crypto.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x }, format: "jwk" })`, `crypto.verify(null, …)`, `crypto.createHash("blake2b512")`. The schema is checked by a small hand-written validator in `build-plugin-feed.mjs` (no Ajv: the plugin has none), with the schema file as documentation and a test that every schema `required` key is enforced.
- [ ] **Step 4: Run** → PASS; Green.
- [ ] **Step 5: Commit** `feat(dist): zero-dependency minisign verifier and the signed plugin feed format (D87, spec A.5)`.

---

### Task 5 (plugin repo): Node installer — detect, compat, install, licence gate, verify, rollback, report

**Files:**
- Create: `scripts/dist/installer/{main,detect,compat,openclaw-cli,licence,verify,state,report}.mjs`, `scripts/dist/build-installer.mjs`, `tests/helpers/installer-sandbox.js`, `tests/dist-installer-install.test.js`, `tests/dist-installer-bundle.test.js`
- Modify: `package.json` (`devDependencies.esbuild` exact; scripts `build:installer`), `.gitignore` (`dist-installer/`)

**Interfaces:**
- Consumes: Task 1 fact sheet and fixtures; Task 4 feed shape; `openclaw plur1bus selftest --json` (Task 2 report shape).
- Produces:
  ```js
  // detect.mjs — F2 exactly: OPENCLAW_STATE_DIR → <home>/.openclaw-<OPENCLAW_PROFILE> → <home>/.openclaw → legacy <home>/.clawdbot (only if it alone exists);
  // <home> = OPENCLAW_HOME → HOME → USERPROFILE → os.homedir(); config = OPENCLAW_CONFIG_PATH ?? <state>/openclaw.json
  export function resolveOpenclawStateDir({ env, platform, homedir, exists });  // → { stateDir, configPath, profile: string|null, legacy: boolean }
  export async function detectOpenclaw({ env, platform, run, which });          // → { bin, version, node: { bin, version }, stateDir, … } | null
  // openclaw-cli.mjs — the ONLY place that builds openclaw argv; every call has a deadline and never uses a shell
  export function createOpenclawCli({ bin, env, run, timeoutMs = 300_000 });
  //   .version() .inspect(id, { runtime }) .install(spec, { force, pin, acceptCapabilities }) .update(spec) .uninstall(id, { keepFiles })
  //   .enable(id) .configGet(path) .configSet(path, value) .configValidate() .gatewayStatus() .selftest({ downloadModels })
  //   configGet/configSet refuse any path not in ALLOWED_CONFIG_PATHS (Global Constraints list + HM1-R10 set list)
  export const ALLOWED_CONFIG_PATHS;
  // compat.mjs
  export function checkCompat({ openclawVersion, nodeVersion, target, release, freeBytes, readonlyConfig, configValid, baseDbPath, harnessHome });
  //   → Array<{ id: "unsupported-target"|"openclaw-too-old"|"node-unsupported"|"insufficient-disk"|"config-readonly"|"config-invalid"|"store-inside-harness-home", fatal: boolean, detail }>
  // licence.mjs — ADR-006 / A.9
  export async function resolveLicence({ interactive, acceptNc, env, prompt });
  //   → { profile: "e5-multilingual-384"|"jina-v5-nano-<dims>", acceptNonCommercialLicense: boolean, accepted?: { by, at, model, revision, licence: "CC-BY-NC-4.0" } }
  // verify.mjs
  export async function verifyInstall({ cli, release, source });  // → Array<{ id: "loaded"|"integrity"|"selftest"|"model", ok, warn?: boolean, detail }>
  // state.mjs — <stateDir>/memory/.plur1bus-installer.json (0600): { schema: 1, previousSlot, installedVersion, source, inProgress?: { op, step, snapshotId, previousVersion } }
  export function readState(stateDir); export function writeState(stateDir, s);
  // report.mjs
  export const EXIT = { OK: 0, FAILED: 1, NEEDS_CHOICE: 2, INCOMPATIBLE: 3, ROLLBACK_FAILED: 4 };
  export function createReport({ json, stderr, stdout });          // .step(id, status, detail) .finish(exitCode) → prints plur1bus.plugin-installer/1
  // main.mjs
  export async function runInstaller(argv, { env, platform, run, fetchImpl, prompt, isTTY });  // → exit code
  ```
  Flags: `--host openclaw|hermes` (default `openclaw`; `hermes` → exit 3, HM1-R16), `--version <v>` (default feed `latest`), `--source clawhub|npm` (default `clawhub`), `--offline <tgz>`, `--feed <url>` (bootstrap passes the verified feed file as `--feed-file <path>`), `--accept-nc-licence`, `--non-interactive`, `--download-models`, `--update`, `--uninstall`, `--purge`, `--yes-delete-memories`, `--adopt-legacy`, `--yes`, `--dry-run`, `--json`, `--state-dir <dir>`, `--profile <name>`, `--lang de|en`. Install order (spec A.3): detect → compat (all fatal findings printed together, exit 3) → existing install? (tracked → hand over to `--update` path, Task 6; untracked → exit 2 `legacy-deploy`) → install (`clawhub:@cyb3rb1ade/plur1bus-memory@<v>`; `npm:…@<v> --pin`; `npm-pack:<tgz> --force --accept-capabilities` after its SHA-256 matched the feed) → licence config (HM1-R10) → `plugins.slots.memory` → enable if recorded disabled → feature crons (HM1-R7) → verify → on any failure `uninstall --force`, restore the previous slot, exit 1 (4 if that fails). On win32 while `windowsNativeBeta` → one beta line.

- [ ] **Step 1: Write the failing tests** (`installer-sandbox.js`: temp home/state, `openclaw` and `node` shims on `PATH` that append argv to a log and answer from Task 1 fixtures; asserts the resolved `openclaw` is the shim). `dist-installer-install.test.js`: `fresh install runs install, sets the slot, runs selftest and verifies integrity` (argv log equals the expected sequence); `an install whose selftest fails is uninstalled and the previous slot restored, exit 1`; `integrity mismatch against the feed uninstalls and fails`; `an already tracked install switches to update`; `an untracked extensions dir exits 2 naming --adopt-legacy and changes nothing`; `readonly or invalid config stops before any change` (Review Focus 3: `OPENCLAW_CONFIG_READONLY=1`, then a failing `config validate` shim; argv log has no `install`/`config set`); `state dir resolution follows OpenClaw for profiles, legacy dir, spaces and non-ASCII` (Review Focus 4; table test over `resolveOpenclawStateDir` for linux/darwin/win32 envs, plus one full install under `/tmp/p b/Jürgen`); `non-interactive licence defaults to E5 and never accepts silently`; `--accept-nc-licence records who, when, model, revision and licence` (the `config set` argv carries the profile and `acceptNonCommercialLicense true`); `a baseDbPath inside a harness home is refused`; `--host hermes exits 3 naming HM2`; `unsupported targets exit 3 before any change` (`linux-musl`, `darwin-x64`); `never prints config secrets` (a `config get` shim that would return `sk-TEST-DO-NOT-LOG` for a non-allowed path is never called, and the output never contains it); `configGet refuses a path outside the allow-list`; `--json prints exactly one plur1bus.plugin-installer/1 document`. `dist-installer-bundle.test.js`: `the bundle imports only node: builtins`, `the bundle runs --help on the current Node`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** `run` wraps `child_process.execFile` (on win32 the `openclaw.cmd` shim is invoked through `cmd.exe /d /s /c` with argument quoting per Task 1's fact, never through a user shell string). `build-installer.mjs` runs esbuild per HM1-R20 and prints the bundle's SHA-256.
- [ ] **Step 4: Run** → PASS; `npm run build:installer`; Green.
- [ ] **Step 5: Commit** `feat(dist): Node plugin installer — OpenClaw detection, compatibility, install, licence gate, verification and rollback (D87, spec A.3)`.

---

### Task 6 (plugin repo): Installer — update with snapshot, uninstall and purge, legacy adoption, resume

**Files:**
- Create: `scripts/dist/installer/{update,uninstall,legacy}.mjs`, `tests/dist-installer-update.test.js`, `tests/dist-installer-uninstall.test.js`, `tests/dist-installer-legacy.test.js`
- Modify: `scripts/dist/installer/main.mjs` (mode switch)

**Interfaces:**
- Consumes: Task 3 `createSnapshot`, `restoreSnapshot`, `verifySnapshot`; Task 5 `createOpenclawCli`, `verifyInstall`, `readState`/`writeState`, `createReport`, `EXIT`; Task 1 facts (e), (f), (g).
- Produces:
  ```js
  export async function runUpdate(ctx);     // ctx = { cli, report, feed, release, stateDir, baseDbPath, flags, prompt, now }
  export async function runUninstall(ctx);
  export async function runAdoptLegacy(ctx);
  export function detectLegacyDeploy({ stateDir, inspectJson, exists, crontab }); // → { untracked: boolean, guard: boolean, guardSource?: "file"|"crontab" }
  ```
  Update (spec A.3 step 6, D78): installed version from `inspect --json` (Task 1 pointer); equal → `up-to-date`, exit 0; show the release notes for every version between installed and target in `--lang` (default from `LANG`, fallback `en`), then *Now / Later / Skip* on a TTY (`--yes` = Now; no TTY and no `--yes` → exit 2); `writeState({ inProgress: { op: "update", step } })` before each step; `createSnapshot({ label: "pre-<target>" })`; `cli.update(<spec from Task 1 (e)>)`; `verifyInstall`; on failure `cli.update(<previous exact spec>)` then `restoreSnapshot`, delete `.pre-restore-*` only after the rolled-back `verifyInstall` passes; exit 1 (4 if the rollback's verify fails, with the manual commands printed). Resume: a state file with `inProgress` → report the interrupted step and continue from it, or, with `--rollback`, restore. Uninstall (A.3 step 7): `cli.uninstall(id, { keepFiles: false })` with `--force`; restore `previousSlot` if it was not `memory-core`; `--purge` removes the store, the Node snapshots and the plugin's model cache under the state dir only after two interactive confirmations or `--yes-delete-memories` (non-interactive without it → exit 2). Adoption: HM1-R9.

- [ ] **Step 1: Write the failing tests.** Update: `update snapshots, updates, verifies and records the new version`; `release notes are printed before anything changes and Skip changes nothing`; `a failed verify restores the previous version and the snapshot and exits 1` (store digest equal to before); `a failed rollback exits 4 and prints the manual steps`; `no TTY and no --yes exits 2`; `an existing embedding choice is never changed by an update`; `a killed update is completed or rolled back by the next run` (Review Focus 5: kill after the snapshot step via a shim that exits 137 on `update`; second run resumes; no `*.tmp-*`, no stray `.pre-restore-*`). Uninstall: `uninstall keeps the store and snapshots`; `purge without --yes-delete-memories is refused non-interactively`; `the previous memory slot is restored`. Legacy: `legacy deploy with the protect guard refuses adoption and changes nothing` (Review Focus 1: guard file under `<state>/scripts/`, and separately a crontab shim line; exit 3, argv log has no `install`, the legacy dir unchanged); `adoption keeps the legacy dir and the store and rolls back on a failed verify` (legacy dir renamed back, store digest equal); `adoption leaves memory-lancedb-stock and plur1bus-release untouched`; `the crontab line is matched but never printed`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; `npm run build:installer`; Green.
- [ ] **Step 5: Commit** `feat(dist): installer update with store snapshot and automatic rollback, uninstall/purge, legacy-deploy adoption, resume (D87, D89)`.

---

### Task 7 (plugin repo): Bootstraps `install-plugin.sh` and `install-plugin.ps1`

**Files:**
- Create: `scripts/dist/install-plugin.sh.in`, `scripts/dist/install-plugin.ps1.in`, `scripts/dist/render-bootstraps.mjs`, `tests/dist-bootstrap-sh.test.js`, `tests/dist-bootstrap-ps1.test.js`
- Modify: `package.json` (script `build:bootstraps`)

**Interfaces:**
- Consumes: Task 4 `scripts/dist/minisign.mjs` (inlined verbatim), feed shape; Task 5 installer flags and exit codes; Task 1 fact on Node locations.
- Produces: `render-bootstraps.mjs --pubkey-stable <line> --pubkey-beta <line> --out-dir dist-installer` → `install-plugin.sh`, `install-plugin.ps1`, each with the two keys and the verifier inlined at the placeholders `@@PUBKEY_STABLE@@`, `@@PUBKEY_BETA@@`, `@@MINISIGN_JS@@`; refuses to render without both keys unless `--test-key` (then the header says `TEST ONLY`).
  Bootstrap flow (both): env `PLUR1BUS_PLUGIN_CHANNEL` (default `stable`, `^[a-z0-9-]+$`), `PLUR1BUS_PLUGIN_FEED` (default `https://updates.plur1bus.app/plugin/{channel}.json`; https only unless the test flag); target detection as `scripts/install/install.{sh,ps1}` (Rosetta, `PROCESSOR_ARCHITEW6432`); find `openclaw` (`command -v` / `Get-Command openclaw.cmd,openclaw`), missing → exit 3 `openclaw-not-found`; find Node: `node` on `PATH` if its version satisfies `>=24.16.0 <25 || >=26.1.0`, else the OpenClaw-private Node per Task 1, else exit 3 `node-not-found`; fetch feed and `.minisig` into a private temp dir; verify with the inlined verifier (exit 1 on failure, nothing else downloaded); read `installer.url`/`installer.sha256` with Node's `JSON.parse`; download; SHA-256 (Node `crypto`, or .NET in the `.ps1`); exec `node <installer> --feed-file <feed> "$@"` (sh: `</dev/tty` when stdin is not a TTY and `/dev/tty` opens, like `install.sh`). The `.ps1` additionally: `$env:WSL_UTF8 = '1'`; `wsl.exe -l -q` and `-l -v` (running state), decode defensively (strip NULs); probe each running distro with `wsl.exe -d <d> -e sh -lc 'command -v openclaw'`, stopped ones only with `-ProbeWsl` or an interactive yes (HM1-R1/C12); candidates = native + WSL hits (including `OpenClawGateway`); several and no `-Target native|wsl:<d>` → interactive choice, or exit 2 listing them; `wsl:<d>` → fetch `bootstrap.sh` from the verified feed, check its SHA-256, pipe it into `wsl.exe -d <d> -e sh -s -- --version <resolved> <args>`, translating an `--offline <path>` with `wsl.exe -d <d> -e wslpath -a '<path>'`; the distro's own run re-verifies the feed (one Linux code path, spec A.3 step 1).

- [ ] **Step 1: Write the failing tests** (`file://` feed signed per run with `minisign-sign.js`, rendered with `--test-key`, shims from `installer-sandbox.js`, a fake installer `.mjs` that prints its argv as JSON). `dist-bootstrap-sh.test.js` (skip on win32): `a verified feed runs the installer with the given flags`; `a bad signature exits 1 and downloads nothing else`; `an installer hash mismatch exits 1 and runs nothing`; `no openclaw exits 3`; `a too-old node on PATH falls back to OpenClaw's private node, else exits 3`; `an https-only feed refuses file:// without the test flag`; `the rendered script contains no bashisms` (`sh -n` with `dash` when present, and `shellcheck -s sh` when present). `dist-bootstrap-ps1.test.js` (win32 only; runs under `powershell.exe` and `pwsh`): the same six cases; `the rendered ps1 is ASCII-only`; `several candidates without -Target exit 2 and list native and wsl:Ubuntu-24.04` (`PLUR1BUS_PLUGIN_WSL_EXE` shim printing UTF-16LE with NULs); `a stopped distro is not probed without -ProbeWsl`; `wsl:<d> pipes the verified sh with the resolved version and a translated --offline path`; `ps1 passes a non-ASCII state dir through unchanged` (Review Focus 4). `render` unit test: `refuses to render without both keys`.
- [ ] **Step 2: Run** → FAIL (Linux: the sh file; the ps1 file runs in Task 8's Windows legs and via one dispatched CI run now).
- [ ] **Step 3: Implement.** Copy `install.ps1`'s `Get-Sha256` and `Get-Resource`, and `install.sh`'s `fetch`/`detect_target`, from the harness (P1) rather than inventing new ones; both scripts read fully before `main` runs.
- [ ] **Step 4: Run** → PASS on Linux; push the branch and quote the `windows-2025` and `windows-11-arm` run of `tests/dist-bootstrap-ps1.test.js` (a temporary `workflow_dispatch` job in Task 8's workflow is fine if Task 8 is not merged yet; otherwise a one-off dispatch).
- [ ] **Step 5: Commit** `feat(dist): install-plugin.sh and install-plugin.ps1 bootstraps — feed signature check, installer handover, WSL delegation (D87, spec A.3)`.

---

### Task 8 (plugin repo): `plugin-dist.yml` — pack once, five-target install matrix, selftest, installer end-to-end, WSL leg

**Files:**
- Create: `.github/workflows/plugin-dist.yml`, `tests/helpers/assert-disposable.mjs`, `tests/helpers/seed-store.mjs`, `tests/helpers/store-digest.mjs`, `tests/helpers/sign-feed-for-ci.mjs`

**Interfaces:**
- Consumes: Tasks 2, 5, 6, 7 (selftest, installer bundle, bootstraps), Task 4 (`build-plugin-feed.mjs`), Task 1 facts.
- Produces: workflow `plugin-dist` with `on: push: tags: ['v*']`, `schedule: cron '17 3 * * *'`, `workflow_dispatch`, `pull_request` (paths `scripts/dist/**`, `lib/selftest/**`, `lib/snapshot/**`, `.github/workflows/plugin-dist.yml`, `package*.json`, `openclaw.plugin.json`), and `workflow_call` (output `artifact`: the pack artefact name). `permissions: contents: read`. Actions pinned by full SHA, as the existing workflows.
  Jobs:
  - `pack` (`ubuntu-24.04`): `npm ci && npm test && npm pack --json`; outputs version, sha256, integrity; also packs `<v>-ci.0` (HM1-R13); builds the installer bundle and bootstraps with `--test-key`; `sign-feed-for-ci.mjs` builds a feed for both tarballs and signs it with an ephemeral key (public line passed on as `PLUR1BUS_PLUGIN_PUBKEY`); uploads one artefact.
  - `install` (matrix `runner: [ubuntu-24.04, ubuntu-24.04-arm, macos-15, windows-2025, windows-11-arm]` × `openclaw: [min, latest]`, `fail-fast: false`): `git config --global core.longpaths true` on Windows; Node 24.21.0; resolve the version (HM1-R12); install OpenClaw per HM1-R11; `assert-disposable.mjs`; restore the model cache (HM1-R21); **raw path**: `openclaw plugins install npm-pack:<tgz> --force --accept-capabilities`, `plugins inspect memory-lancedb-namespaced --runtime --json` → the Task 1 status pointer is loaded and no `sdk-incompatible` diagnostic, `openclaw plur1bus selftest --json --download-models` → `ok: true`; on failure the job prints the `addons` array (A.2 step 3); `plugins uninstall memory-lancedb-namespaced --force`. **Installer path** (`PLUR1BUS_PLUGIN_INSTALLER_TEST=1`, `file://` feed): fresh `install-plugin.{sh,ps1} --offline <ci.0 tgz> --non-interactive --json` → exit 0; `seed-store.mjs` writes 50 synthetic memories into the installed plugin's store with the plugin's own `@lancedb/lancedb`; `store-digest.mjs` (row count + SHA-256 of sorted ids) before; `--update --offline <v tgz> --yes --json` → exit 0; digest after equals before, one snapshot listed; then a forced failing verify (selftest shim env `PLUR1BUS_SELFTEST_FORCE_FAIL=1`, honoured only with the installer test flag) → exit 1 and digest still equal; `--uninstall --json` → store still present. Job summary: resolved OpenClaw version, selftest timings, addon results.
  - `upgrade-from-release` (nightly only, `ubuntu-24.04`, `continue-on-error: true` until 7.17.0 exists, HM1-R13).
  - `wsl` (`windows-2025`, `continue-on-error: true`, C8): `Vampire/setup-wsl` pinned by SHA (the executor pins the current release's commit and records it in the step comment), distribution `Ubuntu-24.04`; inside, Node 24.21 and OpenClaw `latest` via `install-cli.sh` with temp prefix/state; from PowerShell `install-plugin.ps1 -Target wsl:Ubuntu-24.04 --offline <tgz> --non-interactive --json` → exit 0, then `wsl.exe -d Ubuntu-24.04 -e sh -lc 'openclaw plur1bus selftest --json --download-models'` → `ok: true`. `windows-11-arm` has no WSL leg (F14).

- [ ] **Step 1: Write the helpers' tests** in `tests/dist-ci-helpers.test.js`: `assert-disposable refuses a state dir outside RUNNER_TEMP or os.tmpdir()`; `store-digest is stable across row order`; `seed-store refuses a baseDbPath outside the given state dir`.
- [ ] **Step 2: Run** → FAIL; implement the helpers; run → PASS.
- [ ] **Step 3: Write the workflow.** Validate with `actionlint` if available, else a YAML parse in `tests/dist-ci-helpers.test.js` (`plugin-dist.yml parses and every uses: is pinned to a 40-hex SHA`).
- [ ] **Step 4: Dispatch** the workflow on the branch. Required: all 10 `install` legs green. Quote the run URL, the two resolved OpenClaw versions and the per-target selftest timings in the report. The `wsl` leg's result is reported, green or not.
- [ ] **Step 5: Commit** `ci(dist): plugin-dist workflow — pack once, install into disposable OpenClaw min/latest on five targets, selftest, installer upgrade without data loss, WSL leg (D86, spec A.2)`.

---

### Task 9 (plugin repo): Full suite on Windows and macOS

**Files:**
- Modify: `.github/workflows/ci.yml` (new job `test-cross`), `tests/*.test.js` and `test/*.test.js` (skip annotations only)

**Interfaces:**
- `test-cross`: matrix `[windows-2025, windows-11-arm, macos-15]`, Node `24.16.0` and `24.21.0` on `windows-2025`, `24.21.0` elsewhere; `core.longpaths true` on Windows; `npm ci` (with scripts: the optional ONNX/sharp packages must be present); `npm test`. The existing `windows-verified-path.yml` and macOS workflows stay.

- [ ] **Step 1: Run** the suite on the three runners from the branch (dispatch) and collect failures.
- [ ] **Step 2: Classify** each failure: POSIX-only by nature (file modes, signals, abstract sockets, `chmod` semantics) → `{ skip: process.platform === "win32" && "<reason>" }` or the darwin equivalent; a real defect → open a GitHub issue with the failing test, OS and error, and skip with `"<reason> (#<issue>)"` (HM1-R22). No engine code changes in this task.
- [ ] **Step 3: Re-run** until all legs are green. Add `tests/platform-skips.test.js`: `every platform skip carries a reason string` (static scan for `skip: process.platform` without a string reason fails).
- [ ] **Step 4: Report** the run URL, the count of skips per OS with reasons, and the issue numbers.
- [ ] **Step 5: Commit** `ci: run the full suite on windows-2025, windows-11-arm and macos-15; explicit platform skips with reasons (spec A.2 step 4)`.

---

### Task 10 (plugin repo): `plugin-release.yml` — artefacts, unsigned feed, attestations, npm provenance; version 7.17.0

**Files:**
- Create: `.github/workflows/plugin-release.yml`, `docs/release-notes/7.17.0.de.md`, `docs/release-notes/7.17.0.en.md`
- Modify: `package.json`, `openclaw.plugin.json` (`version` 7.17.0), `package-lock.json` (version lines only)

**Interfaces:**
- `on: push: tags: ['v*']` and `workflow_dispatch` (input `dry-run`, default `true`; input `channel`, default `stable`). Jobs: `check` (tag == `v` + `package.json` version == manifest version, else fail); `dist` (`uses: ./.github/workflows/plugin-dist.yml`, pack once — later jobs download its artefact, never re-pack); `assemble` (`ubuntu-24.04`): render bootstraps with `vars.PLUR1BUS_RELEASE_PUBKEY_STABLE`/`_BETA` (dry run without them → `--test-key` and a `::warning::`; real run without them → fail), build the installer bundle, `build-plugin-feed.mjs` with the GitHub Release URLs (`https://github.com/Cyb3rb1ade/openclaw-plur1bus-memory/releases/download/v<v>/…`), the notes files and `--no-npm` unless O1, write `SHA256SUMS` over `cyb3rb1ade-plur1bus-memory-<v>.tgz`, `plur1bus-plugin-installer.mjs`, `install-plugin.sh`, `install-plugin.ps1`, `plugin-<channel>.json`; `actions/attest-build-provenance` (pinned SHA; `id-token: write`, `attestations: write`) for the tarball, the installer and both bootstraps (A.5); upload artefact `plugin-release-<v>`. `github-release` (skipped in dry run; `contents: write`): create the release (title per checklist) and upload the artefact files; the feed is uploaded as `plugin-<channel>.unsigned.json`. `npm-publish` (skipped in dry run or when O1 is not "yes"; environment `npm-publish`; `id-token: write`): `npm publish <tgz> --provenance --access public`, then `npm view @cyb3rb1ade/plur1bus-memory@<v> dist.integrity` must equal the feed's integrity.

- [ ] **Step 1: Write the check** as a test in `tests/dist-release.test.js`: `package.json, openclaw.plugin.json and the lockfile agree on the version`; `plugin-release.yml parses and pins every action to a SHA`; `the release notes exist in de and en for the package version`.
- [ ] **Step 2: Run** → FAIL; bump the version (`npm version 7.17.0 --no-git-tag-version`, then the manifest), write both notes files (fixed headings per D78: *What's new*, *Fixes*, *Upgrade notes*; ≤ 1 500 characters each); run → PASS.
- [ ] **Step 3: Write the workflow**; Green.
- [ ] **Step 4: Dispatch** with `dry-run: true` on the branch. Quote the run URL, the `SHA256SUMS` content, and the unsigned feed from the job summary. If P4's variables are missing, say so; the dry run still passes.
- [ ] **Step 5: Commit** `feat(release): plugin release workflow — one pack, installer bundle, bootstraps, unsigned plugin feed, attestations, npm provenance; 7.17.0 (D87, D78, spec A.5)`.

---

### Task 11 (plugin repo): README install fixes, distribution guide, release checklist, CHANGELOG, AGENTS.md

**Files:**
- Create: `docs/distribution.md`
- Modify: `README.md` ("Installation", currently lines 1125–1171), `docs/release-checklist.md` (new "Distribution (HM1)" section), `CHANGELOG.md` (7.17.0), `AGENTS.md` ("Testing": new test files, `plugin-dist.yml`, the installer test flag and sandbox rule)

- [ ] **Step 1: README (F4).** Replace the requirement line with Node `>=24.16.0 <25 || >=26.1.0` and OpenClaw `2026.8.1` or newer (from `openclaw.compat`); the one-liners from spec A.3 with `--accept-nc-licence` explained; the manual ClawHub line **without** `--acknowledge-clawhub-risk` (not defined by OpenClaw 2026.9.5, F4): `openclaw plugins install clawhub:@cyb3rb1ade/plur1bus-memory@7.17.0`; `npm:` only if O1; the GitHub Release tarball as `npm-pack:<file>` with `--force --accept-capabilities`; Windows native (beta) and WSL notes.
- [ ] **Step 2: `docs/distribution.md`:** targets; what the installer does step by step; every flag and exit code; the feed and its signature (who signs, where the keys come from, HB19 comparison); update, rollback and resume; uninstall and purge; legacy adoption for rsync deploys including the `protect-plur1bus-deploy.sh` cron guard steps (O2); the licence gate; the selftest and how to read a failed native addon; privacy (no credentials read, what the snapshot contains).
- [ ] **Step 3: Release checklist:** per release: dry run of `plugin-release.yml` → real run → owner signs `plugin-<channel>.json` offline (link to the harness `docs/manual-release.md` plugin section) → ClawHub manual publish, then `--clawpack-digest` if HM1-R15 applies → publish feed + `.minisig` + bootstraps → smoke per OS through the published one-liner in a fresh VM or user account.
- [ ] **Step 4: Run** `npm run lint` (docs are not linted; check every command in `docs/distribution.md` against the installer's `--help` output by hand) and Green.
- [ ] **Step 5: Commit** `docs: plugin installation one-liners, distribution guide, HM1 release checklist; README install fixes (F4)`.

---

### Task 12 (harness repo): Plugin feed in the manual release checklist, milestones, spec status

**Files:**
- Modify: `docs/manual-release.md` (new §6 "Plugin feed and one-liners (HM1)"), `docs/milestones.md` (Track HM row HM1: "Plan: `docs/superpowers/plans/2026-09-28-hm1-openclaw-plugin-distribution.md`"; effort note 9.5 ad vs 6–9, O3), `docs/superpowers/specs/2026-09-28-plugin-distribution-and-migration-design.md` (status line: "HM1 plan runs on C1, C5, C6, C8, C11, C12 defaults")

- [ ] **Step 1: `manual-release.md` §6:** the plugin feed is signed with **the same per-channel secret key** as `release.json` (C6), offline: `minisign -S -s stable.key -m plugin-stable.json` (rename the downloaded `plugin-stable.unsigned.json` first); publish `plugin-stable.json` + `.minisig` at `https://updates.plur1bus.app/plugin/stable.json`, and `install-plugin.sh`/`.ps1` from the plugin release at `https://plur1bus.app/` beside `install.sh`/`install.ps1` (O4); the plugin repo's variables `PLUR1BUS_RELEASE_PUBKEY_STABLE`/`_BETA` must equal this repository's (P4), because the bootstraps embed them; promotion beta → stable re-signs identical bytes (D78); the plugin bootstrap verifies the signature itself (HM1-R3), which the harness one-liner still does not (HB19).
- [ ] **Step 2: Run** `node scripts/lint-hygiene.mjs` (docs are outside its roots; it must stay green) and `pnpm docs:check`.
- [ ] **Step 3: Commit** `docs: plugin feed signing and one-liner publishing in the manual release checklist; HM1 plan in milestones (D87)`.

---

## Self-review (done while writing)

- **Spec coverage.** A.1 OpenClaw rows (five targets, native + WSL, ClawHub primary, npm fallback, offline tarball) → Tasks 5, 7 (HM1-R14 for npm). A.2 steps 1–5 → Task 8 (pack once, matrix, load + selftest, WSL leg) and Task 9 (full suite). A.3 steps 1–8 → Task 7 (detect incl. WSL delegation), Task 5 (compat, install, licence, verify, report, exit codes), Task 6 (update with snapshot, uninstall/purge); the postinstall step → HM1-R7. A.4 checks → Task 2 (selftest, model), Task 5 (loaded, integrity, Gateway pick-up message), Hermes row out of scope (HM2). A.5 → Task 4 (feed, minisign), Task 10 (SHA256SUMS, attestations, npm provenance), HM1-R4 and Task 12 (signing with the harness key), `.ps1` Authenticode out of scope (SignPath). A.7 plugin half → HM1-R17 in Tasks 2 and 5. A.9 → Task 5 `resolveLicence`. F4 README → Task 11. Milestone row HM1 "Node port of the bash installer's snapshot step" → Task 3. D78 notes first, Now/Later/Skip, rollback → Task 6; notes de/en → Task 10. D89 upgrade in place without data loss → Tasks 3, 6, 8 (upgrade leg with digest).
- **Binding constraints.** Credentials: allow-listed `config get` paths, `never prints config secrets` tests in Tasks 2 and 5, snapshot content rule. No client imitation: every host interaction through `openclaw` (Global Constraints). Owner's VPS: HM1-R9, Review Focus 1, Task 6. Tests never touch a real installation: shims + sandbox guard (Tasks 5–7), `assert-disposable` in CI (Task 8).
- **Verification of facts.** Every OpenClaw subcommand and flag used is in the verified table with its docs URL; the remaining unknowns are Task 1 questions (a)–(k), and every later step that depends on one names the question.
- **Type consistency.** `createOpenclawCli`, `verifyInstall`, `readState`/`writeState`, `createReport`, `EXIT` (Task 5) are what Task 6 consumes; `createSnapshot`/`restoreSnapshot`/`verifySnapshot` (Task 3) match Task 6; `verifyMinisign`/`mainVerify` (Task 4) are what Task 7 inlines; feed fields (`installer`, `bootstrap.sh`, `hosts.openclaw.windowsNativeBeta`, `releases[].tarball.integrity`, `clawpackDigest`) are the same in Tasks 4, 5, 7, 10; selftest schema `plur1bus.selftest/1` in Tasks 2, 5, 8; the CLI root name is HM1-R5's, with Task 1's fallback.
- **Review Focus.** Each of the five lines names a test in its owning task (6, 3, 5, 5/3/7, 6).
- **Effort.** 9.5 ad against the HM1 share of 6–9; the overrun and its three causes are HM1-R23 (O3).
- **Proportion.** Interfaces, flags, test names and the few fixed strings only; no function bodies.
