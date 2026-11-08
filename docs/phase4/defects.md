# Phase 4 defect ledger

Plan: `docs/superpowers/plans/2026-11-07-phase4-ts-core-to-rust.md` §4.2 (pull forward on defect) and §3 (parity). Besides
recorded owner decisions, an entry here is the only allowed divergence between the TypeScript core and the Rust core: a
defect found in TypeScript (it is ported, not patched), or a difference the Rust front door introduces on purpose and that
a later package removes. Each entry names the component, its MODULE-MAP row
(`docs/superpowers/plans/phase4/MODULE-MAP.md`), a severity, the owning package and a reproduction; it is closed by the
PR that flips the owning package with its vector green.

Severity: `security`, `data-loss`, `low` (a wrong answer or refusal on a path no shipped client takes, or a narrow
window that was not reproduced; the entry says which), `info` (a documented difference with no wrong answer).

| Id | Component | MODULE-MAP row | Severity | Owner | Status |
|---|---|---|---|---|---|
| P4D-1 | TypeScript store migrations read `user_version` before `BEGIN IMMEDIATE` | `packages/core/src/session/migrations.ts`, `packages/core/src/collab/migrations.ts` | low | P4-40 | open, contained |
| P4D-2 | An API subscriber does not see the front door's own `core.state` | `packages/core/src/events-map.ts` | low | P4-12 | open |
| P4D-3 | Before the handshake, a line with a lone surrogate escape is a parse error | `packages/module-api/src/rpc-server.ts` (reference) | info | P4-12 | open |
| P4D-4 | The front door accepts at most 512 connections at once | `packages/core/src/core.ts` | info | P4-12 | open |
| P4D-5 | After the front door dies abruptly, the old legacy core stops on its own while a new front door waits | `packages/core/src/core.ts` | low | P4-90 | mitigated in P4-10 (residual cases named) |
| P4D-6 | The legacy core's Windows pipe keeps Node's default DACL (ADR-012 C2) | `packages/core/src/core.ts` | low | P4-90 | open; contained for credentials, not for availability |
| P4D-7 | The front door's own diagnostics are plain stderr lines, not log-schema records in `logs/core.log` | `packages/core/src/logger.ts` | info | P4-11 | open |
| P4D-8 | module-api's `validApiPrincipal` coerces `role` and `kind` with `String()`; the Rust port does not | `packages/module-api/src/api-principal.ts` (reference) | low | P4-12 | open, Rust strict |
| P4D-11 | An accepted `core.shutdown`: the requester sees `core.state stopping` before the answer | `packages/core/src/core.ts` | info | P4-12 | open, intentional |

## P4D-1 — migration step read outside the write lock

`migrate()` in `packages/core/src/session/migrations.ts` (and the copy in `collab/migrations.ts`) reads `PRAGMA
user_version` once, then runs each missing step in its own `BEGIN IMMEDIATE`. Two migrators that both read the old
version run the same step twice; the second one's DDL fails (`table ... already exists`), is rolled back, and the open
fails with `migration-failed`. Nothing is written twice and no data is lost; the open is refused.

- Reproduction: two connections to one fresh session store; both read `user_version` 0; the first runs `migrate()`; the
  second runs its loop from 0 and fails on step 1.
- Containment: one TypeScript core per home (the core lock), and the Rust core never migrates a store before the package
  that ports it flips (`crates/plur1bus-store`, package ruling 4).
- Vector: `crates/plur1bus-store` `a_step_applied_meanwhile_is_skipped_not_run_twice` (P4-03 review F5) is the Rust side:
  the version is read again under the write lock and a step already in is skipped.

## P4D-2 — `core.state` for API subscribers

The front door owns the process state (`ready`, `orphaned`, `stopping`) and sends `core.state` to the owner connections
that subscribed, with the TypeScript server's rule for a notification without an audience. An API connection (the
harness API's delegated principal) keeps the legacy core's `core.state` instead, because its delivery needs the person
behind the API principal, which only the legacy core can resolve until the identity store is ported. The legacy core
never reports `orphaned` while the front door lives (the front door holds its lifeline), so an API subscriber does not
see the front door's `orphaned`; it sees `stopping` from the legacy core once the front door asks that to stop.

- Reproduction: `core.impl: "rust"`; an API connection subscribes to `core.state`; close the supervisor's lifeline; the
  owner subscriber gets `orphaned`, the API subscriber does not.
- Fix: P4-12 resolves the API principal in Rust and delivers the front door's `core.state` with the audience rule.

