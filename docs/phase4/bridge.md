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
| `bridge.secret.preload` | 1.27.0 (P4-20 flip B1) | front door (`plur1bus-core`) | the legacy core, on the secret-store endpoint (below) | the store's start-up read (`preloadRedaction`): every value, for the legacy core's redaction registry. Also the call that fetches the effects after an error. Refused when the caller derives another keyring service from its home than the front door | the packages that take the store's callers out of the legacy core, P4-90 at the latest |
| `bridge.secret.status` | 1.27.0 (P4-20 flip B1) | front door (`plur1bus-core`) | the legacy core, on the secret-store endpoint (below) | `status(principal)` of the store | the packages that take the store's callers out of the legacy core, P4-90 at the latest |
| `bridge.secret.list` | 1.27.0 (P4-20 flip B1) | front door (`plur1bus-core`) | the legacy core, on the secret-store endpoint (below) | `list(principal)` | the packages that take the store's callers out of the legacy core, P4-90 at the latest |
| `bridge.secret.set` | 1.27.0 (P4-20 flip B1) | front door (`plur1bus-core`) | the legacy core, on the secret-store endpoint (below) | `set(principal, name, value, description?)` | the packages that take the store's callers out of the legacy core, P4-90 at the latest |
| `bridge.secret.describe` | 1.27.0 (P4-20 flip B1) | front door (`plur1bus-core`) | the legacy core, on the secret-store endpoint (below) | `describe(principal, name, description)` | the packages that take the store's callers out of the legacy core, P4-90 at the latest |
| `bridge.secret.meta` | 1.27.0 (P4-20 flip B1) | front door (`plur1bus-core`) | the legacy core, on the secret-store endpoint (below) | `meta(principal, name)`: the metadata without the value | the packages that take the store's callers out of the legacy core, P4-90 at the latest |
| `bridge.secret.reveal` | 1.27.0 (P4-20 flip B1) | front door (`plur1bus-core`) | the legacy core, on the secret-store endpoint (below) | `reveal(principal, name)`: the metadata and the value | the packages that take the store's callers out of the legacy core, P4-90 at the latest |
| `bridge.secret.delete` | 1.27.0 (P4-20 flip B1) | front door (`plur1bus-core`) | the legacy core, on the secret-store endpoint (below) | `delete(principal, name)` | the packages that take the store's callers out of the legacy core, P4-90 at the latest |
| `bridge.secret.lease` | 1.27.0 (P4-20 flip B1) | front door (`plur1bus-core`) | the legacy core, on the secret-store endpoint (below) | `lease(principal, name, { purpose, profileId, ttlMs? })`, handed out: the legacy core holds the lease | the packages that take the store's callers out of the legacy core, P4-90 at the latest |
| `legacy.account.changed` | 1.27.0 (P4-12 flip A2) | legacy core (`core-legacy`) | the front door, on its control link (below) | after the front door committed a change of a person's role or status itself (`user.role.set`, `user.disable`, `user.enable`): `rights` asks for the `api.account.changed` notification to the API service connections, `learning` for the learner's reconcile. Authorizes and stores nothing | the package that serves API connections and the learner natively, P4-90 at the latest |
| `legacy.secret.changed` | 1.27.0 (P4-20 flip B2) | legacy core (`core-legacy`) | the front door, on its control link (below) | after the front door changed the secret store it owns without the legacy core asking: `name` (and `secret`, the value of a set) for a native `secret.set` or `secret.delete`, so that the legacy core voids the leases of the name it holds, masks the value and tells its change listeners; with or without a name, the legacy core fetches what the store left for it over `bridge.secret.preload`. See "The secret store" below. Authorizes and stores nothing | the packages that take the store's callers out of the legacy core, P4-90 at the latest |
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
  (it holds more than the registry held at the start of the epoch plus 8192 changes). The front door collects a new epoch's replay and applies it in one step when it
  is complete, so that no value the legacy core still masks is unmasked on the way; what only the old epoch held
  retires behind the replayed values (masked until the bound of 256 retired values displaces it).
