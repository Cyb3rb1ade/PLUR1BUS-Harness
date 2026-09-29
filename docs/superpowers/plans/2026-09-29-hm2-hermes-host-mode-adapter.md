# HM2 — Hermes host-mode adapter: Python IPC client, directory provider, `setup --profile host`, `install-plugin --host hermes` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Scope note.** This is the plan for milestone row **HM2** of track HM (`docs/milestones.md` "Track HM", 8–12 ad): D88, the Hermes half of D86/D87, and the parts of D89 an installer needs. It answers owner requirement 1 of 2026-09-28 for **Hermes**. HM1 (OpenClaw) is implemented on plugin PR #200 (not yet merged, P1); HM3 (importer, #40) is merged; HM4 (Hermes bound to an existing harness, host → harness upgrade, catalogue listing, coexistence guards on the harness side) is not planned here. It has **13 tasks**: **8 land in this harness repository** (`Cyb3rb1ade/PLUR1BUS-Harness`), **5 in the plugin repository** (`Cyb3rb1ade/openclaw-plur1bus-memory`), where the HM1 installer lives. Every task header says which.

**Goal:** A person with Hermes on Linux, macOS or Windows (native or WSL2) runs `install-plugin.sh --host hermes` (or `install-plugin.ps1 -Host hermes`). It finds their Hermes, checks compatibility, installs the harness core as a local sidecar (`plur1bus setup --profile host`), binds one agent `hermes-<profile>`, drops the verified `plur1bus` directory provider into `$HERMES_HOME/plugins/plur1bus/`, selects it with `hermes config set memory.provider plur1bus`, proves the install with `hermes plur1bus selftest`, and can later update (store snapshot first, rollback) or uninstall it. Every Hermes turn then recalls and captures through the sidecar's stable RPC; a stopped sidecar never blocks a turn or loses a capture silently.

**Architecture:** Four layers. (1) **`plur1bus-memory-client`** (harness repo, `clients/python/`): stdlib-only Python ≥ 3.11, NDJSON JSON-RPC over the core's Unix socket or named pipe, the same address/token/pid rules as `paths.rs`/`paths.ts`, the S11 server-identity check before the token is sent, deadlines on every call, capability discovery from `core.auth`. Hand-written, with a generated `_schema.py` (method names, `x-stability`, `x-server`, schema hash) and a conformance suite that validates every request and every fixture against `packages/rpc-schema/schema/rpc.schema.json`, offline and against a live core. (2) **The directory provider** (harness repo, `hosts/hermes/plur1bus/`): `plugin.yaml`, `__init__.py` (`MemoryProvider` + `register`), `config_schema.py`, `cli.py`; it vendors the client (HM2-R4), holds no engine, store or model, and maps Hermes hooks onto the RPC (spec A.6 table, as amended by HM2-R5/R14). (3) **The sidecar** is the unchanged `plur1bus` binary with a new `setup --profile host` (supervisor + core, no bundled modules or skills). (4) **The installer** (plugin repo): the HM1 bootstraps and the bundled Node installer gain a `hermes` host module that downloads the pinned sidecar binary and the provider tarball named by the signed feed, runs `plur1bus setup --profile host`, binds the agent, installs the provider through Hermes' own CLI, verifies and rolls back. CI: a new harness workflow `hermes-host.yml` (client + provider live conformance and one real Hermes turn on three OSes) and Hermes legs in the plugin repo's `plugin-dist.yml` (installer end-to-end against real Hermes plus a WSL leg).

**Tech Stack:** Harness: Rust 1.95 (clap 4, serde_json; no new crate), Node 24.21 for generators and the build script (no new npm dependency), Python 3.11–3.13 stdlib (`socket`, `json`, `ctypes`, `threading`, `hashlib`, `tarfile` not used at runtime), `unittest`. **Dev-only Python:** `jsonschema==4.26.0` (conformance tests), `build==1.2.2.post1` and `setuptools==80.9.0` (wheel build in CI only), installed from a hash-pinned `clients/python/requirements-dev.txt`. Plugin repo: Node 24.21, plain ESM JavaScript, `node:test` — all existing; **no new dependency**. Hermes under test: `v0.21.4` (`743ee72`, the checkout the spec read) and the latest tag at run time.

**Spec:** `docs/superpowers/specs/2026-09-28-plugin-distribution-and-migration-design.md` (authority): §0, §1 F8–F13, F16, §A.1 Hermes rows, §A.3 (steps 1–8 as they apply to Hermes), §A.4 Hermes row, §A.5, §A.6 (the whole Hermes adapter), §A.7 (HM2 part), §A.9, "Milestone placement" row HM2, §C C1–C12. Core spec rows **D8, D28, D78, D86–D89** and §6.4–§6.5 (`docs/superpowers/specs/2026-09-24-m1b-2a-core-daemon-cli-design.md`); `docs/host-adapters.md` (tier 1, rules 1–5); `docs/rpc.md` (RPC 1.3.0, NDJSON, 4 MiB line); `docs/milestones.md` row HM2. Reused: the HM1 plan `docs/superpowers/plans/2026-09-28-hm1-openclaw-plugin-distribution.md` and its ledger rulings (R-S1…R-S10, T5-a…T10-a, HM1-R-F1/F2), ruling S11 (`crates/plur1bus-rpc/src/client.rs`), H3B-R9 (`packages/module-api/src/paths.ts`). Executors read the spec and this plan together.

