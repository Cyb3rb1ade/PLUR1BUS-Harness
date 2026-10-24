# CPU core limit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drop the sandbox's fixed process limit and add `supervisor.maxCores`, a live CPU core limit for every PLUR1BUS process with host core detection, set from the CLI and from a slider in the web UI.

**Architecture:** The supervisor detects its CPUs at start and binds its own process tree to the first `maxCores` of them through CPU affinity, which every child process and thread inherits. `daemon.status` reports the result; the web settings read it for the slider's range.

**Tech Stack:** Rust (`libc` on Linux, `windows-sys` 0.59 on Windows), TypeScript (Preact web UI, node:test, Playwright), JSON Schema.

**Spec:** `docs/superpowers/specs/2026-10-24-cpu-core-limit-design.md`

## Global Constraints

- Thread and process counts are never limited.
- `supervisor.maxCores`: integer, `minimum` 0, `maximum` 1024, `default` 0, `x-restart: "live"`, `x-tier: "advanced"`.
- 0, or a value at or above `cpu.detected`, means every core.
- RPC version stays 1.6.0; `daemon.status.cpu` is optional.
- Generated files (`docs/config.md`, `docs/rpc.md`, config fixtures, `settings-index.ts`) come from `pnpm gen` / `pnpm docs:gen`, never by hand.
- German UI text uses "du" and no gendered forms.

## Review Focus

- A configured value above the host's count (a config from a bigger machine): every core is used, the slider sits at the right end, `state` is `unlimited`. Pinned in Task 3 (`plan`) and Task 5 (model test).
- A host with one core: nothing to bind, the slider cannot move. Pinned in Task 3 (`plan`) and Task 5.
- A live change from a limit back to 0: running processes are widened to the start set again. Pinned in Task 3's integration test.
- An adopted core is not a descendant of the supervisor: it is bound too. Pinned by `bind` taking extra roots (Task 3 unit test with a non-descendant pid).
- `daemon.status` not reachable from the browser (older supervisor, refused): the field falls back to the number input. Pinned in Task 5.

---

### Task 1: Sandbox launcher without a process limit

**Files:**
- Modify: `crates/plur1bus/src/bin/plur1bus-sandbox-limits.rs`
- Modify: `packages/core/src/tools/sandbox/{types,index,ports}.ts`
- Modify: `packages/core/test/tools/sandbox/sandbox.test.ts:14`
- Create: `crates/plur1bus/tests/sandbox_limits.rs`

**Interfaces:**
- Produces: launcher argv `<cpu-seconds> <memory-bytes> <program> [args…]`; `SandboxPolicy.limits` without `maxProcesses`; `SandboxResult.resources` without `maxProcesses`.

- [ ] **Step 1: Write the failing tests** (`sandbox_limits.rs`, unix): `the_launcher_keeps_the_inherited_process_limit` runs `plur1bus-sandbox-limits 30 1073741824 /bin/sh -c 'grep "^Max processes" /proc/self/limits'` (Linux only) and asserts the line equals the test process's own; `the_launcher_refuses_missing_or_zero_limits` asserts exit 125 for two arguments and for `0 1073741824 /bin/true`.
- [ ] **Step 2: Run** `cargo test -p plur1bus --test sandbox_limits` — expect the first test to FAIL (the old launcher reads `/bin/sh` as the process count).
- [ ] **Step 3: Implement** the two-limit argv in the launcher (drop `RLIMIT_NPROC`), and drop `maxProcesses` from the three TS files and the test fixture.
- [ ] **Step 4: Run** the Rust test and `node --experimental-strip-types --conditions=source --test packages/core/test/tools/sandbox/sandbox.test.ts` with bubblewrap installed — expect PASS, including the real-backend case.
- [ ] **Step 5: Commit** `fix(sandbox): drop the per-user process limit from the launcher`.

### Task 2: `supervisor.maxCores` in the config schema

**Files:**
- Modify: `packages/config-schema/schema/config.schema.json` (`supervisor` section and its description)
- Modify: `packages/config-schema/src/index.ts:39` (`supervisor: { graceMs; healthIntervalMs; maxCores: number }`)
- Modify: `packages/web/src/pages/settings/config/meta.ts:19` (`n("supervisor.maxCores", 0, 0, "live", 1024)`)
- Regenerate: `packages/config-schema/fixtures/*`, `packages/web/src/palette/settings-index.ts` (`pnpm gen`)

