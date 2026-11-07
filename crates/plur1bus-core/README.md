# plur1bus-core

The PLUR1BUS core in Rust (Phase 4, ADR-019, owner decisions D129 and D131). Today it is the skeleton of task P4-03:
the front door lands in P4-10, and the TypeScript core stays the default until P4-10's flip PR.

```text
plur1bus-core serve --home <dir> [--lifeline stdin --instance <uuid>]
```

`serve` parses its arguments like `packages/core/src/bin.ts` (a usage error exits 2), makes the home absolute, resolves the
run files (`run/core.sock` or the per-home pipe, `run/core.token`, `run/core.pid`, `state/core.lock`) and exits 1 with
"the Rust front door lands in P4-10". It binds, writes and locks nothing. The crate is `#![forbid(unsafe_code)]`.

## Layout

| Module | Owner | What |
|---|---|---|
| `cli` | P4-03 | the command line |
| `run_files` | P4-03 | the run-file names and the address rule of module-api's `unitAddress` |
| `server` | P4-10 | listener, framing, dispatch through `plur1bus_rpc::server::dispatch_core`; P4-03 provides `server::validators()` |
| `relay` | P4-10 | unserved methods to `core-legacy` with the caller context |
| `auth` | P4-10 | `run/core.token`, `core.auth` |
| `lock` | P4-10 | the single-instance lock on `state/core.lock` |
| `events` | P4-10 | `events.subscribe`/`unsubscribe`, fan-out by audience |
| `lifecycle` | P4-10 | lifeline, drain order, shutdown, adoption |

Every `x-server: "core"` method is a method of the generated trait `plur1bus_rpc::server::CoreMethods` (feature `server`
of `plur1bus-rpc`). A method left at its default body answers `NotServed`, which the front door relays.

Shared crates of Phase 4: `plur1bus-canon` (canonical JSON, action hash), `plur1bus-store` (SQLite conventions of the
TypeScript stores), `plur1bus-tokens` (token counter, extracted from the engine), `plur1bus-audit` (audit chain, shared
with the CLI).

## Tests

```text
cargo test -p plur1bus-core --locked
```

`tests/cli.rs` runs the binary. `tests/wire.rs` is parity mode W: `tests/support/` is a fake HTTP and WebSocket server
on 127.0.0.1 that serves the exchanges `scripts/parity/export-wire.ts` recorded from the TypeScript fake servers
(`fixtures/parity/wire/`), so Rust tests never need Node or the network. The parity harness as a whole is described in
`tests/core-parity/README.md`.
