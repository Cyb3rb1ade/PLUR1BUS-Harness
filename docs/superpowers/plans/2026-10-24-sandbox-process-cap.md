# Per-sandbox process cap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Without those skills, work the tasks in order, one commit per task.

**Goal:** `tools.sandbox.maxTasks` (default 512) caps the tasks of one sandboxed run, counted in that run's own user
namespace, in the tool sandbox and in the coding-gate verifier on Linux; `detectSandbox` and Doctor report whether the
cap holds.

**Architecture:** The launcher `plur1bus-sandbox-limits` gets two modes that run *inside* bubblewrap: `--tasks` sets
`RLIMIT_NPROC` and execs the program, `--probe-tasks` measures whether the kernel enforces that limit per namespace.
The core binds the launcher into the sandbox at a fixed path, puts the `--tasks` step in front of the program when the
probe says the cap holds, and reports the probe result.

**Tech Stack:** Rust 1.95 (`libc` only, no new crate), TypeScript on Node 24.21 (`node:test`), JSON Schema config.

**Spec:** `docs/superpowers/specs/2026-10-24-sandbox-process-cap-design.md` (read it first; this plan argues from it).

## Global Constraints

- Work on branch `claude/practical-ramanujan-s5ac9d`; push there; the pull request is #765 (one PR for this package).
  The branch already merges `claude/wizardly-pasteur-jjhy5x` (PR #764: launcher without `RLIMIT_NPROC`, no
  `maxProcesses` in the TS types). If `main` moves, merge it in; never rebase or force-push.
- Commits authored as `Cyb3rb1ade <cyb3rblade@me.com>`.
- Toolchain: `export PATH=/home/claude/.node24/bin:$PATH` (or any Node 24.21), pnpm 10, Rust 1.95. Prepare with
  `pnpm test:prep`; the TS sandbox tests need `cargo build -p plur1bus --bin plur1bus-sandbox-limits` first.
- The outer launcher mode (`<cpu> <memory> <program> …`) never sets `RLIMIT_NPROC`. The `--tasks` mode never sets it in
  the caller's own user namespace.
- The cap never makes a launch or a verifier check fail that would run without it.
- Values: default `512`; range `0`–`65536`; `0` = off; `RLIMIT_NPROC` = `maxTasks + 1`; inner path
  `/run/plur1bus/sandbox-limits`; probe forks at most 4 children.
- TypeScript: `erasableSyntaxOnly` (no `enum`, no parameter properties). Match the dense one-line style of the files
  you touch.
- Generated files only through `pnpm gen` and `pnpm docs:gen`, never by hand.
- Never skip, disable or quarantine a test to get green. Do not poll CI (`AGENTS.md`).

## Review Focus

