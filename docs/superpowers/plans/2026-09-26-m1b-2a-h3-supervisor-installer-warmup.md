# M1b-2a-H3a — Supervisor, lifelines, adoption, OS service, `1staid check`, kill soak, model warm-up — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Scope note.** Ruling G1 of plan 2a-H2 moved the supervisor, installer, `1staid`, soak, Windows ACL, model warm-up and admin ops into "2a-H3". Together that is too much for one reviewable plan, so it is split (ruling S1): **this document is 2a-H3a, written in full** (16 tasks). **2a-H3b** (supervisor-owned config, modules, `setup` installer, `update --check`, `1staid repair`, admin ops over RPC, operations skill) is an outline with named tasks at the end; it gets its own full plan after 2a-H3a merges.

**Goal:** `plur1bus daemon start` (or the OS service manager) runs a small Rust supervisor. The supervisor spawns the core, watches it, and restarts it with backoff. If the supervisor dies and comes back within the grace window, it adopts the running core instead of restarting it. `plur1bus 1staid check` shows what is wrong. The core warms its models in the background and reports `models-warming` until they are ready. A 1 000-turn kill soak proves that no command blocks.

**Architecture:** The supervisor is a new hidden subcommand `plur1bus supervise` in the existing Rust binary: std threads, no async runtime. It serves JSON-RPC on `run/supervisor.sock` (or a named pipe with an explicit user-SID DACL on Windows), using methods defined in the same `rpc.schema.json` (RPC 1.2.0). A new annotation, `x-server`, records which process serves each method, so each handshake advertises only its own capabilities. The core gets a supervised mode: stdin is its lifeline, it enters `orphaned` on EOF, and `core.adopt` re-attaches it over an authenticated connection. The supervisor identifies the process behind a socket through OS peer credentials, never through a PID file. OS registration renders a systemd user unit, a launchd agent or a Task Scheduler XML. `1staid check` is a read-only CLI command that gathers checks from the filesystem, the supervisor and the core. Model warm-up consumes engine PR E4's readiness API, which is assumed below and adapted in the last tasks.

**Tech Stack:** Unchanged from 2a-H2 — Node 24.21 (ESM, `--experimental-strip-types`), TypeScript 5.9 (`erasableSyntaxOnly`), `node:test`, ajv 8, esbuild, pnpm 10; Rust 1.95, clap 4, serde_json, typify 0.8, jsonschema, assert_cmd. New Rust dependencies, and only these: `libc` 0.2 (unix: `setsid`, `kill`, peer credentials), `windows-sys` 0.59 (features `Win32_Foundation`, `Win32_Security`, `Win32_Security_Authorization`, `Win32_Storage_FileSystem`, `Win32_System_Pipes`, `Win32_System_IO`, `Win32_System_Threading`), `getrandom` 0.2 (tokens), `signal-hook` 0.3 (unix SIGTERM/SIGINT); dev-only `proptest` 1. Engine `@cyb3rb1ade/plur1bus-memory` pinned to `3a4426a59f0dca66f7da214f69e203754ce8280f` (contract 1.7.0) in Task 1, and to E4's merge commit in Task 13.

**Spec:** `docs/superpowers/specs/2026-09-24-m1b-2a-core-daemon-cli-design.md`. Binding sections: §4 (process model, supervisor role), §6.3 (lifecycle, model warm-up, `models-warming`), §6.4 (health states, spawn/monitor, backoff, lifeline/grace, locks, adoption, clients under core loss), §6.5 (service registration; `setup` is 2a-H3b), §6.6 rows `1staid check`, `daemon`, `service`, and §8 "Core killed mid-use" and "Supervisor killed, returns in 5 s". Also §10 criteria 2 (kill soak), 3 (reconnect not respawn), 8 (B1/B8/B11 must not regress) and 9 (service), and D11 and D12. Also binding: ADR-012 §1, §3, §4, §5 and §8 plus its deviations table; ADR-013 §5; ADR-016 §3 (capabilities in "both handshakes", ruling G2), §5 (deprecations "listed by `1staid check`") and G3 (side-by-side `apiVersion`, which goes to 2a-H3b with the loader). Engine contract: `/home/claude/work/plur1bus-m1b1/types/engine.d.ts` and `docs/engine-api.md` at `3a4426a5` ("probe()" — "The harness uses `probe()` as its embedding warm-up primitive").

---

## Repository, branch, and how to run anything

**Work repo (`$HARNESS`):** `/home/claude/PLUR1BUS-Harness` (`Cyb3rb1ade/PLUR1BUS-Harness`). Cut branch **`feat/m1b-2a-h3a`** from `main` at **`c26db5f`** or later, and bring in commit "test: gate shared-memory tests on the engine's platform support" from `fix/shared-memory-platform` if it has not merged by then. Create the worktree with the `superpowers:using-git-worktrees` skill. Every path below is relative to that worktree.

**Engine reference tree (`$ENGINE`):** `/home/claude/work/plur1bus-m1b1`. Read it with `git -C $ENGINE show <sha>:<path>`. This plan never changes it.

**Node:** `export PATH=/home/claude/.node24/bin:$PATH` (`node -v` → `v24.21.0`).

**Green** means all of:

```bash
pnpm install --frozen-lockfile && pnpm gen && pnpm build && pnpm lint && pnpm test \
  && cargo fmt --all -- --check && cargo clippy --workspace --all-targets -- -D warnings \
  && cargo test --workspace --no-fail-fast && pnpm docs:check
```

**One TS test file:** `cd packages/<pkg> && node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning --test --test-concurrency=1 test/<file>.test.ts`. **One Rust test:** `cargo test -p <crate> --test <file> <name> -- --nocapture`. **System tests** (Linux/macOS): `cargo build --release -p plur1bus && pnpm build && PLUR1BUS_BIN=target/release/plur1bus node --experimental-strip-types --test tests/system/<file>.test.ts`.

Run `pnpm gen` after touching either schema. Run `pnpm docs:gen` after touching the RPC schema, the config schema or any clap text, and commit the regenerated `docs/*.md`.

---

## Global Constraints

Every task's requirements implicitly include this section.

- **Commits:** `git -c user.name=Cyb3rb1ade -c user.email=84099452+Cyb3rb1ade@users.noreply.github.com commit …`. Every message body ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01SxcLhve6hyM9AFm2nU9B3F`. Never `git stash`, never `--amend`, never push, never change git config (use `-c` only).
- **No secrets, no real user data** in code, fixtures, logs or test names. Tokens are generated at test time. Agent ids (`bernd`, `anna`) and texts are synthetic. Every test uses its own temp home and never touches `~/.plur1bus`, the real user's systemd/launchd/Task Scheduler namespace, or a service name without the per-home suffix (S10).
- **CI green on Linux, macOS and Windows** (`.github/workflows/ci.yml`: unit job on `ubuntu-24.04`, `macos-15`, `windows-2025`; system job on Linux/macOS). The PR #2 Windows rules still apply: `fs.realpathSync` (never `.native`), `fileURLToPath`, `pnpm` through a shell, stop a core with `core.shutdown`/`core.stop()` and never `SIGTERM`, `replyAndClose` instead of `destroy()` after `write()`. POSIX-signal tests are `#[cfg(unix)]` or `{ skip: process.platform === "win32" }`.
- **Supervisor dependency budget** (spec §4: "no heavy dependencies and no reason to crash"): std threads plus the four crates named in Tech Stack. No tokio, no async runtime, no `sysinfo`, no `nix` (ruling S14). A supervisor panic is a bug: every thread body is wrapped so that a panic is logged to `logs/supervisor.log` and the supervisor exits 70, and the OS then restarts it (Task 8).
- **B1 stays < 100 ms p95** (`plur1bus --help`, criterion 8): supervisor, service and 1staid code runs only when its subcommand is chosen. No global statics with work at start-up. `pnpm bench` runs in the nightly and must not regress.
- **Engine pin exact:** full SHA in `packages/core/package.json`, no range, no `link:`. The core imports only `@cyb3rb1ade/plur1bus-memory/engine/create-engine.js` and `…/types/engine.js`. E4 members are feature-detected (S18) until Task 13 moves the pin.
- **No OpenClaw idiom** (`scripts/lint-hygiene.mjs` stays green; no slash-command strings in help text).
- **Closed params, closed error enum, projected results** as in 2a-H2. The Rust supervisor deserialises params into the typify-generated structs (`deny_unknown_fields` → `E_INVALID_PARAMS`). Every `daemon.*`/`supervisor.*` result is validated against the schema in tests (the `jsonschema` dev-dependency is already in `crates/plur1bus`).
- **CLI `--json`:** the raw RPC value (R13) plus one top-level `"schema": "<command>/<major>"` (ADR-016 §8, G15). New ids are `daemon.start/1`, `daemon.stop/1`, `daemon.restart/1`, `daemon.status/1`, `service.install/1`, `service.uninstall/1`, `service.status/1` and `1staid.check/1`. Every new CLI command's `about` starts with `[experimental] `. None is stable.
- **Versions:** RPC schema `1.2.0` (`$id` `https://plur1bus.dev/schema/rpc/1.2.0/rpc.schema.json`, `x-rpc-version`). `SUPPORTED_RPC_MAJOR` stays 1. Everything new is `x-stability: "experimental"`, `x-since: "1.2.0"`.
- **Test seams:** in-process core tests use `createCore({ home, testInternals: flatTestInternals(…) })`. Process tests use `PLUR1BUS_ALLOW_TEST_INTERNALS=1` + `PLUR1BUS_TEST_INTERNALS=flat-embedder`. Two supervisor seams exist, both honoured only when `PLUR1BUS_ALLOW_TEST_INTERNALS=1`: `PLUR1BUS_SUPERVISOR_TIME_SCALE=<float>` multiplies every supervisor duration (backoff, health interval, hang and kill thresholds, stable window), and the hidden flag `supervise --no-core`. The fake core for Rust tests is `crates/plur1bus/tests/fixtures/fake-core.mjs`, reached through the existing `PLUR1BUS_CORE_JS` / `PLUR1BUS_NODE` lookup (Task 6).
- **Clocks:** every supervisor duration is measured with `std::time::Instant`. Wall time appears only in reported `since`/`at` fields (epoch ms).
- **English** everywhere. Generated docs (`docs/rpc.md`, `docs/cli.md`, `docs/config.md`, `docs/config-engine-keys.md`) are never hand-edited.

## Review Focus

These are five inputs that the spec implies but that no acceptance criterion names. Each is pinned by a test in the owning task.

1. **Two starts racing** (the OS service manager and a manual `daemon start`, or two terminals): exactly one supervisor and exactly one core survive. The loser exits 3 with `supervisor already running (pid N)`, and no second core is ever spawned. → Task 5 `a_second_supervisor_on_the_same_home_exits_3`, Task 9 `concurrent_daemon_starts_leave_one_supervisor_and_one_core`.
2. **A home path with spaces and non-ASCII** (`C:\Users\Max Mustermann\AppData\Local\PLUR1BUS`, `/tmp/p1b sys ü`): the service unit, plist and task XML quote or escape it correctly, and the supervisor spawns the core with it intact. → Task 8 `renders_a_home_with_spaces_and_umlauts`, Task 6 `spawns_under_a_home_with_spaces`.
3. **Stale run files after a power loss** (`run/core.sock`, `run/core.pid`, `run/supervisor.sock`, `run/supervisor.pid` present, no process alive): `supervise` starts normally, replaces the stale sockets and spawns a core. `1staid check` reports the stale files as `warn` before the start and `ok` after it. → Task 5 `stale_supervisor_socket_is_replaced`, Task 7 `a_stale_core_socket_probes_absent`, Task 11 `stale_run_files_are_a_warning`.
4. **A core that cannot start because `config.json` is invalid** (exit 2) or because the engine contract is unsupported (exit 4): the supervisor marks it `crashed` at once with `reason: "config-invalid"` or `"engine-contract"`, and never restarts it in a loop. The state is visible in `daemon status` and in `1staid check`. → Task 4 `classify_exit_follows_s9`, Task 6 `exit_code_2_is_fatal_config_invalid`.
5. **A laptop that slept, or one slow health reply**: a single late or failed `core.status` must not kill a healthy core. The supervisor needs three consecutive failures before `degraded(unresponsive)`, and a hang is measured on the monotonic clock. → Task 6 `one_late_health_reply_does_not_degrade_or_kill`.

---

## Rulings on spec gaps (binding for this plan)