## P4D-3 — a lone surrogate escape before the handshake

Before `core.auth` succeeds the front door parses every line itself. Invalid UTF-8 is replaced by U+FFFD first, as the
TypeScript server's decoder does, so such a line gets the same answer on both cores. A lone surrogate escape (`"\ud800"`)
is different: `JSON.parse` accepts it, `serde_json` cannot represent it in a string and refuses the line, so the front
door answers `-32700` (`reason: parse-error`, id `null`) where the TypeScript server dispatches the request and refuses it
there.

After the handshake the front door reads only the members it routes on (`crates/plur1bus-core/src/peek.rs`, P4-10 fix
round, security review M1/L3): every client line goes to the legacy core as written (a completed request with only its id
replaced), and every answer and notification of the legacy core reaches the client byte for byte, a lone surrogate or
nesting deeper than 128 included. What remains is narrow: a frame the front door reads whole — a `core.auth` on an
authenticated connection, a natively served method (none in P4-10), and the six answers it completes (`core.auth`,
`core.status`, `core.adopt` patched; `core.shutdown`, `events.subscribe`, `events.unsubscribe` only peeked) — reads a lone
surrogate as U+FFFD, so a patched answer carries U+FFFD where the TypeScript core writes the escape; and such a frame
that serde_json cannot read — nested deeper than 128 levels, or with a number out of its range (`1e400`, which
`JSON.parse` reads as Infinity) — is refused with `-32700` (a request) or forwarded with only its id replaced (an answer,
a warning on stderr). Two more are read alone (task review I2): the `api` member of every request on an API connection,
which the front door verifies before it relays the request (a member nested that deep or with such a number is refused
`api-delegation`, as module-api refuses what `JSON.parse` makes of it); and the legacy core's answer to the control
link's handshake, read strictly once at start (its own `core.auth` result, no client data).

A request id goes back as the client wrote it, on the answers the front door completes or gives itself: `1E+2` or
`9007199254740993` returns as written, where module-api returns what `JSON.parse` made of it (`100`,
`9007199254740992`). An id that is no `$defs/Id` (an object, an array, a boolean, a fraction) gets module-api's
`invalid-request` answer with its detail (P4-10 fix round 1b F8, vectors in `fixtures/parity/auth/module-api.json`,
section `request-id`); one the front door cannot read (`1e400`, Infinity to `JSON.parse`) goes to the legacy core, which
echoes `null` as module-api does.

- Reproduction: `{"jsonrpc":"2.0","id":1,"method":"core.auth","params":{"token":"\ud800"}}` on a fresh connection. The
  TypeScript core answers `E_INVALID_PARAMS` (`/token` is too short), the front door `-32700`.
- Both refuse the line; only the error differs. P4-12 decides whether the Rust core keeps the stricter parse (recorded
  then as an owner decision) or reproduces it.

## P4D-4 — connection limit

The front door serves each connection on a thread of its own and closes a new connection while 512 are open (logged as
`connection limit reached`). The TypeScript server has no limit. No shipped client opens more than a handful of
connections. P4-12 sets the limit for the Rust core for good (the async server of the full port) and documents it.

Descriptors (P4-10 fix round, security review M2): the front door raises its soft `RLIMIT_NOFILE` to the hard limit at
start with Node's search (`plur1bus_rpc::limits::raise_open_files`), as Node does for the TypeScript core, so launchd's
256 is no longer its ceiling; an accepted socket holds one descriptor, a link three. Where the limit cannot be raised the
connection limit follows it (`(limit - 64) / 4`, at most 512; 48 at 256). At most 64 connections (half the limit, if
lower) wait for their handshake at once; a new one beyond that ends the oldest of them, so idle unauthenticated sockets
cannot keep an owner from its handshake (logged once as `unauthenticated connections at their limit`). Only connections
that have not sent a single complete frame count and are ended (fix round 1b F5): a handshake under way is never ended to
make room. At the connection limit the oldest such connection is ended instead of refusing the new one (F2). Running out of
descriptors is logged once per burst with the descriptors the process can use (`openFiles`: the soft limit, at most
`kern.maxfilesperproc` on macOS, task review I6). The TypeScript server has neither cap; its
30 s handshake deadline is the same.

## P4D-5 — the old legacy core outlives an abruptly stopped front door