- An inherited `RLIMIT_NPROC` hard limit below `maxTasks + 1` (an admin's `ulimit -u`): the `--tasks` mode keeps the
  lower hard limit instead of failing. Pinned in Task 1.
- An installed launcher from an older build, without the new modes: the probe exits 125, the sandbox stays available
  and only the cap is reported as not enforceable. Pinned in Task 3.
- Program arguments that contain `--`: only the first `--` after `--tasks <n> <ns>` separates; later ones reach the
  program. Pinned in Task 1.
- Two sandboxed runs at the same time: each has its own cap, and the user keeps starting processes outside. Pinned
  in Task 3.
- `maxTasks` 0: no inner step, `resources.maxTasks` is `null`, Doctor warns on Linux and stays `ok` on macOS. Pinned in
  Tasks 3 and 5.

---

### Task 1: Launcher modes `--tasks` and `--probe-tasks`

**Files:**
- Modify: `crates/plur1bus/src/bin/plur1bus-sandbox-limits.rs`
- Test: `crates/plur1bus/tests/sandbox_limits.rs` (existing tests stay)

**Interfaces:**
- Produces (CLI, Linux only; on other Unix both modes exit 125 with "the task cap mode is Linux-only"):
  - `plur1bus-sandbox-limits --tasks <n> <outer-userns> -- <program> [args…]`: `n` a positive integer, `<outer-userns>`
    the text of the caller's `readlink /proc/self/ns/user` (e.g. `user:[4026531837]`), `args[3]` must be `--`, a program
    must follow. If its own `/proc/self/ns/user` differs from `<outer-userns>`: `setrlimit(RLIMIT_NPROC)` soft and hard
    to `min(n, inherited hard)`, then exec. If equal or unreadable: stderr
    `sandbox launcher: process cap skipped: the sandbox shares the caller's user namespace`, exec without the limit.
  - `plur1bus-sandbox-limits --probe-tasks <outer-userns>`: prints exactly one line, exit 0:
    `shared-userns` (same or unreadable namespace), else after setting the limit to `min(tasks in /proc + 1, hard)`
    and forking up to 4 children that block on a pipe until the parent closes it: `per-user` when 0 forks succeed,
    `enforced` for 1–2, `not-enforced` for 3–4. The parent reaps every child before printing.
  - Usage errors exit 125 with `sandbox launcher: …` on stderr, like today. The task count is the number of entries
    under `/proc/<pid>/task` for every numeric `/proc/<pid>`, skipping entries that vanish while counting.

- [ ] **Step 1: Write the failing tests** (all `#[cfg(target_os = "linux")]`; turn the existing `line` closure into
  `fn max_processes(limits: &str) -> Option<String>`; `fn own_userns() -> String` reads `/proc/self/ns/user`)

```rust
#[test] fn the_task_mode_refuses_bad_arguments() {
    let cases: [&[&str]; 6] = [&["--tasks"], &["--tasks", "0", "user:[1]", "--", "/bin/true"],
        &["--tasks", "x", "user:[1]", "--", "/bin/true"], &["--tasks", "7", "user:[1]", "/bin/true"],
        &["--tasks", "7", "user:[1]", "--"], &["--probe-tasks"]];
    // each: exit code Some(125)
}
#[test] fn the_task_mode_sets_the_limit_outside_the_callers_namespace() {
    // launcher --tasks 7 user:[1] -- /bin/cat /proc/self/limits → success; max_processes matches r"^Max processes\s+7\s+7\s"
}
#[test] fn the_task_mode_keeps_a_lower_inherited_hard_limit() {
    // /usr/bin/prlimit --nproc=50:50 <launcher> --tasks 512 user:[1] -- /bin/cat /proc/self/limits → Max processes 50 50
}
#[test] fn the_task_mode_skips_the_cap_in_the_callers_namespace() {
    // --tasks 7 <own_userns()> -- /bin/cat /proc/self/limits → max_processes == the test's own; stderr contains "process cap skipped"
}
#[test] fn the_task_mode_passes_later_double_dashes_to_the_program() {
    // --tasks 7 user:[1] -- /bin/echo -- x → stdout == "-- x\n"
}
#[test] fn the_probe_reports_what_the_kernel_enforces() {
    // launcher --probe-tasks <own_userns()> (no new namespace) → stdout "shared-userns\n"
    // /usr/bin/unshare --user --map-current-user --pid --fork --mount-proc <launcher> --probe-tasks <own_userns()>:
    //   if unshare is missing or fails with empty stdout → eprintln!("skipped: no user namespace: …") and return
    //   expected: geteuid()==0 → "not-enforced"; kernel (/proc/sys/kernel/osrelease) >= 5.14 → "enforced"; else "per-user"
}
```

- [ ] **Step 2: Run them to see them fail**

Run: `cargo test -p plur1bus --test sandbox_limits`
Expected: the new tests FAIL (the launcher reads `--tasks` as a CPU limit and exits 125 with "invalid cpu limit").

- [ ] **Step 3: Implement the two modes** in the launcher: dispatch on `args[0]` before the existing parse, one
  function per mode (`fn task_cap(args: &[String]) -> Result<(), String>`, `fn probe_tasks(args: &[String]) ->
  Result<(), String>`), `libc::fork`/`pipe`/`waitpid`/`getrlimit`/`setrlimit` in `unsafe` blocks with the existing
  error style. Update the module doc comment: the outer mode still sets no process limit; the inner modes say why
  they are safe (a new user namespace is counted on its own since Linux 5.14).

- [ ] **Step 4: Run the tests to see them pass**

Run: `cargo test -p plur1bus --test sandbox_limits && cargo clippy -p plur1bus --all-targets -- -D warnings && cargo fmt --all -- --check`
Expected: PASS. As root the probe test expects `not-enforced`; that is correct, not a skip.

- [ ] **Step 5: Commit** `feat(sandbox): launcher modes for a per-namespace task cap and its probe`

### Task 2: Config key `tools.sandbox.maxTasks`

**Files:**
- Modify: `packages/config-schema/schema/config.schema.json` (`tools.sandbox.properties`)
- Modify: `packages/config-schema/src/index.ts:37` (`HarnessConfig.tools.sandbox`)
- Modify: `crates/plur1bus/src/supervisor/config_policy.rs` (test module)
- Regenerated: `packages/config-schema/fixtures/*`, `packages/web/src/palette/settings-index.ts`, `docs/config.md`

**Interfaces:**
- Produces: `HarnessConfig.tools.sandbox.maxTasks: number`; `defaults().tools.sandbox.maxTasks === 512`.

- [ ] **Step 1: Write the failing test** in `config_policy.rs`, beside `sandbox_bypass_is_owner_only_even_for_parent_replacements`:

```rust
#[test]
fn sandbox_task_cap_is_owner_only() {
    let before = json!({"tools":{"sandbox":{"maxTasks":512}}});
    let after = json!({"tools":{"sandbox":{"maxTasks":0}}});
    for role in ["admin", "operator", "member", "viewer"] {
        assert_eq!(changes(schema(), &before, &after, role), Err("config-write-role"));
    }
    assert!(changes(schema(), &before, &after, "owner").unwrap().iter().any(|r| r.key == "tools.sandbox.maxTasks"));
}
```

- [ ] **Step 2: Run it to see it fail** — `cargo test -p plur1bus sandbox_task_cap_is_owner_only` → FAIL (admin may write it).

- [ ] **Step 3: Add the key** with exactly these annotations:

```json
"maxTasks": {
  "type": "integer", "minimum": 0, "maximum": 65536, "default": 512,
  "description": "Most tasks (processes and threads) the programs of one sandboxed run may have together, counted in that run's own user namespace (Linux 5.14 or newer, not as root); bubblewrap's own init process is not counted. Applies to agent tool processes and, on Linux, to the coding-gate verifier. 0 turns the cap off. macOS denies forking in the tool sandbox regardless. Doctor shows whether the cap holds.",
  "x-tier": "advanced", "x-restart": "live", "x-write-roles": ["owner"], "x-audit": true
}
```

  Add `maxTasks: number` to `HarnessConfig`. Run `pnpm gen`, then `pnpm docs:gen`.

- [ ] **Step 4: Verify** — `cargo test -p plur1bus sandbox_task_cap_is_owner_only` PASS; `pnpm --filter @plur1bus/config-schema test` PASS;
  `node packages/config-schema/src/gen-defaults.mjs --check` and `pnpm docs:check` clean.

- [ ] **Step 5: Commit** `feat(config): tools.sandbox.maxTasks`

### Task 3: The cap in the tool sandbox (detection, argv, result)

**Files:**
- Modify: `packages/core/src/tools/sandbox/types.ts`, `backends.ts`, `policy.ts:62`, `index.ts:34-37`
- Test: `packages/core/test/tools/sandbox/sandbox.test.ts` (existing tests stay; fixture `limits` gains `maxTasks: 512`)
- Create: `packages/core/test/tools/sandbox/bomb-tasks.ts` (test helper, below)

**Interfaces:**
- Consumes: Task 1's CLI.
- Produces (exported from `types.ts`, re-exported by `index.ts`):
  - `export const DEFAULT_MAX_TASKS = 512;`
  - `export interface SandboxTasks { mechanism: 'namespace-limit' | 'fork-denied' | 'none'; reason: string; hint?: string }`
  - `SandboxPolicy.limits.maxTasks: number` (0 = off); `SandboxDetection.tasks: SandboxTasks` (always present);
    `SandboxResult.resources.maxTasks: number | null`.
- Produces (exported from `backends.ts`):
  - `export const INNER_LAUNCHER = '/run/plur1bus/sandbox-limits';`
  - `export function outerUserNamespace(): string` — `readlinkSync('/proc/self/ns/user')`, memoized; `''` when unreadable.
  - `export function probeTasks(limitsHelper: string): Promise<SandboxTasks>` — Linux: bubblewrap with the existing
    probe mounts plus `--proc /proc` and `--ro-bind <limitsHelper> INNER_LAUNCHER`, running
    `INNER_LAUNCHER --probe-tasks <outerUserNamespace()>`; cached per `limitsHelper` for the process lifetime.
  - `export function tasksStep(limitsHelper: string, maxTasks: number): { bind: string[]; prefix: string[] }` —
    `bind = ['--ro-bind', limitsHelper, INNER_LAUNCHER]`, `prefix = [INNER_LAUNCHER, '--tasks', String(maxTasks + 1), outerUserNamespace(), '--']`.

Probe results and their copy (`reason` / `hint`):

| Probe | `mechanism` | `reason` | `hint` |
|---|---|---|---|
| `enforced` | `namespace-limit` | `Each sandboxed run has its own task limit in its own user namespace.` | — |
| `per-user` | `none` | `This kernel counts processes per user, not per sandbox; a cap would limit every process of the user.` | `Linux 5.14 or newer enforces the cap per sandbox.` |
| `not-enforced` | `none` | `The kernel does not apply process limits to root.` | `Run PLUR1BUS as a normal user.` |
| `shared-userns` | `none` | `bubblewrap did not create a user namespace; a cap would count every process of the user.` | `Use a bubblewrap without setuid, with unprivileged user namespaces enabled.` |
| exit ≠ 0, other output, timeout | `none` | `The process-cap probe could not run.` | `Install the plur1bus-sandbox-limits launcher of this release.` |
| macOS, fork denied | `fork-denied` | `Seatbelt denies forking: one process per run; threads are not counted.` | — |
| macOS, fork allowed or probe failed | `none` | `The Seatbelt fork probe did not confirm that forking is denied.` | — |
| Windows | `none` | `No sandbox backend on Windows; a future one sets a Job Object process limit.` | — |
| sandbox unavailable | `none` | `The sandbox is unavailable.` | — |

- [ ] **Step 1: Write the failing tests**

```ts
test('backendArgv adds the task step only when the cap is on and enforced', async () => {
  // p = preparePolicy({ ...f.policy, writeRoots: [], limitsHelper: process.execPath }); d(m) = { backend: 'bubblewrap', strength: 'partial', available: true, reason: 'fixture', tasks: { mechanism: m, reason: 'fixture' } }
  // on = backendArgv(p, d('namespace-limit'), ['/bin/echo', '--', 'x']); sep = on.indexOf('--')
  // assert: on has '--ro-bind', p.limitsHelper, INNER_LAUNCHER (consecutive) at an index < on.indexOf('--remount-ro')
  // assert.deepEqual(on.slice(sep + 1), [INNER_LAUNCHER, '--tasks', '513', outerUserNamespace(), '--', '/bin/echo', '--', 'x'])
  // for maxTasks 0 and for mechanism 'none': on.includes(INNER_LAUNCHER) === false
});
test('detection reports the task cap for a missing launcher, Windows and an old launcher', async () => {
  // detectSandbox('/missing').tasks.mechanism === 'none'; detectSandbox('/missing', 'win32').tasks.reason matches /Windows/
  // Linux: stub launcher `#!/bin/sh\nexit 125` (mode 0755, in the fixture dir): when detection.available,
  //   tasks.mechanism === 'none' and tasks.reason matches /probe could not run/ (the sandbox stays available)
});
test('real backend: fork bombs stay inside their own caps while the user keeps starting processes', { timeout: 60000 }, async t => {
  // skip with d.tasks.reason unless d.tasks.mechanism === 'namespace-limit' (Linux, f.policy.writeRoots = [])
  // two parallel sandboxSpawn(['/usr/bin/perl', '-e', 'fork while 1'], { ...policy, limits: { ...limits, maxTasks: 32, timeoutMs: 4000 } })
  // while both run: sample bombTasks() every 50 ms; once both namespaces show >= 2 tasks, start 20 execFile('/bin/true') → all exit 0
  // assert: every sample has each namespace <= 32 tasks; both results timedOut; resources.maxTasks === 32
  // within 3 s after both resolve: bombTasks().size === 0
});
```

  Create `packages/core/test/tools/sandbox/bomb-tasks.ts` with `export function bombTasks(): Map<string, number>`: for
  each `/proc/<pid>` owned by `process.getuid()` whose `comm` is `perl` and whose `ns/user` link differs from the
  test's own, add its `/proc/<pid>/task` entry count under that link (entries that vanish are skipped). Task 4 reuses it.

  In the existing real-backend test add: on macOS `d.tasks.mechanism === 'fork-denied'`; on Linux
  `probe.resources.maxTasks === (d.tasks.mechanism === 'namespace-limit' ? 512 : null)`.

- [ ] **Step 2: Run them to see them fail**

Run: `cargo build -p plur1bus --bin plur1bus-sandbox-limits && cd packages/core && node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning --test --test-concurrency=1 test/tools/sandbox/sandbox.test.ts`
Expected: FAIL (`INNER_LAUNCHER`, `tasks` undefined).

- [ ] **Step 3: Implement**
  - `types.ts`: the interfaces above; the `limits` doc comment says `maxTasks` is per run, set inside the sandbox's
    user namespace, 0 = off.
  - `backends.ts`: every `detectSandbox` return carries `tasks`. Linux: after the existing probe succeeds, `tasks =
    await probeTasks(limitsHelper)`. macOS: after the existing probe succeeds, run `/usr/bin/perl -e 'print
    defined(fork()) ? "forked" : "denied"'` under the same probe profile; `fork-denied` only when stdout is exactly
    `denied` (the macOS real-backend assertion below shows in CI if perl cannot start under that profile). Replace the bubblewrap `reason` text "limits are per process, not aggregate cgroup limits" with "CPU and
    memory limits are per process; the task cap is per run (see tasks)". `backendArgv`: when `d.tasks.mechanism ===
    'namespace-limit' && p.limits.maxTasks > 0`, push `tasksStep(…).bind` before `--remount-ro` and put
    `tasksStep(…).prefix` before `argv` after `--`.
  - `policy.ts:62`: `maxTasks` must be a safe integer 0–65536 (`sandbox task cap must be 0 to 65536`); every other
    limit stays positive.
  - `index.ts`: `resources.maxTasks = detection.tasks.mechanism === 'namespace-limit' && p.limits.maxTasks > 0 ?
    p.limits.maxTasks : null`.

- [ ] **Step 4: Run the tests to see them pass** (same command as Step 2). If you run as root, the bomb test skips
  with "The kernel does not apply process limits to root."; run the file once more as a normal user (e.g. `setpriv
  --reuid=<uid> --regid=<gid> --clear-groups …` with a readable checkout) and report both runs.

- [ ] **Step 5: Commit** `feat(sandbox): per-run task cap in the tool sandbox, probed and reported`

### Task 4: Wiring and the verifier

**Files:**
- Modify: `packages/core/src/tools/sandbox/ports.ts:14,26`, `packages/core/src/composition/index.ts:250` and `:343`
- Modify: `packages/core/src/collab/verifier.ts`
- Test: `packages/core/test/collab/coding-gate.test.ts`, `packages/core/test/tools/sandbox/wiring.test.ts`

**Interfaces:**
- Consumes: Task 3's `DEFAULT_MAX_TASKS`, `probeTasks`, `tasksStep`, `INNER_LAUNCHER`; Task 2's config key.
- Produces:
  - `SandboxOptions { required?: boolean; limitsHelper?: string; maxTasks?: number }`; the internal `policy()` becomes
    `export function sandboxPolicy(o: SandboxPortsOptions, spec: SpawnSpec): SandboxPolicy` (callers renamed) and sets
    `limits.maxTasks = o.sandbox?.maxTasks ?? DEFAULT_MAX_TASKS`. `composeTools` already passes `o.sandbox` through.
  - `export function sandboxVerifier(timeoutMs = 60000, tasks?: { limitsHelper: string; maxTasks: () => number }): VerifierPort`
  - `export function verifierBwrapArgv(o: { root: string; temp: string; program: string; args: readonly string[]; networkAllowed: boolean; step?: { bind: string[]; prefix: string[] } }): string[]`
    — the Linux argv the verifier builds today (moved out of `run`, unchanged), with `step.bind` before `--chdir` and
    `step.prefix` before `program`.

- [ ] **Step 1: Write the failing tests**

```ts
// coding-gate.test.ts
test('the verifier argv carries the task step only when given one', () => {
  // base = verifierBwrapArgv({ root, temp, program: '/usr/bin/node', args: ['t.js'], networkAllowed: false })
  // base.includes(INNER_LAUNCHER) === false; base ends with ['--chdir', root, '/usr/bin/node', 't.js']
  // capped = verifierBwrapArgv({ …same, step: tasksStep('/opt/l', 512) })
  // capped has '--ro-bind', '/opt/l', INNER_LAUNCHER before '--chdir'; capped ends with [...tasksStep('/opt/l', 512).prefix, '/usr/bin/node', 't.js']
});
// module top: launcher = fileURLToPath(new URL('../../../../target/debug/plur1bus-sandbox-limits', import.meta.url));
// capped = process.platform === 'linux' && existsSync('/usr/bin/bwrap') && existsSync(launcher) && (await probeTasks(launcher)).mechanism === 'namespace-limit'
test('a verifier fork bomb is bounded by the cap and ends as a timeout', { skip: capped ? false : 'no enforceable task cap on this host' }, async () => {
  // sandboxVerifier(3000, { limitsHelper: launcher, maxTasks: () => 32 }).run(root, { kind: 'test', argv: ['/usr/bin/perl', '-e', 'fork while 1'] }, …)
  // → ok false, reason 'timeout'; bombTasks() (Task 3's helper) sampled every 50 ms never shows a namespace above 32
});
// wiring.test.ts
test('the sandbox policy carries the configured task cap, 512 by default', () => {
  // sandboxPolicy({ home, roots: [], deny: [], principal: 'p', audit, sandbox: { maxTasks: 7 } }, spec).limits.maxTasks === 7
  // the same without maxTasks → 512
});
```

- [ ] **Step 2: Run them to see them fail** — `cd packages/core && node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning --test --test-concurrency=1 test/collab/coding-gate.test.ts test/tools/sandbox/wiring.test.ts` → FAIL.

- [ ] **Step 3: Implement**
  - `ports.ts`: the option and default above.
  - `composition/index.ts:250`: `sandbox: { required: cfg.tools.sandbox.required, maxTasks: d.config().tools.sandbox.maxTasks }`
    (read per turn, so the `live` key applies without a restart).
  - `composition/index.ts:343`: `new CodingGate({ …, verifier: sandboxVerifier(60000, { limitsHelper: join(d.home, 'bin', 'plur1bus-sandbox-limits'), maxTasks: () => d.config().tools.sandbox.maxTasks }) })`.
  - `verifier.ts`: on Linux, use `step = tasksStep(…)` only when `tasks` is given, `existsSync(limitsHelper)`,
    `maxTasks() > 0` and `(await probeTasks(limitsHelper)).mechanism === 'namespace-limit'`; otherwise no step. Any
    error while deciding means no step. macOS is unchanged.

- [ ] **Step 4: Run them to see them pass** (Step 2's command), then `pnpm typecheck`.

- [ ] **Step 5: Commit** `feat(sandbox): the task cap reaches exec.run, host subprocesses and the Linux verifier`

### Task 5: Doctor check `tools.sandbox.tasks`

**Files:**
- Modify: `packages/core/src/doctor-report.ts:27,55-56`, `packages/core/src/core.ts:1009`
- Test: `packages/core/test/doctor-report.test.ts`

**Interfaces:**
- Consumes: `SandboxDetection.tasks` (Task 3).
- Produces: `buildDoctorMethods` options gain `sandboxMaxTasks?: () => number` (default `DEFAULT_MAX_TASKS`) and
  `detectSandbox?: (limitsHelper: string) => Promise<SandboxDetection>` (default the real one); `core.ts` passes
  `sandboxMaxTasks: () => cfg().tools.sandbox.maxTasks`.

Check rows (pushed right after `tools.sandbox`, through `safe()`):

| Detection | `maxTasks` | status | summary |
|---|---|---|---|
| not available | any | `skipped` | `Process cap not checked: the sandbox is unavailable.` |
| `fork-denied` | any | `ok` | `Forks are denied in the tool sandbox (Seatbelt), whatever tools.sandbox.maxTasks says. The coding-gate verifier is not capped on macOS: process limits there count every process of the user.` |
| `namespace-limit` | > 0 | `ok` | `At most ${n} tasks per sandboxed run (tool sandbox and Linux coding-gate verifier), counted in the run's own user namespace.` |
| `namespace-limit` | 0 | `warn` | `Process cap off: the owner set tools.sandbox.maxTasks to 0.` |
| `none` | any | `warn` | `No process cap: ${tasks.reason}` with `repair: { kind: 'hint', label: tasks.hint }` when there is a hint |

