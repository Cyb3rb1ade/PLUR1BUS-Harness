# Rust engine process (RE-08 T2 / U1)

`plur1bus-engine serve --home <home>` serves the experimental `engine.*` endpoint. It runs directly as the
engine binary, with its actual PID in the readiness line and authentication result. It does not select the Rust
engine in the Core: `engine.implementation` still defaults to `node`.

The process server is implemented. With a configured store base, recall (normal and warm), capture, every
memory operation (list/show/state/forget/link/import/rebind/unbind; since RE-D165 also correct, share, propose,
`proposals.list/accept/reject`, unimport, and the A1 methods `stats`, `promote` and `curation.list/resolve/keep/drop`),
store adoption and the job registry (`engine.jobs.list/run/history`, RE-D158) are served by their native
compositions. The A1 capability flags stay `false` and the contract stays 1.17.0 until A1-5; the methods answer on
the wire regardless. `engine.admin.share` and `engine.admin.forget` stay `E_NOT_AVAILABLE`/`composition-pending`
(no native implementation, no productive Harness caller; RE-D165, KNOWN-GAP → RY), as do the F6/F9/F14 admin
methods and the F7 `reembedding.rollback`/`switch`. `engine.admin.migrate` (RE-D143) and
`engine.admin.reembedding.{plan,apply,resume,status,validate}` (RE-D166) are served only over the authenticated
Core link's maintenance grant; each call is audited in `state/engine-maintenance.jsonl`, and each `apply`/`resume`
commits one durable batch while recall and capture go on against the active generation. Each memory operation
runs in the foreground with its caller's principal; what an owner without a user principal cannot get (a Neo
partition) fails closed as described in `docs/engine-stores.md` (RE-D165).
A memory write that still finds the engine-wide mutation gate held after 20 s, or finds four callers already
waiting, answers `E_NOT_AVAILABLE` with `engine-busy`; holders run on budgets ended by shutdown (except a local
inference step already running). `engine.status` reports `sharedMemory` as the last share decision found it, and
the cautious `unavailable` before the first one. Under F13 every job whose body reads or
writes private owner or workspace rows answers `job-authority-unbound`, LLM jobs answer `not-implemented`; the
only installed body is `embedding-drain` with Neo disabled (`skipped/neo_disabled`, as at the pin).
Embedding and model methods use the existing RE-03 providers. With a store base, `engine.status` is the pin's
status reporter over real sources (RE-D157): the host journal backlog (50 ms bound), the job ledger health under
`<base>/_jobs` and the `_schema.json` marker. It reports `ready: true`; model warming or failure degrades as at the
pin. It reports `ready: false` after close (`closed/engine`), while capture is not served
(`startup-recovery-incomplete` or `composition-invalid` with `capture`), while the jobs root cannot be bound
(`composition-invalid/jobs`) and while the base schema marker is one every store open refuses
(`schema-unsupported/store`, RE-D160). One agent's failed job session start answers
`startup-recovery-incomplete` for that agent's runs only. A session start is bounded (5 s, or a closed
connection, or shutdown) and then answers `job-session-busy`; so is the start-marker admission (RE-D164), so a
`jobs.run` waits at most about 2 × 5 s in total. `job-session-busy` means "not started"; once a body began, an
unfinished settle answers the registry's own error and the run stays started (recorded as `failed`/`crash` at
the next session start). `engine.jobs.history` never waits for it. `job-session-busy`, `job-authority-unbound` and
`startup-recovery-incomplete` are internal reasons: on the wire each appears as `operation-unavailable`, so a
client cannot tell "busy, retry later" from "refused" (changing that is a contract change, not RX). After
close, status asks no source. Capture composition takes an inventory only; retained work is recovered behind it,
one owner at a time (RE-D162). While capture is served but some owner's retained work waits or is being recovered
(after the composition, maintenance, a transient failure, its own recovery budget) or a retained
file cannot be attributed, it reports `capture-recovery-deferred/capture` and keeps `ready`. Which degradation
wins follows the RE-D159 priority in `docs/engine-stores.md`. Without a store base it keeps the frozen
`{reason: "composition-pending", capability: "recall"}`. Status creates no file. Transport tests inject an
explicit test-only engine to exercise recall and capture receipts.

## Identity and lifecycle

The endpoint is `<home>/run/engine.sock` on Unix and the shared Harness `engine` pipe name on Windows. The
runtime directory is private; Unix sockets and identity files have mode `0600`. Windows uses the same explicit
user-and-SYSTEM pipe DACL, remote-client refusal and kernel peer-PID checks as the supervisor. Clients verify the
peer before transmitting credentials.

