# plur1bus-tools

The D120 native tools process (ADR-019 path B), isolated from the memory engine.
This initial package serves `tools.hello` and `tools.health`; it implements no coding executor.

Build with `cargo build --locked -p plur1bus-tools`. Start with
`plur1bus-tools serve --home <absolute-path>`, or let the supervisor/Core own its
stdin lifeline. `PLUR1BUS_TOOLS_BIN` selects a development binary. Test with
`cargo test -p plur1bus-tools --locked`; the real-process tests always kill and reap children.

`Service::bind` accepts `ToolsModule` implementations. The central dispatcher requires
the authenticated Core principal before calling any module and supplies its `CoreContext`.
The context borrows the per-Core-start ticket key. Future mutating methods must verify
dispatcher tickets before effects (D120 §11.2), starting with C1 and D123.

Core credentials and the supervisor's existing module lifecycle contract are separate.
Only allowlisted OS environment variables reach this process; registered provider secrets
remain in Core. See [the service contract](../../docs/tools-service.md) for run files,
permissions, adoption, degraded operation and packaging.
