# Quickstart

From nothing to a running installation with one agent, a first memory, a backup and an update check. German: [`../de/quickstart.md`](../de/quickstart.md). Day-to-day running, logs, services and troubleshooting: [`operations.md`](operations.md).

Every command in this page exists in the CLI reference ([`docs/cli.md`](../../cli.md)); `node scripts/check-docs-commands.mjs` (part of `pnpm docs:check`) fails when one does not. Paths are written relative to the **home**, the state root, as `<home>/...`:

| OS | Default home |
|---|---|
| Linux, macOS | `~/.plur1bus` |
| Windows | `%LOCALAPPDATA%\PLUR1BUS` |

`--home <PATH>` on any command, or the environment variable `PLUR1BUS_HOME` (an empty value counts as unset), selects another home. Every command also accepts `--json`.

## What works today, and what does not

| Works | Not yet (the CLI says so) |
|---|---|
| Install, supervisor and core, OS service, health checks, repair | A real chat model: `chat` answers `E_NOT_AVAILABLE` with reason `no-provider` until provider adapters are wired in (labelled M2 in the code and in `docs/cli.md`) |
| Agents, memory capture and recall, session store, dreams schedule | `login`, `channel`, `project`, `uninstall`: stubs that name their milestone (M2, M4, M3, M8) and exit 2 |
| Backup, verify, restore; signed update with rollback | |

## 1. Requirements

- Linux x64 or arm64, macOS on Apple silicon (arm64), Windows x64 or arm64. macOS on Intel is not built (`crates/plur1bus/src/install/targets.rs`).
- No administrator rights: the installer writes only inside your user profile, and the OS service is a user service.
- Disk and network on first memory use: the embedding and reranker models are downloaded into `<home>/models` (about 600 MB, `docs/container.md`). Until they are loaded, `1staid check` reports `models.cache` or `models.warm` as `warn`.

## 2. Install

There are two ways. Take the first when a release is published for your platform, the second to run the code in this repository.

### 2a. Installer (release)

The installer downloads the release feed, verifies the binary's SHA-256 before running anything, installs the binary and then runs `plur1bus setup` with the flags you pass.

Linux and macOS (`<release host>` is the host that serves `install.sh`; the feed is read from `PLUR1BUS_INSTALL_FEED`, default `https://updates.plur1bus.app/{channel}.json`, and the channel from `PLUR1BUS_CHANNEL`, default `stable`):

```sh
curl -fsSL <release host>/install.sh | sh -s -- --non-interactive --accept-nc-licence
```

Windows PowerShell 5.1 or 7 (a form that is safe whichever way the host serves the script):

```powershell
$s = (Invoke-WebRequest -UseBasicParsing <release host>/install.ps1).Content; if ($s -is [byte[]]) { $s = [Text.Encoding]::UTF8.GetString($s) }; & ([scriptblock]::Create($s.TrimStart([char]0xFEFF))) --non-interactive --accept-nc-licence
```

Without `--non-interactive` the installer's `setup` asks two questions: the name of your first agent (default `main`) and how you will use PLUR1BUS (`general`, `research` or `commercial`, default `general`). Unless the use class is `commercial` it also asks you to accept the non-commercial licence of the default models; with `--non-interactive` that needs `--accept-nc-licence`.

The binary lands in `~/.local/bin/plur1bus` (Linux, macOS) or `%LOCALAPPDATA%\PLUR1BUS\bin\plur1bus.exe` (Windows). The shell installer prints a reminder when that directory is not on your `PATH`; the PowerShell installer does not change `PATH`, so add the directory yourself or call the binary by its full path. A hash mismatch, an unknown platform or a feed without your platform stops the installer with exit 1 and nothing installed.

`setup` runs nine steps in a fixed order and prints one line each, `done`, `skipped` or `failed`. The first failure stops the run and the rest are `skipped (after-failure)`:

| Step | What it does |
|---|---|
| `state-root` | creates the home |
| `runtime.node` | installs the pinned Node runtime (24.21.0) under `<home>/runtime/` after a SHA-256 check |
| `runtime.core` | installs the core payload, same check |
| `modules.bundled` | installs the bundled modules |
| `config` | writes `config.json`, asking only the two basic questions |
| `skills` | copies the bundled skills into `<home>/skills/` |
| `service` | registers the OS service (left out with `--no-service`) |
| `start` | starts the supervisor and the core |
| `check` | runs `plur1bus 1staid check` |

`setup` is safe to repeat: a step whose result is already installed is `skipped (already-installed)`. It ends with a summary line `1staid check: <n> ok, <n> warn, <n> fail` and exits 1 if a step failed or a check failed. Other flags: `--no-service`, `--channel <CHANNEL>`, `--use-class <CLASS>`, `--agent <ID>`, `--profile <PROFILE>` (`host` is for Hermes host mode, `docs/hermes-host-mode.md`) and `--core-from <DIR|TAR.GZ>` to install the core from a local directory or archive instead of the release payload.

```sh
plur1bus --version
plur1bus setup --help
```

### 2b. From source (this repository)

Needs Node 24.16 or later (or 26.1 or later), pnpm 10, and Rust 1.95 (pinned by `rust-toolchain.toml`). This path was run for this page on macOS arm64; Linux and Windows were not exercised.

```sh
pnpm install --frozen-lockfile
pnpm prep
cargo build -p plur1bus
```

`pnpm prep` builds `packages/core/dist/core.js`. Without `setup` there is no installed core, so tell the supervisor where it is, then start it in a home of your choice:

```sh
export PLUR1BUS_CORE_JS=$PWD/packages/core/dist/core.js
export PLUR1BUS_NODE=$(command -v node)
target/debug/plur1bus --home /tmp/plur1bus-try daemon start
```

