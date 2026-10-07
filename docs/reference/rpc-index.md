# RPC-Index (harness RPC 1.5.0)

Compact index of all request methods in `packages/rpc-schema/schema/rpc.schema.json`, grouped by family (prefix before the first dot). Parameters, results and error codes are in [../rpc.md](../rpc.md). Notifications are not listed here.

Legend: "Rolle / Recht" is taken from `docs/rbac.md` and confirmed against `RPC_RULES` in `packages/core/src/rbac/guard.ts`. "nicht gesichert" means the method is not yet RBAC-checked; the local connection is then the owner (RULING R8). "unklar – prüfen" means docs/rbac.md does not state the mapping. "(kein description-Feld)" means the schema has no description for that method. Quelle paths are relative to `packages/rpc-schema/schema/`.

## core (4)

| Methode | Rolle / Recht | Kurzbeschreibung | Quelle |
|---|---|---|---|
| core.auth | nicht gesichert (lokal = Owner, R8) | (kein description-Feld) | rpc.schema.json:489 |
| core.status | nicht gesichert (lokal = Owner, R8) | (kein description-Feld) | rpc.schema.json:494 |
| core.shutdown | nicht gesichert (lokal = Owner, R8) | (kein description-Feld) | rpc.schema.json:499 |
| core.adopt | nicht gesichert (lokal = Owner, R8) | Supervisor adopts a running core using the supervisor token nonce | rpc.schema.json:504 |

## memory (13)

| Methode | Rolle / Recht | Kurzbeschreibung | Quelle |
|---|---|---|---|
| memory.recall | nicht gesichert (lokal = Owner, R8) | (kein description-Feld) | rpc.schema.json:510 |
| memory.capture | nicht gesichert (lokal = Owner, R8) | (kein description-Feld) | rpc.schema.json:535 |
| memory.checkpoint | nicht gesichert (lokal = Owner, R8) | (kein description-Feld) | rpc.schema.json:554 |
| memory.list | nicht gesichert (lokal = Owner, R8) | (kein description-Feld) | rpc.schema.json:559 |
| memory.show | nicht gesichert (lokal = Owner, R8) | (kein description-Feld) | rpc.schema.json:564 |
| memory.forget | Owner, Admin; Operator und Member mit use-Recht am Agent | (kein description-Feld) | rpc.schema.json:569 |
| memory.correct | nicht gesichert (lokal = Owner, R8) | (kein description-Feld) | rpc.schema.json:574 |
| memory.share | nicht gesichert (lokal = Owner, R8) | (kein description-Feld) | rpc.schema.json:579 |
| memory.state | nicht gesichert (lokal = Owner, R8) | (kein description-Feld) | rpc.schema.json:584 |
| memory.propose | nicht gesichert (lokal = Owner, R8) | (kein description-Feld) | rpc.schema.json:589 |
| memory.proposals.list | nicht gesichert (lokal = Owner, R8) | (kein description-Feld) | rpc.schema.json:594 |
| memory.proposals.accept | nicht gesichert (lokal = Owner, R8) | (kein description-Feld) | rpc.schema.json:599 |
| memory.proposals.reject | nicht gesichert (lokal = Owner, R8) | (kein description-Feld) | rpc.schema.json:604 |

## agent (4)

| Methode | Rolle / Recht | Kurzbeschreibung | Quelle |
|---|---|---|---|
| agent.list | nicht gesichert (lokal = Owner, R8) | (kein description-Feld) | rpc.schema.json:609 |
| agent.open | nicht gesichert (lokal = Owner, R8) | (kein description-Feld) | rpc.schema.json:614 |
| agent.close | nicht gesichert (lokal = Owner, R8) | (kein description-Feld) | rpc.schema.json:619 |
| agent.status | agent.read: Owner, Admin, Operator; Member und Viewer mit use-Recht | (kein description-Feld) | rpc.schema.json:624 |

## jobs (3)

