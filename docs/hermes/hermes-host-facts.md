# Hermes host facts for HM2 (captured on disposable instances)

HM2 Task 1 spike, 2026-09-29. It checks the Hermes behaviour that
`docs/superpowers/plans/2026-09-29-hm2-hermes-host-mode-adapter.md` lists
under "Not verified". Later tasks quote the **Use this** line of each section
and do not assume anything else about Hermes.

**Evidence labels.** *observed*: the command ran on a disposable instance on
this sandbox and the output is quoted (redacted). *from source*: read from the
pinned Hermes source, file and line given. *open*: needs a run on that OS
(listed at the end). *From source* line numbers are for **0.21.5** (`v2026.9.24`) unless
the line says `743ee72`; the cited code is the same in both unless noted.

**Redaction.** `<home>` is `$HOME`, `<hermes-home>` is a `HERMES_HOME` outside
`$HOME/.hermes`, `<install-dir>` is the Hermes checkout, `<tmp>` is the
scratch dir, `<session-id>` is a Hermes session id. Captured files are in
`hosts/hermes/tests/fixtures/hermes-cli/`. The provider used to capture them
is `docs/hermes/scratch/` (logs every hook and its arguments
to `$SCRATCH_LOG`, no network, `is_available()` is False while
`SCRATCH_UNAVAILABLE=1`; its provider name is its directory name).

## 0. Instances, versions, OS

| Label | Hermes | Code | How installed |
|---|---|---|---|
| **min** | `0.21.4` (build date `2026.9.21`) | `743ee72` (the checkout the spec read) | tag's own `scripts/install.sh --commit 743ee72… --force-commit` |
| **latest** | `0.21.5` (build date `2026.9.24`) | tag `v2026.9.24` (`f97608f`) | tag's own `scripts/install.sh --branch v2026.9.24` |

OS for every *observed* line: Linux x64, Ubuntu 24.04 container, running as
root, system Python 3.11.15, system Node 22.22.2, git 2.43.0.

**Tags are date-based, not semver.** There is **no tag `v0.21.4`** (the plan's
"Hermes `v0.21.4`"). Release tags are `vYYYY.M.D` (`v2026.9.21`,
`v2026.9.24`, …); the semver lives in `pyproject.toml` and in
`hermes --version`. `v2026.9.21` (`d337b73`) already reports `0.21.4`;
`743ee72` is a later commit on the same day, reachable from `v2026.9.24` but
not from `v2026.9.21` (observed, `git merge-base --is-ancestor`). Other tags
seen: `abandoned-rc.N-v0.21.5`.

**Use this:** pin Hermes by commit SHA or by the date tag; compare versions by
the semver parsed from `hermes --version` (§a), never by tag name. `min` =
`0.21.4`, `tested` = `0.21.5` (tag `v2026.9.24`) as of 2026-09-29.

## 1. Disposable install (Step 1)

Guard used for every command: `HERMES_HOME`, `HOME`, `XDG_*` all under the
scratch dir `$T`; the scripts refuse to run otherwise.

```sh
T=<tmp>; V=v2026.9.24
git show v2026.9.24:scripts/install.sh > install-$V.sh    # the tag's own installer
HOME=$T/fakehome XDG_CONFIG_HOME=$T/fakehome/.config XDG_DATA_HOME=$T/fakehome/.local/share \
HERMES_HOME=$T/home-$V bash install-$V.sh --branch $V --dir $T/hermes-$V --hermes-home $T/home-$V \
  --skip-setup --non-interactive --skip-browser --skip-computer-use --no-skills </dev/null
# min: same script from 743ee72 with: --branch main --commit 743ee72596e7a9f23bc7cd5c570a6ebd958043e4 --force-commit
```

Results (observed):

