# Per-sandbox process cap (`tools.sandbox.maxTasks`)

Owner request, 2026-10-24: sandboxed processes need a fork-bomb guard again, one that counts only the sandbox's own
tasks. It is on by default with 512 tasks, configurable, and it has to work on every platform where the sandbox runs.
Never again a process or thread limit that counts the user's tasks on the whole system.

## Why

The CPU core limit (`docs/superpowers/specs/2026-10-24-cpu-core-limit-design.md`, PR #764) removed `RLIMIT_NPROC`
from the sandbox launcher `plur1bus-sandbox-limits`: set before bubblewrap, it counted every thread of the user on the
whole system, so bubblewrap failed (`Creating new namespace failed: Resource temporarily unavailable`) as soon as the
user ran that many threads anywhere. Since then a fork bomb in a sandboxed `exec.run` or host subprocess runs until the
sandbox timeout (300 s for `exec.run`) or an abort kills the bubblewrap PID namespace, and it can exhaust the user's
process limit for everything else meanwhile.

### What runs today

- The D106 tool sandbox (`sandboxSpawn`: `exec.run` and host subprocesses) does not run in a shipped install yet. The
  launcher is not in the release payload and `setup` does not install it, so `detectSandbox` reports the sandbox
  unavailable and sandboxed calls are refused. On Linux every production call is also refused before launch, because
  `ports.ts` always passes the workspace as a writable root and `backendArgv` refuses writable roots until dynamic
  credential-name protection exists (`docs/host-tools.md`).
- The one place that runs agent code in a sandbox today is the coding-gate verifier (`packages/core/src/collab/verifier.ts`:
  format, lint, typecheck and tests of agent-written code). On Linux it starts bubblewrap directly, without the
  launcher and without any limit; on macOS its Seatbelt profile is `(allow default)`, so forking is allowed. A fork
  bomb there runs until its 60 s timeout.

Owner decision, 2026-10-24: this change puts the cap into the tool sandbox and into the verifier on Linux. A separate
pull request ships the launcher (release payload, `setup`, a pinned hash like `plur1bus-attest`); from then on the cap
protects the verifier in shipped installs, and the tool sandbox once its own gaps close.

## Goals

- A cap on the number of tasks (processes and threads) one sandbox run may have, counted for that run only, in the
  tool sandbox (`sandboxSpawn`) on every platform and in the coding-gate verifier on Linux.
- On by default: `tools.sandbox.maxTasks`, default 512. 0 turns the cap off.
- It works wherever the sandbox works, without systemd, cgroup delegation or setup by the user.
- Where it cannot be enforced, the sandbox runs without it; `detectSandbox` and Doctor say so and why. The cap never
  makes a launch fail that would otherwise run.

## Non-goals and anti-goals

- No limit outside the sandbox. The supervisor, core, API and modules keep the inherited limits.
- No cgroups. They would only add coverage on old kernels with systemd (see Approaches), at the cost of a second
  mechanism to keep working.
- Shipping the launcher is the separate pull request named above, not part of this one. Neither are the tool
  sandbox's other gaps (Linux writable roots).
- The verifier on macOS stays without a cap. It has to allow forking (tests run compilers and package managers), and
  macOS has no per-sandbox mechanism: its `RLIMIT_NPROC` always counts every process of the user, which is exactly the
  limit the owner ruled out. Doctor says so.
- Anti-goal: the old failure in a new form. The cap must never be applied in the user namespace the user's other
  processes live in, where the kernel would count them all.
- Anti-goal: a cap that silently does nothing. `detectSandbox` reports whether it holds, from a probe, not a guess.

## Approaches considered

All four were discussed with the owner; D was chosen.

- **A. A systemd scope per run** (`systemd-run --user --scope -p TasksMax=N`). Works without install changes wherever
  a systemd user manager runs. Costs a D-Bus round trip per launch and moves the sandbox out of PLUR1BUS's cgroup.
  Nothing without systemd: containers, WSL without systemd, non-systemd distributions.
- **B. PLUR1BUS creates the cgroups itself** under a cgroup its systemd unit delegates (`Delegate=pids`), with the
  supervisor moving itself into a leaf first (cgroup v2's no-internal-process rule). Fast, but works only for
  `service install`, not for `daemon start` from a terminal, and needs supervisor work and stale-cgroup clean-up.
- **C. B, else A, else none.** Most coverage of the cgroup routes, most code, two paths to test.
- **D. `RLIMIT_NPROC` inside the sandbox's own user namespace (chosen).** bubblewrap creates a new user namespace for
  every run. Since Linux 5.14 the kernel counts `RLIMIT_NPROC` per user namespace (ucounts): a task forked inside the
  namespace is checked against the forking task's limit using the count of tasks in that namespace only, and against
  the creator's limit at the time the namespace was created for the levels above. So a limit set inside the sandbox,
  after bubblewrap created the namespace, counts that run's tasks and nothing else; outside, the inherited limit stays.
  It needs no systemd, no cgroup and no privileges. The owner's concern was a per-user limit; this one is per sandbox.

Measured on this host (Linux 6.18, bubblewrap 0.9.0, a non-root user with 200 other tasks running): the old order
(limit 64 set before bubblewrap) fails with `Creating new namespace failed`; the new order (limit 64 set inside) allows
62 forks, then `EAGAIN`; two sandboxes at once get 62 each while 100 more processes start outside; threads count the
same way (62 threads).

## Decisions

### The setting

`tools.sandbox.maxTasks`: integer 0 to 65536, default 512. 0 means no cap. `x-restart: live` (read per turn),
`x-tier: advanced`, `x-write-roles: ["owner"]` and `x-audit: true` like its sibling `tools.sandbox.required`, because
raising it or setting 0 weakens a protection. Description: the most tasks (processes and threads) the programs of
one sandboxed run may have together; bubblewrap's own init process is not counted.

### Mechanism (Linux)

The launch chain stays `core → plur1bus-sandbox-limits <cpu> <memory> → bwrap → program`, with one step added inside
the sandbox when the cap is on and enforceable:

`bwrap … --ro-bind <launcher> /run/plur1bus/sandbox-limits … -- /run/plur1bus/sandbox-limits --tasks <maxTasks + 1>
<outer user namespace> -- <program> [args]`

- The launcher binary gets a second mode, `--tasks <n> <outer-userns> -- <program> [args]`: it compares its own user
  namespace (`/proc/self/ns/user`) with the one the core passed (the core's own, read once). If they differ it sets
  `RLIMIT_NPROC` soft and hard to `n` (or keeps the inherited hard limit when that is lower), then execs the program.
  If they are the same, setting the limit would recreate the old per-user failure, so it does not set it, writes one
  line to stderr and execs the program anyway (never fail because of the cap).
- `n` is `maxTasks + 1`: bubblewrap's init (PID 1 of the sandbox) is one task in the namespace; the launcher step
  becomes the program by exec and is counted as the program.
- The launcher is bound read-only at the fixed path `/run/plur1bus/sandbox-limits` (bubblewrap creates it on its tmpfs
  root), before `--remount-ro /`. It is the trusted installed binary `preparePolicy` already validated.
- `RLIMIT_CPU`, `RLIMIT_AS` and `RLIMIT_CORE=0` stay in the outer launcher, unchanged.

### The verifier (Linux)

The verifier's bubblewrap command gets the same inner step: when the launcher exists at `<home>/bin/plur1bus-sandbox-limits`
and the probe (below) says the cap is enforced, it adds the read-only bind of the launcher and runs the check as
`/run/plur1bus/sandbox-limits --tasks <maxTasks + 1> <outer user namespace> -- <program> [args]`. Without the launcher,
or when the cap is not enforceable or set to 0, it runs as today. It never fails a check because of the cap. Only the
inner step is added: the verifier's other limits, mounts and environment stay as they are. Composition passes it the
launcher path and the live `maxTasks`.

### Detection

`detectSandbox` keeps its sandbox probe and adds a second one when the sandbox is usable: bubblewrap with `--proc` and
the launcher bound as above runs `--probe-tasks <outer-userns>`. The probe:

1. reports `shared-userns` when its user namespace is the outer one (bubblewrap made none, e.g. a setuid build);
2. counts the tasks in its namespace (`/proc/*/task`), sets the limit to that count + 1 and forks children that wait,
   up to four;
3. reports `enforced` when one or two forks succeed (one more than the limit is tolerated: 5.14 to 5.16 allowed
   `limit + 1`), `per-user` when the first fork fails (a kernel older than 5.14 counts the user's tasks system-wide),
   and `not-enforced` when all four succeed (root, which the kernel exempts).

The result is cached per launcher path for the life of the core process: the kernel, the user and bubblewrap do not
change while it runs, and the inner check covers the one dangerous case. A probe that cannot run (for example an
older launcher without the mode) means "not enforceable", never "sandbox unavailable".

`SandboxDetection` gains `tasks: { mechanism: 'namespace-limit' | 'fork-denied' | 'none'; reason: string }` on every
platform. On macOS the sandbox probe also runs a command that forks (`/bin/sh -c /usr/bin/true`) under the tool
sandbox's no-fork rule and reports `fork-denied` only when that fork fails, so macOS is probed too, not assumed.

| Platform | `tasks.mechanism` | Why |
|---|---|---|
| Linux 5.14+, non-root, bubblewrap with a user namespace | `namespace-limit` | the mechanism above |
| Linux before 5.14 | `none` | the kernel counts the user's tasks system-wide; Linux 5.14 or newer needed |
| Linux, PLUR1BUS running as root | `none` | the kernel does not apply process limits to root |
| Linux, bubblewrap without a user namespace | `none` | the limit would count every process of the user |
| macOS | `fork-denied` | Seatbelt denies forking: one process per run, whatever `maxTasks` says; threads are not counted |
| Windows | `none` | no sandbox backend; a future one must set a Job Object `ActiveProcessLimit` to `maxTasks` |
| sandbox unavailable | `none` | nothing runs |

### Reporting

- `SandboxPolicy.limits.maxTasks` (0 = off). `SandboxResult.resources.maxTasks` is the cap that held for the run
  (`namespace-limit` and on), or `null` otherwise; on macOS `sandbox.tasks.mechanism` says `fork-denied`.
- Doctor: a check `tools.sandbox.tasks`, one for the tool sandbox and the verifier:
  - Linux, `namespace-limit`: `ok` with the cap (both are covered when the launcher is installed); `warn` when the
    owner set 0.
  - Linux, `none`: `warn` with the reason and a hint ("Linux 5.14 or newer", "run PLUR1BUS as a normal user").
  - macOS: `ok`, "forks denied in the tool sandbox", whatever `maxTasks` says, plus the sentence that the coding-gate
    verifier is not capped on macOS.
  - `skipped` when the sandbox itself is unavailable (the `tools.sandbox` check already fails then).
- Documentation: `docs/host-tools.md` (sandbox section and the table), `docs/user/{en,de}/host-tools.md`,
  `docs/config.md` (generated), the `tools/` row of `AGENTS.md`, and a note under "Non-goals" of the CPU core limit
  spec pointing here.

### Tests

- `crates/plur1bus/tests/sandbox_limits.rs` (existing tests stay): the `--tasks` mode refuses a missing, zero or
  non-numeric limit and a missing `--`; in the caller's own user namespace it leaves `Max processes` unchanged and says
  why on stderr; with a different outer namespace it sets the limit (`/proc/self/limits`); the probe, run under
  `unshare --user --map-current-user --pid --fork --mount-proc` where possible, reports what the host predicts
  (`enforced` for a non-root user on 5.14+, `not-enforced` for root), skipped with a reason when no user namespace can
  be created.
- `packages/core/test/tools/sandbox/sandbox.test.ts` (existing tests stay): `backendArgv` adds the inner step only when
  the cap is on and enforced; `detectSandbox` reports `tasks` for a missing launcher, Windows and macOS; and on Linux,
  when `tasks.enforced`, a real fork bomb (`perl -e 'fork while 1'`, cap 32) stays at or below the cap while the test
  starts 20 processes of the same user outside and they all succeed, and the bomb's tasks are gone after the run;
  skipped with the probe's reason otherwise.
- `packages/core/test/doctor-report.test.ts`: the `tools.sandbox.tasks` check for each row above (detection
  injected).
- Verifier: the Linux argv carries the inner step only with an installed launcher, an enforced probe and a cap above 0;
  on a host where it is enforced, a fork-bomb check is bounded by the cap and the verifier reports its usual timeout or
  failure, not a crash.
- CI: the `sandbox` job's Linux legs install bubblewrap and lift the AppArmor user-namespace restriction (as `unit`
  and `core unit shard` do), so the real-backend tests run there instead of skipping. The job stays outside `ci-gate`.

## Left to the builder

- How the option reaches `ports.ts` (`SandboxOptions.maxTasks`, read from `d.config()` per turn in `composition/`) and
  Doctor (a `sandboxMaxTasks` callback beside `sandboxRequired`, plus an injectable detection for tests).
- The probe's exact output format and the cache's shape.
- Wording of reasons and hints, in the style of the existing `detectSandbox` texts.
- Any web settings label or i18n entry the settings page needs for the new key.

## Calls made by the author (not discussed with the owner)

- Key name `maxTasks`, range 0 to 65536, 0 = off, owner-only write and audited.
- `live` restart class.
- The inner step skips the cap (and runs the program) when it finds itself in the outer user namespace, instead of
  refusing the launch.
- The probe result is cached for the core's lifetime.
- macOS: a fork probe instead of an assumption; Doctor shows `ok` there even with `maxTasks` 0, and names the uncapped
  verifier in its summary instead of a permanent warning.
- The non-gating `sandbox` CI job gets bubblewrap on Linux.
