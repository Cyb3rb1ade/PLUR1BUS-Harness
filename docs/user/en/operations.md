# Operations manual

Running an installation day to day: where things live, what to read when something is wrong, how the OS service works on each system, and what the error codes mean. German: [`../de/operations.md`](../de/operations.md). Installation and first steps: [`quickstart.md`](quickstart.md). The agent-facing version of the repair ladder is the bundled skill (`skills/plur1bus-ops/`), and the generated references are [`docs/cli.md`](../../cli.md), [`docs/config.md`](../../config.md), [`docs/rpc.md`](../../rpc.md) and [`docs/log-schema.md`](../../log-schema.md).

`<home>` is the state root: `~/.plur1bus` on Linux and macOS, `%LOCALAPPDATA%\PLUR1BUS` on Windows, or whatever `--home <PATH>` or `PLUR1BUS_HOME` names. Every command accepts `--json`, and a `--json` document carries a top-level `schema` (`<command>/<major>`, failures `error/1`); read that, not the human text, in scripts.

## Directories

Created as needed; an empty or missing directory is normal. On Linux and macOS the home, `run/`, `logs/` and `config.json` are private to your user (`0700`/`0600`); on Windows `run/` carries an ACL for your user and SYSTEM only.

| Path | Holds | Safe to touch by hand? |
|---|---|---|
| `<home>/config.json` | the configuration (see "Changing configuration") | No while the supervisor runs: use `config set` |
| `<home>/manifest.json` | the install manifest `setup` writes: versions, hashes, channel, profile | No |
| `<home>/state/` | the engine's store (`lancedb`), the SQLite databases (`sessions.sqlite`, `identity.sqlite`, `budget.sqlite`), the capture journal (`journal/`), the system-job ledger (`system-jobs/`), dreams, `core.lock`, the staging directory of a backup | **Never.** Only the core writes it |
| `<home>/agents/<id>/` | one agent; its workspace is `workspace/` | Workspace files yes; the rest no |
| `<home>/run/` | sockets (`core.sock`, `supervisor.sock`; named pipes on Windows), `*.token`, `*.pid`, `supervisor.lock` | No. Tokens are secrets. `1staid repair` removes stale files |
| `<home>/logs/` | logs, see below | Read only |
| `<home>/runtime/` | the Node runtime `setup` installed (`node-24.21.0`) | No; `1staid repair` can reinstall it |
| `<home>/modules/`, `<home>/skills/`, `<home>/extensions/` | installed modules, skills, and the package cache, state and trash of extensions | Use `module`, `skill`, `plugin` commands |
| `<home>/data/` | extension data, kept when an extension is uninstalled | Per extension |
| `<home>/models/` | the embedding and reranker model cache | Deleting it re-downloads (about 600 MB) |
| `<home>/catalog/` | the model catalog (`models.json`) | No |
| `<home>/imports/` | the skills importer's lock and rollback data | No |
| `<home>/backups/` | archives from `backup create`, and `pre-restore-<id>/` directories left by a restore | Yes: copy archives off the machine, delete old ones |
| `<home>/bundles/` | zips from `1staid bundle` | Yes |

A group- or world-writable home or `run/`, a `run/` that is a symlink, a home owned by another uid (for example `sudo plur1bus` against your home) and a home on WSL under `/mnt/c` are refused by every client with `E_UNAUTHORIZED` (see the error table). Back up with `backup create`, not by copying `state/` while the core runs.

## Running the stack

```sh
plur1bus daemon status
plur1bus daemon start
plur1bus daemon stop
plur1bus daemon restart
```

