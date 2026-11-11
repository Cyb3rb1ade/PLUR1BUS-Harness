# Phase 4 bridge ledger

Plan: `docs/superpowers/plans/2026-11-07-phase4-ts-core-to-rust.md` §2.4 and §4.5.

While the TypeScript core runs behind the Rust front door as `core-legacy`, a TypeScript caller that needs a subsystem already
ported to Rust calls a `bridge.*` method on the front door, and a Rust caller that needs a TypeScript executor calls a
`legacy.*` method on the legacy core. Every such method has `x-server: "bridge"`, `x-stability: "experimental"`, closed params,
and `x-deprecated` with `removeAfter` "the 0.1 cut (P4-90)". It is callable only by the principal it names. P4-90 requires
this ledger to be empty.

| Method | Since | Served by | Caller | Purpose | Removed by |
|---|---|---|---|---|---|
| `bridge.hello` | 1.25.0 (P4-10) | front door (`plur1bus-core`) | the legacy core: a connection that authenticated with `core.auth { token: <run/core-legacy.token> }` | the bridge's handshake and probe; returns the front door's `rpc`, `instanceId` and `pid` | P4-90 |

## The link credential (not a method)

`core.auth.frontDoor` (`$defs/FrontDoorLink`, since 1.25.0) is the other half of the bridge: the front door's credential on
the per-client links it opens to the legacy core (`run/core-legacy.token` and the caller kind it authenticated). Only the
legacy core accepts it, and only together with the client's own credentials, which it verifies again; every other server
refuses it with `E_UNAUTHORIZED reason=front-door-link`. It goes with the legacy core at P4-90.
