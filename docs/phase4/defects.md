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
| P4D-5 | After the front door dies abruptly, the old legacy core stops on its own while a new front door waits; an offline writer could overlap it | `packages/core/src/core.ts` | low | P4-90 | open |
| P4D-6 | The legacy core's Windows pipe keeps Node's default DACL (ADR-012 C2) | `packages/core/src/core.ts` | low | P4-90 | open, contained |
| P4D-7 | The front door's own diagnostics are plain stderr lines, not log-schema records in `logs/core.log` | `packages/core/src/logger.ts` | info | P4-11 | open |
| P4D-8 | module-api's `validApiPrincipal` coerces `role` and `kind` with `String()`; the Rust port does not | `packages/module-api/src/api-principal.ts` (reference) | low | P4-12 | open, Rust strict |

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
nested deeper than 128 levels is refused with `-32700` (a request) or forwarded with only its id replaced (an answer, a
warning on stderr).

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
cannot keep an owner from its handshake (logged once as `unauthenticated connections at their limit`). Running out of
descriptors is logged once per burst with the limit in force (`openFiles`). The TypeScript server has neither cap; its
30 s handshake deadline is the same.

## P4D-5 — the old legacy core outlives an abruptly stopped front door

When the front door is killed, its lock (`state/core.lock`) is released at once, but the legacy core behind it runs until
it sees its lifeline (stdin) close and finishes its stop (it stops at once, without grace, but finishes what is in
flight). A new front door started in that window takes `state/core.lock`, and its legacy core exits with code 3 on
`run/core-legacy.lock` until the old one is gone; the new front door retries that start for the shutdown budget plus
10 s and binds `run/core.sock` only once its legacy core is ready. The stores are never written by two legacy cores at
once (`run/core-legacy.lock`), and clients see the address refused as they do while a TypeScript core restarts
(tests/system kill-soak SIGKILLs the front door and passes on the rust leg: no fact lost, none replayed twice).

What the window does not cover: an offline writer that takes only `state/core.lock` (the import worker, a restore) and
starts within the old legacy core's stop could overlap with it (two writers on the stores). It needs a crash or SIGKILL
of the front door followed within seconds by such a writer; the supervisor stops the core gracefully before every
import or restore, and a graceful stop of the front door waits for its legacy core. Not reproduced; severity `low` because
it touches data safety. Fix options for the owner: the offline writers also take `run/core-legacy.lock` while a front
door is configured, or the window ends with the legacy core (P4-90).

## P4D-6 — the legacy core's pipe on Windows

The front door's own pipe gets the explicit user-and-SYSTEM DACL (`plur1bus_rpc::server_transport`), which closes ADR-012
deviation C2 for `\\.\pipe\plur1bus-<hash>-core` with `core.impl: "rust"`. The legacy core's pipe
(`\\.\pipe\plur1bus-<hash>-core-legacy`) is created by Node and keeps its default security descriptor, as the TypeScript
core's own pipe does today.

- Containment: the legacy core refuses every `core.auth` without `frontDoor.token` (`run/core-legacy.token`, 32 random
  bytes in the user-only run directory) and verifies the client's own credentials again; the front door checks that the
  pipe's server process is the legacy core it started (`GetNamedPipeServerProcessId`) before it sends anything.
- Fix: the pipe goes with the legacy core at P4-90 (no TypeScript patch, plan §4.2).

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
