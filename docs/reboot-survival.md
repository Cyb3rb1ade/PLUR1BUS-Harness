# Reboot survival: test protocol

M8 acceptance 3 asks for "service registration and survival of a reboot verified per OS". A CI runner cannot reboot
itself, so the claim is split in two: what a reboot *does to the installation* is simulated and tested on every CI run;
what the *operating system* does with the registered service is checked by hand on a real machine, with the protocol
below. Nothing here touches a real home, keychain or service manager in CI.

## What a reboot does to a home

Every process of the stack dies without cleaning up (power loss, `kill -9`, an OS update that does not wait). What stays
is whatever the processes wrote under `<home>/run/` and `<home>/logs/`:

- `run/supervisor.pid`, `run/core.pid`, `run/module-<name>.pid` of processes that no longer exist;
- `run/supervisor.sock`, `run/core.sock`, `run/module-<name>.sock` with nothing listening (unix; Windows pipes die
  with their owner);
- `run/*.token` of the dead processes, and `run/supervisor.lock`, which is never removed: the operating system drops the
  lock itself when its holder dies, so the next supervisor locks the same inode (ADR-012 §10).

A later boot has to come up from that, and a `run/` that was discarded altogether (a tmpfs, a cleaned home) has to be
recreated.

## Simulated, as integration tests (`crates/plur1bus/tests/reboot.rs`)

The tests run the real `plur1bus` binary, the fake core (`tests/fixtures/fake-core.mjs`) and the built fixture module
in a temp home. The service manager is the fake one (`PLUR1BUS_SERVICE_FAKE`, `PLUR1BUS_ALLOW_TEST_INTERNALS=1`), which
only records the commands it is given: the test plays the operating system, sees the manager's `start` and launches the
registered unit's `plur1bus supervise`. A "reboot" is `SIGSTOP` on the supervisor (so it cannot restart anything),
`SIGKILL` on module, core and supervisor, and a wait until every pid is gone.

| Acceptance | Test |
|---|---|
| A stale pid file, socket and lock after the reboot is detected | `a_rebooted_stack_replaces_what_the_dead_processes_left_behind`: `1staid check` reports `run.stale-files` `warn` and names `core.pid`, `supervisor.pid`, `module-fixture.pid`, `supervisor.sock` |
| …and cleaned up | the same test: after the next boot the row is `ok`, the pids are new, one core and one module run, one `started` event per boot; `a_repair_clears_the_stale_files_without_starting_anything`: `1staid repair --yes --only run.stale-files.remove` clears them with nothing running and leaves `supervisor.lock` |
| `run/` is recreated | `a_discarded_run_directory_is_recreated_private`: sockets, tokens and pid files come back, `run/` is `0700`, `run.permissions` is `ok` |
| Core, supervisor and module come up through the service abstraction | all of the above go through `service install`, `daemon start` (`via: "service"`) and the unit launch |
| A second start does not produce a double core | `a_second_start_after_a_reboot_never_makes_a_second_core`: the unit launched twice plus a `daemon start` at the same moment; the loser exits 3, one supervisor, one core, one more `started` event |

The unix-only parts are the signals and the orphan reaping (the test process becomes a child subreaper on Linux, so a
killed core is not left as a zombie that still looks alive). Windows has no equivalent test yet; its row in the manual
protocol is the evidence.

## Only checkable on a real system (manual protocol)

Run once per release candidate on each target (macOS arm64, Windows x64, Linux x64, Linux arm64), on a machine that
can reboot, with a throwaway home:

1. `plur1bus setup`, then `plur1bus service install` (it starts the unit). `plur1bus daemon status --json`: core
   `ready`, every installed module `ready`; note the pids.
2. Reboot the machine. Do **not** log in on macOS and Windows if the unit is meant to start at boot; log in only where
   the manager is a user session (launchd user agent, `systemd --user`, Task Scheduler "at log on"). On Linux without
   a session: `loginctl enable-linger <user>` must have been run (documented in the install guide), and the unit must
   start without a login.
3. Without touching anything: `plur1bus daemon status --json` shows a new supervisor pid, core `ready`, modules
   `ready`; `plur1bus 1staid check --json` has no `fail`, and `run.stale-files` is `ok` (a `warn` that a first check
   shows before the unit has finished starting is not a failure; run it again after a minute).
4. `plur1bus service status --json`: `registered: true`, `running: true`. Exactly one `plur1bus supervise` process
   and one core process in the process list.
5. Repeat after a hard power cut (not a clean shutdown) where the hardware allows it: unplug a VM, `echo b >
   /proc/sysrq-trigger`, or hold the power button. The unit must still come back, and `plur1bus 1staid bundle` must
   write a bundle.
6. Windows only: check the ACL of `run\` and of a `.token` file with `icacls` after the reboot (user and SYSTEM only,
   inherited); the supervisor sets it again at start, and `1staid check` reports `windows.pipe-acl`.
7. macOS only: confirm launchd did not respawn a supervisor that exited 2 or 3 in a loop (`PLUR1BUS_SERVICE_MANAGER=
   launchd` remaps those codes to 0): `launchctl print gui/$UID/dev.plur1bus.supervisor-<hash>` shows `state = running`
   and a stable pid after a minute.

Record the result per target in the release checklist (§6.2 of `docs/milestones.md`).

## What is not covered

- A pid file whose pid was reused by an unrelated live process: the supervisor's adoption identity checks (peer
  credentials, ADR-012 §10.7) decide that case; `reboot.rs` plants no such pid.
- A reboot in the middle of an `update`, an `ext install` or a module install: recovery for those is
  `ext::recover` and `modules::install::recover`, tested in `ext_commit.rs` and `modules.rs`.
- The OS service managers themselves: only the fake one runs in CI (`tests/service_real.rs` needs
  `PLUR1BUS_SERVICE_TEST=1` and a real manager).
