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
| P4D-9 | A line of the legacy core longer than 4 MiB ends the client's connection | `packages/module-api/src/rpc-server.ts` (reference) | info | P4-12 | open |
| P4D-10 | A home whose `run/core-legacy.sock` exceeds the OS's socket path length is refused | `packages/core/src/core.ts` | info | P4-90 | open, refused with a clear message |
| P4D-11 | An accepted `core.shutdown`: the requester sees `core.state stopping` before the answer | `packages/core/src/core.ts` | info | P4-12 | open, intentional |
| P4D-12 | `plur1bus-store` opened stores with foreign keys off; node:sqlite has them on | `crates/plur1bus-store` (P4-03) | data-loss | P4-12 | closed in P4-12 PR 1 (found before any store was flipped) |
| P4D-13 | Identity service: lifetimes, counters and back-fill records as they are | `packages/core/src/identity/service.ts` | low | P4-12 | open, ported as it is |
| P4D-14 | Identity codes, principals and invite origins: lenient and lossy edges | `packages/core/src/identity/{codes,principals,invite-token}.ts` | low | P4-12 | open, ported as it is; `parse_origin` Rust strict |
| P4D-15 | The limiter keeps counting during a lock | `packages/core/src/identity/ratelimit.ts` | info | P4-12 | open, ported as it is |
| P4D-16 | Admin store: `setRight` without a transaction and without a version for a user without a role row | `packages/core/src/identity/admin-store.ts` | low | P4-12 | open, ported as it is |
| P4D-17 | Desktop attach: a code is spent before its person is checked; an unknown device is `not-found` | `packages/core/src/identity/desktop-attach.ts` | info | P4-12 | open, ported as it is |
| P4D-18 | Guard: the memory fallback runs only after a token-scope denial; a call without `agentId` is a resource mismatch | `packages/core/src/rbac/guard.ts` | low | P4-12 | open, ported as it is; a throwing principal is denied in Rust |
| P4D-19 | Break-glass grants live in memory; `revoke` trusts the role on the principal | `packages/core/src/rbac/break-glass.ts` | low | P4-12 | open, ported as it is |
| P4D-20 | Audit lines: two writers of one file with different care; member order of nested objects | `packages/core/src/identity/audit.ts`, `packages/core/src/rbac/audit.ts` | info | P4-21 | open |
| P4D-21 | `authorize` on input the types forbid | `packages/core/src/rbac/authorize.ts` | info | P4-12 | open, ported as it is (pinned by vectors) |
| P4D-22 | Exposure and scanner: keyword boundaries, long runs, finding order | `packages/core/src/memory-sensitivity/scanner.ts`, `packages/core/src/privacy/doctor.ts` | low | P4-12 | open, ported as it is; finding order differs |
| P4D-23 | Card sensitivity: labels copied by content hash, a file without modes, the wall clock | `packages/core/src/memory-sensitivity/{service,store}.ts` | low | P4-12 | open, ported as it is; the clock is a parameter in Rust |
| P4D-24 | RPC surfaces of identity, admin and sensitivity: findings for the flip | `packages/core/src/identity/rpc.ts`, `packages/core/src/memory-sensitivity/rpc.ts` | security (one item), low | P4-12 | open; out of scope of PR 1 |

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
cannot keep an owner from its handshake (logged once as `unauthenticated connections at their limit`). A connection whose
`core.auth` has reached the credential check no longer counts and is never ended (fix round 1b F5): a handshake under way
is never ended to make room. Any other line before the handshake (answered `auth-required`, the connection stays open as
on the TypeScript server) leaves a connection counted and evictable (re-review N1), so chatty sockets cannot escape the
cap. At the connection limit the oldest such connection is ended instead of refusing the new one (F2). Running out of
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
- The import takes `run/core-legacy.lock` only where `run/` exists (a fresh home stays without `run/`); it holds
  `state/core.lock` for its whole run, which every core takes first, so a core that starts during the import is refused.
