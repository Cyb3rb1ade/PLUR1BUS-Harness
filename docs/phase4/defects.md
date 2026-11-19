# Phase 4 defect ledger

Plan: `docs/superpowers/plans/2026-11-07-phase4-ts-core-to-rust.md` §4.2 (pull forward on defect) and §3 (parity). Besides
recorded owner decisions, an entry here is the only allowed divergence between the TypeScript core and the Rust core: a
defect found in TypeScript (patched there only with an explicit owner exception), or a difference the Rust front door introduces on purpose and that
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
| P4D-7 | The front door's own diagnostics are plain stderr lines, not log-schema records in `logs/core.log` | `packages/core/src/logger.ts` | info | P4-11 | closed (P4-11 flip, first PR): the lines are in `logs/core.log` in the transitional line format |
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
| P4D-25 | A method the front door serves itself is not counted by `GET /metrics` | `packages/core/src/metrics/`, `packages/module-api/src/rpc-server.ts` (reference) | info | P4-43 | open (five methods native since P4-12 flips A1 and A2, `logs.query` since P4-20 flip A, six `secret.*` methods and the engine's `host.secret.get` since flip B2) |
| P4D-26 | A retired secret value that is registered again keeps its old place and can fall off the bound | `packages/core/src/secrets/redaction.ts` | low (a value still in use is unmasked only after 256 newer retired values) | P4-20 | fixed in Rust (library); the TypeScript registry is unchanged |
| P4D-27 | The order of `secret.list` and `secret.status` depends on the locale of the process | `packages/core/src/secrets/{store,file-backend,keyring-backend,memory-backend}.ts` | info | P4-20 | fixed in Rust (library): the ICU root order for the characters a name can hold |
| P4D-28 | Two processes can write the secret store without a lock between them | `packages/core/src/import/supervised-entry.ts`, `packages/core/src/secrets/file-backend.ts`, `keyring-backend.ts` | low (a lost update while an import runs; not reproduced) | P4-85 | open |
| P4D-29 | The engine may resolve any stored secret; five `secret.*` methods have no RBAC row | `packages/core/src/engine/host-methods.ts`, `packages/core/src/rbac/guard.ts` | security (scoping), info | P4-20 | open; flip B2 keeps the answer of today (R-20-32) |
| P4D-30 | Findings in the secret store, ported as they are | `packages/core/src/secrets/` | info | P4-20 | open; the vectors pin them |
| P4D-31 | What a Rust secret store cannot read or hold that JavaScript can | `crates/plur1bus-core/src/secrets/` | info | P4-20 | open (by nature) |
| P4D-32 | The keyring backend: a half-written `put`, foreign members in an answer, and the helper's own wire | `packages/core/src/secrets/keyring-backend.ts`, `crates/plur1bus-core/src/secrets/` | low | P4-20 | fixed in Rust (first item); the rest noted |
| P4D-33 | `logs.query` served by the front door: one refusal the TypeScript core does not have, two bounds on retired values | `crates/plur1bus-core/src/{native,redaction_mirror}.rs`, `packages/core/src/secrets/redaction-feed.ts` | low | P4-20 | open by design until the Rust core owns the registry (flip B and the packages after it) |
| P4D-34 | Without a Secret Service the TypeScript keyring falls back to the kernel keyring and reports itself available | `packages/core/src/secrets/keyring-backend.ts` (`@napi-rs/keyring` 2.1.0) | medium (secrets that are gone after a reboot, on a Linux host without a Secret Service) | P4-20 | not in Rust (Secret Service only); fixed in TypeScript too (owner decision D136: every entry is pinned to the Secret Service) |
| P4D-35 | macOS: a keychain item belongs to the program that made it; another program's read waits for the user | the login keychain (`node` made the TypeScript core's items, the Rust helper is another program) | medium (macOS, when the store's owner changes) | P4-20 | open; the items move before the front door is the default (R-20-4) |
| P4D-36 | The secret store behind the bridge: what the legacy core's bridge store does differently from the TypeScript store | `packages/core/src/secrets/bridge-store.ts`, `crates/plur1bus-core/src/{bridge,secrets_owner}.rs` | low | P4-20 | open; flip B2 takes the owner's six methods and the engine's off the bridge store, the rest ends with it (P4-90) |
| P4D-37 | The native `secret.*` methods and `host.secret.get`: a lease count of one process, a notice that can fail, one error for every failure of the engine's method, no bound on the engine's calls at the store's lock | `crates/plur1bus-core/src/native_secrets.rs`, `packages/core/src/secrets/bridge-store.ts`, `packages/core/src/engine-host-ports.ts` | low | P4-20 | open; the first two end with the bridge store (P4-90), the third is ported as it is |
| P4D-38 | The native methods of the front door ran past an import maintenance | `crates/plur1bus-core/src/{native,lib}.rs`, `packages/core/src/import/maintenance-admission.ts` | low (a write the maintenance should have held, on an installation that runs the front door, which is not the default) | P4-20 | fixed (R-20-34); open: after the release the front door relays until it is started again |
| P4D-43 | File mutation must wait for handle verification | `packages/core/src/policy/paths.ts` | security (file integrity) | P4-21 | fixed in TypeScript under the owner exception |

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

Closed with the first PR of the P4-11 flip. What it was: the legacy core wrote `logs/core.log` alone, and the front door
wrote its own diagnostics (`core ready`, `connection limit reached`, a slow client disconnected, the legacy core's exit)
as plain `plur1bus-core: <level> <message> <fields>` lines to stderr only; under the supervisor they landed in
`logs/core.out.log` with the child's other output, where `logs.query` on the `core` role does not look.

What holds now (`crates/plur1bus-core/src/front_log.rs`):

- Every such line is also a line of `logs/core.log`, in the transitional format most of the legacy core's own lines
  still have, marked with `src`: `{"at":…,"level":…,"role":"core",<fields, among them "src":"front-door">,"msg":…}`. The
  stderr line stays as it was.
- Both processes write through the role's native lock (`core.log.writer-lock`), which the Rust sink and the TypeScript
  sink share, so a line is never torn and rotation is one writer's at a time. `tests/core-parity/p4-11-log-writers.ts`
  drives both at once through a rotation and counts the lines (nightly, with the parity step).
- No caller in the front door waits for the log: lines are queued for a thread of the log's own, a full queue is
  counted, a repeated `warn` or `error` message is written once per second with the number of its repetitions, and
  opening and closing the log are bounded (`docs/logging.md`).
- The level is `core.logLevel` and the rotation `logs.maxBytes` / `logs.keep`, from config.json at the start and from
  the configuration source afterwards (the supervisor's `config.watch`, or the file when no supervisor answers).
- The catalogue events of the process (`core.process.started`, `.ready`, `.stopping`) and `log.level.changed` stay the
  legacy core's until the cut, so each appears once.

What is left, by design until the cut:

- A level set at run time through `logs.levels` reaches the legacy core's writer only; the front door follows the
  configuration alone. The front door's lines are few (start, stop, limits, a lost lifeline) and nearly all `info` or
  `warn`.
- The front door registers no secret with its writer: it holds none beside the handshake credentials, which it never
  logs; the writer's standing redaction applies as to every line.
- `logs/core.log` names the legacy core's own address (`run/core-legacy.sock`, 7 bytes longer than `run/core.sock`)
  where the TypeScript core logs its address (`rpc listening`), and now carries the front door's lines as well; that
  is why `logs.query`'s `scanned.bytes` differs between the legs in G1 (an expected place there).

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
- Flip A1 (first native methods, owner connection only): `breakglass.notices` and `identity.principals` are served by
  the front door behind the native guard. Not flipped, with the reason:
  - `user.role.set`, `user.disable`, `user.enable`: flipped with A2, below.
  - `user.list`: Inventory 7 above; without the same collation no flip.
  - `agent.rights.get`, `agent.rights.set`: they read the agent table of the configuration and the lifecycle store,
    which is not ported.
- Flip A1, what differs from the TypeScript core on purpose or by construction:
  - The front door never creates `state/admin.sqlite` or `state/identity.sqlite` (the legacy core does at its start).
    Without `admin.sqlite` a native call is refused as `resolver-failed`; without `identity.sqlite`
    `identity.principals` answers `E_NOT_AVAILABLE` "identity unavailable". Neither state exists once the legacy core
    is ready.
  - A hash-chain record written by the front door has its members in key order (as the CLI's records), the TypeScript
    core's in the order it builds them. The chain hashes the line as written, and the TypeScript verifier accepts a
    chain both extended in turn (`tests/core-parity/p4-12-native.ts`). The `logs/audit.log` lines are the same bytes.
  - An audit event one of its two places did not take is a `warn` line of the front door ("audit event not
    recorded", with the sink and the chain's short code); the TypeScript core raises an owner notice for a chain
    refusal. The legacy core's audit health check reads the same files and still raises its notices.
  - A stored role outside the five presets (the table's `CHECK` forbids it) would resolve to the fallback role here
    and to a role `authorize` denies in TypeScript.
- Flip A2 (the first native writes, owner connection only): `user.role.set`, `user.disable` and `user.enable` are served
  by the front door. The TypeScript handlers are followed by `api.account.changed` to the API service connections
  (`rightsChanged`) and by the learner's `reconcile` (`dreams/learn/lifecycle.ts`); both stay in the legacy core, and
  the front door asks for them after its commit with `legacy.account.changed` on its control link
  (`docs/phase4/bridge.md`). What differs from the TypeScript core on purpose or by construction:
  - Two processes now write `state/admin.sqlite`. The rule that an active Owner always remains is checked inside the
    store's write transaction and holds whichever process writes (`front_door.rs`, two processes;
    `tests/core-parity/p4-12-native.ts`, the TypeScript store against the core). The front door also checks its
    handler's rules about the person it changes a second time inside that transaction, on the row read there, and
    audits the role found there (`set_role_checked`, `set_disabled_checked`); the TypeScript handler reads the person
    once, before its store call, so with the other process writing in between its event can name an older `previous`.
    The caller's own role is read once, by the guard, in both cores: a change of the caller's role by the other
    process during a call is not seen by that call. Reach: an Owner or Admin whose own role another administrator
    changes in the same millisecond; severity low; it ends when one process writes the store (P4-90).
  - The follow-ups run in another process. A `legacy.account.changed` the legacy core refuses is sent once more. One
    it does not answer within five seconds is not repeated: the request is in the legacy core's queue and runs when
    its event loop gets to it. In both cases the change stands (as nothing after the commit undoes it in TypeScript)
    and the front door logs a line, at `error` when a change of rights is concerned. The API services are not told
    only when the legacy core refuses twice or goes away before it serves the request; harness-api then keeps a
    session of that person until its own next check. Not reproduced outside the tests that force it.
  - One native call runs at a time: a write holds the store's mutex while it reads `identity.sqlite`, appends the
    audit event and waits for SQLite's write lock (each bounded by five seconds or the chain's lock wait). Another
    owner connection's native call waits that long at most; relayed calls do not wait.
  - As in TypeScript the audit event is written before the commit: a commit that then fails leaves an event for a
    change that did not happen, and the call reports `E_STORAGE`.
  - Once the control link has ended, a write method is refused with `E_NOT_AVAILABLE`, reason `stopping`, before
    anything is stored. The TypeScript core has no such state; the link only ends when the legacy core goes away.
  - A client's request under `legacy.*` is `method-not-found` for every caller. A TypeScript core answers an engine
    connection `engine-method` and runs an API connection's admission before it looks the method up; a refusal either way.
  - A lone surrogate escape in `reason` reaches the audit event as U+FFFD (the front door reads a native call's
    parameters with its tolerant reader); the TypeScript core keeps it and `JSON.stringify` writes the escape.
  - The legacy core counts `legacy.account.changed` in `plur1bus_rpc_calls_total` (a new `method` label value while the
    front door serves these methods); the native calls themselves are P4D-25.
- Flip A3 (a person behind the harness API): the five native methods are also served by the front door for a request
  of an API connection whose delegation names a person and is the delegation of the connection's handshake (same user
  id, kind and transport). The person is resolved as `resolvePrincipal` and `apiIdentities` resolve her: disabled is
  `person-disabled` (not audited), unknown to the store is nobody, and the stored role and agent rights replace the
  claimed ones; token scopes, project rights and the binding are the delegation's. Not served natively, and relayed
  byte for byte as before: the API service itself (no principal), an agent the API acts for, a request without a
  delegation, and a request whose delegation names another identity or transport (the legacy core refuses those on the
  link: `api-principal-required`, `api-identity-change`, `api-transport-change`). Scoped clients and the engine stay
  relayed. What differs from the TypeScript core on purpose or by construction:
  - Two processes decide about one API connection: the front door for the requests it serves, the legacy core for the
    rest. Both read the same store for every request, and the front door serves only what carries the handshake's
    identity, which the legacy core accepted; there is no request the front door serves that the legacy core would
    have refused for its identity.
  - The front door keeps the handshake's identity of an API connection (`ApiBinding`: user id, kind, transport). After
    a second `core.auth` on the connection it keeps the latest one the legacy core accepted; the legacy core refuses a
    second handshake that names another identity, so the two cannot differ.
  - `apiIdentity.forwarded` refuses an API handshake while the core stops (`E_NOT_AVAILABLE`, `stopping`); that is the
    legacy core's answer on every leg, the handshake is always relayed.
  - module-api stores an API connection's delegation again on every request (`c.api = delegated`,
    `onApiAuthenticated`). A request the front door serves itself never reaches it, so the legacy core's picture of
    that connection is the one of its last relayed request (or the handshake): the same user id and kind, possibly
    older token scopes. The native methods do not read that picture; what in the legacy core does (the audience of an
    event for the connection) reads the user id.

## P4D-33 — `logs.query` served by the front door

P4-20 flip A. `logs.query` is answered by the front door for the owner connection and for a person behind the harness
API (the rules of P4-12 flip A3), with the handlers of P4-11 and a redactor over the mirror of the legacy core's
registry (`docs/phase4/bridge.md`, "The redaction feed"). `logs.tail` and `logs.levels` stay with the legacy core: the
first follows the legacy core's own writer, the second changes it. What differs from the TypeScript core's answer:

- **One refusal the TypeScript core does not have.** When the front door cannot bring its mirror in step inside a call
  (it gives up after five seconds, or when the call to the legacy core that is under way then has ended, which may be
  five more), it answers `E_NOT_AVAILABLE`, reason `redaction-sync`, and relays the method from then on until the
  mirror is in step again. It never answers with fewer masks than the legacy core would apply. The refusal goes to the
  calls that were already taken on when the mirror fell out of step, usually one; a retry is served by the legacy
  core. Parameters the method refuses are refused first, as in the TypeScript core.
- **The start waits for the mirror.** The ready line comes after the first pass over the feed. With a legacy core
  that does not answer the feed that is up to five seconds later than before (up to fifteen with one that answers
  slowly and keeps saying more is waiting).
- **Two bounds on retired values.** Each process keeps the newest 256 values that are no longer held. The front door
  hears a value when it retires and keeps its own list in the same order. After a new epoch the front door's list
  also holds what only the old epoch held, as its oldest entries: it then masks more than the legacy core, never
  less, until 256 newer retirements have displaced them. Values a name or a group holds are never affected.
- **A value is masked here a moment later than there, never in an answer.** The front door's own log lines are masked
  with what the follower has heard; a line it writes in the instant between the registration in the legacy core and
  the follower's answer is not masked with that value. The front door writes no client content and no value into its
  lines, so nothing is known to reach one. An answer of `logs.query` holds every value that was registered before
  the call began (it catches up first); a value registered while it reads may be masked in it or not, as in any two
  calls that run at the same time.
- **The feed costs one call per query.** Every native `logs.query` asks the legacy core once before it reads (no wait,
  one frame each way).
- **Not counted** by `GET /metrics`, like every native call (P4D-25).

Found on the way, in this change's own code: the follower asked a stopping legacy core in a tight loop (a stopping
core answers at once). Fixed before the merge (a rest after an empty answer that did not wait); the three-leg run
checks the number of calls.

## P4D-25 — native calls are invisible to the legacy core's counters

`GET /metrics` is served by the legacy core until P4-43 and counts the calls its own RPC server dispatched. A call the
front door serves itself (`route::NATIVE`) never reaches that server: it is missing from `plur1bus_rpc_calls_total`
(and `plur1bus_rpc_connections_open` counts the legacy core's links, not the clients). The log keeps its lines: the
front door writes the TypeScript server's `rpc error` line (`error`, `reason`) for a native call it refuses, with
`src: "front-door"`; the `ok` line at `debug` is not written.

- Reach: `breakglass.notices` and `identity.principals` (P4-12 flip A1), `user.role.set`, `user.disable` and
  `user.enable` (flip A2), on the owner connection and, since flip A3, for a person behind the harness API (the calls
  the web interface makes); `logs.query` since P4-20 flip A; every later flip adds its methods.
- Since P4-20 flip B2, while the front door owns the secret store: `secret.status`, `secret.list`, `secret.get`,
  `secret.describe`, `secret.set` and `secret.delete`, and `host.secret.get` on the engine's connection. The last
  one matters to whoever watches for an engine that reads more secrets than it should (P4D-29): its rate is no
  longer in `plur1bus_rpc_calls_total`. What counts every such read is `logs/audit.log` and the chain: each
  `host.secret.get` that reaches the store leaves a `secret.lease` with the name (actor `core`, purpose
  `memory-engine`) and a `secret.lease.revoke`, each reveal a `secret.reveal`, each refusal a `secret.denied`,
  written by the front door as the TypeScript core wrote them. A watch on secret reads belongs on those records
  until P4-43.
- Fix: P4-43 moves the dispatcher and with it the counters; the front door then counts every call. Until then a
  dashboard that sums RPC calls undercounts by the native ones.

## P4D-26 — a retired value registered again

`createSecretRedaction` keeps the values no store name holds any more ("retired") in insertion order and bounds them to the
newest 256. `addAnonymous` returns early for a value that is already retired (`redaction.ts`, `if (... retired.has(value))
return`), so a value that is registered again and again without a name keeps the place of its first registration. Once
256 newer values have retired it leaves the set while it is still in use, and from then on it is not masked. The log
writer's own registry (`logs/writer.ts`) moves such a value to the end; the two disagree.

- Rust (`plur1bus_core::logs::redact::SecretSet`): a retired value that is registered again moves to the newest place.
  Nothing else differs; `values()` is the same set in another order after such a registration.
- Vector: `fixtures/parity/secrets-store/registry.json`, scenario `a-retired-value-registered-again` records the
  TypeScript order with a `note`; `a_retired_value_registered_again_is_the_newest_one` pins the Rust behaviour.

## P4D-27 — the order of secret names

`list` and `status` sort with `a.name.localeCompare(b.name)`, that is with the collation of the process's default locale.
For the characters a secret name can hold the ICU root collation gives `_ - : . @ /`, then digits, then letters, lower case
before upper case only when everything else ties; a process started under another locale (a tailoring that reorders
letters or contracts `ch`) lists the same names in another order.

- Rust (`secrets::backend::compare_names`): the root order, fixed. A vector of 814 names recorded with `localeCompare`
  pins it (`fixtures/parity/secrets/name-order.json`).

## P4D-28 — two writers, no lock

Writes are ordered inside one process only (a promise chain per backend and per store). `store.json` is replaced
atomically, and the keyring index is one entry, but nothing excludes a second process between its read and its write. The
supervised import child builds its own store over the same files and the same keyring service
(`import/supervised-entry.ts`): a `secret.set` in the core and a secret migration of a running import can lose one of the
two updates. Not reproduced.

- The same holds for the first write of a store. The key file is started over when it is empty or short and the store
  has no entry yet (a crash between creating and writing it); a second process that looks at that moment removes the
  first one's key file while it is still empty, and the first one's entry can then never be read (`corrupt`).
- Reach: while an import with source secrets runs. The Rust store keeps the single-owner rule of the P4-20 cut (the front
  door alone opens the file and the keyring while it runs); the import child stays as it is until P4-85.

## P4D-29 — who may resolve which secret

- **`host.secret.get` has no scope** (security). The handler checks that the caller is the engine and then leases whatever
  well-formed name it is asked for (`engine/host-methods.ts`, `createEngineSecrets`). ADR-005 asks for fail-closed
  scoping per agent or profile; a compromised engine process can read every stored secret, not only the provider keys
  its configuration references. The lease is audited (`secret.lease`, `secret.lease.revoke` as `core`).
- **No RBAC row** (info). `secret.status`, `secret.list`, `secret.set`, `secret.get` and `secret.delete` are not in
  `RPC_RULES`; only the store's owner gate and, for writes and reveal, the surface floor apply. `secret.describe` and
  `secret.grants.list` have rows, and the store then refuses an admin the policy allowed. The `secrets.*` action rows of
  `rbac/policy.ts` are not referenced by any handler.
- **The surface floor covers `set`, `describe`, `reveal` and `delete`, not `lease` and `readLease`** (info). Both are
  in-process only (there is no RPC for a lease). An owner principal without a surface is an in-process caller and passes
  the floor: the flip builds an owner principal with the level of the connection, never without one.

Both are decided before flip B (the package cut names them as check points): the native `host.secret.get` either
keeps the answer of today or narrows it to the names the configuration references.

Flip B2 keeps the answer of today (ruling R-20-32): the front door's `host.secret.get` leases whatever well-formed
name the engine asks for, as the TypeScript handler does, and the five methods have no row in the Rust table either.
The entry stays open.

## P4D-30 — findings in the secret store, ported as they are

Each is pinned by a vector of `fixtures/parity/secrets/` or `fixtures/parity/secrets-store/`.

- `status()` and `list()` write: they bring the keyring in line with the file and audit that as `core`. Five callers use
  `status()` as a read.
- The schema's `maxLength` of `secret.set.value` counts characters, the store counts 65,536 UTF-8 bytes; the schema allows
  a `host.secret.get` name of 256 characters, the store 128, and the handler never returns the `null` the schema allows.
- `put` of the memory and the file backend stores a description as given, `describe` stores it trimmed; the file
  backend's `describe` answers with the stored entry, so a member this version does not know rides along in the answer.
- `leases.ts`: the `revoked` flag is never set. `audit.ts`: a cut at 128 code units can leave half of a surrogate pair.
- `file-backend.ts` calls the key file "machine-bound"; nothing binds it to the machine (who reads both files decrypts,
  as its header says).
- `Buffer.from(text, "base64")` reads the low byte of every UTF-16 unit: a key file with U+0144 in it decodes as if it
  held `D`.

## P4D-31 — what the Rust store cannot read or hold

- A `store.json` that only `JSON.parse` reads (a lone surrogate escape, a number outside f64) is `corrupt
  (unreadable-store)` in Rust; neither implementation writes such a file.
- A timestamp that is not in the ISO form `toISOString` writes is read as 0 when two copies are compared; V8 accepts
  further forms, some of them in local time.
- A value, name or description with a lone surrogate cannot reach the Rust store (a Rust string is well-formed); the
  TypeScript file backend stores U+FFFD in its place. The `*_units` checks judge such input the way TypeScript does.
- `lease-invalid: the secret changed while the lease was being issued` cannot occur: the Rust store has one lock, so a
  lease never overlaps a write.
- A `store.json` nested deeper than 128 levels is `corrupt (unreadable-store)` (the parser's limit); in a member this
  version does not know, an integer beyond 2^53 or a number written as `1.0` is written back in another spelling than
  `JSON.stringify` gives. No entry member either implementation writes is nested or holds a number.
- The audit record of a lease whose `ttlMs` is `NaN`, infinite or beyond 2^53 (it is refused as `invalid-ttl` right after)
  carries no `ttlMs`, or another spelling of it. Only in-process callers give a ttl.
- Change listeners and registry sinks: the TypeScript ones run inside the call, in commit order. The Rust store tells its
  listeners after its lock is released (they may call the store); two operations on two threads may be told in either
  order. A registry sink runs under the registry's lock and must not call the registry or the store.

## P4D-32 — the keyring backend and its helper

Found while porting `keyring-backend.ts` and the helper process (P4-20). The vectors of
`fixtures/parity/secrets-store/keyring-backend.json` record the TypeScript side of the first two (the scenarios with a
`note`); `crates/plur1bus-core/src/secrets/keyring_vectors.rs` says what Rust does.

- **A `put` with a time no date can hold leaves a value the index does not know.** TypeScript writes the value to the
  keyring and only then calls `toISOString`, which throws; the index is never written and nothing is undone. For a new name
  the keyring then holds a value that `list` does not show and `delete` only finds by name; for an existing name it holds
  another value than the index describes. The store never passes such a time (its clock is the system's), so this is a
  defect of the backend's own contract. Rust looks at the time before the write and writes nothing. TypeScript is left as
  it is (D129: Rust-only fixes).
- **`list` answers with whatever the index entry holds.** TypeScript spreads the entry into the answer after `name` and
  `backend`, so an index written from outside can replace both and add members; `updatedBy` of any type passes through.
  Rust answers with the members a `SecretMeta` has, the name being the entry's key. Both refuse an index whose entry has no
  string `createdAt` and `updatedAt`, a description of another type, or a key that is no secret name.
- **An index that only `JSON.parse` reads** (a lone surrogate escape, a number outside f64, nesting deeper than 128) is
  `corrupt (unreadable-index)` in Rust, as for the file store (P4D-31); in a member this version does not know, a number
  may be written back in another spelling.
- **The helper's wire is not the TypeScript one.** The TypeScript core talks to its helper over Node's IPC channel; the
  Rust core talks to `plur1bus-core secrets-helper` in frames on the helper's standard input and output, with a protocol id
  in every request. The two never meet (a helper is always started by its own core), so this is no compatibility surface.
  Stricter than TypeScript, on purpose: a request whose argument has another type than the operation takes, or that names
  another backend than the helper's first request did, is answered `secret backend operation failed` (TypeScript passes the
  argument on as it is and ignores the later description); a helper answer that is not of the operation's shape is the
  same error at the caller.
- **A helper that is killed in the middle of a `put` leaves it half done.** Between the value write and the index write
  (or its undo) there is nothing that survives the process: the keyring then holds a value the index does not describe.
  The same in TypeScript (the helper is killed with SIGKILL at the budget). The store treats the backend as unavailable
  from then on and reads anew when it comes back; a value without an index entry is found by name, not by `list`. Values
  a killed helper had read for a reply that never arrived are not registered for masking by that call.
- **The code of a failing keyring call.** TypeScript puts whatever string the thrown value carries as `code` into the
  message (`reading from the keyring failed (<code>)`). Rust does so only when it has the shape of a code (letters,
  digits and `_ . -`, at most 64 characters) and says `error` otherwise, so that an adapter can never carry platform text
  into an answer.
- **`describe` without a writer forgets the last one, in the keyring only.** The keyring backend writes the entry anew
  (`updatedBy` only when the caller gives one); the file backend changes the entry in place and keeps the `updatedBy` it
  had. The store gives a writer only for an owner with an id. Ported as it is in both backends: the answer of
  `secret.describe` has to be the same on every leg when the method flips. To be made one behaviour at the cut.
- **The OS keyring adapters came with their own change (PR 2b).** Until the flip nothing in production uses the Rust
  store.

## P4D-34 — the kernel keyring behind the TypeScript keyring

`@napi-rs/keyring` 2.1.0 chooses its Linux store per entry: the Secret Service, and when none answers the kernel
keyring (keyutils). `keyring-backend.ts` passed no option, so the fallback was live. A value written there is held in
kernel memory for the user's session and is gone after a reboot; the backend's probe succeeded all the same, so the
store reported the keyring as available and used it in preference to the encrypted file.

- Reach: a Linux host without a running Secret Service (a server without a desktop session, a container). macOS and
  Windows are not affected.
- Rust: `secrets::os_keyring` has the Secret Service and nothing else. The store for the kernel keyring is not among
  the crate's dependencies (a test reads the lock file for it). Without a Secret Service the entry is refused, the
  backend probes `keyring-unavailable`, and the store takes the file backend where the owner allowed that.
- TypeScript (owner decision D136 of 2026-11-15, an exception to "fixes go to Rust", D129): `keyring-backend.ts` makes
  every entry with `{ linux: { store: "secret-service" } }` (`KEYRING_ENTRY_OPTIONS`). Without a Secret Service the
  entry throws, the probe says `keyring-unavailable`, and the store takes the encrypted file where
  `secrets.fileFallback.enabled` allows it; where it does not, the store's error names that setting. Both
  implementations now say the same on such a host.
- What changes for a host that ran on the fallback: the values in the kernel keyring are no longer read. They would
  have been gone after the next reboot; they have to be set once more, into the store the host now uses.
- Evidence: `.github/workflows/keyring-probe.yml` runs both sides on a session bus without a Secret Service. The Rust
  adapter cannot make an entry, and the Node entry, pinned as the core pins it, fails instead of answering.

What else differs between the adapters and `@napi-rs/keyring`, by construction:

- **A store per entry on both sides, no process-wide default here.** `@napi-rs/keyring` sets the process's default
  store on every `new Entry`; the Rust adapter builds the entry from a store of its own. The items are the same.
- **Failures.** Every failure of the platform layer carries the code `GenericFailure`, which is what the napi error
  of the TypeScript side carries. The platform's own text is dropped in the adapter; on the TypeScript side it is in
  the thrown error's message, which the keyring backend does not pass on either.
- **macOS, an item the other program created:** P4D-35.

## P4D-35 — macOS: a keychain item belongs to the program that made it

A generic password of the login keychain carries an access list that names the program that created it. When another
program reads the value, the system asks the user (allow once, always allow, deny) and the call waits for the answer.
The TypeScript core's items were made by `node`; the Rust helper (`plur1bus-core secrets-helper`) is another program.

- Evidence: the keyring probe on a hosted macOS runner (run 43756742544, `.github/workflows/keyring-probe.yml`). Rust
  alone passes every step against the real keychain: a round trip, a replaced value, a value of 1024 characters, the
  keyring backend with its index entry. Node alone reads what it wrote. The read of an item the other program wrote got
  no answer within 30 s, in both directions. A read of an account that is not there answers at once, so the wait
  shows that each program found the other's item; after one program deleted its account, the other's read of it
  answered at once again.
- The helper's budget: an operation has 3 s, then the helper is ended and the store is unavailable for 30 s
  (`secrets::isolated`, as in the TypeScript core).
  A dialog cannot be answered within that. A Rust store over items `node` made would therefore not just ask once per
  item; its first read would time out.
- Containment (ruling R-20-4): before the front door is the default on macOS the items move. The old program reads
  them and the new one writes them anew, so every item belongs to the program that reads it and no value crosses
  between two programs through the keychain. Until then the TypeScript core is the default, and tests and CI never
  reach a keychain (the seam of `secrets::os_keyring`); the probe is the one exception and uses a service of its own.
- A program is known by its signature. A release binary is signed with a Developer ID
  (`.github/workflows/harness-release.yml`), so the next version is the same program to the keychain. A local build is
  signed ad hoc and is a new program after every build: a core started by hand from a development build would ask
  again after each rebuild.
- The probe expects this on macOS: each of the two reads between the programs must get no answer, and one that is
  answered fails the leg, because the containment above rests on the rule.
- Not shown by the probe: what the dialog says, that a value reads the same after "Always Allow", and whether writing
  to or deleting another program's item asks too. A user's Mac is checked with the owner before the store flips.

## P4D-36 — the secret store behind the bridge

While the front door owns the secret store (P4-20 flip B1, docs/phase4/bridge.md "The secret store"), the legacy core's
store is `bridge-store.ts`, a client of the bridge. `tests/core-parity/p4-20-secrets.ts` finds no difference in the
answers of `secret.*` or in the audit lines. These differences are known and are not reached by it.

**What flip B2 changes.** While the front door owns the store it answers `secret.status`, `secret.list`,
`secret.get`, `secret.describe`, `secret.set` and `secret.delete` for a client, and `host.secret.get` for the engine,
itself. Those calls no longer pass the bridge store, so for them the items below that are about a call over the
bridge do not apply: a call that ran out of time after the front door committed it, `set` registers after the answer
(the legacy core is given the value before the caller is answered), names and values that are not text (the schema
refuses them first), and the lease of a `host.secret.get`, which the front door's store now holds and revokes itself.
The items stand as written for every caller inside the legacy core (`secret.grants.list`, the leases of web search
and channels, the export's signing key), and for the seven methods whenever they are relayed
(`PLUR1BUS_P4_IDENTITY=ts`, a run started for an import maintenance, P4D-38). What the native methods themselves do
differently is P4D-37.

- **A lease during a `set` or a `delete` of its name.** The TypeScript store revokes the leases of a name before it
  writes. Over the bridge the front door's store does the same to its own table, which is empty (leases are handed
  out); the legacy core learns of it with the answer (`effects.revoked.names`). Between the front door's write and the
  answer, a `readLease` in the legacy core still returns the old value. The window is one bridge call; the lease
  would have been valid a moment earlier, and no lease outlives the answer.
- **A store that became unavailable while nobody called.** When a helper process of the store fails, the TypeScript
  store revokes every lease at once. The front door's store does the same to its table and notes it for the legacy
  core (`effects.revoked.all`), which learns it with the answer to its next call: the bridge has calls only, in one
  direction. Until then a lease the legacy core holds can still be read there, up to its expiry. Flip B2 adds a
  message in the other direction (`legacy.secret.changed`), sent after a native call that finds something waiting.
  It narrows the window to the next call of either process; a store that fails while nobody calls at all is still
  learned of late.
- **A call that ran out of time after the front door committed it.** The bridge store gives a call the store's
  budget. A `set` or a `delete` the front door finished later is reported as `backend-unavailable`, the change
  listeners are not told, and every lease is void (the bridge is taken for lost). The TypeScript store has a like
  outcome when its helper answers late. The same holds for an answer the front door could not send as it built it.
- **The order of `logs/audit.log`.** Both processes write the chain under its lock and the line in `logs/audit.log`
  after it. Two records of the two processes (a `secret.reveal` of the front door, a `secret.lease.read` of the
  legacy core) can therefore stand in `logs/audit.log` in the other order than in the chain. No line is torn.
- **`describe` and the redaction registry.** The TypeScript store reads the value to check the description against
  it and registers the value while it does. Over the bridge the front door's store does both; the value does not
  travel, so the legacy core's registry does not learn it from a `describe`. It holds the value already if it was in
  the start-up snapshot or was set, revealed or leased in this run. A value that another program wrote into the store
  while the cores ran is in neither case; it is masked in the legacy core's lines from the next preload on.
- **`set` registers after the answer.** The TypeScript store registers a value once it has accepted it, before it
  writes. The bridge store registers it when the call comes back, also when the write failed (not when the value was
  refused). A log line of the legacy core that held the value and was written during the call would not be masked
  by the legacy core; nothing in the legacy core writes the value of a `secret.set` into a line.
- **Names and values that are not text.** The store's interface is typed, but a caller can pass anything. The
  TypeScript store refuses a non-string with `invalid-name` or `invalid-value`; the bridge store sends the empty
  string in its place and the front door's store refuses that with the same code. A string with a lone surrogate
  cannot be carried (the front door reads well-formed text only): the bridge store sends U+FFFD in its place, which
  is what the TypeScript file backend stores for it (P4D-31). The legacy core's registry holds the string as it was
  given, as before.
- **A principal that is none of the three kinds.** The TypeScript store refuses it and records it as an agent
  without an id. The bridge store sends `{ kind: "agent" }`, with the same outcome and the same record.
- **The log lines of the store.** "secret access denied", "secret backend selected" and the warnings of the start-up
  read are written by the front door (`src: "front-door"`) for what its store does, and by the legacy core for the
  leases it holds. In the TypeScript core they all come from one process.
- **Two more processes build a store of their own.** The API service and the import child of the legacy core are
  given the home, not the bridge: each opens `state/secrets/` and the keyring itself, as before the flip. On Linux
  and Windows that is a second reader of the same files and the same keyring service, as it always was. On macOS
  they are programs of their own to the keychain (P4D-35): once the items have moved to the front door's helper,
  their reads would wait for the user. The move therefore has to come after they stopped opening the keyring, or
  take them along. They move with their own packages.
- **The mark of the move.** `state/secrets/keyring-owner` is looked for, not read, and nothing writes it yet. A home
  that has the file without the move (copied from another machine, restored) makes a front door on macOS the owner
  of a keychain whose items belong to `node`: its reads time out and the store is unavailable. The step that writes
  the mark gives it a content that is checked (the program, the home).
- **The home as text.** The keyring service is derived from the home's text, so the front door must spell the home
  as a TypeScript core alone would: the entries of an installation were made under that name. It normalizes `--home`
  with a port of Node's `path.resolve` (`home_path.rs`, checked against the vectors `resolveHome` shares with the CLI)
  and passes the result to the legacy core, for which it is already in its form. Before flip B1 it used
  `std::path::absolute`, which keeps a trailing separator and `..`, and nothing depended on the text. Where the port
  and Node differ on a spelling, a front door looks under another name than a TypeScript core that was given the same
  spelling. Known: on Windows a drive-relative path (`C:x`), and a literal `~` (a TypeScript core started by hand
  expands it; the CLI and the front door take it as a name). The CLI resolves the home with the same port before it
  starts either core (`commands/core.rs`), so an installation started through it has one spelling. Should the two
  processes of one run ever derive different names, the preload that opens every bridge connection refuses, and the
  legacy core has no store instead of a second, empty one. The parity run has a variant with a trailing separator; it
  failed before the normalization.
- **A store whose values exceed a frame.** The start-up snapshot travels in one frame of at most 4 MiB. Beyond
  that the legacy core gets `storage` and has no store (`secret.status` says unavailable; the front door's line
  "a bridge answer exceeds a frame" says why), where a TypeScript core alone would run. No paging: 4 MiB is some
  60 values of the largest size a value may have, or tens of thousands of keys, and the snapshot goes with the bridge.
- **Time.** Every operation is one more local round trip (well under a millisecond on a Unix socket) on top of the
  store's own cost; the first call also opens the connection.

## P4D-37 — the native `secret.*` methods and `host.secret.get`

P4-20 flip B2. While the front door owns the secret store it answers six `secret.*` methods and the engine's
`host.secret.get` itself (`docs/phase4/bridge.md`, "The secret store"). `tests/core-parity/p4-20-secrets.ts` finds no
difference in the answers or the audit lines on its four legs. What is known:

- **`activeLeases` of the native `secret.status` counts the front door's leases only** (ruling R-20-33). A lease
  taken over the bridge is handed out: the legacy core holds and counts it, and the front door's store does not. The
  TypeScript core's own `secret.status` adds the two (`bridge-store.ts`); the front door's answer has only its own
  table, which holds a lease for the moment a `host.secret.get` is under way. The number is too small by the leases
  the legacy core holds at that moment (a web search, a channel, an export in flight). Nothing decides on the
  number; `plur1bus secret status` shows it. The scenario reads it when no lease is held, where both say 0. It ends
  when the leases are taken where the store is.
- **A `legacy.secret.changed` that does not arrive.** After a native `secret.set` or `secret.delete` the front door
  tells the legacy core before it answers (five seconds, one more attempt after a refusal). When the call fails, the
  change stands and the caller gets its answer; the front door writes an error line with a short code. The legacy
  core then learns the name with its next call over the bridge, whose answer carries the names whose leases are void
  (`effects.revoked.names`): until then a lease of the old value it holds can still be read there, up to its
  expiry. It does not learn the value: its redaction registry gets it with the next start-up snapshot
  or when the value next reaches it (a lease, a reveal over the bridge), so a line of the legacy core that held the
  new value in between would not be masked by the legacy core; the front door's registry has the value from the
  moment of the set, and masks its own lines and every `logs.query` it answers with it. Its change listeners are not
  told at all for that change. A TypeScript core alone has no such case: store, leases and registry are one process.
  The front door asks again, without a name, with a native call that comes five seconds or more after the failure,
  and the legacy core then fetches what waits.
- **A native `secret.set` that fails after the value was accepted.** The store registers a value once it has
  accepted it, before it writes, so that a write that failed leaves it masked. Over the bridge the legacy core does
  the same in its own registry (`bridge-store.ts`, `set`). After a native `set` that failed, the legacy core is not
  told the name or the value (a change that did not happen has no notice by name): the value is in the front door's
  registry and not in the legacy core's. The value never reached the legacy core, so no line of its own can hold
  it, unless the caller sends the same value to it by another way.
- **A legacy core that does not answer holds up a native change.** The notice is waited for before the caller is
  answered: up to five seconds for a `secret.set` or a `secret.delete` (ten when a first attempt was refused and
  the second is not answered), with the change already committed. Nothing is locked meanwhile; the thread of that
  connection waits. The request to fetch (without a name) costs that wait at most once in five seconds, whatever
  the number of calls: it goes out once for each stand of what waits, and rests five seconds after a failure, so
  reads and the engine's `host.secret.get` are not each held up by a legacy core that hangs. A TypeScript core that
  hangs answers nothing at all; here the store's own methods keep answering, at that price.
- **`host.secret.get` answers every failure with `E_INTERNAL`, reason `handler-threw`** (ported as it is, ruling
  R-20-32). `createEngineSecrets` catches whatever the lease or its revocation raised (a name the store does not have,
  a name that is none, a store that is unavailable, an audit record that could not be written) and throws a plain
  error, which the server answers as a handler that failed. The engine cannot tell a missing key from a broken
  store, and the schema's `value: null` is never sent. The front door does the same and logs the server's line
  (`handler failed`, with the method and nothing of the call; it also writes its own `rpc error` line for the
  refusal, which the TypeScript server does not). A lease whose revocation failed stays in the table until it
  expires (five seconds), in both.

- **The engine reaches the store's lock directly, and nothing bounds it per connection** (independent review, U7;
  read in the code, not measured). A native `host.secret.get` takes the store's mutex twice, for the lease and for
  its revocation, each time with an audit record and a read of the backend, on the thread of the engine's
  connection. Before the flip the same calls went through the legacy core and its one bridge connection, one after
  the other. An engine that opens many connections and asks on all of them makes the legacy core's own bridge calls
  wait for the same lock; one that waits longer than its budget (3 s, `docs/phase4/bridge.md`, "When the bridge is
  gone or slow") counts as a bridge that is gone, and the legacy core then voids every lease it holds. That takes an
  engine that misbehaves, which can already read every secret (P4D-29); what it gains here is to disturb the
  holders of leases, not to read more. There is no limit of calls or connections for the engine; one belongs with
  the scope of P4D-29.

Not a difference, but new with the flip: the front door now checks an engine connection's token against
`run/engine.token` before every request it answers itself, as module-api does before every request; before, it
checked at the handshake only and the legacy core checked each relayed request.

The token file is read as module-api's `readRunToken` reads it (`run_files::engine_token_now`): `run/` first, which
must still be a real directory of this user that group and others cannot write to (`checkRunDir`,
`plur1bus_rpc::trust::verify_run_dir`), then the file, and a directory that fails holds no token at all. The first
form of this flip looked at the file only, as the front door has done at every engine handshake since P4-10; there
the legacy core looks at the directory itself before the connection is anyone, but for a native answer nobody did
any more (independent review, U1). On Unix the file is opened once, without following a link and without waiting,
and judged by its descriptor: a regular file of at most 4096 bytes, of which no more is read (U2). Before, the name
was looked at and then opened, so a process that can write in `run/` (this user, who can read the tokens anyway)
could change what the name meant in between: a link to another file, a file that grows, or a FIFO that held the
thread of that connection for good. On Windows the name is still looked at and then opened; `run/` is protected by
its DACL there. Two small differences remain, both to the refusing side: a token file that begins with a byte order
mark is a token to module-api (JavaScript's `trim` takes U+FEFF) and none here, and the engine handshake of the
front door still reads the file without the directory, where the legacy core's check decides. And the method still
gives out any name (P4D-29).

## P4D-38 — the native methods and an import maintenance

A core that the supervisor starts for an import maintenance (`PLUR1BUS_IMPORT_MAINTENANCE`, the run id) is a read-only
host until the job releases it: `createImportMaintenanceHold` wraps every method of the TypeScript core and refuses
all but a short list with `E_CONFLICT`, reason `busy` (`packages/core/src/import/maintenance-admission.ts`; the list
is a few reads, the import's own methods, and three `host.*` methods the engine needs to validate the target). The
front door did not know of it. Every method it served itself was answered in such a run as in any other, without
the legacy core having admitted it: since P4-12 flip A1 `breakglass.notices` and `identity.principals`, since flip A2
`user.role.set`, `user.disable` and `user.enable`, since P4-20 flip A `logs.query`. Three of them write
`state/admin.sqlite`. None is on the list, so a TypeScript core alone refuses each of them while it is held
(`packages/core/test/import/maintenance-admission.test.ts` names `user.role.set` and `secret.set`). The six
`secret.*` methods of flip B2 would have joined them. Reached only where the supervisor's core is the front door
(`PLUR1BUS_CORE_IMPL=rust`), which is not the default; found by reading, not seen in a run.

**Fixed (ruling R-20-34):** a front door started with the variable set, to whatever value, serves no method itself
(`Native::hold_for_import_maintenance`, asked through `Native::serves_now` for every request). Every call is
relayed, and the legacy core, which inherits the variable and holds the maintenance, decides it: `busy`, or let
through, as without a front door. That is the leg `PLUR1BUS_P4_IDENTITY=ts` of the parity scenarios, which is
compared for every native method. The value is the legacy core's to judge; a value that is no run id stops its
start, and with it the front door's. The front door has no reading of the value at all: set and empty, or blanks
only, holds here as a run id does (the legacy core takes each for a run id that is none,
`createImportMaintenanceHold("")` throws, and the pair does not start). The first form of this fix took an empty
value for no maintenance, and was safe only because of that second check in the other process; the independent
review of flip B2 (U3) found it, and the rule is now the one of `maintenance-admission.ts`: defined is held. The
front door's own test runs against a stand-in for the legacy core that starts whatever the variable holds, and
shows the front door's half: relayed for a run id, for any other text, for blanks and (where a process can be given
an empty variable; not on Windows) for the empty value. The supervisor sets a run id or removes the variable
(`supervisor/child.rs`). A maintenance can only be held from the start of a core, never begin later, so reading the
variable once is enough. The front door starts its legacy core once: a held core cannot come back held
in the same process after a release. One line of the front door's log says that it stands back ("started for an
import maintenance: every native method is relayed until the next start").

What the front door answers without the legacy core, in such a run as in any other, is what module-api answers
before it looks a method up, and the hold wraps methods only: the handshake and its refusals, a request that is no
request, an id of the front door's own namespace, a delegation that does not verify, `legacy.*` and `bridge.*` on a
client's connection (`method-not-found`, `bridge-principal`). The answers it completes (`core.status`,
`core.adopt`, `core.shutdown`, `events.subscribe`, `events.unsubscribe`) are relayed first, and completed only when
the legacy core accepted them.

A variable that comes from somewhere else (independent review, U6). The supervisor never passes on one it inherited:
every child it starts has it removed and the core of a maintenance gets the job's run id
(`supervisor/child.rs`, `apply_child_env`). `plur1bus core run` is different: it starts the core, TypeScript or
front door, with the environment it was called in (`commands/core.rs`, `run`; only the engine it owns goes through
`apply_child_env`), so a variable set in that shell reaches the front door and, through it, the legacy core. With a
run id in it the front door relays everything and the legacy core holds, and no job is there to release it; with
anything else the legacy core does not start. A TypeScript core started that way holds in the same way, so this is
not the front door's and not new. For the front door it only closes: an inherited variable makes it stand back,
never serve.

**Open:** the front door does not see the release (`admin.import.runtime.release` is the legacy core's). After it,
the legacy core goes on answering the methods the front door would serve, until the core is started again. The
answers are the same; they take the relay's round trip, and `logs.query` and the `secret.*` methods are answered
through the bridge and the legacy core's registry instead of here. A later package lets the front door learn of the
release.

Tests: `native::secret_tests::started_for_an_import_maintenance_nothing_is_served_here`,
`tests/front_door.rs` `started_for_an_import_maintenance_the_front_door_serves_nothing_itself`.


## P4D-43 — verified file opens

The path policy now verifies the open file handle before applying a truncation request. A target that
was absent at the check is refused unless the caller asked to create it. The path tests cover both
conditions. This is K2-D5 (TS-1) from P4-K.