| # | Gap | Ruling |
|---|---|---|
| S1 | G1 puts about ten subsystems into "2a-H3". | Split. **2a-H3a** (this plan): supervisor and its handshake, core supervised mode, adoption, `daemon`, `service`, Windows ACL, `1staid check`, kill soak, model warm-up, shared-memory status. **2a-H3b** (outline at the end): supervisor ownership of `config.json`, the module loader and `module …`, `setup`, `update --check`, `1staid repair` plus installer checks, admin ops over RPC, the operations skill. |
| S2 | Spec §6.2 calls the child-side adoption call `daemon.adopt` and files it under the supervisor methods. The schema has one method namespace for two servers. | Every method carries `x-server: "core" \| "supervisor"`. `buildCapabilities(features, server)` lists only the methods and notifications of that server. The method a supervisor calls on the core is **`core.adopt`** (`x-server: "core"`); 2a-H3b adds `module.adopt` for modules. The supervisor serves `supervisor.auth`, `daemon.status`, `daemon.start` and `daemon.stop` (and `config.*` and `module.*` in 2a-H3b). |
| S3 | Spec: the supervisor "writes a fresh nonce to `run/supervisor.token`". That file is also the supervisor's RPC token. | They are the same file: 32 random bytes as hex, fresh at every supervisor start, mode `0600` (user-SID ACL on Windows). The core's `core.adopt { nonce }` reads the file at call time and compares with `timingSafeEqual`. Proof of "the supervisor that owns `run/` now" is exactly proof of that file's current content. |
| S4 | "Accepts the new lifeline" (`lifelineFd`): a file descriptor cannot cross a JSON-RPC socket portably. | A spawned child's lifeline is its **stdin pipe**; the supervisor holds the only write end. An adopted child's lifeline is **the authenticated connection on which `core.adopt` succeeded**. Closing it counts as lifeline EOF. A later successful `core.adopt` replaces the previous source. |
| S5 | Spec §6.4 names `PR_SET_PDEATHSIG` and a Job Object with `KILL_ON_JOB_CLOSE` as backstops. Both kill the child when the supervisor dies, which contradicts D11 and criterion 3 ("core pid unchanged"). | Neither is used. The backstop for an orphan is the core's own grace timer. For a hung orphan it is the next supervisor's start-up probe, which terminates a core that accepts but does not answer (S6). The macOS `ppid` poll is not needed, because the stdin lifeline works on every OS. Recorded in ADR-012's deviations table. |
| S6 | "A child that does not answer … is terminated": the supervisor must not signal a recycled PID. | The supervisor signals only a PID that the OS names as the socket's server: `SO_PEERCRED` (Linux), `LOCAL_PEERPID` (macOS), `GetNamedPipeServerProcessId` (Windows), exposed as `Stream::peer_pid()` in `plur1bus-rpc`. `run/core.pid` becomes `<pid> <instanceId>\n` and serves only to detect a foreign core (hello `instanceId` ≠ file, or hello `pid` ≠ peer pid). |
| S7 | Spec §6.3: "`core.status.degraded = { reason: "models-warming" }` until ready". `core.status` has no top-level `degraded`; `process` is the health state the supervisor and criterion 8 (B8 "< 3 s without models") read. | Once the socket serves and the journal is replayed, `process` stays `ready`. `core.status.engine.degraded` carries the engine's own model-derived `degraded` (E4: `models-warming` or `model-failed`, capability `embedding` or `reranker`). `engine.ready` is `true` only when that is `null`. `engine.models` holds per-model detail. `process` stays `ready` throughout, and recall falls back as the engine does. |
| S8 | Spec §6.4 health is "`core.status` every 5 s; three consecutive failures → `degraded(unresponsive)`; a hung child past 30 s → SIGTERM, SIGKILL after 10 s". It does not say what "hung" means. | Each poll has a 2 s deadline. After three consecutive failed polls the child is `degraded("unresponsive")`. It counts as "hung" when no poll has succeeded for 30 s of monotonic time. Termination then goes: `core.shutdown` on a fresh connection (every OS), after 2 s `SIGTERM` (unix), after 10 s more `SIGKILL` / `TerminateProcess`. One successful poll restores the previous state. |
| S9 | Spec §6.4 is silent on exit codes under supervision. | A clean exit (0) that the supervisor requested → `stopped`; otherwise a clean exit counts as a crash. Exit 3 (`E_LOCKED`) → crash with `reason: "lock-held"`. Exit 2 (config invalid) → `crashed { reason: "config-invalid" }` and exit 4 → `crashed { reason: "engine-contract" }`; both are fatal with no retry until `daemon start`. A signal or any other code → crash with backoff. |
| S10 | The spec does not name the service. Tests must never collide with a real install. | Default home → systemd `plur1bus.service`, launchd label `dev.plur1bus.supervisor`, task `PLUR1BUS Supervisor`. Any other home → the same names with suffix `-<first 8 hex of sha256(lower-cased home)>`. systemd `Restart=on-failure`, `RestartSec=1`. launchd `KeepAlive = { SuccessfulExit = false }`, `ThrottleInterval = 5`. Task Scheduler XML: `LogonTrigger`, `RestartOnFailure` (`PT1M`, 999), `LeastPrivilege`. A clean `daemon stop` (exit 0) is never restarted by the OS. |
| S11 | "Named pipe with a user-SID ACL (Windows)". Node's `net` cannot set a DACL on a pipe, and cannot listen on a handle on Windows. | The supervisor pipe (Rust) gets an explicit DACL `D:P(A;;GA;;;<user SID>)(A;;GA;;;SY)` and `FILE_FLAG_FIRST_PIPE_INSTANCE`. The core pipe keeps Node's default DACL: full control for SYSTEM, Administrators and the creator owner, read-only for Everyone and Anonymous, so no other user can write a request. A Windows test and `1staid check` verify that DACL with `pipe_dacl_report`. On Windows both Rust clients refuse a pipe whose `GetNamedPipeServerProcessId` differs from `run/core.pid` / `run/supervisor.pid` (`E_UNAUTHORIZED reason=pipe-server-mismatch`), which blocks squatting. `securePath` on Windows = `icacls <p> /inheritance:r /grant:r *<user SID>:(F) *S-1-5-18:(F)`. |
| S12 | `1staid check` exit code and shape. | Read-only: it never writes, starts or signals anything, and works with neither process running. Result: `{ ok, checks: [{ id, status: "ok"\|"warn"\|"fail"\|"skip", summary, detail?, hint? }] }`. Exit 0 when no check is `fail`, otherwise 1. `warn` does not change the exit code. |
| S13 | ADR-016 §5: deprecations "logged once per process and listed by `1staid check`". | `core.status` gains `deprecationsUsed: string[]` (`"method:<name>"` / `"notification:<name>"`, first uses since start, sorted). `1staid check` lists every deprecated entry from both handshakes' capabilities with `used`. |
| S14 | Supervisor concurrency model. | Std threads: one accept thread, one thread per connection, and per child one waiter, one health loop and one output pump. A `Mutex<SupervisorState>` plus a `Condvar` wakes the restart scheduler. No async runtime (Global Constraints). |
| S15 | Config ownership (ADR-013 §5 target) is not in 2a-H3a. | The CLI keeps owning `config.json`. The supervisor reads `supervisor.*` and `logs.*` at start. The core keeps reading the file. Supervisor ownership, `config.changed` and the watcher land in 2a-H3b-1. |
| S16 | Kill soak parameters. | 1 000 turns in the nightly and 200 turns in the PR system job (same file, `PLUR1BUS_SOAK_TURNS`). `supervisor.graceMs = 3000` in the test home. The test plays the OS service manager: it restarts `supervise` itself after 1 s (< grace) and after 5 s (> grace). The core is SIGKILLed at random with `p = 1/20` per turn, from a seeded PRNG (`PLUR1BUS_SOAK_SEED`, printed as a diagnostic). |
| S17 | Log files. | The supervisor writes `logs/supervisor.log` (JSON lines) and each child's stdout/stderr to `logs/<role>.out.log`. The core rotates its own `logs/core.log`. Rotation is by size (`logs.maxBytes`, keep `logs.keep`: `<file>.1` newest … `<file>.<keep>` oldest), checked before each write. |
| S18 | E4 is planned in parallel. | Task 1 pins `3a4426a5` (1.7.0). Tasks 2–12 must pass on it. The core feature-detects E4 (`typeof (engine as any).models?.warm === "function"`, `EngineStatus.models` / `.sharedMemory` present). Task 13 moves the pin to E4's merge commit and turns the detection into a contract-minor check. |
| S19 | Adoption of a core that no supervisor spawned (e.g. `plur1bus core run`). | Adopted like any other core: the child is the source of truth about itself (spec §6.4). The supervisor shows it with `adopted: true`. Restarting it later uses the supervisor's own spawn spec. |

**Out of scope (stated so nobody builds it):** everything listed for 2a-H3b below; `config.changed` and `module.state` notifications; the supervisor's `events.subscribe`; download-and-swap updates (M8); macOS signing and notarisation (2a-H3b-9); `agent purge` (M2); any D21 slash command.

---

## Controller rulings on the open questions (2026-09-26, binding)

- **C1 (S5)** accepted: no `PR_SET_PDEATHSIG` / `KILL_ON_JOB_CLOSE`; D11 and acceptance criterion 3 (the core survives a supervisor crash and is adopted) win over the spec's backstop sentence; recorded as an ADR-012 deviation.
- **C2 (S11)** Windows core pipe keeps Node's default DACL for now, mitigated by the server-PID check and the `1staid check` probe; **the owner is asked** whether to add a native/Rust front-end for the core pipe later — execution does not wait for the answer.
- **C3 (S2)** `core.adopt` accepted (method prefix names the serving process).
- **C4 (S7)** accepted: engine `models-warming`/`model-failed` under `core.status.engine.degraded`; `process` stays `ready` (B8 measures socket readiness).
- **C5** Linux service CI: try `loginctl enable-linger` on the runner; if it fails, the real-service test runs on the owner's Ubuntu VM and CI keeps the unit-file test.
- **C6** the controller pushes the branch so the nightly macOS acceptance can run before the PR is opened for review.
- **C7 (S12)** `1staid check` exits 1 only on a failed check; grace default 60 s (Q1 stays open).
- **C8** E4-dependent Tasks 13–15 start only after E4 Tasks 1–8 are merged; they follow E4's final interface, not this plan's copy of it, where the two differ.

## Engine dependency (E4 — interface taken from the E4 plan, adapted in Tasks 13–15)

Engine PR E4 is planned in parallel in `docs/superpowers/plans/2026-09-26-m1b-2a-e4-engine-status-and-shared-platforms.md` (contract **1.8.0**, additive). Tasks 13–15 consume the interface that plan's Task 1 defines. They are the only tasks that change if the merged contract differs. Tasks 1–12 do not depend on it.

```ts
// types/engine.d.ts at E4 (contract 1.8.0) — the members this plan uses
export type ModelState = "loading" | "ready" | "failed" | "disabled";
export interface ModelReadiness { state: ModelState; warming: boolean; checkedAt: number | null; error?: string }
export interface ModelsStatus { embedder: ModelReadiness & { identity: EmbeddingIdentity }; reranker: ModelReadiness & { provider: string | null } }
export interface ModelsService { status(): ModelsStatus; warm(opts?: { signal?: AbortSignal; refresh?: boolean }): Promise<ModelsStatus> }
export interface SharedMemorySupport { supported: boolean; mode: "fd-capability" | "verified-path" | "unavailable";
  reason?: "platform" | "unsafe-root" | "acl-tool-unavailable" | "identity-changed" }
export interface JournalBacklog { entries: number; oldestAt: number | null }
export interface HostCapabilities { /* … */ journalBacklog?(): JournalBacklog | null | Promise<JournalBacklog | null> }
export interface EngineStatus { /* 1.7.0 members; */ degraded: Degraded | null /* now model-derived */;
  jobs: JobsHealth; models: ModelsStatus; journal: JournalBacklog | null; sharedMemory: SharedMemorySupport }
export interface Engine { /* … */ models: ModelsService }
// MemoryOpErrorCode gains "unsupported" (detail { capability: "shared-memory", reason }); CaptureResult.reason gains
// "duplicate-turn" (the same TurnRecord — keyed by agentId, runId, sessionKey, messages — was already captured; Q3).
```

When E4 merges: diff its `types/engine.d.ts` against this block and rename fields in `packages/core/src/warmup.ts`, `shared-memory.ts` and `journal.ts` only. The RPC wire shapes (`$defs/ModelStatus`, `$defs/SharedMemoryStatus`) stay as written in Tasks 13 and 14. If E4 ships without `Engine.models`, Task 13 warms with `embedding.probe({ signal })` and reports the reranker as `loading`. Record that as a deviation in Task 16.

