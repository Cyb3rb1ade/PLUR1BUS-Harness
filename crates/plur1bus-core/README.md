# plur1bus-core

The PLUR1BUS core in Rust (Phase 4, ADR-019, owner decisions D129 and D131). Since P4-10 it is the **front door**: it owns
the core's socket, token, run files and lock, starts the TypeScript core behind it as `core-legacy`, and relays every call
it does not serve to it. Opt-in until the flip PR: `core.impl: "rust"` in `config.json`, or `PLUR1BUS_CORE_IMPL=rust`
(tests); the TypeScript core alone stays the default. The crate is `#![forbid(unsafe_code)]`.

```text
plur1bus-core serve --home <dir> [--lifeline stdin --instance <uuid>]
```

The supervisor's `core` slot and `plur1bus core run` start it with `PLUR1BUS_NODE` and `PLUR1BUS_CORE_JS` set to the
located runtime; it spawns `node core.js --home <dir> --behind-front-door supervised|standalone --lifeline stdin
--instance <uuid>` and holds that process's stdin as its lifeline.

## What it owns

| File or endpoint | Mode | Written by |
|---|---|---|
| `run/` | `0700` (user-and-SYSTEM DACL on Windows) | front door |
| `run/core.sock` / `\\.\pipe\plur1bus-<hash>-core` | `0600` / explicit SDDL (closes ADR-012 deviation C2) | front door |
| `run/core.token`, `run/api-delegation.token`, `run/core-legacy.token` | `0600`, 32 random bytes as hex, fresh per start | front door |
| `run/core.pid` | `0600`, `<pid> <instanceId>` | front door |
| `state/core.lock` | the TypeScript core's SQLite byte range | front door |
| `run/core-legacy.sock`, `run/core-legacy.pid`, `state/core-legacy.lock`, `run/engine-models.json` | | legacy core |

## Layout

| Module | What |
|---|---|
| `cli` | the command line |
| `run_files` | the run-file names, the address rule of module-api's `unitAddress`, private writes |
| `server` | listener, framing (4 MiB lines), 16 MiB back-pressure, the 30 s handshake deadline, the route table |
| `relay` | the per-client link to `core-legacy` |
| `auth` | credentials (`Secret`, never printed), constant-time compares, the `core.auth` checks |
| `lock` | the single-instance lock on `state/core.lock` |
| `events` | subscriptions and the front door's own `core.state` |
| `lifecycle` | process state, lifeline, drain order, timings |
| `legacy` | spawning the legacy core and its ready line |
| `frame` | NDJSON lines and error frames |

Route table: before `core.auth` everything is answered here; `core.auth` is verified here and then opened as a link with
the client's credentials plus `core.auth.frontDoor`; `bridge.*` is served to the legacy core's own connection only;
`core.status`, `core.adopt`, `core.shutdown` and `events.(un)subscribe` are relayed for the legacy core's admission and
RBAC and completed here (the front door's identity and state, its lifeline, its stop, its `core.state`); everything else
is relayed byte for byte. The legacy core re-verifies every credential and runs its RBAC on every relayed call until the
cut. See `docs/phase4/bridge.md` for the bridge ledger.

Shared crates of Phase 4: `plur1bus-canon` (canonical JSON, action hash), `plur1bus-store` (SQLite conventions of the
TypeScript stores), `plur1bus-tokens` (token counter, extracted from the engine), `plur1bus-audit` (audit chain and the
core lock, shared with the CLI).

## Tests

```text
cargo test -p plur1bus-core --locked
```

`tests/front_door.rs` (`harness = false`) runs the binary against a fake legacy core that is the test binary itself
(`tests/front_door_support/fake_legacy.rs`): run files and modes, every caller kind, the relay, notifications,
back-pressure, adoption and the lifeline, every stop path, and that no credential leaks. `tests/cli.rs` covers the command
line. `tests/wire.rs` is parity mode W: `tests/support/` is a fake HTTP and WebSocket server on 127.0.0.1 that serves the
exchanges `scripts/parity/export-wire.ts` recorded from the TypeScript fake servers (`fixtures/parity/wire/`). The parity
harness as a whole is described in `tests/core-parity/README.md`.