**Owner decisions still open.** Spec C1–C12 are unanswered (no "Owner"/"answered" entry for them in the spec, the milestones or the HM1 ledger, which answered only HM1's O1–O5); this plan runs on the spec's defaults (HM2-R1). New questions this plan raises are listed at the end (Q1–Q8), each with the default the plan runs on.

---

## Prerequisites (must hold before the task that needs them)

| # | Prerequisite | Needed by | Check |
|---|---|---|---|
| P1 | HM1 is on plugin `main`: PR #200 (`feat/hm1-dist`, head `2d275b99` or later) merged. | Tasks 8–12 extend its installer, bootstraps, feed, workflows. | `git -C $PLUGIN merge-base --is-ancestor 2d275b99 origin/main`. |
| P2 | HM3's per-OS Hermes roots are on harness `main` (#40): `defaultHermesHome`, `resolveHermesRoot` in `packages/core/src/import/sources/hermes.ts`. | Task 8 ports the rule and its test table. | Met at harness `d6dad76`. |
| P3 | Reference Hermes checkout `/home/claude/refs/hermes-agent` @ `743ee72` (version `0.21.4`), read-only. | Tasks 1, 5. | `git -C /home/claude/refs/hermes-agent rev-parse HEAD`. |
| P4 | A harness GitHub (pre-)release built by `harness-release.yml` after Tasks 4 and 7 merged, carrying the five `plur1bus-*` binaries and `plur1bus-hermes-provider-<v>.tar.gz`. **Owner step.** | Task 11's Hermes legs become blocking; Task 12's non-dry run. | `gh release view <tag> -R Cyb3rb1ade/PLUR1BUS-Harness` lists them. Until then Task 11's legs run `continue-on-error` (HM2-R19). |
| P5 | No RPC change is planned here (HM2-R6); X1 keeps its claim on RPC 1.4.0. | — | — |

---

## Repositories, branches, and how to run anything

**Harness repo (`$HARNESS`, Tasks 1–7, 13):** `/home/claude/PLUR1BUS-Harness`. Branch **`feat/hm2-hermes-host`** from `origin/main` in its own worktree (`superpowers:using-git-worktrees`). Proposed PR split: **PR-A** Tasks 1–6 (facts, client, setup profile, provider, CI), **PR-B** Tasks 7, 13 (release artefacts, docs). **Node:** `export PATH=/home/claude/.node24/bin:$PATH`.

**Green (harness):**

```bash
pnpm install --frozen-lockfile && pnpm gen && pnpm build && pnpm lint && pnpm test \
  && cargo fmt --all -- --check && cargo clippy --workspace --all-targets -- -D warnings \
  && cargo test --workspace --no-fail-fast && pnpm docs:check \
  && python3 -m unittest discover -s clients/python/plur1bus-memory-client/tests -t clients/python/plur1bus-memory-client \
  && python3 -m unittest discover -s hosts/hermes/tests -t hosts/hermes
```

Python tests need `python3 -m pip install --require-hashes -r clients/python/requirements-dev.txt` once (a venv under the worktree; never the system Python's site-packages).

**Plugin repo (`$PLUGIN`, Tasks 8–12):** branch **`feat/hm2-hermes-installer`** from `origin/main` after P1. Green as in HM1: `npm ci && npm run lint && npm test`; one file: `node --test --test-concurrency=1 tests/<file>.test.js`. PR: one, Tasks 8–12.

**Verified Hermes surface** (read 2026-09-29 at `743ee72`):

| Surface | Fact used by this plan | Source |
|---|---|---|
| Provider discovery | User providers live in `$HERMES_HOME/plugins/<name>/` (directory with `__init__.py` + `plugin.yaml`), per profile; bundled providers win on a name collision; discovery only enumerates, nothing runs until `memory.provider` names it. | `website/docs/developer-guide/memory-provider-plugin.md:17-50` |
| ABC | `MemoryProvider` (`agent/memory_provider.py:75`): `name`, `is_available()` (no network), `initialize(session_id, **kwargs)`, `system_prompt_block()`, `prefetch(query, *, session_id="")`, `queue_prefetch`, `sync_turn(user, assistant, *, session_id="", messages=None)`, `get_tool_schemas()`, `handle_tool_call(tool_name, args, **kwargs)`, `shutdown()`, `on_session_end(messages)`, `on_pre_compress(messages)`, `get_config_schema()`, `save_config(values, hermes_home)`; `spawn_context_thread(target, *, name, daemon=True)` (line 29) is mandatory for background work; `is_trivial_prompt(text)`; `PRE_COMPRESS_CHECKPOINT_API_VERSION = 2` opt-in. | `agent/memory_provider.py:20-181` |
| `initialize` kwargs | `hermes_home`, `platform` (`cli`, `gui`, `acp`, `telegram`, …), `gateway_session_key`, `user_id`, `user_id_alt`, `user_name`, `chat_id`, `agent_identity` (active profile: `default`, the profile name, or `custom` for any other `HERMES_HOME`), `agent_context` (`primary`, `cron`, `subagent`; skip automatic writes for the non-primary values). | guide:100-121; `hermes_cli/profiles.py:1768-1782` |
| `sync_turn` | MUST be non-blocking; run work in a thread from `spawn_context_thread` (profile isolation lives in contextvars). | guide "Threading Contract" |
| `cli.py` | `register_cli(subparser)`; commands appear as `hermes <provider> …` only while the provider is the active `memory.provider`. | guide "Adding CLI Commands" |
| `plugin.yaml` | `name`, `version`, `description`, `hooks: [...]`; optional `pip_dependencies`/`python_dependencies`. | guide "plugin.yaml"; `plugins/memory/honcho/plugin.yaml` |
| Config | `hermes config set <key> <value>` (`hermes_cli/config.py:3711`); `hermes memory status` (`hermes_cli/memory_setup.py:381`); `hermes memory setup <name>` runs pip installs and interactive prompts (not used, HM2-R17). | as cited |
| Python | `requires-python = ">=3.11,<3.14"`. | `pyproject.toml:15` |

**Not verified — Task 1 spikes them** (each later task reads Task 1's fact sheet, never assumes): `hermes --version` output; `hermes config get memory.provider` (exists? format when unset); whether a `$HERMES_HOME/plugins/plur1bus` directory without `pip_dependencies` survives `hermes update` untouched; `hermes memory status` output naming a user provider and its `is_available()`; the real kwargs a CLI one-shot and a gateway session pass (log them from a scratch provider); where Hermes' own Node lives and its version per OS (F11 says 26 POSIX, 22 Windows); the Windows launcher (`hermes.exe`/`hermes.cmd`) and `%LOCALAPPDATA%\hermes` layout; the minimal non-interactive install of a pinned Hermes into a temp prefix and temp `HERMES_HOME`; the minimal config that makes Hermes run one turn against a local OpenAI-compatible stub model.

---

## Global Constraints

Every task's requirements implicitly include this section.

- **Commits** (both repos): `git -c user.name=Cyb3rb1ade -c user.email=84099452+Cyb3rb1ade@users.noreply.github.com commit …`; every message body ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01SxcLhve6hyM9AFm2nU9B3F`. Never `git stash`, `--amend`, push to `main`, or change git config.
- **No secrets, tokens or real user data in either repo or any fixture.** The core token is read from `run/core.token` at connect time and never logged, printed, journaled or put in an error message; captured Hermes output in fixtures is redacted (`<home>`, `<hermes-home>`, `<redacted>`); fixture chat text is synthetic. A test asserts the provider's log and journal never contain the token or a captured message's text (Task 5).
- **Tests never touch a real service manager, a real Hermes or OpenClaw install, or a real home.** Every test runs with temp `HOME`/`USERPROFILE`/`LOCALAPPDATA`/`XDG_*`/`HERMES_HOME`/`PLUR1BUS_HOME`. Rust setup tests use `PLUR1BUS_SERVICE_FAKE`; live Python tests start the stack with `--no-service`; installer tests use `hermes`, `plur1bus` and `wsl.exe` **shims** and throw if `PATH` resolves a non-shim (`tests/helpers/hermes-sandbox.js`). A real Hermes runs only in CI on disposable runners with `HERMES_HOME` and its install prefix under `$RUNNER_TEMP`, guarded by `assert_disposable.py` / HM1's `assert-disposable.mjs`; even there setup runs with `--no-service` (HM2-R19).
- **No remote hosting.** This plan publishes nothing and stands up no service: PyPI upload (Q2), feed signing and publishing to `updates.plur1bus.app`/`plur1bus.app` (HM1-R2/R4) stay owner steps in `docs/manual-release.md`.
- **The provider holds no engine, store or model** (D28 rule 1, T7). Runtime imports: Python stdlib, the vendored client, and Hermes' own `agent.memory_provider`. Nothing else.
- **Hermes is changed only through its CLI and our own files.** The installer runs `hermes config set memory.provider …` and nothing else against `config.yaml`; it writes only `$HERMES_HOME/plugins/plur1bus/`, `$HERMES_HOME/plur1bus.json`, `$HERMES_HOME/plur1bus/` (journal) and its state file `$HERMES_HOME/.plur1bus-installer.json`. It never reads `.env` or any secret file.
- **RPC:** no schema change (HM2-R6); RPC stays **1.3.0**. The client accepts `rpc` major 1 with minor ≥ 3, refuses other majors with `E_RPC_VERSION`. Turn path uses **stable** methods only; experimental methods are called only when `core.auth` capabilities list them (HM2-R5).
- **Python:** ≥ 3.11, < 3.14; runtime stdlib only; `unittest` (no pytest). Code is ASCII except test data.
- **Five targets only** (D8): `linux-x64`, `linux-arm64` (glibc ≥ 2.27), `darwin-arm64`, `win-x64`, `win-arm64`; others exit 3 `unsupported-target` before any change.
- **Scripts** (plugin repo): as HM1 — POSIX `sh`, PowerShell 5.1/7 ASCII-only, .NET SHA-256, no admin, no `sudo`, nothing outside the user's home, the Hermes home and the PLUR1BUS home.
- **Exit codes and JSON:** HM1's (`0`, `1`, `2`, `3`, `4`; `plur1bus.plugin-installer/1` with `host: "hermes"`). New ids: binding file `plur1bus.hermes-binding/1`, provider selftest `plur1bus.hermes-selftest/1`, provider status `plur1bus.hermes-status/1`, bindings registry `plur1bus.hermes-bindings/1`.
- **Atomic writes and Windows retries:** temp `<name>.tmp-<pid>` → fsync → rename; `EPERM`/`EBUSY`/`EACCES` retried with backoff up to 10 s (Python: `PermissionError`/`winerror 32`), as HM1.
- **Hygiene:** nothing under the harness's `packages/ crates/ tests/ scripts/` names OpenClaw (`scripts/lint-hygiene.mjs`); `clients/` and `hosts/` are added to its `ROOTS` (Task 2) so the rule covers the new code too.
- **English** in code, docs and messages; release notes German and English (D78).

## Review Focus

Five inputs the spec implies but no acceptance line names, most likely first. Each is pinned by a named test in its owning task.

1. **The sidecar stops, restarts or is being updated mid-session** (supervisor restart rewrites `run/core.token` and `run/core.pid`; `daemon stop`; Windows reboot before the Task Scheduler entry runs). Expected: no Hermes turn waits longer than its deadline; `prefetch` returns `""` with one warning per session; a failed capture goes to the bounded journal and is replayed after the next successful call; the next call re-reads token and pid. → Task 2 `test_token_is_reread_after_a_core_restart`; Task 5 `test_prefetch_returns_empty_and_warns_once_when_the_core_is_down`, `test_failed_capture_is_journaled_and_replayed_on_the_next_success`; Task 6 `test_core_restart_mid_session_recovers`.
2. **A squatted or stale endpoint** (another user's process created the pipe name first on Windows; a leftover `core.sock` from a killed core; `run/` made group-writable). Expected: the token is never sent to a server whose OS-reported pid differs from `run/core.pid` (S11), and a writable-by-others `run/` is refused. → Task 2 `test_token_is_not_sent_when_the_peer_pid_differs_from_core_pid`, `test_run_dir_writable_by_others_is_refused`; Task 3 `test_squatted_pipe_with_another_server_pid_gets_no_token`.
3. **Homes with spaces and non-ASCII** (`C:\Users\Jürgen A\AppData\Local\hermes`, a PLUR1BUS home `C:\Users\Jürgen A\AppData\Local\PLUR1BUS`, `İ` in a path). Expected: Python computes the same pipe name as `paths.rs`/`paths.ts` (lower-casing parity), and the installer, binding file and provider work there. → Task 2 `test_core_address_matches_the_shared_vectors` (+ the Rust and TS vector tests); Task 8 `a non-ASCII Hermes and PLUR1BUS home install and verify`.
4. **Several Hermes profiles, a custom `HERMES_HOME`, and a gateway serving profiles concurrently.** Expected: one agent per profile (`hermes-default`, `hermes-work`, `hermes-custom-<hash8>`), `Work`/`work` refused as a collision naming both, and concurrent turns of two profiles capture into their own agents. → Task 5 `test_two_profiles_in_parallel_threads_capture_into_their_own_agents`, `test_agent_id_folding_and_custom_home_hash`; Task 8 `Work and work collide and are refused`.
5. **Another memory provider is already active (e.g. `honcho`), or the install is killed halfway.** Expected: never replaced silently (`--replace-provider` or an interactive yes; non-interactive without it exits 2); the previous value is restored on rollback and uninstall; the next run after a kill completes or rolls back, leaving no `plur1bus.tmp-*` directory. → Task 8 `an existing other provider needs --replace-provider and is restored on rollback`, `a killed install is completed or rolled back by the next run`; Task 9 `uninstall restores the previous memory.provider and keeps the store and sidecar`.

---

## Rulings on spec gaps (binding for this plan)

| # | Gap | Ruling (and its cost) |
|---|---|---|
| HM2-R1 | C1–C12 are open. | Spec defaults: **C1** one-liners only; **C2** provider + core sidecar; **C3** Hermes adapter in HM2; **C4** no catalogue build in HM2 (HM4); **C6** feed signed with the harness release key; **C8** WSL legs non-blocking for four weeks; **C11** `--accept-nc-licence` (and `PLUR1BUS_ACCEPT_NONCOMMERCIAL_LICENSE=1`); **C12** stopped WSL distros probed only with consent. C5's pattern is applied to Hermes on native Windows as Q7. C7, C9, C10 do not touch HM2. |
| HM2-R2 | Which repo each part lands in (the spec does not say). | **Harness repo:** the Python client (`clients/python/plur1bus-memory-client/`), the provider (`hosts/hermes/plur1bus/`), `setup --profile`, the conformance run and `hermes-host.yml`, the release artefacts, docs. The schema, the core and the paths rules live here, so the conformance run can use a real core built from the same commit. **Plugin repo:** everything under `install-plugin.*` (HM1-R2 put the installer there; D87 names `install-plugin.sh --host hermes`): feed `hosts.hermes`, the installer's `hermes` module, bootstraps, `plugin-dist.yml` Hermes legs. New top-level harness dirs `clients/` and `hosts/`, not `packages/` (a pnpm workspace glob). **Cost:** the plugin feed references harness artefacts by URL and hash (pinned in `scripts/dist/hermes-sidecar.lock.json`), so a Hermes release needs a harness release first (P4); the plugin repo carries non-OpenClaw install code. |
| HM2-R3 | "Generated from the schema or conformance-tested against it." | Hand-written client (small, stdlib only) **plus** generated `src/plur1bus_memory_client/_schema.py` (`RPC_VERSION`, `SCHEMA_SHA256`, `METHODS = {name: (x_server, x_stability, x_since)}`) and `tests/fixtures/address-vectors.json`, both written by `scripts/gen-python-client.mjs`, run from `packages/rpc-schema`'s `gen` script. Conformance: every request the client builds and every `packages/rpc-schema/fixtures/**` result is validated with `jsonschema` against `rpc.schema.json` (offline, all OSes) and against a live core (Task 6). **Cost:** a generator (≈ 80 lines) instead of a Python codegen dependency. |
| HM2-R4 | A.6 declares `python_dependencies: ["plur1bus-memory-client==<x.y.z>"]`, which needs the client on PyPI for `hermes update`'s venv rebuild (F9); PyPI publishing is an owner step (no remote hosting). | The provider **vendors** the client under `plur1bus/_vendor/plur1bus_memory_client/` (copied at build time, Task 7) and declares **no** Python dependency, so a venv rebuild cannot drop or break it. The wheel and sdist are still built and attached to the harness release for Q2. **Cost:** two copies of the client at run time if the user also pip-installs it (the vendored one always wins by import path); a build-time test asserts the vendored copy is byte-identical to the package source. |
| HM2-R5 | A.6 and F12 call `agent.*` and `memory.checkpoint` stable; at RPC 1.3.0 only `core.auth`, `core.status`, `core.shutdown`, `memory.recall`, `memory.capture`, `events.*` are stable, and `docs/host-adapters.md` rule 4 says adapters consume stable surfaces only. | The turn path (`prefetch` → `memory.recall`, `sync_turn` → `memory.capture`) uses stable methods only. `agent.open` (warm-up at `initialize`), `agent.close`, `memory.checkpoint` and the D21 tools (`memory.list/show/forget/correct/share`) are used **only when `core.auth` capabilities list them**, and their absence disables that hook or tool, never the provider. `agent.open` is not required: `memory.recall`/`capture` only require a registered agent (`packages/core/src/rpc/methods.ts`). Promotion to stable is Q3. |
| HM2-R6 | A.6: "principal from `user_id`/`chat_id`/`platform` (D22/D24)". `CallerIdentity` is `{ channel: "cli", accountId, userId }` (closed); the engine keeps a proved principal only for channels in its route vocabulary (`engine/identity/principal.js`), and the D22 setting (E7) has not landed. | **No RPC change.** The provider sends `channel: "cli"`, `accountId: "hermes:<platform>"` (platform folded to `[a-z0-9_-]{1,32}`, missing → `local`), `userId` = `user_id` → `chat_id` → `"local"` (≤ 128 chars, control characters stripped). The engine derives a distinct user principal per platform and user, trust `proved` (same OS user holds the token). **Cost:** the group/private setting is not conveyed (Q4), and when a later RPC minor adds a host channel the user-principal hash changes, which the engine's user aliases (D24/E7) are for. |
| HM2-R7 | "`core.auth` with the host-mode client token" — no such token exists; `run/core.token` is rewritten on every core start. | The client reads `run/core.token` and `run/core.pid` on every (re)connect. Before sending the token it checks the OS-reported server pid (Linux `SO_PEERCRED`, macOS `LOCAL_PEERPID`, Windows `GetNamedPipeServerProcessId`) equals `run/core.pid` (ruling S11) and, on POSIX, that `<home>/run` is owned by the current uid with no group/other write bit. A scoped per-agent client token is HM4/M3 (D28 authorisation). **Cost:** the provider holds a full-surface core token (same OS user, same trust as the CLI). |
| HM2-R8 | One agent per Hermes profile; `agent_identity` is `custom` for every non-standard `HERMES_HOME`; agents must exist in `config.json` (`E_AGENT_UNKNOWN` otherwise), and only the supervisor's `config.set` can add one. | Binding file `$HERMES_HOME/plur1bus.json` (`plur1bus.hermes-binding/1`: `home`, `bin`, `agentId`, `recallHardMs` default 600, `capture` default true, `installedBy`, `version`), mode 0600. `agentId = "hermes-" + fold(profile)`, `fold` = lower-case, every char outside `[a-z0-9_-]` → `-`, total ≤ 64; `custom` → `hermes-custom-<first 8 hex of sha256(realpath(HERMES_HOME))>`. The installer and `hermes plur1bus bind` create the agent with `plur1bus agent create <id>` and record `{agentId: hermesHome}` in `<plur1bus home>/hosts/hermes-bindings.json`; an `agentId` already bound to another Hermes home is refused naming both. The provider never writes config; on `E_AGENT_UNKNOWN` it degrades and names `hermes plur1bus bind`. |
| HM2-R9 | `--profile` is a new setup option (A.6); A.8 (`--profile full` upgrade) is HM4. | `plur1bus setup --profile host|full`. `host`: step `modules.bundled` and `skills` are `skipped` with reason `profile-host`; `config` creates no first agent unless `--agent` is given; everything else as today (Node, core, config, service, start, check). The install manifest gains optional `profile` (`"host"|"full"`; absent reads as `full`; schema version unchanged). Without `--profile`, setup keeps the recorded profile (a re-run of the harness one-liner never upgrades silently). A profile **change** fails step `state-root` with reason `profile-change-unsupported` and changes nothing (HM4 lifts it). **Cost:** until HM4 a host-mode user cannot upgrade in place. |
| HM2-R10 | A.7: an existing full harness should get Hermes as a tier-1 client "after asking" — HM4 per the milestone table. | The installer detects a PLUR1BUS home (`$PLUR1BUS_HOME`, else the platform default) with a manifest whose `profile` is `full` (or absent) and exits 3 `harness-present`, naming HM4 and changing nothing. A `host` manifest is reused (no second core; the binary is updated only if the feed's sidecar version is newer, Task 9). |
| HM2-R11 | A.6's Windows client is `open(r'\\.\pipe\…', 'r+b')`: blocking reads with no deadline would hang a Hermes turn on a stuck core. | `transport_win.py` uses `ctypes` only: `CreateFileW(..., FILE_FLAG_OVERLAPPED)`, `WaitNamedPipeW` on `ERROR_PIPE_BUSY`, overlapped `ReadFile`/`WriteFile` with `WaitForSingleObject(deadline)` and `CancelIoEx` on expiry, `GetNamedPipeServerProcessId` for HM2-R7. **Cost:** ≈ 1 ad the spec did not price (HM2-R20). |
| HM2-R12 | `is_available()` "the sidecar's socket/pipe exists and its token file is readable"; opening a named pipe to probe it consumes a server instance. | `is_available()` checks files only: the binding file parses and `<home>/run/core.token` is readable. It never connects. A stale token file makes calls fail fast and degrade (HM2-R13). |
| HM2-R13 | Host-adapter rule 1: degraded, "drops nothing silently", a local journal "only if the host allows local files". Hermes gives each profile a storage dir. | Recall failure or timeout → `""` and one warning per session. Capture failure → appended to `$HERMES_HOME/plur1bus/journal.ndjson` (0600; ≤ 1 000 entries and ≤ 4 MiB, oldest dropped with a counted warning), replayed in order after the next successful call; replay stops at the first failure. `hermes plur1bus status` reports queued and dropped counts. Captures are never retried inline. |
| HM2-R14 | A.6 maps both `prefetch` and `system_prompt_block` to `memory.recall`. `system_prompt_block` is built into the cached system prompt. | `system_prompt_block()` returns a fixed one-paragraph note (no RPC), so the prompt cache stays stable; `prefetch()` recalls with `budget.hardMs = binding.recallHardMs` and a transport deadline of `hardMs + 400 ms`, `joined: true`, and returns `result.joined.text`. `is_trivial_prompt(query)` → `""` without a call. `queue_prefetch` is not implemented. |
| HM2-R15 | `on_pre_compress` → `memory.checkpoint`; Hermes offers a fail-closed checkpoint API v2. | Checkpoint API **v1** (best-effort, the inherited default): wait up to 2 s for a pending `sync_turn`, then `memory.checkpoint { reason: "compaction" }` when advertised; return `""`. v2 needs a durable per-transcript archive the engine checkpoint is not (Q5). |
| HM2-R16 | How a Node-less machine verifies the signed feed. HM1's bootstraps borrow OpenClaw's Node; Hermes ships Node 22 on Windows (F11), below the installer's `>=24.16`. | Bootstrap Node chain for `--host hermes`: `node` on `PATH` in range → Hermes' own Node (Task 1 path) in range → an existing sidecar's `<plur1bus home>/runtime/node-v*/…` in range → **pinned portable Node 24.21.0**: the archive URL and SHA-256 per target are rendered into the bootstrap at release (`@@NODE_PINS@@` from `scripts/dist/node-pins.json`, values from nodejs.org `SHASUMS256.txt`, the harness `pins.rs` version), downloaded into `<user cache>/plur1bus/bootstrap-node-24.21.0/`, hash-checked before extraction and on every reuse. **Cost:** ≈ 30 MB extra download on first install; the pins must follow the harness Node pin (Task 10 test + a CI check). |
| HM2-R17 | A.6: the installer "installs the sidecar through the harness's own `install.sh`/`install.ps1` with `--profile host`". Those scripts read the *latest* binary from the unsigned harness feed (HB19). | The installer downloads the **pinned** sidecar binary named by the signed plugin feed (`hosts.hermes.releases[].sidecar.binary[<target>]`, URL + SHA-256), installs it where the harness scripts do (`~/.local/bin/plur1bus`, `%LOCALAPPDATA%\PLUR1BUS\bin\plur1bus.exe`) with the same atomic rename, and runs `plur1bus setup --profile host --non-interactive --use-class <c> [--accept-nc-licence]`; setup verifies Node and the core payload against the binary's baked hashes as today. `hermes memory setup` is not used (it pip-installs and prompts); activation is `hermes config set memory.provider plur1bus`. **Cost:** the bin locations are duplicated; Task 8 cites the harness scripts' lines and tests the same paths. |
| HM2-R18 | Licence gate (A.9) for Hermes host mode. | HM1's `resolveLicence` asks the use-class question; the answer maps to setup flags: personal non-commercial + confirmation → `--use-class general --accept-nc-licence`; commercial → `--use-class commercial`; non-interactive → `--use-class general` without acceptance unless `--accept-nc-licence`. The acceptance is recorded by setup in the harness audit log (A.9); the installer report names it. |
| HM2-R19 | Hard rule "tests never touch a real service manager" vs. setup's `service` step. | Every test and CI leg runs setup with `--no-service` (the installer adds it only when `PLUR1BUS_PLUGIN_INSTALLER_TEST=1` and `PLUR1BUS_PLUGIN_TEST_NO_SERVICE=1`); service rendering stays covered by the existing fake-manager tests. Task 11's legs are `continue-on-error` until P4, then required on `ubuntu-24.04`, `macos-15`, `windows-2025`; WSL non-blocking (C8). |
| HM2-R20 | Effort against HM2's 8–12 ad. | The task estimates sum to **12.5 ad** (range 11–14). The excess comes from three items the spec did not price: the overlapped Windows pipe client (HM2-R11, ~1 ad), the pinned-Node bootstrap path (HM2-R16, ~0.5 ad), and sidecar update with snapshot and binary rollback (Task 9, ~0.5 ad beyond a provider-only update). Q1 names what to drop to get to 12. |
| HM2-R21 | Provider artefact format; the HM1 installer bundle imports only `node:` builtins (no unzip). | `plur1bus-hermes-provider-<v>.tar.gz`: deterministic ustar (sorted, mtime 0, uid/gid 0, mode 0644/0755), regular files and directories only, with `plur1bus/MANIFEST.json` (SHA-256 per file). The installer's `untar.mjs` refuses links, absolute paths, `..`, duplicate names and case-fold duplicates, and re-checks `MANIFEST.json`. |
| HM2-R22 | Versions. | Provider and client carry the **harness version** (one release, one number; a test compares `pyproject.toml`, `plugin.yaml`, `Cargo.toml`). Plugin repo ships the Hermes installer as **7.18.0** (minor). Hermes: `min` = `0.21.4` (the interface read here), `tested` = latest tag at release time, both in the feed. |

**Out of scope:** Hermes on an existing full harness, `setup --profile full` upgrade, Hermes catalogue listing, harness-side coexistence refusals (HM4); a scoped host client token (HM4/M3); the D22 setting for Hermes turns (Q4, E7); checkpoint API v2 (Q5); `on_memory_write` mirroring and `queue_prefetch`; PyPI upload (Q2); `.pkg`/`.msi` (C1); Authenticode (SignPath); the desktop app's "Install into my Hermes" (D2).

---

## File structure

```
HARNESS REPO (Cyb3rb1ade/PLUR1BUS-Harness)
docs/hermes/hermes-host-facts.md (new)                                              T1
hosts/hermes/tests/fixtures/hermes-cli/* (new; captured, redacted)                  T1
hosts/hermes/tests/scratch_provider/ (new; logs kwargs, spike only)                 T1
clients/python/plur1bus-memory-client/{pyproject.toml,README.md,requirements-dev.txt} (new)   T2, T7
clients/python/plur1bus-memory-client/src/plur1bus_memory_client/
  {__init__,paths,protocol,transport_posix,client}.py (new), _schema.py (generated)  T2
  transport_win.py (new)                                                             T3
clients/python/plur1bus-memory-client/tests/{test_paths,test_protocol,test_client_posix,
  test_conformance_offline}.py, fixtures/address-vectors.json (generated)            T2
clients/python/plur1bus-memory-client/tests/test_transport_win.py                    T3
clients/python/plur1bus-memory-client/tests/live/test_conformance_live.py            T6
scripts/gen-python-client.mjs (new); packages/rpc-schema/package.json (gen script)   T2
packages/module-api/test/paths-vectors.test.ts (new); crates/plur1bus/src/paths.rs (test only)   T2
scripts/lint-hygiene.mjs (ROOTS += clients, hosts)                                   T2
crates/plur1bus/src/{cli.rs,commands/setup.rs,install/setup.rs,install/manifest.rs},
  crates/plur1bus/schema/install-manifest.schema.json, crates/plur1bus/src/commands/firstaid*.rs,
  crates/plur1bus/tests/setup_profile.rs (new), docs/cli.md (generated)             T4
hosts/hermes/plur1bus/{__init__,binding,mapping,journal,config_schema,cli}.py,
  plugin.yaml, README.md (new)                                                       T5
hosts/hermes/tests/{stubs/agent/memory_provider.py,test_provider,test_mapping,test_journal,
  test_binding,test_cli}.py (new)                                                    T5
hosts/hermes/tests/e2e/{assert_disposable,stub_model_server,drive_turn,test_provider_live}.py (new)   T6
.github/workflows/ci.yml (job python-host), .github/workflows/hermes-host.yml (new)  T6
scripts/build-hermes-provider.mjs (new), scripts/build-hermes-provider.test.mjs (new),
  .github/workflows/harness-release.yml (job hermes-artefacts)                       T7
docs/hermes-host-mode.md (new), docs/host-adapters.md, docs/milestones.md, docs/manual-release.md,
  AGENTS.md, docs/superpowers/specs/2026-09-28-plugin-distribution-and-migration-design.md (status)   T13

PLUGIN REPO (Cyb3rb1ade/openclaw-plur1bus-memory)
scripts/dist/{plugin-feed.schema.json,build-plugin-feed.mjs} (hosts.hermes)          T8
scripts/dist/hermes-sidecar.lock.json (new)                                          T8
scripts/dist/installer/{untar.mjs, hermes/{detect,hermes-cli,sidecar,plur1bus-cli,provider,binding,install}.mjs} (new)   T8
scripts/dist/installer/main.mjs (host dispatch)                                      T8, T9
scripts/dist/installer/hermes/{update,uninstall}.mjs (new); lib/snapshot/store-snapshot.js (snapshotsDir)   T9
tests/helpers/hermes-sandbox.js, tests/fixtures/hermes-cli/* (new), tests/dist-hermes-{install,feed,untar}.test.js   T8
tests/dist-hermes-{update,uninstall}.test.js, tests/snapshot-store.test.js           T9
scripts/dist/{node-pins.json (new),install-plugin.sh.in,install-plugin.ps1.in,render-bootstraps.mjs};
  tests/dist-bootstrap-{sh,ps1}.test.js, tests/dist-node-pins.test.js (new)          T10
.github/workflows/plugin-dist.yml (jobs hermes, hermes-wsl, node-pins)               T11
.github/workflows/plugin-release.yml; docs/distribution.md; README.md; CHANGELOG.md;
  docs/release-notes/7.18.0.{de,en}.md; package.json, openclaw.plugin.json (7.18.0)  T12
```

## Task map, batches, model tiers and effort

| # | Repo | Task | Produces (used by) | Tier | ad |
|---|---|---|---|---|---|
| 1 | harness | Spike: Hermes behaviour on disposable instances; fact sheet + fixtures | facts (5, 6, 8, 10, 11) | opus | 0.5 |
| 2 | harness | Python client: paths, protocol, POSIX transport, S11, generated `_schema.py`, offline conformance | `MemoryClient` (3, 5, 6) | opus | 1.25 |
| 3 | harness | Python client: Windows named-pipe transport (overlapped, deadlines, server pid) | `open_pipe` (5, 6) | opus | 1.0 |
| 4 | harness | `plur1bus setup --profile host\|full` | profile flag, manifest `profile` (6, 8) | opus | 1.0 |
| 5 | harness | Directory provider `hosts/hermes/plur1bus/` + `cli.py` (status, selftest, bind) | provider (6, 7) | opus | 1.5 |
| 6 | harness | Live RPC conformance run + real Hermes turn; CI on three OSes | `hermes-host.yml` | opus | 1.0 |
| 7 | harness | Provider tarball, wheel/sdist, release job, SHA256SUMS, attestations | artefacts (8, 11, 12) | sonnet | 0.75 |
| 8 | plugin | Feed `hosts.hermes` + installer `--host hermes`: detect, compat, sidecar, bind, provider, verify, rollback | `runHermesInstall` (9, 10, 11) | opus | 1.75 |
| 9 | plugin | Installer Hermes update (snapshot, rollback) and uninstall/purge | — | opus | 1.0 |
| 10 | plugin | Bootstraps `--host hermes`: host detection, WSL probe, pinned-Node fallback | bootstraps (11, 12) | opus | 1.0 |
| 11 | plugin | `plugin-dist.yml` Hermes legs (3 OSes + WSL), node-pins check | — | sonnet | 0.75 |
| 12 | plugin | Release: feed with `hosts.hermes`, docs, 7.18.0 | — | sonnet | 0.5 |
| 13 | harness | Docs: `docs/hermes-host-mode.md`, host adapters, milestones, manual release, AGENTS.md, spec status | — | sonnet | 0.5 |
| | | **Total** | | | **12.5** (HM2 share 8–12, HM2-R20) |

**Parallel batches** (no two tasks in a batch touch the same file):

- **Batch A:** Tasks **1, 2, 4** (harness).
- **Batch B:** Tasks **3, 5** (after 2; Task 5 also after 1).
- **Batch C:** Tasks **6, 7** (after 3, 4, 5) and **8** (plugin; after 1, 4, and P1).
- **Batch D:** Tasks **9, 10** (after 8).
- **Batch E:** Tasks **11, 12** (after 7, 9, 10), **13** (after 6, 7).

## Conflict scan

| File | Tasks / other work | Kind of change | Seq / resolution |
|---|---|---|---|
| `crates/plur1bus/src/cli.rs` | 4; X1 (`feat/x1-extensions`, adds `skill`/`plugin`/`ext`) | T4 adds one field to `SetupArgs` | whichever merges second rebases; disjoint hunks |
| `crates/plur1bus/src/install/setup.rs`, `install/manifest.rs`, `schema/install-manifest.schema.json` | 4 only (X1 does not touch them) | profile handling | — |
| `.github/workflows/ci.yml` | 6; X1 Task 14 | T6 adds one job | rebase |
| `scripts/lint-hygiene.mjs` | 2 only | `ROOTS` | — |
| `packages/rpc-schema/package.json` | 2; X1 Task 10 (schema, not scripts) | T2 appends to `gen` | disjoint |
| `docs/milestones.md` | 13; other plans in flight | HM2 row text | rebase |
| plugin `scripts/dist/installer/main.mjs` | 8, 9 | T8 host dispatch; T9 registers update/uninstall | C → D |
| plugin `scripts/dist/install-plugin.{sh,ps1}.in`, `render-bootstraps.mjs` | 10 only | — | — |
| plugin `.github/workflows/plugin-dist.yml` | 11 only | new jobs | — |
| plugin `lib/snapshot/store-snapshot.js` | 9 only | optional `snapshotsDir` | — |

---

### Task 1 (harness repo): Spike the unverified Hermes behaviour on disposable instances

**Files:**
- Create: `docs/hermes/hermes-host-facts.md`, `hosts/hermes/tests/fixtures/hermes-cli/{version-min.txt,version-latest.txt,config-get-provider-unset.txt,config-get-provider-set.txt,config-set-ok.txt,memory-status-plur1bus.txt,memory-status-unavailable.txt,plur1bus-help.txt,init-kwargs-cli.json,init-kwargs-profile.json,init-kwargs-custom.json}`, `hosts/hermes/tests/scratch_provider/{__init__.py,plugin.yaml,cli.py}` (logs every hook call and its kwargs to a file named by `SCRATCH_LOG`, no network)

**Interfaces:**
- Produces: the fact sheet, one section per question below, each with command, Hermes version, OS, captured output (redacted) and a one-line "use this" rule later tasks quote.

- [ ] **Step 1: Two disposable instances** on the sandbox (Linux x64): Hermes `v0.21.4` and the latest tag, each installed non-interactively into `$T/hermes-<v>` with `HERMES_HOME=$T/home-<v>` (try the official installer with its skip-setup/no-browser options first, else `python3 -m venv $T/venv-<v> && pip install "git+https://github.com/NousResearch/hermes-agent@<tag>"`; record which works and why). Refuse to continue if `HERMES_HOME` is not under `$T`.
- [ ] **Step 2: Answer, with captured output:** (a) `hermes --version`; (b) `hermes config get memory.provider` unset and set (or the supported read form, with exit codes); (c) `hermes config set memory.provider scratch` output and exit code, and that `config.yaml` changed only there; (d) copy `scratch_provider` to `$HERMES_HOME/plugins/scratch/`: `hermes memory status` output with it active and with `is_available()` false; (e) `hermes scratch --help` appears only while active; (f) the kwargs of `initialize` for a CLI one-shot (`hermes chat -q …` or the documented one-shot), for `HERMES_HOME=<root>/profiles/work`, and for a custom `HERMES_HOME` (`agent_identity` values), and the hook call order for one turn and a session end; (g) whether `hermes update` (or its venv-rebuild function, driven the way `hermes_cli/plugin_python_deps.py` documents, without network where possible) leaves `$HERMES_HOME/plugins/scratch/` byte-identical; (h) the path and version of Hermes' own Node per OS; (i) the minimal config that runs one turn against a local OpenAI-compatible stub (`http://127.0.0.1:<port>/v1`, fixed completion) — keys and values; (j) Windows and macOS: the launcher name, `%LOCALAPPDATA%\hermes` layout, (a)–(f) and (h), answered by dispatching a throw-away workflow run of the same commands on `windows-2025` and `macos-15`; the run URL goes into the fact sheet.
- [ ] **Step 3: Verify** no fixture contains a home path, token, key, e-mail or real chat text: `rg -n -i 'apikey|token|bearer|sk-|/home/|/Users/|C:\\\\Users|@' hosts/hermes/tests/fixtures/hermes-cli` prints nothing.
- [ ] **Step 4: Commit** `docs(hermes): Hermes CLI and provider facts for host mode, captured on disposable instances (HM2 spike)`.

---

### Task 2 (harness repo): Python client — paths, protocol, POSIX transport, S11, generated schema module, offline conformance

**Files:**
- Create: `clients/python/plur1bus-memory-client/{pyproject.toml,README.md,requirements-dev.txt}`, `src/plur1bus_memory_client/{__init__,paths,protocol,transport_posix,client}.py`, `tests/{__init__,test_paths,test_protocol,test_client_posix,test_conformance_offline}.py`, `tests/fakes.py` (NDJSON fake core on a Unix socket in a thread), `scripts/gen-python-client.mjs`, `packages/module-api/test/paths-vectors.test.ts`
- Generated: `src/plur1bus_memory_client/_schema.py`, `tests/fixtures/address-vectors.json`
- Modify: `packages/rpc-schema/package.json` (`gen`: `node src/build.mjs && node ../../scripts/gen-python-client.mjs`), `crates/plur1bus/src/paths.rs` (test module only: `address_matches_the_shared_vectors`), `scripts/lint-hygiene.mjs` (`ROOTS` + `clients`, `hosts`; `EXT` + `.py`)

**Interfaces:**
- Produces (Python; every public name re-exported from `__init__`):
  ```python
  # paths.py — H3B-R9 / paths.rs `address`, `resolve_home`
  def default_home(env: Mapping[str, str], platform: str, home_dir: str, local_app_data: str | None = None) -> str
  def core_address(home: str, platform: str) -> str      # "win32": \\.\pipe\plur1bus-<sha256(home.lower())[:16]>-core ; else home.rstrip("/") + "/run/core.sock"
  def core_token_path(home: str) -> str                  # <home>/run/core.token
  def core_pid_path(home: str) -> str                    # <home>/run/core.pid
  # protocol.py
  MAX_LINE: int = 4 * 1024 * 1024
  class RpcError(Exception):  # .code: "E_*" from error.data.error, or client-side "E_TRANSPORT"|"E_TIMEOUT"|"E_SERVER_IDENTITY"|"E_PROTOCOL"|"E_RPC_VERSION"|"E_CORE_UNAVAILABLE"; .data: dict
  def encode_request(req_id: int, method: str, params: dict) -> bytes   # raises RpcError("E_PROTOCOL") when > MAX_LINE
  def decode_line(line: bytes) -> dict
  # client.py
  @dataclass(frozen=True)
  class Caller: account_id: str; user_id: str          # .to_rpc() -> {"channel": "cli", "accountId": ..., "userId": ...}
  class MemoryClient:
      def __init__(self, home: str, *, platform: str = sys.platform, connect_timeout: float = 2.0,
                   call_timeout: float = 5.0, transport_factory: Callable | None = None) -> None
      def connect(self) -> dict                      # reads token + pid, S11 check, core.auth; returns its result
      def supports(self, method: str) -> bool        # from core.auth capabilities
      def status(self) -> dict
      def recall(self, caller: Caller, agent_id: str, query: str, *, session_key: str | None = None,
                 hard_ms: int | None = None, joined: bool = True, deadline_s: float | None = None) -> dict
      def capture(self, caller: Caller, agent_id: str, messages: list[dict], *, session_key: str | None = None,
                  run_id: str | None = None, wait: bool = False) -> dict
      def checkpoint(self, caller: Caller, agent_id: str, reason: str) -> dict
      def agent_open(self, agent_id: str) -> dict ; def agent_close(self, agent_id: str) -> dict ; def agent_status(self, agent_id: str) -> dict
      def memory_list(self, caller, agent_id, *, topic=None, limit=None) -> dict
      def memory_show(self, caller, agent_id, memory_id) -> dict ; def memory_forget(...) ; def memory_correct(..., text) ; def memory_share(..., target, allow_sensitive=False)
      def close(self) -> None
  ```
  Transport contract (`transport_posix.py`, and Task 3's Windows twin): `open_stream(address: str, *, connect_timeout: float) -> Stream` with `Stream.send(data: bytes, deadline: float)`, `Stream.recv_line(deadline: float) -> bytes` (≤ `MAX_LINE`, else `E_PROTOCOL`), `Stream.peer_pid() -> int | None`, `Stream.close()`. Reconnect: a call on a broken connection reconnects **once** (re-reading token and pid) and retries only `core.status`, `memory.recall`, `memory.list`, `memory.show`, `agent.*`; `memory.capture/forget/correct/share/checkpoint` are never retried (the caller decides). `rpc` major ≠ 1 or minor < 3 → `E_RPC_VERSION`. Notifications (no `id`) are skipped.
  Generated `_schema.py`: `RPC_VERSION = "1.3.0"`, `SCHEMA_SHA256 = "<hex of rpc.schema.json bytes>"`, `METHODS: dict[str, tuple[str, str, str]]` (x-server, x-stability, x-since) for every method. `address-vectors.json`: `[{home, platform, address}]` computed with `packages/module-api/src/paths.ts` `coreAddress`, covering POSIX with and without trailing `/`, `C:\Users\Jürgen A\AppData\Local\PLUR1BUS`, a home containing `İ`, and a mixed-case drive letter.

- [ ] **Step 1: Write the failing tests.** `test_paths.py`: `test_core_address_matches_the_shared_vectors` (every vector), `test_default_home_mirrors_resolve_home` (relative and absolute `PLUR1BUS_HOME`, Windows with and without `LOCALAPPDATA`, POSIX `~/.plur1bus`). `test_protocol.py`: `test_a_line_over_4_mib_is_refused_before_sending`, `test_error_response_maps_error_data_error_to_code` (fixture `packages/rpc-schema/fixtures/errors/E_AGENT_UNKNOWN.json` → `code == "E_AGENT_UNKNOWN"`), `test_ids_are_matched_and_notifications_skipped`. `test_client_posix.py` (skip on win32; fake core writes `run/core.token` (64 hex, test-only), `run/core.pid`): `test_token_is_not_sent_when_the_peer_pid_differs_from_core_pid` (pid file names another pid → `E_SERVER_IDENTITY`, fake core log has no `core.auth` line) — Review Focus 2; `test_run_dir_writable_by_others_is_refused` (`chmod 0o777 run` → `E_SERVER_IDENTITY`); `test_token_is_reread_after_a_core_restart` (fake restarts with a new token and pid; next `recall` succeeds) — Review Focus 1; `test_capture_is_never_retried_automatically` (connection dropped mid-capture → `E_TRANSPORT`, fake saw one `memory.capture`); `test_recall_reconnects_once_then_raises_core_unavailable`; `test_call_deadline_raises_timeout_within_budget` (fake never answers; `E_TIMEOUT`, elapsed < `call_timeout + 0.25 s`); `test_supports_reads_core_auth_capabilities`; `test_rpc_major_2_is_refused`. `test_conformance_offline.py`: `test_every_request_the_client_builds_validates_against_the_schema` (each public method called against a recording transport; params validated with `jsonschema.Draft202012Validator` against `$defs/methods/<name>/params`), `test_every_fixture_result_validates_and_parses` (all `packages/rpc-schema/fixtures/methods/*.json` the client uses), `test_client_methods_exist_with_expected_stability` (`memory.recall`, `memory.capture` stable; the rest present), `test_generated_schema_module_is_fresh` (`SCHEMA_SHA256` equals the file's sha256). TS `paths-vectors.test.ts`: `coreAddress matches every vector`; Rust: `address_matches_the_shared_vectors` reads the same JSON with `include_str!`.
- [ ] **Step 2: Run** `python3 -m unittest discover -s clients/python/plur1bus-memory-client/tests -t clients/python/plur1bus-memory-client` → FAIL (no module).
- [ ] **Step 3: Implement.** `gen-python-client.mjs` imports `coreAddress` from `packages/module-api/src/paths.ts` (run with `--experimental-strip-types`) and writes both generated files deterministically (sorted keys, LF). Peer pid: `socket.SO_PEERCRED` (Linux, `struct ucred`), `getsockopt(0, 2)` `LOCAL_PEERPID` (macOS); absent support → `None` → refused when `run/core.pid` exists (S11). `pyproject.toml`: name `plur1bus-memory-client`, version = harness version, `requires-python = ">=3.11,<3.14"`, no dependencies, setuptools backend.
- [ ] **Step 4: Run** the Python suite, `pnpm gen && git diff --exit-code` (generated files fresh), `cargo test -p plur1bus paths`, the module-api test, `node scripts/lint-hygiene.mjs` → PASS; Green.
- [ ] **Step 5: Commit** `feat(client-py): plur1bus-memory-client IPC core — paths, NDJSON JSON-RPC, POSIX transport with S11, generated schema module, offline conformance (D88, spec A.6)`.

---

### Task 3 (harness repo): Python client — Windows named-pipe transport

**Files:**
- Create: `clients/python/plur1bus-memory-client/src/plur1bus_memory_client/transport_win.py`, `tests/test_transport_win.py`, `tests/fakes_win.py` (fake pipe server via `ctypes` `CreateNamedPipeW` in a thread)
- Modify: `client.py` (select `transport_win.open_stream` on `win32`)

**Interfaces:**
- Consumes: Task 2 transport contract and `RpcError` codes.
- Produces: `transport_win.open_stream(address, *, connect_timeout)` satisfying Task 2's `Stream`; `peer_pid()` from `GetNamedPipeServerProcessId`. The module imports on POSIX without touching `ctypes.windll` (lazy binding).

- [ ] **Step 1: Write the failing tests** (Windows only, except the import test): `test_round_trip_over_a_named_pipe`; `test_squatted_pipe_with_another_server_pid_gets_no_token` (fake server's pid ≠ `run/core.pid` → `E_SERVER_IDENTITY`, fake log has no `core.auth`) — Review Focus 2; `test_read_deadline_cancels_the_pending_read` (server silent → `E_TIMEOUT` within `call_timeout + 0.25 s`, a later call on a new connection works); `test_busy_pipe_waits_up_to_connect_timeout` (single-instance server busy → waits, then `E_CORE_UNAVAILABLE`); `test_non_ascii_home_pipe_name` (fake serves the vector address for `C:\Users\Jürgen A\…`); `test_line_over_4_mib_from_server_is_refused`. Any OS: `test_transport_win_imports_without_windll`.
- [ ] **Step 2: Run** locally (import test) and in a dispatched `windows-2025` run of the client job (Task 6's job may be added early as a temporary `workflow_dispatch`) → FAIL.
- [ ] **Step 3: Implement** per HM2-R11 with `ctypes.WinDLL("kernel32", use_last_error=True)`; one `OVERLAPPED` + event per operation; `CancelIoEx` + `GetOverlappedResult(wait=True)` on timeout before closing the handle.
- [ ] **Step 4: Run** → PASS on `windows-2025` and `windows-11-arm`; quote the run URL; Green.
- [ ] **Step 5: Commit** `feat(client-py): Windows named-pipe transport with overlapped I/O, deadlines and server-pid check (HM2-R11, S11)`.

---

### Task 4 (harness repo): `plur1bus setup --profile host|full`

**Files:**
- Modify: `crates/plur1bus/src/cli.rs` (`SetupArgs.profile: Option<String>`, `value_parser = ["host", "full"]`, help "Install profile: host (supervisor and core only, for Hermes host mode) or full (default for a new home; an existing home keeps its profile)"), `crates/plur1bus/src/commands/setup.rs` (pass through), `crates/plur1bus/src/install/setup.rs` (`SetupOpts.profile`, steps), `crates/plur1bus/src/install/manifest.rs` (`InstallManifest.profile: Option<String>`, serde default), `crates/plur1bus/schema/install-manifest.schema.json` (`profile` enum, optional), `crates/plur1bus/src/commands/firstaid*.rs` (only if a check row assumes bundled modules or skills), `docs/cli.md` (regenerated)
- Create: `crates/plur1bus/tests/setup_profile.rs`

**Interfaces:**
- Consumes: existing `run_steps`, `STEP_IDS`, `StepResult::skipped`, `answer_config`, the `PLUR1BUS_SERVICE_FAKE` seam, `--core-from`.
- Produces: `setup --profile host` (HM2-R9); `setup/1` document unchanged in shape, `manifest.profile` set; step reason `profile-host`; failure reason `profile-change-unsupported` (added to the frozen reason vocabulary, HB16) with hint "host → full arrives with HM4". `pub fn effective_profile(requested: Option<&str>, recorded: Option<&InstallManifest>) -> Result<&'static str, StepError>`.

- [ ] **Step 1: Write the failing tests** (`setup_profile.rs`, temp home, fake service manager, `--core-from` the fixture core, `--non-interactive`): `host_profile_installs_supervisor_and_core_only` (`modules.bundled` and `skills` skipped with `profile-host`; `manifest.profile == "host"`; `config.json` has no `agents` entry); `host_profile_with_agent_creates_that_agent`; `rerun_without_profile_keeps_the_recorded_profile`; `a_profile_change_is_refused_and_changes_nothing` (host→full and full→host; tree digest of the home equal before/after; reason `profile-change-unsupported`); `manifest_without_profile_reads_as_full`; `firstaid_check_passes_on_a_host_profile` (setup exit 0, `check.fail == 0`). Unit: `effective_profile` table; CLI parse `--profile host`, invalid value refused.
- [ ] **Step 2: Run** `cargo test -p plur1bus --test setup_profile` → FAIL.
- [ ] **Step 3: Implement.** `effective_profile` runs in `step_state_root` before any write. `pnpm docs:gen` for `docs/cli.md`.
- [ ] **Step 4: Run** → PASS; Green (incl. `pnpm docs:check`).
- [ ] **Step 5: Commit** `feat(setup): --profile host installs supervisor and core only; profile recorded in the install manifest (D88, spec A.6, HM2-R9)`.

---

### Task 5 (harness repo): Directory provider `hosts/hermes/plur1bus/` and `cli.py`

**Files:**
- Create: `hosts/hermes/plur1bus/{__init__.py,binding.py,mapping.py,journal.py,config_schema.py,cli.py,plugin.yaml,README.md}`, `hosts/hermes/tests/{__init__.py,stubs/agent/__init__.py,stubs/agent/memory_provider.py,test_provider.py,test_mapping.py,test_journal.py,test_binding.py,test_cli.py,fake_client.py}`

**Interfaces:**
- Consumes: Task 1 facts (kwargs, CLI discovery, config commands); Task 2/3 `MemoryClient`, `Caller`, `RpcError`, `default_home`. The stub `agent/memory_provider.py` reproduces exactly the verified ABC signatures, `spawn_context_thread`, `is_trivial_prompt` (copied behaviour, cited to `agent/memory_provider.py` @ `743ee72`); tests put `hosts/hermes/tests/stubs` and `clients/python/plur1bus-memory-client/src` on `sys.path` (the vendored copy exists only in the build, HM2-R4).
- Produces:
  ```python
  # binding.py — HM2-R8
  BINDING_SCHEMA = "plur1bus.hermes-binding/1"; BINDING_FILE = "plur1bus.json"; REGISTRY_SCHEMA = "plur1bus.hermes-bindings/1"
  @dataclass(frozen=True)
  class Binding: home: str; agent_id: str; bin: str | None = None; recall_hard_ms: int = 600; capture: bool = True
  def read_binding(hermes_home: str) -> Binding | None
  def write_binding(hermes_home: str, b: Binding) -> None                 # atomic, 0600
  def agent_id_for(hermes_home: str, profile: str) -> str
  def register_binding(plur1bus_home: str, agent_id: str, hermes_home: str) -> None   # raises BindingConflict(agent_id, other_home)
  # mapping.py — HM2-R6, R14
  def caller_for(platform: str | None, user_id: str | None, chat_id: str | None) -> Caller
  def session_key_for(session_id: str, gateway_session_key: str | None) -> str        # ≤ 256
  def turn_messages(user: str, assistant: str, messages: list | None) -> list[dict]   # user+assistant only, ≤ 64, whole request ≤ MAX_LINE - 64 KiB, "[truncated]" marker
  SYSTEM_PROMPT_BLOCK: str
  TOOL_METHODS: dict[str, str]  # plur1bus_memory_list|show|forget|correct|share -> memory.*
  # journal.py — HM2-R13
  class CaptureJournal:
      def __init__(self, dir: str, *, max_entries: int = 1000, max_bytes: int = 4 * 1024 * 1024) -> None
      def append(self, entry: dict) -> None ; def drain(self, send: Callable[[dict], None]) -> int ; def counts(self) -> dict  # {"queued", "dropped"}
  # __init__.py
  class Plur1busMemoryProvider(MemoryProvider):   # name == "plur1bus"; client_factory seam for tests
  def register(ctx) -> None                        # ctx.register_memory_provider(Plur1busMemoryProvider())
  # cli.py
  def register_cli(subparser) -> None              # hermes plur1bus status [--json] | selftest [--json] | bind [--json]
  ```
  Hook mapping: `initialize` → read binding (absent → provider inert, one warning), caller and session key, `agent_open` if advertised (failure ignored); `prefetch` (HM2-R14); `sync_turn` → `spawn_context_thread` running `capture(wait=False)`, skipped when `agent_context in {"cron", "subagent"}` or `binding.capture` is false, journal on failure then `drain` after the next success; `on_pre_compress` (HM2-R15); `get_tool_schemas`/`handle_tool_call` → only advertised methods, result JSON as the tool's string, `E_*` as `{"error": code}`; `on_session_end` → join the last sync thread (≤ 2 s), `checkpoint(reason="session-end")` and `agent_close` when advertised; `shutdown` → close the client; `get_config_schema()` → `[]`, `save_config` no-op (the installer writes the binding). `plugin.yaml`: `name: plur1bus`, `version: <harness version>`, description, `hooks: [on_session_end, on_pre_compress]`, no dependency keys. `status` JSON (`plur1bus.hermes-status/1`): binding (home, agentId), `core` (reachable, rpc, contract, instanceId), journal counts, last error code. `selftest` (`plur1bus.hermes-selftest/1`): `connect`, `core.status`, `agent.status` (if advertised), one `memory.recall` of `"plur1bus selftest"` — read-only; exit 0/1. `bind`: derive `agentId`, run `<bin> --home <home> --json agent create <id>` (already exists → ok), `register_binding`, `write_binding`.

- [ ] **Step 1: Write the failing tests.** `test_provider.py`: `test_is_available_checks_files_only_and_never_opens_the_pipe` (factory never called); `test_initialize_uses_the_binding_agent_and_maps_the_caller` (telegram/42 → `hermes:telegram`/`42`; cli without ids → `hermes:cli`/`local`); `test_prefetch_returns_the_joined_text_within_the_deadline`; `test_prefetch_returns_empty_and_warns_once_when_the_core_is_down` (two prefetches, one warning) — Review Focus 1; `test_trivial_prompt_skips_recall`; `test_sync_turn_is_non_blocking_and_uses_spawn_context_thread` (returns before a fake 2 s capture finishes; the stub records the spawn); `test_sync_turn_is_skipped_for_cron_and_subagent`; `test_failed_capture_is_journaled_and_replayed_on_the_next_success` (order preserved) — Review Focus 1; `test_oversized_turn_is_trimmed_to_fit_one_rpc_line` (5 MiB assistant text → encoded request ≤ 4 MiB, marker present); `test_on_pre_compress_checkpoints_only_when_advertised`; `test_tools_are_offered_only_for_advertised_methods`; `test_forget_tool_calls_memory_forget_with_the_bound_agent`; `test_on_session_end_flushes_checkpoints_and_closes`; `test_two_profiles_in_parallel_threads_capture_into_their_own_agents` (two providers, two `hermes_home`s, interleaved threads; fake records agentId per capture) — Review Focus 4; `test_agent_unknown_degrades_with_the_bind_hint`; `test_nothing_logs_the_token_or_message_text` (captured log records and journal file lack the test token and the message text; journal stores text only in its own 0600 file, asserted mode on POSIX). `test_binding.py`: `test_agent_id_folding_and_custom_home_hash` (`default`, `work`, `Work.v2` → `hermes-work-v2`, 70-char profile truncated to 64, `custom` hash from realpath) — Review Focus 4; `test_profile_case_collision_is_refused` (`Work` then `work` → `BindingConflict` naming both homes); `test_binding_written_atomically_0600`. `test_journal.py`: bounds and counted drops, `drain` stops at first failure. `test_cli.py`: `test_status_json_reports_binding_core_and_journal`, `test_selftest_is_read_only` (fake sees no capture/forget/correct/share), `test_bind_runs_plur1bus_agent_create_with_the_folded_id` (subprocess shim), `test_plugin_yaml_declares_no_python_dependencies`.
- [ ] **Step 2: Run** `python3 -m unittest discover -s hosts/hermes/tests -t hosts/hermes` → FAIL.
- [ ] **Step 3: Implement.** Logging through `logging.getLogger("plur1bus")`; log lines carry codes and counts, never text or token.
- [ ] **Step 4: Run** → PASS; Green.
- [ ] **Step 5: Commit** `feat(hermes): plur1bus directory memory provider — recall/capture over the core RPC, capture journal, D21 tools, hermes plur1bus status|selftest|bind (D88, spec A.6)`.

---

### Task 6 (harness repo): Live RPC conformance run, real Hermes turn, CI on three OSes

**Files:**
- Create: `clients/python/plur1bus-memory-client/tests/live/{__init__,test_conformance_live}.py`, `hosts/hermes/tests/e2e/{__init__,assert_disposable,stub_model_server,drive_turn,test_provider_live}.py`, `.github/workflows/hermes-host.yml`
- Modify: `.github/workflows/ci.yml` (job `python-host`)

**Interfaces:**
- Consumes: Tasks 2–5; Task 4 `setup --profile host`; Task 1 facts (i) (stub model config), install method; `tests/system/helpers.ts`'s way of starting a flat-embedder stack (the live tests start `plur1bus --home <tmp> daemon start` with `PLUR1BUS_CORE_JS`, `PLUR1BUS_ALLOW_TEST_INTERNALS=1`, the flat-embedder seam and `engine.duplicateThreshold = 1.01`; `agent create hermes-default`). Env: `PLUR1BUS_BIN`, `PLUR1BUS_CORE_JS`; skipped with a printed reason when unset.
- Produces: job `python-host` in `ci.yml` (matrix `ubuntu-24.04` × Python 3.11/3.13, `macos-15`, `windows-2025`, `windows-11-arm` informational): hash-pinned dev requirements, offline suites of Tasks 2, 3, 5, then build `plur1bus` + core and run the live suites. Workflow `hermes-host.yml` (`pull_request` on `clients/**`, `hosts/**`, `crates/plur1bus/src/install/**`; nightly `cron '41 3 * * *'`; `workflow_dispatch`; `permissions: contents: read`; actions pinned by SHA; `persist-credentials: false`): job `real-hermes` (matrix `ubuntu-24.04`, `macos-15`, `windows-2025`): build the harness, `plur1bus setup --profile host --non-interactive --no-service --core-from <built payload>` under `$RUNNER_TEMP/p1b`, `daemon start`, install Hermes per Task 1 into `$RUNNER_TEMP`, `assert_disposable.py`, copy `hosts/hermes/plur1bus` plus the client into `$HERMES_HOME/plugins/plur1bus/_vendor/…` (Task 7's build script once it exists; a copy step before), write the binding with `bind`, `hermes config set memory.provider plur1bus`, start `stub_model_server.py`, `drive_turn.py` runs one turn saying a synthetic fact, then a second turn; asserts the sidecar received a capture (`plur1bus memory list --agent hermes-default --json` non-empty) and the second turn's request to the stub model contains the recalled fact. Windows leg `continue-on-error` until first green, then required (T9-b pattern).

- [ ] **Step 1: Write the failing tests.** `test_conformance_live.py`: `test_every_client_method_round_trips_and_validates_against_the_schema` (each method once against the real core; results validated with `jsonschema`; experimental ones only if advertised); `test_capture_then_recall_finds_the_memory`; `test_core_restart_mid_session_recovers` (`daemon restart` → next recall ok, token differs) — Review Focus 1; `test_unregistered_agent_is_E_AGENT_UNKNOWN`. `test_provider_live.py` (stub ABC, real core): `test_sync_turn_then_prefetch_recalls_it`, `test_daemon_stop_degrades_and_journal_replays_after_start`. `assert_disposable.py`: `refuses a HERMES_HOME outside RUNNER_TEMP or the temp dir` (unit test in the same file's `__main__` guard is not enough — a `test_assert_disposable.py` beside it).
- [ ] **Step 2: Run** locally with a built stack (`cargo build --release -p plur1bus && pnpm build`) → FAIL before wiring, PASS after.
- [ ] **Step 3: Write** both workflow changes; validate with `actionlint` if available, else a YAML parse plus a SHA-pin check in `hosts/hermes/tests/test_workflows.py`.
- [ ] **Step 4: Dispatch** `hermes-host.yml` and the CI run on the branch. Required: `python-host` green on `ubuntu-24.04`, `macos-15`, `windows-2025`; `real-hermes` green on `ubuntu-24.04` and `macos-15`. Quote run URLs and the Windows result.
- [ ] **Step 5: Commit** `ci(hermes): live RPC conformance of the Python client and one real Hermes turn through the host-mode sidecar on three OSes (D88, milestone HM2)`.

---

### Task 7 (harness repo): Provider tarball, wheel and sdist, release job

**Files:**
- Create: `scripts/build-hermes-provider.mjs`, `scripts/build-hermes-provider.test.mjs`
- Modify: `.github/workflows/harness-release.yml` (job `hermes-artefacts`; its outputs join `SHA256SUMS` and the attestation step), `clients/python/plur1bus-memory-client/pyproject.toml` (version sourced from the harness version by the build script's check), `package.json` (script `build:hermes`), `scripts/lint-hygiene.mjs` only if the new script needs no allow-list (it must not)

**Interfaces:**
- Consumes: Task 5 provider dir, Task 2 client sources.
- Produces: `node scripts/build-hermes-provider.mjs --out <dir>` → `plur1bus-hermes-provider-<v>.tar.gz` (HM2-R21) containing `plur1bus/**` + `plur1bus/_vendor/plur1bus_memory_client/**` + `plur1bus/MANIFEST.json` (`{ schema: "plur1bus.hermes-provider/1", version, files: { "<path>": "<sha256>" } }`); prints its SHA-256. Release job builds the tarball and, with the pinned dev requirements, `python -m build` → `plur1bus_memory_client-<v>-py3-none-any.whl` and `plur1bus_memory_client-<v>.tar.gz`; all three in `SHA256SUMS` and attested; nothing is uploaded to PyPI.

- [ ] **Step 1: Write the failing tests** (`node --test scripts/build-hermes-provider.test.mjs`): `two builds are byte-identical`; `the vendored client equals clients/python sources byte for byte`; `no __pycache__, tests, dotfiles or links in the tarball`; `MANIFEST.json hashes match every file`; `versions agree across Cargo.toml, pyproject.toml and plugin.yaml`; `harness-release.yml parses, pins every action by SHA and lists the three new files in SHA256SUMS`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** a minimal ustar writer over `node:zlib`; the release job on `ubuntu-24.04`.
- [ ] **Step 4: Run** → PASS; Green; replace Task 6's copy step with the build script and re-run `hermes-host.yml` once (quote URL).
- [ ] **Step 5: Commit** `feat(release): Hermes provider tarball with vendored client, client wheel and sdist in the harness release (HM2-R4, R21, spec A.5)`.

---

### Task 8 (plugin repo): Feed `hosts.hermes` and installer `--host hermes` — detect, compat, sidecar, bind, provider, verify, rollback

**Files:**
- Create: `scripts/dist/hermes-sidecar.lock.json` (`{ harnessTag, version, provider: { url, sha256 }, binary: { "<target>": { url, sha256 } }, minHermesVersion: "0.21.4", testedHermesVersion }`), `scripts/dist/installer/untar.mjs`, `scripts/dist/installer/hermes/{detect,hermes-cli,sidecar,plur1bus-cli,provider,binding,install}.mjs`, `tests/helpers/hermes-sandbox.js`, `tests/fixtures/hermes-cli/*` (copied from harness Task 1 fixtures, same redaction), `tests/dist-hermes-install.test.js`, `tests/dist-hermes-feed.test.js`, `tests/dist-hermes-untar.test.js`
- Modify: `scripts/dist/plugin-feed.schema.json` (replace `"hermes": false` with the object below), `scripts/dist/build-plugin-feed.mjs` (`--hermes-lock <json> --hermes-notes-de <md> --hermes-notes-en <md>`), `scripts/dist/installer/main.mjs` (dispatch `--host hermes` to `runHermesInstall`; remove the HM1-R16 refusal; new flags below)

**Interfaces:**
- Consumes: HM1 `createReport`, `EXIT`, `Stop`, `resolveLicence`, `readState`/`writeState` pattern, `writeFileAtomic`, `renameWithRetry`, `keepArtefact`; Task 1 facts; Task 4 flags; Task 5 binding format and `hermes plur1bus selftest --json`; Task 7 tarball format.
- Produces:
  Feed `hosts.hermes` (closed): `{ windowsNativeBeta: boolean, latest, releases: [{ version, provider: { url, sha256 }, sidecar: { version, binary: { "linux-x64"|"linux-arm64"|"darwin-arm64"|"win-x64"|"win-arm64": { url, sha256 } } }, minHermesVersion, testedHermesVersion, python: ">=3.11,<3.14", security: boolean, notes: { de, en } }] }` — all five targets required; `latest` equals `releases[0].version`.
  ```js
  // untar.mjs — HM2-R21
  export async function extractTarGz({ file, dest, maxBytes = 64 << 20 });   // → { files: string[] }; throws UntarError("unsafe-entry"|"duplicate"|"too-large"|"corrupt")
  // hermes/detect.mjs — port of harness sources/hermes.ts defaultHermesHome/resolveHermesRoot, same case table
  export function resolveHermesHome({ env, platform, homedir });              // → { root, home, profile: string|null, resolvedFrom }
  export async function detectHermes({ env, platform, run, which });          // → { bin, version, root, home, profile, identity: "default"|<profile>|"custom" } | null
  // hermes/hermes-cli.mjs — the ONLY place that builds hermes argv; deadlines; no shell
  export const ALLOWED_HERMES_CONFIG_KEYS = ["memory.provider"];
  export function createHermesCli({ bin, env, run, timeoutMs = 120_000 });   // .version() .configGet(key) .configSet(key, value) .memoryStatus() .selftest() .bind()
  // hermes/sidecar.mjs — HM2-R10, R17
  export function sidecarBinPath({ platform, env, homedir });                // ~/.local/bin/plur1bus | %LOCALAPPDATA%\PLUR1BUS\bin\plur1bus.exe
  export function plur1busHome({ platform, env, homedir });                  // $PLUR1BUS_HOME | ~/.plur1bus | %LOCALAPPDATA%\PLUR1BUS
  export function readSidecar({ home });                                     // → { profile: "host"|"full", binaryVersion } | null  (from <home>/manifest.json)
  export async function installSidecar({ release, target, bin, fetchImpl, keep });   // verified download, atomic rename; keeps the previous binary for rollback → { fresh, previousBin|null }
  // hermes/plur1bus-cli.mjs
  export function createPlur1busCli({ bin, home, env, run });                // .setup({ useClass, acceptNc, noService }) .agentCreate(id) .agentList() .daemonStop() .serviceUninstall() .memoryCount(agentId)
  // hermes/provider.mjs
  export async function installProvider({ hermesHome, tarball, sha256, now }); // stage plugins/plur1bus.tmp-<pid> → move existing to plugins/.plur1bus-prev-<ts> → rename → { dir, previousDir|null }
  export async function restoreProvider({ hermesHome, previousDir });
  // hermes/binding.mjs — same rules as harness binding.py (HM2-R8), same test table
  export function agentIdFor({ hermesHome, profile }); export function writeBinding(hermesHome, b); export function registerBinding(plur1busHome, agentId, hermesHome);
  // hermes/install.mjs
  export async function runHermesInstall(ctx);   // ctx = { flags, env, platform, run, fetchImpl, prompt, isTTY, report, feed, release }
  ```
  New flags: `--hermes-profile <name>`, `--replace-provider`, `--hermes-home <dir>` (overrides detection). State file `$HERMES_HOME/.plur1bus-installer.json` (0600; `previousProvider`, `sidecarFresh`, `previousBin`, `providerPrev`, `inProgress?`). Order: detect (none → exit 3 `hermes-not-found`) → compat, all fatal findings together, exit 3: target, Hermes version ≥ `minHermesVersion`, free disk, `harness-present` (HM2-R10), existing provider ≠ `plur1bus` without `--replace-provider`/interactive yes → exit 2 `provider-in-use` naming it → licence (HM2-R18) → sidecar (skip when a host sidecar has version ≥ release) → `setup` → `agentCreate` + `registerBinding` → provider → `writeBinding` → `configSet memory.provider plur1bus` → verify (`memoryStatus` names `plur1bus`; `selftest` ok; installer's own `connect` check not needed) → on failure: `configSet` previous value, `restoreProvider`, remove binding, and if `sidecarFresh`: `daemonStop`, `serviceUninstall`, remove the binary and the home (only a home this run created); exit 1 (4 if a rollback step fails, manual steps printed). On win32 while `windowsNativeBeta` → one beta line (Q7).

- [ ] **Step 1: Write the failing tests** (`hermes-sandbox.js`: temp homes; `hermes` and `plur1bus` shims logging argv and replaying fixtures; a local file:// feed + tarball + binary under the test flag). `dist-hermes-install.test.js`: `fresh install runs detect, setup --profile host, agent create, provider, config set and selftest in order`; `an existing other provider needs --replace-provider and is restored on rollback` — Review Focus 5; `non-interactive with another provider exits 2 provider-in-use and changes nothing`; `a full harness home exits 3 harness-present and changes nothing`; `an existing host sidecar is reused and not reinstalled`; `a binary or tarball hash mismatch installs nothing`; `a failed selftest restores the provider value, removes the provider dir and a fresh sidecar's service, binary and home`; `a killed install is completed or rolled back by the next run` (shim exits 137 at `config set`; second run finishes or `--rollback` restores; no `plur1bus.tmp-*`) — Review Focus 5; `--hermes-profile work binds hermes-work`; `Work and work collide and are refused` — Review Focus 4; `a custom HERMES_HOME binds hermes-custom-<hash8>`; `hermes home resolution follows the harness table` (linux/darwin/win32, `HERMES_HOME` with `~`, `%VAR%`, `…/profiles/<n>`, missing `LOCALAPPDATA`); `a non-ASCII Hermes and PLUR1BUS home install and verify` — Review Focus 3; `non-interactive licence passes no --accept-nc-licence; --accept-nc-licence passes it`; `hermes config set is never called with another key`; `the installer never reads .env or config.yaml`; `unsupported targets exit 3 before any change`; `--json prints one plur1bus.plugin-installer/1 document with host hermes`. `dist-hermes-feed.test.js`: `builds hosts.hermes from the lock file and notes`, `rejects a Hermes release missing a target`, `the schema no longer forbids hosts.hermes`. `dist-hermes-untar.test.js`: `extracts the Task 7 fixture tarball`, `refuses symlinks, absolute paths, .. and case-fold duplicates`, `refuses more than maxBytes`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** Download goes through HM1's verified download helper with the size cap; the bin paths cite harness `scripts/install/install.sh` (`$HOME/.local/bin`) and `install.ps1` (`%LOCALAPPDATA%\PLUR1BUS\bin`).
- [ ] **Step 4: Run** → PASS; `npm run build:installer` (bundle still imports only `node:` builtins); Green.
- [ ] **Step 5: Commit** `feat(dist): install-plugin --host hermes — Hermes detection, pinned sidecar with setup --profile host, agent binding, provider install, verification and rollback (D87, D88, spec A.3, A.6)`.

---

### Task 9 (plugin repo): Installer Hermes update and uninstall/purge

**Files:**
- Create: `scripts/dist/installer/hermes/{update,uninstall}.mjs`, `tests/dist-hermes-update.test.js`, `tests/dist-hermes-uninstall.test.js`
- Modify: `scripts/dist/installer/main.mjs` (Hermes mode switch), `lib/snapshot/store-snapshot.js` (optional `snapshotsDir`; default unchanged), `tests/snapshot-store.test.js`

**Interfaces:**
- Consumes: Task 8 modules and state file; HM1 `createSnapshot`/`restoreSnapshot`/`verifySnapshot`, the D78 notes-first and *Now/Later/Skip* flow, HM1-R-F2 (restore only when the live store differs from the pre-update manifest).
- Produces: `runHermesUpdate(ctx)`, `runHermesUninstall(ctx)`. Update: installed version from the binding (`version`) and `readSidecar`; up to date → exit 0; notes first; *Now/Later/Skip* (`--yes` = Now; no TTY without `--yes` → exit 2); provider-only update when the sidecar version is unchanged (stage/rename, previous dir kept); otherwise `daemonStop` → `createSnapshot({ stateDir: <plur1bus home>, baseDbPath: <home>/state/lancedb, snapshotsDir: <home>/backups/host-update, label: "pre-<v>" })` → `installSidecar` (previous binary kept) → `setup --profile host --non-interactive` → provider → verify → on failure: previous binary back, `setup` with it, `restoreProvider`, store restored per HM1-R-F2; exit 1/4. Uninstall: `configSet memory.provider <previousProvider or "">`, provider dir moved to `plugins/.plur1bus-removed-<ts>` then deleted, binding removed, registry entry removed; agent, store and sidecar kept. `--purge` additionally: only when `readSidecar().profile === "host"` **and** every agent in `agentList()` starts with `hermes-`: `daemonStop`, `serviceUninstall`, delete the binary and the home after two interactive confirmations or `--yes-delete-memories` (non-interactive without it → exit 2); otherwise keep the home and print why.

- [ ] **Step 1: Write the failing tests.** Update: `update shows notes first and Skip changes nothing`; `a provider-only update swaps the provider and keeps the sidecar`; `a sidecar update stops the daemon, snapshots, installs and verifies`; `a failed verify restores provider, binary and the store` (store digest equal); `no TTY and no --yes exits 2`. Uninstall: `uninstall restores the previous memory.provider and keeps the store and sidecar` — Review Focus 5; `purge refuses a home with non-hermes agents`; `purge refuses a full-profile home`; `purge without --yes-delete-memories is refused non-interactively`. Snapshot: `snapshotsDir writes and lists under the given dir`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; `npm run build:installer`; Green.
- [ ] **Step 5: Commit** `feat(dist): Hermes host-mode update with store snapshot and binary rollback, uninstall and guarded purge (D87, D89)`.

---

### Task 10 (plugin repo): Bootstraps `--host hermes`

**Files:**
- Create: `scripts/dist/node-pins.json` (`{ version: "24.21.0", targets: { "<target>": { url, sha256, archive: "tar.gz"|"zip" } } }`, values from `https://nodejs.org/dist/v24.21.0/SHASUMS256.txt`), `tests/dist-node-pins.test.js`
- Modify: `scripts/dist/install-plugin.sh.in`, `scripts/dist/install-plugin.ps1.in` (host-aware detection, Node chain, WSL probe of `hermes`), `scripts/dist/render-bootstraps.mjs` (`--node-pins <json>` → `@@NODE_PINS@@`; refuse without), `tests/dist-bootstrap-sh.test.js`, `tests/dist-bootstrap-ps1.test.js`

**Interfaces:**
- Consumes: Task 1 fact (h) (Hermes' Node paths), Task 8 flags, HM1 bootstrap flow and its test harness.
- Produces: with `--host hermes` (`-Host hermes`): find `hermes` (`command -v hermes`; `Get-Command hermes.exe,hermes.cmd,hermes`) else exit 3 `hermes-not-found`; Node chain per HM2-R16; everything else (feed signature, installer hash, handover) exactly as HM1. The `.ps1` WSL probe runs `command -v hermes` for `--host hermes` (`openclaw` otherwise) and delegates as HM1. Env `PLUR1BUS_PLUGIN_TEST_NODE_BASE` (test flag only) replaces the nodejs.org base with a `file://` dir.

- [ ] **Step 1: Write the failing tests.** sh (skip on win32): `--host hermes without hermes exits 3 hermes-not-found`; `uses Hermes' own Node when in range`; `falls back to the pinned Node download and verifies its sha256`; `a Node archive hash mismatch exits 1 and runs nothing`; `a cached Node archive is re-hashed before reuse`; `host openclaw behaviour is unchanged` (existing cases stay green). ps1 (win32): the same, plus `the WSL probe looks for hermes with --host hermes`, `the rendered ps1 is ASCII-only`. Render: `refuses to render without node pins`. `dist-node-pins.test.js`: `five targets, version equals 24.21.0, sha256 format`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** POSIX extraction with `tar -xzf` into a staging dir then rename; Windows with `System.IO.Compression.ZipFile` (.NET, PS 5.1 compatible).
- [ ] **Step 4: Run** → PASS on Linux; dispatch the ps1 tests on `windows-2025` and quote the URL; Green.
- [ ] **Step 5: Commit** `feat(dist): bootstraps for --host hermes — Hermes detection, WSL probe, pinned Node fallback for Node-less hosts (HM2-R16)`.

---

### Task 11 (plugin repo): `plugin-dist.yml` Hermes legs

**Files:**
- Modify: `.github/workflows/plugin-dist.yml` (jobs `hermes`, `hermes-wsl`, `node-pins`), `tests/helpers/sign-feed-for-ci.mjs` (include `hosts.hermes` from the lock)

**Interfaces:**
- Consumes: Tasks 8–10; `scripts/dist/hermes-sidecar.lock.json` (P4 artefacts); Task 1 install method and stub-model config; HM1 `assert-disposable.mjs`.
- Produces: `hermes` (matrix `ubuntu-24.04`, `macos-15`, `windows-2025`; `continue-on-error: ${{ !vars.HM2_SIDECAR_RELEASED }}` until P4, HM2-R19): install Hermes `min` and `latest` into `$RUNNER_TEMP`; `assert-disposable`; bootstrap with `--host hermes --non-interactive --json` against the CI-signed `file://` feed (`PLUR1BUS_PLUGIN_INSTALLER_TEST=1`, `PLUR1BUS_PLUGIN_TEST_NO_SERVICE=1`) → exit 0; `hermes memory status` names `plur1bus`; `hermes plur1bus selftest --json` → `ok`; re-run → `up-to-date`; `--uninstall --json` → `memory.provider` back to its previous value, store present. `hermes-wsl` (`windows-2025`, non-blocking, C8): Ubuntu 24.04 via `Vampire/setup-wsl` (SHA-pinned), Hermes inside, `install-plugin.ps1 -Host hermes -Target wsl:Ubuntu-24.04 …` → exit 0, selftest inside the distro. `node-pins`: fetch `SHASUMS256.txt` for the pinned version and compare with `node-pins.json`.

- [ ] **Step 1: Extend** `tests/dist-ci-helpers.test.js`: `plugin-dist.yml parses, pins every action by SHA, and every Hermes leg sets PLUR1BUS_PLUGIN_TEST_NO_SERVICE`.
- [ ] **Step 2: Run** → FAIL; write the jobs; run → PASS.
- [ ] **Step 3: Dispatch** on the branch; report each leg's result (green or not, with the P4 state) and the run URL.
- [ ] **Step 4: Commit** `ci(dist): Hermes install legs on three OSes and a WSL leg against disposable Hermes instances; node pin check (milestone HM2)`.

---

### Task 12 (plugin repo): Release — feed with `hosts.hermes`, docs, 7.18.0

**Files:**
- Create: `docs/release-notes/7.18.0.{de,en}.md`
- Modify: `.github/workflows/plugin-release.yml` (pass `--hermes-lock`, `--node-pins` to builder and renderer), `docs/distribution.md` (Hermes section), `README.md` (Hermes one-liners), `CHANGELOG.md`, `AGENTS.md` (new tests, shims, `PLUR1BUS_PLUGIN_TEST_NO_SERVICE`, `PLUR1BUS_PLUGIN_TEST_NODE_BASE`), `package.json`, `openclaw.plugin.json`, `package-lock.json` (7.18.0)

- [ ] **Step 1: Extend** `tests/dist-release.test.js`: `the release workflow passes the hermes lock and node pins`, `7.18.0 notes exist in de and en`, versions agree.
- [ ] **Step 2: Run** → FAIL; bump, write notes (D78 headings, ≤ 1 500 characters) and docs (targets; what `--host hermes` does step by step; flags and exit codes; the Node chain and why; update, rollback, uninstall, purge rules; the sidecar and its home; privacy: what the provider sends to the local core, the journal file); run → PASS; Green.
- [ ] **Step 3: Commit** `docs(dist): Hermes host-mode installation, release notes; 7.18.0 (D87, D88)`.

---

### Task 13 (harness repo): Docs, milestones, release checklist, spec status

**Files:**
- Create: `docs/hermes-host-mode.md`
- Modify: `docs/host-adapters.md` (Hermes row: "HM2: directory provider over the 2a RPC", evidence verified 2026-09-29), `docs/milestones.md` (row HM2: plan link, 12.5 ad vs 8–12, Q1), `docs/manual-release.md` (the plugin feed's `hosts.hermes` comes from `hermes-sidecar.lock.json` after a harness release; bump the lock, then the plugin release), `AGENTS.md` (`clients/python`, `hosts/hermes`, how to run their tests, `hermes-host.yml`), `docs/superpowers/specs/2026-09-28-plugin-distribution-and-migration-design.md` (status line: "HM2 plan runs on C1–C4, C6, C8, C11, C12 defaults; F12's stability note corrected by HM2-R5")

- [ ] **Step 1: Write `docs/hermes-host-mode.md`:** architecture (provider, client, sidecar), hook → RPC table as implemented (HM2-R5, R14, R15), identity mapping (HM2-R6) and its limits (Q4), binding file and agent naming, degrade and journal rules, `hermes plur1bus status|selftest|bind`, files written, how to run the tests locally.
- [ ] **Step 2: Run** `node scripts/lint-hygiene.mjs` and `pnpm docs:check`.
- [ ] **Step 3: Commit** `docs: Hermes host mode guide, host-adapter row, HM2 milestone and release checklist (D88)`.

---

## Self-review (done while writing)

- **Spec coverage.** A.1 Hermes rows (native POSIX, native Windows, WSL delegation) → Tasks 8, 10, 11. A.3 steps for Hermes: detect incl. WSL → Tasks 8, 10; compat → Task 8; install → Task 8 (HM2-R17); licence → HM2-R18; verify → Task 8; update → Task 9; uninstall/purge → Task 9; report/exit codes → Global Constraints. A.4 Hermes row (`hermes memory status`, `is_available`, sidecar answers, round trip) → Tasks 5, 6, 8. A.5 (feed, SHA256SUMS, attestations, sidecar unchanged) → Tasks 7, 8, 12. A.6: provider shape → Task 5; `plugin.yaml`/`cli.py` → Task 5; client kit with socket + pipe → Tasks 2, 3; hook table → Task 5 (amended by HM2-R5/R14/R15); AgentId folding and collision → HM2-R8; `setup --profile host` → Task 4; Windows native → Tasks 3, 6, 11; install path (a) → Task 8; (b) catalogue → out (C4/HM4). A.7 HM2 part → HM2-R10. A.9 → HM2-R18. Milestone row HM2: client, provider, profile, installer on four platforms, conformance run, CI on three OSes → Tasks 2–6, 8–11.
- **Hard rules.** No secrets: Global Constraints + Task 1 Step 3 + Task 5 `test_nothing_logs_the_token_or_message_text`. No real service manager/Hermes/home: fake manager (Task 4), `--no-service` (Tasks 6, 11), shims + sandbox (Tasks 8–10), disposable-runner guards (Tasks 6, 11). No remote hosting: HM2-R4, Q2, owner steps only.
- **Type consistency.** `MemoryClient`, `Caller`, `RpcError` codes (Task 2) are what Tasks 3, 5, 6 use; the `Stream` contract is shared by Tasks 2 and 3; binding fields and `agentIdFor`/`agent_id_for` rules are the same in Tasks 5 and 8 (one table, tested in both); `plur1bus.hermes-selftest/1` in Tasks 5, 8, 11; feed `hosts.hermes.releases[].sidecar.binary` in Tasks 8, 11, 12; profile values `host|full` and reason `profile-change-unsupported` in Tasks 4, 8.
- **Review Focus.** Each line names tests in its owning tasks (2/5/6, 2/3, 2/8, 5/8, 8/9).
- **Proportion.** Signatures, test names and fixed strings; no bodies except the fixed rules in HM2-R6/R8.

---

## Questions for the owner (the plan runs on each default)

| # | Question | Default |
|---|---|---|
| Q1 | The estimate is 12.5 ad against HM2's 8–12. Accept, or trim? | **Accept.** To reach 12: drop `--purge` of the sidecar (Task 9, −0.25) and the pinned-Node fallback on POSIX only (keep it for Windows, −0.25). |
| Q2 | Publish `plur1bus-memory-client` to PyPI (trusted publishing) and switch the provider to `python_dependencies`? | **No, not in HM2.** Vendored client (HM2-R4); wheel and sdist attached to the harness release. Revisit with the M3 client kits. |
| Q3 | Promote `agent.open`, `agent.close` and `memory.checkpoint` to `stable` in the next RPC minor? | **Not in HM2.** Capability-gated use (HM2-R5); promotion with 2b's MCP server, where the same methods get a second consumer. |
| Q4 | Hermes turns carry no group/private setting (D22) until E7 and an RPC minor; the engine does not filter by setting today either. Accept that for HM2? | **Accept**, documented in `docs/hermes-host-mode.md`; the setting lands with E7 together with M4's channels. Alternative: disable capture for gateway chats whose `chat_id` differs from `user_id` (cost: lost memories in groups). |
| Q5 | Advertise Hermes' fail-closed checkpoint API v2? | **No** (HM2-R15); v2 needs a durable transcript archive keyed by digest. |
| Q6 | Another memory provider is active: may the non-interactive installer replace it with `--replace-provider`? | **Yes, only with the flag** (exit 2 otherwise); the previous value is restored on rollback and uninstall. |
| Q7 | Label native-Windows Hermes host mode **beta** until the Windows legs are green for four weeks (C5's rule)? | **Yes** (feed `hosts.hermes.windowsNativeBeta: true`, flipped by re-signing the feed). |
| Q8 | Cut a harness pre-release after Tasks 4 and 7 so the plugin CI's Hermes legs can become blocking (P4)? | **Yes, on the `beta` channel**, signed offline as `docs/manual-release.md` describes. |
