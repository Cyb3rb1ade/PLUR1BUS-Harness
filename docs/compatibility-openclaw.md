# Compatibility matrix: Harness × engine × OpenClaw (× Hermes)

**Status:** v0.1.0 release checklist item 11 (`docs/milestones.md` §6.2, row 11: "Compatibility matrix published
(harness × engine × OpenClaw); `docs/compatibility-openclaw.md` has its harness column filled").
**Harness column:** `main`, unreleased (no tag exists yet; `CHANGELOG.md` `## [Unreleased]`).
**Written:** 2026-10-05 against Harness `origin/main` `bd3fb20bec865e7bc342beeafbc6db1caa2f84f3`, plugin repo
`origin/main` `f2160c3cd94534ea39a046c9d89bfaec489fe442`, Host-Addons `origin/main`
`8d4eb6c9914da3e4be36d3f90b2c549429dd8090`.

Every fact below cites its source. A cell marked **unverified** was not found in a checked-in source and is not
guessed. Paths are relative to the repository named in the "Repo" column of the source table; the plugin repo is
`Cyb3rb1ade/openclaw-plur1bus-memory`, Host-Addons is `Cyb3rb1ade/PLUR1BUS-Host-Addons`, the Harness is
`Cyb3rb1ade/PLUR1BUS-Harness`.

## 1. The matrix

| Harness | Engine pin (plugin repo SHA) | Engine contract | Contract floor | Plugin version at the pin | OpenClaw min tested | OpenClaw latest tested | Hermes min / latest tested |
|---|---|---|---|---|---|---|---|
| `main` (unreleased, `bd3fb20b`) | `6868b7b117cf7d59b24eb1e75f02aafc1a48f46c` (plugin `origin/main` after PR #237) | `1.12.0` | `1.8.0`, major 1 only | `7.18.4` | `2026.8.1` (Host-Addons) | `2026.9.6` (Host-Addons, resolved 2026-09-28) | `0.21.4` (`743ee72596e7a9f23bc7cd5c570a6ebd958043e4`) / `0.21.5` (`f97608f178d1ffeca59860195ab7da295f7c8e5f`, Linux only) |

Notes on the row:

- **The Harness itself is not tested against a real OpenClaw.** The Harness CI has no job that installs OpenClaw;
  the only OpenClaw use is a synthetic `~/.openclaw` fixture for the importer's `--detect` probe
  (`.github/workflows/ci.yml`, step "create synthetic openclaw fixture in WSL"). The OpenClaw columns therefore
  describe the **plugin** (the same engine, hosted by OpenClaw), exercised by Host-Addons CI. This is what row 12
  of the checklist ("the OpenClaw plugin installs and behaves identically at the same version") relies on.
- **OpenClaw min/latest are from Host-Addons, not the Harness.** Host-Addons `docs/distribution/openclaw-cli-facts.md`
  records min `2026.8.1` (`OpenClaw 2026.8.1 (ea80657)`, equal to `openclaw.compat.minGatewayVersion`) and latest
  `2026.9.6` (`OpenClaw 2026.9.6 (eb377ac)`, npm `dist-tags.latest` on 2026-09-28). "Latest" is resolved at run time
  (`npm view openclaw dist-tags.latest`, step "Resolve OpenClaw latest (HM1-R12)" in Host-Addons
  `.github/workflows/plugin-dist.yml`), so the value moves; the recorded `2026.9.6` is what the cited run saw
  (Host-Addons `docs/distribution/openclaw-cli-facts.md`, run 36528979525 at plugin-repo `fcab978b`, 2026-09-29, all 10
  `install` legs and `wsl` green; that run packed plugin `7.17.0`, not `7.18.4`).
- **Whether the plugin at `7.18.4` / `61025251` has been run against OpenClaw min and latest: unverified.** The
  recorded green run predates it (plugin `7.17.0`). No later run is cited in the checked-in docs.
- **Hermes:** the Harness's own `hermes-host.yml` runs the host-mode sidecar against `0.21.4` on ubuntu-24.04,
  macos-15 and windows-2025 (windows is `continue-on-error`) and against `0.21.5` on ubuntu-24.04 only. `0.21.4` is
  commented as "min: the interface HM2 was written against (743ee72 reports 0.21.4; there is no v0.21.4 tag)";
  `0.21.5` as "tested: tag v2026.9.24 (0.21.5), Linux only" (`.github/workflows/hermes-host.yml`, matrix block).
  Host-Addons `plugin-dist.yml` job `hermes` uses the same two commits as `min` and `latest` on three runners.
  Whether either version still passes today: unverified (CI results are not recorded in a checked-in file).

## 2. Engine pin history (what is verifiable)

| Engine contract | Engine SHA (plugin repo) | Plugin version | Where recorded |
|---|---|---|---|
| `1.9.0` | `b0e149b8` ("E4.3") | `7.16.11` | Harness `CHANGELOG.md` (`[0.1.0]` → Changed); Host-Addons `docs/distribution/openclaw-cli-facts.md` (tarball of this repo at `b0e149b8`, `7.16.11`) |
| `1.10.0` | unverified | unverified | plugin `docs/engine-api.md` (1.10.0 entry) and plugin `CHANGELOG.md` ("7.18.5 … Contract 1.10.0"); the Harness did not pin this contract in a recorded SHA |
| `1.11.0` | `9bafa0477bb47a3d8386d0dc682137adba3aa466` (first pinned at plugin #217; now `6868b7b117cf7d59b24eb1e75f02aafc1a48f46c`, full SHA from `pnpm-lock.yaml` and `packages/core/package.json`) | `7.18.4` (`package.json` at `9bafa047` and `61025251`) | Harness `CHANGELOG.md` `[Unreleased]`; plugin `docs/engine-api.md` (1.11.0 entry: `MemoryOps.import`, `Engine.stores.adopt`, additive only) |
| `1.12.0` | `6868b7b117cf7d59b24eb1e75f02aafc1a48f46c` (first pinned at plugin #219, merge `6868b7b1`; plugin `origin/main` after #237) | `7.18.4` (`package.json` at `6868b7b1`) | Harness `CHANGELOG.md` `[Unreleased]`; plugin `docs/engine-api.md` (1.12.0 entry: `MemoryOps.rebind`/`unbind`, additive only) |

Contract history 1.8.0 → 1.12.0, from plugin `docs/engine-api.md` ("Contract version 1.12.0 … amended thirteen times"):

- **1.8.0:** `Engine.status()` real, `Engine.models`, journal backlog, turn-replay guard, typed `unsupported` for shared memory.
- **1.9.0:** host-neutral engine config schema, warm-only recall, honest recall timing, bounded fragment compaction.
- **1.10.0:** additive engine-config keys (`runtime.deferPostTurnLlm` and others), `JobName` `"post-turn-refine"`.
- **1.11.0:** `MemoryOps.import`, `Engine.stores.adopt`; additive members only.
- **1.12.0:** `MemoryOps.rebind`, `MemoryOps.unbind` (manual N:1 channel-identity link, user-scope owner metadata only); `UserPrincipal` accepts `user:v1` and `user:v2`; new `MemoryOpErrorCode` values `identity-already-bound`, `ledger-corrupt`, `lock-lost`; additive.

The plugin version stayed `7.18.4` across 1.10.0, 1.11.0 and 1.12.0 (plugin `package.json` is `7.18.4` at both
`9bafa047` and `61025251`; the plugin `CHANGELOG.md` lists the 7.18.5–7.18.20 items as "Ported", not as
version bumps). Do not read the plugin version as a monotone proxy for the contract.

The pin `61025251` (plugin `origin/main` after PR #232) adds, on top of #217, the lock-ownership fixes (#220, #224)
and the log-redaction fixes (#225, #229, #231); the contract is unchanged at 1.11.0. The pin `6868b7b1` (plugin `origin/main` after PR #237) adds `memory.rebind`/`unbind` (#219, contract 1.12.0, including the rebind lock fix) and the `global-agent` override that drops `roarr`/`sprintf-js` (#237).

## 3. The contract floor rule

The Harness accepts an engine whose `contract` is `<int>.<int>.<int>`, **major equal to 1**, **minor ≥ 8**.
Anything else makes the core refuse to start with `E_RPC_VERSION`.

| Constant | Value | Source |
|---|---|---|
| `CORE_CONTRACT` (the contract the Harness is built and pinned against) | `1.12.0` | `packages/core/src/engine.ts`; mirrored in `crates/plur1bus/src/install/manifest.rs` (`CORE_CONTRACT`) |
| `SUPPORTED_CONTRACT_MAJOR` | `1` | `packages/core/src/engine.ts` |
| `MIN_CONTRACT_MINOR` (floor = `1.8.0`) | `8` | `packages/core/src/engine.ts` |

- **Check:** `assertEngineContract` in `packages/core/src/engine.ts` throws `E_RPC_VERSION` with `reason =
  engine-contract-major` (not a `<int>.<int>.<int>` string, or major ≠ 1) or `reason = engine-contract-minor`
  (major 1, minor < 8).
- **The floor is deliberately below the pin.** The comment on `MIN_CONTRACT_MINOR` states that the floor stays 1.8.0
  because nothing in the core needs a 1.12.0 member. A search of `packages/core/src` finds no call to
  `memory.import`, `stores.adopt`, `memory.rebind` or `memory.unbind` (2026-10-06), so an engine at 1.8.0 to 1.11.0 passes the startup check (HB2).
  Whether such an engine passes the core's tests: unverified (the test suite pins 1.12.0).
- **The two constants cannot drift apart silently.** The Rust test `core_contract_matches_the_typescript_core_contract`
  in `crates/plur1bus/src/install/manifest.rs` reads `packages/core/src/engine.ts` and asserts equality of
  `CORE_CONTRACT`.
- **Installed-core check in `1staid check` is stricter than the floor.** `check_runtime_core` in
  `crates/plur1bus/src/commands/firstaid_install.rs` reports `warn` when a running core's contract has a different
  major or is **older than the manifest's** `core.contract` (the manifest value is `CORE_CONTRACT`, `1.12.0`), or when
  its `rpc` differs; a newer additive minor is accepted (`contract_compatible`: same major and `running >= installed`).
  It is a warning, not a refusal; the core still answers. Two different rules, by design: startup refusal uses the
  floor (1.8.0), the installation health check compares against what the installer shipped (1.12.0).
- **Major 2 is out of range.** `runCommand` is deprecated in plugin contract 1.5.0 and removed in 2.0
  (plugin `docs/engine-api.md`); the Harness refuses any major other than 1 until a deliberate bump.

### Bumping the engine pin

Per the plugin's amendment rule (plugin `docs/engine-api.md` "Amending the contract"), a contract change moves
`ContractVersion`, the conformance assertions and both adapters together in one plugin PR. For the Harness, a re-pin
changes, in one PR: `packages/core/package.json` and `pnpm-lock.yaml` (SHA), `CORE_CONTRACT` in
`packages/core/src/engine.ts` and `crates/plur1bus/src/install/manifest.rs`, `scripts/gen-engine-keys.mjs` and the
generated `docs/config-engine-keys.md` (header "contract 1.12.0, engine @ 6868b7b1"), `CHANGELOG.md`, and this file.
`MIN_CONTRACT_MINOR` moves only when the core starts to need a newer member.

## 4. How to verify

Only commands present in code are listed. There is **no `doctor` command** in the Harness CLI (no `Doctor` variant
in `crates/plur1bus/src/cli.rs`; the first-aid group is `1staid check` and `1staid repair`). `docs/milestones.md`
§6.2 row 4 uses the word "doctor"; read it as `1staid check` (unverified that the checklist intends a rename).

| Question | Command | Source |
|---|---|---|
| Is the installed core's contract compatible with what the installer shipped? | `plur1bus 1staid check` (check id `runtime.core`; `warn` on contract or rpc drift) | `crates/plur1bus/src/cli.rs` (`FirstAidCmd::Check`), `crates/plur1bus/src/commands/firstaid_install.rs`, `docs/cli.md` ("plur1bus 1staid check") |
| Is the installation repairable? | `plur1bus 1staid repair --dry-run` (prints the plan, changes nothing) | `CHANGELOG.md` `[0.1.0]` (Added: `1staid repair`) |
| Does the core accept its engine? | start the core; a refused engine surfaces as `E_RPC_VERSION` with `reason` `engine-contract-major` or `engine-contract-minor` | `packages/core/src/engine.ts` (`assertEngineContract`) |
| Do the two `CORE_CONTRACT` constants agree? | `cargo test -p plur1bus core_contract_matches_the_typescript_core_contract` | `crates/plur1bus/src/install/manifest.rs` (test) |
| Is the pinned engine's key list in sync? | `pnpm docs:check` (runs `cargo build -q -p plur1bus && node scripts/gen-docs.mjs --check`) | `package.json` scripts; see the limit below |
| Does the plugin (OpenClaw side) pass its own selftest? | `selftest --json` of the plugin CLI; its use in CI is recorded as `FACT wsl.selftest` / "`selftest --json --download-models` returned `ok: true`" | Host-Addons `docs/distribution/openclaw-cli-facts.md`. The exact plugin-side invocation is **unverified** here (not read from plugin code) |

Limit of `pnpm docs:check`: `scripts/gen-docs.mjs` regenerates and compares `docs/rpc.md`, `docs/cli.md` and
`docs/config.md`. It does **not** cover this file. `docs/config-engine-keys.md` is produced by `pnpm docs:gen`
(`scripts/gen-engine-keys.mjs`), and `docs:check` does not compare it either (`package.json` scripts). This file is
hand-written; staleness is caught only by review at re-pin time.

## 5. Open items for the v0.1.0 checklist (row 11)

- **OpenClaw column for the Harness itself:** none exists; the Harness does not host inside OpenClaw. If row 11 means
  "tested against a real OpenClaw", that test is Host-Addons' (plugin) and is currently recorded only for plugin
  `7.17.0`. A plugin run at `7.18.4` against `2026.8.1` and the then-current latest should be recorded here
  before the tag.
- **OpenClaw latest drifts:** `2026.9.6` was latest on 2026-09-28; re-resolve before the release and update the row.
- **Plugin-repo `docs/compatibility-openclaw.md` is stale relative to this table.** It names `2026.8.1` as the floor
  and `2026.9.1` as additionally verified, and a build baseline of `openclaw@2026.8.2`; the plugin `package.json`
  `devDependencies.openclaw` is `2026.8.33`, and the Host-Addons latest is `2026.9.6`. Three different numbers; the
  plugin's file is outside this PR.
- **Contract 1.10.0 SHA:** no recorded Harness pin; fill in if a historical row is wanted.
- **Hermes min/latest results:** CI configuration is cited; results are not recorded in the repository.

## 6. Sources

| Fact | Repo | File |
|---|---|---|
| Checklist item 11 | Harness | `docs/milestones.md` §6.2 |
| Engine pin SHA | Harness | `packages/core/package.json`, `pnpm-lock.yaml` |
| Engine pin narrative, contract 1.12.0 | Harness | `CHANGELOG.md` `[Unreleased]`, `docs/config-engine-keys.md` |
| `CORE_CONTRACT`, floor, major | Harness | `packages/core/src/engine.ts` |
| Rust `CORE_CONTRACT`, drift test | Harness | `crates/plur1bus/src/install/manifest.rs` |
| Installed-core contract check | Harness | `crates/plur1bus/src/commands/firstaid_install.rs`, `crates/plur1bus/src/cli.rs` |
| Hermes versions and commits | Harness | `.github/workflows/hermes-host.yml` |
| Synthetic OpenClaw fixture | Harness | `.github/workflows/ci.yml` |
| Contract history, plugin version | Plugin | `docs/engine-api.md`, `CHANGELOG.md`, `package.json` (`7.18.4`; `openclaw.compat.minGatewayVersion` `2026.8.1`) |
| OpenClaw min/latest, selftest facts | Host-Addons | `docs/distribution/openclaw-cli-facts.md`, `.github/workflows/plugin-dist.yml` |
| Hermes min/latest in plugin-dist | Host-Addons | `.github/workflows/plugin-dist.yml` (job `hermes`) |