- A restore takes `run/core-legacy.lock` only where the file exists (a refused restore must leave the home byte for byte
  as it was), and it holds no other lock: it checks once that no supervisor and no core answers. On a home without
  `run/core-legacy.lock` (no core of P4-10 or later has started there yet, the typical restore into a fresh home), a core
  of either kind, stock or front door, that is started after those checks is not excluded for the restore's whole run
  and opens the stores while units are swapped in. The same window exists at the base for the stock TypeScript core (a
  restore never took `state/core.lock`); P4-10 only narrows it (every core of P4-10 or later leaves the file behind,
  stock cores included). The operator closes it: `plur1bus backup restore`'s help and its refusals say to stop the daemon
  or the `core run` process first and start no core until the restore has finished. The restore moves to the Rust core
  with P4-90, which can hold the core's own lock for the swap.
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

## P4D-9 — a legacy line longer than 4 MiB

The front door reads the legacy core's link with the same framing as a client's (`crates/plur1bus-core/src/frame.rs`,
`MAX_LINE` 4 MiB, module-api's `MAX_LINE_BYTES`): a line from the legacy core longer than that ends that client's link
and with it the client's connection (P4-10 security review I2). The TypeScript server writes its lines without a cap, so
a client of a TypeScript core alone gets such a line, and module-api's own client then refuses it (`LineTooLong`, it
reads with the same 4 MiB cap), so for every shipped client the outcome is the same: the connection ends. Only the
link of the one client ends; no other client's frames are touched (links are per client, lines are written whole).

- Reproduction: a fake legacy core that answers one request with a 5 MiB line; the client's connection ends, the next
  client is served.
- Owner: P4-12, where the server half moves to Rust, decides whether the core caps what it writes.

## P4D-10 — the legacy core's socket path is 7 bytes longer

On Linux and macOS the core's address is a Unix socket whose path must fit `sun_path` (107 bytes on Linux, 103 on macOS,
without the NUL). Behind the front door the legacy core listens on `run/core-legacy.sock`, 7 bytes longer than
`run/core.sock` (P4-10 security review I3): a home of 83 to 89 bytes on macOS (87 to 93 on Linux) works with
`core.impl: "ts"` and cannot work with `"rust"`. The front door checks both paths before it writes anything and refuses
the start with a message that names the socket and the limit (`run_files::check_socket_paths`, exit 1), instead of a
bind error of the legacy core. Windows pipe names are not limited this way.

- Reproduction: `crates/plur1bus-core/tests/front_door.rs`
  `a_home_too_long_for_the_legacy_socket_is_refused_with_a_clear_message` and the `run_files` unit test
  `a_home_too_long_for_the_legacy_socket_is_refused_by_name`.
- Owner: P4-90, when the legacy core and its socket go.

## P4D-11 — `stopping` before the answer to an accepted `core.shutdown`

When the legacy core accepts a client's `core.shutdown`, the front
door enters `stopping` and queues `core.state stopping` to every owner subscriber before it forwards the accepted answer
(P4-10 task review M2, ADR-012 §3 G17: no subscriber may lose `stopping` to a link the legacy core ends right after its
answer). On the requester's own connection, when it is an owner subscriber too, `core.state stopping` therefore arrives
before the answer; a TypeScript core answers first and stops on the next turn (`core.ts`, `setImmediate`). Intentional:
the G17 order over the answer order. Both arrive, no content differs, and core-parity compares a connection's
notifications as a multiset, so no gate sees it.