## File structure

```
packages/rpc-schema/schema/rpc.schema.json   1.2.0: x-server (T2); supervisor.auth, daemon.*, core.adopt, $defs/CoreStatus,
                                             ChildStatus (T2); deprecationsUsed (T11); ModelStatus, models (T13); SharedMemoryStatus (T14);
                                             CoreStatus.jobs (T15)
packages/rpc-schema/src/index.ts             buildCapabilities(features, server) (T2); fixtures/capabilities/{core,supervisor}.json
packages/core/src/
  orphan-watch.ts (new)                      createOrphanWatch (T3)
  core.ts, bin.ts, rpc/server.ts, rpc/methods.ts   supervised mode, core.adopt, onConnectionClosed (T3); deprecationsUsed (T11)
  logger.ts                                  size rotation (T3)
  platform.ts                                Windows securePath via icacls (T10)
  warmup.ts (new)                            startWarmup (T13);  shared-memory.ts (new), memory-ops.ts `unsupported` (T14)
  journal.ts, host.ts                        replay runId + duplicate-turn, journalBacklog capability (T15)
packages/module-api/src/client.ts            connect({ endpoint }) (T2)
crates/plur1bus-rpc/src/
  client.rs                                  Endpoint, connect_endpoint, hello() -> &Value, peer_pid() (T2, T7)
  capabilities.rs (new)                      capabilities(server, features) (T2)
  transport.rs                               Stream::peer_pid (T7); Windows overlapped reads with deadline (T10)
  win.rs (new, cfg(windows))                 pipe_server_pid, pipe_dacl_report, user_sid (T10)
crates/plur1bus/src/
  supervisor/{mod,state,server,logfile,child,adopt,pipe_windows}.rs (new)   T4–T7, T10
  service/{mod,systemd,launchd,schtasks}.rs (new)                            T8
  commands/{daemon,service,firstaid}.rs (new)                                T9, T8, T11
  commands/core.rs                           locate_node / locate_core_js made pub(crate) (T6)
  paths.rs                                   supervisor paths and address (T5)
  cli.rs, main.rs                            Supervise (hidden), Daemon, Service, FirstAid::Check (T5, T8, T9, T11)
crates/plur1bus/tests/
  fixtures/fake-core.mjs (new)               T6 (extended T7)
  supervisor.rs, supervisor_children.rs, adoption.rs, daemon.rs, service.rs, firstaid.rs (new)
  service_real.rs (new, gated)               T8
tests/system/kill-soak.test.ts, reconnect.test.ts (new)                      T12;  two-session-recall.test.ts (T13)
.github/workflows/ci.yml, nightly.yml        T8, T12, T13
docs/adr/ADR-012, -013, -016, AGENTS.md      T16
```

## Task map

| # | Task | Produces (used by) |
|---|---|---|
| 1 | Engine pin `3a4426a5` (contract 1.7.0) | — |
| 2 | RPC 1.2.0: `x-server`, supervisor handshake and `daemon.*`, `core.adopt`; per-server capabilities; `Endpoint` in both clients | schema, `buildCapabilities(…, server)`, `capabilities()`, `connect_endpoint` (3–11) |
| 3 | Core supervised mode: stdin lifeline, `orphaned`, grace, `core.adopt`, pid file, log rotation | `--lifeline stdin`, `core.adopt` (6, 7, 12) |
| 4 | Supervisor state machine: health, backoff, crash budget, exit classes (pure) | `Backoff`, `ChildState`, `classify_exit` (5, 6, 7) |
| 5 | `plur1bus supervise`: endpoint, token/pid files, `supervisor.auth`, `daemon.status/stop`, logging | `SupervisorServer`, `RotatingFile`, Layout paths (6–11) |
| 6 | Spawn and monitor the core: readiness, health, hang kill, restart with backoff, output log, `daemon.start` | `Monitor`, `core_spec`, fake core (7, 9, 12) |
| 7 | Adoption: peer credentials, start-up probe, `core.adopt`, connection lifeline | `probe_core`, `peer_pid` (9, 11, 12) |
| 8 | OS service registration: systemd, launchd, Task Scheduler; `service install\|uninstall\|status`; CI job | `service::status` (9, 11) |
| 9 | `daemon start\|stop\|restart\|status`; the supervisor's view in core-unavailable answers | `supervisor_detail` (12) |
| 10 | Windows: supervisor pipe DACL, `securePath` via icacls, pipe-server check, DACL report, read deadlines | `pipe_dacl_report` (11) |
| 11 | `plur1bus 1staid check` (incl. deprecations) | check ids (12, 13, 14) |
| 12 | Kill soak and reconnect-not-respawn system tests; CI and nightly | — |
| 13 | Model warm-up (E4): pin 1.8.0, `models-warming`, `engine.models`, nightly macOS first-recall fix | `startWarmup` (14, 15) |
| 14 | Shared-memory status and `unsupported` (E4) in `core.status`, memory ops, `daemon status`, `1staid check` | — |
| 15 | Journal backlog capability, replay `runId` and `duplicate-turn`, job health (E4) | — |
| 16 | ADR implementation records, AGENTS.md | — |

---

### Task 1: Engine pin `3a4426a5` (contract 1.7.0)

**Files:**
- Modify: `packages/core/package.json` (engine line), `pnpm-lock.yaml`, `packages/core/test/core.test.ts` (contract expectation `"1.7.0"`), `scripts/gen-engine-keys.mjs` (header `contract 1.7.0, engine @ 3a4426a5`; `EXPECTED_KEY_COUNT` unchanged unless the engine added a key — if so, name it in the comment as G6 did), `docs/config-engine-keys.md` (regenerated)

- [ ] **Step 1: Change the test** `core.test.ts`: `assert.equal(s.contract, "1.7.0")`. Run the core suite → FAIL (1.6.0).
- [ ] **Step 2: Bump the pin** to `git+https://github.com/Cyb3rb1ade/openclaw-plur1bus-memory.git#3a4426a59f0dca66f7da214f69e203754ce8280f` and run `pnpm install`. Only the engine's resolution lines (and its own dependency closure) may move in the lockfile.
- [ ] **Step 3: Run Green** plus both system tests. `assertEngineContract` already accepts 1.7.0. A regression is investigated in the harness; if it comes from an engine behaviour change the harness cannot absorb, stop and report BLOCKED with the assertion.
- [ ] **Step 4: Commit** `feat(core): pin engine 3a4426a5 (contract 1.7.0, E3 embedding probe/serve)`.

---

### Task 2: RPC 1.2.0 — `x-server`, supervisor handshake, `daemon.*`, `core.adopt`, per-server capabilities

**Files:**
- Modify: `packages/rpc-schema/schema/rpc.schema.json` — version → 1.2.0. Every existing method gets `"x-server": "core"`. `core.status`'s result moves verbatim to `$defs/CoreStatus` and the method refs it. New `$defs/ChildStatus`. New methods in the table below. Every notification also gets `"x-server": "core"` (the supervisor has none in 2a-H3a).
- Modify: `packages/rpc-schema/src/build.mjs`, `src/index.ts` (`ajv.addKeyword("x-server")`; `buildCapabilities(features, server = "core")`; `METHODS_BY_SERVER`); `crates/plur1bus-rpc/build.rs` already strips `x-*`
- Create: `packages/rpc-schema/fixtures/capabilities/{core,supervisor}.json` (generated by `build.mjs` with `features: []`), `fixtures/methods/{supervisor.auth,daemon.status,daemon.start,daemon.stop,core.adopt}.json`
- Create: `crates/plur1bus-rpc/src/capabilities.rs`; modify `crates/plur1bus-rpc/src/{lib.rs,client.rs}`, `crates/plur1bus-rpc/tests/{fixtures.rs,client.rs}`
- Modify: `packages/module-api/src/client.ts`, `packages/core/src/core.ts` (`buildCapabilities(CORE_FEATURES, "core")`), `packages/core/src/rpc/methods.ts` (`core.adopt` answers `E_NOT_AVAILABLE reason=not-supervised` until Task 3)
- Test: `packages/rpc-schema/test/stability.test.ts`, `packages/module-api/test/client.test.ts`, `crates/plur1bus-rpc/tests/{client.rs,capabilities.rs}`

| Method | `x-server` | Params (closed) | Result (closed) |
|---|---|---|---|
| `supervisor.auth` | supervisor | `token` (string, 64) | `{ rpc, instanceId, pid, capabilities?: Capabilities }` |
| `daemon.status` | supervisor | — | `{ supervisor: { process: ProcessState, instanceId, pid, uptimeMs }, children: ChildStatus[] }` |
| `daemon.start` | supervisor | `role?` (`"core"`) | `{ accepted: true, role }` — clears a `crashed`/`stopped` child's backoff and spawns it |
| `daemon.stop` | supervisor | `budgetMs?` (0–120000) | `{ accepted: true }` |
| `core.adopt` | core | `nonce` (string, 64) | `{ status: CoreStatus }` |

`ChildStatus`: required `role` (`^[a-z0-9][a-z0-9-]{0,63}$`), `process: ProcessState`, `pid` (integer|null), `instanceId` (string|null), `adopted` (boolean), `restarts` (integer ≥ 0), `lastExit` (`{ code: integer|null, signal: string|null, at: integer, reason: string|null }` | null) and `nextRestartAt` (integer|null).

**Interfaces:**
- Produces (TS): `export type RpcServerRole = "core" | "supervisor"; export function buildCapabilities(features: readonly string[], server?: RpcServerRole): Capabilities;` (methods filtered by `x-server`). The `Hello` of `@plur1bus/module-api` gets `connect(o: { address; token; endpoint?: "core" | "supervisor"; … })`, with the handshake method `core.auth` or `supervisor.auth`; `supports()` is unchanged.
- Produces (Rust): `pub fn capabilities(server: &str, features: &[&str]) -> serde_json::Value` (from `pub const SCHEMA_JSON: &str = include_str!("../../../packages/rpc-schema/schema/rpc.schema.json")`, parsed once per call). `#[derive(Clone, Copy)] pub enum Endpoint { Core, Supervisor }`, `ConnectOptions { connect_timeout, call_timeout, endpoint: Endpoint }` (`Default` → `Core`), `pub fn hello(&self) -> &serde_json::Value` (replaces the typed `&Hello`; adapt the one or two callers to read fields from the value) and `pub fn endpoint(&self) -> Endpoint`. The version check is unchanged (`rpc` major before anything else).
- `SUPERVISOR_FEATURES: &[&str] = &["adoption", "lifelines"]` lives in `crates/plur1bus/src/supervisor/mod.rs` (Task 5); the tests here pass their own lists.

- [ ] **Step 1: Write the failing tests.**
  - stability.test: `every method declares x-server core or supervisor`; `buildCapabilities(core) omits supervisor methods and vice versa` (core has `memory.recall`, `core.adopt`, and no `daemon.status`; supervisor has exactly `["daemon.start","daemon.status","daemon.stop","supervisor.auth"]`; supervisor `notifications` is `{}`); `capability fixtures match buildCapabilities`; `RPC_VERSION === "1.2.0"`; `core.status and core.adopt share $defs/CoreStatus`.
  - module-api: `connect with endpoint supervisor sends supervisor.auth`.
  - Rust: `capabilities_match_the_typescript_fixtures` (both servers, `features: []`); `connect_endpoint_supervisor_uses_supervisor_auth` (fake server records the first method); `hello_is_the_raw_value_with_unknown_keys_kept`. The fixture tests demand the five new method fixtures.
- [ ] **Step 2: Run** `cd packages/rpc-schema && pnpm test`, the module-api tests and `cargo test -p plur1bus-rpc` → FAIL.
- [ ] **Step 3: Implement** the schema, keyword, filter, fixtures generation, both clients and the `core.adopt` stub.
- [ ] **Step 4: Run Green**, then `pnpm docs:gen` (rpc.md gains a `**Served by:**` line: add it in `scripts/gen-docs.mjs` next to the stability line).
- [ ] **Step 5: Commit** `feat(rpc): 1.2.0 — x-server, supervisor.auth/daemon.*/core.adopt, per-server capabilities (ADR-016 §3, G2)`.

---

### Task 3: Core supervised mode — stdin lifeline, `orphaned`, grace, `core.adopt`, pid file, log rotation

