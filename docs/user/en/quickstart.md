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
- `--accept-nc-licence` accepts the non-commercial licence of the default models (asked for unless the use class
  is `commercial`).
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

This build has no `chat` command. What you can do is put facts into an agent's memory and recall them, from any
later session:

```sh
plur1bus memory add --agent main "The staging database is called orion."
plur1bus memory recall --agent main "which database is staging?"
```

`memory add` and `memory recall` are the stable commands (ADR-016). An unknown agent answers `E_AGENT_UNKNOWN`.
More on the memory commands: `plur1bus memory --help` (list, show, forget, correct, share, state, propose,
proposals).

## 5. Backup and restore

This build has no `backup` command. Everything the installation owns is under its home directory, so a backup is a
copy of that directory taken while nothing runs:

```sh
plur1bus daemon stop
# copy the whole home directory with your file tool of choice (see operations.md#directories)
plur1bus daemon start
```

To restore, stop the daemon, put the copy back in place of the home directory and start it again; then run
`plur1bus 1staid check`. Two limits to know: `run/` holds sockets, tokens and pid files that are recreated on start, so never copy a home
into a running installation; and a copy is only as consistent as the moment you stopped the daemon.

One thing that is automatic: when `config.json` is damaged, `plur1bus 1staid repair` restores it from the running
configuration or from the newest valid `config.json.bak-*` beside it.

## 6. Update

This build can check for an update but not apply one:

```sh
plur1bus update --check
```

`update --check` compares the installation with the release manifest of its channel (`stable` or `beta`, see
`--channel`), prints which units would change and which would restart, and changes nothing. Without `--check`,
`plur1bus update` prints that applying a release arrives in M8 and exits with code 2. To move to a newer version
today, install the newer binary and run `plur1bus setup` again; steps whose result is current are skipped.

## Next

[operations.md](operations.md): directories, logs, service management per operating system and troubleshooting.