A permanent OS-held `run/engine.process.lock` pins process exclusivity before acquiring the incarnation-aware
`JobLock`. The OS-held file is never unlinked, and protects a live process from the job lock's stale-age ceiling.
Both locks are acquired before probing or replacing stale endpoint files. Each start writes a
fresh 32-byte OS-random bearer token to `run/engine.token` and `<pid> <instanceId>` to `run/engine.pid`. A second
owner exits 3 without changing the first process's files. After a crash, a private local nonce whose PID is dead
or whose start identity is demonstrably different is recovered immediately. A different boot ID is checked before
probing the recorded PID, and a PID unavailable to this user is orphaned in a private home. Only a positively live
local owner with the same incarnation stays protected regardless of nonce age. Foreign-host, malformed and incomplete
stamps use the existing bounded `JobLock` age rule: malformed, empty or invalid-PID stamps become stale after
60 seconds; a valid foreign-host stamp can remain protected up to the 600-second hard ceiling. Exit 3 with
`stamp-age-rule` therefore means a finite wait; retry startup with backoff rather than deleting the stamp.
Startup diagnostics distinguish a live owner, the age rule, an OS-held process lock, and an already live
endpoint (`endpoint-live`). The live endpoint is preserved when startup refuses it.
New nonce files are created with mode `0600`; legacy owner-only nonce metadata
with read bits (for example `0644`) is accepted only inside the owned `0700` run directory, with no links or foreign
write bits. Bearer-token readers stay strict. Successful shutdown removes only that start's run files.
Usage/configuration failures exit 2; a clean shutdown exits 0.

Every connection must first call `engine.auth` with the token and a `clientId`. Authentication is checked before
method lookup, parameter validation or engine callbacks. A failed handshake closes the connection. Schema params
remain closed. Line size, authentication time, connection count, concurrent requests and capture receipt retention
are bounded; diagnostic messages never echo method data, provider bodies or credentials.

`--lifeline stdin` makes the parent's stdin pipe the initial lifeline. EOF or error orphans the process for
`supervisor.graceMs` (the schema default is 60 seconds). An authenticated `engine.adopt {nonce}` must prove the
current private `run/supervisor.token`; that connection replaces the previous lifeline and cancels an outstanding
grace timer. Closing an obsolete source has no effect. Closing the current adopted connection starts a new grace.
`engine.shutdown`, grace expiry and termination signals close engine resources and connections within a shared
stop deadline. Uncooperative callbacks are detached when that deadline expires; returning from the process entry
point terminates its remaining threads. A library caller of `serve` must account for those callbacks and must not
start a replacement in the same process. Windows CLOSE/LOGOFF/SHUTDOWN use a two-second close budget and wait
up to three seconds for cleanup; native console-event verification remains a Windows CI responsibility. Process task
limits are not part of this trusted engine process; D123 governs untrusted ACP containment separately.

`engine.status` preserves the frozen engine status and adds optional RPC 1.17 process identity, lifecycle state,
request/auth/connection/capture/accept-error counters and scheduler-loop lag. Process `ready` means the endpoint serves RPC;
the separate engine `ready` flag follows the composed status above (false without a store base).

## Host services and configuration

Startup reads and validates `config.json` without creating a configuration file. Its engine projection follows the
Core's text embedding/reranker defaults, host-owned paths and recall budgets. Remote providers retain the existing
privacy acknowledgments and shared local-only restrictions. Conditional model revisions require matching persisted
license receipts. A WAL-mode license ledger is refused before opening it, rather than ignoring live WAL contents or
creating SQLite sidecars during this read-only startup path.

`RpcHost` lazily opens one persistent reverse `host.*` connection. The independent engine token is both the outer
auth token and the delegated engine credential, as required by the real Core guard. The private Core token/PID
files identify rotations and restarts; the owner token is not sent as the engine's credential. Kernel peer checks
still run before credentials are transmitted. A background reader dispatches replies and policy notifications.
`events.subscribe` is acknowledged before caching policy decisions per Target (60-second TTL, at most 256 Targets). `egress.changed`, disconnection and
identity rotation invalidate the cache and the owned embedding/reranker transports; a generation check prevents a
late decision from restoring invalidated policy. Missing Core is recoverable on the next call.

LLM completion requires explicit outer agent attribution, matching the Core's dispatch guard. The unattributed
frozen callback fails closed. Events use a bounded, nonblocking queue and can be dropped under backpressure; a hung
Core cannot block the caller's `emit`. The background client bounds pending calls and aborts I/O during shutdown.
A cancelled or expired host call currently closes the shared connection: concurrent host calls fail unavailable,
the policy cache is invalidated, and the next call reconnects and authenticates. Keeping the connection while
discarding late replies by request ID is a U2/U3 follow-up.