- [ ] **Step 1: Write the failing test** — one `it` per row, with `check: async () => ({ schema: '1staid.check/1', checks: [] })`,
  an injected `detectSandbox` returning the row's detection and `sandboxMaxTasks` returning its value; assert the
  `tools.sandbox.tasks` entry's `status` and `summary` (and `repair.label` for the `none` row).

- [ ] **Step 2: Run it to see it fail** — `cd packages/core && node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning --test test/doctor-report.test.ts` → FAIL.

- [ ] **Step 3: Implement** the options and the rows above; `core.ts` passes `sandboxMaxTasks`.

- [ ] **Step 4: Run it to see it pass** (Step 2's command).

- [ ] **Step 5: Commit** `feat(doctor): report whether the per-run task cap holds`

### Task 6: Documentation, CI and the full check

**Files:**
- Modify: `docs/host-tools.md` ("Sandbox and fail-closed behaviour" and its table), `docs/user/en/host-tools.md`,
  `docs/user/de/host-tools.md`, regenerated `packages/web/src/pages/help/docs-bundle/{en,de}/host-tools.ts`
- Modify: `AGENTS.md` (the `packages/core/src/tools` row: the `sandbox/` sentence), `docs/superpowers/specs/2026-10-24-cpu-core-limit-design.md`
  (its non-goal on a per-sandbox cap points to the new spec)
- Modify: `.github/workflows/ci.yml` (job `sandbox`)

- [ ] **Step 1: Write the docs.** `docs/host-tools.md` and both user docs: one short paragraph each — the cap,
  default 512, 0 = off (owner only), counted per run in the run's own user namespace; where it holds (Linux 5.14+
  as a normal user), where not (older kernels, root, bubblewrap without user namespace; Doctor says why), macOS
  (forks denied in the tool sandbox; the verifier is not capped there), Windows (no backend yet; a Job Object process
  limit when one comes). The German user doc uses "Du". Regenerate the bundle with
  `node --experimental-strip-types --no-warnings=ExperimentalWarning packages/web/scripts/bundle-user-docs.ts`.