| Methode | Rolle / Recht | Kurzbeschreibung | Quelle |
|---|---|---|---|
| jobs.list | nicht gesichert (lokal = Owner, R8) | Lists scheduled jobs, optionally filtered by kind | rpc.schema.json:629 |
| jobs.run | jobs.run: Owner, Admin, Operator | Runs a job immediately; agentId required for agent jobs | rpc.schema.json:666 |
| jobs.history | nicht gesichert (lokal = Owner, R8) | Past job execution records, system or per agent | rpc.schema.json:680 |

## dreams (7)

| Methode | Rolle / Recht | Kurzbeschreibung | Quelle |
|---|---|---|---|
| dreams.status | nicht gesichert (bleibt offen wie jobs.list) | Dreaming status per agent and phase: schedule, last run, breaker | rpc.schema.json:694 |
| dreams.log | nicht gesichert (bleibt offen wie jobs.history) | Dream run ledger rows, newest first; with runId also its log | rpc.schema.json:712 |
| dreams.run | jobs.run: Owner, Admin, Operator | Runs a dreaming phase now, under every guard except the cron gate | rpc.schema.json:718 |
| dreams.schedule.get | nicht gesichert (bleibt offen wie jobs.list) | The three phase schedules of an agent | rpc.schema.json:724 |
| dreams.schedule.set | settings.write: Owner, Admin | Edits one phase schedule: cron, IANA timezone, enabled | rpc.schema.json:730 |
| dreams.enable | settings.write: Owner, Admin | Enables one phase schedule | rpc.schema.json:736 |
| dreams.disable | settings.write: Owner, Admin | Disables one phase schedule; run-now still works | rpc.schema.json:742 |

## admin (11)

Every admin.* method is Owner/Admin per docs/rbac.md ("the whole admin.* family").

| Methode | Rolle / Recht | Kurzbeschreibung | Quelle |
|---|---|---|---|
| admin.obsidian.detect | Owner, Admin | Obsidian vaults the agent may use (read-only) | rpc.schema.json:748 |
| admin.obsidian.prepare | Owner, Admin | First half of one-time vault confirmation; nonce valid 10 min | rpc.schema.json:754 |
| admin.obsidian.confirm | Owner, Admin | Second half of vault confirmation; consumes the nonce | rpc.schema.json:760 |
| admin.migrate | Owner, Admin | Store schema migration between decimal version strings | rpc.schema.json:766 |
| admin.backup.snapshot | Owner, Admin | Stages the engine-owned part of a backup into a staging directory | rpc.schema.json:772 |
| admin.embedding.probe | Owner, Admin | Exercises the embedding provider once; result memoized | rpc.schema.json:842 |
| admin.embedding.serve | Owner, Admin | Starts or stops the scoped-embedding IPC server | rpc.schema.json:848 |
| admin.reembed.plan | Owner, Admin | Step 1 of re-embedding migration: probe verdict and plan, copies nothing | rpc.schema.json:858 |
| admin.reembed.run | Owner, Admin | Starts or continues the planned re-embedding migration in background | rpc.schema.json:870 |
| admin.reembed.status | Owner, Admin | Migration checkpoint, engine state, running flag, progress | rpc.schema.json:876 |
| admin.reembed.abort | Owner, Admin | Stops the migration at the next batch boundary | rpc.schema.json:887 |

## logs (2)

| Methode | Rolle / Recht | Kurzbeschreibung | Quelle |
|---|---|---|---|
| logs.query | logs.query: Owner, Admin | Reads protected log files after redaction, with filters and cursor | rpc.schema.json:784 |
| logs.tail | logs.query: Owner, Admin | Follows the log as a pull call, optional long poll | rpc.schema.json:802 |

## audit (1)

| Methode | Rolle / Recht | Kurzbeschreibung | Quelle |
|---|---|---|---|
| audit.verify | audit.read: Owner, Admin | Verifies the hash-chained audit file and its anchor; read-only | rpc.schema.json:819 |

## events (2)

| Methode | Rolle / Recht | Kurzbeschreibung | Quelle |
|---|---|---|---|
| events.subscribe | unklar – prüfen | (kein description-Feld) | rpc.schema.json:893 |
| events.unsubscribe | unklar – prüfen | (kein description-Feld) | rpc.schema.json:898 |

