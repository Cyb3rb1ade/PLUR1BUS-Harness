# External-agent containment in Rust — implementation plan

**Goal.** Run M6-B's sandboxed terminal, agent launcher and watchdog in Rust: a new crate, `plur1bus-sandbox`, used by
the `plur1bus-tools` module and called by the core over `tools.sandbox.*`. The TypeScript interface and the reason codes
stay as they are, and #820's suites are the acceptance gate. Specified in
[`2026-10-31-containment-rust-design.md`](../specs/2026-10-31-containment-rust-design.md), cited as "spec §n"; register
entry D123, proposed (Q1).

**Architecture.** A keeper process per run (`plur1bus-sandbox-limits keep`), started by `plur1bus-tools`, is the parent
and reaper of the Seatbelt or bwrap process and runs the watchdog (spec §3, §6). `plur1bus-tools` stays
`forbid(unsafe_code)`; all `unsafe` lives in `plur1bus-sandbox` (spec §3.1).

**Status.** Plan only. **It starts after PR #820 is merged.** It needs D120 H1-1 (the `plur1bus-tools` skeleton) from
SB-4 on (Q11). Owner questions Q1–Q11 are in spec §13.

**Constraints.**
- **RPC.** JSON Schema is the single source: closed params, `x-server: "tools"`, `x-stability: "experimental"`, `x-since`
  set to the next minor. No new RPC error codes; new reason strings go into `docs/errors.md`.
- **Dependencies.** No new crate (spec §9); `libc` is pinned `=0.2.189`.
- **Tests.** TDD, red test first. No `sleep` synchronisation (spec §6). No network in tests. Never skip, disable or
  quarantine a test to get green.
- **#820's suites stay byte-identical:** `containment`, `red-team`, `hardlink` and `coding-worktree`.
- **Executor.** Every Rust package is done by a Claude agent, never Codex (owner preference).
- **Process.** One branch and one ready PR per package. No CI polling: push, open the PR, report the number, stop. No
  force-push, rebase, amend or stash. Commits carry the owner's identity.

## Work packages

| WP | Scope | Files | Language | Executor | Estimate (agent days) | Depends on |
|---|---|---|---|---|---|---|
| **SB-1** | New crate; the launcher moves in under its name; `keep` mode: lifeline fd, `NOTE_EXIT`, `posix_spawn` with its own pgid, status records on fd 3; macOS watchdog (conservative count, RSS sum, `NOTE_FORK` plus 100 ms sweep, escalation, wait until the group is empty); the `sbx-fixture` binary; U2, U4 and U10 measured | `crates/plur1bus-sandbox/{Cargo.toml,src/{lib,keeper,watchdog,status}.rs,src/sys/macos.rs,src/bin/plur1bus-sandbox-limits.rs,tests/}`; `crates/plur1bus/Cargo.toml` (bin removed); the `sandbox` job in `ci.yml` (build line); release payload path if it names the crate | Rust | Claude agent | 2.5 | #820 merged |
| **SB-2** | Linux keeper: `PR_SET_PDEATHSIG` plus the `getppid` check, pidfd wait and signal with a fallback, PID-namespace enumeration, `statm` RSS, D106's inner `--tasks` step; kernel-property tests (U3) | `src/sys/linux.rs`, `tests/linux_*.rs` | Rust | Claude agent | 1.5 | SB-1 |
| **SB-3** | Policy model; Seatbelt profile and bwrap argv generation, golden-tested against #820's output; `childEnv` port plus the loader denylist; argv validation; realpaths, `gitDenyPaths`, hardlink scan; Q9 read denies; the `agent-process` profile (U7) | `src/{policy,profile,argv,env,scan}.rs`, `tests/golden/` | Rust | Claude agent | 1.5 | SB-1 (in parallel with SB-2) |
| **SB-4** | `tools.sandbox.{run,spawn,write,read,cancel,status,probe}` in the schema, with fixtures; handlers in `plur1bus-tools`: run table, bounded head and tail buffers, T1 ticket check, run journal and its sweep, probe; U5 if Q3 keeps a Linux profile | `packages/rpc-schema/schema/rpc.schema.json`, `packages/rpc-schema/fixtures/methods/tools.sandbox.*.json`, `crates/plur1bus-tools/src/sandbox/`, `docs/errors.md`, generated `docs/rpc.md` | Rust and schema | Claude agent | 1.5 | H1-1, SB-2, SB-3 |
| **SB-5** | `containedTerminal` and `launchExternalAgent` become thin RPC clients behind the same signatures; the test-only `PLUR1BUS_CONTAINMENT` switch; the gate on both backends; Doctor row `tools.sandbox.containment`; audit events (spec §8) | `packages/core/src/external-agents/{containment,launcher,delegation}.ts`, `packages/core/src/composition/external-agents.ts`, `packages/core/src/doctor-report.ts`, `packages/log-schema/schema/catalogue.json`, test runner env | TypeScript | Claude agent | 1.5 | SB-4 |
| **SB-6** | Parity cut: delete the TypeScript spawn, kill and watchdog code and the switch; enter D123; update `docs/agent-isolation.md`, `docs/security.md`, `docs/host-tools.md` and ADR-011 | the files above, plus the register in `2026-09-24-m1b-2a-core-daemon-cli-design.md` §2 | TypeScript and docs | Claude agent | 0.5 | SB-5 green on macOS and Linux |
| | **Total for macOS and Linux** | | | | **9.0** | |