- Reproduction: `crates/plur1bus-core/tests/front_door.rs`
  `a_client_shutdown_reaches_every_subscriber_as_stopping_first`, the assertion on `first` (the requester's first line).
- Owner: P4-12, which owns the process state in Rust, keeps or reverses the order and records it.

## P4D-12 to P4D-24: what P4-12 PR 1 found

P4-12 PR 1 ports identity, RBAC and exposure as a library (nothing is flipped). TypeScript is frozen (D129), so what
looks like a defect is ported as it is and pinned by a recorded vector or sequence; the flip PR of P4-12 decides each
one. "Inventory n" refers to the numbered list of the P4-12 source inventory (controller notes of 2026-11-14). Vectors
and sequences live under `fixtures/parity/{rbac,exposure,identity,identity-store,identity-admin,rbac-guard,sensitivity}/`.

## P4D-12 — foreign keys were off where node:sqlite has them on

`crates/plur1bus-store` documented, since P4-03, that node:sqlite does not enforce foreign keys, and `StoreSpec::new`
turned enforcement off for every store whose TypeScript code does not set the pragma. Node 24 does the opposite:
`DatabaseSync` enables foreign key constraints unless told otherwise. Opened through the old default, the Rust core would
have accepted orphan rows that the TypeScript core refuses, in every store that relies on Node's default.

- Found: the recorded pragmas of `memory-sensitivity.sqlite` (the store never sets the pragma) show `foreign_keys` 1.
- Fix (this PR): `StoreSpec::new` has foreign keys on. Mode B asks Node: `tests/core-parity/store-b-driver.ts` records
  what node:sqlite does with an orphan row (`nodeForeignKeys`), and `crates/plur1bus-store/tests/mode_b.rs` holds the
  Rust default to it. `fixtures/parity/identity-admin/schema.json` (`node-default`) records the pragma as well.
- No store was flipped before the fix, so nothing ran with enforcement off.

## P4D-13 — identity service

Ported as it is; sequences `fixtures/parity/identity-store/scenarios.json`.

- Inventory 10: `confirm_by` of a claim is `min(claim + lifetime, code end)` when the code's lifetime is shorter than the
  default and `claim + default` otherwise, so a claim on a 60-minute invitation code can be confirmed after the code has
  ended (scenario `expiry-and-confirm-window`). Every successful issuance is counted with the limiter's `failure`.
  `reserveBackfill` and `finishBackfill` check no authorization and run in no transaction (the back-fill checks before it
  calls them).
- Inventory 9: pending pairings live in a `TEMP` table and are gone after a restart (scenario
  `reopen-prune-and-newer-schema`); the invitation row in `admin.sqlite` stays unrevoked.
- A configured `codeTtlMs` is also the ceiling of a per-code lifetime: below one minute every explicit lifetime is refused
  (scenario `validation`). A fractional value makes every insert fail in the `INTEGER` column; `core.ts` never passes one.
  Rust takes whole milliseconds (`Option<i64>`).
- The audit's second name is looked up in an object literal, so an action named like an inherited member
  (`constructor`) would find a function. Rust looks up the six names only. No producer uses such a name.
- For the flip: `startPairing` reads `input.ttlMs ?? codeTtlMs`, so a JSON `null` means the default; the adapter has to
  hand `None` over for `null`, not refuse it. The back-fill is exclusive in Rust because `Backfill::run` holds the service
  mutably while a synchronous engine port runs; an engine port that awaits, or a second `Backfill` value, needs TypeScript's
  `busy` set again (`conflict`, "backfill already in progress"): the record's state check alone lets a second run through.
- The typed Rust API takes strings; an argument that is not a string is refused where JSON is decoded (flip PR), with the
  same `invalid-params` text.
- `link` writes the `link.requested` audit event before it checks that the human exists (scenario `validation`).

## P4D-14 — codes, principals, invite origins

Ported as it is; vectors `fixtures/parity/identity/`.

- `normalizeCode` is `toUpperCase()`: `ſ`, `ß`, `ﬀ`, `ﬂ`, `ﬄ`, `ﬅ`, `ﬆ` become alphabet letters, so a code can be typed
  with them. Same code, not a different one.
- `hashesEqual` decodes hex leniently (`"zz"` equals `"yy"`: both decode to nothing). Stored hashes are always 64 hex
  digits, so no stored value is affected.
- `deriveUserPrincipal` hashes the UTF-8 of the id; a lone surrogate becomes U+FFFD, so two ids that differ only in a
  lone surrogate derive the same principal. Harness user ids are UUIDv7.
- `uuidv7` draws its random bytes before it checks the timestamp; `NaN` is timestamp 0.
- **Rust strict:** `parse_origin` refuses a host with an `xn--` label; TypeScript's `URL` accepts valid Punycode. The
  crate carries no IDNA tables (no new dependency in PR 1). 120 vector cases pin the refusal. An installation whose
  public origin is an IDN in Punycode form could not mint invite links after the flip: the flip PR decides.

## P4D-15 — the limiter

`failure` keeps counting during a lock (from 0, with the window restarted at the locking failure); the limit-th failure
inside a lock extends it. `release` lifts a running lock and sets the count to `limit - 1`. Ported as it is; vectors
`fixtures/parity/identity/limiter.json`, sequences `claim-limits`, `issuance-limits`, `claims-per-human-and-release`.

## P4D-16 — admin store

Inventory 16: `setRight` is two statements without a transaction, and its version bump changes nothing for a user
without a role row, so desktop credentials of such a user are not invalidated by a rights change. Removing a right that
is not there still moves the version. Ported as it is; sequence `agent-rights` of
`fixtures/parity/identity-admin/admin.json`.

## P4D-17 — desktop attach

`redeem` spends the code (`DELETE ... RETURNING`) before it compares the person's version, and before the device store
may refuse the key: a failed enrolment needs a new code. `resolve` asks the device store before it looks at the
credential row, so an unknown device is the device store's `not-found`, not `denied`. Ported as it is; sequences
`person-version-and-audit-sink` and `issue-redeem-authenticate` of `fixtures/parity/identity-admin/attach.json`.

## P4D-18 — the guard

Ported as it is; vectors `fixtures/parity/rbac-guard/guard.json`.

- Inventory 4: the memory fallback of `memory.recall`, `memory.capture` and `external.turn.*` runs only when the rule's
  own decision is a token-scope denial, not for every denial.
- Inventory 5: these rules build their resource from `agentId`; a call that names no agent is `resource-mismatch` before
  any scope is looked at. The fallback's "agent the token is bound to" is therefore never reached (layer `fallback`:
  every case with empty parameters is `resource-mismatch`).
