# Phase 4 defect ledger

Plan: `docs/superpowers/plans/2026-11-07-phase4-ts-core-to-rust.md` §4.2 (pull forward on defect) and §3 (parity). Besides
recorded owner decisions, an entry here is the only allowed divergence between the TypeScript core and the Rust core: a
defect found in TypeScript (patched there only with an explicit owner exception), or a difference the Rust front door introduces on purpose and that
a later package removes. Each entry names the component, its MODULE-MAP row
(`docs/superpowers/plans/phase4/MODULE-MAP.md`), a severity, the owning package and a reproduction; it is closed by the
PR that flips the owning package with its vector green.

Severity: `security`, `data-loss`, `low` (a wrong answer or refusal on a path no shipped client takes, or a narrow
window that was not reproduced; the entry says which), `info` (a documented difference with no wrong answer).

Paket T uses the reserved numbers P4D-40, P4D-43, P4D-44 and P4D-45. P4-K K12 allocates new numbers from P4D-46.

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
| P4D-40 | HTTP adapters must represent bodyless responses without a stream | `packages/core/src/composition/http.ts`, `packages/core/src/a2a/client.ts` | security (availability) | P4-W | fixed in TypeScript under the owner exception |
| P4D-43 | File mutation must wait for handle verification | `packages/core/src/policy/paths.ts` | security (file integrity) | P4-21 | fixed in TypeScript under the owner exception |
| P4D-44 | RSA signing keys must meet the verifier's minimum requirements | `packages/core/src/openai-auth/identity.ts` | security (identity verification) | P4-21 | fixed in TypeScript under the owner exception |
| P4D-45 | Login listeners must handle unreadable request targets | `packages/core/src/auth/login.ts`, `packages/core/src/openai-auth/loopback.ts` | security (availability) | P4-21 | fixed in TypeScript under the owner exception |

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

## P4D-40 — bodyless HTTP responses

The provider and A2A adapters used a stream as the body of a Fetch response even when its status
required an absent body. They now construct a response with a null body for 204 and 205. The A2A
adapter does the same for 304. The provider transport continues to refuse 304 through its existing
redirect policy. Adapter tests cover the statuses, response headers and the provider refusal.

<a id="p4d-43"></a>

## P4D-43 — verified file opens