`PLUR1BUS_NODE` must name the real `node` executable, not a wrapper script. A source build has no install manifest, so `update` refuses (`no install manifest here: run plur1bus setup first`). `setup` itself also takes `--core-from <DIR|TAR.GZ>` for a core you built (not exercised for this page). The examples below say `plur1bus` for the binary; from source read `target/debug/plur1bus --home /tmp/plur1bus-try` instead.

## 3. First start

After `setup` the supervisor is already running. Check:

```sh
plur1bus daemon status
```

```
supervisor: ready
core (core): ready
service: not registered (launchd)
shared memory: verified-path
```

That output is from a source build without `setup`, hence `not registered`; after `setup` the `service:` line names the registered service. If the supervisor is stopped, `plur1bus daemon start` starts it, or the OS service when one is registered; `daemon start --no-wait` returns as soon as the supervisor answers, without waiting for the core. `plur1bus daemon stop` and `plur1bus daemon restart` do what they say.

Then the read-only health check:

```sh
plur1bus 1staid check
```

One line per check: `ok`, `warn`, `fail` or `skip` (skipped because the core is not reachable). Right after the first start `models.cache` and `models.warm` may be `warn` while the models download. Anything `fail` has a repair path, see [`operations.md`](operations.md#troubleshooting).

## 4. Create an agent

`setup` creates the first agent (`main` unless you chose another name). More:

```sh
plur1bus agent create <id>
plur1bus agent list
plur1bus agent status <id>
```

`agent create` answers `created agent <id> (open in the running core)`. `agent remove <id>` removes the agent from the registry and keeps its data. An agent's workspace is `<home>/agents/<id>/workspace`.

## 5. First chat, and what to do until a model is wired in

```sh
plur1bus chat --agent main "Hello"
```

With the code as it is today this prints

```
no chat provider is configured for this core (real providers arrive with M2); for development start the core with PLUR1BUS_ALLOW_TEST_INTERNALS=1 PLUR1BUS_TEST_CHAT_PROVIDER=fake
plur1bus: E_NOT_AVAILABLE: no chat provider is configured; configure one or use a core started with the test provider (no-provider)
```

and exits 2. That is the expected state, not a fault of your installation. The `fake` provider named in the message is a development seam (it echoes your text); it is refused unless `PLUR1BUS_ALLOW_TEST_INTERNALS=1` is also set, and is not meant for real use. `chat` without a message reads lines from stdin until EOF; `--session <SESSION>` continues a session and `--no-memory` starts one that remembers nothing. `plur1bus session list`, `plur1bus session show <ID>` and `plur1bus session archive <ID>` work on stored sessions.

What does work now is memory, which a chat will later use:

```sh
plur1bus memory add --agent main "I prefer tea over coffee"
plur1bus memory recall --agent main "what do I drink"
```

`memory add` prints `stored <n> / skipped <n>`. The very first call loads the models and can take a while; `memory add` waits up to `core.capture.waitMs` (60 000 ms by default). If the core cannot be reached at all, the text is written to a journal under `<home>/state/journal` and the command says `journaled (the core replays it at start)`; `memory recall` then answers `degraded` and still exits 0, so read its text.

## 6. Backup and restore

```sh
plur1bus backup create
plur1bus backup verify <FILE>
```

`backup create` needs the core running and writes `<home>/backups/plur1bus-backup-<UTC>.tar.gz` (or `--out <OUT>`; an existing file is never overwritten). The archive holds the memory store (staged consistently by the core), the SQLite databases under `<home>/state/`, the configuration, agents, skills, modules, extensions, catalog, the capture journal and the system-job ledger. It never holds secrets (API keys stay in the OS keyring; `<home>/run/` is never archived). It is checksummed, not signed and not encrypted: keep it as private as the home itself. `backup create --dry-run` lists what would go in without touching anything.

`backup verify` checks the manifest and every entry against its SHA-256 and exits 1 with a reason (`archive-corrupt`, `truncated`, `manifest-invalid`, `unsupported-format`, `unexpected-entry`, `checksum-mismatch` or `missing-entry`) for an archive a restore would refuse.

To restore, stop the core, look at the plan, then apply:

```sh
plur1bus daemon stop
plur1bus backup restore --dry-run <FILE>
plur1bus backup restore --yes <FILE>
plur1bus daemon start
```

Restore verifies first, extracts into `<home>/.restore-<id>/` and swaps each unit in by rename. What it replaces is kept in `<home>/backups/pre-restore-<id>/`; a failure puts the old state back. On a terminal it asks before applying; in a script or with `--json` it needs `--yes`. To restore into a different home, pass `--home <PATH>` to the same commands.

## 7. Update

```sh
plur1bus update --check
plur1bus update
plur1bus update status
plur1bus update --rollback
```

`update --check` compares your installation with the release manifest of your channel (or `--manifest <PATH|URL>`) and prints the plan; it changes nothing. `update` applies it: it stops the daemon, snapshots the binary, `config.json`, the install manifest and the core payload (never the memory store), swaps, starts, and gates on `--version`, a ready core and `1staid check`; any failure restores the snapshot. `update status` shows where the last update stands; `update --rollback` goes back to the snapshot of the last applied update. A release that changes the Node runtime or the module set is refused: run `plur1bus setup` instead. A crashed update is settled by the next `update` or `daemon start`. Outside a terminal `update` needs `--yes`.

## 8. Remove

`uninstall` is a stub (planned, M8). By hand, in this order: `plur1bus service uninstall`, then `plur1bus daemon stop`, then delete the binary and, only if you want to lose your memory, the home. Take a backup first.

## Next

[`operations.md`](operations.md): directories, logs, service management per operating system, and troubleshooting with the real error codes.
