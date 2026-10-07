# Changelog

All notable user-visible changes to the PLUR1BUS Harness are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project does not yet follow semantic versioning
(pre-1.0, milestone-cut releases).

## [Unreleased]

### Added

- **Session store and turn loop (M1b-2c, part 1):** the core keeps chat sessions in `<home>/state/sessions.sqlite`
  (`node:sqlite` + FTS5) and runs a submit/event turn loop with one engine `recall` before and one `capture` after each
  turn. New experimental RPC: `session.create|list|get|resume|archive|submit|events` and the opt-in `session.event`
  notification; new experimental CLI: `plur1bus session list|show|archive` and `plur1bus chat`. No real model provider is
  wired in yet: without one `session.submit` answers `E_NOT_AVAILABLE reason=no-provider`.

- `@plur1bus/providers` (M2, part 1): the OpenAI-compatible `chat_completions` adapter — request builder, SSE
  streaming with incremental tool-call assembly and usage, non-stream path, a typed error taxonomy
  (`auth`, `rate_limit` with retry-after, `context_length`, `content_filter`, `bad_request`, `server`, `timeout`,
  `network`, `protocol`, `aborted`), `AbortSignal` and injectable timeouts throughout, and a tool-argument repair
  hook point (interface only). No auth logic: it takes a ready-made `Authorization` value. Tested against synthetic
  fixtures and a local stub server only.

- **D111 logging foundation, part 1: `log-schema`.** New package `@plur1bus/log-schema` and crate `plur1bus-log-schema`
  hold the JSONL log record schema, the audit record schema (the HB12 v1 fields kept, spec R1), the versioned event
  catalogue (128 events, each with an example), the OpenTelemetry/syslog level map and the redaction patterns as data,
  with one validator per language and a Rust/TypeScript parity test. `docs/log-schema.md` is generated and checked by
  `pnpm docs:check`. No logger or writer is wired in yet; nothing in the existing log files changes.

- **Secret store (M2, ADR-005).** `plur1bus secret status|set|get|rm|ls` and the core's `secret.status|list|set|get|delete`
  RPC (experimental, owner only; any other principal is refused with `E_DENIED`). Secrets go to the OS keyring
  (`@napi-rs/keyring`, loaded on first use) and, only when `secrets.fileFallback.enabled` is `true` (default `false`),
  to an encrypted file (`state/secrets/store.json`: AES-256-GCM, a fresh nonce per entry, the entry's name bound as
  authenticated data, a machine-bound key file `store.key`, both 0600 or a user-and-SYSTEM ACL, written atomically). A
  tampered, truncated or key-less file fails closed (`E_STORAGE`, reason `corrupt`) and the key is never regenerated over
  existing entries. A value is read from stdin, never from an argument, and is printed only by `get --reveal`; every
  access writes a value-free line to `logs/audit.log`, and when that line cannot be written no value is released or
  changed. The engine gets short-lived, revocable leases (in-process; there is no RPC for them). `secret.*` is never
  offered as a WebMCP tool. RPC stays at 1.5.0: the new methods carry `x-since: 1.5.0`.

- **#153:** The Harness API supports sign-in with the owner token.
- **#155:** Added dependency licence/advisory audit tooling and its policy documentation.
- **#157:** Added the Telegram channel adapter with long polling, allowlisting and secret-store token handling.
- **#158:** Added local Ollama/LM Studio discovery and local model adapter support.
- **#160:** Added provider fallback routing with retry and circuit-breaker controls.
- **#161:** Added the core channel registry, manifest and lifecycle framework.
- **#162:** Added the signed extension-catalogue index client and verified offline cache.
- **#163:** Added the tool registry and policy-gated tool-call loop.
- **#165:** Added `exec.run` with deny-by-default execution tiers.
- **#166:** Added live `modelProfiles` configuration for fallback/MoA profiles.
- **#167:** Added root-scoped `file.read|write|list|stat` tools.
- **#168:** Added a fresh-home CLI → daemon → core end-to-end smoke test.
- **#172:** Added inbound A2A Agent Card and task endpoints.
- **#173:** Added deterministic fuzz/property tests for the line protocol and JSON-RPC parsers.
- **#174:** Added the ACP agent adapter and `plur1bus acp serve`.
- **#175:** Added fail-closed outbound egress policy and owner-visible status.
- **#176:** Added Prometheus metrics and a Zabbix 7 template.
- **#177:** Added X2 per-kind extension manifests and worker-side package storage for MCP-server/provider kinds.
- **#178:** Added an automated German/English translation completeness check.
- **#179:** Added a verifiable hash chain for the audit log.
- **#180:** Added `logs.query` and `logs.tail` RPC methods.
- **#181:** Added the Gemini `generateContent`/`streamGenerateContent` provider adapter.
- **#189:** Added the M3 web UI skeleton with Chat, Memories/Dreams, Models, Usage and Doctor pages.
- **#190:** Added D109 approval storage, grants, RPC/CLI and the dispatcher chokepoint.
- **#191:** Added remote embedding and rerank adapters (not yet wired into the core/engine).
- **#193:** Added cache-aware prompt layout metadata and cache-usage telemetry.