## supervisor (1)

x-server: supervisor.

| Methode | Rolle / Recht | Kurzbeschreibung | Quelle |
|---|---|---|---|
| supervisor.auth | unklar – prüfen | First call on a supervisor connection; token from run/supervisor.token | rpc.schema.json:903 |

## daemon (3)

x-server: supervisor.

| Methode | Rolle / Recht | Kurzbeschreibung | Quelle |
|---|---|---|---|
| daemon.status | unklar – prüfen | Supervisor state and one entry per supervised child | rpc.schema.json:909 |
| daemon.start | unklar – prüfen | Clears a crashed or stopped child's backoff and spawns it | rpc.schema.json:930 |
| daemon.stop | unklar – prüfen | Replies, shuts children down within budget, then exits the supervisor | rpc.schema.json:936 |

## config (3)

x-server: supervisor.

| Methode | Rolle / Recht | Kurzbeschreibung | Quelle |
|---|---|---|---|
| config.get | unklar – prüfen | Running configuration: whole value, one key, or one tier | rpc.schema.json:942 |
| config.set | unklar – prüfen | Validates and applies all changes or none; writes config.json atomically | rpc.schema.json:959 |
| config.watch | unklar – prüfen | Returns running configuration and subscribes to config.changed | rpc.schema.json:985 |

## module (12)

x-server: supervisor for module.watch, list, start, stop, restart, graph, install, uninstall. x-server: module (the module process itself) for module.auth, status, adopt, shutdown.

| Methode | Rolle / Recht | Kurzbeschreibung | Quelle |
|---|---|---|---|
| module.watch | unklar – prüfen | Current state of every module child; subscribes to module.state | rpc.schema.json:991 |
| module.list | unklar – prüfen | Every installed module with its supervised child | rpc.schema.json:997 |
| module.start | unklar – prüfen | Clears backoff and starts the module | rpc.schema.json:1003 |
| module.stop | unklar – prüfen | Stops the module within budgetMs; it stays stopped until started | rpc.schema.json:1009 |
| module.restart | unklar – prüfen | Stops and starts the module again (requested restart) | rpc.schema.json:1015 |
| module.graph | unklar – prüfen | The module dependency graph | rpc.schema.json:1021 |
| module.install | unklar – prüfen | Installs a module directory; replaces a module of the same name | rpc.schema.json:1027 |
| module.uninstall | unklar – prüfen | Stops the module and removes its directory; config entry stays | rpc.schema.json:1033 |
| module.auth | unklar – prüfen | First call on a module connection; token from run/module-<name>.token | rpc.schema.json:1039 |
| module.status | unklar – prüfen | (kein description-Feld) | rpc.schema.json:1052 |
| module.adopt | unklar – prüfen | Supervisor adopts a running module using the supervisor token nonce | rpc.schema.json:1057 |
| module.shutdown | unklar – prüfen | Asks the module to stop within budgetMs and exit 0 | rpc.schema.json:1063 |

## ext (9)

x-server: supervisor.

| Methode | Rolle / Recht | Kurzbeschreibung | Quelle |
|---|---|---|---|
| ext.list | unklar – prüfen | Installed extensions, filterable by kind, state, agent | rpc.schema.json:1069 |
| ext.show | unklar – prüfen | One extension in detail: manifest, capabilities, trust, dependents | rpc.schema.json:1075 |
| ext.inspect | unklar – prüfen | Audits a package file in a worker and keeps it for ten minutes | rpc.schema.json:1081 |
| ext.install | unklar – prüfen | Installs an inspected package, disabled unless enable is given | rpc.schema.json:1087 |
| ext.uninstall | unklar – prüfen | Moves an extension to the trash; purge also moves its data | rpc.schema.json:1093 |
| ext.restore | unklar – prüfen | Restores an extension from the trash | rpc.schema.json:1099 |
| ext.enable | unklar – prüfen | Enables an extension for given agents or everywhere; dryRun available | rpc.schema.json:1105 |
| ext.disable | unklar – prüfen | Disables an extension; disabling a module holds back its dependents | rpc.schema.json:1111 |
| ext.watch | unklar – prüfen | Returns all installed extensions; subscribes to ext.changed | rpc.schema.json:1117 |

