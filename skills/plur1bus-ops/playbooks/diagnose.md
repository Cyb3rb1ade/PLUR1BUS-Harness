# Diagnose

Read-only. Nothing in this playbook writes, starts, stops or signals anything (S12); it is always safe to run, whether or not a supervisor is running in this home.

## 1. Run the check

```sh
plur1bus 1staid check --json
```

The result is `{"schema":"1staid.check/1","ok":<bool>,"checks":[{"id","status","summary","hint"?,"detail"?}, ...]}`, one entry per id below, in this fixed order. `status` is `ok`, `warn`, `fail` or `skip` (skipped because an earlier check, usually a reachable core, is a precondition). `ok` is `true` only when every check is `ok` or `skip`.

| id | What it checks | A `warn`/`fail` means | Next step |
|---|---|---|---|
| `config.valid` | `config.json` parses and validates against the schema (or does not exist yet, which is `ok`: the defaults run) | The file is present but invalid JSON or fails the schema | `1staid repair` step `config.restore`, or restore from a known-good backup yourself first |
| `run.permissions` | `run/`'s permissions (unix mode, Windows ACL) match what the supervisor expects | Another process or a hand edit loosened them | `1staid repair` step `run.permissions.fix` |
| `run.stale-files` | Every file under `run/` (pid, socket, token) names a live peer | A crashed process left a file behind with no one to answer for it | `1staid repair` step `run.stale-files.remove` (never removes a file with a live peer behind it, even one a check found stale-looking) |
| `supervisor.state` | Whether the supervisor answers `supervisor.auth` | It is not running | `plur1bus daemon start` (the check's own `hint`), or `daemon status` first if you expected it to be up |
| `core.state` | Whether the supervised core is `ready` | Not running, or `degraded`/`crashed` — see `daemon status` for the reason and `CrashReason` in `SKILL.md` | `daemon restart`, or `module restart`-equivalent for the core is `daemon restart` (the core has no separate restart command) |
| `models.warm` | The embedding/reranker models are loaded and ready | They are still loading, or failed to load (network, disk) | Wait and re-check; if it never clears, check `models.cache` and network access |
| `memory.shared` | The core's shared-memory support (fast recall path) is usable | It fell back to the RPC-only path | Rarely actionable directly; note it and move on unless recall latency is the actual complaint |
| `core.lock` | The engine's on-disk lock is held by this installation's own core, not a stray process | Held by an unexpected process, or a stale lock with no live holder | `1staid repair` step `unit.terminate-hung` if a hung process holds it (Review Focus 3: never removed while a live endpoint answers) |
| `modules.state` | Every installed module either runs or is cleanly disabled | A module that should run is not, or is stuck starting | `module restart <name>`; `module list --json` for detail |
| `service.registration` | The OS service (systemd/launchd/Task Scheduler unit) for this home is registered as expected | Missing or misconfigured | `1staid repair` step `service.renew`, or the check's own `hint` (`service install`) |
| `agents.activity` | Registered agents have recent activity where expected | An agent has gone quiet | Usually informational; correlate with `jobs.last-runs` |
| `journal.backlog` | The core's write-ahead journal is not piling up unreplayed entries | Replay is stuck or falling behind | `daemon restart`; if it recurs, treat as a `core.state` problem |
| `jobs.last-runs` | Scheduled jobs (dreams, etc.) ran recently and succeeded | A job is failing or has not run | `plur1bus dreams status`/`dreams log` for detail |
| `api.deprecations` | Whether this installation calls a deprecated RPC method | A caller (a module, a script) still uses something on its way out | Not urgent; plan the caller's update before the `removeAfter` date in the detail |
| `windows.pipe-acl` | (Windows only; `skip` elsewhere) the named-pipe ACL matches the harness's contract | It does not | `1staid repair` step `run.permissions.fix` covers the Windows ACL path too |
| `runtime.node` | The installed Node runtime's hash matches what `setup`/`update` expects | Corrupted or hand-modified | `1staid repair` step `runtime.node.reinstall` |
| `runtime.core` | The installed core payload's hash matches what `setup`/`update` expects | Corrupted or hand-modified | `1staid repair` step `runtime.core.reinstall` |
| `models.cache` | The embedding/reranker model files are present in the local cache | Missing (first run downloads them at warm-up) | Usually informational; only actionable if you expect them already cached and network is unavailable |
| `extensions.integrity` | Every file of an installed extension (from a package) still matches the digest recorded at install | A payload file was edited, deleted or replaced (detail lists `<name>: <path>`) | Reinstall the package (`plur1bus ext install <file>`); report only, `1staid repair` changes nothing here |
| `extensions.consistency` | Extension records, their code directories and the skills index agree | `fail`: a record whose skill/module directory is missing; `warn`: an index entry that names a package but has no record | Reinstall the package, or drop the stray index entry |
| `extensions.revoked` | No installed extension is on the revocation list | An installed extension was revoked (detail gives the reason); it is held back and cannot be enabled | `plur1bus ext remove <name>`; look for a fixed version |

## 2. Cross-check with process status and logs

```sh
plur1bus daemon status --json
plur1bus module list --json
plur1bus module graph --json
plur1bus service status --json
```

`daemon status --json`'s `supervisor` and `children` carry each process's `state` (`starting`, `ready`, `degraded`, `orphaned`, `stopping`, `stopped`, `crashed`) and, for `degraded`/`crashed`, a `reason` — see `SKILL.md`'s degraded-reason and `CrashReason` sections. `module graph --json` shows the dependency order and any unresolved edge or cycle, which explains a module stuck in `modules.state`.

For anything a `--json` field does not explain, read the logs directly: `logs/<role>.log` (the process's own structured log) and `logs/<role>.out.log` (its captured stdout/stderr) under this home's `logs/` directory. Never quote a secret value found in a log back into a report; redact it.

## 3. Check for a pending release (read-only)

```sh
plur1bus update --check --manifest <path> --json
```

Compares the installed manifest with a release manifest (a local path, an `https://` URL, or the
channel's signed feed by default) and prints what would change and which units would restart.
Nothing is downloaded or applied; applying an update is a separate, later step outside this skill's
scope.

## 4. Decide

- Every check `ok`/`skip` and every process `ready`/`stopped`-as-expected: nothing to do.
- One or more `warn`/`fail`: move to `playbooks/repair.md`, starting with `1staid repair --dry-run --json`.
- A configuration value looks wrong but every check passes: move to `playbooks/configure.md`.