- Inventory 17: `users.delete` and `ownership.transfer` have a policy row and no rule.
- Inventory 18: the authenticated principal is kept per call context and removed when the handler returns; a guarded
  handler that called another guarded handler with the same context would lose it. PR 1 ports the decision, not the
  wrapper; the flip decides how the handler gets the principal.
- **Rust strict:** where TypeScript's `authorize` throws a `TypeError` on a malformed principal (a `null` rights table,
  scopes that are not an array), the Rust guard denies it as `invalid-principal`. No vector reaches it. The denial also
  writes an `rbac.denied` line, where TypeScript throws before it writes one.
- RY-B (D134) adds a second fallback, ported with it (layer `job-grants`): while the host says job grants are in force, a
  denied `dreams.diary` of a person is decided as `agent.use`, and a denied `grant.create` or `grant.list` for the
  capability `memory.jobs.run` or a denied `grant.revoke` as the person's own job grant (`grant.jobs.write` on the agent,
  `grant.jobs.read`). The new decision replaces the rule's denial whether it allows or denies, and `grant.revoke` takes
  this path for any grant id. The guard therefore lets a Member through to `grant.revoke` and a person with `use` through
  to `dreams.diary`; which grant and whose diary is the handler's check, not the guard's. The audit line of a denial
  still names the rule's action.

## P4D-19 — break-glass

Inventory 11: grants live in memory, so a restart ends every grant without a `break-glass.expired` audit line while its
notice stays in `admin_notices`; `revoke` decides "holder or Owner" from the role on the principal it is handed. Ported
as it is; sequences `fixtures/parity/rbac-guard/break-glass.json`.

