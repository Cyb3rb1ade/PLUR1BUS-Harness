---
name: plur1bus-ops
description: Diagnose, configure and repair a PLUR1BUS installation — `1staid check`/`1staid repair`, `config get|set`, logs and the audit trail. Use when a PLUR1BUS supervisor, core or module looks unhealthy, a config change needs to go out safely, or an installation needs repair.
category: plur1bus.admin
useWhen: Diagnose an unhealthy PLUR1BUS supervisor, core or module, apply a configuration change safely or repair an installation.
---

# plur1bus-ops

Operations skill for a PLUR1BUS Harness installation (spec §9, D4, D66). Three playbooks:

- `playbooks/diagnose.md` — read `1staid check`, `daemon status` and the logs; decide what, if anything, is wrong.
- `playbooks/configure.md` — change `config.json` safely, knowing which keys restart what.
- `playbooks/repair.md` — the repair ladder, from `1staid repair --dry-run` up to asking the owner.

Read `diagnose.md` first on any report of trouble. Only move to `configure.md` or `repair.md` once the diagnosis names a specific check or unit.

## The escalation ladder

Never skip a rung, and never apply a rung whose criterion is not met:

1. **`plur1bus 1staid check --json`** — read-only, safe to run any time, on a running or a stopped installation. Criterion to move on: any check is `warn` or `fail`.
2. **`plur1bus 1staid repair --dry-run --json`** — plans repair steps for the failing checks and changes nothing. Criterion to move on: the plan is non-empty and its steps look right for what `1staid check` found.
3. **`plur1bus 1staid repair --json`** (interactive: confirms each step; `--yes` only when nothing in the plan is a surprise) — applies the plan. Criterion to move on: `1staid repair` reports a step `failed`, `declined` when it should not have been, or leaves `checkAfter.fail > 0`.
4. **`plur1bus module restart <name> --json`** — restart one module without touching the core or the other modules. Criterion to move on: the module named by the failing check is still unhealthy after a restart, or more than one module is affected.
5. **`plur1bus daemon restart --json`** — restart the whole supervised tree (core and every module) in this home. Criterion to move on: the problem is still there right after a clean restart, or it needs an OS-level look (a service that will not start, a socket a firewall is blocking).
6. **`plur1bus service status --json`** — read the OS service registration (systemd/launchd/Task Scheduler) for anything a restart inside the harness cannot see. Criterion to move on: the service itself is missing, disabled or looping, and nothing above already reported that.
7. **Ask the owner.** Anything a `--dry-run` plan calls `high` risk, anything `1staid repair` reports `skipped` for a reason you do not recognize, or two passes through this ladder that do not converge.

Every command in this skill supports `--json`; use it and read the `schema` field, not the human text, when scripting or reporting back.

## Never

- Touch `state/` directly. It holds the engine's own store; only the core (through RPC) or `1staid repair`'s `store.migrate` step ever write it.
- Edit `config.json` by hand while a supervisor is running. Use `plur1bus config set` (it validates, writes atomically and tells the supervisor); a hand edit races the supervisor's own writer and can be silently overwritten or rejected (B18).
- `kill -9` a supervised process outside of an explicit soak test. Use `plur1bus module stop|restart` or `plur1bus daemon stop|restart`, which shut down cleanly and update state; a `SIGKILL` can leave `run/` files stale for `1staid repair` to clean up later.
- Print a secret value. `config get`/`config schema` never emit them, and no playbook here does either; if a check's `detail` ever surfaces one, redact it before sharing the output.
- Restart or write anything without saying so first. Every step in `repair.md` and every write in `configure.md` is announced (`what`, `why`, the `x-restart` class if it applies) before the command runs, and `1staid repair` itself will not apply a step without confirmation unless `--yes` was given deliberately.

## Configuration and `x-restart`

Every `config.json` key carries an `x-restart` class (ADR-013): `"live"` applies without restarting anything, `"core"` needs the core restarted, `"module:<name>"` needs that module restarted. `plur1bus config set <key> <value> --dry-run --json` prints the restart plan (which units would restart) before you commit to it; run the same command without `--dry-run` (or with `--yes` outside a terminal) only after you have read that plan.

```sh
plur1bus config get <key> --json
plur1bus config set <key> <value> --dry-run --json
plur1bus config set <key> <value> --yes --json
plur1bus config schema --tier <tier> --json
```

## Logs

- `logs/<role>.log` — one process's own JSON-lines log (`supervisor.log`, `core.log`, `module-<name>.log`).
- `logs/<role>.out.log` — that process's captured stdout/stderr (`core.out.log`, `module-<name>.out.log`).
- `logs/audit.log` — one JSON line per privileged action this skill or the CLI took (`{ at, actor, action, target, detail }`), append-only, private to the user (HB12, ADR-006, D66). Every repair step and every `config set` a person or this skill applies lands here; read it to see what changed and when, never to guess — it is the record.

## The error enum