When the front door is killed, its lock (`state/core.lock`) is released at once, but the legacy core behind it runs until
it sees its lifeline (stdin) close and finishes its stop (it stops at once, without grace, but finishes what is in
flight). A new front door started in that window takes `state/core.lock`, and its legacy core exits with code 3 on
`run/core-legacy.lock` until the old one is gone; the new front door retries that start for the shutdown budget plus
10 s and binds `run/core.sock` only once its legacy core is ready. The stores are never written by two legacy cores at
once (`run/core-legacy.lock`), and clients see the address refused as they do while a TypeScript core restarts
(tests/system kill-soak SIGKILLs the front door and passes on the rust leg: no fact lost, none replayed twice).

Where the window exists (task review L11). When the supervisor spawned the front door (Linux, macOS), it SIGKILLs what is
left of the front door's process group once it has reaped it (`crates/plur1bus/src/supervisor/child.rs` `sweep_tree` →
`adopt.rs` `sweep_group`), the legacy core included: that legacy core does not finish its stop, and a supervised front
door's crash equals a TypeScript core's SIGKILL (no drain), as on the ts leg. The window exists where nobody sweeps: an
adopted front door (the supervisor never signals a peer's group after its exit), `plur1bus core run`, and Windows (no
process group). Since P4-10 S-M4 the OS also ends the legacy core with its front door on Linux (parent-death signal) and
on Windows (a job object that kills on close), and the supervisor's kill of an adopted front door and 1staid's
`unit.terminate-hung` kill the legacy core `run/core-legacy.pid` names. What remains is a front door that dies abruptly
by another hand on macOS (an OOM kill, a SIGKILL by hand, a `core run` terminal closed): its legacy core stops on its
lifeline (no grace) and finishes what is in flight, under its own lock (below).

Mitigated in P4-10 (security review M3, controller ruling S-M3). Until then every writer that is not the front door took
only `state/core.lock`, which the kernel frees the moment the front door dies, so a stock TypeScript core (a `core.impl`
switch to `ts` applies exactly at the restart after such a crash), the import and a restore could start beside the old
legacy core while it still wrote the stores. Now:

- Every other holder of `state/core.lock` also takes `run/core-legacy.lock`, after `state/core.lock` and without waiting
  (the same order everywhere, so no two holders can deadlock), and refuses with its existing lock error while it is held:
  the stock TypeScript core (`acquireCoreLock`, `E_LOCKED core-lock-held`, exit 3, retried by the supervisor), the
  import's single writer (`withTargetLock`, `target-running`; it also probes `run/core-legacy.pid` like `run/core.pid`)
  and with it the import's rollback, and `plur1bus backup restore` (`E_LOCKED core-running`, held for the whole swap).
- The legacy core behind a front door gives up its start when its lifeline ends before it is ready: at the next of its
  start steps (before its lock, after the engine opened, before it listens) the start fails and cleans up like any failed
  start, instead of finishing it and then stopping.

Residual cases:

- The legacy core finishes the start step it is in when its front door dies (an engine open, a migration) and then the
  drain of what was in flight; it holds `run/core-legacy.lock` throughout, so the writers above wait or refuse, and only
  the next front door's start is delayed (its legacy core exits 3 and is retried for the shutdown budget plus 10 s).
- The import takes `run/core-legacy.lock` only where `run/` exists and a restore only where the lock file exists (a
  refused restore must leave the home byte for byte as it was): a legacy core creates both before it opens a store, so
  only the very first legacy core on a home, in the moments between its spawn and its lock, is not excluded.
- A legacy core that hangs keeps the lock, and with it every later start, until it is killed: the process binding of
  P4-10 S-M4 (security review M4) covers that.

Reproduction (now the regression tests): `packages/core/test/lock.test.ts` (a stock core refused while a legacy core
holds its lock), `packages/core/test/import/single-writer.test.ts`, `packages/core/test/core-front-door.test.ts` (the
abandoned start) and `crates/plur1bus/tests/backup.rs` `restore_refuses_while_a_legacy_core_still_holds_its_lock`. The
window itself ends with the legacy core (P4-90).

## P4D-6 — the legacy core's pipe on Windows

The front door's own pipe gets the explicit user-and-SYSTEM DACL (`plur1bus_rpc::server_transport`), which closes ADR-012
deviation C2 for `\\.\pipe\plur1bus-<hash>-core` with `core.impl: "rust"`. The legacy core's pipe
(`\\.\pipe\plur1bus-<hash>-core-legacy`) is created by Node and keeps its default security descriptor, as the TypeScript
core's own pipe does today.