**Follow-ups** (not in the total; each comes after SB-6):

| WP | Scope | Files | Language | Executor | Estimate | Depends on |
|---|---|---|---|---|---|---|
| SB-7 | Optional cgroup v2 layer: detection, `pids.max`/`memory.max`/`memory.oom.group`, `clone3(CLONE_INTO_CGROUP)`, typed reports from `pids.events`/`memory.events`, probe and Doctor (U9) | `src/sys/linux_cgroup.rs`, `tests/linux_cgroup.rs` | Rust | Claude agent | 2 | SB-6, Q10 |
| SB-8 | D98 verifier and C4 `code.check` through `tools.sandbox.run` with a `verifier` profile (macOS task cap included) | `packages/core/src/collab/verifier.ts`, `crates/plur1bus-tools/src/sandbox/`, `crates/plur1bus-sandbox/src/profile.rs` | Rust and TypeScript | Claude agent | 1.5 | SB-6, D120 C4 |
| SB-W | Windows backend: AppContainer profile and ACLs, Job Object limits with `KILL_ON_JOB_CLOSE`, completion-port typed reports, handle list; a spike first (U8) | `crates/plur1bus-sandbox/src/sys/windows.rs`, `tests/windows_*.rs` | Rust | Claude agent | 5 (4–7) | SB-6, Q6 |

```text
#820 merged ─► SB-1 macOS keeper + watchdog ─┬─► SB-2 Linux keeper ─┐
                                             └─► SB-3 policy/profile ┴─► SB-4 RPC (needs H1-1) ─► SB-5 TS client + gate ─► SB-6 parity cut
                                                                                                                              ├─► SB-7 cgroup v2
                                                                                                                              ├─► SB-8 verifier + C4
                                                                                                                              └─► SB-W Windows
```

## Best first package: SB-1

SB-1 carries most of the risk. It measures U2 (macOS zombie visibility), U4 (`setsid` escape) and U10 (CI runners
against the Mac measurements) before anything else is built on them. It needs neither H1-1 nor the RPC: the keeper takes
a backend argv, so its tests run against `sandbox-exec -p '(version 1)(allow default)'` and the fixtures.

## SB-1 — macOS keeper and watchdog (2.5 agent days)

- **First task:** a `zombie N` fixture and a test that records which of `proc_listpgrppids`, `proc_listchildpids` and
  `sysctl` `KERN_PROC_PGRP` list the zombie. The test result picks the enumeration (spec §6) and is written into the
  crate docs.
- **Then:**
  - the `keep` argv: `keep --status-fd 3 --lifeline-fd 4 --parent <pid> --limits <json> -- <backend argv>`;
  - status records `started`, `sample`, `limit` and `exit`;
  - the escalation rules;
  - exit codes 121 and 125 for the legacy caller;
  - the existing D106 modes, unchanged, with their tests in `crates/plur1bus/tests/sandbox_limits.rs` moved along.
- **Tests:**
  - zombies are counted;
  - `fork-hold` over `maxTasks` gives `task-limit-exceeded`, and the group is empty afterwards;
  - `alloc` gives `memory-limit-exceeded`;
  - `ignore-term` is killed after the grace;
  - a killed parent makes the keeper kill the group, asserted by kqueue `NOTE_EXIT` on the fixture pids, not by polling;
  - the `setsid-escape` fixture's outcome is recorded (U4);
  - on Linux and Windows, `keep` compiles, and the backend argv is refused on Windows.
