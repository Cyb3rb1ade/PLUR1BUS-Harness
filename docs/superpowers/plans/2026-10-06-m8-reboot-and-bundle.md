# M8 — `1staid bundle` and reboot survival (plan, 2026-10-06)

Milestone: `docs/milestones.md` §M8 (scope: services; acceptance 3 "survival of a reboot verified per OS"; effort
note "+1–2 D111 `1staid bundle`"). Spec: `docs/superpowers/specs/2026-10-01-logging-and-diagnostics-design.md` §2.9
(bundle) and §4 (redaction rules). ADR-012 §10 (supervisor, single instance, `run/`).

## Goal

1. `plur1bus 1staid bundle [--out PATH] [--lines N]`: one redacted diagnostic zip a person can attach to a report.
2. Reboot survival as a test strategy: a simulated reboot (every process of a home killed with no clean-up, `run/`
   left stale or discarded) followed by a start through the service abstraction brings the stack back, with no stale
   file left behind and never two cores.

## Design

### Bundle (`crates/plur1bus/src/firstaid_bundle/`, `commands/firstaid_bundle.rs`)

- `redact.rs` — a pure, regex-free redactor implementing spec §4 rules 1–4 (known secret values and their base64/URL
  forms, keys by name, vendor/Bearer/Basic/JWT/PEM/`PLUR1BUS_*` patterns and long base64url runs that are not pure
  hex, URL userinfo/query/fragment). Replacement is `[REDACTED:<rule>]`. `scan` reports what `redact` would still
  change, which is the bundle's re-scan: a hit on the final content refuses the write (exit 1, nothing on disk).
- `mod.rs` — `build(layout, runner, opts) -> Bundle` collects the parts as in-memory entries; `write` creates the zip
  with `create_new` (never overwrites), mode `0600` on unix, then a `manifest.json` (entry path, size, SHA-256) is the
  last entry. Parts:
  `manifest.json`, `versions.json` (harness version, install manifest if present, node runtime name),
  `platform.json` (os, arch, family, platform string; no hostname or user name), `check.json` (`1staid check`
  document), `service.json` (service status through the `Runner`), `config.json` (redacted), `logs/<file>` (last N
  lines, default 500, of diagnostic and `.out.log` files, redacted per line).
- Never included: `audit.log`, payload log, `state/`, stores, journal, `run/*.token`, secret store, `extensions/`
  contents (spec §2.9: `--include-audit`/`--include-payload` are not part of this package).
- Registered secret values for rule 1: the contents of `run/*.token` (≥ 8 chars) are read and registered so a token
  that leaked into a log line is caught even without a key name.
- Default output: `<home>/bundles/1staid-bundle-<UTC>.zip` (directory `0700`); `--out` takes a file path or an
  existing directory. The path is printed (`--json`: `1staid.bundle/1`).

### Reboot survival

No production change is planned unless a test finds a gap. Tests live in `crates/plur1bus/tests/reboot.rs` and run the
real `plur1bus` binary, the fake core, the fixture module and the fake service manager (`PLUR1BUS_SERVICE_FAKE`) in
temp homes. The "OS" is the test: after `service install`, `daemon start` asks the fake manager to start the unit; the
test then plays the manager and execs the unit's command line (`supervise`), as launchd/systemd/Task Scheduler would
after a boot. A "reboot" SIGKILLs the supervisor, core and module, leaving `run/` as the dead processes left it.

`docs/reboot-survival.md` (hand-written) holds the test protocol and lists what only a real system can show.

## Tasks → acceptance

| # | Task | Acceptance → test |
|---|---|---|
| 1 | Plan (this file) | — |
| 2 | `redact` + `scan` unit tests first, then the redactor | every §4 rule 1–4 canary replaced; hex SHA-256 kept; `scan(redact(x))` empty |
| 3 | Bundle builder, zip writer, manifest, mode | bundle has the expected parts; manifest checksums match; mode `0600`; refuses to overwrite |
| 4 | CLI wiring `1staid bundle`, docs regen | `--json` schema `1staid.bundle/1`; `pnpm docs:check` |
| 5 | Marker test over all files | planted canaries in config, logs, token file, check detail → none in any file of the zip |
| 6 | Refusal on re-scan hit | a secret the redactor cannot see forces exit 1 and no file |
| 7 | Reboot: stale socket/pid/lock after a kill | `1staid check` warns `run.stale-files`; start via the stub replaces them; stack ready; module up |
| 8 | Reboot: `run/` discarded | start recreates `run/` (0700 on unix) and the stack is ready |
| 9 | Reboot: second start, no double core | two concurrent starts after the reboot → one `started` event, one core pid |
| 10 | Docs: `docs/reboot-survival.md`, AGENTS.md rows, milestones note | `pnpm docs:check`, review |

## Rulings (taken from the docs, not decided here)

- R1 (spec §2.9): bundle holds last-N lines of logs (not days: the spec's "3 days" would need the log-schema `ts`
  reader, which another session owns; lines is bounded and works with legacy `{ at, role }` and raw lines alike).
- R2 (spec §4): no `x-sensitive` annotation exists in the config schema yet, so config values are redacted by key
  name and value pattern; `logs.otlp.headers` is dropped wholesale; a config that does not parse is omitted
  (fail closed).
- R3: written `0600` / `0700`; on Windows the file inherits the ACL of its directory (default `<home>/bundles`),
  explicit ACLs are an open point.

## Out of scope

`--include-audit`, `--include-payload`, OTLP export, uploading, `ts`/`source` log-schema reader, update/backup paths.
