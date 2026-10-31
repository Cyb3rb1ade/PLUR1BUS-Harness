# External-agent containment in Rust (`plur1bus-sandbox`) — design

**Status:** Specification only, no product code. Owner questions open (§13). The plan starts after PR #820 is merged ·
**Date:** 2026-10-31 · **Owner:** Christian (Cyb3rb1ade) · **Register entry:** **D123** (proposed, Q1) in the core
spec's register ([`2026-09-24-m1b-2a-core-daemon-cli-design.md`](2026-09-24-m1b-2a-core-daemon-cli-design.md) §2). D120
is on main; D121 is used by open PR #840 (`agy/j-profile-import-spec`) and D122 by open PR #845
(`docs/apple-foundation-models`); main, every remote branch and every local branch were checked on 2026-10-31 and none
uses a higher number · **Follows:** PR #820 (M6-B) and D120 path B
([`2026-10-30-harness-hygiene-coding-aci-design.md`](2026-10-30-harness-hygiene-coding-aci-design.md) §12–§13, the
ADR-019 text) · **Plan:** [`2026-10-31-containment-rust.md`](../plans/2026-10-31-containment-rust.md)

**Inputs read:** main at `27ec7c4f0c`. PR #820 at `fd26fd2383` (branch `agy/m6b-external-agents`):
`packages/core/src/external-agents/{containment,launcher,provisioner,git,delegation}.ts`,
`packages/core/src/composition/external-agents.ts`, the tests
`packages/core/test/external-agents/{containment,red-team,hardlink,coding-worktree}.test.ts`, `docs/agent-isolation.md`,
the `docs/security.md` diff, ADR-011 and `docs/research/2026-10-29-m6b-external-agent-spike.md`. On main: D120 §5, §7.5–§7.7,
§8.6, §11, §12, §17; [ADR-012](../../adr/ADR-012-process-model-and-languages.md) §1–§3 and §10.1;
[`2026-10-24-sandbox-process-cap-design.md`](2026-10-24-sandbox-process-cap-design.md) (D106 task cap);
`packages/core/src/tools/sandbox/*`, `packages/core/src/collab/verifier.ts`, `crates/plur1bus/src/bin/plur1bus-sandbox-limits.rs`,
`crates/plur1bus/Cargo.toml`, [`dependency-policy.md`](../../dependency-policy.md), `deny.toml`, `Cargo.lock`, the `sandbox`
job in `.github/workflows/ci.yml`, [`2026-10-29-shared-compute-design.md`](2026-10-29-shared-compute-design.md) §5 and §13
(D119). Crate data from the crates.io API and the `libc` 0.2.189 source, both read 2026-10-31. Codex's Mac and Linux
diagnostics on #820 are taken from the owner's brief; whatever is not in pushed code is marked as an unknown (§14).

## 1. Goal and non-goals

**Goal.** Move the process half of M6-B containment into Rust: the sandboxed terminal (`containedTerminal`), the agent
launcher (`launchExternalAgent`), the watchdog for task and RSS limits, timeouts and abort. It becomes a library crate
used by D120's supervised `plur1bus-tools` module and called by the core over the harness RPC. The TypeScript interface
and the typed reason codes stay as they are, and #820's suites are the acceptance gate.

**Why Rust.** Node cannot reach what a reliable watchdog needs. On macOS: `proc_pidinfo`, `proc_listpgrppids` and
`sysctl` `KERN_PROC`. On Linux: `setrlimit` in the child before exec, cgroup v2 placement, `pidfd`, `PR_SET_PDEATHSIG`.
On both: `waitpid` and signals on process groups. On Windows: Job Objects. Today's TypeScript has `spawn({ detached })`,
`process.kill(-pid)` and, in D106, a 100 ms `ps` sampler. It cannot reap, it does not see zombies, and it races pid reuse.

**Non-goals.**
- `containedRead`/`containedWrite` (ACP `fs/*`) stay TypeScript. They go through `policy/paths.ts`, which moves in P4
  step 1 (D120 §12.2). `provisioner.ts` and `git.ts` stay as well: that is harness-owned git, not untrusted code.
- No migration of the D106 tool sandbox (`exec.run`, host subprocesses) and no change to the D98 verifier in v1 (§11, Q5).
- No Windows backend in v1 (Q6). Windows keeps failing closed.
- No new user-facing config key. The limits keep whatever values #820 ships.
- No new boundary against processes of the same OS user (`docs/security.md`, "Known boundary").

## 2. Starting point

