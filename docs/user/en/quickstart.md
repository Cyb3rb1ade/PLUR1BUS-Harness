# Quickstart

This page takes you from nothing to a running installation with one agent and one remembered fact. Every command
below exists in this build (`docs/cli.md` is the full reference); where this build has no command for something,
the page says so. Add `--json` to any command for machine-readable output. The companion page is
[operations.md](operations.md); the German version of this page is [../de/quickstart.md](../de/quickstart.md).

## 1. Install

You need a `plur1bus` binary for your platform (a release download, or `cargo build --release -p plur1bus`, which
writes `target/release/plur1bus`). Check that it runs:

```sh
plur1bus --version
```

The binary holds the command line and the supervisor. The Node runtime and the core are installed by `setup` in
the next step.

## 2. First start: `setup`

```sh
plur1bus setup
```

`setup` runs nine fixed steps: state root, Node runtime, core, bundled modules, config, skills, OS service, start
and a first `1staid check`. It downloads the pinned Node runtime and the core and verifies their SHA-256 hashes.
It asks only the basic questions (the first agent's id, default `main`, and the embedding use class). It is safe to
run again: a step whose result is already installed is skipped.

Useful options:

```sh
plur1bus setup --non-interactive --agent main --use-class general --accept-nc-licence
plur1bus setup --no-service
plur1bus setup --profile host
```

- `--non-interactive` never prompts; answers come from the flags and defaults (agent `main`, use class `general`).
- `--accept-nc-licence` accepts a non-commercial model licence. It is only needed when you opt into a CC BY-NC model
  such as Jina; the default embedding model (EmbeddingGemma 2, Apache-2.0) needs no licence decision.
- `--no-service` skips the OS service; the supervisor is still started for this session.
- `--profile host` installs only the supervisor and core (for Hermes host mode); `full` is the default.

Where the installation lives: `~/.plur1bus` on Linux and macOS, `%LOCALAPPDATA%\PLUR1BUS` on Windows. Override it
with `--home <path>` on any command or with the `PLUR1BUS_HOME` environment variable. See
[operations.md](operations.md#directories).

Check that everything is up:

```sh
plur1bus daemon status
plur1bus 1staid check
```

`daemon status` prints the supervisor's and core's state; `1staid check` is read-only and reports each check as
`ok`, `warn`, `fail` or `skip`. On the very first start the model cache check may warn ("downloads at first
warm-up"): the embedding models are fetched when the core first needs them.

## 3. Create an agent

`setup` already registered the first agent. To add another:

```sh
plur1bus agent create notes
plur1bus agent list
plur1bus agent status notes
```

An agent id matches `^[a-z0-9][a-z0-9_-]{0,63}$`. Creating an id that exists fails with `E_INVALID_PARAMS`
(reason `agent-exists`). `plur1bus agent remove <id>` removes an agent from the registry; its data is kept.

## 4. First conversation

`plur1bus chat` (experimental) talks to an agent: one message as an argument, or line by line on stdin until EOF.
`--agent <id>` picks the agent (default: the only registered one), `--session <id>` continues a session, `--no-memory`
starts incognito so nothing of the chat is remembered:

```sh
plur1bus chat --agent main "Which database is staging?"
```

You can also put facts into an agent's memory and recall them, from any later session:

```sh
plur1bus memory add --agent main "The staging database is called orion."
plur1bus memory recall --agent main "which database is staging?"
```

`memory add` and `memory recall` are the stable commands (ADR-016). An unknown agent answers `E_AGENT_UNKNOWN`.
More on the memory commands: `plur1bus memory --help` (list, show, forget, correct, share, state, propose,
proposals).

## 5. Backup and restore

`plur1bus backup` (experimental) writes a consistent, checksummed archive of the installation. `create` needs a
running core; the archive never contains secrets (API keys stay in the OS keyring, `run/` is never archived) and is
neither signed nor encrypted:

```sh
plur1bus backup create --dry-run          # list what would be archived, write nothing
plur1bus backup create                    # default: <home>/backups/plur1bus-backup-<UTC>.tar.gz
plur1bus backup verify <archive>          # manifest and every SHA-256; exits 1 for an archive a restore would refuse
```

SQLite databases under `state/` are copied with SQLite's online backup API while the core keeps running: the copy is
consistent, includes what is still in the write-ahead log, passes an integrity check before it is archived, and is one
self-contained file. `-wal`, `-shm` and `-journal` files are never part of an archive. A fresh home works the same as an
old one; nothing needs to be stopped or checkpointed first.

To restore, stop the daemon, then run `plur1bus backup restore <archive>` (`--dry-run` prints the plan; a script needs
`--yes`). It verifies first, swaps each unit in by rename and keeps whatever it replaced in
`<home>/backups/pre-restore-<id>/`; a failure puts the old state back. A leftover `-wal`/`-shm` beside a replaced
database goes aside with it, so it can never be replayed onto the restored file. Afterwards start the daemon and run
`plur1bus 1staid check`. `--out <file>` chooses the archive path; an existing file is never overwritten.

One thing that is automatic: when `config.json` is damaged, `plur1bus 1staid repair` restores it from the running
configuration or from the newest valid `config.json.bak-*` beside it.

## 6. Update

`plur1bus update` (experimental) applies a signed release with a snapshot, a health gate and automatic rollback:

```sh
plur1bus update --check      # compare with the release manifest and print the plan; changes nothing
plur1bus update              # apply (asks first on a terminal; a script needs --yes)
plur1bus update status       # phase and outcome of the last update, and whether a rollback is possible
plur1bus update --rollback   # go back to the snapshot of the last applied update
```

`--channel` (`stable` or `beta`) selects the release channel and `--manifest <path|url>` a manifest other than the
channel's signed feed. An update stops the daemon, snapshots the binary, `config.json`, the install manifest and the
core payload (never the memory store), swaps, starts, and gates on `--version`, a ready core and `1staid check`; any
failure restores the snapshot. A release that changes the Node runtime or the module set is refused: run
`plur1bus setup` instead.

## Next

[operations.md](operations.md): directories, logs, service management per operating system and troubleshooting.