**Files:**
- Create: `packages/core/src/orphan-watch.ts`, `packages/core/test/orphan-watch.test.ts`, `packages/core/test/core-supervised.test.ts`
- Modify: `packages/core/src/core.ts` (`CoreOptions.lifeline?: NodeJS.ReadableStream`, `onOrphanGraceExpired?: () => void`; `core.adopt` handler; pid file), `packages/core/src/bin.ts` (`--lifeline stdin`, `--instance <id>`), `packages/core/src/rpc/server.ts` (`onConnectionClosed` option), `packages/core/src/rpc/methods.ts`, `packages/core/src/paths.ts` (`supervisorToken`, `supervisorPid`, `supervisorAddress(home, platform)` — POSIX `run/supervisor.sock`, Windows `\\.\pipe\plur1bus-<hash16>-supervisor`), `packages/core/src/logger.ts`
- Test: `packages/core/test/{logger,bin,paths}.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface OrphanWatch {
    watchStream(s: NodeJS.ReadableStream): void;   // 'end' | 'close' | 'error' → lost
    watchConnection(connectionId: string): void;  // replaces the current source, cancels a running grace timer
    connectionClosed(connectionId: string): void; // lost only if it is the current source
    readonly orphanedSince: number | null;
    dispose(): void;
  }
  export function createOrphanWatch(o: { graceMs: number; clock?: () => number; onOrphaned(since: number): void;
    onReattached(): void; onGraceExpired(): void }): OrphanWatch;
  ```
  `createRpcServer(o: { …; onConnectionClosed?: (connectionId: string) => void })`. `createLogger(o: { file; level; role; stream?; maxBytes?: number; keep?: number })` rotates as in S17 when `maxBytes` is set.
- Core behaviour: with `lifeline`, the core calls `watchStream` after `ready`. On lost it enters `setState({ state: "orphaned", since })` and keeps serving every method; `isStopping()` stays false. On grace expiry (`config.supervisor.graceMs`) it calls `o.onOrphanGraceExpired?.()`; `bin.ts` routes that to `stop("lifeline grace expired")` → exit 0. Handler `core.adopt({ nonce }, ctx)`: read `layout.supervisorToken`, and if it is missing, not 64 hex characters or not `timingSafeEqual` → `E_UNAUTHORIZED "adoption refused" reason=adopt-nonce`, state unchanged. Otherwise call `watchConnection(ctx.connectionId)`; if `orphaned`, set `ready` (or the pre-orphan state); return `{ status: status() }`. `core.adopt` without a lifeline configured also succeeds: it gives an unsupervised core a lifeline (S19). `run/core.pid` = `` `${process.pid} ${instanceId}\n` ``. `bin.ts`: `--instance` (a UUID, else exit 2) sets `instanceId`; `--lifeline` accepts only `stdin` (else exit 2) and passes `process.stdin`.

- [ ] **Step 1: Write the failing unit tests** (`orphan-watch.test.ts`, `mock.timers`): `stream end orphans and grace expiry fires once`; `watchConnection before expiry cancels the timer and calls onReattached`; `closing a connection that is not the current source is ignored`; `a replaced source's close no longer orphans`. logger.test: `rotates at maxBytes and keeps at most keep files` (maxBytes 200, 50 lines → `core.log`, `.1`, `.2` with keep 2, no `.3`, and no line is lost across the files). bin.test: `--lifeline other than stdin exits 2`, `--instance not a uuid exits 2`.
- [ ] **Step 2: Write the failing integration tests** (`core-supervised.test.ts`; in-process `createCore` with `lifeline: new PassThrough()` and config `supervisor.graceMs = 300`; the supervisor token is written by the test as 64 hex into `run/supervisor.token`):
  - `lifeline EOF orphans the core and it keeps serving memory.recall` (`status().process.state === "orphaned"`; a recall answers with `degraded === null`)
  - `grace expiry calls onOrphanGraceExpired; stop leaves no lock, socket or run files`
  - `core.adopt with the supervisor token re-attaches and returns the full status` (`result.status.process.state === "ready"`, `result.status.instanceId === core.status().instanceId`, and no grace callback after 600 ms)
  - `core.adopt with a wrong or missing nonce is E_UNAUTHORIZED adopt-nonce and the core stays orphaned`
  - `closing the adopting connection orphans the core again`
  - `a second adopt on another connection replaces the lifeline; closing the first does nothing`
  - `core.pid carries pid and instance id` (`/^\d+ [0-9a-f-]{36}\n$/`)