- **The live installer does not install a tag.**
  `https://hermes-agent.nousresearch.com/install.sh` (fetched 2026-09-29,
  868 lines, sha256 `9ed50b51fe072df4ece6dc9a72c1ec8d78bc7907eec16a61d8a2a0ef4ec45884`)
  is the new "pm" bootstrap of unreleased `main`. With `--branch v2026.9.24` it
  cloned, fetched uv 0.12.3 and CPython **3.14.7**, then failed:
  `No module named 'pm'` / `✗ pm install failed` (exit 1), because the tag has
  no `pm/` package. It also did not accept `--no-skills`.
- **The tag's own `scripts/install.sh` works** for both instances (exit 0,
  about 3 minutes each, about 1 GB checkout + venv per instance). Options it
  honours: `--skip-setup`, `--non-interactive`, `--skip-browser`,
  `--skip-computer-use`, `--no-skills`, `--dir`, `--hermes-home`, `--branch`,
  `--commit` (+ `--force-commit`).
- **It writes outside `HERMES_HOME`:** launchers
  `$HOME/.local/bin/{hermes,hermes-agent,hermes-acp}` (bash scripts that
  `exec <install-dir>/venv/bin/python <install-dir>/hermes "$@"`), a managed uv
  in `$HERMES_HOME/bin/uv`, uv caches in `$HOME/.cache/uv`, and it tries to
  edit a shell rc file ("Could not detect shell config file" with a fake
  `HOME`). The checkout defaults to `$HERMES_HOME/hermes-agent`, but **as root
  it defaults to `/usr/local/lib/hermes-agent`** (`scripts/install.sh:434-484`,
  from source), so `--dir` is mandatory on a root runner.