Every RPC-backed command answers a failure as one of a closed set of codes (`ErrorCode`, RPC schema): `E_UNAUTHORIZED`, `E_RPC_VERSION`, `E_NOT_AVAILABLE`, `E_CORE_UNAVAILABLE`, `E_INVALID_PARAMS`, `E_AGENT_UNKNOWN`, `E_AGENT_EXISTS` (name collision), `E_AGENT_RIGHTS` (invalid or excessive delegation), `E_AGENT_SECRETS_MISSING` (required secret names in `ids`, never values), `E_CONFIG_INVALID`, `E_MODULE_UNKNOWN`, `E_INTERNAL`, `E_LOCKED`, `E_NOT_FOUND`, `E_DENIED`, `E_APPROVAL_REQUIRED`, `E_CONFLICT`, `E_STORAGE`, and for media search `E_MEDIA_CAPABILITY`, `E_MEDIA_LICENSE`, `E_MEDIA_PRIVACY`, `E_MEDIA_UNAVAILABLE`, `E_MEDIA_DIMENSION`, `E_MEDIA_UNSUPPORTED_KIND` (a configuration or availability problem of the media index, see docs/media-search.md; not a crash), `E_INBOX_CURSOR` (a malformed `inbox list --cursor`; list again without it). `E_INVITE_INVALID` (an invitation link cannot be redeemed: unknown, expired, revoked, already used or malformed, and the answer deliberately never says which; not a fault. Ask the inviting admin to create a fresh link with `user.invite.create`, see docs/invites.md), A `--json` failure document is `{"schema":"error/1","error":"<code>",...}`; the human text on stderr/stdout names the same code. `E_NOT_AVAILABLE reason=container-managed` means the step or command is refused because a container manages this installation's lifecycle — that is expected, not a fault, and needs no repair.

## Voice and project refusals

These codes are refusals, not faults. Each one exits 1 and says what to change; retrying without a change only repeats the refusal.

- `E_VOICE_BUDGET`: the voice feature budgets together exceed `voice.v3.budgetMs`. `detail` and `ids.feature` name the first switch that overflows, in the stable feature order; `ids.totalMs` and `ids.budgetMs` give the sums. Nothing is saved. *Repair:* read the current switches with `plur1bus voice features --help` and the budget with `plur1bus voice status --json`, then lower that switch's `maxMs`, set its mode to `off`, or raise `voice.v3.budgetMs`, and retry.
- `E_VOICE_LICENSE`: `voice.models.install` needs `licenseAccepted: true` for a model whose licence is research-only, non-commercial or not yet confirmed. Nothing is downloaded. *Repair:* show the owner the licence name and URL from `plur1bus voice models list --json`. Only if the owner explicitly accepts it, retry with `plur1bus voice models install <model-id> --license-accepted`. Never add that flag on your own initiative.
- `E_VOICE_LICENCE`: `voice.language.set` (the language choice in the UI) needs the exact `modelId@licenceId` of every gated model it would select, listed in `acceptLicences`. Nothing is downloaded until all of them are accepted. *Repair:* the same rule as `E_VOICE_LICENSE`. Show the owner each key and its licence, and only with their explicit yes retry with `plur1bus voice profile set --language <de|en> --profile <fast|quality> --accept-licence <modelId@licenceId>`, one `--accept-licence` per model.
- `E_VOICE_UNAVAILABLE`: a verified model package, the realtime provider, a capacity limit or a trusted audio transport is missing. Raw provider errors are withheld on purpose. `reason` says which; `no-audio-transport` means the host has not attached an audio transport. *Repair:* check `plur1bus voice status --json` (`available`), attach the host's audio transport, or retry later. Do not switch to a research-only voice to get around it.
- `E_PROJECT_WIP_LIMIT`: a board change would exceed a column's work-in-progress limit, and the whole change is refused. *Repair:* archive or move another card first, or let a human project lead decide an `overrideWip`. An agent never overrides the limit.

Why there are two licence codes: `E_VOICE_LICENSE` gates one model install with a single boolean, `licenseAccepted`. `E_VOICE_LICENCE` gates a language choice, which can select several models at once (speech-to-text, text-to-speech and voice activity detection), so the person has to name each model's exact licence as `modelId@licenceId`. Two RPC methods with two acceptance shapes, hence two codes. The spelling differs too, and the repository records no deliberate reason for that. Merging the codes would change the RPC contract, so both stay. Neither code is a licence to accept terms silently, and neither is a reason to pick a different voice without the owner.

## The `CrashReason` vocabulary

`ChildStatus.process.reason` (a crashed child) and `ChildStatus.lastExit.reason` take one of: `lock-held`, `config-invalid`, `engine-contract`, `ready-timeout`, `adopted-exit`, `manifest-invalid`, `api-version-unsupported`, `gave-up`, `none`. `manifest-invalid` and `api-version-unsupported` only ever appear for a module. `gave-up` means the child exited five times inside the give-up window and will not restart on its own — see `playbooks/repair.md`'s `service.restart-loop` report and, once the underlying cause is fixed, `plur1bus daemon restart` or `plur1bus module restart <name>` to re-arm it. `degraded` states (`daemon status`, `memory recall`/`memory add`) carry a free-text `reason`, most commonly `unresponsive` (the process is up but not answering in time) or `core-unavailable` (the client could not reach the core at all).

```sh
plur1bus daemon status --json
```


Agent creation/import (Owner/Admin people only): `agent create <id> --config <settings.json>` uses the core RPC; `agent validate <payload.json>` is a dry-run reporting identity/model/rights errors; `agent import <export.json> --on-conflict rename` verifies checksums and any Ed25519 signature before writes. All accept `--json`. Required secrets must already exist on the target. Import discards unknown person rights and reports `discardedRights`; the caller receives manage. The existing name-only offline create remains a bootstrap path; settings/validate/import require the current core. See docs/agents.md.