- [ ] **Step 3: Run** → FAIL.
- [ ] **Step 4: Implement** `orphan-watch.ts`, the server hook, the handler (replacing Task 2's stub), the flags, the paths and the rotation. The core passes `maxBytes`/`keep` from `config.logs`.
- [ ] **Step 5: Run** the files → PASS, then Green.
- [ ] **Step 6: Commit** `feat(core): supervised mode — stdin lifeline, orphaned with grace, core.adopt (S3, S4), rotated core.log`.

---

### Task 4: Supervisor state machine — health, backoff, crash budget, exit classes (pure Rust)

**Files:**
- Create: `crates/plur1bus/src/supervisor/mod.rs` (module root; `pub mod state;` for now), `crates/plur1bus/src/supervisor/state.rs`
- Modify: `crates/plur1bus/src/main.rs` (`mod supervisor;`), `crates/plur1bus/Cargo.toml` (dev `proptest = "1"`)

**Interfaces:**
- Produces:
  ```rust
  pub enum Health { Starting, Ready, Degraded(String), Orphaned { since: u64 }, Stopping, Stopped { reason: Option<String> },
                    Crashed { code: Option<i32>, signal: Option<String>, at: u64, reason: Option<String> } }
  impl Health { pub fn to_process_state(&self, since: u64) -> serde_json::Value }            // $defs/ProcessState
  pub enum ExitClass { Requested, Retryable { reason: Option<String> }, Fatal { reason: String } }
  pub fn classify_exit(code: Option<i32>, signal: Option<i32>, requested: bool) -> ExitClass; // S9
  pub struct Backoff { /* private */ }
  pub enum RestartDecision { After(std::time::Duration), GiveUp }
  impl Backoff {
      pub fn new(scale: f64) -> Self;                         // scale = PLUR1BUS_SUPERVISOR_TIME_SCALE (1.0 in prod)
      pub fn on_exit(&mut self, now: std::time::Instant) -> RestartDecision;
      pub fn on_ready(&mut self, now: std::time::Instant);
      pub fn reset(&mut self);                                // daemon start / daemon.start
  }
  pub struct ChildState { pub role: String, pub health: Health, pub since_ms: u64, pub pid: Option<u32>, pub instance_id: Option<String>,
                          pub adopted: bool, pub restarts: u32, pub last_exit: Option<LastExit>, pub next_restart_at_ms: Option<u64> }
  impl ChildState { pub fn to_json(&self) -> serde_json::Value }                              // $defs/ChildStatus
  ```
- Backoff rule (spec §6.4): delays 1, 2, 4, 8, 16, 32, 60, 60 … s × scale. The delay index returns to 0 once the child has been ready for 10 min × scale. `GiveUp` when this exit is the 5th within the trailing 10 min × scale, and it stays sticky until `reset()`.

- [ ] **Step 1: Write the failing tests** (`#[cfg(test)]` in `state.rs`): `backoff_doubles_from_1s_to_60s` (eight exits spaced 11 min apart but without `on_ready` → 1, 2, 4, 8, 16, 32, 60, 60 s); `five_crashes_in_ten_minutes_give_up` (the 5th exit within 600 s → `GiveUp`, and a 6th after 20 min still `GiveUp` until `reset`); `ten_minutes_stable_resets_the_delay`; `classify_exit_follows_s9` (table: `(Some(0), None, true)` → Requested; `(Some(0), None, false)` → Retryable; `(Some(3), …)` → Retryable reason `lock-held`; `(Some(2), …)` → Fatal `config-invalid`; `(Some(4), …)` → Fatal `engine-contract`; `(None, Some(9), false)` → Retryable reason `None`); `child_status_json_validates_against_the_schema` (every `Health` variant via `jsonschema` against `$defs/ChildStatus` from `plur1bus_rpc::SCHEMA_JSON`); proptest `backoff_invariants` (random non-decreasing exit times with optional `on_ready`: delay ≤ 60 s × scale; `GiveUp` iff ≥ 5 exits fell in the trailing window at some point since the last reset).
- [ ] **Step 2: Run** `cargo test -p plur1bus supervisor::state` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; clippy clean.
- [ ] **Step 5: Commit** `feat(supervisor): pure health/backoff/exit-class state machine with property tests (spec §6.4, R3)`.

---

### Task 5: `plur1bus supervise` — endpoint, token and pid files, `supervisor.auth`, `daemon.status|stop`, logging

**Files:**
- Create: `crates/plur1bus/src/supervisor/{server.rs,logfile.rs}`, `crates/plur1bus/tests/supervisor.rs`
- Modify: `crates/plur1bus/src/supervisor/mod.rs` (`pub fn run(layout: &Layout, opts: SuperviseOpts) -> !`, `SUPERVISOR_FEATURES`), `crates/plur1bus/src/cli.rs` (`#[command(hide = true)] Supervise { #[arg(long, hide = true)] no_core: bool }`), `crates/plur1bus/src/main.rs`, `crates/plur1bus/src/paths.rs` (`core_pid()`, `supervisor_token()`, `supervisor_pid()`, `logs()`, `log_file(role)`, `out_log(role)`; `pub fn supervisor_address(home: &Path, platform: &str) -> String` mirroring `core_address`), `crates/plur1bus/Cargo.toml` (`libc`, `getrandom`, `signal-hook` under `cfg(unix)`; `windows-sys` under `cfg(windows)`)

**Interfaces:**
- Produces: `pub struct RotatingFile` (`open(path, max_bytes: u64, keep: u32) -> io::Result<Self>`, `impl Write`, rotation per S17). `pub struct SupervisorServer` with `bind(layout, token) -> io::Result<Self>` and `serve(self, state: Arc<Shared>)`. A POSIX listener is created under `run/` (`0700`) with the socket at `0600`. The Windows pipe is created with a plain `CreateNamedPipeW` here; the DACL comes in Task 10. `pub struct Shared { state: Mutex<SupervisorState>, wake: Condvar }` is what Task 6 fills with children.
- Start-up order: create `run/`, `logs/` → probe `supervisor_address` (connect 300 ms + `supervisor.auth` with the token read from the file). If it answers → stderr `supervisor already running (pid N)`, exit 3. A dead socket is unlinked. Then write `run/supervisor.token` (fresh, `0600`) and `run/supervisor.pid` (`<pid> <instanceId>\n`) → bind → log `supervisor ready`. Protocol: NDJSON, `MAX_LINE` 4 MiB, `supervisor.auth` first (constant-time compare), 30 s auth idle close. Unknown method → `E_INTERNAL reason=method-not-found`; bad params → `E_INVALID_PARAMS`. Until Task 6, and always under `--no-core`, `daemon.start` answers `E_NOT_AVAILABLE reason=no-children`. `daemon.stop { budgetMs }` replies first, then stops the children (Task 6), removes the socket, token and pid files, and exits 0. SIGTERM/SIGINT (unix, `signal-hook`) take the same path. Every thread runs under `catch_unwind`; a panic is logged, then `std::process::exit(70)`.

- [ ] **Step 1: Write the failing tests** (`tests/supervisor.rs`; spawn `plur1bus --home <tmp> supervise --no-core` with `PLUR1BUS_ALLOW_TEST_INTERNALS=1`, then wait for `run/supervisor.token`):
  - `supervise_writes_token_and_pid_and_answers_auth_with_capabilities` (token is 64 hex and `0600` on unix; pid line matches the child's pid; `hello["capabilities"]["methods"]` has `daemon.status` and no `memory.recall`; `features == ["adoption","lifelines"]`)
  - `a_wrong_token_is_refused_and_closed`
  - `daemon_status_validates_against_the_schema` (`children == []` with `--no-core`)
  - `unknown_params_are_e_invalid_params` (`daemon.stop { "x": 1 }`)
  - `daemon_stop_exits_zero_and_removes_run_files`
  - `a_second_supervisor_on_the_same_home_exits_3` (Review Focus 1)
  - `stale_supervisor_socket_is_replaced` (unix: bind and drop a listener at `run/supervisor.sock`, write a stale pid file, start → answers; Review Focus 3)
  - `sigterm_stops_cleanly` (`#[cfg(unix)]`)
  - unit in `logfile.rs`: `rotates_at_max_bytes_keeping_n`.
- [ ] **Step 2: Run** `cargo test -p plur1bus --test supervisor` → FAIL.
- [ ] **Step 3: Implement.** `--no-core` is honoured only with `PLUR1BUS_ALLOW_TEST_INTERNALS=1` (else exit 2).
- [ ] **Step 4: Run** → PASS; Green; `pnpm docs:gen` (the hidden command changes nothing visible).
- [ ] **Step 5: Commit** `feat(supervisor): plur1bus supervise — endpoint, supervisor.auth with capabilities, daemon.status/stop, single instance`.

---

### Task 6: Spawn and monitor the core — readiness, health, hang kill, restart with backoff, output log, `daemon.start`

**Files:**
- Create: `crates/plur1bus/src/supervisor/child.rs`, `crates/plur1bus/tests/fixtures/fake-core.mjs`, `crates/plur1bus/tests/supervisor_children.rs`
- Modify: `crates/plur1bus/src/commands/core.rs` (extract `pub(crate) fn locate_node(layout) -> PathBuf` and `pub(crate) fn locate_core_js(layout) -> PathBuf`, used by `run` and by the supervisor), `crates/plur1bus/src/supervisor/{mod.rs,server.rs}` (`daemon.start`, children in `daemon.status`, stop sequence)

**Interfaces:**
- Consumes: `Backoff`, `ChildState`, `classify_exit` (Task 4); `Shared`, `RotatingFile` (Task 5); `connect_endpoint` (Task 2); `--lifeline stdin --instance` (Task 3).
- Produces: `pub struct ChildSpec { pub role: String, pub program: PathBuf, pub args: Vec<OsString>, pub env: Vec<(OsString, OsString)> }`; `pub fn core_spec(layout: &Layout, instance_id: &str) -> Result<ChildSpec, String>` (args `<core.js> --home <home> --lifeline stdin --instance <id>`; forwards `PLUR1BUS_TEST_INTERNALS` as `--test-internals` exactly like `core run`); `pub struct Monitor` (`start(shared, spec)`, `stop(budget: Duration)`).
- Lifecycle per spawn: `stdin` piped and held (the lifeline), `stdout`/`stderr` pumped into `RotatingFile(logs/core.out.log)`. Readiness = connect + `core.auth` succeeds (poll every 100 ms, give up after 60 s × scale → kill, count as a crash `reason: "ready-timeout"`). The child state then follows the core's own `process.state`. Health (S8): the control connection calls `core.status` every `supervisor.healthIntervalMs` × scale with a 2 s deadline. On exit: `classify_exit` → `Requested` → `stopped`; `Fatal` → `crashed`; `Retryable` → `Backoff::on_exit` → `next_restart_at` or `crashed` (GiveUp). `daemon.start` → `reset()` and an immediate spawn. Stop: `core.shutdown { budgetMs }` on the control connection, wait `budgetMs` + 5 s, then kill.
- `fake-core.mjs` (Node, no dependencies): parses the same flags as `core.js`; listens on the same address rule; writes `run/core.token`/`run/core.pid` like the real core; answers `core.auth` (`contract: "1.7.0"`, `rpc: "1.2.0"`), `core.status`, `core.shutdown`, and (Task 7) `core.adopt`. Its behaviour comes from env `FAKE_CORE_MODE` (`ok` | `crash-after:<ms>` | `exit:<code>` | `hang-after:<ms>` | `slow-status:<nth>:<ms>`). It appends one JSON line per event (`started`, `shutdown`, `orphaned`, `adopted`, `exiting`) to `$FAKE_CORE_EVENTS`.

- [ ] **Step 1: Write the failing tests** (`tests/supervisor_children.rs`; env `PLUR1BUS_CORE_JS=<fixture>`, `PLUR1BUS_NODE=node`, `PLUR1BUS_ALLOW_TEST_INTERNALS=1`, `PLUR1BUS_SUPERVISOR_TIME_SCALE=0.02`):
  - `spawns_the_core_and_reports_ready_after_the_handshake` (`children[0].process.state == "ready"`, `pid` equals `run/core.pid`'s pid, `adopted == false`)
  - `a_crashed_core_is_restarted_with_backoff` (`crash-after:200` → `restarts >= 1`; the second `started` event is ≥ 20 ms (1 s × 0.02) after the first `exiting`)
  - `five_quick_crashes_end_in_crashed_without_further_attempts` (`exit:1` → `process.state == "crashed"`, exactly 5 `started` events after 3 s)
  - `exit_code_2_is_fatal_config_invalid` (`exit:2` → one `started`, `crashed` with `reason == "config-invalid"`; Review Focus 4)
  - `daemon_start_after_crashed_resets_and_respawns`
  - `a_hung_core_is_terminated_after_the_hang_threshold` (`hang-after:300` → a `shutdown` event or a kill, then a restart)
  - `one_late_health_reply_does_not_degrade_or_kill` (`slow-status:2:3000` with scale 1.0 and `healthIntervalMs` 200 in the config → state never leaves `ready`, the same pid throughout; Review Focus 5)
  - `child_output_goes_to_the_out_log` (the fixture prints a marker to stderr → it appears in `logs/core.out.log`)
  - `daemon_stop_shuts_the_core_down_first` (a `shutdown` event precedes the supervisor's exit; the core exits 0 and ends `stopped`)
  - `spawns_under_a_home_with_spaces` (home `…/p1b sys ü`; Review Focus 2)
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** `child.rs`, the fixture, `daemon.start` and the stop sequence.
- [ ] **Step 4: Run** → PASS (Windows runs every test except the unix-signal assertions, which are guarded); Green.
- [ ] **Step 5: Commit** `feat(supervisor): spawn and monitor the core — handshake readiness, health, hang kill, backoff, out log (spec §6.4)`.

---

### Task 7: Adoption — peer credentials, start-up probe, `core.adopt`, connection lifeline

**Files:**
- Create: `crates/plur1bus/src/supervisor/adopt.rs`, `crates/plur1bus/tests/adoption.rs`
- Modify: `crates/plur1bus-rpc/src/{transport.rs,client.rs}` (`peer_pid`), `crates/plur1bus-rpc/Cargo.toml` (`libc` unix, `windows-sys` windows), `crates/plur1bus/src/supervisor/{mod.rs,child.rs}`, `crates/plur1bus/tests/fixtures/fake-core.mjs` (`core.adopt`, `FAKE_CORE_GRACE_MS`, stdin EOF → `orphaned`)
- Test: `crates/plur1bus-rpc/tests/client.rs`

**Interfaces:**
- Produces: `trait Stream { fn peer_pid(&self) -> Option<u32>; … }` (Linux `SO_PEERCRED`, macOS `LOCAL_PEERPID` via `getsockopt(SOL_LOCAL)`, Windows `GetNamedPipeServerProcessId`); `impl Client { pub fn peer_pid(&self) -> Option<u32> }`.
  ```rust
  pub enum Probe { Absent, Serving { peer_pid: u32, hello: serde_json::Value }, Hung { peer_pid: u32 }, Foreign { peer_pid: u32, reason: String } }
  pub fn probe_core(layout: &Layout, timeout: Duration) -> Probe;
  pub fn adopt(layout: &Layout, supervisor_token: &str) -> Result<(Client, serde_json::Value), RpcError>; // (lifeline connection, CoreStatus)
  ```
- Probe rule (S6): connect fails (ENOENT, ECONNREFUSED, pipe missing) → `Absent`. Connected but `core.auth` times out (2 s) or no token file → `Hung`. Hello `pid` ≠ peer pid, or hello `instanceId` ≠ the one in `run/core.pid` → `Foreign`. Otherwise → `Serving`. At supervisor start, before any spawn: `Serving` → `adopt`, then the child is `adopted: true` and its health runs on the lifeline connection. Its exit is detected as connection EOF plus `kill(pid, 0)` / `OpenProcess` failing, classified as `Retryable { reason: "adopted-exit" }`. `Hung`/`Foreign` → terminate `peer_pid` as in S8, then spawn. A spawn that exits 3 (lock still held) enters backoff.

- [ ] **Step 1: Write the failing tests:**
  - plur1bus-rpc: `peer_pid_of_a_unix_socket_is_the_listener_pid` (`#[cfg(unix)]`, a child process listens).
  - `tests/adoption.rs` (fake core, scale 0.02 except the grace):
    - `supervisor_killed_and_restarted_within_grace_adopts_the_same_core` (SIGKILL the supervisor → `orphaned` event → restart `supervise` → same core pid, `adopted == true`, `ready`; the `adopted` event's nonce equals the new `run/supervisor.token`)
    - `beyond_grace_the_core_exits_and_a_fresh_one_is_spawned` (`FAKE_CORE_GRACE_MS=300`, restart after 1 s → a new pid, `adopted == false`)
    - `killing_the_supervisor_twice_readopts` (adopt, kill again → orphaned via the connection lifeline → adopt again)
    - `a_hung_core_found_at_start_is_terminated_and_replaced` (`#[cfg(unix)]`, `hang-after:0` started by hand)
    - `a_foreign_instance_id_is_terminated` (rewrite `run/core.pid` with another UUID before the start)
    - `a_stale_core_socket_probes_absent` (unix; Review Focus 3)
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; Green.
- [ ] **Step 5: Commit** `feat(supervisor): adopt a running core via nonce and connection lifeline; identify it by peer credentials (spec §6.4, S3–S6)`.

---

### Task 8: OS service registration — systemd, launchd, Task Scheduler; `service install|uninstall|status`; CI job

**Files:**
- Create: `crates/plur1bus/src/service/{mod.rs,systemd.rs,launchd.rs,schtasks.rs}`, `crates/plur1bus/src/commands/service.rs`, `crates/plur1bus/tests/service.rs`, `crates/plur1bus/tests/service_real.rs`
- Modify: `crates/plur1bus/src/cli.rs` (`Service { sub: ServiceCmd }`: `Install { #[arg(long)] no_start: bool, #[arg(long = "env", hide = true)] env: Vec<String> }`, `Uninstall`, `Status`), `crates/plur1bus/src/main.rs`, `.github/workflows/ci.yml` (job `service`)

**Interfaces:**
- Produces:
  ```rust
  pub enum Manager { Systemd, Launchd, TaskScheduler }       // by target OS
  pub struct Unit { pub manager: Manager, pub name: String, pub path: PathBuf, pub content: String }
  pub fn service_name(layout: &Layout, default_home: &Path) -> String;                        // S10 suffix rule
  pub fn render(manager: Manager, bin: &Path, layout: &Layout, name: &str, env: &[(String, String)]) -> Unit;
  pub trait Runner { fn run(&self, program: &str, args: &[OsString]) -> io::Result<std::process::Output>; }
  pub fn install(r: &dyn Runner, unit: &Unit, start: bool) -> Result<(), ServiceError>;
  pub fn uninstall(r: &dyn Runner, layout: &Layout) -> Result<bool, ServiceError>;           // false: was not registered
  pub fn status(r: &dyn Runner, layout: &Layout) -> ServiceStatus;                          // { registered, running, manager, name, path }
  ```
  Paths and commands. systemd: `~/.config/systemd/user/<name>.service`; `systemctl --user daemon-reload`, `enable [--now]`, `disable --now`, `is-active`. launchd: `~/Library/LaunchAgents/<label>.plist`; `launchctl bootstrap gui/<uid> <plist>`, `bootout gui/<uid>/<label>`, `print gui/<uid>/<label>`. Task Scheduler: the XML is written to `<home>/run/<name>.xml`, then `schtasks /Create /XML <file> /TN "<name>" /F`, `/Delete /F`, `/Query /FO CSV`, `/Run`. `ExecStart`/`ProgramArguments`/`Command`+`Arguments` = `<current exe> --home <home> supervise`. The hidden `--env` becomes systemd `Environment=`, launchd `EnvironmentVariables`, and on Windows a refusal (`E_INVALID_PARAMS reason=env-unsupported`; the CI Windows test does not need it). No command needs admin rights.
- CLI results: `service.install/1` → `{ installed: true, started, manager, name, path }`; `service.uninstall/1` → `{ removed: bool, name }`; `service.status/1` → `ServiceStatus`.

- [ ] **Step 1: Write the failing unit tests** (`tests/service.rs` plus unit tests in the render modules, all with a recording fake `Runner`): `systemd_unit_runs_supervise_with_restart_on_failure` (contains `ExecStart="<bin>" --home "<home>" supervise`, `Restart=on-failure`, `RestartSec=1`, `WantedBy=default.target`); `launchd_plist_keeps_alive_only_on_failure` (parsed plist: `KeepAlive.SuccessfulExit == false`, `RunAtLoad == true`, `ThrottleInterval == 5`, `ProgramArguments[3] == "supervise"`); `task_xml_restarts_on_failure_at_logon_without_admin` (`LogonTrigger`, `RestartOnFailure/Interval == "PT1M"`, `Count == 999`, `RunLevel == "LeastPrivilege"`, UTF-16 declaration); `service_name_suffixes_non_default_homes`; `install_runs_the_manager_commands_in_order` (one table per manager); `uninstall_is_idempotent` (second call → `removed: false`, exit 0); `renders_a_home_with_spaces_and_umlauts` (systemd quoting, plist XML escaping, XML `&amp;`/quotes; Review Focus 2).
- [ ] **Step 2: Write the gated real test** `tests/service_real.rs` (runs only with `PLUR1BUS_SERVICE_TEST=1`): `install_status_uninstall_in_user_context` (all OS: install with `--env` pointing at the fake core on unix; `status.registered && status.running` within 10 s; uninstall → `registered == false`, and `supervise` is gone); `the_os_restarts_a_killed_supervisor` (`#[cfg(unix)]`: SIGKILL the pid from `run/supervisor.pid` → a different pid answers `supervisor.auth` within 15 s).
- [ ] **Step 3: Run** `cargo test -p plur1bus --test service` → FAIL.
- [ ] **Step 4: Implement** the renderers, runner, CLI and CI job: matrix `ubuntu-24.04`, `macos-15`, `windows-2025`; build release; set `PLUR1BUS_SERVICE_TEST=1`. On Linux, first run `sudo loginctl enable-linger "$USER"` and `export XDG_RUNTIME_DIR=/run/user/$(id -u)`. Finally run `cargo test --release -p plur1bus --test service_real -- --test-threads=1`.
- [ ] **Step 5: Run** the unit tests → PASS; Green; `pnpm docs:gen`.
- [ ] **Step 6: Commit** `feat(service): systemd/launchd/Task Scheduler user registration; service install/uninstall/status (spec §6.5, criterion 9)`.

---

### Task 9: `daemon start|stop|restart|status`; the supervisor's view in core-unavailable answers

**Files:**
- Create: `crates/plur1bus/src/commands/daemon.rs`, `crates/plur1bus/tests/daemon.rs`
- Modify: `crates/plur1bus/src/cli.rs` (`Daemon { sub: DaemonCmd }`: `Start { #[arg(long)] no_wait: bool }`, `Stop { #[arg(long)] budget_ms: Option<u64> }`, `Restart`, `Status`), `crates/plur1bus/src/main.rs` (the `daemon` stub goes; `core run` stays internal), `crates/plur1bus/src/commands/{memory.rs,memory_ops.rs,dreams.rs}` (degraded/unavailable `detail`)

**Interfaces:**
- Consumes: `connect_endpoint` (Task 2), `service::status`/`Runner` (Task 8), the supervisor (Tasks 5–7).
- Produces: `pub(crate) fn supervisor_detail(layout: &Layout) -> String`. It connects with a 100 ms timeout and a 150 ms call deadline and returns one of: `"supervisor not running"`, `"supervisor unresponsive"`, `"core <state>"`, `"core crashed: <reason>"`, or `"core restarting (restart <n>, next attempt in <ms> ms)"`. The existing `degraded.detail` of `memory recall|add`, the memory-op `E_CORE_UNAVAILABLE` documents and `dreams` all carry it. The whole degraded answer stays < 300 ms by design and < 1 s by test.
- `daemon start`: if the supervisor answers → `daemon.start` (resets a crashed core), then wait. Else, if `service::status().registered` → start through the manager (`systemctl --user start`, `launchctl kickstart gui/<uid>/<label>`, `schtasks /Run`). Else spawn `<current exe> --home <home> supervise` detached (unix `pre_exec(setsid)`, stdio null; Windows `DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW`). Wait ≤ 10 s for `supervisor.auth`; unless `--no-wait`, wait ≤ 30 s for the core child `ready`. Timeout → exit 1, `E_CORE_UNAVAILABLE reason=not-ready`, with the last `daemon.status` in the document. Result: `{ started: bool, via: "running"|"service"|"spawn", status }`.
- `daemon stop` → `daemon.stop`, wait ≤ budget + 10 s for `run/supervisor.pid` to disappear; with no supervisor → `{ stopped: false, wasRunning: false }`, exit 0. `daemon restart` = stop then start (the new supervisor pid differs). `daemon status` → `{ supervisor: <daemon.status> | { process: { state: "stopped" } } | { process: { state: "degraded", reason: "unresponsive" } }, service: ServiceStatus }`.

- [ ] **Step 1: Write the failing tests** (`tests/daemon.rs`, fake core, scale 0.02):
  - `daemon_start_spawns_a_detached_supervisor_and_waits_for_ready` (`via == "spawn"`, `status.children[0].process.state == "ready"`; the supervisor survives the CLI process)
  - `daemon_start_twice_is_idempotent` (`started == false`, `via == "running"`, same pid)
  - `concurrent_daemon_starts_leave_one_supervisor_and_one_core` (two `daemon start` at once → one supervisor pid file, one `started` event; Review Focus 1)
  - `daemon_stop_without_supervisor_exits_0_was_running_false`
  - `daemon_status_without_supervisor_reports_stopped_and_the_service_state`
  - `daemon_status_with_a_hung_supervisor_answers_within_a_second` (a test listener at `run/supervisor.sock` that accepts but never replies → `reason == "unresponsive"`, wall time < 1 s)
  - `daemon_restart_gives_new_supervisor_and_core_pids`
  - `recall_with_core_down_names_the_supervisor_state` (`FAKE_CORE_MODE=exit:2` → `memory recall` degraded `detail` contains `crashed: config-invalid`, < 1 s)
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; Green; `pnpm docs:gen`.
- [ ] **Step 5: Commit** `feat(cli): daemon start/stop/restart/status; core-unavailable answers name the supervisor state (spec §6.4, §6.6)`.

---

### Task 10: Windows — supervisor pipe DACL, `securePath` via icacls, pipe-server check, DACL report, read deadlines

**Files:**
- Create: `crates/plur1bus-rpc/src/win.rs` (`#[cfg(windows)]`), `crates/plur1bus/src/supervisor/pipe_windows.rs`, `crates/plur1bus-rpc/tests/windows.rs` (`#![cfg(windows)]`), `packages/core/test/platform-windows.test.ts`
- Modify: `crates/plur1bus-rpc/src/{transport.rs,client.rs,lib.rs}`, `crates/plur1bus/src/supervisor/server.rs`, `packages/core/src/platform.ts`, `packages/core/src/core.ts` (`securePath` on `run/`, the token and pid files after writing them)

**Interfaces:**
- Produces (Rust, windows): `pub fn user_sid() -> io::Result<String>` (`OpenProcessToken` + `GetTokenInformation(TokenUser)` + `ConvertSidToStringSidW`); `pub fn pipe_server_pid(h: HANDLE) -> Option<u32>`; `pub struct DaclEntry { pub sid: String, pub mask: u32, pub allow: bool }`; `pub fn pipe_dacl_report(address: &str) -> io::Result<Vec<DaclEntry>>` (`GetSecurityInfo` on an opened client handle); `pub fn writable_by_others(entries: &[DaclEntry], user_sid: &str) -> Vec<String>` (SIDs other than the user, `S-1-5-18`, `S-1-5-32-544` and the owner-rights SID with `FILE_WRITE_DATA` or `GENERIC_WRITE`/`GENERIC_ALL`). The supervisor pipe uses `CreateNamedPipeW` with `SECURITY_ATTRIBUTES` from `ConvertStringSecurityDescriptorToSecurityDescriptorW("D:P(A;;GA;;;<sid>)(A;;GA;;;SY)")` and `FILE_FLAG_FIRST_PIPE_INSTANCE` on the first instance. Transport: the pipe is opened with `FILE_FLAG_OVERLAPPED`; each read is `ReadFile` + `WaitForSingleObject(event, deadline)` + `CancelIoEx` on timeout (replaces the "H2: overlapped I/O" TODO; the timeout poisons the client as on unix). Client connect (windows): `pipe_server_pid` ≠ the pid in `run/core.pid` (`Endpoint::Core`) or `run/supervisor.pid` (`Endpoint::Supervisor`) → `RpcError::Call { code: E_UNAUTHORIZED, reason: "pipe-server-mismatch" }`. `ConnectOptions` gets `expected_server_pid: Option<u32>` so callers pass it; `None` skips the check.
- Produces (TS): Windows `securePath(p)` runs `icacls` via `execFileSync` with the user SID from `whoami /user /fo csv /nh`, memoised → `{ applied: true, mechanism: "icacls" }`. On failure → `{ applied: false, reason: "icacls-failed" }` and a warning log.

- [ ] **Step 1: Write the failing tests** (they run on the Windows unit job; every other OS compiles them out or skips them):
  - `supervisor_pipe_dacl_grants_only_user_and_system` (start `supervise --no-core`, `pipe_dacl_report` → the SIDs are exactly `{user, S-1-5-18}`)
  - `a_second_pipe_instance_owner_is_refused` (with `FILE_FLAG_FIRST_PIPE_INSTANCE`, creating a same-name first instance fails while the supervisor runs)
  - `core_pipe_default_dacl_is_not_writable_by_others` (spawn the fake core via `node`, `writable_by_others(...) == []`)
  - `a_pipe_whose_server_pid_mismatches_is_refused` (`expected_server_pid: Some(1)`)
  - `a_read_times_out_and_poisons_on_windows` (a fake core that never answers a call → `call-timeout` within call_timeout + 500 ms, then `poisoned`)
  - TS `securePath applies an icacls grant on Windows` (`{ skip: process.platform !== "win32" }`; `icacls <p>` output lists the user SID and no `Everyone`/`BUILTIN\Users`)
- [ ] **Step 2: Run** on a Windows host (the owner's Parallels VM) if one is available → FAIL. Otherwise, `cargo check --workspace --all-targets --target x86_64-pc-windows-msvc` must compile (add the target with `rustup target add`), and the tests run in the Windows CI job once the owner pushes the branch (this plan never pushes).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS on Windows; Green everywhere.
- [ ] **Step 5: Commit** `feat(windows): supervisor pipe with user-SID DACL, core securePath via icacls, pipe-server pid check, overlapped read deadlines (S11)`.

---

### Task 11: `plur1bus 1staid check` (with deprecation listing)

**Files:**
- Create: `crates/plur1bus/src/commands/firstaid.rs`, `crates/plur1bus/tests/firstaid.rs`
- Modify: `crates/plur1bus/src/cli.rs` (`FirstAidCmd::Check` loses its stub text; `Repair` stays a stub naming `2a-H3b`; `STUB_MILESTONES` gains `"2a-H3b"`), `crates/plur1bus/src/main.rs`, `packages/rpc-schema/schema/rpc.schema.json` (`$defs/CoreStatus.deprecationsUsed`: optional array of string), `packages/core/src/rpc/server.ts` (record first uses), `packages/core/src/core.ts`
- Test: `packages/core/test/core.test.ts`

**Interfaces:**
- Produces: `pub struct Check { pub id: &'static str, pub status: Status, pub summary: String, pub detail: Option<Value>, pub hint: Option<String> }`, `pub enum Status { Ok, Warn, Fail, Skip }`, `pub fn gather(layout: &Layout, env: &Env) -> Vec<Check>` (pure orchestration over small readers; `Env` bundles `now`, the platform and a `Runner` for `service::status`). The result document is `1staid.check/1` per S12.
- Check ids, in this order, each with its rule:

| id | ok / warn / fail |
|---|---|
| `config.valid` | valid (ok), `schemaVersion` older → warn with hint `config migrates at next core start`, invalid → fail |
| `run.permissions` | unix: `run/` 0700 and token files 0600; Windows: `icacls` listing only the user and SYSTEM. Otherwise fail |
| `run.stale-files` | a socket or pid file with no live peer (connect fails, or the pid is not alive) → warn (Review Focus 3) |
| `supervisor.state` | answers and `ready` (ok), not running (warn: `plur1bus daemon start`), unresponsive (fail) |
| `core.state` | `ready` (ok); `orphaned`/`degraded`/restarting (warn); `crashed` (fail, with `lastExit.reason`); core absent while the supervisor is also absent → warn |
| `core.lock` | pid in `run/core.pid` alive and equal to the core peer pid (ok); the core is serving but the pid file differs → fail |
| `service.registration` | registered and running (ok); not registered → warn with hint `plur1bus service install` |
| `agents.activity` | per agent, an activity older than 30 s (recall/capture/checkpoint) or 10 min (dreaming/consolidating/maintenance) → warn (spec §6.3) |
| `journal.backlog` | `journalBacklog == 0` and no `state/journal/*.jsonl` lines (ok), otherwise warn with the count |
| `jobs.last-runs` | `jobs.history` per agent (limit 1 per job): an outcome `failed`/`abandoned` → warn |
| `api.deprecations` | the deprecated entries of both capabilities (S13): none → ok; any → warn listing `{ name, since, removeAfter, replacement, used }` |
| `windows.pipe-acl` | Windows only: `writable_by_others` empty for both pipes (ok) else fail; skip elsewhere |

  Anything that needs a process the check cannot reach is `skip` with a `summary` that says why. Connections use the 300 ms connect timeout. The whole check budget is < 3 s.

- [ ] **Step 1: Write the failing tests** (`tests/firstaid.rs`):
  - `check_with_nothing_running_is_read_only_and_exits_0` (a fresh home after `agent create bernd`: `ok == true`, `supervisor.state` warn, `core.state` warn, and no file in the home changed — compare a recursive listing with mtimes before and after)
  - `check_json_validates_the_document_shape` (`schema == "1staid.check/1"`, every check has `id` from the table and a known status, ids are in table order)
  - `stale_run_files_are_a_warning` (Review Focus 3)
  - `a_crashed_core_is_a_failure_and_exit_1` (fake core `exit:2` under the supervisor → `core.state` fail with detail reason `config-invalid`, exit 1)
  - `ready_stack_is_all_ok_except_service` (fake core ready → `supervisor.state`/`core.state` ok)
  - `deprecations_list_engine_event_with_used_flag` (real core started by the test with flat embedder; subscribe to `engine.event` first → `used == true`)
  - unix: `loose_run_permissions_fail` (chmod `run/` 0755)
  - core.test: `core.status lists deprecations used since start` (`deprecationsUsed` deep-equals `["notification:engine.event"]` after such a subscribe, `[]` before)
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** the schema field, the core recording and `firstaid.rs`.
- [ ] **Step 4: Run** → PASS; Green; `pnpm docs:gen`.
- [ ] **Step 5: Commit** `feat(cli): 1staid check — supervisor/core/lock/run files/service/activity/journal/jobs/deprecations (spec §6.6, D12, ADR-016 §5)`.

---

### Task 12: Kill soak and reconnect-not-respawn system tests; CI and nightly

**Files:**
- Create: `tests/system/kill-soak.test.ts`, `tests/system/reconnect.test.ts`
- Modify: `tests/system/helpers.ts` (`startDaemon(h)`, `stopDaemon(h)`, `supervisorPid(h)`, `corePid(h)`, `killPid(pid, signal)`, `restartSupervisor(h)` — spawns `plur1bus --home h supervise` detached with the same env as `startCore`), `.github/workflows/ci.yml` (system job: add both files, `PLUR1BUS_SOAK_TURNS=200`), `.github/workflows/nightly.yml` (add a `kill-soak` step with `PLUR1BUS_SOAK_TURNS=1000` on Linux and macOS, flat embedder)

**Interfaces:**
- Consumes: the whole stack of Tasks 3–11.

- [ ] **Step 1: Write** `reconnect.test.ts` → `criterion 3: reconnect not respawn` (flat embedder; `config set supervisor.graceMs 3000 --yes`; `daemon start`; capture a fact):
  - (a) SIGKILL the supervisor, restart it after 1 s → `daemon status` shows the core `adopted: true` with the same pid; `memory recall` finds the fact with `degraded === null`.
  - (b) SIGKILL the supervisor, wait 5 s → the old core pid is gone, `run/core.sock` was removed and the lock released (a direct `core run` would not get exit 3); restart the supervisor → a new core pid, and the fact is still recalled.
- [ ] **Step 2: Write** `kill-soak.test.ts` → `criterion 2: kill soak` (S16):
  - `N = Number(process.env.PLUR1BUS_SOAK_TURNS ?? 200)`, seeded PRNG (mulberry32, seed from `PLUR1BUS_SOAK_SEED` or `Date.now()`, printed with `t.diagnostic`).
  - Each turn: `memory add` (unique text `soak fact <i>`) then `memory recall`. Each call's wall time is **< 1 000 ms** (assert per call; also record the max and p95).
  - With probability 1/20 per turn, SIGKILL the core pid. At turn ⌊N/3⌋, SIGKILL the supervisor and restart it after 1 s. At turn ⌊2N/3⌋, SIGKILL it and restart after 5 s.
  - Every outage must be visible. When a turn ran with the core down, `recall.degraded.reason === "core-unavailable"` and `detail` is non-empty. A `daemon status --json` and a `1staid check --json` taken during one outage show the core `crashed`/`starting`/restarting and `core.state` not `ok`.
  - At the end: wait for `ready`. Then **no journal line is lost**: every `soak fact <i>` that was `stored` or `journaled` is found by `memory list --agent bernd --topic "soak fact <i>"`, sampled every 10th `i` plus every journaled one. The journal drains within 30 s.
  - Exactly one supervisor and one core remain: `daemon status` has one child, and `pgrep -f -- "--home <h>"` gives exactly two pids (supervisor, core). One LanceDB owner (T7, M1 #5): on Linux, only the core pid has fds under `<h>/state/lancedb` in `/proc/<pid>/fd` (skip this sub-check on macOS).
  - `daemon stop` exits 0.
- [ ] **Step 3: Run** both with `PLUR1BUS_SOAK_TURNS=200` → they pass against Tasks 1–11. A failure is a bug in the owning task and is fixed there, not in the test.
- [ ] **Step 4: Wire** CI and nightly, then run Green plus all four system tests.
- [ ] **Step 5: Commit** `test(system): kill soak (criterion 2) and reconnect-not-respawn (criterion 3); CI 200 turns, nightly 1000`.

---

### Task 13: Model warm-up (E4) — pin 1.8.0, `models-warming`, `engine.models`, nightly macOS first-recall fix

**Precondition:** engine PR E4 is merged. Diff its `types/engine.d.ts` against the "Engine dependency" block and adapt names in this task only.

**Files:**
- Modify: `packages/core/package.json` + `pnpm-lock.yaml` (pin → E4 merge commit `<E4_SHA>`, contract 1.8.0), `packages/core/test/core.test.ts` (contract `"1.8.0"`), `scripts/gen-engine-keys.mjs` header, `packages/core/src/core.ts`
- Modify: `packages/rpc-schema/schema/rpc.schema.json`. New `$defs/ModelStatus`, closed: `{ state: "loading"|"ready"|"failed"|"disabled", warming: boolean, checkedAt: integer|null, error?: string, id: string|null }`. `$defs/CoreStatus.engine.models` is optional and closed: `{ embedder: ModelStatus, reranker: ModelStatus }`. `engine.degraded` keeps its `Degraded|null` type.
- Create: `packages/core/src/warmup.ts`, `packages/core/test/warmup.test.ts`
- Modify: `tests/system/two-session-recall.test.ts`, `tests/system/helpers.ts` (`waitEngineReady`), `crates/plur1bus/src/commands/firstaid.rs` (check `models.warm` after `core.state`), `crates/plur1bus/tests/firstaid.rs`

**Interfaces:**
- Produces: `export interface Warmup { readonly done: Promise<void>; abort(): void }` and `export function startWarmup(o: { engine: Engine; logger: HarnessLogger; signal: AbortSignal; onDone(models: ModelsStatus): void }): Warmup`. It calls `engine.models.warm({ signal })` once and logs each model's final state and the warm duration (`info("models warm", { embedder, reranker, ms })`). It never throws: `warm()` does not reject for provider failures, and an abort or close rejection is logged at debug.
- `export function projectModels(m: E.ModelsStatus): { embedder: ModelStatus; reranker: ModelStatus }` (`id` = `embedder.identity.model` or `reranker.provider`).
- Core: `startWarmup` starts right after `setState(ready)`, so B8 "ready < 3 s" is unaffected. `status()` must stay synchronous for `core.status` (B11 < 5 ms). So the core caches the engine's `status()` result: once after start, again after `onDone`, and at most every 1 s on demand. It keeps `engine.degraded` from `EngineStatus.degraded` and `engine.models` from `projectModels`. The core sets `engine.ready = degraded === null`. While `EngineStatus.models.*.warming` is true, the core refreshes the cache every 250 ms, so `models-warming` → `null` is seen promptly. `stop()` aborts the warm-up first (its signal is the shutdown signal). Flat embedder (test internals): the engine reports the embedder `ready` after the probe and the reranker `disabled`, so the existing tests see `engine.ready` true within one refresh. Any existing test that asserts `engine.ready` right after start waits for it.
- `1staid check` `models.warm`: `engine.degraded === null` → ok; `models-warming` → warn; `model-failed` → fail with `detail = { capability, error }`; core absent → skip.

- [ ] **Step 1: Write the failing tests:**
  - warmup.test (fake engine objects): `calls models.warm once with the shutdown signal and reports the result`; `abort ends the wait without throwing`; `projectModels maps identity.model and reranker provider to id and drops unknown fields`.
  - core.test: `engine is models-warming until warm completes, process stays ready`. Use a `testInternals` embedder whose first `embedQuery` resolves after 300 ms: the first `core.status` has `process.state === "ready"` and `engine.degraded.reason === "models-warming"`; after 600 ms `engine.ready === true`, `degraded === null` and `models.embedder.state === "ready"`. Also `a failed embedder probe is model-failed and memory.recall still answers`.
  - firstaid: `models_warming_is_a_warning` (fake core status).
  - **Nightly acceptance (macOS first-recall budget):** in `two-session-recall.test.ts`, delete the unasserted "warm-up recall" block. After `startCore`, call a new helper `waitEngineReady(h, 60_000)` in `tests/system/helpers.ts`: it polls `plur1bus 1staid check --json` every 250 ms until check `models.warm` is `ok` and throws on `fail` or timeout. Record `warmMs` with `t.diagnostic`. Then, with `REAL`, the **first** measured recall has `degraded === null`, `timing.exceededBudget !== true` and `timing.totalMs < 400`, and the reranker ran (existing assertions). This is the check that failed on macOS (582 ms, `exceededBudget: true`).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Bump the pin**, then implement `warmup.ts`, the schema, the status cache and the check. Run `pnpm gen` and `pnpm docs:gen`.
- [ ] **Step 4: Run** Green and the flat system tests. Trigger `nightly.yml` (`workflow_dispatch`) on the branch once the owner has pushed it: both OS must pass, and the macOS diagnostic must show a first-recall `totalMs < 400`. Record the B8 numbers (`readyMs`, `warmMs`) for Task 16.
- [ ] **Step 5: Commit** `feat(core): background model warm-up; models-warming until ready (spec §6.3, E4, contract 1.8.0); first real-model recall within the 400 ms soft budget`.

---

### Task 14: Shared-memory status and `unsupported` (E4) in `core.status`, memory ops, `daemon status`, `1staid check`

**Files:**
- Create: `packages/core/src/shared-memory.ts`, `packages/core/test/shared-memory.test.ts`
- Modify: `packages/rpc-schema/schema/rpc.schema.json`. New `$defs/SharedMemoryStatus`, closed: `{ supported: boolean, mode: "fd-capability"|"verified-path"|"unavailable", reason?: string }`. `CoreStatus.engine.sharedMemory` is optional.
- Modify: `packages/core/src/memory-ops.ts` (`mapMemoryOpError`: `unsupported` → `E_NOT_AVAILABLE`, `reason: "unsupported"`, `ids` = detail), `packages/core/test/memory-ops-map.test.ts`, `packages/core/test/memory-ops.test.ts` and `tests/system/memory-ops.test.ts` (the non-Linux branch now expects `E_NOT_AVAILABLE reason=unsupported`, no longer `E_STORAGE`), `packages/core/src/core.ts`, `crates/plur1bus/src/commands/{firstaid.rs,daemon.rs}`, `crates/plur1bus/src/commands/memory_ops.rs` (human hint on `unsupported`: `explicit shared memory is not available on this platform`), `tests/system/helpers.ts`
- Test: `crates/plur1bus/tests/firstaid.rs`

**Interfaces:**
- Produces: `export function sharedMemoryStatus(es: unknown): SharedMemoryStatus | null`. It projects `EngineStatus.sharedMemory` and returns `null` when absent. It is included in `status().engine` from the Task 13 cache.
- `1staid check` `memory.shared` (after `models.warm`): `supported` → ok with the mode in `summary`; unsupported → **warn**, not fail (agent-private memory works), `summary: "explicit shared memory unavailable (<reason>)"`, hint `share and proposals answer E_NOT_AVAILABLE on this platform`. Absent → skip. `daemon status` human output gains the line `shared memory: <mode> | unavailable (<reason>)`.
- `tests/system/helpers.ts`: `SHARED_MEMORY` stays as the fallback. New `sharedMemorySupported(h)` reads `engine.sharedMemory.supported` through `1staid check --json`, and the system test gates on it.

- [ ] **Step 1: Write the failing tests:** `sharedMemoryStatus projects supported, mode and reason, drops unknown fields, null when absent`; memory-ops-map `unsupported maps to E_NOT_AVAILABLE reason unsupported with ids capability and reason`; core.test `core.status carries engine.sharedMemory` (Linux: `supported === true`, `mode === "fd-capability"`; other OS: `supported === false`, `mode === "unavailable"`, `reason === "platform"`; branch on `process.platform`); memory-ops.test (non-Linux branch) `share on an unsupported platform is E_NOT_AVAILABLE unsupported`; firstaid `shared_memory_unavailable_is_a_warning_not_a_failure` (fake core status → warn, exit 0).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** Green and the system tests (macOS locally if available; CI otherwise).
- [ ] **Step 5: Commit** `feat(core,cli): shared-memory support in core.status, daemon status and 1staid check; unsupported → E_NOT_AVAILABLE (E4)`.

---

### Task 15: Journal backlog capability, replay `runId` and `duplicate-turn`, job health (E4)

**Files:**
- Modify: `packages/core/src/journal.ts` (`journalBacklog(dir): { entries: number; oldestAt: number | null }`, which counts complete lines across `*.jsonl` and `*.replaying-*` and reads `at` of the oldest; replay passes `runId: line.id` in the `TurnRecord` and treats `reason === "duplicate-turn"` as done), `packages/core/src/host.ts` (`capabilities: { journalBacklog: () => journalBacklog(layout.journal) }`), `packages/core/src/core.ts` (`journalBacklog` in `core.status` from `EngineStatus.journal.entries` when present, else the replay count)
- Modify: `packages/rpc-schema/schema/rpc.schema.json` (`CoreStatus.jobs` optional: `{ ledger: "ok"|"unavailable", agents: [{ agentId, running: string[], breakerOpen: boolean, unreadableLines: integer, lastRuns: { [job]: { outcome: JobOutcome, reason?, finishedAt } } }] }`, closed except `lastRuns` keys), `crates/plur1bus/src/commands/firstaid.rs` (`jobs.last-runs` reads `core.status.jobs` when present, else the `jobs.history` fallback of Task 11; new warn when `breakerOpen` or `unreadableLines > 0`)
- Test: `packages/core/test/journal.test.ts`, `packages/core/test/core.test.ts`, `crates/plur1bus/tests/firstaid.rs`

**Interfaces:**
- Produces: `export function journalBacklog(dir: string): { entries: number; oldestAt: number | null }` (sync, bounded: stops counting past 100 000 lines and reports that bound). The engine calls it through the capability under its own 50 ms cap.
- R20 amended: a line leaves the journal if its capture resolved with `stored + skipped > 0` and **no reason other than `duplicate-turn`**. That closes the at-least-once gap ADR-012 §7 named: a replay after a crash between append-back and delete is now a no-op in the engine, and it is no longer only absorbed by the vector dedup.

- [ ] **Step 1: Write the failing tests:** journal.test `journalBacklog counts lines across live and replaying files and reports the oldest at`; `replay passes the line id as runId`; `a duplicate-turn result removes the line`. core.test: `core.status journalBacklog comes from the engine's journal status` (write two journal lines for an unregistered agent so they are kept → `journalBacklog === 2`); `core.status.jobs lists last runs after a job run` (`jobs.run gc-run` → `jobs.agents[0].lastRuns["gc-run"].outcome` is `completed` or `skipped`). firstaid: `an open breaker is a warning`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**; `pnpm gen`, `pnpm docs:gen`.
- [ ] **Step 4: Run** Green and both system tests. The kill soak's "no journal line lost" still holds; run it once more with `PLUR1BUS_SOAK_TURNS=200`.
- [ ] **Step 5: Commit** `feat(core): journal backlog host capability, replay runId with duplicate-turn (Q3, E4), job health in core.status and 1staid check`.

---

### Task 16: ADR implementation records and AGENTS.md

**Files:**
- Modify: `docs/adr/ADR-012-process-model-and-languages.md`:
  - §1: the supervisor is built.
  - §3: RPC 1.2.0, `x-server`, the supervisor handshake with its own capabilities, `daemon.*`, `core.adopt`, `CoreStatus`, `deprecationsUsed`, `models`, `sharedMemory`.
  - §4: the Windows ACL as built (S11); the pipe-server pid check.
  - §8: rewritten as "What 2a-H3a superseded". `core run` stays as a developer path; config ownership points to 2a-H3b.
  - New "§10 Supervision": S3–S9, S14, S17.
  - Deviations table: S5 (no PDEATHSIG/Job Object), S7 (`engine.degraded` instead of a top-level `degraded`), S11 (core pipe default DACL). The warm-up row is closed, with the B8 numbers from Task 13. §3/§7: `unsupported` → `E_NOT_AVAILABLE`; R20 amended by `duplicate-turn` (Task 15).
- Modify: `docs/adr/ADR-013-configuration-and-restart-classes.md` — `supervisor.graceMs`/`healthIntervalMs` and `logs.*` are now consumed (at supervisor and core start; live application is 2a-H3b-1); the forward references now name 2a-H3b.
- Modify: `docs/adr/ADR-016-api-stability-and-versioning.md` — `## Implementation record (2a-H3a)`: G2 closed (supervisor capabilities, `x-server` filter), deprecations listed by `1staid check` (S13), G3 still deferred to 2a-H3b-2.
- Modify: `AGENTS.md`:
  - "Where things live": `supervisor/`, `service/`, `daemon`, `service`, `1staid check`; the remaining stubs name `2a-H3b`.
  - Env vars: `PLUR1BUS_SUPERVISOR_TIME_SCALE`, `PLUR1BUS_SOAK_TURNS`, `PLUR1BUS_SOAK_SEED`, `PLUR1BUS_SERVICE_TEST`.
  - "Running the core by hand" gains `plur1bus daemon start` next to `core run`.
  - `tests/system` now exists.
  - Conventions: every method carries `x-server`.

- [ ] **Step 1: Write the records** from the merged code (cite files and function names, not line numbers). The stubs `setup`, `module`, `update` and `1staid repair` now say `2a-H3b`: update `main.rs`, `cli.rs` and the gen-docs intro milestone list in this task if Tasks 9 and 11 did not already.
- [ ] **Step 2: Run** `pnpm lint`, `pnpm docs:gen`, `pnpm docs:check` → exit 0.
- [ ] **Step 3: Commit** `docs(adr): 2a-H3a implementation records (ADR-012, ADR-013, ADR-016); AGENTS.md`.

---

## 2a-H3b — outline (own full plan after 2a-H3a merges)

Same Global Constraints; builds on 2a-H3a's supervisor. Tasks named, not detailed:

1. **H3b-1 Supervisor owns `config.json`** — `config.get|set|watch` on the supervisor (`x-server: supervisor`), `config.changed { diff, restartPlan }` and the supervisor's `events.subscribe`; file watcher (invalid edit rejected, running config kept); restart-plan execution in dependency order; the core loads the `config.get` snapshot when supervised (file read stays for `core run`), applies `live` keys (`core.logLevel`, recall budgets, `supervisor.*`, `logs.*`); `HostServices.mutateConfig` → `config.set`; the CLI's `config set` routes through the supervisor when it runs. Criterion 4.
2. **H3b-2 Module manifest and loader** — D14 manifest schema in `packages/module-api` (`provides`, `consumes`, `implements`, `extensionPoints`, `scope`, `priority` bands), `run/module-<name>.lock`, supervisor spawns modules with stdin lifelines, `module.adopt` in module-api, current and previous `apiVersion` side by side (ADR-016 G3).
3. **H3b-3 `module list|start|stop|restart|graph`** plus a fixture module (priority 500, `scope: installation`), `module.state` notification, `x-restart: module:<name>` executed. Criteria 5 and 12.
4. **H3b-4 `setup` installer** — state root, pinned Node runtime download verified against a SHA-256 manifest baked into the binary, core payload into `runtime/core/`, config defaults, basic-tier-only questions (G4) with the ADR-006 embedding use-class and the audit-logged NC-licence gate, skill copy, `service install`, start, `1staid check`; `--non-interactive`, `--accept-nc-licence`, `--no-service`; `curl | sh` and PowerShell one-liners.
5. **H3b-5 `update --check`** — installed `root/manifest.json` vs a release manifest; which units would restart.
6. **H3b-6 `1staid repair` and installer checks** — checks `runtime.node` (presence, hash), `models.cache`; `repair [--yes] [--dry-run]` (fix `run/` permissions, remove stale sockets/PIDs, config vs backup, re-download the runtime, renew the service, terminate a hung core by peer pid after confirmation); `admin.migrate` as a repair step for a store-schema mismatch (G5).
7. **H3b-7 Admin ops over RPC and CLI** — `admin.obsidian.detect|prepare|confirm`, `admin.migrate`, `admin.embedding.probe` (status, `refresh`) and `admin.embedding.serve` (address or `null`) from `Engine.admin`/`Engine.embedding` (contract ≥ 1.7.0), closed params, the H2 principal rules; CLI names decided in that plan.
8. **H3b-8 Operations skill** — `skills/plur1bus-harness/SKILL.md`, `docs/operations.md`, the freshness test (every named command exists and supports `--json`). Criterion 10.
9. **H3b-9 Release and exit** — macOS signing and notarisation in the release workflow (§6.5), the B1/B8/B9/B11 baseline report on the five targets, CHANGELOG, `docs/milestones.md`, the demo guide (§12).
10. **H3b-10 ADR records** for the above.

---

## Self-review (done while writing)

- **Spec coverage:**
  - Spec §4 supervisor → Tasks 5 and 6. §6.4 health, backoff, lifeline/grace, adoption, clients under core loss → Tasks 3, 4, 6, 7 and 9. §6.5 service → Task 8 (`setup` → H3b-4). §6.6 `daemon`, `service`, `1staid check` → Tasks 9, 8 and 11 (`repair` → H3b-6). §6.3 warm-up → Task 13.
  - Criteria: 2 → Task 12; 3 → Tasks 7 and 12; 8 (B1 stays, B8 recorded) → Global Constraints and Tasks 13 and 16; 9 → Task 8; 4, 5, 10 and 12 → H3b.
  - ADR-016: G2 → Task 2; §5 deprecations → Task 11; G3 → H3b-2.
  - Windows ACL → Task 10. Nightly macOS 582 ms → Task 13 acceptance. Shared-memory status → Task 14. E4's harness-side items (warm, status mapping, `journalBacklog`, replay `runId`) → Tasks 13–15. Admin ops → H3b-7.
- **Type consistency:**
  - `buildCapabilities(features, server)` and `capabilities(server, features)` (Task 2) are used by Tasks 5 and 11. `Endpoint`/`connect_endpoint`/`hello() -> &Value` (Task 2) are used by Tasks 5, 6, 7, 9 and 11.
  - `core.adopt`, `CoreStatus` and `ChildStatus` (Task 2) are served in Task 3 and consumed in Tasks 6, 7 and 11.
  - `Backoff`/`ChildState`/`classify_exit` (Task 4) are used by Tasks 6 and 7. `RotatingFile`/`Shared` (Task 5) are used by Task 6.
  - `peer_pid` (Task 7) is used by Tasks 10 and 11. `service::status` (Task 8) is used by Tasks 9 and 11. `supervisor_detail` (Task 9) is used by Task 12.
  - `pipe_dacl_report`/`writable_by_others` (Task 10) are used by Task 11. The Task 13 status cache feeds Tasks 14 and 15. `ModelStatus`, `SharedMemoryStatus` and `CoreStatus.jobs` feed Task 11's `models.warm`, `memory.shared` and `jobs.last-runs` checks.
- **Review Focus:** each line names a test in its owning task (Tasks 4, 5, 6, 7, 8, 9 and 11).
