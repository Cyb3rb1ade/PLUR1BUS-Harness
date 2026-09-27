# M1b-2a-H3b — Replay while serving, supervisor-owned config, modules, admin ops (2a-H3b-a) · setup, update, repair, skill, release (2a-H3b-b outline) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Scope note.** The 2a-H3b outline in plan 2a-H3a (ten tasks, H3b-1 to H3b-10) plus the 2a-H3a ledger's parked items are too much for one reviewable plan, so this plan is split the same way 2a-H3a was (ruling B1). **This document is 2a-H3b-a, written in full** (12 tasks): the engine pin E4.1, journal replay while serving, a launchd debt, supervisor ownership of `config.json`, the module system and admin ops over RPC. **2a-H3b-b** (the `setup` installer, `update --check`, `1staid repair` with the installer checks, the operations skill, release and exit) is an outline at the end. It gets its own full plan after 2a-H3b-a merges.

**Goal:** After a core restart, the core serves at once and replays its journal in the background. The supervisor becomes the only writer of `config.json`. It hands the core its configuration, applies `live` keys without a restart, restarts only the units a change names, and treats a valid hand edit like a `config set`. A module is a directory with a D14 manifest. The supervisor installs it, starts it in dependency order, watches it, restarts it with backoff, adopts it after its own restart, and shows it in `module list` and `module graph`, all without harness code edits. Admin operations of the engine are reachable over RPC and from the CLI.

**Architecture:** Replay moves out of `start()` into a background task that the core's shutdown signal aborts. The supervisor gains a config service with a revision, a watcher that polls the file, a bounded per-connection notifier for `config.changed`, and a restart-job queue that the main thread executes. The core loads its configuration through `config.watch` on the supervisor when it runs supervised, and falls back to the file otherwise. The supervisor's single core child becomes a list of slots. Modules are Node processes that `@plur1bus/module-api`'s `runModule()` turns into small servers (`run/module-<name>.sock`, methods `module.auth|status|adopt|shutdown`), so the core's lifeline and adoption machinery applies to them unchanged. The manifest schema lives in `packages/module-api/schema/` and is loaded by Rust and TypeScript alike.