- **Acceptance:** `cargo test -p plur1bus-sandbox` passes on `macos-15` and `ubuntu-24.04` in the `sandbox` job;
  `cargo deny check` is clean; no new crate in `Cargo.lock`.

## SB-2 — Linux keeper (1.5 agent days)

`PR_SET_PDEATHSIG(SIGKILL)` plus `getppid()` against `--parent`; `pidfd_open` and `pidfd_send_signal`, with the
`waitpid`/`kill` fallback; enumeration over `/proc/*/ns/pid`; `statm` RSS; the inner `--tasks` step bound at
`/run/plur1bus/sandbox-limits`.

- **Tests** (owner decision 2026-10-31):
  - concurrent tasks never exceed `maxTasks`, and the next fork gets EAGAIN;
  - two sandboxes count independently;
  - a zombie holds a slot;
  - killing the keeper takes the namespace down (`--die-with-parent`);
  - the fallback path is driven through an injected "no pidfd" flag.
- **Acceptance:** green on `ubuntu-24.04` with bwrap installed. A skip states the probe's reason, never silently.

## SB-3 — Policy, profiles, pre-launch checks (1.5 agent days)

Port `seatbelt()`, `bwrapArgv()`, `childEnv()`, `gitDenyPaths()`, `blocksWorktree()` and `findHardlink()` from #820.
- **Golden fixtures.** A script runs the TypeScript functions on a fixture worktree and commits their output; the Rust
  tests compare byte for byte.
- **Additions:** D106's loader denylist, `--new-session --cap-drop ALL` for bwrap, the Q9 read denies (behind the owner's
  answer), and the `agent-process` profile once U7 is known from merged #820.
- **Acceptance:** golden tests are green, and every #820 refusal case has a Rust unit test.

## SB-4 — RPC surface in `plur1bus-tools` (1.5 agent days)

- **Schema:** the methods of spec §4 with contract fixtures; generated Rust and TypeScript types.
- **Handlers:** the run table (keyed by `runId`); stdout and stderr buffers (head and tail, `cut`, 4 MiB backpressure
  for `agent-process`); the long-poll `read`; idempotent `cancel`; `status`; `probe`; the T1 ticket check (key from
  `tools.hello`, H1-1); the run journal at `state/run/sandbox/` and its sweep before serving.
- **Tests:** the core-only guard refuses other principals; a bad, expired or reused ticket is refused; a journal with a
  stale entry whose start time no longer matches leaves the reused pid alive.
- **Acceptance:** `pnpm docs:check`; the schema tests that enforce server values pass.

## SB-5 — TypeScript thin client and the gate (1.5 agent days)

- **Clients.** `containedTerminal` keeps `TerminalResult | TerminalRefusal`. `launchExternalAgent` keeps `LaunchHandle`;
  its `stdin` and `stdout` streams map to `write` and `read`.
- **Wiring.** The client comes from `tools-service/client.ts`, or from spawning `PLUR1BUS_TOOLS_BIN` in tests and in core
  run.
- **Switch.** `PLUR1BUS_CONTAINMENT=ts|rust` (default `rust`) exists only in this PR's lifetime. CI runs the four gate
  files on both values on macOS and Linux.
- **Doctor and audit.** The Doctor row reports the probe. The audit events of spec §8 go into the log catalogue.
- **Acceptance:** the four gate files are unchanged and green on both backends; the Windows refusal tests are green.

## SB-6 — Parity cut and docs (0.5 agent days)

- **Delete** the TypeScript `spawn`/`process.kill` paths and the switch. `findHardlink` and `gitDenyPaths` stay for
  session open and `fs/*`.
- **Docs:** `docs/agent-isolation.md` and `docs/security.md` (external agent worktree), `docs/host-tools.md` (sandbox
  table), an ADR-011 note, and D123 in the register.
- **Checks:** `node scripts/check-doc-links.mjs`, `node scripts/lint-hygiene.mjs`.
- **Acceptance:** no `detached: true` spawn remains in `packages/core/src/external-agents/`, and the gate is green.

## Estimate

| Block | Agent days |
|---|---|
| SB-1 to SB-6 (macOS and Linux) | 9.0 (range 7.5–11) |
| SB-7 cgroup v2 | 2 |
| SB-8 verifier and C4 | 1.5 |
| SB-W Windows | 5 (4–7) |