| Piece | #820 at `fd26fd2383` (TypeScript) |
|---|---|
| Terminal | `containedTerminal`: absolute, NUL-free argv, no shell. A hardlink scan runs first. **macOS:** `/usr/bin/sandbox-exec -p` with `(allow default)(deny file-link)`, optional `(deny network*)`, writes denied outside the worktree except `/dev/null`, writes denied to home and `gitDenyPaths`. **Linux:** `/usr/bin/bwrap --die-with-parent --unshare-all [--share-net]`, read-only binds of `/usr /bin /lib /lib64 /etc` and the Node directory, the worktree bound writable, denies bound read-only. **Windows:** refused |
| Kill and limits | `spawn` with `detached`, then `process.kill(-pid)`: SIGTERM, SIGKILL after 100 ms. Timeout 30 s. Each stream is capped at 64 KiB; reaching the cap kills the group, and the result stays `ok: true` with the output truncated |
| Environment | `childEnv`: `PATH`, `LANG`, `LC_ALL`, `TERM`, `TMPDIR`, `HOME` |
| Agent process | `launchExternalAgent`: absolute argv, shell basenames refused, scrubbed env, own process group, 600 s timeout, abort. **No OS sandbox at this commit** (U7) |
| Refusals | `sandbox-unavailable \| argv \| timeout \| aborted \| spawn-failed \| hardlink-in-worktree` |
| Watchdog | Not in pushed code. Per the brief: a watchdog per terminal and process group enforces task and RSS limits, including on the streaming path, and the macOS watchdog reports `task-limit-exceeded` with exit 121 (U1) |

Main has two more sandboxes. The D106 tool sandbox (`tools/sandbox/`) uses deny-default Seatbelt without fork, bwrap
without writable roots, the launcher `plur1bus-sandbox-limits` (exit 125 on its own errors, modes `--tasks` and
`--probe-tasks`), and the `ps` RSS sampler. The D98 verifier (`collab/verifier.ts`) builds its own Seatbelt and bwrap
argv, adds the `--tasks` step on Linux, and stops at 64 KiB of output. This design gives all three one Rust home, but v1
moves only M6-B.

**Diagnostics (brief).** On macOS, an unreaped zombie still answers `kill(pid, 0)`, but `proc_pidinfo` returns ESRCH
because XNU's `proc_find` skips zombies. On Linux under bwrap, a zombie holds its `RLIMIT_NPROC` slot, and the next fork
gets EAGAIN, which the program may handle and then exit 0. The owner decided on 2026-10-31: the Linux tests prove the
kernel property, macOS keeps checking `task-limit-exceeded`, and a typed Linux report through cgroup v2 is a follow-up.

## 3. Placement and process topology

### 3.1 Crates (Q2)

- **`crates/plur1bus-sandbox`** (new; library plus binary). It holds the policy model, profile and argv generation,
  pre-launch checks, the keeper and watchdog, and one `sys` module per OS. This is the only crate with `unsafe`. Every
  block carries a `SAFETY` comment, `unsafe_op_in_unsafe_fn` is denied, and the crate uses `[lints] workspace = true`.
  The launcher `plur1bus-sandbox-limits` moves here from `crates/plur1bus/src/bin/`. Its name and its existing argv modes
  stay the same, so D106 and the verifier keep working. It gains one new mode, `keep`.
- **`crates/plur1bus-tools`** (D120 H1-1) gets `src/sandbox/`: RPC handlers, the run table, output buffers and the ticket
  check. The crate stays `#![forbid(unsafe_code)]` (D120 §11.2). It starts the keeper with `std::process::Command` and
  nothing else.

### 3.2 Who is the parent (Q4)

```text
core (TS) ── tools.sandbox.* (x-server "tools", core only, T1 ticket) ──► plur1bus-tools (Rust, supervised)
                                                                            │ Command, own process group
                                                                            │ fd 0–2 target pipes · fd 3 status · fd 4 lifeline
                                                                            ▼
                                                  plur1bus-sandbox-limits keep   (keeper: outside the OS sandbox)
                                                                            │ child: setpgid(0,0) · rlimits · [cgroup] · fds ≥ 3 closed · exec
                                                                            ▼
                               /usr/bin/sandbox-exec -p <profile> argv…  │  /usr/bin/bwrap … -- [inner --tasks] argv…
                                                                            ▼
                                                              target process group (untrusted)
```

- **The keeper** is the parent and reaper of the backend process. It runs the watchdog loop and writes NDJSON status
  records on fd 3: `started`, `sample`, `limit`, `exit`. The status record is the authority. Exit codes 121 (task limit)
  and 125 (launcher error) remain only for the TypeScript caller during the migration. A target that exits 121 by itself
  can no longer be mistaken for a limit hit.
- **Streams.** The target's stdin, stdout and stderr are pipes that `plur1bus-tools` creates and the keeper passes
  through untouched, so bytes take no extra hop.