- [ ] **Step 1: Add the key** with the values from Global Constraints and a description that says 0 means every core, that it covers the supervisor, core, API, modules and the programs they start, and that macOS cannot enforce it.
- [ ] **Step 2: Run** `pnpm gen`, then `pnpm --filter @plur1bus/config-schema test` and the web unit tests `settings-config-model.test.ts` and `palette-index.test.ts` — expect PASS.
- [ ] **Step 3: Commit** `feat(config): supervisor.maxCores`.

### Task 3: The supervisor binds its process tree

**Files:**
- Create: `crates/plur1bus/src/supervisor/cpu.rs`
- Modify: `crates/plur1bus/src/supervisor/mod.rs` (`SupervisorState.cpu`, start sequence before the first `start_child`, `status_json`, the adoption path)
- Modify: `crates/plur1bus/src/supervisor/config.rs` (`apply_live` calls `cpu::apply`)
- Create: `crates/plur1bus/tests/supervisor_cpu.rs`

**Interfaces:**
- Produces: `cpu::Host { cpus: Vec<usize>, count: usize }`; `cpu::Host::detect() -> Host`; `cpu::plan(host: &Host, max: u64) -> Option<Vec<usize>>`; `cpu::configured(config: &Value) -> u64`; `cpu::Cores { host, max, state }` with `Cores::status_json(&self) -> Value` (`{ detected, maxCores, effective, state, reason? }`); `cpu::apply(shared: &Shared, config: Option<&Value>)`; `cpu::bind_adopted(shared: &Shared, pid: u32)`.

- [ ] **Step 1: Write the failing unit tests** in `cpu.rs`: `plan` returns `None` for 0, for `max >= count` and for a one-core host, and the first `max` ids otherwise (`plan(&Host { cpus: vec![0,2,4,6], count: 4 }, 2) == Some(vec![0,2])`); a quota-capped host (`cpus` 0..16, `count` 2) gives `None` for 2 and `Some(vec![0])` for 1. Linux: `bind_reaches_every_thread_of_a_tree_and_extra_roots` spawns `sh -c 'sleep 30 & wait'` and a separate `sleep 30`, binds `[own pid, separate pid]` to CPU 0 and asserts `Cpus_allowed_list: 0` in `/proc/<pid>/status` of the shell, its `sleep` child and the separate process (skipped on a one-CPU host).
- [ ] **Step 2: Run** `cargo test -p plur1bus --lib supervisor::cpu` — expect compile FAIL.
- [ ] **Step 3: Implement** `cpu.rs`: Linux walks `/proc/*/stat` (ppid after the last `)`) from the roots and calls `sched_setaffinity` on every `/proc/<pid>/task/<tid>`, twice, ignoring `ESRCH`; Windows calls `SetProcessAffinityMask` on the supervisor and on each running child opened by pid; other platforms report `unsupported` when a limit is set. Wire `apply` into the start sequence and `apply_live`, and `bind_adopted` after an adoption. Log each change once.
- [ ] **Step 4: Write the integration test** `max_cores_binds_the_core_and_a_change_applies_live` (Linux, at least two CPUs): `config.json` with `supervisor.maxCores: 1`, `start_with_core`; `daemon.status.cpu` is `{ state: "limited", effective: 1 }` and validates against the schema; the fake core's `Cpus_allowed_list` has one CPU; `config.set supervisor.maxCores 0` gives `state: "unlimited"` and the core's list equals the supervisor's start list.
- [ ] **Step 5: Run** `cargo test -p plur1bus --lib supervisor::cpu` and `cargo test -p plur1bus --test supervisor_cpu` — expect PASS.
- [ ] **Step 6: Commit** `feat(supervisor): bind every PLUR1BUS process to supervisor.maxCores cores`.

### Task 4: `cpu` in `daemon.status`, the CLI and the API

**Files:**
- Modify: `packages/rpc-schema/schema/rpc.schema.json` (`daemon.status` result gains optional `cpu`)
- Modify: `crates/plur1bus/src/commands/daemon.rs` (`status_parts` keeps `cpu`; human line `cpu: …`)
- Modify: `packages/api/src/rpc-route.ts:30` and `packages/api/test/web-rpc.test.ts`