### Changed

- **#156:** Reconciled milestone and repository status documentation with merged work.
- **#170:** Added German and English user quickstart and operations handbooks.
- **#186:** Unified provider errors, profile-driven routing and streaming contracts.

- Memory engine re-pinned to **`6868b7b1`** (plugin `origin/main` after PR #237, previously `9bafa047`), contract
  **1.12.0**; top-level engine keys stay **57**. `CORE_CONTRACT` in `packages/core` and `crates/plur1bus` is
  **1.12.0** (drift-guard from #89); the contract floor stays 1.8.0. What changes for Harness users:
  - **Contract 1.12.0 (plugin #219):** additive `Engine.memory.rebind` / `Engine.memory.unbind` (manual N:1
    channel-identity link, user-scope owner metadata only; `unbind` restores the bindings recorded under a rebind id)
    and `UserPrincipal` accepts `user:v2`. The Harness core does not call them yet; its engine-error map gains the
    three new codes (`identity-already-bound` → `E_CONFLICT`, `ledger-corrupt` and `lock-lost` → `E_STORAGE`).
  - **Dependency audit (plugin #237):** `onnxruntime-node`'s `global-agent` is overridden to 4.1.3, which drops
    `roarr` and `sprintf-js` from the engine's tree.
  - **Lock ownership (plugin #220, #224):** file locks, including the job locks the engine takes, are released and
    reaped only by their owner, so a stale or reused lock no longer lets one process drop another's lock.
  - **Log redaction (plugin #225, #229, #231):** memory text, prompts, reminder text and peer ids stay out of engine
    logs; provider error bodies are no longer copied into error messages; webhook and provider URLs are kept out of
    errors and logs; text sidecars are written owner-only.
  - Not included: plugin #233 (further leak-audit items) was still open at the 61025251 pin; not checked since.

### Fixed

- **#151:** Fixed non-reproducible container core-layer builds.
- **#152:** Removed a duplicate RPC schema definition and added duplicate-key detection.
- **#154:** Fixed security findings from the local HTTP API red-team review.
- **#159:** Avoided the macOS backup snapshot timeout caused by syncing the staged copy.
- **#171:** Fixed Windows supervisor log ACL setup and restart failures.
- **#182:** Made supervisor start-delay seam tests resilient to loaded runners.
- **#183:** Hardened the Hermes installer-lock transcription test.
- **#184:** Fixed desktop Windows audit and cold-start flakes.
- **#185:** Made backup snapshots WAL-safe and fixed a macOS hang.
- **#187:** Stabilized unit-test jobs across Windows, macOS and Ubuntu.

- The skills lock `<home>/imports/.lock` (importer and `plur1bus ext`) now carries a nonce and is released only while
  it is still ours (rename aside, re-check, delete or put back). Before, release checked the pid and then deleted, and
  a takeover checked and then deleted, so a lock taken over in between was deleted too. The stale verdict is taken from
  one open handle (contents and metadata together), and a takeover is re-verified on a moved-aside name by file
  identity (dev/ino or volume serial + file index), modification time (and creation time on Windows) and contents. An
  unreadable lock is a holder mid-create for 10 s before it counts as a leftover. A live foreign holder is still never
  taken over. Old and new versions honor each other's live holders; the race fixes hold only when every writer runs
  this version (CLI and core ship together, so a mix exists only during an upgrade) (lock audit N1).

## [0.1.0] — M1b-2a

The first end-to-end harness: a Rust CLI + supervisor, a TypeScript core process binding the memory engine over
JSON-RPC, and the module system. This entry covers the full M1b-2a arc, with **2a-H3b-b** (installer, updater,
repair, release, operations skill, cross-platform migration) as the most recent batch of user-visible work
(PRs #17–#40, since the 2a-H3b-a merge, PR #16).

### Added

- **`plur1bus setup`** — installs the harness end to end: verified Node runtime and core download (SHA-256
  pinned), config with the NC-licence gate, bundled skills, OS service registration, first start, and a
  `1staid check`. Nine fixed steps (`state-root`, `runtime.node`, `runtime.core`, `modules.bundled`, `config`,
  `skills`, `service`, `start`, `check`), each idempotent and atomic; a killed run leaves no half-installed
  directory and a re-run completes without asking again.
- **`plur1bus update --check`** — checks a signed release feed and reports what a real update would change and
  which units would restart, without changing anything yet (`update` without `--check` stays a stub for M8).
  Fails cleanly and within 30 s against an offline, malformed, or oversized manifest.
- **`plur1bus 1staid repair`** — reads the plan `1staid check` finds and applies only the confirmed, safe steps
  (permission fixes, stale-file removal, config restore from backup, runtime re-download, service renewal).
  Prints the whole plan first; `--dry-run` changes nothing; `--yes` confirms every step for non-interactive use;
  with no TTY and no `--yes`, it refuses (exit 2) rather than guess. Never touches `state/`.
- **`1staid check`** grows three new checks: `runtime.node`, `runtime.core`, `models.cache` (18 check ids total,
  up from 15).
- **`plur1bus import`** gains **read-only `--detect`** (finds OpenClaw/Hermes installs without touching them) and
  **`--skills`** import, now working across Linux, macOS and Windows: per-OS default roots, foreign-OS path
  handling, Windows file-lock and long-path hazards, and a checked SQLite copy for the source's memory store. A
  companion migration assistant covers moving an existing installation across platforms.
- **`skills/plur1bus-ops`** — the first bundled operations skill (`SKILL.md` plus `diagnose`/`configure`/`repair`
  playbooks), installed by `setup` and covered by a freshness test.
- **Windows `run/` directory hardening** — the supervisor sets one inheritable, protected ACL on `run/` at start
  instead of shelling out to `icacls` per module; every child of that supervisor is provably confined to the
  current user and `SYSTEM`.
- **`harness-release.yml`** — builds native binaries and core payloads for all five required targets
  (linux-x64, linux-arm64, darwin-arm64, win-x64, win-arm64), signs and notarises the macOS binary, and produces
  the `release-native.json` object consumed by the desktop app's own signed release feed. One-line installers
  (`install.sh`, `install.ps1`) verify the binary's SHA-256 before running it.
- **Module system groundwork** (installer foundations): `module install|uninstall|start|stop|restart|graph`, a
  manifest schema with an API-version policy, and the bundled `fixture` test module used by the demo guide and
  the system tests.

### Changed

- Memory engine re-pinned to **`b0e149b8` (E4.3)**, contract **1.9.0** (E5's host-neutral
  `engine-config.schema.json`, construction-time `recall.*` keys). `core.recall.softBudgetMs` and
  `core.recall.capChars` reclassified from `live` to `x-restart: "core"` (HB3) — they take effect at the next
  core start, matching how the engine actually reads them; `core.recall.hardBudgetMs` stays `live` and is
  enforced by the core's own `AbortSignal.timeout`.
- `MODULE_READY_FLOOR` raised to **10 s** (from 3 s, which flaked under load on CI); `CORE_READY_FLOOR` added at
  the same floor for supervisor startup timing at test time scales.

### Fixed

- Several Windows CI races (supervisor exit-log race, `daemon start`'s "started" detection, loaded-runner test
  flakes, a systemic core-ready-timeout flake) that were keeping `windows-2025` intermittently red.
- Shared-memory tests now gate on engine platform support instead of failing outright on macOS/Windows.
- CRLF line endings no longer break the repository's hygiene lint.

### Documentation

- Desktop app design: containers as a shipping model, release/update policy, the design canvas reconciled with
  the desktop spec, and the extensions-ecosystem spec (skill/plugin install, enable/disable, signed catalogue —
  out of scope for this milestone, frozen as a compatible surface via ⟂EXT).
- Plugin distribution and cross-platform migration design for OpenClaw and Hermes installs (tracks D and HM).

### Known gaps at this baseline

- `update` without `--check` (the actual download-and-swap), `uninstall`, and a Windows code-signing certificate
  remain milestone-M8 work.
- The HB4 real-model recall-timing acceptance and the Windows module-ready wall-clock figure need the owner's
  reference hardware (decision O6, open) — see `docs/reports/2026-m1b-2a-baseline.md`.
- Task 8 (riskier `1staid repair` steps) is in flight in a parallel worktree as of this entry and is not yet
  reflected above.
