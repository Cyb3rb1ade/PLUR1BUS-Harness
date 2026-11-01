# Rust engine process (RE-08 T2 / U1)

`plur1bus-engine serve --home <home>` serves the experimental `engine.*` endpoint. It runs directly as the
engine binary, with its actual PID in the readiness line and authentication result. It does not select the Rust
engine in the Core: `engine.implementation` still defaults to `node`.

The process server is implemented. Recall, capture, jobs and memory/admin operations are connected through the
frozen Rust `Engine` traits, but their unfinished production implementations answer `E_NOT_AVAILABLE` with
`composition-pending`. Embedding and model methods use the existing RE-03 providers. Transport tests inject an
explicit test-only engine to exercise recall and capture receipts without claiming that production pipelines exist.

## Identity and lifecycle

The endpoint is `<home>/run/engine.sock` on Unix and the shared Harness `engine` pipe name on Windows. The
runtime directory is private; Unix sockets and identity files have mode `0600`. Windows uses the same explicit
user-and-SYSTEM pipe DACL, remote-client refusal and kernel peer-PID checks as the supervisor. Clients verify the
peer before transmitting credentials.

A permanent OS-held `run/engine.process.lock` pins process exclusivity before acquiring the incarnation-aware
`JobLock`. The OS-held file is never unlinked, and protects a live process from the job lock's stale-age ceiling.
Both locks are acquired before probing or replacing stale endpoint files. Each start writes a
fresh 32-byte OS-random bearer token to `run/engine.token` and `<pid> <instanceId>` to `run/engine.pid`. A second
owner exits 3 without changing the first process's files. Successful shutdown removes only that start's run files.
Usage/configuration failures exit 2; a clean shutdown exits 0.

Every connection must first call `engine.auth` with the token and a `clientId`. Authentication is checked before
method lookup, parameter validation or engine callbacks. A failed handshake closes the connection. Schema params
remain closed. Line size, authentication time, connection count, concurrent requests and capture receipt retention
are bounded; diagnostic messages never echo method data, provider bodies or credentials.

`--lifeline stdin` makes the parent's stdin pipe the initial lifeline. EOF or error orphans the process for
`supervisor.graceMs` (the schema default is 60 seconds). An authenticated `engine.adopt {nonce}` must prove the
current private `run/supervisor.token`; that connection replaces the previous lifeline and cancels an outstanding
grace timer. Closing an obsolete source has no effect. Closing the current adopted connection starts a new grace.
`engine.shutdown`, grace expiry and termination signals close engine resources and connections. Process task
limits are not part of this trusted engine process; D123 governs untrusted ACP containment separately.

`engine.status` preserves the frozen engine status and adds optional RPC 1.17 process identity, lifecycle state,
request/auth/connection/capture counters and scheduler-loop lag. Process `ready` means the endpoint serves RPC;
the separate engine `ready` flag remains false while memory composition is pending.

## Host services and configuration

Startup reads and validates `config.json` without creating a configuration file. Its engine projection follows the
Core's text embedding/reranker defaults, host-owned paths and recall budgets. Remote providers retain the existing
privacy acknowledgments and shared local-only restrictions. Conditional model revisions require matching persisted
license receipts. A WAL-mode license ledger is refused before opening it, rather than ignoring live WAL contents or
creating SQLite sidecars during this read-only startup path.

`RpcHost` authenticates reverse `host.*` requests with both the Core token and the engine's independent delegation
credential. Missing Core, token rotation or restart returns a bounded host-unavailable error; the next call reads
the current identity files and reconnects. LLM completion requires explicit outer agent attribution, matching the
Core's dispatch guard. The unattributed frozen callback fails closed. Outbound process-host policy decisions bypass
the lower transport decision cache so every HTTP hop, including redirects, consults the live Core policy.

Native filesystem, link, identity and embedding-address callbacks fold the pinned platform helper into Rust.
The infallible Rust IPC-address callback returns an empty address when Node would throw for an overlong Unix
socket path. This does not start or port scoped embedding IPC; embeddings use `engine.embedding.*` (RE-D4).

The shared redaction catalogue also covers quoted bearer values, folded Authorization headers, credential/key
assignments and bare bot tokens from the pinned logging helper. Existing deliberate vendor-token length rules
remain unchanged. The engine's own diagnostics contain fixed categories only.

## Developer tests

`PLUR1BUS_TEST_INTERNALS=flat-embedder` (or `--test-internals flat-embedder`) and `flat-embedder-cold` require
`PLUR1BUS_ALLOW_TEST_INTERNALS=1`. The cold variant serializes a 350 ms delay for each of its first two query
embeddings. Passage embeddings and subsequent queries use the existing flat provider directly. These seams do
not install fake production memory behavior.

Acceptance lives in `crates/plur1bus-engine/tests/rpc_server.rs`, `tests/seams.rs`,
`tests/host_guard_contract.rs` and the `rpc` unit tests, including `rpc/roundtrip.rs`. Shared listener/peer identity
tests live in `crates/plur1bus-rpc/tests/server_transport.rs` and `tests/client.rs`. Windows runtime cases remain
enabled for their native CI platform. Every spawned test child has a kill-and-wait drop guard.

Supervisor startup, adoption orchestration and `core run` spawning belong to U2. Token RPC belongs to U3; the
parity runner and advisory CI to U4/U5; system runs and hop-budget measurement to U6/U7; release payloads to U8.
No default engine switch or Phase 2 behavior change is included here.