- [ ] **Step 2: CI.** In job `sandbox`, before "kernel sandbox adversarial probes", add the step the `unit` job uses
  (`install bubblewrap (Linux)`, `if: runner.os == 'Linux'`: apt-get install bubblewrap, `sudo sysctl -w
  kernel.apparmor_restrict_unprivileged_userns=0`, `bwrap --ro-bind / / --unshare-all true`). The existing
  `sandbox.test.ts` passed on Linux 6.18 with bubblewrap 0.9.0, as root and as a normal user, before this change
  (2026-10-24). If Linux real-backend assertions then fail for reasons outside this change, keep them, report the
  failure in the PR, and do not widen the change.

- [ ] **Step 3: Full check** (long runs in the background with a log file, `AGENTS.md`):

```bash
pnpm gen && pnpm docs:gen && git diff --exit-code   # nothing left to regenerate after the commits
pnpm lint && pnpm docs:check
cargo fmt --all -- --check && cargo clippy --workspace --all-targets -- -D warnings
cargo test -p plur1bus --test sandbox_limits && cargo test -p plur1bus sandbox_task_cap_is_owner_only
pnpm --filter @plur1bus/core test > core-test.log 2>&1
```

Expected: all clean; the core log ends with `# fail 0`.

- [ ] **Step 4: Commit** `docs: per-run sandbox task cap`, push, and update PR #765's description (Zusammenfassung,
  Tests with the commands above and which tests skipped and why, Follow-ups: shipping the launcher, Linux writable
  roots). Report the PR number. Do not poll CI.