- It used the system Node (22.22.2 is in Hermes' accepted range) and did not
  install its own Node (§h).
- **A `--branch <tag>` install cannot `hermes update`:** the clone's only
  refspec is `+refs/tags/v2026.9.24:refs/tags/v2026.9.24`, and
  `hermes update --check` prints `✗ Branch 'main' not found on origin.`
  (exit 1). The `--commit` install tracks `origin/main` and updates.
- `pip install "git+https://github.com/NousResearch/hermes-agent@<ref>"` was
  not needed and was not tried.

**Use this:** a disposable Hermes is installed with **that ref's own**
`scripts/install.sh` (`git show <ref>:scripts/install.sh`), with `--dir` and
`--hermes-home` under the temp root, `HOME`/`XDG_*` also under the temp root,
`--skip-setup --non-interactive --skip-browser --skip-computer-use --no-skills`,
stdin `</dev/null`. Use `--commit <sha>` (not `--branch <tag>`) when the test
needs `hermes update`. Never use the live `install.sh` URL to pin a tagged
version.

## (a) `hermes --version`

Observed, both instances (`version-min.txt`, `version-latest.txt`):

```
$ hermes --version
Hermes Agent v0.21.4 (2026.9.21) · upstream 16c59d0e · local 743ee725 (+39948 carried commits)
Install directory: <install-dir>
Install method: git
Python: 3.11.15
OpenAI SDK: 2.24.0
[exit 0]
```

```
Hermes Agent v0.21.5 (2026.9.24)
Install directory: <install-dir>
…same four lines…
```

After `hermes update` moved the min instance to unreleased `main` (§g), the
first line became `Hermes Agent vgit.16c59d0 (2026.9.24) · upstream 16c59d0e`
(observed): **the token after `v` is not always semver.** `hermes version` is
not a command (`'version' is not a \`hermes\` command.`, exit 2).

**Use this:** read line 1 of `hermes --version` (exit 0) and match
`^Hermes Agent v(\d+)\.(\d+)\.(\d+) \((\d{4}\.\d+\.\d+)\)`; everything after
the closing parenthesis is optional. A first line that does not match (for
example `vgit.<sha>`) is "unknown version": treat it as untested, never as
below `min`.

## (b) `hermes config get memory.provider`

Observed, identical on both instances:

| State | Command | stdout | exit |
|---|---|---|---|
| unset (template config has no `memory.provider`) | `hermes config get memory.provider` | an empty line | 0 |
| unset | `… --json` | `""` | 0 |
| set to `scratch` | `hermes config get memory.provider` | `scratch` | 0 |
| set | `… --json` | `"scratch"` | 0 |
| key unknown to Hermes | `hermes config get memory.nosuchkey` | `Config key not set: memory.nosuchkey` | 1 |

`get` prints the **resolved** value: the default of `memory.provider` is `''`,
so "unset" and "set to empty" look the same. `--raw` exists (unmasks
credential-shaped values). Values `""`, `default`, `builtin`, `built-in`,
`none` all mean "built-in store, no external provider"
(`agent/memory_provider.py` `CORE_MEMORY_PROVIDER_SENTINELS`, from source).

**Use this:** `hermes config get memory.provider --json`, exit 0, parse the
JSON string; `""`/`default`/`builtin`/`built-in`/`none` = no external
provider. Fixtures: `config-get-provider-unset.txt`,
`config-get-provider-set.txt`.

## (c) `hermes config set memory.provider scratch`

Observed (`config-set-ok.txt`):

```
$ hermes config set memory.provider scratch
✓ Set memory.provider = scratch in <hermes-home>/config.yaml
[exit 0]
```

`hermes config unset memory.provider` prints
`✓ Unset memory.provider from <hermes-home>/config.yaml`, exit 0.

**Semantically only `memory.provider` changes** (YAML-parsed diff of
`config.yaml` before and after: one difference, `memory.provider` absent →
`scratch`, on both instances). **Textually the whole file is rewritten**, and
the two versions differ:

- **0.21.4:** every comment and every default-valued key is dropped: 2267 lines
  / 1990 comment lines before, **148 lines / 0 comments** after (the writer
  strips defaults: `hermes_cli/config.py` `save_config(strip_defaults=True)`,
  from source).
- **0.21.5:** comments survive; trailing whitespace on blank lines is removed and
  `key: null` becomes `key:` (a handful of lines).

**Use this:** change `memory.provider` only with `hermes config set` (exit 0 =
done) and restore the previous value with `hermes config set` or
`hermes config unset` if it was unset; record the previous value from §b
first. Verify with `hermes config get … --json`, never by diffing
`config.yaml`, and never back up/restore `config.yaml` as a file (the user's
comments may already be gone on 0.21.4, and a file restore would undo their
other edits).

## (d) `hermes memory status` with a user provider

Setup: `cp -r docs/hermes/scratch <hermes-home>/plugins/scratch`
(and a copy as `plugins/plur1bus` with `name: plur1bus`). Observed, identical
on both instances except that 0.21.4 also lists the bundled `hindsight`:

```
$ hermes memory status

Memory status
────────────────────────────────────────
  Built-in (MEMORY.md / USER.md):
    Memory injection:   enabled ✓
    User profile:       enabled ✓
    Memory tool:        enabled ✓
  Provider:  plur1bus

  Plugin:    installed ✓
  Status:    available ✓

  Installed plugins:
    • byterover  (API key / local)
    • hindsight  (API key / local)
    …
    • plur1bus  (no setup needed) ← active
    • scratch  (no setup needed)

[exit 0]
```

With `is_available()` False the block reads `Status:    not available ✗` plus
`Note: systemd/gateway services do not inherit ~/.hermes/.env —` (two lines),
**still exit 0** (`memory-status-unavailable.txt`). Without `memory.provider`
the line is `Provider:  (none — built-in only)` and user providers are listed
without `← active`. The hint in parentheses comes from `get_config_schema()`:
empty → `no setup needed` (`hermes_cli/memory_setup.py:148-176`, from source).
`memory status` imports the provider (`register(ctx)`) and calls
`is_available()` and `get_config_schema()` in-process (scratch log, observed);
an optional `get_status_config(cfg)` adds `  <name> config:` lines (from
source). A user provider directory needs `__init__.py` containing the text
`MemoryProvider` or `register_memory_provider` in its first 8 KiB; its name is
the **directory name** (`plugins/memory/__init__.py:64-110`, from source).

Hermes writes **`__pycache__/` into `$HERMES_HOME/plugins/<name>/`** the first
time it imports the provider (observed).

**Use this:** `hermes memory status` exit code says nothing; parse
`^  Provider:  (\S+)` and `^  Status:    (available|not available)`. Keep
`is_available()` and module import cheap and offline: every `memory status`
and every agent start calls them. Any manifest or byte check of the installed
provider directory ignores `__pycache__/`. Fixtures:
`memory-status-plur1bus.txt`, `memory-status-unavailable.txt`.

## (e) `hermes <provider> --help` only while active

Observed, identical on both instances:

| State | `hermes scratch --help` |
|---|---|
| no `plugins/scratch` | `hermes: 'scratch' is not a \`hermes\` command.` + `Run \`hermes --help\` to see all commands.`, exit 2 |
| installed, `memory.provider` unset | same, exit 2 |
| installed, `memory.provider=scratch` | the provider's argparse help, exit 0 |
| installed, another provider (`plur1bus`) active | exit 2 again |

Active output (`plur1bus-help.txt`, captured with the scratch files installed
as `plur1bus`):

```
$ hermes plur1bus --help
usage: hermes plur1bus [-h] {status,selftest} ...

Scratch provider for the HM2 spike: logs hook calls to $SCRATCH_LOG, no network.
…
[exit 0]
```

The description line is `plugin.yaml` `description`. **`hermes --help` never
lists the provider command** (plugin commands are discovered only when the
first positional word is not a built-in, `hermes_cli/main.py:2848-2856`, from
source). Hermes imports only `cli.py` for this (not `__init__.py`), calls
`register_cli(subparser)`, and dispatches to `<name>_command(args)` if
`cli.py` defines it, else to whatever `register_cli` put in
`set_defaults(func=…)` (`plugins/memory/__init__.py:490-532`,
`hermes_cli/main.py:3317-3327`, from source; the scratch `cli.py` uses
`set_defaults` and `hermes scratch status` ran it, observed).

**Use this:** `hermes plur1bus …` exists only after
`hermes config set memory.provider plur1bus`; an installer that probes it runs
it after that step and treats exit 2 + "is not a `hermes` command" as "not
active". `cli.py` defines `register_cli(subparser)` and
`plur1bus_command(args)`, imports nothing heavy, and must work without the
provider module loaded.

## (f) `initialize` kwargs and hook order

Command (observed, both instances; fixtures `init-kwargs-*.json`):
`hermes chat -q "scratch probe: say ok" -Q </dev/null` with the stub model of
§i. The one-shot answered `stub reply: ok` and `session_id: <session-id>`,
exit 0. **The kwargs and the hook order were identical on 0.21.4 and 0.21.5.**

| `HERMES_HOME` | `agent_identity` |
|---|---|
| `$HOME/.hermes` (unset or the default) | `default` |
| `$HOME/.hermes/profiles/work` | `work` |
| `<root>/profiles/work`, `<root>` outside `~/.hermes` with a `config.yaml` | `work` |
| **any dir outside `~/.hermes`** (e.g. `/srv/hermes`) | **`default`** |
| a dir under `~/.hermes` that is not a profile (e.g. `~/.hermes/custom-x`) | `custom` |

Kwargs for a CLI one-shot (all cases): `hermes_home` (the resolved
`HERMES_HOME`, equal to the env var), `platform: "cli"`,
`agent_context: "primary"`, `agent_identity` (table), `agent_workspace:
"hermes"`, `warning_callback`, `status_callback` (CLI only). **No `user_id`,
`chat_id`, `user_name` or `gateway_session_key` on the CLI.** From source
(`agent/agent_init.py`, `_memory_provider_init_kwargs`), a gateway adds any
non-empty of `user_id`, `user_id_alt`, `user_name`, `chat_id`, `chat_name`,
`chat_type`, `thread_id`, `gateway_session_key`, and optionally `cwd`,
`session_title`, `session_title_source`; `agent_context` is `cron` or
`subagent` when the platform is one of those. Gateway kwargs were not
captured (open).

Why "outside `~/.hermes`" is `default`: `get_active_profile_name()` returns
`default` when `HERMES_HOME` equals the Hermes root, and
`get_default_hermes_root()` makes any `HERMES_HOME` outside `~/.hermes` its own
root ("Docker/custom root"), or its grandparent when the parent dir is named
`profiles` (`hermes_cli/profiles.py:1941-1955`, `hermes_constants.py:217-234`
at 0.21.5; same code at `743ee72` `profiles.py:1768`, `hermes_constants.py:177-194`).

Hook order for one turn, then session end (one-shot; `thread` in brackets):

```
register [Main] > is_available [Main] > get_tool_schemas [Main] > initialize [Main]
> get_tool_schemas [Main] > system_prompt_block [Main] > on_turn_start [Main]
> prefetch [memory-prefetch-<name>] > sync_turn [mem-sync_0] > queue_prefetch [mem-sync_0]
> on_session_end [Main] > shutdown [Main]
```

`on_turn_start(turn_number=1, message=<user text>, author_id=None,
author_name=None, author_is_bot=False)`; `prefetch(query=<user text>,
session_id=<session-id>)`; `sync_turn(user_content, assistant_content,
session_id=<session-id>, messages=[user, assistant], turn_author=None)`;
`on_session_end(messages=[user, assistant])`. With `is_available()` False
the order is `register > is_available > unavailable_reason` and the turn still
answers (exit 0; `-Q` hides the warning). From source: Hermes itself runs
`prefetch` in a context-bound thread and waits at most **8.0 s**
(`agent/memory_manager.py:32,418-427` at `743ee72`, `:32,471-480` at 0.21.5), and runs `sync_turn` on a
one-worker executor (`mem-sync`).

**Use this:** the binding key is the **realpath of `hermes_home`**, not
`agent_identity`: two unrelated homes outside `~/.hermes` both report
`default`. Map `agent_identity` `default` → `hermes-default` **only when
`hermes_home` is the platform default root** (`~/.hermes`,
`%LOCALAPPDATA%\hermes`); a profile name `<p>` → `hermes-<fold(p)>` only when
`hermes_home` is `<default root>/profiles/<p>`; everything else (including
`default`/`<p>` under a non-default root, and `custom`) →
`hermes-custom-<first 8 hex of sha256(realpath(hermes_home))>`. Expect no
`user_id`/`chat_id` on the CLI (principal falls back to `local`). Keep
`prefetch` below Hermes' 8 s cap.

## (g) `hermes update` and `$HERMES_HOME/plugins/<name>/`

Observed, two runs:

1. **Real `hermes update --yes --no-backup --no-gateway-restart`** on the min
   instance (commit install) with `memory.provider=plur1bus`,
   `plugins/{scratch,plur1bus}` (no `python_dependencies`) and a profile
   `profiles/work/plugins/scratch`. It switched the detached checkout to
   `main`, moved it to `16c59d0` (unreleased), handed off to the new "pm"
   updater ("Installing Python dependencies ✓"), then **failed** fetching
   ffmpeg from `github.com/BtbN/FFmpeg-Builds/releases/...`:
   `CERTIFICATE_VERIFY_FAILED … CA cert does not include key usage extension`
   (the sandbox TLS proxy CA vs. pm's Python 3.14 strict verification; not a
   Hermes bug), exit 1. All three plugin dirs were **byte-identical** before and
   after (sha256 over contents, names, modes and mtimes, `__pycache__/`
   excluded).
2. **The update's plugin steps driven offline** on the latest instance
   (0.21.5): `hermes_cli.update_cmd_deps._refresh_active_memory_provider_dependencies()`
   (printed `→ Refreshing active memory provider dependencies (plur1bus)...`)
   and `_reapply_plugin_python_dependencies()` (printed nothing) with
   `memory.provider=plur1bus`, dirs in the root and in `profiles/work`: all
   **byte-identical** afterwards.

From source (0.21.4 = 0.21.5 for these parts): `reapply_all` only considers
user plugins that declare dependencies (`pyproject.toml` or
`python_dependencies`/`pip_dependencies`) **and** are listed in
`plugins.enabled`; its only side effect on a conflict is `plugins.disabled` in
`config.yaml`, never the directory (`743ee72`: `hermes_cli/plugin_python_deps.py:197-233,
421-444`, `update_cmd_deps.py:408-440`). The active memory provider's refresh
pip-installs its `pip_dependencies` only. **One path does write a provider
directory:** `memory_provider_migration.migrate_home()` (run by every update
and by `recover_at_startup()` at agent start when
`security.allow_lazy_installs` is on) installs the **catalog plugin of the
same name** when `memory.provider` names a provider that resolves nowhere.
Observed with `memory.provider=plur1bus` and no directory: `catalog_source`
= `None`, so it only warned
`⚠ Memory provider 'plur1bus' is configured but not installed and not in the plugin catalog.`
Unreleased `main` replaces this with `pm/` (`pm/plugin_eviction.py`: disables,
via config only, plugins that no longer fit; new manifest fields
`requires_hermes`, `manifest_version`).

**Use this:** a provider directory with **no** Python dependency declaration
survives `hermes update` untouched (HM2-R4 holds). Never leave
`memory.provider=plur1bus` set while `plugins/plur1bus/` is missing (install:
directory first, then `config set`; uninstall: restore `memory.provider`
first, then remove the directory), because a future catalog entry named
`plur1bus` would be auto-installed into that path.

## (h) Hermes' own Node

| OS | Path | Version | Evidence |
|---|---|---|---|
| Linux, macOS | `<root>/node/bin/node` (`<root>` = default Hermes root, not a profile) | major **26** (`NODE_VERSION="26"`), installed **only** when no acceptable Node is on `PATH` (accepted: 22.22+, 24.11+, 26+) | `scripts/install.sh:61,1045-1066` at `743ee72` (`NODE_VERSION="26"` also at 0.21.5), from source |
| Linux (this sandbox) | none: the installer printed `✓ Node.js v22.22.2 found` and used the system Node | 22.22.2 | observed |
| Windows | `%LOCALAPPDATA%\hermes\node\node.exe` (`$HermesHome\node\node.exe`), put first on the user `PATH` | major **22** (`$NodeVersion = "22"`, latest 22.x zip from nodejs.org) | `scripts/install.ps1:395,1846-1974` (same lines at `743ee72` and 0.21.5), from source |
| all (unreleased `main`) | `<root>/tools/node-26.7.0-<target>/` via `pm` | **26.7.0 on every target incl. `win32-x64`/`win32-arm64`** | `pm/lock.json`, `pm/environments.py:134`, from source |

Runtime code looks for Hermes' Node in `<home>/node/bin`, `<home>/node`,
`<home>/node_modules/.bin` (`743ee72`: `tools/browser_tool_install.py:43`,
`hermes_cli/doctor_live.py:58`, from source).

**Use this:** HM2-R16's "Hermes' own Node" step probes, in order,
`<root>/node/bin/node` (POSIX) or `<root>\node\node.exe` (Windows), then
`<root>/tools/node-*/…/node[.exe]` (future pm layout), and runs
`node --version`; it is optional (often absent on POSIX, Node 22 on Windows,
below `>=24.16`), so the chain must fall through to the pinned Node.

## (i) Minimal config for one turn against a local stub

Observed on both instances with a `config.yaml` containing **only**:

```yaml
model:
  provider: custom
  base_url: http://127.0.0.1:18931/v1
  default: stub-model
memory:
  provider: scratch
```

(no `.env`, no API key, fresh `HERMES_HOME`; Hermes created the rest of the
home on first run). The same three `model.*` values also work through
`hermes config set model.provider custom`, `… model.base_url …`,
`… model.default stub-model` on the template config. The stub must answer:

- `GET /v1/models` (and Hermes also probes `GET /api/v1/models` 4×, and
  `GET /v1/models/stub-model`; 404 is fine for the first),
- `POST /v1/chat/completions` with `stream: true` (SSE `data: {...}` chunks
  with `choices[0].delta.content`, a final chunk with `finish_reason:"stop"`,
  then `data: [DONE]`): the turn itself (24 tools on 0.21.5, 18 on `main`),
- `POST /v1/chat/completions` non-streaming, `tools` empty: the session-title
  call.

Hermes sends `Authorization: Bearer no-key-required` to a keyless loopback
endpoint (`hermes_cli/runtime_provider_custom.py:390-440`, from source); the
stub must not check it. 0.21.5 prints
`⚠ tirith security scanner enabled but not available …` on stderr; harmless.

**Use this:** the e2e harness writes exactly the YAML above (port varies) and
runs `hermes chat -q "<text>" -Q </dev/null`; success = exit 0 and stdout
contains the stub's fixed completion followed by a `session_id: ` line.

## (j) Windows and macOS

Not run: this spike cannot push a branch or dispatch a workflow, and the
owner's Windows VM is not reachable from the sandbox. From source (0.21.4 and
0.21.5, `scripts/install.ps1`):