The path policy now verifies the open file handle before applying a truncation request. A target that
was absent at the check is refused unless the caller asked to create it. The path tests cover both
conditions. This is K2-D5 (TS-1) from P4-K, numbered [P4D-52](#p4d-52) in the P4-K table. The P4-K
`policy-fs` vectors record the shared answer since the package took in PR #937, including a target
that appeared after the check and is opened without a create.

<a id="p4d-44"></a>

## P4D-44 — RSA keys in OIDC verification

The ID-token verifier requires an allowed string algorithm and the corresponding key member types.
RS256 requires a modulus of at least 2048 bits and an odd exponent greater than one before signature
verification. Rejection uses the existing `id-token-invalid` error. The tests cover key and algorithm
types, the exponent rule and the 2047/2048-bit boundary. This is K4-D5 (T-C1) from P4-K,
numbered [P4D-67](#p4d-67), and it also closes K4-D6 ([P4D-68](#p4d-68), an `alg` that is an array).
A key's own `alg` member now matches only when it is absent or equal to the header's algorithm; the
Rust verifier of P4-K follows that rule. K4-D7 ([P4D-69](#p4d-69)) is not affected.

<a id="p4d-45"></a>

## P4D-45 — unreadable login callback targets

The login-port and ChatGPT Plan listeners answer an unreadable request target with the existing
404 for an unknown route. The listener stays open for the legitimate callback. Both listener tests
cover this sequence. This is K4-D3 and K4-D4 (T-1) from P4-K, numbered [P4D-65](#p4d-65) and
[P4D-66](#p4d-66).

## P4-K findings and decisions

K12 assigns the identifiers below to the package's library findings and documented decisions. A Rust status describes the
library. The listed owner still owns the production flip. The [P4-K inventory](p4-k-inventory.md) records the parity fixtures
and host ports for each milestone. K12 starts at P4D-46.

A historical label explicitly left unassigned remains searchable here with that status. K6c findings that had shared K6a labels
now use K6-D27 through K6-D29. The early calendar boundary formerly labeled K7-D7 uses K7-D14. K7-D4 identifies schema
refusal and K7-D5 identifies the calendar difference.

### P4-K K1

| Id | Package label | MODULE-MAP owner and component | Severity | Status | Observed behavior or proof |
|---|---|---|---|---|---|
| <a id="p4d-46"></a>P4D-46 | K1-D1 | [P4-24](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-24) · `packages/core/src/budget/` | info | flip | A subagent preview formatted through a parsed Rust value can reorder object members and render numbers differently from the original JavaScript preview. Preserve the rendered text at the flip. |
| <a id="p4d-47"></a>P4D-47 | K1-D2 | [P4-24](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-24) · `packages/core/src/budget/` | info | open | The pinned Rust tzdb and the Node ICU tzdb can compute different budget period boundaries after a rule change. Pin results against each release rather than treating different releases as identical. |

### P4-K K2

| Id | Package label | MODULE-MAP owner and component | Severity | Status | Observed behavior or proof |
|---|---|---|---|---|---|
| <a id="p4d-48"></a>P4D-48 | K2-D1 | [P4-21](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-21) · `packages/core/src/egress/` | low | in parity | An invalid null model-download configuration raises TypeError and permits no request. The model vector records the refusal. |
| <a id="p4d-49"></a>P4D-49 | K2-D2 | [P4-21](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-21) · `packages/core/src/policy/` | info | Rust strict | A policy audit field capped at 256 UTF-16 units can end inside a surrogate pair. Rust stops before that pair. |
| <a id="p4d-50"></a>P4D-50 | K2-D3 | [P4-21](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-21) · `packages/core/src/policy/` | info | in parity | An ill-typed last-job timestamp can follow JavaScript addition and coercion in grant expiry. The real grant store supplies numbers. |
| <a id="p4d-51"></a>P4D-51 | K2-D4 | [P4-21](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-21) · `packages/core/src/egress/` | low | Rust strict | The egress host parser rejects invalid IDNA labels accepted by Node. The URL and gate vectors record the separate outcomes. |
| <a id="p4d-52"></a>P4D-52 | K2-D5 | [P4-21](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-21) · `packages/core/src/policy/paths.ts` | security | in parity | Closed in TypeScript by [P4D-43](#p4d-43) (PR #937): both sides truncate only after the opened descriptor passed the identity check, and refuse a target missing at the check unless the open creates it. The policy-fs vectors record the shared answers. Keep the checked descriptor through the flip. |
| <a id="p4d-53"></a>P4D-53 | K2-D6 | [P4-21](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-21) · `packages/core/src/policy/paths.ts` | low | Rust strict | A FIFO can block the legacy open. Rust opens without blocking and refuses descriptors other than files and directories. |
| <a id="p4d-54"></a>P4D-54 | K2-D7 | [P4-21](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-21) · `packages/core/src/policy/paths.ts` | low | Rust strict | Detection of a changed parent during file creation differs by platform. Rust compares the created descriptor with the entry at the checked location before accepting it. |
| <a id="p4d-55"></a>P4D-55 | K2-D8 | [P4-21](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-21) · `packages/core/src/policy/` | low | Rust strict | An invalid configuration object can throw during JavaScript policy coercion. Rust refuses the value at the affected boundary, as recorded by the policy vectors. |

### P4-K K3

| Id | Package label | MODULE-MAP owner and component | Severity | Status | Observed behavior or proof |
|---|---|---|---|---|---|
| <a id="p4d-56"></a>P4D-56 | K3-D1 | [P4-22](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-22) · `packages/core/src/approvals/` | low | in parity | An ill-formed approval-chain tag can have the expected UTF-16 length and the wrong byte length. The chain comparison fails closed with an error. |
| <a id="p4d-57"></a>P4D-57 | K3-D2 | [P4-22](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-22) · `packages/core/src/approvals/` | security | flip | A legacy approval-chain verified-view cache can outlive a rolled-back write. Rust only publishes committed state. Keep rollback coverage at the flip. |
| <a id="p4d-58"></a>P4D-58 | K3-D3 | [P4-22](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-22) · `packages/core/src/approvals/` | info | open | The approval verifier supports legacy unsigned evidence and accepts an unpinned signing key when the caller supplies no verifier pin. The HMAC chain remains authoritative. |
| <a id="p4d-59"></a>P4D-59 | K3-D4 | [P4-22](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-22) · `packages/core/src/channel-handoff/` | info | Rust strict | Clipping a delivery-adjacent inbox field or hand-off context can leave a lone surrogate in TypeScript. Rust drops that half at the boundary, as shown by the UTF-16 vectors. |
| <a id="p4d-60"></a>P4D-60 | K3-D5 | [P4-22](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-22) · `packages/core/src/approvals/` | low | Rust strict | The Ed25519 SPKI reader requires the supported DER encoding. Approval and JWKS fixture members cover BER encodings accepted by Node. |
| <a id="p4d-61"></a>P4D-61 | K3-D6 | [P4-22](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-22) · `packages/core/src/approvals/` | low | Rust strict | The approval signing key reader refuses unsupported PKCS #8 encodings and a public member inconsistent with its private seed. |
| <a id="p4d-62"></a>P4D-62 | K3-D7 | [P4-22](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-22) · `packages/core/src/approvals/` | info | unassigned | The review B ledger explicitly left this label unassigned. No defect was recorded under it. |

### P4-K K4

| Id | Package label | MODULE-MAP owner and component | Severity | Status | Observed behavior or proof |
|---|---|---|---|---|---|
| <a id="p4d-63"></a>P4D-63 | K4-D1 | [P4-23](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-23) · `packages/core/src/auth/` | info | in parity | An ill-typed extra_headers member can be enumerated as JavaScript object entries. Rust reproduces the legacy profile validation in the vectors. |
| <a id="p4d-64"></a>P4D-64 | K4-D2 | [P4-23](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-23) · `packages/core/src/auth/` | info | Rust port | The login callback rate limit reads wall time in TypeScript. Rust reads its injected clock. |
| <a id="p4d-65"></a>P4D-65 | K4-D3 | [P4-23](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-23) · `packages/core/src/auth/` | low | in parity | Closed in TypeScript by [P4D-45](#p4d-45) (PR #937): a malformed loopback login request target gets 404 on both sides, and the listener continues to accept callbacks. The login vector records the shared answer. |
| <a id="p4d-66"></a>P4D-66 | K4-D4 | [P4-23](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-23) · `packages/core/src/openai-auth/` | low | in parity | Closed in TypeScript by [P4D-45](#p4d-45) (PR #937): the plan OAuth loopback answers a malformed target after method and host checks with 404 on both sides. The listener vector records the shared answer. |
| <a id="p4d-67"></a>P4D-67 | K4-D5 | [P4-23](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-23) · `packages/core/src/openai-auth/` | security | Rust strict | Since [P4D-44](#p4d-44) (PR #937) both verifiers reject RSA keys below 2048 bits and an exponent that is 1 or even; the JWKS members fixture records the shared refusals. Rust stays stricter only at the limits of `ring`: a modulus above 8192 bits or an exponent of 2^33 or more is refused where TypeScript accepts it. No vector covers these limits. |
| <a id="p4d-68"></a>P4D-68 | K4-D6 | [P4-23](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-23) · `packages/core/src/openai-auth/` | low | in parity | Closed in TypeScript by [P4D-44](#p4d-44) (PR #937): both verifiers require a string alg member. The JWKS members fixture records the shared refusal of an array. |
| <a id="p4d-69"></a>P4D-69 | K4-D7 | [P4-23](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-23) · `packages/core/src/openai-auth/` | security | Rust strict | The verifier rejects a key set entry containing private-key material. The adopted JWK contract is public verification keys only. |
| <a id="p4d-70"></a>P4D-70 | K4-D8 | [P4-23](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-23) · `packages/core/src/openai-auth/` | low | Rust strict | The service-account PEM reader rejects malformed leading or trailing bytes that OpenSSL can accept. The PEM vectors pin both sides. |
| <a id="p4d-71"></a>P4D-71 | K4-D9 | [P4-23](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-23) · `packages/core/src/openai-auth/` | low | Rust strict | Malformed or unrepresentable identity JSON is refused by the Rust reader. This includes a lone surrogate, an out-of-range number or excessive nesting. |
| <a id="p4d-72"></a>P4D-72 | K4-D10 | [P4-23](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-23) · `packages/core/src/openai-auth/` | low | Rust port | The loopback listener caps open connections at 64, checks existing sockets at capacity and bounds admission. The TypeScript application sets no such cap. |

### P4-K K5

| Id | Package label | MODULE-MAP owner and component | Severity | Status | Observed behavior or proof |
|---|---|---|---|---|---|
| <a id="p4d-73"></a>P4D-73 | K5-D1 | [P4-40](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-40) · `packages/core/src/session/` | info | Rust port | Session store statements map SQLite errors to the storage/sqlite envelope. A two-statement visibility update is transactional in Rust. |
| <a id="p4d-74"></a>P4D-74 | K5-D2 | [P4-40](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-40) · `packages/core/src/session/` | low | in parity | The legacy constraint mapping reports turn-in-progress for the matching session UNIQUE error. The Rust error mapping preserves it. |
| <a id="p4d-75"></a>P4D-75 | K5-D3 | [P4-40](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-40) · `packages/core/src/session/` | low | flip | Invalid trigger, summary-state and event values are outside the Rust closed types. The future RPC boundary must return invalid for unrecognized inputs. |
| <a id="p4d-76"></a>P4D-76 | K5-D4 | [P4-40](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-40) · `packages/core/src/session/` | info | in parity | Session titles cut inside a surrogate pair are stored with a replacement character. The fixture representation also covers lone UTF-16 units. |
| <a id="p4d-77"></a>P4D-77 | K5-D5 | [P4-40](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-40) · `packages/core/src/session/` | info | toolchain | Exported vectors can change when run with an unpinned Node/ICU release. Record and check with Node 24.21.0. |
| <a id="p4d-78"></a>P4D-78 | K5-D6 | [P4-40](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-40) · `packages/core/src/session/` | info | unassigned | The session-maintenance comparison found no difference and explicitly left this label unassigned. |
| <a id="p4d-79"></a>P4D-79 | K5-D7 | [P4-40](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-40) · `packages/core/src/session/` | info | test tolerance | SQLite FTS BM25 scores can vary in their last digits. The replay tolerates only the rank column, and verifies hit order and all other values exactly. |
| <a id="p4d-80"></a>P4D-80 | K5-D8 | [P4-40](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-40) · `packages/core/src/session/` | security | flip | Rewind consumes approval and then checks the working tree, index and untracked targets again. An atomic Git port or exclusive writer is still needed after that check. |
| <a id="p4d-81"></a>P4D-81 | K5-D9 | [P4-40](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-40) · `packages/core/src/session/` | low | Rust port | A disk-backed session holds a per-session advisory rewind lease. Its release is tested with independent store connections. |
| <a id="p4d-82"></a>P4D-82 | K5-D10 | [P4-40](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-40) · `packages/core/src/session/` | info | Rust port | New erasure tombstones store a canonical actor principal and a catalog reason. Imported history retains its recorded shape. |

### P4-K K6

| Id | Package label | MODULE-MAP owner and component | Severity | Status | Observed behavior or proof |
|---|---|---|---|---|---|
| <a id="p4d-83"></a>P4D-83 | K6-D1 | [P4-50](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-50) · `packages/core/src/collab/` | security | flip | Collaboration refuses readable trace, task and export views when the redaction port is missing. The host must provide it. |
| <a id="p4d-84"></a>P4D-84 | K6-D2 | [P4-50](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-50) · `packages/core/src/collab/` | info | Rust port | Trace and span identifiers come from the explicit CollabIds port so the fixture can script the same edges. |
| <a id="p4d-85"></a>P4D-85 | K6-D3 | [P4-50](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-50) · `packages/core/src/collab/` | info | flip | A consultation is start and finish with a shared cancellation flag. The host owns scheduling and the equivalent promise lifetime. |
| <a id="p4d-86"></a>P4D-86 | K6-D4 | [P4-50](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-50) · `packages/core/src/collab/` | low | Rust strict | Stored non-object collaboration settings do not get JavaScript object-spread behavior. Invalid JSON and null still produce a storage error. |
| <a id="p4d-87"></a>P4D-87 | K6-D5 | [P4-50](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-50) · `packages/core/src/collab/` | info | Rust port | A failure in the task-grant end port contributes the warning text without the exception object. |
| <a id="p4d-88"></a>P4D-88 | K6-D6 | [P4-50](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-50) · `packages/core/src/collab/` | info | Rust port | SQLite constraint failures in raw collaboration operations carry the Rust raw marker. The vectors compare failure, with no dependence on exception spelling. |
| <a id="p4d-89"></a>P4D-89 | K6-D7 | [P4-50](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-50) · `packages/core/src/collab/` | low | in parity | Ill-typed collaboration token budgets resolve to zero. An absent or null cap remains unlimited. |
| <a id="p4d-90"></a>P4D-90 | K6-D8 | [P4-50](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-50) · `packages/core/src/collab/` | low | Rust port | Collaboration reserves work budget atomically until it is counted. The legacy budget checker is synchronous within one owner. |
| <a id="p4d-91"></a>P4D-91 | K6-D9 | [P4-50](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-50) · `packages/core/src/collab/` | low | Rust port | A consumed reservation remains attributed to its run. Finish requires an established receiver phase. |
| <a id="p4d-92"></a>P4D-92 | K6-D10 | [P4-50](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-50) · `packages/core/src/collab/` | low | Rust strict | The Windows harness-home exclusion uses the same path spelling normalization as the deny policy. |
| <a id="p4d-93"></a>P4D-93 | K6-D11 | [P4-50](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-50) · `packages/core/src/collab/` | security | flip | Collaboration stores redacted artifact text and refuses usable delegations when a required redaction port is absent. |
| <a id="p4d-94"></a>P4D-94 | K6-D12 | [P4-50](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-50) · `packages/core/src/collab/` | info | flip | The host drives the shutdown clock, progress and join. The collaboration library contains no shutdown timer. |
| <a id="p4d-95"></a>P4D-95 | K6-D13 | [P4-50](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-50) · `packages/core/src/collab/` | low | flip | If an admission callback fails synchronously, the legacy registered delegate can lack a terminal result. Make registration and callback completion consistent at the flip. |
| <a id="p4d-96"></a>P4D-96 | K6-D14 | [P4-50](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-50) · `packages/core/src/coding/` | security | flip | Network requests require both manifest and host-policy authority. The current coding snapshot requires two independent local reviewers. |
| <a id="p4d-97"></a>P4D-97 | K6-D15 | [P4-50](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-50) · `packages/core/src/coding/` | security | flip | A Coding Done effect binds the writer, canonical worktree and snapshot and requires the audit and final verification. |
| <a id="p4d-98"></a>P4D-98 | K6-D16 | [P4-50](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-50) · `packages/core/src/coding/` | low | flip | Promotion replay rechecks source and target rights and the effect port deduplicates the preview. Native process-loss recovery belongs to the target adapter. |
| <a id="p4d-99"></a>P4D-99 | K6-D17 | [P4-50](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-50) · `packages/core/src/external-turn/` | security | flip | External ACP prepare binds live connection, D109 scope, owner and agent. Background roles receive only the permitted project context. |
| <a id="p4d-100"></a>P4D-100 | K6-D18 | [P4-50](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-50) · `packages/core/src/coding/` | security | flip | The Git view validates metadata, hashes and output and uses a separate temporary index. The adapter must validate object roots and alternates. |
| <a id="p4d-101"></a>P4D-101 | K6-D19 | [P4-50](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-50) · `packages/core/src/coding/` | low | Rust strict | The human check counts output bytes before and after redaction against the same 65,536-byte limit. |
| <a id="p4d-102"></a>P4D-102 | K6-D20 | [P4-50](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-50) · `packages/core/src/external-turn/` | security | legacy open | External-turn ownership in the legacy library can differ from the authenticated caller. Static review confirmed the trust boundary. Rust denial tests use isolated identities. Exposure through a shipped transport remains unconfirmed. |
| <a id="p4d-103"></a>P4D-103 | K6-D21 | [P4-50](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-50) · `packages/core/src/collab/` | low | Rust port | Collaboration repeat counters are scoped to the project. Earlier global state does not carry across the new scope. |
| <a id="p4d-104"></a>P4D-104 | K6-D22 | [P4-50](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-50) · `packages/core/src/collab/` | security | flip | Task grants end before the cancellation commits. The grant port must be idempotent and must avoid re-entering the held collaboration store. |
| <a id="p4d-105"></a>P4D-105 | K6-D23 | [P4-50](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-50) · `packages/core/src/collab/` | low | Rust port | The file-backed collaboration store claims writer slots under the same SQLite transaction as admission. Separate instances observe the same application capacity. |
| <a id="p4d-106"></a>P4D-106 | K6-D24 | [P4-50](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-50) · `packages/core/src/collab/` | security | flip | R-K-25: stored ancestry and live parent state bind delegation. Tool scope, fan-out, budget and dispatch bindings remain enforceable at the adapter. |
| <a id="p4d-107"></a>P4D-107 | K6-D25 | [P4-50](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-50) · `packages/core/src/external-turn/` | security | flip | R-K-26: person and token owner namespaces derive from the verified subject. The binding also covers continuation, status and dispatch. Existing owner data needs a flip strategy. |
| <a id="p4d-108"></a>P4D-108 | K6-D26 | [P4-50](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-50) · `packages/core/src/coding/` | security | flip | A coding review binds the card, snapshot, canonical worktree and completing agent. Earlier review keys lacking those bindings are refused. |
| <a id="p4d-109"></a>P4D-109 | K6-D27 | [P4-50](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-50) · `packages/core/src/external-turn/` | security | flip | An external turn claim is single-use and tied to its authorized session, origin and live turn. The host supplies cancellation, readiness and deadlines. Historical K6c label K6-D21. |
| <a id="p4d-110"></a>P4D-110 | K6-D28 | [P4-50](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-50) · `packages/core/src/external-turn/` | security | flip | External-turn memory follows the original and current exposure and discards stale recall. Only the active path and authorized rewind lessons enter the model context. Historical K6c label K6-D22. |
| <a id="p4d-111"></a>P4D-111 | K6-D29 | [P4-50](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-50) · `packages/core/src/federation/` | security | flip | Federation validates mission, peers, lease, project and terminal evidence in a deterministic model. A later adapter supplies verified transport and credential lifecycle. Historical K6c label K6-D23. |

### P4-K K7

| Id | Package label | MODULE-MAP owner and component | Severity | Status | Observed behavior or proof |
|---|---|---|---|---|---|
| <a id="p4d-112"></a>P4D-112 | K7-D1 | [P4-51](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-51) · `packages/core/src/user-jobs/` | info | in parity | A recurring job can still run after its creator loses manage while retaining use. Rights derive from the current principal at execution. |
| <a id="p4d-113"></a>P4D-113 | K7-D2 | [P4-51](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-51) · `packages/core/src/user-jobs/` | low | Rust port | Ordinary edits preserve runAs. The Rust takeover operation uses current rights, a conditional update and an audited transfer. |
| <a id="p4d-114"></a>P4D-114 | K7-D3 | [P4-51](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-51) · `packages/core/src/user-jobs/` | info | in parity | A manual user-job run requires agent use. Editing and takeover retain their separate manage checks. |
| <a id="p4d-115"></a>P4D-115 | K7-D4 | [P4-51](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-51) · `packages/core/src/user-jobs/` | low | Rust strict | The unversioned user-jobs store rejects nonzero user_version before altering the journal or schema. |
| <a id="p4d-116"></a>P4D-116 | K7-D5 | [P4-51](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-51) · `packages/core/src/user-jobs/` | info | known difference | The supported calendar vector currently pins six 2100 DST differences. Sampled summer 2040 and 2099 agree. |
| <a id="p4d-117"></a>P4D-117 | K7-D6 | [P4-51](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-51) · `packages/core/src/user-jobs/` | info | known difference | The pinned tzdb releases disagree around the Sep 2026 permanent UTC transition for Casablanca and El Aaiun. The fixtures pin the affected dates. |
| <a id="p4d-118"></a>P4D-118 | K7-D7 | [P4-51](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-51) · `packages/core/src/user-jobs/` | low | Rust port | A user-job claim rechecks and advances the same scheduled definition inside the write transaction, so a competing connection cannot dispatch the same slot. |
| <a id="p4d-119"></a>P4D-119 | K7-D8 | [P4-51](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-51) · `packages/core/src/user-jobs/` | low | Rust strict | Calendar wall years below 100 are refused. JavaScript Date.UTC maps them to 19xx. |
| <a id="p4d-120"></a>P4D-120 | K7-D9 | [P4-51](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-51) · `packages/core/src/user-jobs/` | low | Rust strict | An invalid job request that throws at a JavaScript type boundary receives a structured invalid response in Rust. |
| <a id="p4d-121"></a>P4D-121 | K7-D10 | [P4-51](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-51) · `packages/core/src/user-jobs/` | info | in parity | The interrupted-run reconciliation preserves the legacy coercion and allows a negative duration when the stored start is in the future. |
| <a id="p4d-122"></a>P4D-122 | K7-D11 | [P4-51](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-51) · `packages/core/src/user-jobs/` | info | Rust port | A user-jobs parent created by Rust has mode 0700. On Unix the file is 0600 in both implementations. |
| <a id="p4d-123"></a>P4D-123 | K7-D12 | [P4-51](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-51) · `packages/core/src/user-jobs/` | info | known difference | A user-job definition with a lone surrogate cannot be represented in the Rust JSON string type. |
| <a id="p4d-124"></a>P4D-124 | K7-D13 | [P4-51](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-51) · `packages/core/src/user-jobs/` | info | in parity | The combined jobs/history paths preserve JavaScript spread behavior, including string code points and rejection of a number. |
| <a id="p4d-125"></a>P4D-125 | K7-D14 | [P4-51](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-51) · `packages/core/src/user-jobs/` | info | known difference | Rust refuses instants within a day of the earliest JavaScript Date. The original calendar ledger used K7-D7 for this boundary. |
| <a id="p4d-126"></a>P4D-126 | K7-D20 | [P4-51](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-51) · `packages/core/src/dreams/` | low | Rust strict | A dreaming run may claim only its original key. Completion requires the claim and a terminal row remains terminal. |
| <a id="p4d-127"></a>P4D-127 | K7-D21 | [P4-51](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-51) · `packages/core/src/dreams/` | info | Rust port | Dream planning only reads the schedule. Lifecycle and admission own schedule synchronization and breaker normalization. |
| <a id="p4d-128"></a>P4D-128 | K7-D22 | [P4-51](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-51) · `packages/core/src/dreams/` | low | Rust port | Claim, quota and ledger start are atomic. Completion consumes only the observed corpus so later captures remain available. |
| <a id="p4d-129"></a>P4D-129 | K7-D23 | [P4-51](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-51) · `packages/core/src/dreams/` | security | flip | Learn transcript selection verifies current source and target rights, session identity, memory mode and exposure before and after loading. |
| <a id="p4d-130"></a>P4D-130 | K7-D24 | [P4-51](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-51) · `packages/core/src/dreams/` | low | flip | The dream scheduler returns due hints to the host and uses conditional advances bound to the observed activation, cron and zone. |
| <a id="p4d-131"></a>P4D-131 | K7-D25 | [P4-51](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-51) · `packages/core/src/dreams/` | security | Rust strict | Invalidating a learn run hides its checkpoints and clears associated sensitive material. Historical migration fixtures remain a separate proof. |
| <a id="p4d-132"></a>P4D-132 | K7-D26 | [P4-51](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-51) · `packages/core/src/dreams/` | security | flip | Promotion requires live rights, an agent envelope and batch-bound receipts. A diagnostic hash cannot stand in for a memory record id. |
| <a id="p4d-133"></a>P4D-133 | K7-D27 | [P4-51](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-51) · `packages/core/src/dreams/` | low | Rust port | The last shared REM or deep slot is claimed atomically. A crash charges an unconfirmed call and a confirmed skip releases it. |
| <a id="p4d-134"></a>P4D-134 | K7-D28 | [P4-51](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-51) · `packages/core/src/dreams/` | security | flip | Accepting a learn proposal requires a journaled, revision-bound action and complete evidence. Pending effects block conflicting changes. |
| <a id="p4d-135"></a>P4D-135 | K7-D29 | [P4-51](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-51) · `packages/core/src/dreams/` | security | flip | The evidence review path validates repository-relative file references and repeats authentication around reads. The host must bind the actual root and resolved files. |
| <a id="p4d-136"></a>P4D-136 | K7-D30 | [P4-51](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-51) · `packages/core/src/dreams/` | security | flip | The learn runner claims each target, reserves budget, rechecks rights and binds publication to the current selection digest. |
| <a id="p4d-137"></a>P4D-137 | K7-D31 | [P4-51](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-51) · `packages/core/src/dreams/` | info | Rust port | Learn installation reports bounded structural tool errors. The first stored revision uses the existing default of 1. |
| <a id="p4d-138"></a>P4D-138 | K7-D40 | [P4-51](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-51) · `packages/core/src/skill-mining/` | security | Rust strict | A workflow evidence key accepts only identical replay. The TypeScript internal writer can replace the existing row. |
| <a id="p4d-139"></a>P4D-139 | K7-D41 | [P4-51](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-51) · `packages/core/src/skill-mining/` | security | Rust strict | Mining requires ordered events, one session and turn, bound provenance and an unambiguous tool registry. The workflow artifact holds no arguments or results. |
| <a id="p4d-140"></a>P4D-140 | K7-D42 | [P4-51](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-51) · `packages/core/src/skill-mining/` | security | flip | A skill review requires live person and agent rights and one content-bound approval. Publication compares the current snapshot and receipt to the approved values. |
| <a id="p4d-141"></a>P4D-141 | K7-D43 | [P4-51](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-51) · `packages/core/src/skill-mining/` | security | flip | Artifact provenance binds its root, path and checksum. The sole dispatcher owns file effects and current owner authority. |
| <a id="p4d-142"></a>P4D-142 | K7-D44 | [P4-51](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-51) · `packages/core/src/knowledge/` | security | flip | Knowledge file writes and rollback bind the agent home, current person authority and backup integrity and require a host lock and atomic CAS. |
| <a id="p4d-143"></a>P4D-143 | K7-D45 | [P4-51](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-51) · `packages/core/src/knowledge/` | security | flip | The knowledge job checks original and current jobs.run and agent.use. The host owns the persistent timestamp, timer and dispatch. |
| <a id="p4d-144"></a>P4D-144 | K7-D46 | [P4-51](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-51) · `packages/core/src/media-search/` | security | flip | Media reference reads enforce current scope, and mutations require exact ownership. A stale or revoked write ticket cannot publish. |
| <a id="p4d-145"></a>P4D-145 | K7-D47 | [P4-51](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-51) · `packages/core/src/media-search/` | security | flip | Cloud media encoding requires confirmed function and endpoint plus reserved budget. A route change cancels before dispatch. |
| <a id="p4d-146"></a>P4D-146 | K7-D48 | [P4-51](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-51) · `packages/core/src/media-search/` | security | flip | Per-frame caption calls bind authority, route, budget and response identity. A dispatched call with unknown usage is settled at its reserved limit. |
| <a id="p4d-147"></a>P4D-147 | K7-D49 | [P4-51](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-51) · `packages/core/src/media-search/` | low | flip | Backfill advances by a CAS scoped to file and owner. Disabled or user-paused indexes never resume automatically. |
| <a id="p4d-148"></a>P4D-148 | K7-D50 | [P4-51](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-51) · `packages/core/src/media-search/` | security | flip | Codec tests use a fake process with the recorded arguments. A native adapter must preserve the verified file identity through bounded output collection. |
| <a id="p4d-149"></a>P4D-149 | K7-D51 | [P4-51](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-51) · `packages/core/src/media-search/` | security | flip | Media intake is a scoped queue. Upload records discard the generation prompt, and deletion invalidates inactive as well as active jobs. |
| <a id="p4d-150"></a>P4D-150 | K7-D52 | [P4-51](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-51) · `packages/core/src/media-search/` | info | flip | The media-model catalog checks capability, dimensions, licensing and privacy from the shared schema. Legacy fallback is limited to loading. |

### P4-K K8

| Id | Package label | MODULE-MAP owner and component | Severity | Status | Observed behavior or proof |
|---|---|---|---|---|---|
| <a id="p4d-151"></a>P4D-151 | K8-D1 | [P4-71](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-71) · `packages/core/src/acp/` | info | known difference | An unpaired surrogate in an ACP JSON value becomes U+FFFD in the Rust reader. |
| <a id="p4d-152"></a>P4D-152 | K8-D2 | [P4-71](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-71) · `packages/core/src/acp/` | info | known difference | Rust replies in arrival order for requests pipelined in the same chunk. Microtask depth can change the order in TypeScript. |
| <a id="p4d-153"></a>P4D-153 | K8-D3 | [P4-71](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-71) · `packages/core/src/acp/` | low | Rust port | An ACP output failure marks the reader lost immediately. The legacy server can continue writes until its stream event. |
| <a id="p4d-154"></a>P4D-154 | K8-D4 | [P4-71](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-71) · `packages/core/src/acp/` | low | Rust strict | A non-string session id from the Core is treated as an internal error instead of being echoed. |
| <a id="p4d-155"></a>P4D-155 | K8-D5 | [P4-71](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-71) · `packages/core/src/acp/` | low | Rust strict | An outbound value deeper than 2,000 levels is refused with output-error. |
| <a id="p4d-156"></a>P4D-156 | K8-D6 | [P4-71](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-71) · `packages/core/src/acp/` | low | Rust port | A connection bounds incomplete ACP work to 128 requests by default. The host can configure the per-connection cap. |
| <a id="p4d-157"></a>P4D-157 | K8-D7 | [P4-71](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-71) · `packages/core/src/acp/` | low | Rust port | ACP applies its 1 MiB UTF-8 line cap to responses and notifications as well as input. |

### P4-K K9a

| Id | Package label | MODULE-MAP owner and component | Severity | Status | Observed behavior or proof |
|---|---|---|---|---|---|
| <a id="p4d-158"></a>P4D-158 | K9a-D1 | [P4-42](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-42) · `packages/core/src/prompt/` | info | known difference | A JavaScript slice can produce an isolated surrogate in a query or skill description. Rust preserves length with U+FFFD. |
| <a id="p4d-159"></a>P4D-159 | K9a-D2 | [P4-42](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-42) · `packages/core/src/decision/` | security | flip | Legacy model output can supply a decision revision if no trusted provider completion is present. Rust accepts revision provenance only from the provider event. |
| <a id="p4d-160"></a>P4D-160 | K9a-D3 | [P4-42](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-42) · `packages/core/src/decision/` | low | Rust strict | An invalid numeric setting can throw during JavaScript coercion. Rust applies the documented decision-config fallback. |
| <a id="p4d-161"></a>P4D-161 | K9a-D6 | [P4-42](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-42) · `packages/core/src/triage/` | low | Rust strict | An externally supplied classification is refused above 32 tasks before copying or validation. |
| <a id="p4d-162"></a>P4D-162 | K9a-D7 | [P4-42](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-42) · `packages/core/src/prompt/` | low | Rust port | The prompt prefix, session-model and last-render caches retain at most 1,024 entries each, evicting in insertion order. |

### P4-K K9b

| Id | Package label | MODULE-MAP owner and component | Severity | Status | Observed behavior or proof |
|---|---|---|---|---|---|
| <a id="p4d-163"></a>P4D-163 | K9b-D1 | [P4-42](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-42) · `packages/core/src/toolcall/` | info | known difference | The platform-specific Node Math.log implementation can change the last rank bit. The test locates a real rank difference and compares tie order exactly. |
| <a id="p4d-164"></a>P4D-164 | K9b-D2 | [P4-42](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-42) · `packages/core/src/toolcall/` | low | Rust strict | Schema patterns and inputs have 256 and 1,024 UTF-16 unit caps. R-K-33b closes the flip blocker. With R-K-37, each argument validation shares 4,000,000 steps and caches up to 256 distinct compiled patterns. Exceeding either limit refuses the arguments. |
| <a id="p4d-165"></a>P4D-165 | K9b-D3 | [P4-42](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-42) · `packages/core/src/toolcall/` | security | flip | A Windows skill path is refused until the adapter can verify identity against the opened file handle. |

K9b-D2 is a flip blocker under R-K-33 until a metered UTF-16 matcher closes it
under R-K-33b. See [P4D-164](#p4d-164).

### P4-K K10

| Id | Package label | MODULE-MAP owner and component | Severity | Status | Observed behavior or proof |
|---|---|---|---|---|---|
| <a id="p4d-166"></a>P4D-166 | K10-D1 | [P4-30](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-30) · `packages/core/src/tools/` | security | Rust strict | The temporary file of a write is created private. The TypeScript path narrows its mode after creating it. |
| <a id="p4d-167"></a>P4D-167 | K10-D2 | [P4-30](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-30) · `packages/core/src/tools/` | low | Rust port | Write cleanup uses the held directory descriptor, so a rename of the parent does not redirect the cleanup. |
| <a id="p4d-168"></a>P4D-168 | K10-D3 | [P4-30](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-30) · `packages/core/src/tools/` | low | in parity | An audit append failure after exec can make the response describe a pre-execution failure. Preserve evidence that retry may repeat the effect. |
| <a id="p4d-169"></a>P4D-169 | K10-D4 | [P4-30](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-30) · `packages/core/src/policy/paths.ts` | security | flip | Rust stat and list use verified handles. Legacy path-based reads merit review at the flip. The difference was derived from code, without a live reproduction. |
| <a id="p4d-170"></a>P4D-170 | K10-D5 | [P4-30](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-30) · `packages/core/src/tools/` | security | Rust strict | A file tool rechecks its approved target at execution. A changed binding refuses before invoking the effect. |
| <a id="p4d-171"></a>P4D-171 | K10-D6 | [P4-30](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-30) · `packages/core/src/tools/` | low | Rust strict | The argument allowlist implements a subset of JavaScript pattern syntax. Unsupported patterns fail closed. |
| <a id="p4d-172"></a>P4D-172 | K10-D7 | [P4-30](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-30) · `packages/core/src/tools/` | info | known difference | Member order in a malformed environment can change which rejected name is reported. The environment is still refused. |
| <a id="p4d-173"></a>P4D-173 | K10-D8 | [P4-30](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-30) · `packages/core/src/tools/` | security | fixed in library | The Unicode regex allowlist had accepted an invalid JavaScript escape. The same pattern now authorizes nothing, with vector coverage. |
| <a id="p4d-174"></a>P4D-174 | K10-D9 | [P4-30](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-30) · `packages/core/src/policy/paths.ts` | security | legacy open | Legacy path resolution and open do not hold the same directory identity throughout the operation. Rust checks through a verified descriptor. Static finding D129. |
| <a id="p4d-175"></a>P4D-175 | K10-D10 | [P4-30](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-30) · `packages/core/src/policy/paths.ts` | security | Rust strict | A previously absent target may only be opened through its creation path. A pre-existing replacement is refused. |
| <a id="p4d-176"></a>P4D-176 | K10-D11 | [P4-30](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-30) · `packages/core/src/tools/` | security | Rust strict | The approval gate denies a policy context that identifies a different person, agent or session than its authorized caller. |
| <a id="p4d-177"></a>P4D-177 | K10-D12 | [P4-30](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-30) · `packages/core/src/tools/` | info | candidate | The Windows program-name deny list and its user-facing scope remain a review candidate. The gate must retain the actual authority and target checks. |
| <a id="p4d-178"></a>P4D-178 | K10-D13 | [P4-30](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-30) · `packages/core/src/policy/paths.ts` | security | Rust strict | Verified stat compares type, length, link count and available timestamps. Platforms without change time use the additional available identity evidence. |
| <a id="p4d-179"></a>P4D-179 | K10-D14 | [P4-31](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-31) · `packages/hostctl/src/` | info | Rust port | Host tools check bounds before native effects and record approved action and target hashes. The audit excludes clipboard, command, URL and file contents. |
| <a id="p4d-180"></a>P4D-180 | K10-D15 | [P4-31](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-31) · `packages/hostctl/src/` | security | Rust strict | Host shell use requires opt-in and approval. Hard argument checks and wrapper exclusions continue to apply to the supported literal grammar. |
| <a id="p4d-181"></a>P4D-181 | K10-D16 | [P4-31](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-31) · `packages/hostctl/src/` | security | flip | Host publication must be exclusive and native effects must retain verified identity. A move permits only supported same-filesystem sources. |
| <a id="p4d-182"></a>P4D-182 | K10-D21 | [P4-11](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-11) · `crates/plur1bus-core/src/logs/` | security | Rust strict | Log readers verify opened regular-file identity and refuse replaced leaves. Watchers revalidate before accepting new lines. |
| <a id="p4d-183"></a>P4D-183 | K10-D22 | [P4-31](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-31) · `packages/hostctl/src/` | security | Rust strict | Host document opening refuses the legacy launchable file classes plus additional platform launcher and configuration types. The vectors preserve both outcomes. |
| <a id="p4d-197"></a>P4D-197 | K10-D23 | [P4-31](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-31) · `packages/hostctl/src/` | security | Rust strict | R-K-31 requires ASCII program names in direct calls and at the program position of shell commands. The flip must use the same admission rule. |
| <a id="p4d-198"></a>P4D-198 | K10-D24 | [P4-31](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-31) · `packages/hostctl/src/` | security | flip blocker | RE-6 and R-K-30 require a private receipt when an effect precedes result or audit failure, and confirmed stop or continued management of a newly started process. R-K-36 requires durable storage with a seven-day and 10,000-record limit per identity. |
| <a id="p4d-203"></a>P4D-203 | K10-D25 | [P4-31](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-31) · `packages/hostctl/src/` | security | Rust strict | R-K-34 excludes BASHOPTS, SHELLOPTS and PS4 from inherited and requested inputs. The literal shell subset excludes the arithmetic assignment builtin. |
| <a id="p4d-225"></a>P4D-225 | K10-D26 | [P4-31](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-31) · `packages/hostctl/src/` | low | Rust strict | R-K-35 disables bash and zsh user startup files, excludes ZDOTDIR and refuses program-launching completion and input builtins at the command position. TypeScript uses the earlier shell admission rules. |
| <a id="p4d-199"></a>P4D-199 | K5-D11 | [P4-40](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-40) · `packages/core/src/session/` | security | Rust strict | R-K-28 requires an exclusive host writer lease through the file restore, including the final comparison. |
| <a id="p4d-200"></a>P4D-200 | K9a-D8 | [P4-42](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-42) · `packages/core/src/triage/` | low | Rust strict | R-K-29 requires a nonempty string for each external task summary. The runtime uses its rule fallback on a segmentation error. |
| <a id="p4d-201"></a>P4D-201 | K7-D53 | [P4-51](../superpowers/plans/phase4/MODULE-MAP.md#source-p4-51) · `packages/core/src/user-jobs/` | security | Rust strict | R-K-32 requires refusal on an explicit negative permission verdict even on Unix. |

### P4-K K11

| Id | Package label | MODULE-MAP owner and component | Severity | Status | Observed behavior or proof |
|---|---|---|---|---|---|
| <a id="p4d-184"></a>P4D-184 | K11-D1 | [P4-45](../superpowers/plans/phase4/MODULE-MAP.md#p4-k-libraries) · `crates/plur1bus-core/src/decision/receipts/` | info | Rust design | The receipt format v1 has closed triage, routing and tools use cases. New use cases require an intentional format extension. |
| <a id="p4d-185"></a>P4D-185 | K11-D2 | [P4-45](../superpowers/plans/phase4/MODULE-MAP.md#p4-k-libraries) · `crates/plur1bus-core/src/decision/receipts/` | security | flip | Receipts admit bounded identifiers only. The capture adapter must map content-like option ids before writing. |
| <a id="p4d-186"></a>P4D-186 | K11-D3 | [P4-45](../superpowers/plans/phase4/MODULE-MAP.md#p4-k-libraries) · `crates/plur1bus-core/src/decision/receipts/` | security | Rust design | An authorized owner or administrator can list. Replay and adoption require a person, and a scoped person token needs the separate right for each action. |
| <a id="p4d-187"></a>P4D-187 | K11-D4 | [P4-45](../superpowers/plans/phase4/MODULE-MAP.md#p4-k-libraries) · `crates/plur1bus-core/src/decision/receipts/` | info | Rust design | Retention keeps a receipt at exactly 30 days and prunes when older. Count retention keeps exactly the configured maximum. |
| <a id="p4d-188"></a>P4D-188 | K11-D5 | [P4-45](../superpowers/plans/phase4/MODULE-MAP.md#p4-k-libraries) · `crates/plur1bus-core/src/decision/receipts/` | low | flip | Retention is enforced when the host calls prune. Without host scheduling the configured count cannot bound disk use. |
| <a id="p4d-189"></a>P4D-189 | K11-D6 | [P4-45](../superpowers/plans/phase4/MODULE-MAP.md#p4-k-libraries) · `crates/plur1bus-core/src/decision/receipts/` | security | flip | Replay refuses before loading cases if any required gate fails. Local-only requires a locally supported decision backend. |
| <a id="p4d-190"></a>P4D-190 | K11-D7 | [P4-45](../superpowers/plans/phase4/MODULE-MAP.md#p4-k-libraries) · `crates/plur1bus-core/src/decision/receipts/` | security | Rust design | Adoption validates final report kind, disjoint case ids and report hash. The authorized person selects the baseline. |
| <a id="p4d-191"></a>P4D-191 | K11-D8 | [P4-45](../superpowers/plans/phase4/MODULE-MAP.md#p4-k-libraries) · `crates/plur1bus-core/src/decision/receipts/` | low | Rust port | K11-R1 superseded the original receipt adoption write order. A durable pending row reconciles the exact calibration version on restart. |
| <a id="p4d-192"></a>P4D-192 | K11-D9 | [P4-45](../superpowers/plans/phase4/MODULE-MAP.md#p4-k-libraries) · `crates/plur1bus-core/src/decision/receipts/` | info | flip | The D2 golden test compares capability counters for identical events. The dispatch path that produces those events in a live turn still needs wiring. |
| <a id="p4d-193"></a>P4D-193 | K11-D10 | [P4-45](../superpowers/plans/phase4/MODULE-MAP.md#p4-k-libraries) · `crates/plur1bus-core/src/decision/receipts/` | info | Rust design | The Rust-owned receipt database uses WAL. Marker checks cover the database and sidecars for accidental content. |
| <a id="p4d-194"></a>P4D-194 | K11-D11 | [P4-45](../superpowers/plans/phase4/MODULE-MAP.md#p4-k-libraries) · `crates/plur1bus-core/src/decision/receipts/` | info | Rust design | A receipt records the injected clock at write time rather than trusting a host-supplied data timestamp. |

<a id="p4d-203"></a>

## P4D-203 — Hostctl shell control inputs (R-K-34)

Rust excludes BASHOPTS, SHELLOPTS and PS4 from inherited and requested Hostctl
environment values. The literal proc.shell subset excludes the arithmetic
assignment builtin. The TypeScript admission policy has the earlier rules.

<a id="p4d-195"></a>

## P4D-195 — provider header redaction after normalization

TypeScript builds its provider-error redaction targets from the original credential and configured
extra headers. HTTP header normalization can change that spelling, so a provider error that
includes the corresponding sent value can retain it. The Rust library redacts the sent value
and the original. The provider exporter pins the two outcomes with synthetic markers on a
loopback fixture.

<a id="p4d-196"></a>

## P4D-196 — invalid reasoning descriptors

The directive builder can receive catalog data outside its declared TypeScript types. The recorded
cases cover a string toggle, a truthy non-boolean adaptive flag, an unknown kind kept with an adaptive
flag, and missing or numeric-string budget bounds. The adapter already validates its wire directive.
Rust uses a boolean toggle, enables adaptive thinking only for a declared effort flag, and requires
numeric budget bounds. The six catalog cases are recorded from the real TypeScript builder. A null
effort value falls back to the chosen level in both languages.

<a id="p4d-202"></a>

## P4D-202 — cloud voice JSON responses have no byte limit

Security, W3, reported from static review. The voice HTTP client calls
`Response.json()` on a successful response. The production voice transport
passes the body stream through to the client. The headers deadline has already
ended by the time parsing starts. Listing voices limits the number of pages,
but accepts the full contents of each page before iterating its entries. An
oversized response can exhaust process memory. No live provider or stress
test was used. See [HTTP parsing](../../packages/voice-providers/src/http.ts),
[voice transport](../../packages/core/src/voice/transport.ts) and
[voice listing](../../packages/voice-providers/src/providers/elevenlabs.ts).

R-W-12 requires a 1 MiB decoded byte limit on each successful JSON body and
one absolute deadline covering both headers and the complete body. The
Rust reader checks the limit before parsing and reports overflow as an
unretryable `bad_response`. Provider error bodies are dropped unread.

<a id="p4d-204"></a>

## P4D-204 — buffered cloud voice audio

The Rust buffered audio path reads at most 4 MiB decoded bytes. It shares the
absolute request deadline across headers and body. Polly uses the same audio
limit and delegates signed calls to a host port that must honor that deadline.

<a id="p4d-205"></a>

## P4D-205 — structured realtime voice messages

Each assembled structured voice message is limited to 1 MiB, including
fragmented WebSocket messages. The host supplies finite handshake and I/O
deadlines. The runtime delivers decoded events on demand.

<a id="p4d-206"></a>

## P4D-206 — Gemini realtime credentials

The Rust Gemini handshake accepts only the header form of the credential.
The TypeScript gateway fallback can put credentials in a URL query. The
Rust host can use a gateway that forwards the credential header.

<a id="p4d-207"></a>

## P4D-207 — robots.txt byte ceiling

The TypeScript crawl path limits the fetched body to 512 KiB and passes up
to 500 Ki UTF-16 code units to the parser. The Rust parser rejects a complete
body over 500 KiB of UTF-8 bytes. Its eventual fetch port must limit decoded
bytes before parsing and map overflow to a denied crawl, keeping an incomplete
policy out of the crawler's cache.

<a id="p4d-208"></a>

## P4D-208 — stdio MCP bridge HTTP replies

The local stdio server calls `fetch` and buffers the API's response with
`Response.text()`. This forwarding path has no explicit body byte ceiling
or deadline. The Rust JSON reader enforces 1 MiB on decoded replies and uses
the request's absolute deadline for every read. Rejected HTTP statuses return
only their numeric code. The host connection must enforce the deadline while
blocked in a read and release the body after a failure.

<a id="p4d-209"></a>

## P4D-209 — A2A Agent Card advertisement boundary

The Rust card builder requires agent opt-in at the projection boundary,
validates an HTTP(S) base URL without user information, query or fragment,
and excludes path-navigation identities. The TypeScript handler enforces
opt-in before it invokes the builder. The Rust field limits count UTF-16
units and stop before a scalar that would cross the limit. TypeScript slicing
can emit a lone surrogate at that boundary.

<a id="p4d-210"></a>

## P4D-210 — cloud synthesis stream deadline and completion

The Rust HTTP audio stream reads one decoded chunk at a time under the
request's absolute deadline. WebSocket synthesis uses the same absolute
deadline for writes and reads, admits structured frames up to the
P4D-205 ceiling, and exposes usage only after the text input and the provider's
final frame both complete. The TypeScript HTTP deadline ends at the headers.
The TypeScript socket consumer queues audio frames asynchronously. The native
host owns the ordering of calls to the blocking dialogue.

<a id="p4d-211"></a>

## P4D-211 — streaming text admission and usage identifiers

The Rust Polly sentence splitter admits up to 1 MiB per input delta and
keeps up to 1 MiB of unfinished text. Individual signed requests use Polly's
3,000 UTF-16 code unit ceiling. The TypeScript sentence splitter has no bound
on unfinished text. The Rust realtime host supplies the Gemini session
identifier used to deduplicate usage events. Audio and transcripts remain
application data and are omitted from event Debug output.

<a id="p4d-212"></a>

## P4D-212 — retry after publishing a media result

The TypeScript JobRunner can publish a result and then persist a failed job when
budget settlement fails. Recovery scans queued and running jobs, so it never
reconciles that failed row with its already published output. The Rust runner
returns the settlement error with the durable row still running. On recovery it
finds the output, retries settlement under the same job id, and persists the
success without calling the provider again. The budget port owns durable,
idempotent settlement. The focused Rust failure test covers the retry boundary.

<a id="p4d-219"></a>

## P4D-219 — Polly diagnostic body admission

The TypeScript SDK may read an AWS diagnostics body before classifying a
failure. The Rust transport classifies a known error header without reading
the body. A body-only error is decoded under the original request deadline
and limited to 64 KiB. Overflow yields `bad_response`. Provider message text
is discarded. The boundary and delayed-body tests cover both restrictions.

<a id="p4d-220"></a>

## P4D-220 — generated media manifest admission

The Rust output store bounds a generated manifest to 1 MiB when reading it.
The storage port applies the size limit during the read. The library checks
the returned size, schema and output identity before handing the manifest to
its caller, and applies the same bound before publishing new manifests.

<a id="p4d-221"></a>

## P4D-221 — document review font family matching

The TypeScript font check in the document library compares lowercased
font references against the original case of the embedded families. This
reports an error for embedded Inter. Rust normalizes both names and still
flags families absent from the document and the system fallback list. The
fixture records the TypeScript finding. The Rust check also resolves the
template's three CSS font variables against their declared family lists.

<a id="p4d-222"></a>

## P4D-222 — document widow check with inline markup

The Chromium layout check addresses the last words of each paragraph
relative to the complete paragraph text. The TypeScript script applies
those offsets to the first child alone. A paragraph with emphasis or a
link can therefore abort the check. The Rust asset maps word offsets to
the corresponding text nodes before comparing line positions.

<a id="p4d-223"></a>

## P4D-223 — media adapter structured response and diagnostics limits

The TypeScript media transport reads successful JSON and diagnostic responses
under one 64 MiB limit. Under R-W-13 the Rust transport bounds decoded JSON
at 1 MiB and diagnostic bodies at 64 KiB. Declared lengths can reject early.
The reader counts the bytes it receives, including after gzip decoding.
HTTP setup, retry waits and body reads share the absolute operation deadline.
An in-flight blocking read can defer cancellation until that deadline (R-W-9).
The adapters apply separate file limits to binary media.


<a id="p4d-224"></a>

## P4D-224 — managed discovery reuses the Apple FM body cap

The managed Unix transport shares the provider connector's one MiB ceiling
and keeps the original deadline through body EOF. A response above the cap
returns `response_too_large`; the TypeScript discovery path allows four MiB.
TCP discovery retains the TypeScript four MiB per-page and eight MiB total
bounds. Provider error bodies are not read by the Rust scanner.

<a id="p4d-226"></a>

## P4D-226 — discovery transport diagnostics

The Rust scanner binds a credential lease to its authorized origin before
admitting a request. Its errors omit headers and response bodies. If the
signed catalogue falls back to an authenticated cached view after a transport
failure, Rust preserves the failure code and uses a generic diagnostic message.
The TypeScript view can name the request host.

<a id="p4d-227"></a>

## P4D-227 — guarded web transport response bounds

The Rust web transport admits up to four nested content encodings and keeps
diagnostic response prefixes at or below 64 KiB. The TypeScript client permits
a coding list of arbitrary depth and uses the diagnostic limit supplied by its
caller. Body decoding and each authorized redirect share the original
deadline. A blocking read can defer cancellation until that deadline (R-W-9).

<a id="p4d-228"></a>

## P4D-228 — readable HTML table admission

The Rust renderer refuses table grids whose padded projection would exceed
300,000 cells. It retains the legacy HTML element and nesting limits.
Oversized tables fail the extraction as a whole. The TypeScript renderer
does not apply a separate bound to the padded table grid.

<a id="p4d-229"></a>

## P4D-229 — MCP HTTP response deadlines and limits

The generic Rust MCP backend reads structured HTTP replies up to the 16 MiB
SDK ceiling and caps error replies at 64 KiB. It applies a single finite
deadline from the egress decision through the last read and counts raw SSE
event bytes before parsing. The composed connection keeps the TypeScript
1 MiB frame limit. The HTTP adapter asks for identity coding and rejects
other encodings. Error diagnostics contain status and category. The adapter
discards peer-provided error text and arbitrary error data. It keeps only
known version names for a bounded discovery fallback.

<a id="p4d-230"></a>

## P4D-230 — bounds for MCP OAuth exchanges

Rust applies a finite, shared deadline to discovery, the authorization
interaction and token exchange. It accepts at most 1 MiB of structured
metadata or token data and at most 64 KiB from unsuccessful replies. The
credential-free discovery and token requests use the pinned HTTP transport.
Errors retain a fixed category and omit response bodies.

<a id="p4d-231"></a>

## P4D-231 — deadline for incomplete MCP stdio frames

Rust keeps the 1 MiB line boundary and sets one deadline when an incomplete
line starts. The deadline survives read cancellation and applies to the
remainder of that line. If a send stops after taking the writer, the stream
closes so a partial write cannot prefix a new frame. Process-group termination
and stderr ownership remain with the launcher port.

<a id="p4d-232"></a>

## P4D-232 — MCP runtime request IDs and SDK logging

The rmcp client numbers its own modern requests from zero. The TypeScript
modern peer numbers them from one. The IDs are local correlation values,
and the replay accounts for the offset while comparing the other request
bytes. The Rust SDK runs on a dedicated thread with a scoped tracing
dispatcher so that SDK events carrying peer data cannot enter host logs.
The host still applies the shared wire-record filter to the HTTP library.

<a id="p4d-233"></a>

## P4D-233 — content-free MCP server diagnostics

The Rust HTTP protocol uses the same JSON-RPC codes for mismatched
MCP parameter headers. Its message omits parameter-header names and
values. Tool lookup likewise uses one response for both an unavailable
tool and a name the actor is not allowed to use.

<a id="p4d-234"></a>

## P4D-234 — MCP tool output schema admission

Like TypeScript, the native client checks a structural copy of a tool's output
schema with regex keywords removed. Rust also refuses schema references and
caps schema and instance nodes, nesting, container sizes and validation work.
The original descriptor remains available to the caller. A refused schema
does not authorize the call. Validation errors omit peer diagnostics and
response contents.

<a id="p4d-235"></a>

## P4D-235 — Signed A2A 1.0 cards and peer pins

The Rust library validates typed fields before serializing the SDK's signed
card projection. It rejects ambiguous camelCase and snake_case fields,
ambiguous security alternatives, coercions of malformed field types, and
non-scalar Unicode. The original TypeScript SDK coerces some malformed
fields. Rust uses the registered key, key ID and RFC 7638 fingerprint. The
single usable JSON-RPC 1.0 endpoint must share the registered card origin.
The host records explicit human confirmation bound to the peer revision,
key fingerprint and endpoint. Each operation verifies the card again.

<a id="p4d-236"></a>

## P4D-236 — A2A 0.3 request and event boundaries

The Rust HTTP adapter refuses non-loopback bindings or an unmatched Host
before reading an incoming body. It retains the one MiB request cap and
the smaller limits for Parts. Diagnostic messages use fixed text for
unsupported Parts, with a 128-unit limit on echoed RPC IDs. The TypeScript
implementation echoes an unsupported kind and accepts longer string IDs.
File URI parts are references. Push endpoints with URL fragments are
refused. The host owns task policy and the filesystem and must enforce the
provided absolute deadline. A response stream binds to the admitted task
and context, and releases its subscription on disconnect, expiry or final
status. Disconnect leaves the task available to a new subscription.

<a id="p4d-237"></a>

## P4D-237 — A2A 1.0 outbound lease and response bounds

The existing Core defaults are 128 KiB for card JSON and 16 KiB each for
requests and replies. The explicit Core maximum for requests and replies
is 64 KiB. The Rust transport applies its reply cap to the entire SSE
response including framing and verifies each event's correlation and task
scope. An incomplete stream is a protocol error. Under R-W-9, cancellation
during blocking I/O can be observed as late as the unchanged original
deadline. The client re-admits each same-origin card redirect. An
unsuccessful POST is never sent again by the library. Non-success response
bodies are dropped, and a response error carries only its validated numeric
RPC code. The host settles attempted writes with unknown outcomes against
the reservation and uses the shared wire logger from R-W-11.

<a id="p4d-238"></a>

## P4D-238 — Reflected A2A credential representations

The peer client masks known operation credentials and their canonical
encodings in decoded JSON before returning output. It drops object fields
whose names would copy a credential. Expansion from replacement text is
bounded by the same output limit. The trusted host's output redactor
remains responsible for wider Core secret/PII policy.

<a id="p4d-239"></a>

## P4D-239 — Web result presentation and cancellation

The Rust fetch presenter applies the current redaction context to both
locations of the final URL and to the content type on fresh and cached
reads. Search providers mask reflected forms of their own credential
leases in result text and discard result URLs containing those forms.
JSON formatting charges UTF-16 output units before appending tokens and
indentation, then reports the ordinary extraction limit if the projection
would exceed it. The HTTP adapter also checks the original deadline and
cancellation after receiving headers, before any bodyless result or
redirect can leave the transport.

<a id="p4d-240"></a>

## P4D-240 — MCP registry cache admission and HTTP diagnostic IDs

Reading a cached tool list requires current host admission and time in
the request window. The library checks retirement and time again after
redaction. Cache admission alone never opens a connection. Modern and
legacy MCP HTTP requests use the same 128 UTF-16 unit limit on echoed
string request IDs. The TypeScript server accepts longer IDs.

<a id="p4d-241"></a>

## P4D-241 — IMAP response metadata budget

The TypeScript client limits individual literals. The Rust client also
limits decoded metadata across a command response to 1 MiB under R-W-13,
including an IDLE exchange. Mail payload keeps its 50 MiB per-literal
limit and shares the existing 64 MiB total with metadata. The reader
charges literal bytes before allocating their buffer. The existing
SMTP/IMAP error projection uses static protocol descriptions.

<a id="p4d-242"></a>

## P4D-242 — MCP reply backpressure (R-W-16)

The client and stdio server admit up to 64 outstanding peer requests per
connection. They account separately for retained request IDs and for completed
replies awaiting a write. At 1 MiB of encoded unwritten replies, admission
pauses until the writer drains. Completing or cancelling an incoming request
releases its slot. Host computation can outlast the closing deadline. The
host must bound the work performed for the 64 admitted requests at the flip.

<a id="p4d-243"></a>

## P4D-243 — MCP event stream reconnect budget (R-W-17)

The Rust HTTP adapter waits at least one second between attempts, doubles that
delay up to 60 seconds and fails after ten consecutive reconnects without a
received protocol message. Server retry hints are clamped to the same range.
The TypeScript implementation has no equivalent bound across successfully
opened streams.

<a id="p4d-244"></a>

## P4D-244 — MCP and discovery display text (R-W-25)

The Rust MCP descriptor removes invisible display controls from names, titles
and descriptions. It rejects an empty or ambiguous name after cleaning, and
uses the original wire name on the connection. Unicode truncation keeps
complete scalars. Only the supported descriptor fields are projected, including
an optional `ui://` resource name. The shared display rule also applies to
model labels when ported in W5.

<a id="p4d-245"></a>

## P4D-245 — MCP call cancellation and connection lifecycle at the flip

The Rust library limits calls to at most 600 seconds and returns on deadline.
The flip must expose per-call cancellation and terminate the corresponding
connection and owned process tree on deadline or cancellation, as the
TypeScript path does. It must notify the registry promptly of termination so
idle caches and restart state follow the connection.

<a id="p4d-246"></a>

## P4D-246 — MCP session and resume identifiers

Rust accepts only visible ASCII and at most 1 KiB for a peer's session ID
or a nonempty SSE event ID before retaining it. Empty SSE IDs still clear
the resume cursor. Plain-HTTP `localhost` admitted by the host must also be
pinned to loopback.

<a id="p4d-247"></a>

## P4D-247 — Incremental speech sentence boundaries (W3-R1)

The Rust Polly sentence and word scanner keeps its offset between deltas.
It checks the caller's cancellation and deadline within each scan and retains
the 1 MiB ceilings on one delta and unfinished text. The TypeScript chunker
can rescan an unfinished numeric lookahead across deltas.

<a id="p4d-248"></a>

## P4D-248 — Replay policy after sending synthesis input (R-W-22)

Rust retries a body-carrying operation only after HTTP 429 or 503 with a
valid Retry-After. A transport failure may occur after the vendor has accepted
the input. This differs from the TypeScript HTTP client. Once audio has
been delivered, the original error code is preserved and the error is no longer
retryable. Deadline expiry while reading audio has code `timeout`. The host
must decide whether to resubmit a paid request after a network failure before
the first audio chunk. The provider may already have accepted the body.

<a id="p4d-249"></a>

## P4D-249 — Cumulative synthesis stream limits (R-W-23)

The port or WebSocket settings can set a total decoded audio limit and a
maximum duration for HTTP, Polly, WebSocket synthesis, and realtime streams.
Rust defaults to 64 MiB and at most 600 seconds. It rejects a chunk before
delivery when the chunk would exceed the remaining budget. Host overrides
are capped at 1 GiB. The error code is `stream_limit`. Polly checks the
remaining budget before submitting the next signed request. The realtime
deadline applies to the whole session, so a host continuing a longer
conversation must open a new session.

<a id="p4d-250"></a>

## P4D-250 — Bounded HTML formatting and extraction (R-W-15)

Rust gives retained Markdown blocks, inline buffers and table cell text a
shared budget of four UTF-16 units per configured extraction token plus
4,096 units of lookahead, capped at the default response body limit. It
collapses consecutive blank lines in preformatted blocks before charging
them where no enclosing list or quotation will prefix the lines.
Intermediate output can still reach the budget before final whitespace
trimming. TypeScript checks the token count after rendering.

Error responses use a separate budget of 4,096 UTF-16 units for HTML
diagnostics. Both rendering paths check the fetch deadline and caller
cancellation. Exhausting the diagnostic budget preserves the HTTP status
classification. Interruption propagates as a timeout.

<a id="p4d-251"></a>

## P4D-251 — Private Chromium pipe and document resource policy (R-W-26)

Rust uses the Chromium DevTools pipe and attaches to a single private target.
It supplies the document through interception, without opening a DevTools
listener. The content policy allows inline styles and embedded fonts and
images. The installed Paged.js asset is read from the trusted host path and
evaluated through the controlled session. Fetch interception checks redirects and
ordinary subresource requests. The document CSP blocks script execution and
connections, including script-created workers and WebRTC. Chromium's resolver
rules block name resolution for other connections, including preconnects.
The review found that interception alone did not cover WebSockets, shared
workers, STUN or preconnects. The system proxy is a separate host boundary.
The launcher clears the inherited environment and assigns a fresh home, temp,
profile and crash directory for each render. On macOS it also sets
`MAC_CHROMIUM_TMPDIR` for Chromium and `CFFIXED_USER_HOME` for Foundation.
The renderer disables crash reporting and component updates and uses the mock
keychain on macOS. The driver removes the private directory after the process
exits.
The driver caps the deadline at 600 seconds and checks cancellation while
waiting on the pipe. On Windows the process launcher uses the configured Node
binary to attach the Chromium pipe descriptors.

<a id="p4d-252"></a>

## P4D-252 — Escaped document text survives assembly (R-W-27)

The Rust templates preserve attribute-like text after escaping. The TypeScript
post-processing pass can remove part of that text. The Rust document policy
described in P4D-251 also applies to document inputs outside template assembly.

<a id="p4d-253"></a>

## P4D-253 — Bound Telegram REST responses (R-W-13)

The Rust Telegram client accepts up to 1 MiB of structured response data and
64 KiB of diagnostic response data. The request deadline covers the body.
TypeScript reads REST JSON without these byte limits. An oversized diagnostic
body is discarded; the HTTP status and available retry header still apply.

<a id="p4d-254"></a>

## P4D-254 — Bound Slack REST responses (R-W-13)

The Rust Slack client accepts up to 1 MiB of structured response data and
64 KiB of diagnostic response data. The request deadline covers the body.
TypeScript reads REST JSON without these byte limits. An oversized diagnostic
body is discarded; the HTTP status and available retry header still apply.

<a id="p4d-255"></a>

## P4D-255 — Bound Discord REST responses (R-W-13)

The Rust Discord client accepts up to 1 MiB of structured response data and
64 KiB of diagnostic response data. The request deadline covers the body.
TypeScript reads REST JSON without these byte limits. An oversized diagnostic
body is discarded; the HTTP status and available retry header still apply.

<a id="p4d-256"></a>

## P4D-256 — Bind IMAP message bodies to the requested UID

Rust delivers a FETCH body only when the same untagged response names the
requested UID. TypeScript can take a BODY[] found in another FETCH response.
A server that omits the UID from the FETCH response cannot deliver that body.

<a id="p4d-257"></a>

## P4D-257 — Drop an incomplete IMAP literal stream

Rust drops the underlying stream when a literal read ends early. In IDLE,
it returns the timeout to the caller. A timeout while waiting for the next
response still permits DONE if the stream is synchronized.

<a id="p4d-258"></a>

## P4D-258 — Bound aggregate IMAP reply data

The Rust client bounds literal data and metadata together at 64 MiB, limits
each literal to 50 MiB and permits at most 8192 literals per response or 8192
untagged responses per command. TypeScript limits each literal without these
aggregate ceilings. P4D-241 documents the separate 1 MiB metadata ceiling.

<a id="p4d-259"></a>

## P4D-259 — Apply the MIME part budget across the tree

Rust counts parts across a message and passes the remaining budget into
each multipart. TypeScript applies the limit separately in each multipart.

<a id="p4d-260"></a>

## P4D-260 — Bound MIME HTML input by UTF-8 bytes

The Rust renderer takes at most 1 MiB of HTML at a UTF-8 character boundary.
TypeScript caps this input by UTF-16 code units. Rust may shorten multibyte
HTML earlier.

<a id="p4d-261"></a>

## P4D-261 — Require TLS for remote A2A peers (R-W-19)

The Rust peer client refuses HTTP on a non-loopback socket unless policy
expressly allows cleartext for that registered peer. The check runs before
reading the bearer on discovery, each card redirect and every operation.
TypeScript accepts registered HTTP peers without this separate switch.

<a id="p4d-262"></a>

## P4D-262 — Bound A2A push delivery (R-W-20)

Rust bounds the serialized task at 1 MiB and the diagnostic response at
64 KiB. It validates and pins each redirect target, refuses user information
and fragments, and removes both credential headers when the origin changes.
TypeScript discards the body. Rust uses a bounded reader, preserving the
status decision when a diagnostic reply is oversized or ends early.

<a id="p4d-263"></a>

## P4D-263 — A2A JSON and card admission

The Rust endpoint rejects numbers outside the finite f64 range and unpaired
Unicode surrogates as parse errors. The TypeScript parser accepts these JSON
tokens. The Rust peer card verifier also rejects control characters in
`kid`, overlong URLs and a JSON-RPC 1.0 interface with no URL.

<a id="p4d-264"></a>

## P4D-264 — Bind plaintext discovery to explicit configuration (R-W-24)

Rust permits remote HTTP only when the host confirms the base URL was
explicitly configured and the scan carries no lease. TypeScript enforces the
credential condition through its transport policy. Rust also refuses
abbreviated IPv4 or IPv4-mapped loopback aliases such as `127.1` and
`[::ffff:127.0.0.1]`.

<a id="p4d-265"></a>

## P4D-265 — Observe discovery cancellation while reading (R-W-9a)

Discovery checks cancellation before and after body and decoder reads.
The shared connector polls an in-progress connection or socket operation
in slices of at most 100 ms. The caller samples its cancellation predicate
at most 25 ms apart while the worker is waiting. TypeScript forwards an
abort signal to its asynchronous transport. The total scan budget is
60 seconds and the maximum for a page is 15 seconds.

<a id="p4d-266"></a>

## P4D-266 — Sanitize model-server display names (R-W-25)

Model scanners first apply the TypeScript admission rule to the original
name. A C0, DEL or C1 control character or a length above 512 UTF-8 bytes
fails the complete scan with `invalid_entry`. Accepted names and MCP display
fields share a Unicode projection that removes control, format, private-use,
unassigned, line-separator, paragraph-separator and default-ignorable
characters. Model IDs retain their own grammar. An empty projected name
falls back to the model ID.


<a id="p4d-267"></a>

## P4D-267 — Bounded per-host crawl reservations (W6-N5)

Rust keeps up to 1,024 host reservations. On overflow it removes expired
reservations first, then evicts the oldest remaining reservation by sequence
number if needed. A subsequent visit to that evicted host starts a fresh
reservation. TypeScript can retain more hosts when all reservations are live.

<a id="p4d-268"></a>

## P4D-268 — Reject HTML beyond the parser depth limit (W6-R3)

Rust returns `too-large` when an element would exceed the parser stack limit
of 200 open elements, excluding the document root. The TypeScript extractor can
flatten further nesting. Rust also caps parsed elements and the table grid
at 300,000 each.


<a id="p4d-269"></a>

## P4D-269 — Page IMAP UID searches (R-W-28)

The wire library requests UIDs by message sequence number. A single call
delivers up to 4,096 existing messages and continues from the last UID
accepted by the consumer. The server may request smaller pages with
`[LIMIT]`. When an expunge invalidates a sequence position, the next call
locates the saved UID boundary using binary search on existing messages.
The 64 KiB response line limit applies throughout. TypeScript issues an
open-ended search and can receive a longer reply line.

<a id="p4d-270"></a>

## P4D-270 — Discord outbound message and upload restrictions (W2-N1, W2-N6)

Rust checks path segments before identifying routes and rate-limit buckets.
It rejects dot segments, doubled separators, and encoded dots or separators.
Outgoing message objects, including webhook sends and nested message fields,
receive an empty mention policy. Re-encoding removes duplicate JSON keys.
File uploads require a prepared message part and an ASCII filename containing
only letters, digits, period, dash or underscore. TypeScript sanitizes its
filenames and uses a narrower set of webhook routes.

<a id="p4d-271"></a>

## P4D-271 — Whole MCP tool result size (W7-N2)

TypeScript charges content and structured data before adding provenance. The Rust
registry also measures the final serialized UTF-8 result, including its envelope,
unknown blocks and retained metadata. A result exactly at the configured limit
is valid. The caller receives `ResultLimit` when the result would exceed it.