- **When the front door asks.** Once before it serves the first client, until `more` is false; it gives up after ten
  seconds, or when the one call that is under way then has ended (a call is given five seconds). Then a thread follows
  in a long poll (`waitMs` 20000). And once more, without waiting, before every `logs.query` it serves (five seconds,
  counted the same way), so that the answer is masked with what the legacy core knows at that moment, as its own
  answer would be.
- **When the mirror is not in step** (the call failed, was refused, timed out, or the answer could not be read) the
  front door serves no `logs.query` itself: the call that finds out is answered `E_NOT_AVAILABLE`, reason
  `redaction-sync`; every later one is relayed to the legacy core, until the follower has brought the mirror in step
  again. A legacy core without the method (an older build) therefore keeps the method. The front door says so in one
  line with a short code; the mirror keeps every value it already has.
- **A stop.** A legacy core that is stopping answers a waiting call at once and every later one too. The follower rests
  a quarter of a second after an answer that brought nothing and did not wait, so it does not ask in a loop.
- **A legacy core that is wrong.** The front door trusts the legacy core with the values, not with being right. A
  number beyond the schema's bound is `malformed`. An answer that says more is waiting and brings nothing is not asked
  for again at the speed of the link. An answer of another epoch than the mirror's is a new epoch only for a call that
  was made where the mirror still stands; one that arrives late (two threads ask) is dropped.
- **Who can ask.** Only a connection that named itself `front-door` in its handshake and presented both the owner
  credential and the link credential (`run/core.token`, `run/core-legacy.token`): the control link. Both are files of
  the installation's user. A process of that user that reads both and reaches the legacy core's socket can ask as the
  front door does, and then reads every value the legacy core holds in memory, also those that are in no file (the
  tokens of logins). That is more than such a process could ask for before this method existed; it is the price of
  two processes masking alike, and it ends with the bridge.
- **What does not leave the two processes.** The values are in the result only, under the member `secrets` and the
  key `secret`. Neither side logs them or puts them into an error (failures are codes: `malformed`, `out-of-order`,
  `timeout`, the error code of a refusal). The parity recorder, a test seam of the TypeScript RPC server that writes
  down every frame of every connection when it is switched on, replaces the member (`PARITY_SECRET_KEY` matches the
  name); `tests/core-parity/p4-20-redaction.ts` checks that on every run.

`PLUR1BUS_P4_IDENTITY=ts` (the switch of the P4-12 flips) relays `logs.query` like every other native method. The mirror
runs all the same: the front door's own lines are masked with it, in `logs/core.log` and in their copy on stderr.

## The secret store

Since P4-20 flip B1 one process opens the secret store behind a front door: the front door. It builds the store before
it starts the legacy core (the same files under `state/secrets/`, the same keyring service, the same helper protocol
in a child process of its own program), reads it once, and serves it to the legacy core on an endpoint of its own. The
legacy core is started with `--secrets front-door` (honoured only together with `--behind-front-door`) and builds a
store that is a client of that endpoint (`packages/core/src/secrets/bridge-store.ts`) in place of its own. Every
caller inside the legacy core uses the same interface as before.