- **Tools crash.** On every platform the keeper sees EOF on the lifeline fd. This is the supervisor's stdin-lifeline
  pattern (ADR-012 §10.1). On macOS it also watches `EVFILT_PROC`/`NOTE_EXIT` on the tools pid. On Linux it sets
  `PR_SET_PDEATHSIG(SIGKILL)` on itself, then compares `getppid()` with the pid given on its argv, which closes the
  fork-to-prctl race. In every case it kills the group, reaps and exits.
- **Keeper crash.** On Linux, bwrap's `--die-with-parent` takes the PID namespace down. On macOS, `plur1bus-tools` sees
  the keeper exit and kills the recorded group and the seen set (§6) itself.
- **Both crash.** When it starts the keeper, tools writes the run journal `state/run/sandbox/<runId>.json` with the
  keeper's pid. It adds the pgid and each pid with its start time as the keeper's `started` and `sample` records report
  them, and deletes the file when the run ends. On restart, before serving, tools kills every journalled pid whose
  start time still matches, so a reused pid is never killed.
- **Windows (SB-W).** No keeper. Tools creates a Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, starts the process
  suspended, assigns it and resumes it. A tools crash closes the job handle and the job dies.

### 3.3 The tools process's own OS profile (measured, Q3)

D120 §17 gives `plur1bus-tools` "its own sandbox profile per platform as for the verifier". This was measured on the
owner's Mac (macOS 27.2, 2026-10-31): `sandbox-exec` started inside a Seatbelt profile of `(allow default)` plus a
single `deny file-write*` rule fails with `sandbox_apply: Operation not permitted` (exit 71). Under the trivial
`(allow default)` profile alone, nesting works. The keeper is a child of `plur1bus-tools`, so it cannot apply the
agent profile while tools itself runs under Seatbelt. On Linux, nested bwrap is not measured (U5).

## 4. RPC API (`x-server: "tools"`)

Every method is defined in `packages/rpc-schema/schema/rpc.schema.json` with `x-stability: "experimental"`, `x-since`
set to the next minor, closed params and contract fixtures. The Rust types come from `typify` and the TypeScript types
from `json-schema-to-typescript` (ADR-012 §2). The core-only guard applies (D120 §5). Each call that starts a process
carries the T1 dispatcher ticket (D120 §11.2). Its `actionHash` covers the profile, argv, worktree, network and limits,
and the external-agent delegation path mints it after its permission check.

| Method | Params | Result |
|---|---|---|
| `tools.sandbox.run` | `ticket`, `profile` (`agent-terminal` in v1), `worktree`, `home`, `argv[]`, `network`, `limits { timeoutMs, maxTasks, maxRssBytes, maxOutputBytes }` | `RunResult` or `SandboxRefusal`, after exit |
| `tools.sandbox.spawn` | as `run`, `profile: agent-process`, stdin piped | `{ runId }` or `SandboxRefusal` |
| `tools.sandbox.write` | `runId`, `seq`, `data` (base64, at most 1 MiB), `eof?` | `{ accepted }` |
| `tools.sandbox.read` | `runId`, `afterSeq`, `waitMs` (long poll, at most 30 s), `maxBytes` | `{ chunks: [{ seq, stream, data }], end?: RunResult \| SandboxRefusal }` |
| `tools.sandbox.cancel` | `runId` | `{ cancelled }`; idempotent; the run ends `aborted` |
| `tools.sandbox.status` | `runId` | `{ state, tasks, rssBytes, elapsedMs, limitHits[] }` |
| `tools.sandbox.probe` | — | per backend `{ backend, available, tasks.mechanism, memory.mechanism, reason }`, for Doctor |

`RunResult = { ok: true, runId, exitCode, signal, stdout: Out, stderr: Out, peak: { tasks, rssBytes }, durationMs,
backend }`, where `Out = { head, tail, bytes, cut: null | "output-limit" }`. `SandboxRefusal = { ok: false, reason,
detail? }`.

- **Streaming is pull-based**, the `logs.follow` pattern: a long poll with a cursor. The shared RPC server has no
  per-connection push (`docs/rpc.md`). A `tools.sandbox.output` notification can replace it later without changing the
  run model (U6).
- **Output limits.** Output is buffered in memory in `plur1bus-tools`, per stream, and never written to disk. For
  `agent-terminal`, `maxOutputBytes` (default 64 KiB) keeps today's behaviour: reaching it kills the group and marks
  `cut: "output-limit"`. Head and tail are both kept, so the tail is no longer lost (D120 §7.5). On `agent-process`,
  stdout is the ACP stream. It has no cap; a full 4 MiB buffer stops reading the pipe, so the agent blocks instead of
  bytes being dropped.