`daemon status` prints the supervisor's own state and the state of every supervised process (the core and each module) with the OS service registration. `--json` (`daemon.status/1`) adds pids, uptimes and `lastExit`. States: `starting`, `ready`, `degraded`, `orphaned`, `stopping`, `stopped`, `crashed`. A `degraded` process carries a reason, most often `unresponsive` (up but not answering in time) or `core-unavailable`. A `crashed` process carries one of: `lock-held` (another core holds the engine's lock), `config-invalid`, `engine-contract` (the engine does not match the core), `ready-timeout`, `adopted-exit`, `manifest-invalid` and `api-version-unsupported` (modules only), `gave-up` (exited five times inside the give-up window; it will not restart by itself, fix the cause and run `daemon restart`, or `module restart <name>` for a module) or `none`.

`daemon stop` gives the core 10 000 ms to shut down before the supervisor kills it; `--budget-ms <BUDGET_MS>` changes that. A second `daemon stop` answers `not running` and exits 0. When an OS service is registered, `daemon start` starts that service rather than a detached process.

Modules:

```sh
plur1bus module list
plur1bus module graph
plur1bus module restart <name>
```

## Logs

Every process writes into `<home>/logs/`:

| File | Content |
|---|---|
| `supervisor.log`, `core.log`, `module-<name>.log` | the process's own log, one JSON object per line |
| `core.out.log`, `module-<name>.out.log` | what the process printed to stdout and stderr |
| `audit.log` | one JSON line per privileged action (`at`, `actor`, `action`, `target`, `detail`): repair steps, `config set`, secret access, extension changes. Append-only, private to your user, never contains values of secrets |

A line of `core.log`:

```
{"at":"2026-10-07T03:12:17.959Z","level":"info","role":"core","instanceId":"3d98...","address":"<home>/run/core.sock","supervised":true,"msg":"core ready"}
```

`level` is `debug`, `info`, `warn` or `error`. Rotation is by size: when a file would pass `logs.maxBytes` (20 971 520 by default, 20 MiB) it becomes `<file>.1`, the previous `.1` becomes `.2`, and so on up to `.<keep>` with `logs.keep` (default 5); the oldest is dropped. Both keys and `core.logLevel` (default `info`) are live: they apply without a restart.

```sh
plur1bus config set core.logLevel debug --dry-run
plur1bus config set core.logLevel debug --yes
```

Read a log with `tail -f <home>/logs/core.log` (Linux, macOS) or `Get-Content -Wait <home>\logs\core.log` (PowerShell). The event names and fields of the records are in `docs/log-schema.md`. Never paste a log into a report without reading it first; redact anything that looks like a secret.

To hand the evidence to someone else, write one redacted zip:

```sh
plur1bus 1staid bundle
```

It holds versions, platform, the check result, the service status, the configuration with secrets removed and the last 500 lines of each log (`--lines <N>` changes that), is written with private permissions to `<home>/bundles/` (or `--out <PATH>`) and never contains the audit log, payload capture, stores or tokens. Nothing is uploaded. The command refuses to write a bundle whose own re-scan still finds a secret.

## Service management

`service install` registers the supervisor as a service of **your user**, with no administrator rights, and starts it; `--no-start` registers only (it then starts at the next login). It runs `plur1bus --home <home> supervise`.

```sh
plur1bus service install
plur1bus service status
plur1bus service uninstall
```

For the default home the service has the plain name below; any other home appends `-<suffix>` (eight hex digits derived from the home path), so two homes never share a registration.

| | Linux | macOS | Windows |
|---|---|---|---|
| Manager | systemd user unit | launchd agent | Task Scheduler task |
| Name | `plur1bus` | `dev.plur1bus.supervisor` | `PLUR1BUS Supervisor` |
| Registration file | `~/.config/systemd/user/plur1bus.service` (`$XDG_CONFIG_HOME/systemd/user` when set) | `~/Library/LaunchAgents/dev.plur1bus.supervisor.plist` | the task itself; its XML is kept at `<home>\run\PLUR1BUS Supervisor.xml` |
| Starts | at login | at login | at logon of your user |
| Native status | `systemctl --user status plur1bus.service` | `launchctl print gui/$(id -u)/dev.plur1bus.supervisor` | `schtasks /Query /TN "PLUR1BUS Supervisor" /FO CSV` |
| After a crash | restarted after 1 s (`Restart=on-failure`), but not after a clean stop or exit 2 or 3 | restarted unless it exited cleanly (`KeepAlive` with `SuccessfulExit=false`) | restarted after a failed run, every minute, up to 999 times (`RestartOnFailure`) |
| Graceful stop | yes, the OS waits up to 150 s | yes, `ExitTimeOut` 150 s | no: `schtasks /End` terminates the process, the core then ends by its own grace timer |