Since flip B2 the front door also answers seven methods on the store itself, while it owns it: for the owner and a
person behind the harness API `secret.status`, `secret.list`, `secret.get`, `secret.describe`, `secret.set` and
`secret.delete` (the handlers of `secrets/rpc.ts`), and for the engine's connection `host.secret.get`. A call of
them no longer passes the bridge. Everything else that needs the store stays in the legacy core and reaches it over
the bridge: `secret.grants.list`, and every caller that takes a lease (web search, channels, MCP, approvals, the
export's signing key, among others). The endpoint therefore stays until those callers have moved.

- **When the seven are relayed instead.** While the front door does not own the store (the next item), with
  `PLUR1BUS_P4_IDENTITY=ts`, and in a run started for an import maintenance (P4D-38). The legacy core then answers
  them through the bridge store, or from its own store, as before flip B2.
- **Who is served.** The six `secret.*` methods: the principals of the other native methods, mapped as
  `principalOf` of `core.ts` maps them (a person whose stored role is Owner is the store's owner, with the surface
  of a token connection; everyone else is an agent, whom the store refuses and records). `host.secret.get`: an
  engine connection and nobody else, and no other method is served to an engine connection; before every answer the
  front door reads `run/engine.token` again and compares it with the token the connection presented, as module-api
  does before every request of an engine connection (`E_UNAUTHORIZED`, reason `engine-delegation`, when it is no
  longer the one). The owner's or a person's `host.secret.get` is relayed and refused by the legacy core, as before.
- **`host.secret.get` is the TypeScript handler.** A lease as the core for `memory-engine`, five seconds, the value,
  and the lease revoked at once; the store records `secret.lease` and `secret.lease.revoke`. Every failure is
  `E_INTERNAL`, reason `handler-threw`. Only the names the engine's configuration refers to are given out (P4D-29):
  before the lease, the front door reads `config.json` as it is now and builds the set of names from the schema
  (`x-secret-reference` fields of `engine`, and the `x-secret-default` names of the blocks that are there). A name
  outside it is answered as a name nobody set is, takes no lease, and leaves one `secret.denied` record that names
  it (actor `agent:unknown`, `detail.method` `lease`); the legacy core's own handler (`createHostMethods`) builds the
  same set from its live configuration. See P4D-37 for the one error.
- **The legacy core is told (`legacy.secret.changed`).** It holds leases, a redaction registry and change listeners
  (an extension's environment, for one) that must follow a change it did not make. After a native
  `secret.set` or `secret.delete` that the store accepted, the front door calls it on the control link with the name,
  and for a set the value, and answers its own caller only when that call has returned or failed: the legacy core
  has voided its leases of the name, registered the value and told its listeners by then. After a native call that
  left something for the holder outside (a name whose leases are void, a store that went away, a new snapshot), the
  call goes without a name and asks the legacy core to fetch it: once for each stand of what waits (the store counts
  when something is added), not once for each native call, so a legacy core that has answered and not fetched yet is
  not asked again until something new waits. A notice that failed is sent again with a later native call, not sooner
  than five seconds after the failure. The effects themselves are never taken by the front
  door: they stay collected for the bridge connection, which the legacy core fetches them on
  (`bridge.secret.preload`). A call that is refused is sent once more; one that is not answered in five seconds is
  not repeated. The change stands whatever the call does: a notice that did not arrive is an error line of the
  front door ("the legacy core was not told of a change in the secret store", with a short code), and the legacy
  core learns the name with its next bridge call (P4D-37).
- **Who can ask (`legacy.secret.changed`).** As for every `legacy.*` method: a connection that named itself
  `front-door` in its handshake and presented both the owner credential and the link credential, at the legacy
  core's own socket. The front door relays nothing under `legacy.`, so no client of the core reaches the method.
  Both credentials are files of the installation's user. A process of that user that reads both can call the
  method with a name and a value of its choice. The legacy core then voids the leases of that name it holds (a
  caller that was using one has to take a new one), holds the given text under that name in
  its redaction registry, from where the redaction feed carries it to the front door, so that any text of eight
  characters or more can be masked in the log lines of both processes and in every `logs.query` answer (lines can
  be blacked out, not read), tells its change listeners, and fetches from the bridge. It stores nothing in the
  secret store and reveals nothing. The same process could read `state/secrets/` and stop either core; what the
  method adds for it is the masking of text of its choice, without a record.
- **`status.activeLeases`.** The native `secret.status` counts the leases the front door's store holds, which are
  those of a `host.secret.get` under way; the leases handed out over the bridge are counted by the legacy core, and
  only its own `secret.status` (relayed) adds them (P4D-37).

- **When the front door does not own the store.** On macOS, while the store would use the system's keychain and the
  installation's items have not been moved to this program (no `state/secrets/keyring-owner`): a keychain item belongs
  to the program that made it (P4D-35), so the legacy core keeps the store as it has it. And with
  `PLUR1BUS_P4_SECRETS=ts`, which needs `PLUR1BUS_ALLOW_TEST_INTERNALS=1`; the variable without the allowance, or with
  another value, stops the start. In both cases the endpoint is not bound and the legacy core is started as before.
- **The endpoint.** `run/core-bridge.sock` (the unit address of the role `core-bridge`; a named pipe on Windows),
  bound before the legacy core is started and closed after it has stopped. A connection must begin with
  `core.auth { token: <run/core-legacy.token> }`; after that it has `bridge.hello` and `bridge.secret.*`, and
  everything else is refused with `bridge-principal`. The front door's main listener answers no `bridge.secret.*`
  method, whoever asks, and relays nothing under `bridge.`. The endpoint serves at most eight connections at once; a
  connection that sends nothing for five seconds before its handshake is ended, and before the handshake anything
  but that one request ends it (a notification and a line without a method too). The bounds are against accidents:
  every process of the installation's user reaches the socket, and such a process could also stop the front door.
  It could hold the eight places too (the five seconds are per read, and nothing puts the oldest connection out, as
  the public socket does).
- **A connection opens with the preload.** `bridge.secret.preload { service }` names the keyring service the caller
  derives from its home (`plur1bus:` and a hash of the home's text). Until a preload named the front door's own, the
  connection has no other `bridge.secret.*` method (`E_STORAGE`, reason `storage`); the legacy core's store makes the
  preload the first call of every connection it opens. Two processes that spell the home differently therefore never
  work on one store under two names: the legacy core has no store, and says why. So that they do spell it alike, the
  front door takes `--home` through the same normalization as the TypeScript core (Node's `path.resolve`:
  `crates/plur1bus-core/src/home_path.rs`, checked against the vectors `resolveHome` shares with the CLI) and passes
  the result on. A home that is not Unicode text is refused.
- **One connection has the store.** The effects (below) are the store's, so they must reach the one connection the
  legacy core uses. A connection's first preload makes it that connection, and every older one is refused from then
  on (`storage`), before its call reaches the store. The legacy core closes a connection it gives up and opens a new
  one; a request that was still queued on the old one cannot take the effects of a call on the new one. A call, the
  taking of its effects and the check that the connection still has the store are one step in the front door. The
  legacy core takes no answer of a connection it gave up. One case costs a call: when the store hung so long that
  several connections were opened and given up, their preloads are still queued, and the one that runs last has the
  store, which may be one nobody reads. The legacy core's next call is refused, it voids its leases and opens anew.
- **The principal is data.** Every method but `preload` takes `principal`: `{ kind: "owner", id?, surface? }`,
  `{ kind: "core" }` or `{ kind: "agent", agentId? }`, as the legacy core derived it from its own connection. The front
  door's store runs its gates on it and writes it into the audit record. Whoever holds the link credential therefore
  acts as any principal it names. That is the legacy core's position today (it holds the store); it is not a position
  a client of either core can reach.
- **Effects.** A change in the store has consequences in the process that holds leases and a redaction registry:
  leases that are void, the start-up state, a new snapshot of the values. Every result carries them as `effects`
  (`{ startup: { state, reason?, safeToFlush }, revoked: { all, names }, preloaded? }`), and the legacy core applies
  them before the call returns. An error carries none: the legacy core asks for them with `bridge.secret.preload` before
  it raises the error, and treats a preload that fails as a store that is gone. The snapshot (`preloaded`) is in the
  first preload of a connection; after that only when the store read it anew, so asking for the effects after a
  refusal does not carry every value again. An answer the front door cannot give as it built it (it violates the
  schema, or is longer than a frame) ends the connection after the refusal, and the legacy core, which loses its
  bridge, voids every lease: the effects were in that answer.
- **Errors.** The store's refusals keep their codes: the error code the legacy core's `secret.*` gives for them
  (`E_DENIED`, `E_NOT_FOUND`, `E_INVALID_PARAMS`, `E_NOT_AVAILABLE`, `E_STORAGE`), the store's code as `reason`, and
  the store's fixed text as the message. The legacy core turns them back into the same `SecretError`.
- **Leases.** The front door gates, records (`secret.lease`) and reads as for any lease, gives the lease its id and
  its expiry, and hands it out without keeping it. The legacy core holds it, so `readLease`, `revokeLease` and
  `activeLeases` stay synchronous there; it writes their records (`secret.lease.read`, `secret.lease.revoke`) itself.
  `status.activeLeases` is the legacy core's count.
- **The audit records.** Both processes append to the one chain under `logs/` (under its lock) and then to
  `logs/audit.log`, in the TypeScript order. An operation whose record cannot be written is refused, on either
  side. The line in `logs/audit.log` is written after the chain's lock is released, as the TypeScript core writes
  it; with two writers, two lines of different processes can stand there in the other order than in the chain. The
  chain is the order.
- **The redaction registries.** The front door's store registers every value it reads or is given in the front door's
  registry (the one its log lines and `logs.query` are masked with). The legacy core registers every value that
  reaches it (the start-up snapshot, a reveal, a lease, a value it set) in its own, and the redaction feed (above)
  carries that registry to the front door as before.
- **When the bridge is gone or slow.** A call has the store's I/O budget (3 s). A call that fails for any reason but
  a refusal of the store, or a connection that ended, makes the legacy core's store unavailable
  (`backend-unavailable`): every lease it holds is revoked, the connection is closed, and the next call opens a new
  one. A bridge that could not be opened (no answer, a refused preload) is not tried again for a second; calls in
  that time fail as the opening did.
- **A snapshot is one frame.** `preloaded` holds every value of the store, and a frame is at most 4 MiB. A store
  whose values do not fit (a value is at most 64 KiB; some 40000 keys of a hundred characters fit) is answered with
  the store's `storage` in place of the snapshot and the connection ends, the front door writes an error line that
  says so, and the legacy core's store is unavailable until the values fit again (P4D-36).
- **A front door that cannot build the store does not start.** A keyring seam that is refused (the test variables
  without their allowance) or an owner switch that is not understood ends the start before the legacy core is spawned.
  A store that has no backend, or whose first read fails, is a store that says so in `secret.status`, as in the
  TypeScript core.
- **Who can ask.** A process of the installation's user that reads `run/core-legacy.token` and reaches the endpoint.
  It can then read every secret under a principal of its choice. The same process can read `state/secrets/` and the
  user's keyring without the bridge, and could ask the legacy core with `run/core.token` before; what the bridge adds
  is that the records such a caller leaves carry the principal it named. The preload itself names no principal and
  leaves no record, as the TypeScript store's own start-up read leaves none: one call hands every value to the holder
  of the credential. Such a caller also takes the store from the legacy core, whose next call fails once and voids
  every lease it holds before it opens a new connection. Flip B2 does not end the endpoint: the legacy core still
  takes its leases and serves `secret.grants.list` through it. It ends when no caller of the store is left in the
  legacy core, at P4-90 at the latest.
- **What does not leave the two processes.** Values travel in `value` (params of `set`; results of `reveal` and
  `lease`) and in `effects.preloaded`, and on the control link in `secret` of `legacy.secret.changed`. Neither side
  logs them or puts them into an error. The bridge connection is
  not recorded by the parity recorder (it is a client connection of the legacy core, and the recorder is a seam of
  the TypeScript RPC server); the control link is, and the recorder replaces `secret`.

`tests/core-parity/p4-20-secrets.ts` runs the owner's methods, an engine connection and a lease-taking caller on a
stock TypeScript core, on the owning front door that answers itself, on the owning front door that lets the
TypeScript core answer over the bridge, and on a front door that leaves the store where it was, and compares the
answers and the audit lines. Known differences between the bridge store and the TypeScript store: P4D-36; of the
native methods: P4D-37.

## The link credential (not a method)

`core.auth.frontDoor` (`$defs/FrontDoorLink`, since 1.25.0) is the other half of the bridge: the front door's credential on
the links it opens to the legacy core (`run/core-legacy.token` and the caller kind it authenticated for a client's link, or
`front-door` for its own control link). Only the
legacy core accepts it, and only together with the client's own credentials, which it verifies again; every other server
refuses it with `E_UNAUTHORIZED reason=front-door-link`. It goes with the legacy core at P4-90.