**Interfaces:**
- Consumes: `Cores::status_json` from Task 3.
- Produces: `daemon.status/1` documents with `cpu`; `/rpc` accepts `daemon.status` for web sessions.

- [ ] **Step 1: Write the failing tests**: in `daemon.rs`, `the_cpu_line_names_the_limit_or_every_core` asserts `describe_cpu` for `limited` ("4 of 8 cores (supervisor.maxCores)"), `unlimited` ("all 8 cores"), `unsupported` (names the reason); in `web-rpc.test.ts` the allowlist now includes `daemon.status`.
- [ ] **Step 2: Run** them — expect FAIL.
- [ ] **Step 3: Implement** the schema property (`detected` ≥ 1, `maxCores` ≥ 0, `effective` ≥ 1, `state` enum, optional `reason`, `additionalProperties: false`), the CLI line and pass-through, and the allowlist entry.
- [ ] **Step 4: Run** `pnpm gen`, the rpc-schema tests, the daemon unit tests, the API tests and Task 3's integration test — expect PASS.
- [ ] **Step 5: Commit** `feat(cli,api): report the CPU core limit in daemon status`.

### Task 5: The slider in Settings → General

**Files:**
- Modify: `packages/web/src/pages/settings/config/model.ts` (`Field.cores?: CoreInfo`, `buildFields(…, host?)`, `coreSliderValue`, `coreDraftValue`)
- Modify: `packages/web/src/pages/settings/config/fields.ts` (range control when `f.cores` is set)
- Modify: `packages/web/src/pages/settings/sections/config.ts` (`loadConfig` reads `daemon.status` for the general section; failures leave `cores` unset)
- Modify: `packages/web/src/i18n/settings.ts`, `packages/web/src/styles/config.css`
- Test: `packages/web/test/settings-config-model.test.ts`, `packages/web/test/settings-config.test.ts`, `packages/web/test/settings-config-fixtures.ts`

**Interfaces:**
- Consumes: `daemon.status.cpu` from Task 4.
- Produces: `type CoreInfo = { detected: number; effective: number; state: "unlimited" | "limited" | "unsupported" | "failed"; reason?: string }`; `coreSliderValue(draft: string, detected: number): number` (0 or ≥ detected → detected); `coreDraftValue(position: number, detected: number): string` (detected → "0").

- [ ] **Step 1: Write the failing tests**: model — `coreSliderValue("0", 8) === 8`, `coreSliderValue("12", 8) === 8`, `coreSliderValue("3", 8) === 3`, `coreDraftValue(8, 8) === "0"`, `coreDraftValue(3, 8) === "3"`; `buildFields` attaches `cores` only to `supervisor.maxCores`. Browser — with `daemon.status` returning `detected: 8` the field is a slider labelled by the field label with value text "All 8 cores"; ArrowLeft twice then Review sends `{ key: "supervisor.maxCores", value: 6 }`; End sends 0 again; `state: "unsupported"` shows the macOS note; a refused `daemon.status` leaves a text input; German shows "Alle 8 Kerne".
- [ ] **Step 2: Run** `pnpm --filter @plur1bus/web test` — expect FAIL.
- [ ] **Step 3: Implement** the model helpers, the range control (native `input type=range`, `aria-valuetext`, hint and meta lines in place of the schema bounds) and the strings.
- [ ] **Step 4: Run** the web tests with Chromium (`PLUR1BUS_WEB_E2E_REQUIRED=1`) — expect PASS.
- [ ] **Step 5: Commit** `feat(web): core slider in the general settings`.

### Task 6: Documentation and full verification

**Files:**
- Modify: `docs/user/de/einstellungen-allgemein.md`, `docs/user/en/general-settings.md` (Supervisor row and a slider paragraph), `AGENTS.md` (supervisor row names `cpu.rs`)
- Regenerate: `docs/config.md`, `docs/rpc.md` (`pnpm docs:gen`)

- [ ] **Step 1: Write** the docs.
- [ ] **Step 2: Run** `pnpm docs:gen`, `pnpm docs:check`, `cargo fmt --all -- --check`, `cargo clippy --workspace --all-targets -- -D warnings`, the touched packages' tests and `pnpm lint` as far as the missing engine allows — expect PASS; name every check that cannot run here.
- [ ] **Step 3: Commit** `docs: supervisor.maxCores`.