## models (5)

| Methode | Rolle / Recht | Kurzbeschreibung | Quelle |
|---|---|---|---|
| models.list | nicht gesichert (lokal = Owner, R8) | Catalog models, provider scan states, new-model count, warnings | rpc.schema.json:1123 |
| models.scan | nicht gesichert (lokal = Owner, R8) | Scans configured providers for available models | rpc.schema.json:1146 |
| models.setOverride | models.write: Owner, Admin | Sets or clears metadata overrides, or creates a manual model entry | rpc.schema.json:1165 |
| models.removeManual | models.write: Owner, Admin | Removes a manual model entry | rpc.schema.json:1186 |
| models.acknowledge | nicht gesichert (lokal = Owner, R8) | Acknowledges newly discovered models, clearing the indicator | rpc.schema.json:1205 |

## budget (2)

| Methode | Rolle / Recht | Kurzbeschreibung | Quelle |
|---|---|---|---|
| budget.status | unklar – prüfen | Usage per period, agent and model, plus budget limits | rpc.schema.json:1220 |
| budget.set | unklar – prüfen | Sets, changes or clears a budget limit and/or the time zone | rpc.schema.json:1325 |

## egress (1)

| Methode | Rolle / Recht | Kurzbeschreibung | Quelle |
|---|---|---|---|
| egress.status | egress.read: Owner, Admin | Outgoing-network policy in force, with decision counters; read-only | rpc.schema.json:1293 |

## secret (5)

| Methode | Rolle / Recht | Kurzbeschreibung | Quelle |
|---|---|---|---|
| secret.status | unklar – prüfen (Beschreibung: Owner only) | Secret backend in use, why, and number of secrets | rpc.schema.json:1357 |
| secret.list | unklar – prüfen (Beschreibung: Owner only) | Secret names and metadata, never values | rpc.schema.json:1363 |
| secret.set | unklar – prüfen (Beschreibung: Owner only) | Creates or replaces a secret; value is write-only | rpc.schema.json:1373 |
| secret.get | unklar – prüfen (Beschreibung: Owner only) | Metadata; with reveal: true also the value (only RPC returning one) | rpc.schema.json:1386 |
| secret.delete | unklar – prüfen (Beschreibung: Owner only) | Deletes a secret from every backend and revokes its leases | rpc.schema.json:1406 |

## identity (7)

| Methode | Rolle / Recht | Kurzbeschreibung | Quelle |
|---|---|---|---|
| identity.list | users.read: Owner, Admin | Humans with linked channel identities and pending pairings | rpc.schema.json:1420 |
| identity.human.create | users.manage: Owner, Admin | Creates a human principal | rpc.schema.json:1426 |
| identity.link | users.manage: Owner, Admin | Owner links a channel identity to a human by hand | rpc.schema.json:1432 |
| identity.pair.start | users.manage: Owner, Admin | Mints a one-time pairing code for a human on a channel | rpc.schema.json:1438 |
| identity.pair.claim | users.manage: Owner, Admin | Channel adapter relays a pairing code; claim parked for owner | rpc.schema.json:1444 |
| identity.pair.confirm | users.manage: Owner, Admin | Owner approves or declines a claimed pairing | rpc.schema.json:1450 |
| identity.unlink | users.manage: Owner, Admin | Revokes a link at once; record stays for the audit trail | rpc.schema.json:1456 |

## session (8)

