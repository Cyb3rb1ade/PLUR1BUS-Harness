# Native tools service

`plur1bus-tools` is the isolated Rust process introduced by D120 H1-1 (ADR-019 path B).
The memory engine remains separate. H1-1 adds lifecycle and health only; artifacts, coding ACI,
containment and team/router handlers arrive in their own packages.

The supervisor starts the tools slot after starting Core, with an independent restart backoff,
stdin lifeline, private output log and adoption. A tools crash does not restart Core. In standalone
`plur1bus core run`, Core owns the child and reaps it on shutdown; a child adopted by a supervisor
continues under its new lifeline. `PLUR1BUS_TOOLS_BIN` overrides the native binary path. Otherwise
the binary is installed beside the CLI, or under `<home>/runtime/bin/`.

For development, build `cargo build --locked -p plur1bus-tools` and set `PLUR1BUS_TOOLS_BIN` to its
absolute executable path. The binary also accepts `serve --home <absolute-path>` independently.
`--lifeline stdin --instance <uuid>` is the supervisor/Core process contract. Lifeline loss permits
adoption for the configured startup grace (`--grace-ms`, supplied from `supervisor.graceMs`, ten seconds
by default), then the process exits and removes its run files.

The endpoint is `<home>/run/tools.sock`, or the harness's per-home `-tools` named pipe. Run files
are owner-private (0700 directories, 0600 files and sockets; owner-and-SYSTEM ACLs on Windows).
`state/tools.lock` prevents concurrent instances. A live endpoint is never removed to force a bind.

Two credentials establish distinct connection identities:

- `run/tools-core.token` authenticates `tools.hello`. Only this identity reaches `tools.*` handlers.
  The hello exchanges a fresh 32-byte dispatcher-ticket key per Core start (D120 §11.2), kept only
  in memory and erased when the connection/Core closes. It is never returned in health or logs.
- `run/tools.token` authenticates the existing `module.auth/status/adopt/shutdown` lifecycle
  contract for the supervisor. This identity cannot call `tools.health` or future tools handlers.
  Adoption additionally proves the current `run/supervisor.token` on the connection becoming the lifeline.

These are local service credentials, not registered secret-store/provider values. The process
receives an allowlisted OS environment; credential, dynamic-loader and extension-secret environment
variables are excluded. Future modules implement `ToolsModule` and receive an authenticated
`CoreContext` after the central guard. Mutating handlers must add the D120 ticket verification before
their first release (C1/D123); H1-1 introduces no mutation executor or second Git implementation.

Core periodically calls `tools.health` and exposes its cached readiness as `core.status.tools`.
`core.status` itself performs no tools I/O. `1staid check` reports `tools.service: ok/fail`, or `skip`
when Core is unavailable; `doctor.report` overlays current readiness. Coding behavior is unchanged,
so the owner's D123-Q11 exemption allows this skeleton ahead of the B1 live-baseline gate.

The release archive and container carry `plur1bus-tools` beside `plur1bus`. Desktop packaging stages
it beside the host CLI and includes its hash in the signed resource payload. Inert packaging fixtures
remain labelled as fixtures; they do not claim native installation or cross-platform runtime evidence.

Local verification uses `cargo test -p plur1bus-tools --locked`, the tools restart supervisor test,
and `packages/core/test/tools-service/` (real binary, fake chat provider, no model/network).