The service manager stops and restarts only the supervisor. The core survives a supervisor crash and is adopted by the next supervisor, so the unit uses `KillMode=process` (systemd) and `AbandonProcessGroup` (launchd).

Starting without a login: a systemd user unit starts at login unless lingering is enabled for your account (`loginctl enable-linger <user>`, a systemd command; whether your distribution lets an ordinary user run it is not verified here, see `docs/platform-matrix.md`). macOS and Windows need at least one login to arm the autostart. After a reboot the supervisor replaces the stale pid, socket and token files itself; a `warn` on `run.stale-files` in a check run seconds after boot is not a failure, run it again after a minute. A second supervisor started while one runs loses the single-instance lock and exits 3 (0 under launchd, which would otherwise loop). The procedure for checking reboot survival on a real machine is `docs/reboot-survival.md`.

## Changing configuration

Every key has a restart class: `live` applies at once, `core` restarts the core, `module:<name>` restarts that module. Read it first, dry-run, then apply:

```sh
plur1bus config get core.logLevel
plur1bus config set core.logLevel debug --dry-run
plur1bus config set core.logLevel debug --yes
plur1bus config get --tier basic
plur1bus config schema --tier basic
```

`config get <KEY>` prints `core.logLevel = "info"  [live, advanced]`. A dry run prints `changes:` and, per key, what would happen (`live key, sent to the running core with config.changed`) and writes nothing. A value the schema refuses is `E_CONFIG_INVALID` and changes nothing on disk:

```
plur1bus: the configuration would be invalid: /core/logLevel "loud" is not one of ["debug","info","warn","error"]
```

`--yes` is required outside a terminal. All keys, defaults and classes are in `docs/config.md`. Do not edit `config.json` by hand while the supervisor runs.

## Backup, restore, update