**Tech Stack:** Unchanged from 2a-H3a: Node 24.21 (ESM, `--experimental-strip-types`), TypeScript 5.9 (`erasableSyntaxOnly`), `node:test`, ajv 8, esbuild, pnpm 10; Rust 1.95, clap 4, serde_json, typify 0.8, jsonschema 0.26, sha2 0.10, assert_cmd. **New Rust dependencies: none.** `jsonschema` moves from dev-dependency to dependency of `crates/plur1bus`; it is already compiled into the binary through `plur1bus-config`. New TypeScript dependency: `ajv` 8 (same version as `packages/rpc-schema`) and `@plur1bus/rpc-schema` in `packages/module-api`. Engine `@cyb3rb1ade/plur1bus-memory` pinned to `<E41_SHA>` (merge commit of engine PR #195, E4.1, contract still 1.8.0) in Task 1.

**Spec:** `docs/superpowers/specs/2026-09-24-m1b-2a-core-daemon-cli-design.md`. Binding: §4 (supervisor owns `config.json` and the module registry; the module manifest), §6.1 (one owner, `config.get|set|watch`, watcher, apply sequence), §6.2 (supervisor methods and notifications), §6.3 (lifecycle, amended by B2), §6.4 (spawn and monitor, backoff, lifeline and grace, locks, adoption, applied to modules), §6.6 rows `config`, `module`, `module graph`, §10 criteria 4, 5 and 12 (and 2, which must not regress), D3, D11, D14. Also binding: ADR-013 §4 and §5 (the target sequence this plan builds), ADR-016 §2, §3 and G3 (side-by-side `apiVersion`), ADR-012 §10 as shipped (flat `daemon.status/1`, RPC 1.2.0 `x-server`, `1staid check` ids, `CrashReason` vocabulary, rulings H3-R1 to H3-R26). Engine contract: `/home/claude/work/plur1bus-m1b1` `types/engine.d.ts` at `d0842424` (1.8.0): `AdminOps.obsidian`, `AdminOps.migrate`, `EmbeddingService.probe|serve`, `HostServices.mutateConfig`.

**Owner decisions (2026-09-27, in chat):** B2 confirmed: the core reports `ready` right after `listen()` and replays the journal in the background; a recall during replay may miss a journaled fact, and `journalReplay` makes that visible. B15 confirmed: admin operations live in a top-level `admin` CLI group. The remaining open points (defer agent-scoped modules and extension points to 2b; invalid `config.json` → no core start; module config under `modules.<name>`; non-persistent `module stop`; C2 Windows core pipe front-end) run as the plan's rulings unless the owner overrides them.

---

## Repository, branch, and how to run anything

**Work repo (`$HARNESS`):** `/home/claude/PLUR1BUS-Harness`. Cut branch **`feat/m1b-2a-h3b-a`** from `main` at **`b5712e7`** or later, with the `superpowers:using-git-worktrees` skill. Every path below is relative to that worktree.

**Engine reference tree (`$ENGINE`):** `/home/claude/work/plur1bus-m1b1`. Read it with `git -C $ENGINE show <sha>:<path>`. This plan never changes it.

**Node:** `export PATH=/home/claude/.node24/bin:$PATH` (`node -v` → `v24.21.0`).

**Green** means all of:

```bash
pnpm install --frozen-lockfile && pnpm gen && pnpm build && pnpm lint && pnpm test \
  && cargo fmt --all -- --check && cargo clippy --workspace --all-targets -- -D warnings \
  && cargo test --workspace --no-fail-fast && pnpm docs:check
```

**One TS test file:** `cd packages/<pkg> && node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning --test --test-concurrency=1 test/<file>.test.ts`. **One Rust test:** `cargo test -p <crate> --test <file> <name> -- --nocapture`. **System tests** (Linux/macOS): `cargo build --release -p plur1bus && pnpm build && PLUR1BUS_BIN=target/release/plur1bus node --experimental-strip-types --test tests/system/<file>.test.ts`. Every new system test file is added to the explicit list in `.github/workflows/ci.yml`'s system job.

Run `pnpm gen` after touching a schema, `pnpm build` after touching `rpc.schema.json` (a stale `packages/rpc-schema/dist` breaks spawned cores, 2a-H3a Task 14 note), and `pnpm docs:gen` after touching the RPC schema, the config schema or any clap text. Commit the regenerated `docs/*.md`.

---

## Global Constraints

Every task's requirements implicitly include this section.

- **Commits:** `git -c user.name=Cyb3rb1ade -c user.email=84099452+Cyb3rb1ade@users.noreply.github.com commit …`. Every message body ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01SxcLhve6hyM9AFm2nU9B3F`. Never `git stash`, never `--amend`, never push, never change git config (use `-c` only).
- **No secrets, no real user data** in code, fixtures, logs or test names. Tokens are generated at test time. Agent ids (`bernd`, `anna`), module names (`fixture`, `fixture-b`) and texts are synthetic. Every test uses its own temp home and never touches `~/.plur1bus` or a real service manager namespace.
- **CI green on Linux, macOS and Windows** (`.github/workflows/ci.yml`). The PR #2 Windows rules still apply: `fs.realpathSync` (never `.native`), `fileURLToPath`, `pnpm` through a shell, stop a core or module over RPC and never with `SIGTERM`, `replyAndClose` instead of `destroy()` after `write()`. POSIX-signal tests are `#[cfg(unix)]` or `{ skip: process.platform === "win32" }`.
- **Supervisor dependency budget** (spec §4, 2a-H3a S14): std threads plus the crates already in `crates/plur1bus/Cargo.toml`. No `notify`, no tokio, no async runtime. The config watcher polls. A supervisor panic still exits 70.
- **B1 stays < 100 ms p95:** manifest and config-schema validators are built lazily (`OnceLock`) inside the subcommands that use them. `pnpm bench` must not regress.
- **Engine pin exact:** full SHA in `packages/core/package.json`. The core imports only `…/engine/create-engine.js` and `…/types/engine.js`.
- **No OpenClaw idiom** (`scripts/lint-hygiene.mjs` stays green).
- **Closed params, closed error enum, projected results.** Every new method's `params` has `additionalProperties: false`. The Rust supervisor deserialises params into typify structs (`deny_unknown_fields` → `E_INVALID_PARAMS`). Every new result is validated against the schema in a test.
- **CLI `--json`:** the raw RPC value (R13) plus one top-level `"schema": "<command>/<major>"`. New ids: `module.list/1`, `module.start/1`, `module.stop/1`, `module.restart/1`, `module.graph/1`, `module.install/1`, `module.uninstall/1`, `admin.obsidian.detect/1`, `admin.obsidian.prepare/1`, `admin.obsidian.confirm/1`, `admin.migrate/1`, `admin.embedding.probe/1`, `admin.embedding.serve/1`. `config.get/1` and `config.set/1` keep their ids and gain fields only. Every new CLI command's `about` starts with `[experimental] `.
- **Versions:** RPC schema **`1.3.0`** (`$id` `https://plur1bus.dev/schema/rpc/1.3.0/rpc.schema.json`, `x-rpc-version`), bumped once, by Task 2. Everything new is `x-stability: "experimental"`, `x-since: "1.3.0"`. `SUPPORTED_RPC_MAJOR` stays 1. Config `schemaVersion` stays 1 (the `modules` namespace is additive). Module API version `"1"`.
- **`x-server`** is now `"core" | "supervisor" | "module"` on methods and `"core" | "supervisor"` on notifications. A method or notification without it is a schema bug.
- **Test seams** (honoured only with `PLUR1BUS_ALLOW_TEST_INTERNALS=1`): the existing ones, plus `PLUR1BUS_MODULE_API_CURRENT=<n>` (overrides the supervisor's current module API version, Task 7) and `FAKE_CORE_RESTART_PENDING=1` in `crates/plur1bus/tests/fixtures/fake-core.mjs` (Task 5). Rust tests find the built fixture module at `PLUR1BUS_FIXTURE_MODULE`, default `packages/module-fixture/dist` (built by `pnpm build`, which CI runs before `cargo test`).
- **Clocks:** durations on `Instant` (Rust) or `performance.now()` (TS). Wall time only in reported `at`/`since` fields.
- **English** everywhere. Generated docs are never hand-edited.

## Review Focus

These are five inputs the spec implies but no acceptance criterion names. Each is pinned by a test in the owning task.

1. **An editor that saves `config.json` non-atomically** (truncate, then write): the watcher may see `{` or an empty file for one tick. The running configuration must not change, a rejection must not stick once the full content lands, and the final content is applied exactly once. → Task 4 `a_truncated_then_completed_edit_applies_once`.
2. **`config set` racing a hand edit or a second `config set`**: the CLI previews against one revision and applies against another. Expected: `E_CONFLICT reason=config-changed`, nothing written, and the CLI tells the person to re-run. → Task 4 `set_with_a_stale_revision_is_a_conflict_and_writes_nothing`.
3. **A module that dies at start** (a syntax error in its entry, a missing dependency): it must back off, give up after five exits in the window, show `crashed` with a reason in `module list`, `daemon status` and `1staid check`, and never touch the core. → Task 9 `a_module_that_crashes_at_start_gives_up_after_five_and_the_core_is_untouched`.
4. **`daemon stop` (or SIGTERM) while a large journal backlog replays**: the stop stays inside its budget, no line is lost, and none is stored twice at the next start. → Task 2 `stop during replay keeps every unreplayed line and leaves no replaying file`.
5. **`module install` of a hostile or broken directory** (an `entry` of `../x.js`, a symlink that points outside, the name `core`): refused with the reason, and nothing is copied into `modules/`. → Task 10 `install_refuses_escaping_entries_symlinks_and_reserved_names_and_copies_nothing`.

---

## Rulings on spec gaps (binding for this plan)

| # | Gap | Ruling |
|---|---|---|
| B1 | The H3b outline holds ten subsystems plus parked debts. | Split. **2a-H3b-a** (this plan): E4.1 pin, replay while serving, launchd debt, config ownership, modules, admin ops. **2a-H3b-b** (outline at the end): `setup`, `update --check`, `1staid repair` plus installer checks, operations skill, release and exit. |
| B2 | Spec §6.3's lifecycle is "replays journal → opens socket → reports `ready`". Since `f9d0e19` the socket already listens before replay, but `process.state` stays `starting` and `start()` does not return until replay ends. After a long outage, `daemon status`, `1staid check` and callers that wait for `ready` see the core as not ready for tens of seconds, and warm-up starts only after replay (ADR-012 §10.11). | The core reports `ready` right after `listen()`, then starts warm-up and replay together in the background. Replay captures observe the core's shutdown signal. On abort, the lines not yet replayed stay in the journal without a capture call. `core.status` gains `journalReplay` (`$defs/JournalReplayStatus`). A recall during replay can miss a fact that is still journaled; `journalReplay.state === "replaying"` and `journalBacklog` make that visible. Recorded as an ADR-012 deviation. |
| B3 | Spec §6.2 names `config.watch` and `config.changed { diff, restartPlan }` but no subscription for supervisor notifications; `events.subscribe` is a core method. | `config.watch {}` returns the running configuration and subscribes the connection to `config.changed`. `module.watch {}` does the same for `module.state`. Notification shape: `config.changed { revision, previousRevision, changed, restart, config, source }`, where `changed`/`restart` are the existing restart-plan shape (ADR-013 §3), `config` is the full new configuration and `source` is `"set"` or `"file"`. Both notifications carry `x-server: "supervisor"`. |
| B4 | Spec §6.1: "direct file edits are detected by a watcher". No watcher crate fits the budget. | The supervisor polls `config.json`'s mtime and length every `1000 ms × scale`; on a change it reads the file and compares its SHA-256 with the last applied or self-written bytes. A valid, different file is applied like a `set` (`source: "file"`). An invalid file leaves the running configuration unchanged, is logged, and shows in `daemon.status.config.rejected` and `1staid check config.valid`. The file is never rewritten by the watcher. A later `config.set` over a rejected file first copies it to `config.json.rejected-<epoch ms>`. |
| B5 | Preview and apply are two calls; the spec says nothing about a change in between. | `revision` = first 16 hex of SHA-256 over the running configuration serialized by `serde_json::to_string` (sorted keys; the workspace does not enable `preserve_order`). `config.set { ifRevision }` refuses a mismatch with `E_CONFLICT reason=config-changed`. The CLI previews with `dryRun: true` and applies with the previewed revision. |
| B6 | The CLI owns the file today; after this plan the supervisor does, but the supervisor may not run. | The CLI routes `config get|set` and `agent create|remove` through the supervisor when it answers. When it is **absent** (no `run/supervisor.token`, connection refused, or the recorded pid is dead) the CLI writes the file directly, as today, and says the change takes effect at the next start. When it is **present but does not answer** within the call deadline, the CLI fails with `E_NOT_AVAILABLE reason=supervisor-unresponsive`, exit 1, and writes nothing. |
| B7 | Spec §6.3: the core "loads config from supervisor". An adopted core may hold an older configuration than the new supervisor's. | A supervised core (`--lifeline stdin`) calls `config.watch` on the supervisor at start (3 attempts, 1 s each), then falls back to reading the file with a warning. After each successful `core.adopt` it calls `config.watch` again and applies the difference. When the configuration the engine was built from differs from the current one in any `core`-class key, `core.status.config.restartPending` is `true`, and the supervisor performs one requested restart of that generation. |
| B8 | Spec §6.1 "restart plan in dependency order" is unspecific; spec §6.4 says a config change touching a given-up unit re-arms it. | Execution order: stop affected modules in reverse start order, restart the core if `restart.core`, start affected modules in start order. Requested restarts never count toward the give-up budget. A plan that touches a unit in `crashed` (fatal or given up) resets that unit's `Backoff` and starts it. |
| B9 | Spec §6.4: "readiness is the RPC handshake on the child's socket"; modules are clients of the core, yet must be adoptable. | Every module serves `run/module-<name>.sock` (Windows `\\.\pipe\plur1bus-<hash16>-module-<name>`, Node's default DACL as for the core, C2) with `run/module-<name>.token` and `run/module-<name>.pid` (`<pid> <instanceId>\n`), and holds `run/module-<name>.lock`. Module-served methods (`x-server: "module"`): `module.auth`, `module.status`, `module.adopt`, `module.shutdown`. Supervisor-served methods keep the spec's names: `module.list|start|stop|restart|graph|install|uninstall|watch`. The two sets do not overlap. |
| B10 | D14 `scope: agent` means one instance per agent; nothing in 2a needs it. | The manifest accepts `scope: "agent"`, `module list` and `module graph` show it, and the supervisor does not start it (`stopped`, reason `scope-agent-unsupported`) until the first agent-scoped module (2b). |
| B11 | D14 `extensionPoints` (`chain`/`collect`) have no dispatcher in 2a. | Validated, listed and drawn in `module graph`. They are not dispatched, and the supervisor's `capabilities.extensionPoints` stays `{}` until the first consumer (2b). |
| B12 | ADR-016 G3: "the supervisor loads current and previous module `apiVersion` side by side". | Current module API version is `1`. Supported: the current and the one before it (`n` and `n−1`, `n−1 ≥ 1`). A module's `module.auth` hello must report its manifest's `name` and `apiVersion`, else it is treated as foreign and terminated. The test seam `PLUR1BUS_MODULE_API_CURRENT` proves two versions run side by side. |
| B13 | D3 needs `module:<name>` keys, and config is one closed file. | New namespace `modules.<name>` (open object per module, tier `advanced`) with `"x-restart": "module:$key"`, resolved to `module:<name>` by both resolvers. `modules.<name>.enabled` (boolean, default `true`) stops or starts the module. When the manifest has `configSchema`, `modules.<name>` is validated against it on every `set` and hand edit (`E_CONFIG_INVALID`). `module stop` is a runtime state only; `enabled: false` is the persistent one. |
| B14 | Criterion 12 says "installed via `module` commands"; the outline names no install command. | `module install <dir>` and `module uninstall <name>` (supervisor methods, and offline CLI paths using the same Rust code). The registry is `modules/<name>/module.json`. Install copies into `modules/<name>.tmp-<pid>`, then renames; it refuses symlinks anywhere in the tree, an `entry` outside the directory, a reserved name (`core`, `supervisor`) and an invalid manifest. `list`, `graph`, `install` and `uninstall` work with no supervisor; `start`, `stop` and `restart` need one. Uninstall keeps `modules.<name>` in `config.json`. |
| B15 | The outline leaves admin-op CLI names open. | A top-level `admin` group: `admin obsidian detect|prepare|confirm`, `admin migrate --from --to`, `admin embedding probe [--refresh]`, `admin embedding serve [--stop]`. RPC names `admin.obsidian.detect|prepare|confirm`, `admin.migrate`, `admin.embedding.probe|serve` (`x-server: "core"`). WebMCP never exposes `admin.*` (D55). |
| B16 | ADR-012 §10.7: launchd restarts on every non-zero exit, so exit 2 (usage) and 3 (lost the single-instance race) loop every 5 s. | The plist sets `PLUR1BUS_SERVICE_MANAGER=launchd`. Under it the supervisor exits **0** instead of 2 or 3, after logging the real code. Every other exit code is unchanged. |
| B17 | 2a-H3a minor M3: `daemon.start`'s `role` enum is `["core"]`; "2a-H3b must widen knowingly". | Not widened: `daemon.start` stays core-only, and modules use `module.start`. |

**Out of scope:** everything under 2a-H3b-b; extension-point dispatch; agent-scoped module instances; module signing or a catalog; the ADR-016 §7 conformance kit; blue/green core swap; the Windows core-pipe front end (C2 stays open).

## Engine dependency (E4.1)

Engine PR #195 (`fix/e4-1-replay-guard-records-on-rows-settled`, head `c4b613aa`) makes the replay guard record a turn once its rows are stored ("No contract change (1.8.0)"). Task 1 needs its **merge commit** on the engine's `main`, written below as `<E41_SHA>`. Tasks 2–12 do not depend on it. If PR #195 has not merged when Task 11 is done, Task 1 runs last.

## File structure

```
packages/rpc-schema/schema/rpc.schema.json   1.3.0 (T2); JournalReplayStatus (T2); config.* + config.changed + RestartPlan, daemon.status.config (T4);
                                             CoreStatus.config (T5); module.auth|status|adopt|shutdown, ModuleStatus (T8); ChildStatus.kind,
                                             module.watch, module.state (T9); module.list|start|stop|restart|graph|install|uninstall (T10); admin.* (T11)
packages/rpc-schema/src/index.ts             RpcServerRole += "module"; supervisor notifications (T4, T8)
packages/config-schema/schema/config.schema.json, src/index.ts   modules namespace, module:$key (T10)
packages/core/src/
  replay.ts (new)                            startJournalReplay (T2);  journal.ts: abortable replay (T2)
  config-source.ts (new)                     supervised config with file fallback (T5)
  core.ts, bin.ts, agents.ts, host.ts, logger.ts, rpc/methods.ts   ready before replay (T2); live config (T5)
  admin-ops.ts (new)                         admin.* handlers (T11)
packages/module-api/
  schema/manifest.schema.json (new), fixtures/manifest-cases.json (new), src/manifest.ts (new)   T7
  src/config-watch.ts (new)                  supervisor config client (T5)
  src/runtime.ts, control-server.ts, paths.ts, lock.ts, orphan-watch.ts (new/moved)            T8
packages/module-fixture/ (new)               the fixture module (T8)
crates/plur1bus-config/src/lib.rs            revision, set_many (T4); module:$key (T10)
crates/plur1bus-rpc/src/{client,capabilities}.rs   Endpoint::Module, "module" capabilities (T8)
crates/plur1bus/src/
  supervisor/config.rs, subscribers.rs (new) T4;  supervisor/{mod,child,adopt,server,state}.rs  T4–T6, T9, T10
  modules/{mod,manifest,graph,install}.rs (new)   T7, T10
  commands/{module,admin}.rs (new); commands/{config,agent,daemon,firstaid}.rs   T4, T9–T11
  service/launchd.rs                          T3
crates/plur1bus/tests/config_service.rs, modules.rs, module_cmd.rs (new)
tests/system/config-restart.test.ts, modules.test.ts, admin.test.ts (new); kill-soak.test.ts (T1, T2)
docs/adr/ADR-012, -013, -016, docs/module-guide.md (new), AGENTS.md   T12
```

## Task map

| # | Task | Produces (used by) |
|---|---|---|
| 1 | Engine pin `<E41_SHA>`; the soak's kill-during-replay tolerance goes | — |
| 2 | Journal replay while serving; RPC 1.3.0; journal/host test leaks | `startJournalReplay`, `JournalReplayStatus` (12) |
| 3 | launchd: non-transient supervisor exits become 0 | `exit_code` (12) |
| 4 | Supervisor owns `config.json`: `config.get|set|watch`, watcher, `config.changed`, CLI routing | `ConfigState`, `Subscribers`, `commands::config::apply` (5, 9, 10) |
| 5 | Core loads and applies the supervisor's config; restart jobs; `restartPending`; criterion 4 (live, core) | `openConfigSource`, `watchSupervisorConfig`, `RestartJob` (8, 10) |
| 6 | Supervisor children as slots (refactor, behaviour unchanged) | `Role`, `Slot`, `next_due`, `probe_child` (9, 10) |
| 7 | Module manifest schema, graph, API-version policy | `Manifest`, `scan`, `graph`, `start_order` (9, 10) |
| 8 | Module runtime in `@plur1bus/module-api`; module control methods; fixture module | `runModule`, `module.*` (module-served), fixture (9, 10) |
| 9 | Supervisor runs modules; `module.state`; `1staid modules.state`; criterion 5 | module slots (10) |
| 10 | `module` commands; `modules.<name>` config; module restart execution; criteria 4 (module) and 12 | — |
| 11 | Admin ops over RPC and CLI | — |
| 12 | ADR records, `docs/module-guide.md`, AGENTS.md | — |

---

### Task 1: Engine pin `<E41_SHA>`; the kill soak's kill-during-replay tolerance goes

**Files:**
- Modify: `packages/core/package.json` (engine line), `pnpm-lock.yaml`, `scripts/gen-engine-keys.mjs` (header `contract 1.8.0, engine @ <first 8 of E41_SHA>`), `docs/config-engine-keys.md` (regenerated), `tests/system/kill-soak.test.ts` (remove `killsDuringReplay`, `coreLogRecords`, the `sigkills` and `journalLine` bookkeeping, `LOGS_KEEP` and its `config set`, the `todo (engine PR E4.1)` diagnostic), `packages/core/src/journal.ts` (the `journal: replay start` comment names it a diagnostic that pairs with `journal: replayed`, not a soak hook; the log line stays)

- [ ] **Step 1: Check the precondition.** `git -C $ENGINE fetch origin && git -C $ENGINE log --oneline origin/main | grep -m1 "#195"` names the merge; that commit is `<E41_SHA>`. `git -C $ENGINE show <E41_SHA>:engine/capture/turn-replay-guard.js | grep -c onRowsSettled` ≥ 1, and `types/engine.d.ts` there still says 1.8.0. If PR #195 has not merged, stop and report BLOCKED; run this task after Task 11.
- [ ] **Step 2: Tighten the soak first.** Replace the tolerance with `assert.deepEqual(replayedTwice, [], …)` and keep the per-third diagnostic. Run the 200-turn soak three times on the old pin with `PLUR1BUS_SOAK_SEED=3748478939` (H3-R24's reproducing seed). Expected: at least one FAIL with a journaled fact stored twice. If all three pass, record that in the report; the RED evidence is then E4.1's own engine test.
- [ ] **Step 3: Bump the pin** to `git+https://github.com/Cyb3rb1ade/openclaw-plur1bus-memory.git#<E41_SHA>` and run `pnpm install`. Only the engine's resolution lines may move in the lockfile. `core.test.ts` still expects contract `"1.8.0"`.
- [ ] **Step 4: Run** Green, all system tests, and the soak three times (seed 3748478939 and two unseeded runs) → PASS, `replayedTwice 0` each time.
- [ ] **Step 5: Commit** `feat(core): pin engine E4.1 (replay guard records on rows settled); kill soak asserts exactly-once without tolerance`.

---

### Task 2: Journal replay while serving; RPC 1.3.0; the journal/host test leaks

**Files:**
- Create: `packages/core/src/replay.ts`, `packages/core/test/replay.test.ts`
- Modify: `packages/core/src/journal.ts`, `packages/core/src/core.ts`, `packages/rpc-schema/schema/rpc.schema.json` (version 1.3.0; `$defs/JournalReplayStatus`; `$defs/CoreStatus.journalReplay` optional), rpc-schema fixtures, `crates/plur1bus/src/commands/firstaid.rs` (`check_journal_backlog`), `tests/system/kill-soak.test.ts` (drain wait: `1staid check` `journal.backlog` must be `ok`; "ready" no longer implies drained, fix both comments), `packages/core/test/host.test.ts` and `journal.test.ts` (use `tempDir()` from `test/helpers/temp-dir.ts`)
- Test: `packages/core/test/{journal,core}.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // journal.ts — options gain an abort signal; everything else unchanged
  type JournalOpts = { dir: string; agents: AgentRegistry; engine: ReplayEngine; logger: HarnessLogger; clock: () => number; signal?: AbortSignal };
  // replay.ts
  export interface JournalReplayStatus { state: "replaying" | "done" | "aborted" | "failed"; replayed: number; kept: number; passes: number; startedAt: number; finishedAt: number | null }
  export interface JournalReplay { status(): JournalReplayStatus; readonly done: Promise<void> }  // done never rejects
  export function startJournalReplay(o: JournalOpts & { signal: AbortSignal; onDone?: (s: JournalReplayStatus) => void }): JournalReplay;
  ```
  `$defs/JournalReplayStatus` mirrors the TS type (closed, `finishedAt` `integer|null`). An empty journal gives `state: "done"` with zeros at once.
- Behaviour: each replayed capture gets `AbortSignal.any([o.signal, AbortSignal.timeout(60_000)])`. Once `o.signal` is aborted, the remaining lines of the current file are kept without a capture call (appended back as today), no further file is renamed, and no further pass runs. `core.ts`: after `server.listen()` → `setState(ready)` → `startWarmup(…)` → `replay = startJournalReplay({ …, signal: shutdown.signal, onDone: (s) => { journalBacklog = s.kept; refreshEngineStatus(); } })`. `status().journalReplay = replay.status()`. `stop()`: after `shutdown.abort()` and before `engine close`, wait for `replay.done` for at most `min(5000, budgetMs)`; a replay still running then leaves its `.replaying-<pid>` file for the next start (existing recovery). The branch that orphans a core whose lifeline was lost "during the replay" becomes "during engine start" (the check at `ready` stays).
- `1staid check journal.backlog`: when `core.status.journalReplay.state === "replaying"` → `warn`, summary `replaying: <replayed> replayed, <n> left`, detail `{ replayed, left }`.

- [ ] **Step 1: Write the failing tests.**
  - journal.test (fake `ReplayEngine` counting calls): `an aborted signal keeps the rest of the file without calling capture` (5 lines, abort inside the first capture → 1 call, 4 lines back in `<agent>.jsonl`, no `*.replaying-*`); `drainJournal runs no further pass after abort`.
  - core.test (flat embedder, `engine.duplicateThreshold = 1.01`, 20 journal lines for `bernd`): `start() resolves ready while the journal replays` (right after `await core.start()`: `process.state === "ready"` and `journalReplay.state === "replaying"`; in `core.log` the `core ready` record precedes the first `journal: replayed`; then `waitFor` `state === "done"`, `replayed === 20`, `journalBacklog === 0`, and `memory.list` shows 20 cards).
  - core.test (Review Focus 4): `stop during replay keeps every unreplayed line and leaves no replaying file` (40 lines; `stop({ budgetMs: 10_000 })` right after `start()`; afterwards no `*.replaying-*`, and `replayed + lines in bernd.jsonl === 40`; a second core on the same home finishes the replay and `memory.list` shows exactly 40 cards, no text twice).
  - core.test: `nothing is written to core.log after stop() resolves` (size and mtime unchanged 500 ms after `stop()`).
  - firstaid unit: `journal_backlog_while_replaying_is_a_warning_with_progress`.
- [ ] **Step 2: Run** → FAIL (start blocks on replay; no `journalReplay`).
- [ ] **Step 3: Apply `tempDir()` to `host.test.ts` and `journal.test.ts`** and run them. They fail with a write into the removed home after the tests end (final-fix report, concern 1). Find the writer from the stack and fix it at the source, so that nothing logs after `stop()`/`close()` resolved. The test from Step 1 pins it.
- [ ] **Step 4: Implement** the signal in `journal.ts`, `replay.ts`, the `core.ts` order and stop step, the schema field (version 1.3.0 everywhere, fixtures regenerated) and the 1staid row. Update the kill-soak drain wait.
- [ ] **Step 5: Run** the files → PASS; Green; `pnpm docs:gen`; the 200-turn soak once.
- [ ] **Step 6: Commit** `feat(core): serve while the journal replays in the background (B2); RPC 1.3.0 journalReplay; test homes cleaned up`.

---

### Task 3: launchd — non-transient supervisor exits become 0

**Files:**
- Modify: `crates/plur1bus/src/service/launchd.rs` (plist `EnvironmentVariables` dict with `PLUR1BUS_SERVICE_MANAGER` = `launchd`), `crates/plur1bus/src/supervisor/mod.rs` (`fail()` maps its code through `exit_code`)
- Test: `crates/plur1bus/tests/supervisor.rs`, unit tests in `supervisor/mod.rs` and `service/launchd.rs`

**Interfaces:**
- Produces: `pub fn exit_code(code: i32, manager: Option<&str>) -> i32`: `2 | 3` → `0` when `manager == Some("launchd")`; every other input unchanged. Before exiting 0 the supervisor writes `exiting 0 instead of <code> so launchd does not restart a non-transient failure` to stderr and `logs/supervisor.log`.

- [ ] **Step 1: Write the failing tests:** unit `non_transient_exits_are_0_under_launchd_only` (2→0, 3→0 under launchd; 1→1, 70→70; `None` and `Some("systemd")` unchanged); launchd render `plist_sets_the_service_manager_env` (parsed with `roxmltree`); integration `a_second_supervisor_under_launchd_exits_0_with_the_message` (first `supervise --no-core`, second with `PLUR1BUS_SERVICE_MANAGER=launchd` → exit 0, stderr contains both `supervisor already running` and `exiting 0 instead of 3`).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** `exit_code`, the plist entry and the `fail()` change.
- [ ] **Step 4: Run** → PASS; Green; `cargo test --release -p plur1bus --test service`.
- [ ] **Step 5: Commit** `fix(service): launchd does not loop non-transient supervisor exits (B16)`.

---

### Task 4: The supervisor owns `config.json` — `config.get|set|watch`, watcher, `config.changed`, CLI routing

**Files:**
- Create: `crates/plur1bus/src/supervisor/config.rs`, `crates/plur1bus/src/supervisor/subscribers.rs`, `crates/plur1bus/tests/config_service.rs`
- Modify: `packages/rpc-schema/schema/rpc.schema.json` (methods `config.get`, `config.set`, `config.watch`; notification `config.changed`; `$defs/RestartPlan`; `daemon.status` result gains optional `config`), `packages/rpc-schema/src/index.ts` (notifications may carry `x-server: "supervisor"`), `crates/plur1bus-config/src/lib.rs`, `crates/plur1bus/src/supervisor/{mod,server,child}.rs`, `crates/plur1bus/src/commands/{config,agent,firstaid}.rs`, `crates/plur1bus/src/supervisor/logfile.rs` (`set_limits`)
- Test: `crates/plur1bus-config/tests/config.rs`, `packages/rpc-schema/test/schema.test.ts`, `crates/plur1bus/tests/cli.rs`

**Interfaces:**
- Schema (all `x-server: "supervisor"`):
  - `config.get { key?: string, tier?: "basic"|"advanced" }` → `{ key: string|null, tier: string|null, value, restartClass: string|null, revision }` (`restartClass` `"live" | "core" | "module:<name>"` for a key, else `null`).
  - `config.set { changes: [{ key, value }] (1–64), dryRun?: boolean, ifRevision?: string }` → `{ applied, dryRun, changed: string[], restart: RestartPlan, revision, restarted: string[], durationMs, estimates?: { [unit: string]: integer|null } }`. `RestartPlan = { live: string[], core: boolean, modules: string[] }`. Errors: `E_CONFIG_INVALID` (`detail` = joined errors), `E_CONFLICT reason=config-changed`, `E_NOT_AVAILABLE reason=config-unavailable` (no valid running config).
  - `config.watch {}` → `{ subscriptionId, config, revision }`; then `config.changed { revision, previousRevision, changed, restart, config, source: "set"|"file" }` on that connection.
  - `daemon.status.config?: { revision: string|null, rejected: null | { at: integer, errors: string[] } }`.
- Rust:
  ```rust
  // plur1bus-config
  pub fn revision(config: &Value) -> String;                                         // B5
  pub fn set_many(config: &Config, changes: &[(String, Value)]) -> Result<Plan, ConfigError>; // `set` delegates
  // supervisor/config.rs
  pub struct ConfigState { pub running: Option<Value>, pub revision: Option<String>, pub applied_hash: Option<[u8; 32]>,
                           pub stamp: Option<(SystemTime, u64)>, pub rejected: Option<Rejected> }
  pub struct Rejected { pub at: u64, pub errors: Vec<String> }
  pub enum SetError { Invalid(Vec<String>), Conflict { current: String }, Unavailable }
  pub fn set(shared: &Arc<Shared>, layout: &Layout, changes: Vec<(String, Value)>, if_revision: Option<&str>, dry_run: bool) -> Result<Value, SetError>;
  pub fn poll_file(shared: &Arc<Shared>, layout: &Layout);   // one watcher tick (B4)
  // supervisor/subscribers.rs
  pub enum Topic { Config, Modules }
  pub type SharedWriter = Arc<Mutex<Box<dyn Write + Send>>>;
  impl Subscribers { pub fn add(&self, topic: Topic, w: SharedWriter, closer: Box<dyn FnOnce() + Send>) -> String;
                     pub fn broadcast(&self, topic: Topic, method: &str, params: &Value) }
  // commands/config.rs
  pub(crate) enum Route { Supervisor(plur1bus_rpc::Client), Direct }
  pub(crate) fn route(layout: &Layout) -> Result<Route, RpcError>;                    // B6
  pub(crate) fn apply(out: &Out, layout: &Layout, changes: Vec<(String, Value)>, yes: bool, dry_run: bool) -> !;
  ```
  `Shared` gains `config: Mutex<ConfigState>` and `subscribers: Subscribers`. `SupervisorConfig` is derived from the running config instead of a one-off read. Each subscriber has a `sync_channel(64)` drained by its own writer thread; a full channel drops the subscriber and closes its connection (logged), so a client that stops reading never blocks a `set`. The connection's writer becomes a `SharedWriter` so replies and notifications share it. `config.set` is serialised by the config mutex. `config.json` at supervisor start: valid → running; invalid → `running: None`, `rejected` set, `config.get|watch|set` answer `config-unavailable` until a valid file appears.
- Supervisor `live` keys applied on every change: `supervisor.healthIntervalMs` (the health loop reads it from `SupervisorState` before each poll) and `logs.maxBytes`/`logs.keep` (`RotatingFile::set_limits`). `restart.core` and `restart.modules` are reported, not executed yet (Task 5 and Task 10).
- CLI: `config set` previews with `dryRun: true`, prompts (or `--yes`), applies with `ifRevision`; on `E_CONFLICT` it prints `config.json changed meanwhile; re-run` and exits 1. `config get` prefers the supervisor's running config. `agent create|remove` call `apply`. The human text drops the H1 "takes effect at the next core run" sentence when routed through the supervisor.
- `1staid check config.valid`: when the supervisor reports `rejected` → `fail` with `detail.errors` and hint `the supervisor runs the last valid configuration; fix config.json or use plur1bus config set`.

- [ ] **Step 1: Write the failing tests.**
  - plur1bus-config: `revision_is_independent_of_key_order`, `set_many_applies_all_changes_or_none`.
  - rpc-schema: `supervisor.auth capabilities list config.* and config.changed; core.auth lists neither`.
  - `tests/config_service.rs` (`supervise --no-core`, a raw watch connection helper that reads notifications):
    - `config_get_returns_the_running_config_and_its_revision`
    - `config_set_writes_atomically_emits_config_changed_and_reports_the_plan` (`core.logLevel` → `changed == ["core.logLevel"]`, `restart.live == ["core.logLevel"]`, `source == "set"`, the file parses to the running config)
    - `dry_run_changes_nothing` (bytes, mtime and revision unchanged; no notification)
    - `an_invalid_value_is_E_CONFIG_INVALID_and_nothing_changes`
    - `set_with_a_stale_revision_is_a_conflict_and_writes_nothing` (Review Focus 2)
    - `a_valid_hand_edit_is_applied_like_a_set` (`source == "file"`)
    - `an_invalid_hand_edit_is_rejected_the_running_config_stays_and_daemon_status_shows_it`
    - `a_truncated_then_completed_edit_applies_once` (Review Focus 1: write `{`, wait 1.5 ticks, write the full content → exactly one `config.changed`, `rejected` null afterwards)
    - `a_set_over_a_rejected_file_backs_it_up` (`config.json.rejected-*` holds the broken bytes)
    - `an_invalid_file_at_start_answers_config_unavailable`
    - `a_subscriber_that_never_reads_is_dropped_and_set_stays_fast` (100 sets, each < 1 s)
  - `tests/cli.rs`: `config_set_routes_through_a_running_supervisor` (a watch connection sees the change), `config_set_without_a_supervisor_writes_the_file` (existing behaviour), unix `config_set_with_an_unresponsive_supervisor_fails_and_writes_nothing` (supervisor `SIGSTOP`ped → `E_NOT_AVAILABLE supervisor-unresponsive`, exit 1, file unchanged), `agent_create_routes_through_the_supervisor`.
  - firstaid unit: `config_valid_fails_when_the_supervisor_rejected_an_edit`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** schema (and `pnpm gen && pnpm build`), `plur1bus-config` additions, `subscribers.rs`, `config.rs`, the watcher thread (`spawn_guarded(…, "config-watch", …)`, tick `1000 ms × scale`), the server dispatch, the live supervisor keys, the CLI routing and the 1staid row.
- [ ] **Step 4: Run** → PASS; Green; `pnpm docs:gen`.
- [ ] **Step 5: Commit** `feat(supervisor): own config.json — config.get/set/watch, watcher, config.changed, CLI routing (spec §6.1, B3–B6)`.

---

### Task 5: The core loads and applies the supervisor's config; restart jobs; `restartPending`; criterion 4 (live and core)

**Files:**
- Create: `packages/module-api/src/config-watch.ts`, `packages/module-api/test/config-watch.test.ts`, `packages/core/src/config-source.ts`, `packages/core/test/config-source.test.ts`, `packages/core/test/helpers/fake-supervisor.ts`, `tests/system/config-restart.test.ts`
- Modify: `packages/rpc-schema/schema/rpc.schema.json` (`$defs/CoreStatus.config` optional `{ revision: string|null, source: "supervisor"|"file", restartPending: boolean }`), `packages/core/src/{core,bin,agents,host,logger,orphan-watch}.ts`, `packages/core/src/rpc/methods.ts`, `crates/plur1bus/src/supervisor/{mod,child,config}.rs`, `crates/plur1bus/tests/fixtures/fake-core.mjs` (`FAKE_CORE_RESTART_PENDING=1`), `.github/workflows/ci.yml` (system list)
- Test: `packages/core/test/core-supervised.test.ts`, `crates/plur1bus/tests/config_service.rs`

**Interfaces:**
- Consumes: Task 4's `config.watch`, `config.changed`, `config.set`.
- Produces:
  ```ts
  // module-api/src/config-watch.ts — shared by the core and by runModule (Task 8)
  export interface ConfigChanged { revision: string; previousRevision: string | null; changed: string[]; restart: { live: string[]; core: boolean; modules: string[] }; config: Record<string, unknown>; source: "set" | "file" }
  export interface ConfigWatch { readonly config: Record<string, unknown>; readonly revision: string; onChange(fn: (c: ConfigChanged) => void): () => void;
    set(changes: { key: string; value: unknown }[]): Promise<unknown>; close(): Promise<void> }
  export function watchSupervisorConfig(o: { home: string; connectTimeoutMs?: number; attempts?: number }): Promise<ConfigWatch>; // reads run/supervisor.token per attempt
  // core/src/config-source.ts
  export interface ConfigSource { current(): HarnessConfig; readonly source: "supervisor" | "file"; revision(): string | null; restartPending(): boolean;
    onChange(fn: (prev: HarnessConfig, next: HarnessConfig, plan: ReturnType<typeof restartPlan>) => void): () => void;
    resubscribe(): Promise<void>; set(changes: { key: string; value: unknown }[]): Promise<void> | null; close(): Promise<void> }
  export function openConfigSource(o: { layout: Layout; supervised: boolean; logger?: HarnessLogger }): Promise<ConfigSource>; // B7
  export function flattenPatch(prefix: string, patch: Record<string, unknown>): { key: string; value: unknown }[]; // leaves; arrays are leaves
  ```
  A pushed config that fails `validate()` is ignored and logged. `restartPending()` is `restartPlan(builtWith, current()).restart.core`.
- Core `live` appliers: `core.logLevel` → `logger.setLevel`; `logs.maxBytes`/`logs.keep` → new `logger.setRotation({ maxBytes, keep })`; `supervisor.graceMs` → new `OrphanWatch.setGraceMs(ms)` (the next orphaning uses it; a running timer keeps its deadline); `core.recall.*`, `core.capture.waitMs`, `core.shutdownBudgetMs` are read per use (`MethodDeps.config` becomes `() => HarnessConfig`); `agents.*` → `createAgentRegistry({ config: () => HarnessConfig }, l, logger)` (a third input form beside the existing two). `host.mutateConfig` is set only when `source === "supervisor"`: `(patch) => source.set(flattenPatch("engine", patch))`. `onReattached` after a `core.adopt` calls `source.resubscribe()`. `bin.ts` reads `shutdownBudgetMs` from the source. `status().config = { revision, source, restartPending }`.
- Rust:
  ```rust
  pub struct RestartJob { pub plan: plur1bus_config::Restart, pub done: std::sync::mpsc::Sender<Vec<String>> } // units restarted
  // SupervisorState gains `restart_jobs: VecDeque<RestartJob>`; the main loop runs them (B8) and wakes on push.
  impl Monitor { pub fn restart_requested(&mut self, budget: Duration) }  // requested stop + spawn; never counts toward give-up
  ```
  `config::set` pushes a job when `restart.core` (modules: Task 10), waits for it (bound: `DEFAULT_STOP_BUDGET + ready timeout`), and fills `restarted`, `durationMs` and `estimates.core` (the last spawn-to-ready time of the core, `null` before one). A job that touches a fatal or given-up core resets its `Backoff` first (B8). The health loop, on `status.config.restartPending == true`, pushes one core job per generation and logs `core reports a pending core-class config change`.

- [ ] **Step 1: Write the failing tests.**
  - config-watch.test (fake supervisor from `packages/core/test/helpers/fake-supervisor.ts`, a small NDJSON server that answers `supervisor.auth`, `config.watch`, `config.set` and can push `config.changed`): `resolves the watch snapshot`, `forwards config.changed to onChange`, `rejects after the given attempts when nothing listens`.
  - config-source.test: `supervised source serves the snapshot, not the file`; `an invalid pushed config is ignored and logged`; `unreachable supervisor falls back to the file`; `restartPending follows a core-class change`; `flattenPatch yields leaf keys` (`{ recall: { x: 1 }, tags: ["a"] }` → `engine.recall.x`, `engine.tags`).
  - core-supervised.test (`createCore` with a lifeline and the fake supervisor): `core.logLevel change applies without restart` (debug records appear after the push); `hardBudgetMs change applies to the next recall` (`budget` unset, 1 ms hard → `degraded.reason === "aborted"`); `supervisor.graceMs change applies to the next orphaning`; `agents added by config.changed are registered`; `a core-class change sets status().config.restartPending`; `mutateConfig sends a flattened config.set`; `after core.adopt the core re-watches with the new token`.
  - `tests/config_service.rs` (fake core): `a_core_key_change_restarts_the_core_once_and_reports_it` (`restarted == ["core"]`, new pid, `lastExit.reason == "none"`, `estimates.core` integer); `requested_restarts_never_count_toward_give_up` (six core-key sets at scale 0.02 → never `crashed`); `a_core_reporting_restart_pending_is_restarted_once`.
  - `tests/system/config-restart.test.ts` (real core, flat embedder, under `daemon start`), criterion 4 without the module part: `live key` (`core.logLevel debug` → core pid unchanged, `restart.live` names it, debug lines in `core.log`); `core key` (`engine.duplicateThreshold` → exactly one new core pid, `restarted == ["core"]`); `dry run changes nothing` (file bytes, revision, pid); `invalid value rejected` (exit 1 `E_CONFIG_INVALID`, file and revision unchanged); `a core key edited while the supervisor is dead is applied after adoption` (SIGKILL the supervisor, edit `engine.duplicateThreshold` in the file, restart `supervise` within grace → adopted, then `restartPending` → one restart, new pid).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** `config-watch.ts`, `config-source.ts`, the appliers, the schema field, restart jobs, `restart_requested`, the `restartPending` hook and the fake-core flag. Add the system file to `ci.yml`.
- [ ] **Step 4: Run** → PASS; Green; the new system test and `reconnect.test.ts`.
- [ ] **Step 5: Commit** `feat(core,supervisor): the core runs on the supervisor's config — live keys, restart jobs, restartPending (spec §6.1, criterion 4, B7, B8)`.

---

### Task 6: Supervisor children as slots (refactor, behaviour unchanged)

**Files:**
- Modify: `crates/plur1bus/src/supervisor/{mod,child,adopt,server,state}.rs`, `crates/plur1bus/src/paths.rs`, `crates/plur1bus/src/commands/{daemon,firstaid}.rs`

**Interfaces:**
- Produces:
  ```rust
  #[derive(Clone, Copy, PartialEq, Eq, Debug)] pub enum RoleKind { Core, Module }
  #[derive(Clone, PartialEq, Eq, Debug)] pub struct Role { pub name: String, pub kind: RoleKind }
  impl Role { pub fn core() -> Role; pub fn module(name: &str) -> Role; pub fn method(&self, verb: &str) -> String } // "core.status" | "module.status"
  pub struct Endpoints { pub address: String, pub token: PathBuf, pub pid: PathBuf }
  impl Layout { pub fn endpoints(&self, role: &Role, platform: &str) -> Endpoints } // core: today's paths; module: run/module-<name>.{sock,token,pid}
  pub struct Slot { pub role: Role, pub child: Option<ChildState>, pub lifeline: Lifeline, pub backoff: Backoff,
                    pub restart_at: Option<Instant>, pub start_requested: bool }
  // SupervisorState: `slots: Vec<Slot>` (core first) replaces child, lifeline, backoff, restart_at, start_requested.
  impl SupervisorState { pub fn slot(&self, name: &str) -> Option<&Slot>; pub fn slot_mut(&mut self, name: &str) -> Option<&mut Slot> }
  pub fn next_due(slots: &[Slot], now: Instant) -> Option<usize>; // a start_requested slot first, else the earliest due restart_at
  // child.rs: Monitor::start(shared, layout, role, spec) / Monitor::adopt(shared, layout, role, spec, peer, lifeline, status)
  // adopt.rs: pub fn probe_child(layout: &Layout, role: &Role, timeout: Duration) -> Probe  (probe_core becomes a call of it)
  ```
  The main thread holds `BTreeMap<String, Monitor>`. `daemon.status` output is byte-identical for a core-only supervisor.

- [ ] **Step 1: Write the failing unit tests:** `next_due_prefers_a_start_request_then_the_earliest_restart`, `role_method_names`, `core_endpoints_match_the_old_paths` (posix and windows strings).
- [ ] **Step 2: Run** → FAIL (types missing).
- [ ] **Step 3: Refactor.** No test outside the new unit tests may change.
- [ ] **Step 4: Run** Green; `supervisor`, `supervisor_children`, `adoption`, `daemon`, `firstaid` tests unchanged and PASS; kill soak once.
- [ ] **Step 5: Commit** `refactor(supervisor): children as role slots with their own backoff (no behaviour change)`.

---

### Task 7: Module manifest schema, graph, API-version policy

**Files:**
- Create: `packages/module-api/schema/manifest.schema.json`, `packages/module-api/fixtures/manifest-cases.json`, `packages/module-api/src/manifest.ts`, `packages/module-api/test/manifest.test.ts`, `crates/plur1bus/src/modules/{mod,manifest,graph}.rs`
- Modify: `packages/module-api/package.json` (`ajv`, `@plur1bus/rpc-schema` dependencies; `files` adds `schema`), `packages/module-api/src/index.ts`, `crates/plur1bus/Cargo.toml` (`jsonschema` into `[dependencies]`), `crates/plur1bus/src/main.rs` (`mod modules`)

**Interfaces:**
- Manifest (`module.json`, draft 2020-12, closed): `name` `^[a-z][a-z0-9-]{0,62}$`; `version` semver; `apiVersion` `^[1-9][0-9]*$`; `entry` relative path; `needs`, `provides`, `consumes`, `implements`: arrays of `^[a-z][a-z0-9.-]{0,63}$`, unique; `extensionPoints`: map to `"chain"|"collect"`; `scope`: `"installation"|"agent"`; `restart`: `"on-failure"|"always"|"never"` (default `on-failure`); `lifeline`: boolean (default `true`); `priority`: integer 0–999; `configSchema?`: object. Required: `name`, `version`, `apiVersion`, `entry`, `scope`, `priority`.
- Rust:
  ```rust
  pub const MODULE_API_VERSION: u32 = 1;
  pub const RESERVED_NAMES: &[&str] = &["core", "supervisor"];
  pub const CORE_PROVIDES: &[&str] = &["memory", "agent", "jobs", "events"];  // resolves `consumes`
  pub fn api_version_supported(v: &str, current: u32) -> bool;               // B12
  pub fn current_api_version() -> u32;                                        // PLUR1BUS_MODULE_API_CURRENT under test internals
  pub struct Manifest { pub name: String, pub version: String, pub api_version: String, pub entry: String, pub needs: Vec<String>,
    pub provides: Vec<String>, pub consumes: Vec<String>, pub implements: Vec<String>, pub extension_points: BTreeMap<String, String>,
    pub scope: String, pub restart: String, pub lifeline: bool, pub priority: u16, pub config_schema: Option<Value> }
  pub fn parse_manifest(raw: &str) -> Result<Manifest, Vec<String>>; // schema, then reserved names, entry normalised inside the dir
  pub struct Installed { pub name: String, pub dir: PathBuf, pub manifest: Result<Manifest, Vec<String>> }
  pub fn scan(layout: &Layout) -> Vec<Installed>;                     // modules/*/module.json, sorted by directory name
  pub fn band(priority: u16) -> &'static str;                         // foundation|core-services|services|aggregators|orchestration|add-ons (D14)
  pub struct Graph { pub nodes: Vec<Value>, pub edges: Vec<Value>, pub cycles: Vec<Vec<String>>, pub unresolved: Vec<Value> }
  pub fn graph(mods: &[Installed]) -> Graph;   // node {name, version, priority, band, scope, extensionPoints, valid}; edge {from, to, kind: "needs"|"consumes", capability?}
  pub fn start_order(mods: &[Installed]) -> Vec<String>; // valid, not in a needs-cycle, needs resolved: topological, then priority, then name
  ```
  A directory whose name differs from the manifest's `name` is invalid (`name-mismatch`). An unresolved `needs` is an error that keeps the module out of `start_order`; an unresolved `consumes` is listed only.
- TS: `export const MODULE_API_VERSION = 1; export function apiVersionSupported(v: string, current?: number): boolean; export function validateManifest(v: unknown): { ok: true; manifest: ModuleManifest } | { ok: false; errors: string[] }` plus the `ModuleManifest` type.

- [ ] **Step 1: Write the failing tests.** The shared fixture holds at least: the spec §4 example (valid), missing `apiVersion`, `priority: 1000`, `scope: "global"`, an unknown field, `extensionPoints` value `"parallel"`, `name: "core"`, `entry: "../x.js"`, `entry: "/abs.js"`. Rust `manifest_cases_match_the_shared_fixture` and TS `manifest cases match the shared fixture` assert the same `valid` verdict per case. Rust unit tests: `api_version_policy` (current 1 accepts only `"1"`; current 2 accepts `"1"` and `"2"`; rejects `"0"`, `"3"`, `"01"`, `"x"`), `band_boundaries` (99, 100, 299, 300, 499, 500, 999), `needs_cycle_is_reported_and_excluded_from_start_order`, `unresolved_needs_blocks_unresolved_consumes_is_listed`, `consumes_memory_resolves_to_core`, `start_order_is_topological_then_priority_then_name`, `directory_name_must_match`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** The Rust validator is built once (`OnceLock`) from `include_str!("../../../../packages/module-api/schema/manifest.schema.json")`.
- [ ] **Step 4: Run** → PASS; Green.
- [ ] **Step 5: Commit** `feat(modules): D14 manifest schema, dependency graph and module API version policy (G3 groundwork)`.

---

### Task 8: Module runtime in `@plur1bus/module-api`; module control methods; the fixture module

**Files:**
- Create: `packages/module-api/src/{runtime,control-server,paths,lock}.ts`, `packages/module-api/test/{runtime,control-server,paths}.test.ts`, `packages/module-fixture/{package.json,module.json,README.md,src/index.ts,test/fixture.test.ts}`
- Move: `packages/core/src/orphan-watch.ts` → `packages/module-api/src/orphan-watch.ts` (and its test); `packages/core/src/lock.ts` keeps `acquireCoreLock`, now a wrapper over module-api's `acquireExclusiveLock`
- Modify: `packages/rpc-schema/schema/rpc.schema.json` (methods `module.auth`, `module.status`, `module.adopt`, `module.shutdown` with `x-server: "module"`; `$defs/ModuleStatus`), `packages/rpc-schema/src/index.ts` (`RpcServerRole = "core" | "supervisor" | "module"`, `METHODS_BY_SERVER.module`), `packages/module-api/src/{client,index}.ts` (`endpoint: "module"`), `crates/plur1bus-rpc/src/{client,capabilities}.rs` (`Endpoint::Module`, auth method `module.auth`, `capabilities("module", …)`), `crates/plur1bus/src/paths.rs` (`module_address`), `packages/core/src/core.ts` (imports)
- Test: `packages/rpc-schema/test/schema.test.ts`, `crates/plur1bus-rpc/tests/capabilities.rs`, `crates/plur1bus/src/paths.rs` unit tests

**Interfaces:**
- Schema: `module.auth { token }` → `{ rpc, instanceId, pid, module: { name, version, apiVersion }, capabilities? }`; `module.status {}` → `ModuleStatus { process, name, version, apiVersion, instanceId, pid, uptimeMs, core: "connected"|"reconnecting"|"not-needed", detail?: object }`; `module.adopt { nonce }` → `{ status: ModuleStatus }`; `module.shutdown { budgetMs? (0–120000) }` → `{ accepted: true }`. `MODULE_FEATURES = ["adoption", "lifelines"]`.
- TS:
  ```ts
  export interface ModuleContext { name: string; home: string; instanceId: string; signal: AbortSignal; logger: HarnessLikeLogger;
    config(): Record<string, unknown>;                       // modules.<name> from watchSupervisorConfig (Task 5), {} before the first snapshot
    onConfig(fn: (c: Record<string, unknown>) => void): () => void;
    core(): CoreClient | null;                               // when manifest.needs includes "core": reconnecting client, fresh run/core.token per attempt, backoff 250 ms → 5 s
    setDetail(d: Record<string, unknown>): void }            // module.status.detail
  export interface ModuleDefinition { start(ctx: ModuleContext): Promise<{ stop(o: { budgetMs: number }): Promise<void> }> }
  export function runModule(def: ModuleDefinition, argv?: string[]): Promise<never>;
  export function moduleAddress(home: string, name: string, platform?: NodeJS.Platform): string; // role "module-<name>", same hash rule as the core
  export function acquireExclusiveLock(path: string): { release(): void } | null;              // node:sqlite BEGIN EXCLUSIVE; null when held
  export function createControlServer(o: { address: string; token: string; hello: () => object; handlers: Record<string, (p: any, ctx: { connectionId: string }) => Promise<unknown>>;
    onConnectionClosed?: (id: string) => void; authIdleMs?: number }): { listen(): Promise<void>; close(): Promise<void> };
  ```
  `runModule` flags: `--home <p> --module <name> --lifeline stdin --instance <uuid>`. Sequence: read and validate `modules/<name>/module.json` (exit 2 on failure) → lock `run/module-<name>.lock` (held → exit 3) → config watch (file fallback as in B7) → `def.start(ctx)` → write token and pid files (0600) → listen → lifeline from stdin. Lifeline loss → `orphaned`, keep running; grace from `supervisor.graceMs`; expiry → `stop` → exit 0. `module.adopt` compares the nonce with `run/supervisor.token` (`timingSafeEqual`, 64 hex) exactly like `core.adopt`. `module.shutdown` and SIGTERM → `stop({ budgetMs })`, run files removed, exit 0. Logs: `logs/module-<name>.log` (JSON lines, rotated by `logs.*`). Params are validated with `validateParams` from `@plur1bus/rpc-schema`.
- Rust: `pub fn module_address(home: &Path, platform: &str, name: &str) -> String`.
- Fixture (`packages/module-fixture`, private): build bundles `src/index.ts` with module-api inlined into `dist/index.js` (esbuild without `--packages=external`) and copies `module.json` and `README.md` into `dist/`. Manifest: `name "fixture"`, `version "0.1.0"`, `apiVersion "1"`, `entry "index.js"`, `needs ["core"]`, `provides ["fixture.echo"]`, `consumes ["memory"]`, `extensionPoints { "collect-status": "collect" }`, `scope "installation"`, `priority 500`, `configSchema` with `greeting: string` and `crashAfterMs: integer ≥ 0`. Behaviour: `setDetail({ greeting })`; `crashAfterMs` → exit 1 after that many ms. README per the D14 convention (AGENTS.md "Module README convention").

- [ ] **Step 1: Write the failing tests.**
  - rpc-schema: `module.auth capabilities list only module-served methods`; Rust `capabilities_module_lists_only_module_methods`.
  - paths: TS and Rust `module address parity` (`/tmp/p1b` → `/tmp/p1b/run/module-fixture.sock`; `C:\Users\A B\AppData\Local\PLUR1BUS` → the same `\\.\pipe\plur1bus-<hash16>-module-fixture` string, hash computed in the test from the rule).
  - control-server.test: `a request before module.auth is E_UNAUTHORIZED auth-required`, `a wrong token closes the connection`, `unknown params are E_INVALID_PARAMS`, `an unauthenticated connection closes after authIdleMs`.
  - runtime.test (spawns `packages/module-fixture/dist/index.js` against a temp home with the manifest installed): `a second instance exits 3 while the lock is held`; `stdin EOF orphans and grace expiry exits 0 and removes the run files` (graceMs 1000); `module.adopt with the supervisor token re-attaches and cancels the grace`; `a wrong nonce is E_UNAUTHORIZED adopt-nonce`; `module.shutdown exits 0`; `a manifest with a different name exits 2`.
  - fixture.test: `status.detail reports the configured greeting`, `crashAfterMs exits 1`.
  - Core tests stay green after the move (`orphan-watch.test.ts` now in module-api).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** the schema, the runtime pieces, the move, `Endpoint::Module`, and the fixture package.
- [ ] **Step 4: Run** → PASS; Green; `pnpm docs:gen`.
- [ ] **Step 5: Commit** `feat(module-api): runModule — control endpoint, lock, lifeline, adoption (B9); fixture module`.

---

### Task 9: The supervisor runs modules; `module.state`; `1staid modules.state`; criterion 5

**Files:**
- Create: `crates/plur1bus/tests/modules.rs`
- Modify: `packages/rpc-schema/schema/rpc.schema.json` (`ChildStatus.kind?: "core"|"module"`; method `module.watch`; notification `module.state { name, process, pid, instanceId }`, both `x-server: "supervisor"`), `crates/plur1bus/src/supervisor/{mod,child,adopt,server,state}.rs`, `crates/plur1bus/src/commands/{daemon,firstaid}.rs`

**Interfaces:**
- Consumes: Task 6 slots, Task 7 `scan`/`start_order`/`current_api_version`, Task 8 module endpoint and fixture, Task 4 `Subscribers`.
- Produces:
  ```rust
  pub fn module_spec(layout: &Layout, m: &Installed, instance_id: &str) -> Result<ChildSpec, String>; // node <dir>/<entry> --home --module --lifeline stdin --instance; cwd = dir
  // state.rs CrashReason gains ManifestInvalid ("manifest-invalid") and ApiVersionUnsupported ("api-version-unsupported").
  // Stopped reasons (not crashes): "disabled", "scope-agent-unsupported", "stopped-by-request".
  ```
  At supervisor start, after the core: `scan`, then for each name in `start_order`: disabled (`modules.<name>.enabled == false`) → `stopped` reason `disabled`; `scope: "agent"` → `stopped` reason `scope-agent-unsupported`; unsupported `apiVersion` → `crashed` `api-version-unsupported`; otherwise `probe_child` → adopt (`module.adopt`) or spawn. Modules left out of `start_order` (invalid, cycle, unresolved `needs`) get a slot `crashed` `manifest-invalid` with `detail` from the manifest errors or graph. A handshake whose `module.name`/`module.apiVersion` differ from the manifest is `Foreign` and terminated through the pinned peer. Health polls `module.status`; `restart: "never"` → no restart; `"always"` → also after a clean exit. `daemon.stop`: modules in reverse start order, then the core, all inside one deadline. Each health change broadcasts `module.state` on `Topic::Modules`. `daemon status` human output prints one line per child with its kind.
- `1staid check modules.state` (inserted after `core.lock`; `CHECK_IDS` becomes 15): no modules or all ready/stopped-by-config → `ok`; restarting, orphaned or degraded → `warn`; fatal, given up, `manifest-invalid` or `api-version-unsupported` → `fail` with `detail.modules`.

- [ ] **Step 1: Write the failing tests** (`tests/modules.rs`: fake core, fixture copied into `<home>/modules/fixture/`, scale 0.02 unless stated):
  - `an_installed_module_is_spawned_after_the_core_and_becomes_ready` (`children` = `[core, fixture]`, `kind == "module"`, `process.state == "ready"`)
  - `a_crashing_module_backs_off_and_the_core_is_untouched` (`modules.fixture.crashAfterMs = 200` → `restarts ≥ 2`, `nextRestartAt` growing, core pid unchanged)
  - `a_module_that_crashes_at_start_gives_up_after_five_and_the_core_is_untouched` (Review Focus 3: entry replaced by `process.exit(1)` → `crashed`, `nextRestartAt null`; `1staid check` `modules.state` fail, exit 1; core `ready`)
  - `a_supervisor_restart_within_grace_adopts_the_module` (module pid unchanged, `adopted == true`)
  - `invalid_disabled_and_agent_scoped_modules_are_listed_not_spawned`
  - `module_api_versions_run_side_by_side` (`PLUR1BUS_MODULE_API_CURRENT=2`: copies named `fixture` with `"2"` and `fixture-b` with `"1"` both `ready`; `fixture-c` with `"3"` → `api-version-unsupported`)
  - `a_module_reporting_another_name_is_terminated_as_foreign`
  - `module_state_notifications_reach_a_watcher`
  - `daemon_stop_stops_modules_before_the_core` (module exit precedes the fake core's `shutdown` event)
  - firstaid unit tests for `modules.state` (ok / warn / fail cases).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; Green; kill soak once (no module installed: behaviour unchanged).
- [ ] **Step 5: Commit** `feat(supervisor): run, watch, back off and adopt modules in dependency order (spec §6.4, D14, criterion 5, G3)`.

---

### Task 10: `module` commands; `modules.<name>` config; module restart execution; criteria 4 (module) and 12

**Files:**
- Create: `crates/plur1bus/src/modules/install.rs`, `crates/plur1bus/src/commands/module.rs`, `crates/plur1bus/tests/module_cmd.rs`, `tests/system/modules.test.ts`
- Modify: `packages/rpc-schema/schema/rpc.schema.json` (supervisor methods `module.list|start|stop|restart|graph|install|uninstall`), `packages/config-schema/schema/config.schema.json` (`modules`), `packages/config-schema/src/index.ts` and `crates/plur1bus-config/src/lib.rs` (`module:$key`), `packages/config-schema/fixtures/*` (regenerated, two new restart-plan cases), `crates/plur1bus/src/supervisor/{mod,server,config}.rs`, `crates/plur1bus/src/cli.rs` (`Module { sub: ModuleCmd }` replaces the stub), `crates/plur1bus/src/main.rs`, `.github/workflows/ci.yml`

**Interfaces:**
- Config schema: `"modules": { "type": "object", "default": {}, "x-restart": "live", "x-tier": "advanced", "additionalProperties": { "type": "object", "x-restart": "module:$key", "properties": { "enabled": { "type": "boolean", "default": true } }, "additionalProperties": true } }`. Both resolvers replace `$key` with the map key of the level that matched, so `modules.fixture.greeting` → `module:fixture`, and the plan's `restart.modules == ["fixture"]`.
- Supervisor methods (`x-server: "supervisor"`):
  - `module.list {}` → `{ modules: [{ name, version: string|null, apiVersion: string|null, priority: integer|null, band: string|null, scope: string|null, provides, consumes, needs, enabled, errors: string[], child: ChildStatus|null }] }`
  - `module.start|stop|restart { name, budgetMs? }` → `{ accepted: true, name }`; `E_MODULE_UNKNOWN`; `E_NOT_AVAILABLE` with reason `manifest-invalid`, `api-version-unsupported`, `scope-agent-unsupported` or `disabled`. `stop` sets `stopped-by-request` until `start` or a supervisor restart (B13).
  - `module.graph {}` → `Graph` as JSON.
  - `module.install { path }` → `{ name, version, replaced: boolean }`; `module.uninstall { name }` → `{ name, removed: true }`.
  ```rust
  // modules/install.rs — shared by the supervisor and the offline CLI
  pub fn install(layout: &Layout, src: &Path) -> Result<(Manifest, bool /*replaced*/), InstallError>;  // B14
  pub fn uninstall(layout: &Layout, name: &str) -> Result<(), InstallError>;
  pub enum InstallError { NotADirectory, Manifest(Vec<String>), Symlink(PathBuf), EntryOutside, Reserved, Io(String) }
  ```
  Running supervisor: install stops a running module of that name, swaps directories, and starts it when it was running or is newly enabled; uninstall stops, then removes. Restart jobs (Task 5) now carry `restart.modules`, executed in B8 order; a `modules.<name>` change is validated against the manifest's `configSchema` in `config::set` and in the watcher. `enabled: false` stops, `true` starts. `SUPERVISOR_FEATURES` adds `"config"` and `"modules"` (sorted).
- CLI: `module list`, `module graph` (human: an indented tree by band, then cycles and unresolved), `module install <path>`, `module uninstall <name> [--yes]`, `module start|stop|restart <name>`. Without a supervisor, `list`/`graph`/`install`/`uninstall` run locally (`child: null`); `start`/`stop`/`restart` fail `E_NOT_AVAILABLE reason=supervisor-not-running`, exit 1.

- [ ] **Step 1: Write the failing tests.**
  - config-schema (TS) and plur1bus-config (Rust): new fixture cases `modules.fixture.greeting changes → modules ["fixture"]` and `adding modules.fixture-b → modules ["fixture-b"]`; `restartClassOf("modules.x.enabled") === "module:x"`.
  - `tests/module_cmd.rs`:
    - `install_then_list_and_graph_show_the_fixture_without_code_changes` (criterion 12: offline install from `PLUR1BUS_FIXTURE_MODULE`; `list` shows `fixture 0.1.0`, priority 500, band `add-ons`, scope `installation`; `graph` has edges `fixture → core` (`needs`) and `fixture → core` (`consumes`, capability `memory`), and the fixture node's `extensionPoints` is `{ "collect-status": "collect" }`; then `daemon start` with the fake core → fixture `ready`)
    - `install_refuses_escaping_entries_symlinks_and_reserved_names_and_copies_nothing` (Review Focus 5; unix symlink case `#[cfg(unix)]`; `modules/` listing unchanged)
    - `reinstall_replaces_and_restarts_a_running_module` (new pid, new version in `list`)
    - `stop_start_restart_by_name` (stop → `stopped` and stays so for 3 s at scale 0.02; start → `ready`; restart → new pid; unknown name → `E_MODULE_UNKNOWN`, exit 1)
    - `start_without_a_supervisor_is_supervisor_not_running`
    - `graph_reports_cycles_and_unresolved` (two synthetic manifests needing each other, one needing `missing`)
    - `a_module_key_change_restarts_only_that_module` (criterion 4 module part: `config set modules.fixture.greeting '"hi"' --yes` → `restart.modules == ["fixture"]`, `restarted == ["fixture"]`, fixture pid changed, core pid same, `module.status.detail.greeting == "hi"` through `module list`)
    - `a_module_config_violating_its_config_schema_is_rejected` (`crashAfterMs: -1` → `E_CONFIG_INVALID`)
    - `disabling_by_config_stops_the_module_and_enabling_starts_it`
    - `uninstall_stops_and_removes_but_keeps_the_config`
  - `tests/system/modules.test.ts` (real core, flat-embedder-cold for a slow first recall): `module restart while a recall is in flight` (criterion 5: start `memory recall` asynchronously, run `module restart fixture` → the recall answers, fixture pid changed, core pid same); `config restart classes with a real module` (criterion 4 module part on the real stack).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** the config namespace and resolvers, `install.rs`, the supervisor methods, module restart jobs, the CLI. Add the system file to `ci.yml`.
- [ ] **Step 4: Run** → PASS; Green; `pnpm docs:gen`.
- [ ] **Step 5: Commit** `feat(cli,supervisor): module list/start/stop/restart/graph/install/uninstall; modules.<name> config restarts only its module (criteria 4, 5, 12; B13, B14)`.

---

### Task 11: Admin ops over RPC and CLI

**Files:**
- Create: `packages/core/src/admin-ops.ts`, `packages/core/test/admin-ops.test.ts`, `crates/plur1bus/src/commands/admin.rs`, `tests/system/admin.test.ts`
- Modify: `packages/rpc-schema/schema/rpc.schema.json` (six methods, `x-server: "core"`), `packages/core/src/rpc/methods.ts`, `packages/core/src/core.ts` (refresh `storeSchema` after a migration), `crates/plur1bus/src/{cli,main}.rs` (`Admin { sub: AdminCmd }`), `packages/webmcp/src/provider.ts` (`FORBIDDEN_PREFIX` gains `"admin."`), `.github/workflows/ci.yml`
- Test: `packages/webmcp/test/provider.test.ts`

**Interfaces:**
- Schema:
  - `admin.obsidian.detect { caller, agentId, candidates?: string[] (≤ 32) }` → `{ agentId, vaults: [{ path, isVault, confirmed, source: "config"|"workspace"|"candidate" }] }`
  - `admin.obsidian.prepare { caller, agentId, vaultPath }` → `{ nonce, expiresAt, vaultPath, vaultDigest }`
  - `admin.obsidian.confirm { caller, agentId, nonce }` → `{ confirmed: true, vaultPath, vaultDigest, alreadyConfirmed }`
  - `admin.migrate { from, to }` (decimal strings) → `{ from, to, applied }`
  - `admin.embedding.probe { refresh?: boolean }` → `{ ok, error?, cached, identity: { fingerprintId, provider, model, dimensions }, durationMs, checkedAt }`
  - `admin.embedding.serve { address?: { kind: "abstract-socket"|"unix-socket"|"named-pipe", address } | null }` → `{ address: object|null, tokenPath: string|null, identity: object|null }` (omitted → the engine's platform default; `null` → stop serving)
  ```ts
  export const ADMIN_METHODS = ["admin.obsidian.detect", "admin.obsidian.prepare", "admin.obsidian.confirm", "admin.migrate",
    "admin.embedding.probe", "admin.embedding.serve"] as const;
  export function buildAdminMethods(d: { engine: Engine; agents: AgentRegistry; logger: HarnessLogger; isStopping: () => boolean;
    onMigrated: () => void }): Record<(typeof ADMIN_METHODS)[number], Handler>;
  ```
  Principal and agent context exactly as the memory ops (`callerToPrincipal`, `AGENT_CONTEXT_CLI`: `origin "user"`, `background false`). Engine `MemoryOpError`s map through `mapMemoryOpError` (`not-found` → `E_NOT_FOUND`, `denied` → `E_DENIED`, `invalid-input` → `E_INVALID_PARAMS`, `conflict` → `E_CONFLICT`, `storage` → `E_STORAGE`). A stopping core refuses with `core-stopping` like the memory ops. Results are projected onto the closed shapes. The probe's `signal` is the core's shutdown signal plus a 30 s timeout.
- CLI: `admin obsidian detect --agent A [--candidate P]…`, `admin obsidian prepare --agent A <vault>`, `admin obsidian confirm --agent A <nonce>`, `admin migrate --from N --to M [--yes]` (asks on a TTY; `--yes` otherwise, like `config set`), `admin embedding probe [--refresh]`, `admin embedding serve [--stop]`. Every `about` starts with `[experimental] `.

- [ ] **Step 1: Write the failing tests.**
  - admin-ops.test (`createCore` with the flat embedder): `obsidian detect, prepare and confirm round trip` (temp vault with `.obsidian/app.json` as candidate → `isVault`; prepare → nonce; confirm → `confirmed`, then detect shows `confirmed: true`); `an unknown agent is E_AGENT_UNKNOWN`; `a wrong nonce maps the engine's code`; `migrate from a version that is not current is E_CONFLICT`; `migrate current to current answers applied false`; `embedding.probe answers ok with 384 dimensions`; `embedding.serve null answers address null`; `a malformed address is E_INVALID_PARAMS`; every result passes `validateResult`.
  - provider.test: `admin methods are never offered as WebMCP tools`.
  - `tests/system/admin.test.ts`: `admin embedding probe --json carries schema admin.embedding.probe/1`, `admin migrate without --yes in a non-interactive shell exits 2 and changes nothing`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** Add the system file to `ci.yml`.
- [ ] **Step 4: Run** → PASS; Green; `pnpm docs:gen`.
- [ ] **Step 5: Commit** `feat(core,cli): admin ops over RPC — obsidian, migrate, embedding probe/serve (E2/E3 surface, B15)`.

---

### Task 12: ADR records, `docs/module-guide.md`, AGENTS.md

**Files:**
- Create: `docs/module-guide.md`
- Modify: `docs/adr/ADR-012-process-model-and-languages.md`, `docs/adr/ADR-013-configuration-and-restart-classes.md`, `docs/adr/ADR-016-api-stability-and-versioning.md`, `AGENTS.md`

- [ ] **Step 1: ADR-012.** A "2a-H3b-a" implementation record: §10.11 closed (B2, `journalReplay`, stop behaviour, the deviation row for spec §6.3's order) and H3-R24 closed by Task 1 (`<E41_SHA>`); module processes (B9–B12, the `CrashReason` additions `manifest-invalid` and `api-version-unsupported` and the stopped reasons); restart jobs and `restartPending` (B7, B8); launchd (B16, replacing the §10.7 "known, accepted gap" paragraph); the Windows `RestartOnFailure` evidence from the latest CI run of `service_real::the_os_restarts_a_killed_supervisor` on `windows-2025` (quote the run, or say it has still not run). Update the Status line, §8 "still deferred" and "Revisit when".
- [ ] **Step 2: ADR-013.** Record §4 steps 4–6 and §5 as implemented (B3–B8), the watcher and revision rules, the CLI routing, §6's live appliers per key, the `modules` namespace and `module:$key` (B13). Remove the two H1 deviation rows that no longer apply.
- [ ] **Step 3: ADR-016.** G3 closed (B12 and the side-by-side test); `x-server: "module"`; supervisor notifications; the 1.3.0 additive surface list; extension points declared but not advertised (B11).
- [ ] **Step 4: `docs/module-guide.md`** (spec §5): manifest fields with the band table, `runModule` and `ModuleContext`, lifecycle (lock, run files, lifeline, grace, adoption), configuration under `modules.<name>` and `configSchema`, the API-version policy, the README and per-module `AGENTS.md` convention, and how to run a module in isolation. AGENTS.md: the commands that are now real, the `x-server` and `module:$key` conventions, the new seams (`PLUR1BUS_MODULE_API_CURRENT`, `PLUR1BUS_FIXTURE_MODULE`, `FAKE_CORE_RESTART_PENDING`), `packages/module-fixture` in the layout table, and the stubs still labelled `2a-H3b` (`setup`, `update`, `1staid repair`).
- [ ] **Step 5: Run** `pnpm docs:check` and `pnpm lint`.
- [ ] **Step 6: Commit** `docs: 2a-H3b-a implementation records — replay while serving, config ownership, modules, admin ops`.

---

## 2a-H3b-b — outline (own full plan after 2a-H3b-a merges)

Same Global Constraints; builds on 2a-H3b-a. Tasks named, not detailed:

1. **H3b-b-1 `setup` installer** (spec §6.5, D29, ADR-006): state root; the pinned Node runtime for the five targets, verified against SHA-256 values baked into the binary (Node's own `SHASUMS256.txt` for the pinned version); the core payload per target (verified against a hash baked at release build time; `--core-from <dir|tar.gz>` for development and CI); config defaults through `config.set` when a supervisor runs; basic-tier questions only (G4) with the ADR-006 embedding use-class and the audit-logged NC-licence gate; skill copy; `service install`; start; `1staid check`. Flags `--non-interactive`, `--accept-nc-licence`, `--no-service`. `install.sh` and `install.ps1` one-liners. Decide the HTTPS client crate and archive handling there (budget: setup only, never the supervisor).
2. **H3b-b-2 `update --check`** — `root/manifest.json` written by `setup` (binary, core and module versions, `apiVersion`s) against a release manifest; lists the units that would restart, using Task 10's restart-plan vocabulary.
3. **H3b-b-3 `1staid repair [--yes] [--dry-run]` and installer checks** — new checks `runtime.node` (presence, hash), `runtime.core`, `models.cache`; repair steps: fix `run/` permissions, remove stale sockets and pid files, `config.json` against its backup and `config.json.rejected-*`, re-download the runtime, renew the service, terminate a hung core or module by pinned peer after confirmation, `admin.migrate` (Task 11) for a store-schema mismatch (G5), and detection of a launchd restart loop. The `--dry-run` document is a plan of steps (`id`, `action`, `target`, `needsConfirmation`, `risk`) laid out to match the owner's design canvas for the repair flow.
4. **H3b-b-4 Operations skill** — `skills/plur1bus-harness/SKILL.md`, `docs/operations.md`, and the freshness test (criterion 10): every named command exists and supports `--json`. Covers `module …`, `config …` with `x-restart`, and `admin …`.
5. **H3b-b-5 Release and exit** — release workflow (`cargo-zigbuild`, five targets, per-target core payloads, release manifest), macOS signing and notarisation from GitHub secrets, the B1/B8/B9/B11 baseline report on the five targets (reference hardware per H3-R26), CHANGELOG, `docs/milestones.md`, the demo guide (spec §12).
6. **H3b-b-6 ADR records** for the above.

---

## Self-review (done while writing)

- **Spec coverage:**
  - §6.1 one owner, `config.get|set|watch`, watcher, apply sequence → Tasks 4 and 5 (module restarts → Task 10). §6.2 supervisor methods and notifications → Tasks 4, 9 and 10. §6.3 lifecycle → Task 2 (amended by B2). §6.4 spawn/monitor/backoff/lifeline/adoption for modules → Tasks 8 and 9. §6.6 `config`, `module`, `module graph` → Tasks 4 and 10. D14 manifest and bands → Task 7. D3 → Tasks 5 and 10.
  - Criteria: 4 → Tasks 5 (live, core, dry run, invalid) and 10 (module); 5 → Tasks 9 and 10; 12 → Task 10; 2 (must not regress) → Tasks 1, 2, 6 and 9 run the soak.
  - ADR-016 G3 → Tasks 7 and 9. ADR-013 §4/§5 → Tasks 4 and 5. H3b-7 admin ops → Task 11 (D55: WebMCP forbids `admin.*`).
  - Parked items: E4.1 pin and soak tolerance → Task 1; replay while serving → Task 2; host/journal temp dirs → Task 2; launchd unbounded restart → Task 3; Windows console flash and `%` → no change (both documented as unfixable or refused in ADR-012 §10.7); `RestartOnFailure` evidence → Task 12; repair dry run for the design canvas → H3b-b-3.
- **Type consistency:** `revision`/`set_many` (Task 4) are used by Tasks 5 and 10. `Subscribers`/`Topic` (Task 4) carry `module.state` in Task 9. `watchSupervisorConfig` (Task 5) is used by `runModule` (Task 8). `RestartJob` (Task 5) carries modules in Task 10. `Role`/`Slot`/`probe_child`/`Layout::endpoints` (Task 6) are used in Task 9. `Installed`/`scan`/`start_order`/`graph`/`current_api_version` (Task 7) are used in Tasks 9 and 10. `Endpoint::Module`, `module_address`, `ModuleStatus` (Task 8) are used in Task 9. `JournalReplayStatus` (Task 2) feeds 1staid and the soak.
- **Review Focus:** each line names a test in its owning task (Tasks 2, 4, 9 and 10).
