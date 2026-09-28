# Repair

`1staid repair` turns a failing `1staid check` into a confirmed, auditable plan. Always dry-run first; always read the plan before applying it; never apply a step whose risk or reason you do not understand.

```sh
plur1bus 1staid repair --dry-run --json
```

`{"schema":"1staid.repair/1", "steps":[{"id","action","target","reason","risk","needsConfirmation","status","detail"?}, ...]}`. `risk` is `none`, `low`, `medium` or `high`. Nothing is written in `--dry-run`.

## The steps, in the order they are planned and applied

| id | Trigger (the `1staid check` id) | What it does | Risk |
|---|---|---|---|
| `run.permissions.fix` | `run.permissions` | Fixes `run/`'s permissions (unix `chmod`, Windows ACL) back to the harness's contract | low |
| `run.stale-files.remove` | `run.stale-files` | Removes only the files with no live peer behind them, re-checked immediately before each removal — never a file a live endpoint (socket, token, pid) still answers for (Review Focus 3) | low |
| `config.restore` | `config.valid` | Backs up the broken file to `config.json.rejected-<ms>`, then writes the supervisor's own running config back over it (or, offline, restores the newest `config.json.bak-*` that validates) | medium |
| `service.renew` | `service.registration` | Re-registers the OS service unit; in a container-managed installation this is `skipped` with reason `container-managed` (`E_NOT_AVAILABLE`), which is expected, not a failure | low |
| `runtime.node.reinstall` | `runtime.node` | Reinstalls the pinned Node runtime from the mirror, verified against its hash | medium |
| `runtime.core.reinstall` | `runtime.core` | Reinstalls the core payload from the release source; with no source configured it is `skipped` with reason `core-source-missing` | medium |
| `unit.terminate-hung` | a lock or state file held by a process whose socket accepts but does not answer `*.status` within 2 s, and no supervisor answers | Terminates it through its pinned peer (the peer pid taken from the live connection, never the pid file alone — never a foreign process that merely happens to share that pid) and removes its run files | high |
| `store.migrate` | `core.status.engine.storeSchema.current != required` | Runs `admin.migrate` over the core to bring the on-disk store schema up to what this core version requires | high |
| `service.silent-exit` | a `supervisor.log` record showing the supervisor exited 0 where it should have exited non-zero (ADR-012 §10.7) | Reports the evidence; changes nothing | none |
| `service.restart-loop` | repeated `supervisor started` records inside a short window | Reports the evidence (how many restarts, over what window); changes nothing | none |

`run.permissions.fix`, `run.stale-files.remove` and `service.renew` are confirmed together as one plan (a single prompt lists all of them); `config.restore`, `runtime.node.reinstall`, `runtime.core.reinstall`, `unit.terminate-hung` and `store.migrate` each ask their own, separate confirmation because each is a bigger or riskier change on its own. The `report`-only steps (`service.silent-exit`, `service.restart-loop`) never prompt — there is nothing to confirm, since they write nothing.

## Apply

```sh
plur1bus 1staid repair --json
```

Without `--yes`, `1staid repair` asks before each step (or each group) exactly as above; refuses outside a terminal with exit 2. Use `--yes` only once the dry-run plan is the one you intend to apply exactly:

```sh
plur1bus 1staid repair --yes --json
```

Limit the plan to specific steps (for example, to apply only the low-risk ones and leave a `high`-risk step for the owner) with `--only`, repeatable:

```sh
plur1bus 1staid repair --only <step-id> --yes --json
```

After applying, `1staid repair` re-runs `1staid check` itself (`checkAfter`) and reports it in the result; exit 0 means no step `failed` and `checkAfter.fail == 0`. Every applied step (not `skipped` or `declined`) writes one `logs/audit.log` line (`action: "repair.<step id>"`).

## When to stop and ask the owner instead of applying

- A step's `risk` is `high` (`unit.terminate-hung`, `store.migrate`) and you cannot already explain, from `playbooks/diagnose.md`, exactly why the check failed.
- A step comes back `skipped` for a reason not listed above.
- The plan does not shrink after a `--yes` apply and a re-check (the same check still fails).
- Two clean passes through the escalation ladder in `SKILL.md` (repair, then restart, then service check) do not converge.