| Methode | Rolle / Recht | Kurzbeschreibung | Quelle |
|---|---|---|---|
| session.create | nicht gesichert (per-caller, lokal = Owner) | Opens a direct or channel session for the caller | rpc.schema.json:1462 |
| session.list | nicht gesichert (per-caller, lokal = Owner) | Caller's sessions, pinned first; archived excluded unless asked | rpc.schema.json:1471 |
| session.get | nicht gesichert (per-caller, lokal = Owner) | One session with running turn id and optional last messages | rpc.schema.json:1479 |
| session.resume | nicht gesichert (per-caller, lokal = Owner) | Session plus transcript and last event seq, to continue from | rpc.schema.json:1485 |
| session.archive | nicht gesichert (per-caller, lokal = Owner) | Archives a session; idempotent; no delete over RPC | rpc.schema.json:1492 |
| session.submit | nicht gesichert (per-caller, lokal = Owner) | Submits one user message and starts a turn | rpc.schema.json:1498 |
| session.events | nicht gesichert (per-caller, lokal = Owner) | Persisted session events after afterSeq, for replay and catch-up | rpc.schema.json:1507 |
| session.cancel | unklar – prüfen | Cancels the running turn; idempotent | rpc.schema.json:1513 |

## grant (3)

| Methode | Rolle / Recht | Kurzbeschreibung | Quelle |
|---|---|---|---|
| grant.list | grant.read: Owner, Admin (human-only) | Grants in the approval store, newest first | rpc.schema.json:1519 |
| grant.create | grant.write: Owner, Admin (human-only) | Gives an agent a standing permission: task, session or always | rpc.schema.json:1532 |
| grant.revoke | grant.write: Owner, Admin (human-only) | Revokes a grant immediately; idempotent | rpc.schema.json:1549 |

## approval (5)

| Methode | Rolle / Recht | Kurzbeschreibung | Quelle |
|---|---|---|---|
| approval.list | approval.read: Owner, Admin, Operator (human-only) | Approval requests, newest first; status=pending is the queue | rpc.schema.json:1555 |
| approval.get | approval.read: Owner, Admin, Operator (human-only) | One approval request with everything needed to decide it | rpc.schema.json:1567 |
| approval.decide | approval.decide: Owner, Admin (human-only) | Person approves or denies a pending request; first valid answer wins | rpc.schema.json:1573 |
| approval.cancel | approval.decide: Owner, Admin (human-only) | Withdraws a pending request (status cancelled) | rpc.schema.json:1586 |
| approval.verify | approval.read: Owner, Admin, Operator (human-only) | Verifies the HMAC-SHA256 chain of the approval store; read-only | rpc.schema.json:1592 |

Hinweis: grant.* und approval.* sind human-only; Agent-Principals werden in jedem Zustand mit E_DENIED reason=agent-principal abgelehnt.

## Zählung

| Familie | Anzahl |
|---|---|
| core | 4 |
| memory | 13 |
| agent | 4 |
| jobs | 3 |
| dreams | 7 |
| admin | 11 |
| logs | 2 |
| audit | 1 |
| events | 2 |
| supervisor | 1 |
| daemon | 3 |
| config | 3 |
| module | 12 |
| ext | 9 |
| models | 5 |
| budget | 2 |
| egress | 1 |
| secret | 5 |
| identity | 7 |
| session | 8 |
| grant | 3 |
| approval | 5 |
| **Gesamt** | **111** |

Zählung über die Methodenschlüssel in `$defs/methods` (Zeilen 489–1592) von `packages/rpc-schema/schema/rpc.schema.json`. Notifications (ab Zeile 2038) sind nicht gezählt.

## Unklare RBAC-Zuordnungen

1. `session.cancel`: nicht in der session.*-Liste von docs/rbac.md und nicht in RPC_RULES.
2. `budget.status`, `budget.set`: nicht in docs/rbac.md und nicht in RPC_RULES.
3. `secret.*` (5 Methoden): Beschreibungen sagen "Owner only"; docs/rbac.md hat secrets.list/reveal/write, aber keine RPC-Zuordnung.
4. Supervisor-bediente Methoden (x-server supervisor): config.*, daemon.*, module.* (Supervisor-Teil), ext.*, supervisor.auth. docs/rbac.md schweigt, RPC_RULES deckt nur Core-Methoden ab.
5. `events.subscribe`, `events.unsubscribe`: weder in docs/rbac.md noch in RPC_RULES erwähnt.