- **H1.** The sandbox never persists bytes. Once H1-4's exec spool lands, the core reads chunks, redacts them and
  appends them to an artifact (D120 §7.5–§7.6). That keeps D120's rule: raw output never becomes an artifact without
  passing the core's redactor.

### 4.1 Reason codes, old to new

| #820 (TypeScript) | Rust | When |
|---|---|---|
| `sandbox-unavailable` | same | Backend binary missing or probe failed; Windows until SB-W; the measurement as a whole failed (an enumeration call errored, not one unreadable pid); tools service down (Q8) |
| `argv` | same | Empty argv, relative `argv[0]`, NUL byte, or a shell basename (the launcher's list, applied to both profiles) |
| `timeout` | same | Deadline reached; SIGTERM, grace, SIGKILL |
| `aborted` | same | `tools.sandbox.cancel` or the core's `AbortSignal` |
| `spawn-failed` | same | Fork or exec of the keeper or backend failed; keeper exit 125 |
| `hardlink-in-worktree` | same | A regular file with `nlink > 1`, found by a scan in Rust immediately before the spawn |
| `task-limit-exceeded` (macOS, exit 121) | same, from the status record | macOS count above `maxTasks`. Linux reports it only with cgroup v2 (SB-7, Q10); without cgroups the program just gets EAGAIN (owner, 2026-10-31) |
| none (U1) | `memory-limit-exceeded` (new reason string in `docs/errors.md`) | The group's RSS sum exceeds `maxRssBytes` |
| truncated output with `ok: true` | `ok: true`, `cut: "output-limit"` | Parity |

There are no new RPC error codes (D120 constraint).

## 5. Backends

**macOS: Seatbelt.** The Rust profile is built from the same inputs as #820's `seatbelt()`: the worktree's realpath; a
deny list of home (unless home contains the worktree) plus `gitDenyPaths`; and the network flag. Paths are quoted with
`serde_json`, matching `JSON.stringify`. A golden test requires byte-identical output to the TypeScript profile for a
fixture tree, until SB-6 deletes the TypeScript copy. Q9 adds read denies for D106's credential list. The program is
always the absolute `/usr/bin/sandbox-exec -p`. The keeper starts it with `posix_spawn` using `POSIX_SPAWN_SETPGROUP` and
`POSIX_SPAWN_CLOEXEC_DEFAULT`, so only fds 0–2 are inherited.

**Linux: bubblewrap, with optional cgroup v2.**
- **argv.** The bwrap argv is generated as #820's `bwrapArgv` builds it today and golden-tested against it. It also gets
  D106's `--new-session --cap-drop ALL`. The keeper forks and, before exec, calls only async-signal-safe functions (the
  launcher's pattern).
- **Task cap.** It uses D106's inner step, `/run/plur1bus/sandbox-limits --tasks <maxTasks+1> <outer userns> --`, inside
  the sandbox's user namespace and never outside it (D106 anti-goal). D106 measured that this counts per sandbox
  (Linux 6.18, bwrap 0.9.0): 62 forks, then EAGAIN, and two sandboxes count independently.
- **Enumeration.** Every task in the sandbox's PID namespace: the `/proc` entries whose `ns/pid` matches the namespace
  of bwrap's child. Zombies keep their entry (state `Z`) and are counted. RSS is the sum of `statm` resident pages ×
  page size.
- **Wait and kill.** The keeper uses `pidfd_open` on bwrap's pid: it polls the fd for exit and signals through
  `pidfd_send_signal`, with no pid-reuse race. Kernels without pidfd fall back to `waitpid`/`kill`.
- **cgroup v2 (SB-7).** Used only when the keeper's own cgroup has `pids` and `memory` delegated and writable: systemd
  `Delegate=` under `service install`, D106's approach B. The keeper creates `<own cgroup>/plur1bus-sbx-<runId>` and sets
  `pids.max = maxTasks + 1`, `memory.max` and `memory.oom.group = 1`. It places the child with
  `clone3(CLONE_INTO_CGROUP)` or with a pre-opened `cgroup.procs` fd written before exec. `pids.events` (`max`) and
  `memory.events` (`oom_kill`) give the typed reports. The cgroup is removed after reaping. No `cgroups-rs` (§9).

**Windows: AppContainer plus Job Object (SB-W, later; Q6).**
- **AppContainer.** One profile per agent. The worktree gets an ACL grant for the AppContainer SID, and the worktree's
  `.git` file gets an explicit deny ACE; the gitdir is never granted. Network is allowed only through the
  `internetClient` capability, when the agent's network is on.
- **Job Object.** `KILL_ON_JOB_CLOSE`. `ACTIVE_PROCESS` is set to `maxTasks` (it counts processes, not threads).
  `JOB_MEMORY` gives the group-wide sum; `PROCESS_MEMORY` would be per process; both are committed memory, not RSS (U8).
  Plus `DIE_ON_UNHANDLED_EXCEPTION` and UI restrictions.
- **Typed reports.** The completion-port messages `JOB_OBJECT_MSG_ACTIVE_PROCESS_LIMIT` and `JOB_OBJECT_MSG_JOB_MEMORY_LIMIT`
  map to the typed reasons. Handles are inherited only through `PROC_THREAD_ATTRIBUTE_HANDLE_LIST`.
- **Until SB-W lands,** every call answers `sandbox-unavailable` before a process starts (today's tested behaviour).

## 6. Watchdog semantics

| | macOS | Linux (rlimit) | Linux (cgroup, SB-7) | Windows (SB-W) |
|---|---|---|---|---|
| Tasks counted | group ∪ descendants of the leader ∪ seen set; zombies counted conservatively | kernel `RLIMIT_NPROC` in the sandbox's user namespace (processes and threads) | `pids.current` | active processes |
| Over the task limit | SIGKILL the group → `task-limit-exceeded` | EAGAIN to the program; the watchdog records `peak.tasks` | EAGAIN and `pids.events` → typed (Q10) | job message → typed |
| Memory measured | Σ `pti_resident_size` | Σ `statm` resident over the PID namespace; `RLIMIT_AS` per process stays | `memory.current` | job committed memory |
| Over the memory limit | SIGKILL → `memory-limit-exceeded` | SIGKILL → `memory-limit-exceeded` | OOM group kill → `memory-limit-exceeded` | job message → typed |
| What triggers a check | `NOTE_FORK`/`NOTE_EXIT` kevents on known pids, plus a 100 ms sweep | 100 ms sweep, pidfd | inotify on the events files | completion port |

**Conservative counting on macOS** (Codex's finding). The keeper enumerates `proc_listpgrppids(pgid)`,
`proc_listchildpids` recursively from the leader, and the seen set (pid plus start time), then classifies each pid:

- **Live:** `proc_pidinfo` succeeds. Count it, add its RSS and record its start time.
- **Unreaped zombie:** `proc_pidinfo` fails, but `kill(pid, 0)` returns 0 or EPERM. Count it as a task with RSS 0. This
  matches the kernel's `RLIMIT_NPROC` accounting, which counts a zombie until it is reaped.
- **Gone:** both fail.

`sandbox-unavailable` is used only when an enumeration call itself fails, never because one pid cannot be read. Whether
the enumeration calls list zombies at all is U2. If they do not, the keeper reads `sysctl` `KERN_PROC_PGRP`. `libc` has
no Apple `kinfo_proc`, so that path needs a `repr(C)` mirror whose size is checked at runtime.

**Escalation.**
- A limit violation (tasks or memory) sends SIGKILL to the group at once, because a grace period lets a fork bomb keep
  forking.
- Timeout, cancel and the output limit send SIGTERM to the group. After a 2 s grace (today: 100 ms), SIGKILL goes to the
  group and to every seen-set pid whose start time still matches. This also catches live processes that escaped with
  `setsid`. On Linux the PID namespace dies with bwrap's init.
- The keeper reports `exit` only once the group is empty, at most grace + 1 s later, so a run never leaves processes
  behind.

**Tests never synchronise with `sleep`.** Fixtures signal readiness by writing a byte to an inherited pipe. Tests block on
that read or on status records. Deadlines are the watchdog's own monotonic deadlines, set small in tests. "The process is
gone" is asserted through `waitpid`, pidfd or kqueue events, not through polling.

## 7. Migration

1. SB-1 to SB-4 land without touching #820's TypeScript paths.
2. SB-5 turns `containedTerminal` and `launchExternalAgent` into thin RPC clients behind the same exported signatures:
   `TerminalResult | TerminalRefusal`, and a `LaunchHandle` whose `Writable` stdin and `Readable` stdout are built on
   `write` and `read`. The `platform: "win32"` refusal stays on the client side. The client reaches the service through
   `packages/core/src/tools-service/client.ts` (D120 H1-1). Without a supervisor, and in tests, it spawns
   `PLUR1BUS_TOOLS_BIN`.
3. **Side-by-side (Q7):** a test-only switch, `PLUR1BUS_CONTAINMENT=ts|rust`, defaulting to `rust`. CI runs the gate on
   both backends while SB-5 is open.
4. **Gate:** `containment.test.ts`, `red-team.test.ts`, `hardlink.test.ts` and `coding-worktree.test.ts` run unchanged on
   macOS and Linux against the Rust backend, together with the Rust suites (§10).
5. **SB-6** deletes the TypeScript spawn, kill and watchdog code and the switch. `findHardlink` and `gitDenyPaths` stay in
   TypeScript, where session open and the `fs/*` calls use them, until P4 step 1.

## 8. Security

- **Environment.** The `childEnv` allowlist is ported exactly, including the `PATH` fallback `/usr/bin:/bin`. On top of
  it, D106's loader denylist (`DYLD_*`, `LD_*`, `NODE_*`, `PLUR1BUS_*`, …) refuses a name even when it is allowlisted,
  and NUL bytes in values are refused. The keeper's own environment never reaches the target.
- **File descriptors.** Rust's standard library opens with `O_CLOEXEC`. The keeper closes every fd from 3 up before exec
  (`close_range` on Linux 5.9+, otherwise a loop; `POSIX_SPAWN_CLOEXEC_DEFAULT` on macOS). Only fds 0–2 reach the
  target; the status and lifeline fds never do. Windows uses an explicit handle list.
- **argv.** Absolute `argv[0]`, non-empty NUL-free strings, no shell basenames, `execve` only, never `/bin/sh`.
- **Paths.** The worktree and the deny entries are resolved to their realpaths before the profile is built. The worktree
  must be a directory that is not under a deny entry. The hardlink scan (`nlink > 1`, root `.git` skipped) runs
  immediately before the spawn. New hard links are refused by `(deny file-link)` on macOS; on Linux the mount layout
  makes them fail with ENOENT or EXDEV.
- **gitdir invariant.** In every profile these are read-only: the worktree's `.git` file, its gitdir, the common dir, and
  `config`, `hooks` and `info`. Only the harness's hardened git (`git.ts`) writes git, and it runs outside the sandbox.
- **Secrets and logs.** `plur1bus-tools` holds no secret values (D120 §5). Logs and audit records carry ids, counts, the
  program basename and the reason, never argv values, env values or output.
- **Audit**, appended by the core until P4 step 1: `agent.sandbox.started { runId, agentId, profile, backend, network,
  limits }`, `agent.sandbox.ended { runId, reason?, exitCode, signal, durationMs, peakTasks, peakRssBytes, cut }` and
  `agent.sandbox.refused { reason }`.

| Threat | Protection | Residual |
|---|---|---|
| Write outside the worktree (`..`, symlink, absolute path) | Profile write rules on realpaths; `fs/*` through the TypeScript canonicaliser | — |
| Hard link to an outside file | `(deny file-link)`; Linux mount layout; scan right before the spawn | A process outside the sandbox could link between scan and spawn; that is outside the threat model (#820 spike) |
| Git hook or config tampering | gitdir, common dir, `config`, `hooks`, `info` read-only; only harness git writes | — |
| Fork bomb | macOS kill on count; Linux per-namespace `RLIMIT_NPROC`; `pids.max` (SB-7); `ActiveProcessLimit` (SB-W) | macOS overshoot between kevent and kill; Linux before 5.14 or as root has no cap (D106 table) |
| Memory exhaustion | Kill on the group's RSS sum; `RLIMIT_AS`; `memory.max` (SB-7) | Overshoot within one sampling interval; shared pages are counted twice (conservative) |
| Escaping the kill (`setsid`, double fork) | Linux PID namespace; macOS group ∪ tree ∪ seen set with start times | macOS: an orphan that runs `setsid` and detaches between two samples (U4) |
| Orphans after a crash | Lifeline EOF, `NOTE_EXIT`, `PDEATHSIG`; journal sweep; `KILL_ON_JOB_CLOSE` | macOS: if keeper and tools die together, until the tools restart sweeps |
| Leak through env, fds, argv or logs | Allowlist plus loader denylist; fds closed; no secrets in tools; logs hold ids and counts | The agent's own argv is untrusted by definition |
| Credential reads from a terminal (macOS) | Q9: read denies for D106's credential list | If Q9 is declined, as readable as in #820 (Linux binds no home) |
| Network exfiltration | `(deny network*)` or no `--share-net`, unless the agent's network is on | With network on, access is unrestricted; there is no egress proxy |
| A caller other than the core | Core-only guard (`E_DENIED`); HMAC ticket bound to the action hash | Same-OS-user boundary |
| Untrusted output | Bounded buffers, base64 bytes, the taint rule, redaction in the core before persistence | — |

## 9. Dependencies

The gate is the licence list of [`dependency-policy.md`](../../dependency-policy.md) and `deny.toml` (cargo-deny 0.20.2),
plus the exact-pin and 14-day rule applied in D120 §12.5 and the M6-B spike. Checked on crates.io on 2026-10-31.
**Result: no new crate for macOS and Linux.**

| Crate | Version (released) | Licence | Verdict |
|---|---|---|---|
| `libc` | `=0.2.189` (2026-07-21), already in `Cargo.lock`; 0.2.191 (2026-10-16) also passes | MIT OR Apache-2.0 | **Use.** Its 0.2.189 source has, for macOS: `proc_listpgrppids`, `proc_listchildpids`, `proc_pidinfo`, `proc_taskinfo`/`PROC_PIDTASKINFO`, `EVFILT_PROC`/`NOTE_EXIT`, `KERN_PROC_PGRP`, `SZOMB`. For Linux: `PR_SET_PDEATHSIG`, `PR_SET_CHILD_SUBREAPER`, `prlimit`, `CLONE_INTO_CGROUP`, `SYS_pidfd_open` (checked for aarch64). It has no Apple `kinfo_proc` (U2) |
| `windows-sys` | 0.59, already a direct dependency of `crates/plur1bus` (0.61.2 is newer, 2025-10-06) | MIT OR Apache-2.0 | **Use for SB-W.** 0.59 plus the feature `Win32_Security_Isolation` |
| `serde`, `serde_json` | workspace | MIT OR Apache-2.0 | Status records and RPC |
| `nix` | 0.31.3 (2026-05-11), transitive in the lock | MIT | Not needed: `libc` keeps one syscall surface |
| `libproc` | 0.14.11 (2025-10-01) | MIT | **Reject.** Its build script needs `bindgen`, so libclang on every macOS build; `libc` covers the calls |
| `darwin-libproc` | 0.2.0 (2020-06-17) | Apache-2.0 OR MIT | **Reject.** No release since 2020; requires `memchr ~2.3` |
| `cgroups-rs` | 0.5.1 (2026-07-14) | MIT OR Apache-2.0 | **Reject.** Pulls in `nix ^0.25` (a second `nix`) and `zbus ^5.8`; cgroup v2 is a file API |

`crates/plur1bus` declares `libc = "0.2"`. Pinning `=0.2.189` in the new crate matches the lock and changes nothing.

## 10. Test strategy

| Platform | Runner | Runs |
|---|---|---|
| macOS | `macos-15` (the `sandbox` job) | Rust unit and golden tests; keeper integration (zombie counted, fork-hold over the limit → `task-limit-exceeded`, alloc → `memory-limit-exceeded`, ignore-term → SIGKILL after grace, group empty after exit, tools-parent killed → keeper kills the group); the TypeScript gate |
| Linux | `ubuntu-24.04` (bwrap installed, AppArmor's user-namespace restriction lifted, as today) | Kernel property (concurrent tasks ≤ `maxTasks`, the next fork gets EAGAIN); two sandboxes independent; a zombie holds a slot; die-with-parent; pidfd and the fallback; the TypeScript gate |
| Windows | `windows-2025` | Fail-closed: `run`, `spawn` and `probe` answer `sandbox-unavailable` and start no process; SB-W later adds the job tests |

The fixtures are a test-only binary, `sbx-fixture`, with the modes `fork-hold N`, `zombie N`, `alloc BYTES`,
`setsid-escape`, `ignore-term`, `spin` and `flood BYTES`. Each mode writes a readiness byte. The `sandbox` job stays
outside `ci-gate`; making it gating is a separate decision.

## 11. Scope: who else uses this sandbox (Q5)

| Consumer | Verdict | Why |
|---|---|---|
| M6-B external agents | **v1** | The only path that runs untrusted code with fork allowed (`(allow default)`), so it needs the watchdog |
| D98 verifier and C4 `code.check` | **SB-8**, after SB-6 and D120 C4 | Same shape (a worktree, forking toolchains), and C4 lives in `plur1bus-tools` anyway. Gives the verifier a macOS task cap, which D106 had to leave out in TypeScript |
| `exec.run` and host subprocesses (D106) | **P4 step 2** | Deny-default, no fork, and not running in shipped installs yet (D106 spec). The policy model leaves room for writable roots and deny-default |
| D119 compute workers | **No** | Jobs are data (embeddings, captions, ASR, TTS, decision, media generation) for trusted model runtimes on enrolled owner devices; no untrusted code runs (D119 §5.1, §13). A future job class that runs code would use this crate on the node |
| D118 role switch, D113 desktop SSH | **No** | No code execution; a remote harness sandboxes its own agents with its own `plur1bus-tools` |

## 12. Calls made by the author (not owner questions)

- The new reason string `memory-limit-exceeded`.
- SIGKILL at once on a limit violation; SIGTERM, 2 s grace, SIGKILL for timeout, cancel and output limit.
- Pull streaming; the keeper's status record as the authority; bwrap gains `--new-session --cap-drop ALL`.
- The launcher moves into the new crate under its existing name; the run journal and its start-time-checked sweep.
- The method names, profile names and audit names in §4 and §8.

## 13. Owner questions

| # | Question | Options | Recommendation |
|---|---|---|---|
| Q1 | Register entry | **D123**; fold into D120 (P4) | **D123.** It is free, and this is a decision of its own that comes before P4 step 2 |
| Q2 | Crate shape | (a) a new `plur1bus-sandbox` crate (library plus the keeper binary) with all `unsafe` in it; (b) inside `plur1bus-tools` with an `unsafe` exception | **(a).** `plur1bus-tools` stays `forbid(unsafe_code)`, and the launcher already lives in its own binary |
| Q3 | `plur1bus-tools`' own OS profile on macOS, given that nested Seatbelt fails (§3.3) | (a) no Seatbelt profile for `plur1bus-tools` on macOS (the core runs without one today too); least privilege through the core-only guard, the T1 ticket and the typestate; Linux keeps a profile only if nested bwrap works (U5); (b) a separate supervised sandbox-host process without a profile, while `plur1bus-tools` keeps its profile | **(a)** for v1. It amends D120 §17 for macOS. Choose (b) if §17 must hold as written |
| Q4 | Topology | a keeper process per run; or tools as the direct parent plus the journal sweep | **Keeper.** It is the only design where macOS survives a tools crash without leaving orphans |
| Q5 | v1 scope | M6-B only; also the verifier and C4; also `exec.run` | **M6-B only.** Verifier and C4 in SB-8, `exec.run` in P4 step 2, D119 not at all |
| Q6 | Windows | in v1; later | **Later** (SB-W, 5 agent days), failing closed until then |
| Q7 | Side-by-side period | none; a test-only env switch during SB-5; a user config key | **Test-only switch**, removed in SB-6. #820 has no released installs (assumed, U11) |
| Q8 | Tools service down after SB-6 | fail closed (`sandbox-unavailable`); fall back to TypeScript | **Fail closed.** Running untrusted code on a weaker path is worse than refusing it |
| Q9 | macOS terminal reads | keep #820's behaviour (reads allowed everywhere); deny reads of D106's credential list | **Deny.** The `fs/*` calls already refuse the same list, and the gate is unaffected |
| Q10 | Linux with cgroup v2 (SB-7) when `pids.events` reports `max` | abort with `task-limit-exceeded`; report a flag only | **Abort.** One typed outcome on both platforms |
| Q11 | H1-1 sits behind the B1 gate in the D120 plan | wait; pull H1-1 (skeleton only) ahead of B1; an interim path where TypeScript calls the keeper directly | **Pull H1-1 forward.** It changes no measured behaviour and avoids a second migration |

## 14. Unknowns

| # | Unknown | How it gets resolved |
|---|---|---|
| U1 | #820's watchdog is not pushed (`fd26fd2383`): the exit-121 path, the RSS reason, the limit defaults, the streaming path, and whether Linux sets `RLIMIT_NPROC` inside the namespace | SB-1 starts from merged #820 and re-checks §4.1 |
| U2 | Whether `proc_listpgrppids` and `proc_listchildpids` list unreaped zombies, or only `sysctl` `KERN_PROC_PGRP` does (which needs a `kinfo_proc` mirror) | First task of SB-1, with the `zombie` fixture |
| U3 | `RLIMIT_NPROC` per sandbox or per UID: D106 measured per namespace when the limit is set inside (6.18, bwrap 0.9.0); kernels 5.14–5.16 allow one extra; #820's final order is not known | SB-2's kernel-property test on the CI kernel |
| U4 | Whether a `setsid` escape on macOS can be detected or denied; no known Seatbelt operation for it | SB-1's `setsid-escape` fixture records the result |
| U5 | Nested bwrap inside a bwrap-confined `plur1bus-tools` | Matters only if Q3 keeps a Linux profile; measured in SB-4 |
| U6 | Push notifications on the tools connection (H1-1 is not built) | v1 pulls |
| U7 | Whether #820's final launcher runs the agent process itself in the sandbox. At `fd26fd2383` it does not, yet ADR-011 and the spike say "the agent runs inside" | Decides the `agent-process` profile (network, the agent CLI's config directory); SB-3 |
| U8 | Windows: whether git and toolchains run under AppContainer; job memory is committed memory, not RSS | SB-W spike |
| U9 | Whether cgroup v2 delegation exists for `daemon start` (no `Delegate=`); the no-internal-process rule | SB-7 probe |
| U10 | Whether GitHub's `macos-15` runners behave like the measurements on macOS 27.2 (nesting, zombies) | SB-1 on CI |
| U11 | Whether #820 shipped in a release (Q7 assumes not) | Release notes, checked at SB-5 |