The procedures are in [`quickstart.md`](quickstart.md#6-backup-and-restore) and [`quickstart.md`](quickstart.md#7-update). Operational points: archives accumulate in `<home>/backups/` and nothing prunes them; a restore leaves the displaced state in `<home>/backups/pre-restore-<id>/` until you delete it; `update` snapshots everything except the memory store, so take a backup before an update; `update status` tells whether a rollback is possible.

## Troubleshooting

Work up this ladder and stop at the first rung that fixes it; do not skip one.

1. `plur1bus 1staid check` (read-only, safe any time). Look at every `warn` and `fail`; each row's hint names the next command.
2. `plur1bus 1staid repair --dry-run` shows the plan and changes nothing. Read it.
3. `plur1bus 1staid repair` applies it, asking for each step (`--yes` once the plan is exactly what you want, `--only <STEP_ID>` to limit it). Every applied step is written to `audit.log`. Risk is `none`, `low`, `medium` or `high`; stop and think before a `high` step (`unit.terminate-hung`, `store.migrate`).
4. `plur1bus module restart <name>` for one module, then `plur1bus daemon restart` for the whole tree.
5. `plur1bus service status` for what the OS service manager sees.
6. `plur1bus 1staid bundle`, and give the zip to whoever supports the installation.

Never edit `state/` by hand, never `kill -9` a supervised process (it leaves stale files and the next start has to clean them), and never repair a `high`-risk step you cannot explain.

The checks (`1staid check`, in this order): `config.valid`, `config.store-path`, `host_mode_coexistence`, `run.permissions`, `run.stale-files`, `supervisor.state`, `core.state`, `models.warm`, `memory.shared`, `core.lock`, `modules.state`, `service.registration`, `agents.activity`, `journal.backlog`, `jobs.last-runs`, `api.deprecations`, `windows.pipe-acl` (Windows only), `runtime.node`, `runtime.core`, `models.cache`, `extensions.integrity`, `extensions.consistency`, `extensions.revoked`, `models.roles`. What each one means and which repair step fixes it is the table in `skills/plur1bus-ops/playbooks/diagnose.md` and `repair.md`; a test keeps those two files in step with the code.

### Exit codes

| Exit | Meaning |
|---|---|
| 0 | success. `memory recall` and `memory add` also exit 0 when the core is unreachable and answer `degraded` or `journaled` instead; read their text |
| 1 | failure: any error code not listed below, and a failed `setup` step or check |
| 2 | `E_NOT_AVAILABLE`, `E_APPROVAL_REQUIRED`, a usage error, or a stub command |
| 3 | `E_LOCKED` |

### Error codes

A failure from a command that talks to the running installation carries one of these codes (`error` in a `--json` document, `E_...:` in the text), optionally with a `reason`:

| Code | Exit | Meaning and what to do |
|---|---|---|
| `E_UNAUTHORIZED` | 1 | The client refused to talk to the process or was refused. Reasons `run-dir-untrusted`, `socket-untrusted`, `peer-uid-mismatch`, `server-pid-unknown` (Windows): `run/` is not yours alone (wrong owner, writable by others, a symlink), or you run the command as a different user than the daemon. Run it as the owner; `1staid repair` can fix permissions (`run.permissions.fix`). `adopt-nonce` is internal |
| `E_RPC_VERSION` | 1 | The CLI and the running core or supervisor speak different RPC versions, most likely a daemon that is older than the binary you just ran: `plur1bus daemon restart` |
| `E_NOT_AVAILABLE` | 2 | The feature cannot run now. `no-provider`: no chat model is wired in (expected today). `config-unavailable`: no valid configuration runs, see `config.valid`. `container-managed`: a container manages the lifecycle, expected. For a module: `manifest-invalid`, `api-version-unsupported`, `scope-agent-unsupported`, `disabled`, `needs-unavailable`, `ext-revoked`, `ext-tampered`, `ext-incompatible` |
| `E_CORE_UNAVAILABLE` | 1 | The core cannot be reached. Text: `core unavailable: core unavailable (core-unavailable): No such file or directory (os error 2)`; the supervisor is not running (`daemon start`), or the core is starting, stopping or crashed (`daemon status` names the reason) |
| `E_INVALID_PARAMS` | 1 | A parameter was refused, for example an empty text or an invalid cron expression; nothing was written. Many module and extension refusals use it with a reason (`not-a-directory`, `symlink`, `digest-mismatch`, `archive-unsafe-entry`, ...; `docs/extensions.md`) |
| `E_AGENT_UNKNOWN` | 1 | `agent <id> is not registered`: `plur1bus agent list`, then `plur1bus agent create <id>` |
| `E_CONFIG_INVALID` | 1 | The configuration or a value fails the schema; nothing changed. Reason `foreign-host-store-path`: the store path overlaps another host's state |
| `E_MODULE_UNKNOWN` | 1 | No module of that name is installed: `plur1bus module list` |
| `E_INTERNAL` | 1 | A defect or an I/O failure, often with a reason such as `io` or `worker-failed`. Collect `1staid bundle` and the log lines around the time |
| `E_LOCKED` | 3 | Someone else holds a lock: reason `core-lock-held` (another core owns the engine store; the supervisor retries), `skills-locked` (another install or import is running, retry in a moment) |
| `E_NOT_FOUND` | 1 | The thing asked for does not exist (a session, a proposal, an extension, a nonce that expired) |
| `E_DENIED` | 1 | Your identity may not do this (secrets are owner only), or a policy refused (`policy-unsigned-disallowed`, `revoked`, `bundled`) |
| `E_APPROVAL_REQUIRED` | 2 | The action needs an acknowledgement first (`acknowledge-unsigned`, `acknowledge-unknown-signer`, `acknowledge-downgrade`, `acknowledge-capabilities`) |
| `E_CONFLICT` | 1 | The state does not allow it now, for example `config-changed` (the configuration changed since you read it), `name-taken`, `busy`, `required-by`, `migration-running` |
| `E_STORAGE` | 1 | A store or file is unreadable or full: reasons `source-busy`, `insufficient-disk`, `store-outside-home`, `state-invalid`, `index-invalid`, `index-newer`, `corrupt`, `sqlite-corrupt`. Check disk space first, then `1staid check` |

Besides these, the install and backup tools print their own reasons without an `E_` code, as `plur1bus: <reason>: <detail>`: `setup` steps fail with `release-unreachable` (the feed or a download host did not answer; check the network and `PLUR1BUS_INSTALL_FEED`), `digest-mismatch` (a download does not match its pinned hash; nothing is installed from it), `download-too-large`, `core-source-missing`, `io`, `profile-invalid`, `profile-change-unsupported`, `manifest-invalid`; `backup verify` fails with `archive-corrupt`, `truncated`, `manifest-invalid`, `unsupported-format`, `unexpected-entry`, `checksum-mismatch` or `missing-entry`.

### Symptoms

| You see | Look at | Do |
|---|---|---|
| Any command answers `E_CORE_UNAVAILABLE` | `plur1bus daemon status` | supervisor `stopped`: `plur1bus daemon start`. Core `crashed`: read the reason above, then `<home>/logs/core.log` and `core.out.log` |
| `daemon start` does not reach `ready` | `daemon status`, `<home>/logs/supervisor.log`, `core.out.log` | `config-invalid`: `plur1bus 1staid check` row `config.valid`, then `1staid repair`. `lock-held`: another core uses this store; find and stop it (`core.lock` row) |
| `chat` says `no-provider` | nothing is wrong | no chat model is wired in yet, see the quickstart |
| `memory add` or `recall` is slow the first time | `1staid check` rows `models.warm`, `models.cache` | wait for the model download; recall answers `degraded` meanwhile |
| `memory add` says `journaled (the core replays it at start)` | `daemon status` | start the daemon; the line is replayed at core start (row `journal.backlog`) |
| `warn  service.registration` | `plur1bus service status` | `plur1bus service install`, or `1staid repair` step `service.renew` |
| Supervisor keeps restarting | `1staid repair --dry-run` (`service.restart-loop` reports, changes nothing), `supervisor.log` | fix the cause the log names, then `plur1bus daemon restart` |
| Stale files after a crash or reboot | `1staid check` row `run.stale-files` | `plur1bus 1staid repair --only run.stale-files.remove --yes`; it never removes a file a live process still answers for |
| `plur1bus update` says `no install manifest here: run plur1bus setup first` | | this home was not made by `setup` (for example a source build); use `setup` |
| `plur1bus login`, `channel`, `project` or `uninstall` print `arrives in M2` (or M4, M3, M8) and exit 2 | | the command is a stub, see the quickstart |

### Known defect at the time of writing

On macOS arm64 with the code of 2026-10-07, `plur1bus backup create` on a fresh home with a running core failed with `plur1bus: manifest-invalid: unit "state/budget.sqlite-shm" is not allowed` and no archive was written. Nothing in your installation is broken and nothing needs repairing; the failure is in the backup code. No archive is produced, so until it is fixed a restore is only possible from an archive made some other way, and `1staid bundle` is not a substitute for a backup. This note should be deleted when the defect is.
