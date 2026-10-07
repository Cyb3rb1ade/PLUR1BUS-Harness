# Glossary

Project terms as used in the docs and code. The German column gives the equivalent for the German user docs. Where a term has no single defining file, the entry names the most authoritative one.

| Begriff | Definition | Deutsch | Wo definiert |
|---|---|---|---|
| Harness | The PLUR1BUS product as a whole: supervisor, core, CLI, API, modules and desktop app. | Harness | docs/engine-extraction.md, title and §a |
| Engine | The memory engine that the core consumes as a pinned dependency; the harness is host-neutral around it. | Engine | docs/engine-extraction.md §a.2 |
| Core | The core process: holds the engine and the stores (`state/`) and serves the core RPC. | Core | docs/user/en/operations.md, Directories |
| Supervisor | The small process that starts, watches and restarts the core and module processes and owns `config.json`. | Supervisor | docs/user/en/operations.md (Logs, Service management); docs/config.md |
| Module | A separately restartable process with its own directory under `modules/`, its own config entry and its own RPC socket. | Modul | docs/module-guide.md, header |
| Principal | The party on whose behalf a request is made (human or agent); approvals and grants are bound to it. | Principal | docs/approvals.md, §D109 |
| TurnOrigin | The typed origin of a turn (for example `dm`, `group`, `cron` or `internal`), derived from the canonical principal and not a free-text field. | TurnOrigin | docs/host-contract.md, row for `memory_store` and cron detection |
| Zone | One of the five fixed segments of a prompt (cache layout). Each zone has its own byte offset and hash; the cache prefix is built from them in order. | Zone | docs/prompt-cache.md, rules R2–R3 and zone list |
| Dreams | The background memory-consolidation runs of an agent, split into phases (light, rem, deep). | Dreams | docs/dreams.md |
| REM | The `rem` dreaming phase; it runs once a day at 01:15 by default and is one of the three phases. | REM | docs/dreams.md, schedule table |
| Switchboard | The UI area for connected channels (for example Telegram); in the current web UI it is a placeholder page. | Vermittlung (Switchboard) | docs/web-ui.md, page table; docs/milestones.md |
| Break-glass | A time-limited, audited emergency grant; its enforcement and privacy rules are set in ADR-007. | Notfallzugriff (Break-glass) | docs/rbac.md; docs/adr/ADR-007-users-roles-identity.md |
| Grant | A standing permission that lets an agent perform a capability, scoped to a task, a session or always. | Freigabe (Grant) | docs/approvals.md, §D109; reference/rpc-index.md, `grant.*` |
| Approval | A pending request to perform an action that needs a person's decision; the decision is recorded in an HMAC-chained store. | Genehmigung (Approval) | docs/approvals.md; reference/rpc-index.md, `approval.*` |
| Capability | A named permission that a host or module offers or requests; a host checks for it before calling a feature. | Fähigkeit (Capability) | docs/host-contract.md, capability probe rows; docs/approvals.md |
| Host-Mode | The mode in which PLUR1BUS runs as the memory provider of an existing host (currently Hermes): a local sidecar with no web UI and no channels. | Host-Modus | docs/hermes-host-mode.md, header and §1 |
| Restart class | The class (for example `live`, `core`, `module:<name>`) that decides how far a config change must restart the system. | Neustart-Klasse | reference/config-keys.md; docs/adr/ADR-013-configuration-and-restart-classes.md |
| Setup | The one-time install step that writes `manifest.json`, the runtime and the default layout. | Einrichtung (setup) | docs/user/en/quickstart.md, §2 |
| Repair (1staid) | The check-and-repair command family; `1staid check` verifies an installation and `1staid repair` restores damaged `config.json` from backups. | Reparatur (1staid) | docs/user/en/quickstart.md, §5; docs/user/en/operations.md |
| Engine RPC | The local JSON RPC over a socket or named pipe through which clients talk to the core. | Engine-RPC | docs/rpc.md (generated); reference/rpc-index.md |
| Audit chain | The hash-chained audit file in `logs/audit-chain*`; it can be verified and anchored. | Audit-Kette | docs/audit-chain.md |
| Egress policy | The default-deny outgoing-network policy: only listed hosts and ports are reachable. | Ausgangs-Richtlinie (Egress) | docs/egress.md; config key `egress` in reference/config-keys.md |