The configuration projection is checked against shared [Core-derived startup vectors](../tests/engine-parity/config/README.md).
Both TS and Rust replay the same synthetic configuration and receipt metadata, and check regeneration against the
actual Core startup functions. No model execution is used to generate these vectors.

Transient accept failures increment `counters.acceptErrors` and back off for 50 ms; recognized fatal listener errors
stop with exit 2 and remove owned run files. A cap on consecutive other accept errors remains a supervisor-U2
follow-up alongside health monitoring. There are at most 64 connections, eight concurrent requests per connection, 128 pending captures and
256 retained receipts. Saturation returns `E_NOT_AVAILABLE` with reason `engine-busy`. A single completion worker
polls the bounded receipt set; worker creation is fallible. Before authentication, frames are limited to 64 KiB
and the first unauthenticated method closes the connection. Authenticated frames remain limited to 4 MiB.
Capture completion and event fanout enqueue notifications without waiting on socket writes. Each connection has
one fallible notification writer, at most eight outstanding frames and 8 MiB including in-flight data; overflow
closes that peer. A stalled receiver cannot stop captures for healthy peers. Request replies and shutdown
acknowledgements retain their ordering.
An oversized response returns a bounded `response-too-large` error for that request and keeps other requests alive.
Embedding and reranking batches are limited to 128 items. Validators are compiled once per method.

Native filesystem, link, identity and embedding-address callbacks fold the pinned platform helper into Rust.
The infallible Rust IPC-address callback returns an empty address when Node would throw for an overlong Unix
socket path. This does not start or port scoped embedding IPC; embeddings use `engine.embedding.*` (RE-D4).

The process emits `engine.process.lifecycle` and `engine.process.error` records on stderr through the shared D111
catalogue. They contain fixed state/reason/stage/error-class categories, PID and optional errno; never request,
provider, memory or credential text. A single fallible writer has a 64-record queue with nonblocking drop and a
flush bounded by the remaining stop budget. Stdout is reserved for readiness. The regression suite checks both
real signal cleanup records and injected private error content, and proves blocked stderr cannot block producers.

The shared redaction catalogue also covers quoted bearer values, folded Authorization headers, credential/key
assignments and bare bot tokens from the pinned logging helper. Existing deliberate vendor-token length rules
remain unchanged. The engine's own diagnostics contain fixed categories only.

## Developer tests

`PLUR1BUS_TEST_INTERNALS=flat-embedder` (or `--test-internals flat-embedder`) and `flat-embedder-cold` require
`PLUR1BUS_ALLOW_TEST_INTERNALS=1`. The cold variant serializes a 350 ms delay for each of its first two query
embeddings. Passage embeddings and subsequent queries use the existing flat provider directly. These seams do
not install fake production memory behavior. Under a seam, a re-embedding target is the pin's flat test provider,
and `PLUR1BUS_TEST_REEMBEDDING_HOLD=<dir>` holds a target batch while `<dir>/hold` exists (RE-D166).

Acceptance lives in `crates/plur1bus-engine/tests/rpc_server.rs`, `tests/rpc_reembedding.rs`, `tests/seams.rs`,
`tests/host_guard_contract.rs` and the `rpc` unit tests, including `rpc/roundtrip.rs`. Shared listener/peer identity
tests live in `crates/plur1bus-rpc/tests/server_transport.rs` and `tests/client.rs`. Windows runtime cases remain
enabled for their native CI platform. Every spawned test child has a kill-and-wait drop guard. Ordinary process fixtures also keep a piped stdin lifeline,
so loss of the test runner expires their one-second grace. Spawners own process groups; a manual terminal start
keeps normal foreground Ctrl-C semantics. Signal cases invoke the actual OS signals, and cold/warm checks compare
relative latency rather than imposing a fast-path ceiling.

Supervisor startup and adoption orchestration are the supervisor's `engine` slot (RE-D172); `core run` spawning is
described under "Owners without a supervisor" below (RE-D173). Token RPC belongs to U3; the parity runner and advisory
CI to U4/U5; system runs and hop-budget measurement to U6/U7; release payloads to U8. No default engine switch or
Phase 2 behavior change is included here.

## The supervisor's `engine` slot