## P4D-20 — audit lines

- Inventory 12: the identity writer appends without `fsync` and without tightening an existing file; the RBAC sink does
  both, on the same `logs/audit.log`. Both are ported as they are (`identity::audit`, `rbac::audit`); the lines are
  compared byte for byte (`fixtures/parity/rbac-guard/audit.json`).
- The Rust line keeps the producer's order of the detail's members and JavaScript's rule for integer-like keys. An
  object nested inside a detail has no recorded member order in `serde_json`: its keys are written integer-like first,
  then in code-unit order. No current producer nests an object.
- The CLI's own audit lines (`crates/plur1bus/src/audit.rs`) are written with all keys sorted; that predates Phase 4.
- Owner: P4-21, which moves the hash chain behind one writer.

## P4D-21 — `authorize` on input the types forbid

A rights table that is a string or an array answers for index keys; scope lists with a non-string element throw only
when the element is reached; break-glass timestamps are coerced (`"900000"`, `true`, `null`); a role that lists `own` and
`break-glass` reports `break-glass-required`, never `not-owner`. All of it is reproduced by `authorize_js` and pinned by
`fixtures/parity/rbac/` (P4-12 task 1). The typed `authorize` cannot be handed such input.

## P4D-22 — exposure and scanner

- The keyword patterns use an ASCII-only `\b`: `überweisung` does not match at the start of a word, only after a word
  character. A run of 43 or more `[A-Za-z0-9_-]` is a credential. Text and summary are joined, so a keyword may span them.
  Ported as it is; `fixtures/parity/exposure/`.
- `filterSensitiveBlocks` asks for manual categories twice; a service whose answer flips in between returns nothing.
- **Differs:** the local-only doctor findings come out in sorted key order (`serde_json`), not in the order of
  `Object.entries`. The findings are the same.

## P4D-23 — card sensitivity

Ported as it is; sequences `fixtures/parity/sensitivity/scenarios.json`.

- Inventory 14: a card with identical content copies an earlier record including a `manual` source; a manual label
  survives a content change.
- Inventory 3 (store side): `set` without card text and without a record stores a manual label with content hash `""`.
- Inventory 15: `memory-sensitivity.sqlite` is created without the private directory, the file mode or `securePath`
  the other three stores apply.
- Inventory 13: the TypeScript store reads the wall clock; the Rust store and service take the time as a parameter.
- `clear(id, "")` deletes the whole record (`!category`); clearing a category the record does not have rewrites it.
  A category a model hook returns is stored unchecked. `getByHash` with equal timestamps returns what the query plan
  returns first (recorded; not a guarantee).

## P4D-24 — RPC surfaces (for the flip)

Out of scope of PR 1 (`identity/rpc.ts`, `rpc/identity-surface.ts`, `rpc/admin-surface.ts`, `memory-sensitivity/rpc.ts`);
recorded so the flip PR starts with them.

- Inventory 2 (**security**): without `engine.memory.show` the ownership check of `memory.sensitivity.*` returns without
  checking anything, and it falls back to the unauthenticated `ctx.principal` when the guard set none.
- Inventory 1: the legacy `identity.*` family builds its actor from the client's `caller` and gives role `owner` to any
  caller with channel `cli`; the audit actor is the caller's claim.
- Inventory 3 (surface side): `memory.sensitivity.set` audits after the write.
- Inventory 6: `expiresInMinutes` is capped at 60, `ttlMinutes` at 43,200; a break-glass reason may be 10,000 characters
  at the surface and 500 in the registry; `userId` 256 against 128.
- Inventory 7: `user.list` sorts with `localeCompare`; the stores order by bytes.
- Inventory 8: `user.invite.create` writes `identity.sqlite` and `admin.sqlite` without a shared transaction.
- Inventory 19: `identity.link.*` decides "self or Owner/Admin" from a string list instead of `authorize`.
