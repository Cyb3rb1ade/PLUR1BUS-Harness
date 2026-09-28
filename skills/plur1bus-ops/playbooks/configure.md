# Configure

Every `config.json` key carries an `x-restart` class (ADR-013): `"live"` (applies immediately, nothing restarts), `"core"` (the core process restarts), or `"module:<name>"` (that module restarts). Always look at the restart class before applying a change, and say what you are about to do and why before running the write.

## 1. Read before you write

```sh
plur1bus config get <key> --json
plur1bus config schema --tier <tier> --json
```

`config get <key> --json` prints the current `value` plus `restart`/`restartClass` for that key (`restart` is a human label, `restartClass` the raw `x-restart` value). `config get --json` with no key prints the whole document. `config schema --tier <tier> --json` (`--tier basic|advanced|all`) prints the JSON Schema filtered to that tier (D29) — read it when you are not sure a key exists or what shape its value takes.

## 2. Dry-run every write

```sh
plur1bus config set <key> <value> --dry-run --json
```

This validates the new value and prints the restart plan (`{"schema":"config.set/1", ..., "restartPlan": {...}}` — the units that would restart) without writing anything. Read the restart plan before doing anything else: a `"core"` restart interrupts every in-flight `memory recall`/`memory add` on this installation; a `"module:<name>"` restart interrupts only that module.

## 3. Apply, with the restart plan already known

```sh
plur1bus config set <key> <value> --yes --json
```

Interactively (a terminal, no `--yes`) `config set` asks for confirmation itself, showing the same restart plan; `--yes` is only for a script or CI, and only after you have already looked at the `--dry-run` output for this exact change. The write is atomic (temp file, `fsync`, rename) and re-validated against the schema before it lands — a rejected write changes nothing (B18).

## Never

- Hand-edit `config.json` while a supervisor runs in this home. The supervisor polls the file and owns writes to it; a concurrent hand edit races the supervisor's own atomic write and can be silently overwritten, or rejected the same way an invalid file would be (`1staid check`'s `config.valid`).
- Apply a `--yes` write you have not already dry-run in this session. The dry run is what tells you whether the core or a module is about to restart.
- Print or forward a secret value. Neither `config get` nor `config schema` ever emits one; if a future key ever needs to, treat its value the way `logs/audit.log` treats action detail — never echoed back verbatim in a report.

## After the write

Re-run `1staid check --json` for the checks the change could plausibly affect (most commonly `config.valid`, and `core.state`/`modules.state` if a restart happened), and check `logs/audit.log` for the line the write should have added — see `SKILL.md`'s "Logs" section.