- Home: `%LOCALAPPDATA%\hermes` (`HERMES_HOME` wins); checkout
  `%LOCALAPPDATA%\hermes\hermes-agent`; venv `…\hermes-agent\venv`;
  managed uv and **the launchers in `%LOCALAPPDATA%\hermes\bin`**:
  `hermes.exe` (a copy of `venv\Scripts\hermes.exe`) for a normal venv, or
  `hermes.cmd` (`@echo off` + `"<venv>\Scripts\hermes.exe" %*`) for a
  relocatable venv, plus `hermes-acp.exe|.cmd`; that `bin` dir is added to the
  user `PATH` (`install.ps1:33-34, 3263-3330` at 0.21.5; `Install-HermesCommandLaunchers` at `743ee72:3247`). Git may be a private copy in
  `%LOCALAPPDATA%\hermes\git`. Node: §h.
- macOS: same `install.sh` as Linux; home `~/.hermes`, launcher
  `~/.local/bin/hermes`.
- (a)–(f) and (h) on `windows-2025` and `macos-15`: **open**, no run URL.

**Use this:** on Windows resolve the launcher as `hermes.exe`, then
`hermes.cmd`, first on `PATH`, then in `%LOCALAPPDATA%\hermes\bin\` (or
`$HERMES_HOME\bin\`); spawn a `.cmd` through `cmd.exe /d /s /c`. Treat every
Windows/macOS output format as unverified until Task 6's CI legs capture it.

## (k) Bindings registry lock (shared by installer and provider)

`<plur1bus home>/hosts/hermes-bindings.json` is read-modify-written by two programs: the Node installer
(`binding.mjs` `withRegistryLock`) and the Python provider (`hermes plur1bus bind`, `register_binding`). Node has no
`flock`, so **both** take the same lock **file** `<plur1bus home>/hosts/.hermes-bindings.lock` by existence, not by
byte-range lock (an flock is invisible to an O_EXCL file and the reverse):

- **Create** with `O_CREAT | O_EXCL` (mode 0600; no `fcntl`, so it also works on Windows), write `<pid> <hostname> <ms> <nonce>` (nonce = 128-bit hex, new per hold) and close the fd before the critical section. On Windows a `PermissionError` on create (name pending deletion) is retried like `EEXIST` within the deadline.
- **Stale** = mtime older than **60 s**, or a pid of this host that is dead and the lock at least 1 s old. Dead = POSIX `kill(pid, 0)` -> `ESRCH`; Windows `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION)` fails with `ERROR_INVALID_PARAMETER`, or `GetExitCodeProcess` != `STILL_ACTIVE` (259); `ERROR_ACCESS_DENIED` or any other doubt = alive. This is equivalent, not identical, to libuv's `process.kill(pid, 0)` on the Node side: where they differ (libuv's wider `OpenProcess` access rights, pid 0, an exit code of 259) one side judges the pid alive, so a difference only delays a break to the 60 s rule, never breaks a live lock; a pid above 2^31-1 is never dead (Node rejects it). **Break**: rename it to `<lock>.break-<own nonce>`, re-read the moved file and compare dev/inode and content with what was judged stale; equal -> unlink and retry O_EXCL; different (another process broke it first and a fresh lock took its place) -> put it back with `link` (never overwrites; `EEXIST` = only drop the break file). Never unlink the lock path directly. A break that did not remove the stale file (rename failed, or put back) sleeps one poll like any busy round; it does not spin past the deadline.
- **Release**: rename to `<lock>.rel-<own nonce>`, unlink only when the content holds our nonce, otherwise put it back as above (a stolen lock is never deleted). On Windows the rename fails while another process holds the file open without `FILE_SHARE_DELETE` (CPython's `open`): retry it on `EPERM`/`EACCES`/`EBUSY` (winerror 5, 32, 33) with backoff 10 ms doubling to 100 ms, for at most 2 s, then leave the lock to the stale rules. Only `ENOENT` means gone; then, if a `<lock>.break-*` or `<lock>.rel-*` file holds our nonce (a waiter moved the live lock aside and is putting it back), wait for the put-back (poll 5 ms, same 2 s budget) and release it; the put-back links before it unlinks, so once no moved file holds the nonce one more read of the lock decides.
- **Verify before writing**: right before writing the registry the holder re-reads the lock and checks its nonce; if it is gone (`LockLost` in Python) it writes nothing; a pending put-back (as in Release) is waited out first. This closes the window where a holder stalls past 60 s and another process legitimately takes over.
- Leftover `*.break-*` / `*.rel-*` files older than 60 s are removed on the next acquire. Wait at most **10 s**, then fail (`LockTimeout` in Python).

Python: `plur1bus._filelock.ExclusiveLockFile`. `FileLock` (flock / `msvcrt.locking`) stays for the capture journal only.
A lock file left by the old flock-based code ages out after 60 s.

## Open items

| Item | Why open | Who closes it |
|---|---|---|
| (a)–(f), (h) on `windows-2025` and `macos-15`; the Windows launcher actually installed (`.exe` vs `.cmd`) and `%LOCALAPPDATA%\hermes` layout on disk | no workflow dispatch, Windows VM unreachable | Task 6 `hermes-host.yml` first run, or an owner run on the Windows VM |
| Gateway `initialize` kwargs (`user_id`, `chat_id`, `gateway_session_key`) | needs a messaging platform; only the source list above | Task 6 or later, with a fake platform |
| A complete `hermes update` including the pm plugin step on `main` | blocked by the sandbox TLS proxy (ffmpeg download) | Task 6 CI (real network) |
| Hermes-managed Node actually installed on Linux/macOS | system Node was in range; the stage-only probe could not hide it | Task 6 CI on a runner without Node 22.22+/24.11+/26 |

## Findings that change the plan's assumptions

1. **No `v0.21.4` tag**; tags are `vYYYY.M.D` and `hermes --version` can print
   `vgit.<sha>` (§0, §a).
2. **`agent_identity` is `default`, not `custom`, for any `HERMES_HOME` outside
   `~/.hermes`**; `custom` only appears under `~/.hermes`. HM2-R8's
   "`custom` for every non-standard `HERMES_HOME`" is wrong; key agents on
   `realpath(hermes_home)` as in §f's rule, or two homes collide on
   `hermes-default`.
3. **0.21.4 `hermes config set` deletes every comment and default-valued key
   in `config.yaml`** (§c).
4. **Unreleased `main` moves Hermes to a pm-managed CPython 3.14.7**
   (`requires-python = ">=3.11,<3.15"`) and Node 26.7.0 on all OSes, Windows
   included (§h). The provider and the vendored client run inside Hermes'
   interpreter, so the plan's "Python ≥ 3.11, < 3.14" has to include 3.14
   once that ships; F11 (Node 22 on Windows) stops holding then.
5. `hermes memory status` and `hermes <provider>` exit codes carry no status
   (§d, §e); Hermes writes `__pycache__/` into the provider directory (§d).
