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

| `legacy.redaction.changes` | 1.27.0 (P4-20 flip A) | legacy core (`core-legacy`) | the front door, on its control link (below) | the changes of the legacy core's redaction registry (every secret value the process holds), so that the front door masks its own log lines and the `logs.query` answers it serves with the same values. A long poll; see "The redaction feed" below. Authorizes and stores nothing | the package that makes the Rust core the owner of the secret store and of every writer of a value, P4-90 at the latest |

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

## The redaction feed

Two processes write log lines, and since P4-20 flip A the front door answers `logs.query` itself. Both must mask the same
values, and the values live in the legacy core: its redaction registry holds the secret store's values, the secret
values of the configuration and the tokens of logins. `legacy.redaction.changes` carries the registry's changes to the
front door, which keeps them in a registry of its own (`redaction_mirror`).

It is a call the front door makes, not a message the legacy core sends: the bridge has methods only, the front door
asks first and so cannot miss the start, and one call is both the delivery and the acknowledgement of the one before.

- **Params** (closed): `epoch` (the journal the caller follows, empty on the first call), `after` (the number of the
  last change the caller applied), `waitMs` (0 to 25000: how long the legacy core may hold the call when nothing is
  waiting), `maxBytes` (1024 to 2097152: the size of the values of one answer; one change is always sent).
- **Result:** `epoch`, `next` (the number of the last change in this answer, or `after` when there is none),
  `secrets` (`[{ secret, pinned }]` in the order they happened) and `more` (further changes are waiting). `pinned`
  says that a name or a group holds the value now; `pinned: false` is a value that stopped being held (it stays masked,
  among the bounded retired values) or never was.
- **Epochs.** The legacy core keeps a journal of the changes it has not been told were applied, numbered from 1 within
  an epoch. `after` lets it forget up to there. It begins a new epoch (and replays the whole registry) when the caller
  names another epoch than the current one, acknowledges a number that was never sent, or when the journal overflowed
  (8192 changes not yet acknowledged). The front door collects a new epoch's replay and applies it in one step when it
  is complete, so that no value the legacy core still masks is unmasked on the way; what only the old epoch held
  retires behind the replayed values (masked until the bound of 256 retired values displaces it).
- **When the front door asks.** Once before it serves the first client (until `more` is false, at most ten seconds).
  Then a thread follows in a long poll (`waitMs` 20000). And once more, without waiting, before every `logs.query` it
  serves, so that the answer is masked with what the legacy core knows at that moment, as its own answer would be.
- **When the mirror is not in step** (the call failed, was refused, timed out, or the answer could not be read) the
  front door serves no `logs.query` itself: the call that finds out is answered `E_NOT_AVAILABLE`, reason
  `redaction-sync`; every later one is relayed to the legacy core, until the follower has brought the mirror in step
  again. A legacy core without the method (an older build) therefore keeps the method. The front door says so in one
  line with a short code; the mirror keeps every value it already has.
- **A stop.** A legacy core that is stopping answers a waiting call at once and every later one too. The follower rests
  a quarter of a second after an answer that brought nothing and did not wait, so it does not ask in a loop.
- **What does not leave the two processes.** The values are in the result only, under the member `secrets` and the
  key `secret`. Neither side logs them or puts them into an error (failures are codes: `malformed`, `out-of-order`,
  `timeout`, the error code of a refusal). The parity recorder, a test seam of the TypeScript RPC server that writes
  down every frame of every connection when it is switched on, replaces the member (`PARITY_SECRET_KEY` matches the
  name); `tests/core-parity/p4-20-redaction.ts` checks that on every run.

`PLUR1BUS_P4_IDENTITY=ts` (the switch of the P4-12 flips) relays `logs.query` like every other native method. The mirror
runs all the same: the front door's own lines are masked with it.

## The link credential (not a method)

`core.auth.frontDoor` (`$defs/FrontDoorLink`, since 1.25.0) is the other half of the bridge: the front door's credential on
the links it opens to the legacy core (`run/core-legacy.token` and the caller kind it authenticated for a client's link, or
`front-door` for its own control link). Only the
legacy core accepts it, and only together with the client's own credentials, which it verifies again; every other server
refuses it with `E_UNAUTHORIZED reason=front-door-link`. It goes with the legacy core at P4-90.
