# Undoing an import (import rollback)

Every import run that you apply with `--apply` records a report and a snapshot of the state before it. Rollback uses them to put Plur1bus back to that state. The German version of this page is [../de/import-rollback.md](../de/import-rollback.md).

> **Availability:** rolling back what the import wrote to your installation (skills, files, configuration) works today. Undoing the imported **memory cards** is available from Engine 1.15. Until then a rollback reports them as `not-reverted (engine has no undo)` and leaves the memory store as it is.

## How to

There is no web UI for this. Use the CLI.

1. Inspect the source and what an import would find. This changes nothing:

```sh
plur1bus import hermes --detect
```

2. Preview the rollback of a run. Pass the `report.json` of the run, which lies in the `imports` folder of your Plur1bus home under the run id. Without `--apply` nothing is written.

```sh
plur1bus import hermes --rollback <REPORT>
```

3. Apply the rollback. Stop the core first; a rollback refuses to run while the core is running.

```sh
plur1bus import hermes --rollback <REPORT> --apply
```

The same works for the other import source: run `plur1bus import --help` to see the source names.

## Good to know

- **Preview first:** the rollback is a dry run unless you add `--apply`. The report lists what would be removed, restored or kept.
- **Your changes are kept:** a file that the import created and that you changed afterwards is not deleted. It is backed up, left in place and reported as `kept-modified`. The option `--force` deletes such files after the backup.
- **Memory cards:** see the availability note above. A rollback never deletes or changes memory cards today.
- **Fail closed:** a damaged or missing ledger, or a snapshot that does not match its report, stops the rollback instead of reporting success with imported files left behind.
- **The source is never modified:** your source directory (for example the Hermes directory) is only read, during the import and during the rollback.
- **Run it once:** a run that was already rolled back is refused. You can import again at any time with other options.

## Error messages

The importer reports its own error codes; the `reason` says what is wrong.

- `E_ROLLBACK_INVALID` with reason `report-unreadable`, `report-missing` or `report-outside-home`: the report file cannot be read, does not exist, or is not the `report.json` of its run folder. Pass the file from the run's folder.
- `E_ROLLBACK_INVALID` with reason `not-an-apply-report`: the run was only a preview, so there is nothing to undo. `already-rolled-back`: the run was undone before. `source-mismatch`: the report belongs to a different source than the one in your command.
- `E_ROLLBACK_INVALID` with reason `snapshot-missing`, `snapshot-corrupt`, `snapshot-invalid`, `ledger-corrupt` or `unsafe-symlink`: the saved state cannot be trusted, so nothing is restored.
- `E_ROLLBACK_STALE` with reason `skills-changed-since`: your skills changed after that run. Roll back the later runs first.
- Reason `target-running` (the importer's own error): the core is running. Stop it with `plur1bus daemon stop` and try again.

## Next

- Routine operations and maintenance: [operations.md](operations.md)
- Desktop bundles and data migration: [desktop.md](desktop.md)
- Quickstart guide: [quickstart.md](quickstart.md)
