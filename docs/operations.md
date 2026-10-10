# Operations

How to diagnose, configure and repair a PLUR1BUS Harness installation. This is the human-readable
version of the `plur1bus-ops` skill (`skills/plur1bus-ops/`); the skill and its playbooks cover the
same ground for an agent to follow directly.

Every command below accepts `--json`; use it when scripting or filing a report, and read its
`schema` field rather than parsing the human text.

## The escalation ladder

Work through these in order. Do not skip a rung, and do not move on unless its stated condition is
met:

1. **`plur1bus 1staid check --json`** — read-only; safe to run any time. Move on if any check comes
   back `warn` or `fail`.
2. **`plur1bus 1staid repair --dry-run --json`** — plans repair steps for whatever failed, without
   changing anything. Move on once the plan looks right for what the check found.
3. **`plur1bus 1staid repair --json`** (or `--yes` once the plan is exactly the one you intend) —
   applies the plan. Move on if a step fails, or the check still fails afterwards.
4. **`plur1bus module restart <name> --json`** — restart one module on its own. Move on if the
   module is still unhealthy, or more than one module is affected.
5. **`plur1bus daemon restart --json`** — restart the whole supervised process tree in this home.
   Move on if the problem persists right after a clean restart.
6. **`plur1bus service status --json`** — check the operating-system service registration for
   anything the steps above cannot see.
7. **Ask the person who owns this installation.** Anything a plan calls high risk, anything
   `1staid repair` skips for an unfamiliar reason, or two passes through this list that do not fix
   the problem.

## Never

- Edit files under `state/` directly; only the running core or a repair step should ever touch them.
- Hand-edit `config.json` while the supervisor is running — use `config set` instead, which
  validates, writes safely and tells the supervisor about the change.
- Force-kill a supervised process outside of a deliberate test; use `module stop`/`restart` or
  `daemon stop`/`restart`, which shut down cleanly.
- Print a secret value from a config or a check's detail.
- Restart anything or write a configuration change without explaining what and why first, and
  without reading the restart plan a `--dry-run` shows you.

## Diagnose

```sh
plur1bus 1staid check --json
plur1bus daemon status --json
plur1bus module list --json
plur1bus module graph --json
plur1bus service status --json
```

`1staid check` runs eighteen read-only checks covering the configuration file, file permissions and
stale files, the supervisor and core process state, model readiness, shared-memory support, the
engine's on-disk lock, installed modules, the operating-system service registration, agent
activity, the write-ahead journal, scheduled-job history, deprecated API usage, the Windows named-
pipe ACL (Windows only), and the installed Node runtime, core payload and model cache. Each result
is `ok`, `warn`, `fail` or `skip`, with a short summary and, where useful, a hint at the command to
run next.

`daemon status` reports the supervisor's own state and every process it supervises: `starting`,
`ready`, `degraded`, `orphaned`, `stopping`, `stopped` or `crashed`, each with a reason when it is
not simply `ready`. A `degraded` reason is most often `unresponsive` (the process is up but not
answering) or `core-unavailable` (nothing could reach the core at all). A `crashed` process carries
one of a fixed set of reasons: lock held by someone else, an invalid configuration, an engine
contract mismatch, a startup that never became ready, an adopted process later found to have
exited, an invalid module manifest, an unsupported module API version, having given up after
repeated failures, or none more specific than the exit itself.

For anything the structured output does not explain, read the log files directly: each process's
own log, its captured console output, and the append-only audit log described below.

## Configure

Every configuration key belongs to one of three restart classes: applies immediately with nothing
restarting, restarts the core process, or restarts one named module. Always check a key's class
before changing it.

```sh
plur1bus config get <key> --json
plur1bus config schema --tier <tier> --json
plur1bus config set <key> <value> --dry-run --json
plur1bus config set <key> <value> --yes --json
```

Read the current value and its restart class first. Dry-run every change before applying it — the
dry run validates the value and shows exactly what would restart, without writing anything. Apply
only after you have read that plan; outside an interactive terminal, `--yes` is required and should
only be used for a change you have already dry-run. The write itself is atomic: a rejected value
changes nothing on disk.

## Repair

```sh
plur1bus 1staid repair --dry-run --json
plur1bus 1staid repair --json
plur1bus 1staid repair --yes --json
plur1bus 1staid repair --only <step-id> --yes --json
```

`1staid repair` turns a failing check into a plan of concrete steps, each with a risk level (none,
low, medium or high) and its own confirmation. The low-risk steps fix file permissions, remove
genuinely stale run files (never one a live process still answers for), and re-register a missing
operating-system service. The medium-risk steps restore a broken configuration file from the
running configuration or the newest valid backup, and reinstall a corrupted Node runtime or core
payload. The high-risk steps terminate a hung process (only through the specific process a live
connection identifies, never a process ID file alone) and migrate an out-of-date on-disk store
schema. Two more steps only ever report what they found — a supervisor that exited cleanly when it
should not have, or a process restarting in a tight loop — and never change anything.

Limit a plan to specific steps with `--only`, repeatable, when you want to apply some of a plan and
leave the rest for later or for the owner. After applying, `1staid repair` re-runs the checks itself
and reports whether they are now clean. Every step it actually applies is written to the audit log.

Stop and ask the installation's owner instead of applying a step when: the step is high risk and you
cannot already explain why the underlying check failed; a step is skipped for a reason you do not
recognize; the same check still fails after an apply and a re-check; or two full passes through the
escalation ladder above do not fix the problem.

## Logs

- One log file per process, holding its own structured records.
- One captured-output file per process, holding whatever it printed to its own stdout and stderr.
- One append-only audit log, private to the user running the installation, with one line per
  privileged action taken by this document's commands or the operations skill — what was changed,
  by what action, and when. Read it to see what happened; never edit it.

## The error codes

Every command that talks to the running installation answers a failure with one of a fixed set of
codes: unauthorized, wrong RPC version, not available, core unavailable, invalid parameters, unknown
agent, invalid configuration, unknown module, internal error, locked, not found, denied, approval
required, conflict, or storage error. A `--json` failure always carries the code under `error` and a
`schema` of `"error/1"`. "Not available" with the reason "container-managed" means a container
manages this installation's lifecycle — that is expected, not something to repair.

## Project board WIP refusal

`E_PROJECT_WIP_LIMIT` is a workflow limit, not a damaged store. The rejected
create, move, unarchive or column-transfer mutation commits no changes. Move or
archive another active card to free capacity, choose another target column, or
have a human project lead deliberately request `overrideWip`. Agents cannot
bypass the limit. See [Project board backend](projects-board.md).
