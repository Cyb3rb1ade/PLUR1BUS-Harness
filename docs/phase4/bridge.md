# Phase 4 bridge ledger

Plan: `docs/superpowers/plans/2026-11-07-phase4-ts-core-to-rust.md` §2.4 and §4.5.

While the TypeScript core runs behind the Rust front door as `core-legacy`, a TypeScript caller that needs a subsystem already
ported to Rust calls a `bridge.*` method on the front door, and a Rust caller that needs a TypeScript executor calls a
`legacy.*` method on the legacy core. Every such method has `x-server: "bridge"`, `x-stability: "experimental"`, closed params,
and `x-deprecated` with `removeAfter` "the 0.1 cut (P4-90)". It is callable only by the principal it names. P4-90 requires
this ledger to be empty.

The name gives the direction: `bridge.*` is served by the front door, `legacy.*` by the legacy core. Both carry
`x-server: "bridge"`, so the capability list of the bridge role names every method of this ledger, whichever side serves it.

| Method | Since | Served by | Caller | Purpose | Removed by |
|---|---|---|---|---|---|
| `bridge.hello` | 1.25.0 (P4-10) | front door (`plur1bus-core`) | the legacy core: a connection that authenticated with `core.auth { token: <run/core-legacy.token> }` | the bridge's handshake and probe; returns the front door's `rpc`, `instanceId` and `pid` | P4-90 |
| `legacy.account.changed` | 1.27.0 (P4-12 flip A2) | legacy core (`core-legacy`) | the front door, on its control link (below) | after the front door committed a change of a person's role or status itself (`user.role.set`, `user.disable`, `user.enable`): `rights` asks for the `api.account.changed` notification to the API service connections, `learning` for the learner's reconcile. Authorizes and stores nothing | the package that serves API connections and the learner natively, P4-90 at the latest |

## The `legacy.*` namespace and the control link

A `legacy.*` method has no principal of its own: it is the front door acting after it authorized and committed a change
itself. Two independent rules keep everyone else out.

- **The front door relays nothing under `legacy.`.** Whoever the client is (owner, API, scoped client, engine) and
  whether the schema knows the method or not, a request whose method starts with `legacy.` is answered by the front
  door: `E_INTERNAL`, reason `method-not-found`, JSON-RPC -32601, the answer a TypeScript core gives for a method it does
  not serve (`route::Route::Legacy`). The legacy core's own bridge connection gets `bridge-principal`, as for everything
  that is not `bridge.*`.
- **The legacy core serves `legacy.*` on one connection only: the control link.** That is the front door's own
  connection, opened before it listens. Its handshake names it: `core.auth.frontDoor.caller = "front-door"` (since
  1.27.0), with the owner credentials, which the legacy core verifies as for an owner's link. A link named `owner`,
  `api`, `engine` or `client` (what the front door opens for a client) has no `legacy.*` method, and a connection
  cannot change its name with a second handshake. A TypeScript core that does not run behind a front door has no such
  method at all (`packages/module-api/src/rpc-server.ts`).

The front door waits five seconds for the answer (`control::CALL_WAIT`). A refused call is sent once more (the handler
failed; both follow-ups may run twice). A call without an answer is not repeated: the request is in the legacy core's
queue and runs when it gets to it. The change the front door made stands whatever the call does; a call that failed is a
line of the front door ("the legacy core was not told of an account change", with a short code; `error` when it
concerned a change of rights, `warn` otherwise). Once the control link has ended (the legacy core is going away) the front door refuses the
write methods before it stores anything (`E_NOT_AVAILABLE`, reason `stopping`).

## The link credential (not a method)

`core.auth.frontDoor` (`$defs/FrontDoorLink`, since 1.25.0) is the other half of the bridge: the front door's credential on
the links it opens to the legacy core (`run/core-legacy.token` and the caller kind it authenticated for a client's link, or
`front-door` for its own control link). Only the
legacy core accepts it, and only together with the client's own credentials, which it verifies again; every other server
refuses it with `E_UNAUTHORIZED reason=front-door-link`. It goes with the legacy core at P4-90.
