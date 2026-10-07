# Operations handbook

How an installation is laid out, where its logs are, how to run it as a service on each operating system and how
to find out what is wrong. Every command exists in this build (`docs/cli.md`). The agent-facing version of the
repair ladder is `docs/operations.md`; the German version of this page is [../de/operations.md](../de/operations.md).
Start with [quickstart.md](quickstart.md) if you have not installed yet.

## Directories

The home directory is, in this order: `--home <path>`, the `PLUR1BUS_HOME` environment variable (empty counts as
unset), then `~/.plur1bus` (Linux, macOS) or `%LOCALAPPDATA%\PLUR1BUS` (Windows).

| Path under the home | Holds |
|---|---|
| `config.json` | The configuration. Change it with `plur1bus config set`, not by hand while the supervisor runs. Damaged copies are kept as `config.json.bak-*`. |
| `manifest.json` | The install manifest `setup` writes. Without it, `update --check` answers `E_NOT_AVAILABLE` (reason `not-installed`). |
| `state/` | The core's stores and the write-ahead journal (`state/journal`). Never edit. |
| `agents/<id>/workspace` | One agent's workspace. |
| `run/` | Sockets, tokens and pid files of the running processes (`core.token`, `core.pid`, `supervisor.token`, `supervisor.pid`, `supervisor.lock`, `module-<name>.token`). Owner-only; recreated on start. |
| `logs/` | Logs, see below. |
| `runtime/` | The Node runtime and the core installed by `setup`. |
| `skills/` | Installed skills, one `<name>/SKILL.md` directory each. |
| `modules/` | Installed modules. |
| `extensions/` | Extension state, package cache, staging and trash (`skill`, `plugin`, `ext` commands). |
| `data/ext/<name>` | An extension's own data, kept at uninstall. |
| `imports/` | Importer state (`plur1bus import`). |
| `models/`, `catalog/` | The model cache and the model catalog (`catalog/models.json`). |

## Logs

All under `<home>/logs/`:

| File | Content |
|---|---|
| `supervisor.log`, `core.log`, `<module>.log` | One process's own structured records, one JSON object per line. |
| `supervisor.out.log`, `core.out.log`, `<module>.out.log` | What that process printed to stdout and stderr. |
| `audit.log` | Append-only audit log: one line per privileged action. Read it, never edit it. |
| `supervisor.stderr` | macOS only: what the launchd job's supervisor prints to stderr. |

Logs rotate by size: the newest rotated file is `<file>.1`, then `<file>.2` and so on. Systemd also records the
supervisor's output in the user journal (see below).

## Service management

`plur1bus service install` registers the supervisor with the operating system's service manager in the user's own
context (no administrator rights) and starts it; `--no-start` registers only, and the service then starts at the
next login. `service status` shows whether it is registered and running; `service uninstall` removes it. `setup`
does this for you unless you pass `--no-service`.

| | Linux | macOS | Windows |
|---|---|---|---|
| Manager | systemd user unit | launchd agent | Task Scheduler task |
| Name (default home) | `plur1bus` | `dev.plur1bus.supervisor` | `PLUR1BUS Supervisor` |
| Name (any other home) | `plur1bus-<8 hex>` | `dev.plur1bus.supervisor-<8 hex>` | `PLUR1BUS Supervisor-<8 hex>` |
| Registration file | `$XDG_CONFIG_HOME/systemd/user/<name>.service` (default `~/.config/systemd/user/`) | `~/Library/LaunchAgents/<name>.plist` | `<home>\run\<name>.xml` (the task itself lives in Task Scheduler) |
| Restart on crash | `Restart=on-failure` | `KeepAlive` unless it exits cleanly | `RestartOnFailure` (every minute, up to 999 times); logon trigger |

The suffix is derived from the home path, so several homes can have one service each.

```sh
plur1bus service install
plur1bus service status
plur1bus service uninstall
```

Day to day, use the daemon commands; if a registered service owns the home, `daemon start` starts that service:

```sh
plur1bus daemon start
plur1bus daemon status
plur1bus daemon restart
plur1bus daemon stop
```

On Linux the unit's own log is also available with the standard systemd tool: `journalctl --user -u plur1bus`.
Windows and macOS are described from the code of this repository; they are not exercised on every release.

## Troubleshooting

### Find out what is wrong

Work in this order; each step is read-only until `repair`:

```sh
plur1bus daemon status
plur1bus 1staid check
plur1bus 1staid repair --dry-run
plur1bus 1staid repair
```

`1staid check` ids you will see include `config.valid`, `run.permissions`, `run.stale-files`, `supervisor.state`,
`core.state`, `models.warm`, `core.lock`, `modules.state`, `service.registration`, `journal.backlog`,
`jobs.last-runs`, `runtime.node`, `runtime.core`, `models.cache` and `extensions.integrity`. A `warn` or `fail`
comes with a hint at the next command. `1staid repair` prints a plan with a risk level per step, asks for each
(`--yes` confirms all; required outside a terminal), can be limited with `--only <step-id>`, and never touches
`state/`. After applying, it re-runs the checks.

For a single module, `plur1bus module restart <name>`; for everything, `plur1bus daemon restart`.

### Exit codes

`0` success; `1` a failure; `2` `E_NOT_AVAILABLE` or `E_APPROVAL_REQUIRED` (also what a not-yet-built command
answers); `3` `E_LOCKED`. With `--json`, a failure is `{"error": "<code>", "message": ..., "schema": "error/1"}`,
often with a `reason`.

### Error codes

| Code | Typical meaning here | What to do |
|---|---|---|
| `E_AGENT_UNKNOWN` | The agent id is not registered (`agent main is not registered`). | `plur1bus agent list`, then `plur1bus agent create <id>`. |
| `E_INVALID_PARAMS` | Bad input, e.g. an agent id that does not match the pattern, or reason `agent-exists`. | Correct the argument. |
| `E_NOT_AVAILABLE` | A named `reason` says why. `not-installed`: no install manifest. `config-unavailable`: no valid configuration is running. `container-managed`: a container owns the lifecycle, so this is expected. `foreign-host-store-path`: `setup` refused a store path that overlaps another host's state. A module may report `manifest-invalid`, `api-version-unsupported`, `disabled`, `needs-unavailable`. | Read the `reason`; for `not-installed` run `plur1bus setup`; for `config-unavailable` fix `config.json` (`1staid repair`). |
| `E_CORE_UNAVAILABLE` | Nothing could reach the core. | `plur1bus daemon status`, then `plur1bus daemon start`; check `logs/core.log`. |
| `E_CONFIG_INVALID` | A value the schema refuses; the detail lists the errors. | `plur1bus config set <key> <value> --dry-run` to validate first. |
| `E_CONFLICT` | e.g. reason `config-changed`: the configuration changed since you read it. | Read it again and retry. |
| `E_MODULE_UNKNOWN` | No module of that name is installed. | `plur1bus module list`. |
| `E_LOCKED` | Another process holds a lock: the engine's, the supervisor's, or (reason `skills-locked`) the skills index. | `plur1bus daemon status`; do not start a second supervisor for the same home. |
| `E_UNAUTHORIZED` | The client refused to talk to the process: reason `run-dir-untrusted`, `socket-untrusted` or `peer-uid-mismatch`. | `plur1bus 1staid check` (`run.permissions`), then `1staid repair`. |
| `E_RPC_VERSION` | Client and core speak different RPC versions. | Run matching versions of `plur1bus` and the core; `plur1bus update --check`. |
| `E_NOT_FOUND`, `E_DENIED`, `E_APPROVAL_REQUIRED`, `E_STORAGE`, `E_INTERNAL` | As named. | The `message` and `reason` fields; then `logs/core.log` and `logs/audit.log`. |

The full list with the methods that raise each code is in `docs/rpc.md` ("Error codes").

### Common situations

- **Supervisor not running.** `daemon status` prints `supervisor: stopped`. Start it with `plur1bus daemon start`.
  If it keeps stopping, read `logs/supervisor.log` and `logs/supervisor.out.log`.
- **Core `crashed` or `degraded`.** `daemon status` gives the reason (for example `unresponsive`). Read
  `logs/core.log`, then `plur1bus daemon restart`.
- **Service not registered.** `1staid check` shows `service.registration` as `warn`. `plur1bus service install`
  (or the `1staid repair` step that renews it).
- **A configuration change did nothing.** Each key has a restart class (live, core, or one module);
  `plur1bus config set <key> <value> --dry-run` shows what would restart.
- **Stale files after a crash.** `1staid check` reports `run.stale-files`; `1staid repair` removes only files no
  live process still answers for.