- Contained for credentials and spoofing: the legacy core refuses every `core.auth` without `frontDoor.token`
  (`run/core-legacy.token`, 32 random bytes in the user-only run directory) and verifies the client's own credentials
  again; the front door checks that the pipe's server process is the legacy core it started
  (`GetNamedPipeServerProcessId`) after it connects and before it sends anything, and opens the pipe with
  `SECURITY_IDENTIFICATION`, so a squatter can neither read a credential nor impersonate the front door. Another account
  gets only read access to the pipe (no `FILE_WRITE_DATA`, no `FILE_CREATE_PIPE_INSTANCE`) and the legacy core writes
  nothing but replies.
- Not contained for availability (P4-10 security review L4): Node's default security descriptor lets other local
  accounts (and authenticated SMB clients; libuv passes no `PIPE_REJECT_REMOTE_CLIENTS`) hold any number of read-only
  instances open against the legacy core, each costing it a socket and a 30 s handshake timer; and a process that
  creates the predictable pipe name first makes the legacy core's first-instance bind fail, so the front door's start
  fails (the squat class of ADR-012 C2, reopened for this second name). Node offers no option that narrows a pipe's DACL
  (`readableAll`/`writableAll` only widen it).
- Fix: the pipe goes with the legacy core at P4-90 (no TypeScript patch, plan §4.2); until then this is accepted.

## P4D-7 — the front door's own log lines

The legacy core still writes `logs/core.log` (log-schema records: `core.process.started|ready|stopping`, `rpc listening`
and the rest), so `logs.query` and the log tools keep working. The front door writes its own diagnostics (`core ready`,
`connection limit reached`, a slow client disconnected, the legacy core's exit) as plain `plur1bus-core: <level>
<message> <fields>` lines to stderr: under the supervisor they land in `logs/core.out.log` with the child's other output,
not in `logs/core.log`. Two writers on `logs/core.log` (and its rotation) are not safe while the legacy core owns it.
`logs/core.log` also names the legacy core's own address (`run/core-legacy.sock`, 7 bytes longer than `run/core.sock`)
where the TypeScript core logs its address (`rpc listening`); that is the only line that differs in content between a
bare core's log and the legacy core's after a start and a stop of each, and why `logs.query`'s `scanned.bytes` differs by a
few bytes between the legs in G1.

- Fix: P4-11 ports the logger and the log store; the front door then writes log-schema records itself.

## P4D-8 — `String()` coercion of an API principal's `role` and `kind`

module-api's `validApiPrincipal` checks `roles.has(String(p.role))` and `["person", "agent"].includes(String(p.kind))`, so a
one-element array (`"role": ["owner"]`, also `[["admin"]]`) passes as that string; the Rust port in
`crates/plur1bus-core/src/auth.rs` requires a string and refuses the delegation (`E_UNAUTHORIZED`, reason
`api-delegation`). The front door therefore refuses a delegation the legacy core would accept. Only the harness API, which
holds the delegation token, can present a principal, and it builds `role` and `kind` as strings, so no shipped client
sends the lax shape. The Rust side stays strict (fail closed); the TypeScript check is the defect (ported, not patched).

- Vector: `fixtures/parity/auth/module-api.json` (`scripts/parity/export-auth.ts`), the cases noted `P4D-8`
  (`principal-role-in-an-array`, `principal-kind-in-an-array`, `principal-role-in-nested-arrays`); every other case gives
  module-api's verdict on both sides (`auth::tests::the_ported_checks_give_module_apis_verdicts`).
- Fix: P4-12, where the API principal moves to Rust, keeps the strict check and records it as the contract.

## P4D-11 — `stopping` before the answer to an accepted `core.shutdown`

(P4D-9 and P4D-10 are taken by fix round 1, part 2.) When the legacy core accepts a client's `core.shutdown`, the front
door enters `stopping` and queues `core.state stopping` to every owner subscriber before it forwards the accepted answer
(P4-10 task review M2, ADR-012 §3 G17: no subscriber may lose `stopping` to a link the legacy core ends right after its
answer). On the requester's own connection, when it is an owner subscriber too, `core.state stopping` therefore arrives
before the answer; a TypeScript core answers first and stops on the next turn (`core.ts`, `setImmediate`). Intentional:
the G17 order over the answer order. Both arrive, no content differs, and core-parity compares a connection's
notifications as a multiset, so no gate sees it.

- Reproduction: `crates/plur1bus-core/tests/front_door.rs`
  `a_client_shutdown_reaches_every_subscriber_as_stopping_first`, the assertion on `first` (the requester's first line).
- Owner: P4-12, which owns the process state in Rust, keeps or reverses the order and records it.
