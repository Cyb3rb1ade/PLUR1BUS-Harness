# Undoing an import (import rollback)

When you import memory cards and skills from an external source (such as Hermes), Plur1bus records a detailed import report. The rollback feature lets you undo an import cleanly. The German version of this page is [../de/import-rollback.md](../de/import-rollback.md).

> **Availability notice:** Import rollback uses `memory.unimport` and is available starting with Plur1bus Engine 1.15.

## How to ("So geht's")

### Web UI

1. Open **Settings → Import & History** (`#/settings`).
2. Select the past import run from the history table.
3. Choose **Rollback Preview**: The modal calculates which imported cards and skills will be archived, and identifies any cards edited by users that will be kept.
4. Choose **Apply Rollback** and confirm the operation.

### CLI

1. Inspect source details and prior import status:

```sh
plur1bus import hermes --detect
```

2. Run a dry-run rollback (default preview mode, modifies nothing):

```sh
plur1bus import hermes --rollback <REPORT>
```

3. Apply the rollback:

```sh
plur1bus import hermes --rollback <REPORT> --apply
```

## Good to know ("Gut zu wissen")

- **Archiving instead of deletion:** The memory engine invokes `memory.unimport`. Imported cards are archived rather than permanently purged or marked with tombstones.
- **User-edited cards remain:** If you or an agent updated, corrected, or annotated an imported memory card after the initial import run, that card is recognized as user-modified. The rollback preserves all user-edited cards intact.
- **Source system is never modified:** The source system (such as your Hermes state directory) is strictly read-only during both import and rollback.
- **Re-import is always possible:** Undoing an import does not lock or corrupt the store. You can re-run an import at any time with adjusted mappings or conflict resolution options.

## Error messages ("Fehlermeldungen")

- `E_REPORT_NOT_FOUND`: The specified import report file does not exist or cannot be read.
- `E_ENGINE_FEATURE_UNAVAILABLE`: Rollback was requested on an engine version prior to 1.15. Update your Plur1bus Engine to version 1.15 or newer.
- `E_CONFLICT`: A conflicting unimport operation or concurrent write is active.

## Next

- Routine operations and maintenance: [operations.md](operations.md)
- Desktop bundles and data migration: [desktop.md](desktop.md)
- Quickstart guide: [quickstart.md](quickstart.md)
