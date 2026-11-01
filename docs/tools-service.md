# Native tools service

`plur1bus-tools` is the isolated Rust process introduced by D120 H1-1 (ADR-019 path B).
The memory engine remains separate. H1-1 adds lifecycle and health only; artifacts, coding ACI,
containment and team/router handlers arrive in their own packages.

The supervisor starts the tools slot after starting Core, with an independent restart backoff,
stdin lifeline, private output log and adoption. A tools crash does not restart Core. In standalone
`plur1bus core run`, Core owns the child and reaps it on shutdown; a child adopted by a supervisor
continues under its new lifeline. `PLUR1BUS_TOOLS_BIN` overrides the native binary path. Otherwise
the resolver checks beside the CLI or under `<home>/runtime/bin/`. Standalone startup waits until Core owns its lock
and has published its private `run/core.pid`; repeated startup failures use a bounded exponential backoff.

For development, build `cargo build --locked -p plur1bus-tools` and set `PLUR1BUS_TOOLS_BIN` to its
absolute executable path. The binary also accepts `serve --home <absolute-path>` independently, after Core or the
operator has created Home and the shared `state/` directory.
`--lifeline stdin --instance <uuid>` is the supervisor/Core process contract. Lifeline loss permits
adoption for the configured startup grace: direct `serve` defaults to ten seconds; Core/supervisor supply
`--grace-ms` from `supervisor.graceMs` (sixty seconds by default). The process then exits and removes its run files.

The endpoint is `<home>/run/tools.sock`, or the harness's per-home `-tools` named pipe. Run files
are owner-private (0700 directories, 0600 files and sockets; owner-and-SYSTEM ACLs on Windows).
`state/tools/instance.lock` prevents concurrent instances. The service secures only its own files and `state/tools/`;
it checks Home and the shared `state/` without changing their permissions or ACLs. A symlinked Home is supported.
An existing untrusted `run/` is refused rather than repaired. A live endpoint is never removed to force a bind.
The supervisor and tools service use the shared `plur1bus-rpc::server_transport` implementation.

Two credentials establish distinct connection identities:

- `run/tools-core.token` authenticates `tools.hello`. Only this identity reaches `tools.*` handlers.
  The first hello for the recorded Core PID/instance installs a fresh 32-byte dispatcher-ticket key (D120 §11.2)
  process-wide in the service. Where the kernel supplies the peer PID, it must equal `run/core.pid`.
  Every subsequent connection for that Core identity must show the same key, compared in constant time. A new Core
  identity installs its key and closes the old Core connections. Ordinary connection loss does not rotate the key.
  Retired key storage is zeroized when its in-flight references are released; service shutdown erases the active key.
  The key is never returned in health or logs. A token holder without the recorded process identity is refused;
  the existing trust boundary for an OS account able to replace private run files remains unchanged.
- `run/tools.token` authenticates the existing `module.auth/status/adopt/shutdown` lifecycle
  contract for the supervisor. This identity cannot call `tools.health` or future tools handlers.
  Adoption additionally proves the current `run/supervisor.token` on the connection becoming the lifeline.
  `module.status.detail.stdinClosed` confirms that the original stdin EOF was processed, independently of adoption.

These are local service credentials, not registered secret-store/provider values. The process
receives an allowlisted OS environment; credential, dynamic-loader and extension-secret environment
variables are excluded. Future modules implement `ToolsModule` and receive an authenticated
`CoreContext` after the central guard. Mutating handlers must add the D120 ticket verification before
their first release (C1/D123); H1-1 introduces no mutation executor or second Git implementation.
The module RPC boundary catches unwinding panics, suppresses their payload-bearing panic hook and returns only
`E_INTERNAL` with reason `module-panic`. A Drop guard releases the connection budget even when a handler unwinds.

Core periodically calls `tools.health` on a dedicated authenticated connection and exposes its cached readiness as `core.status.tools`.
Long module calls use the separate work connection. A request timeout removes only that pending request; late replies
are ignored and the work connection stays usable. Imports leave this independent tools service running.
`core.status` itself performs no tools I/O. `1staid check` reports `tools.service: ok/fail`, or `skip`
when Core is unavailable; `doctor.report` overlays current readiness. Coding behavior is unchanged,
so the owner's D123-Q11 exemption allows this skeleton ahead of the B1 live-baseline gate.

The release archive and container carry `plur1bus-tools` beside `plur1bus`. Desktop packaging stages
it beside the host CLI and includes its hash in the signed resource payload. Inert packaging fixtures
remain labelled as fixtures; they do not claim native installation or cross-platform runtime evidence.

Local verification uses `cargo test -p plur1bus-tools --locked`, the tools restart supervisor test,
and `packages/core/test/tools-service/` (real binary, fake chat provider, no model/network).

On daemon stop, tools shares the existing acceptance-anchored deadline. As a fixed companion it does not
reduce Core's nominal no-module shutdown allowance; it never extends the shared hard deadline.
