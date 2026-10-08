# Upgrade and rollback runbook

`plur1bus update` is experimental. It applies a signed release, takes an update snapshot, and
automatically rolls back if the health gate fails. This runbook uses only the behavior documented
by the CLI and the existing user guide.

## Before the update

The update snapshot is deliberately limited: it contains the binary, `config.json`, the install
manifest, and the core payload. It does **not** contain the memory store. Make a separate backup
first if you need to be able to restore installation data as well as the update snapshot.

1. Check the current installation and core:

   ```sh
   plur1bus daemon status
   plur1bus 1staid check
   ```

   `1staid check` is read-only.
2. Preview and create a full installation backup while the core is running:

   ```sh
   plur1bus backup create --dry-run
   plur1bus backup create --out /safe/location/plur1bus-before-update.tar.gz
   plur1bus backup verify /safe/location/plur1bus-before-update.tar.gz
   ```

   Choose a path that does not already exist; an existing output file is never overwritten.
   The archive includes the memory store and SQLite databases, but excludes secrets and `run/`
   tokens. It is neither signed nor encrypted, so store it accordingly.
3. Review the proposed update. This only prints the plan and changes nothing:

   ```sh
   plur1bus update --check
   ```

   The default is the installed channel's signed release feed. `--channel stable|beta` selects a
   channel, and `--manifest <path|url>` selects another manifest.

## Apply and verify

On a terminal, apply the update and confirm when prompted:

```sh
plur1bus update
```

For a non-interactive invocation, pass `--yes` to apply without asking:

```sh
plur1bus update --yes
```

The updater stops the daemon, snapshots the binary, `config.json`, install manifest, and core
payload, swaps the release in, starts it, and checks the version, core readiness, and `1staid
check`. Afterward, inspect the update result and installation health:

```sh
plur1bus update status
plur1bus daemon status
plur1bus 1staid check
```

`update status` is read-only; it reports the phase, outcome, and whether rollback is possible.

## If the update fails

- **Health-gate failure:** the updater restores its snapshot automatically. The memory store is
  outside that snapshot; the separate backup above is what preserves it.
- **The update process crashed or was interrupted:** the next `plur1bus update` or `plur1bus daemon
  start` settles the interrupted update. Check `plur1bus update status` afterward.
- **Rollback is still available and you want to return to the last update snapshot:** check status,
  then run:

  ```sh
  plur1bus update --rollback
  ```

  This returns the binary, config, install manifest, and core to the snapshot of the last applied
  update. It is not a restore of the separate full-installation backup.
- **The release changes the Node runtime or module set:** `update` refuses it; use
  `plur1bus setup` instead.

If you explicitly need to restore the separate full-installation archive, verify it first and use
`plur1bus backup restore <archive>` with the core stopped. Preview with `--dry-run`; a script or
`--json` invocation requires `--yes`. This is a broader restore than `update --rollback`.