With `engine.implementation: "rust"` the supervisor runs the engine in its own slot, listed right after the core in
`daemon status` (`kind: "engine"`), with the core's backoff; its exit 3 (`lock-held`) is retried, probing first, until
it has lasted 660 s × the time scale. With the Node engine selected, every path that starts the core (the
supervisor's start, scheduled restarts and `daemon start`, import maintenance, requested restarts such as a core-class
`config set`) first passes one gate on `run/engine.process.lock`:

- No lock file, or a free one: nothing more happens.
- A lock that cannot be checked (anything but a missing file that fails to open or lock: a symlink, no permission, a
  Windows sharing violation): the core stays down at once, crashed for good with `engine-lock-held`. The file is never
  created.
- A held lock: a serving engine whose identity the adoption probe proves (pid file, handshake, instance) is stopped
  with the usual deadlines. A hung or foreign server of the engine endpoint is terminated through the pin the probe
  took on the socket's or pipe's server, a deliberate rule: it is the same policy the supervisor applies to every
  endpoint of the home's private `run/` at start. Then the lock is awaited for at most the engine's orphan grace
  (`supervisor.graceMs` × scale) plus 5 s; still held, the core stays down with `engine-lock-held` (fail closed: two
  writers of one store) until `daemon start` or the next requested restart finds the lock free.

Composition must remain lazy before the single-instance check: `production_model_composition_is_lazy_and_does_not_create_files`
is an invariant for future store integration. RE-04 store integration is gated on moving lock acquisition before
any composition that eagerly opens stores.

## Owners without a supervisor: `core run`

With `engine.implementation: "rust"`, `plur1bus core run` owns the engine (RE-D173; controller ruling F2 moved this
from a planned TypeScript `spawn.ts`/`bin.ts` forwarding into `crates/plur1bus/src/engine_owner.rs`). It builds the
engine's command with the same specification as the supervisor's slot (`engine_process::configured_spec`: `serve
--home --lifeline stdin --instance <uuid>`, `PLUR1BUS_ENGINE_BIN` or beside the executable, `--test-internals` only for
the flat seams and only with `PLUR1BUS_ALLOW_TEST_INTERNALS=1`, no token in argv or environment) and stays as a wrapper
instead of exec'ing the core:

- The engine is spawned first and never waited for; the core's readiness does not depend on it. The wrapper holds the
  engine's stdin (the lifeline), runs it in its own process group, and binds it at the OS level where it can (Linux
  parent-death signal, Windows kill-on-close job and `CREATE_NO_WINDOW`). The engine's stdout, its ready line included,
  is drained in fixed 8 KiB chunks to the wrapper's stderr; its stderr is inherited. The core is spawned with inherited
  stdio in the wrapper's process group, so its ready line is the first line on the wrapper's stdout.
- SIGTERM and SIGHUP are forwarded to the core; SIGINT is the terminal's to deliver to the core and does not end the
  wrapper. A stop signal before the core was spawned means the core is not spawned. Windows: the wrapper ignores Ctrl+C
  after spawning the core, which shares its console.
- After the core has ended the engine is stopped within 5 s: `engine.shutdown` with the token in `run/engine.token`
  to the process whose hello names the spawned pid (connect and call 1 s each), SIGTERM when that was not delivered
  (Windows: an immediate kill), a kill at the deadline. The wrapper exits with the core's code; a core ended by a
  signal gives 130.
- A missing binary, an unauthorized seam or a failed spawn: one line on stderr, the core starts anyway and reports
  `engine-unavailable`. An engine that ends while the core runs: one line on stderr, no restart (the supervisor
  restarts with backoff; `core run` is the developer path). The engine lives exactly as long as the core: a changed
  configuration reaches it at the next `core run`.
- With the Node engine selected, `core run` still execs the core, after one try-lock on `run/engine.process.lock`:
  held by a live process, or not checkable (any open or lock failure but a missing file), it refuses with
  `E_CORE_UNAVAILABLE`, reason `engine-lock-held`, and kills nothing (the supervisor's B3 gate uses the same check).

Residual risks. macOS has no OS binding: a wrapper ended by SIGKILL leaves the core and the engine running, and the
engine ends only after its orphan grace (`supervisor.graceMs`) once it sees its stdin close. KNOWN-GAP: the engine
refuses a home reached through a symlink (macOS `/var` → `/private/var`, a symlinked `~/.plur1bus`) with exit 2; it is
not resolved here, so tests and developers pass a canonical home.

Acceptance: `crates/plur1bus/tests/core_run_engine.rs` (fake engine and fake core; an `#[ignore]` case runs the real
binary from `PLUR1BUS_ENGINE_BIN` with the flat embedder) and the unit tests in `engine_owner.rs`.
