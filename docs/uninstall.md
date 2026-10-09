# Uninstall

`plur1bus uninstall` removes the installation and, by default, keeps your data. It builds a plan, shows it, asks, and
then does exactly what the plan said. The command reference is in [cli.md](cli.md).

```bash
plur1bus uninstall --dry-run      # show the plan, change nothing
plur1bus uninstall                # show the plan, ask, apply
plur1bus uninstall --yes          # apply without asking (scripts)
plur1bus uninstall --purge        # also remove the data, after a backup
```

## What is removed

| Item | What | Where |
|---|---|---|
| Daemon | the supervisor is asked to stop (`daemon.stop`), which stops the core too | the process for this home |
| Service | the registered unit: systemd user unit, launchd agent or Task Scheduler task | `plur1bus service status` shows the name and path |
| Binary | the `plur1bus` executable, plus `plur1bus.old-*` files an update left next to it | the running binary (`update` uses the same lookup) |
| `runtime/` | the pinned Node and the core payload (`core`, `core.prev`) | `<home>/runtime` |
| `update/` | update state and snapshots | `<home>/update` |
| `manifest.json` | the install manifest | `<home>/manifest.json` |
| `run/` | pid files, tokens, sockets, the supervisor lock | `<home>/run` |

A binary whose file name is not `plur1bus` (for example a development build under another name) is left alone and the
plan says so.

## What is kept

Everything else under the home: `config.json`, `agents/`, `skills/`, `modules/`, `extensions/`, `catalog/`, `models/`,
`state/` (stores, journal, SQLite databases), `data/`, `logs/` and `backups/`. `plur1bus setup` on the same home brings
the installation back with this data in place.

Secrets in the OS keyring or in a file store are not touched by a plain uninstall. `--purge` removes the home directory,
which includes a file-based secret store; entries in the OS keyring stay (remove them with `plur1bus secret rm`
beforehand if you want them gone).

## `--purge`

`--purge` removes the whole home, data included. It is refused when the directory is not recognisably a PLUR1BUS home (a
non-empty directory without `config.json`, `manifest.json`, `run/`, `state/`, `runtime/`, `agents/` or `logs/`), when it
is a symlink, when it is a filesystem root or a top-level directory, or when it contains your user home directory.

**Backup.** Before anything is removed, `--purge` writes a `plur1bus backup create` archive next to the home
(`plur1bus-backup-<UTC time>.tar.gz` in the home's parent directory, never inside the home). The path is printed when it
is done. Choose another place with `--backup-out <FILE>`; a path inside the home is refused.

- On a terminal, after the confirmation, you are asked whether to write the backup (default yes).
- With `--yes --purge` the backup is made. This is the default; `--no-backup` skips it explicitly.
- A backup needs a running core (`backup create` asks the core for a consistent snapshot). If it cannot be written, the
  uninstall stops **before changing anything** and says so; start the daemon and run it again, or pass `--no-backup`.

## `--dry-run`, confirmation and `--json`

`--dry-run` prints the same plan the real run would act on and changes nothing. The plan is computed from the current
state, so a dry run and a real run directly after it show the same plan.

Without `--yes` the command asks on a terminal. Off a terminal, or with `--json`, it refuses (exit 2, nothing applied)
and asks you to re-run with `--yes`.

`--json` prints one `uninstall/1` document:

```json
{
  "schema": "uninstall/1",
  "dryRun": false,
  "applied": true,
  "plan": {
    "home": "/home/u/.plur1bus", "os": "unix", "purge": false, "stopDaemon": true,
    "service": { "manager": "systemd", "name": "plur1bus", "path": "...", "registered": true },
    "remove": [ { "kind": "binary", "path": "/home/u/.local/bin/plur1bus" }, { "kind": "runtime", "path": "..." } ],
    "keep": [ "agents", "config.json", "logs" ],
    "notes": [], "nothingToRemove": false
  },
  "result": {
    "backup": null, "daemonStopped": true, "serviceRemoved": true,
    "removed": [ "..." ], "deferred": null, "failures": []
  }
}
```

`plan.backup` (`{ dir, file? }`) is present only with `--purge` unless `--no-backup`. `result` is `null` for a dry run
and for "nothing to remove". `kind` is `binary`, `runtime`, `update-state`, `manifest`, `run` or `home`.

## Order and failures

backup (purge only) -> stop the daemon -> remove the service unit -> remove files -> Windows deferred removal. A
failed backup, a daemon that does not stop, or a service-manager error abort the run before any file is removed. A file
that cannot be removed (a binary in a root-owned directory, say) is reported, the remaining items are still removed, and
the command exits 1 with `E_INTERNAL reason=remove-failed`; fix the cause and run it again.

## Running it again

A second run finds nothing to remove, prints `nothing to remove` and exits 0 (also without `--yes`).

## Platform notes

- **Linux (systemd user unit), macOS (launchd agent):** the binary is deleted while it runs; the file disappears when the
  process exits.
- **Windows:** a running `.exe` cannot be deleted, so the binary (and `.old-*` leftovers) is removed by a one-shot
  `plur1bus-uninstall-<pid>.cmd` in the temp directory. It waits for the uninstaller's process to exit, retries while
  Windows still holds the files, and deletes itself. The command output names the script and the paths it handles. If the
  binary lies inside the home and you `--purge`, the whole home is removed by that script. Paths with spaces are quoted
  and `%` is escaped. Task Scheduler cannot stop the core gracefully, so the daemon is stopped through the supervisor
  first, then the task is removed.
- **Container mode** (`PLUR1BUS_CONTAINER=1`): refused with `E_NOT_AVAILABLE reason=container-managed`, exit 1. The
  image, not the CLI, owns the installation.

## Exit codes

0 done, dry run, or nothing to remove. 1 refused in a container, a failed step, a removal that failed. 2 usage error: a
plan that cannot be made safely (`E_INVALID_PARAMS`, `reason` `unsafe-home`, `not-a-home`, `home-is-symlink`,
`backup-inside-home`) or no `--yes` where none can be asked.
