# ADR-012: Process model, languages, RPC contract and the core lock

**Status:** Accepted (2026-09-24, owner decisions D6 and D7; implementation record of plan H1 added 2026-09-25) · **Date:** 2026-09-24 / 2026-09-25 · **Deciders:** Christian (owner) · **Inputs:** `docs/superpowers/specs/2026-09-24-m1b-2a-core-daemon-cli-design.md` §2 (D1–D20), §4, §5, §6.2–§6.4 · `docs/superpowers/plans/2026-09-24-m1b-2a-h1-harness-foundation.md` (global constraints) · the H1 implementation ledger (rulings R4, R9–R21, E_LOCKED, the `core.auth` handshake, the `node:sqlite` lock) · ADR-001, ADR-002 · Source of record: this repository @ `93f11ca` (`feat/m1b-2a-h1`), engine `@cyb3rb1ade/plur1bus-memory` @ `eaaf168f` (contract 1.4.1). Companion: ADR-013 (configuration and restart classes), generated `docs/rpc.md` and `docs/cli.md`.

**Amends ADR-001.** ADR-001 Option B describes the harness as "single-stack" ("one language, one toolchain"). D7 replaces that: the harness has two languages (Rust and TypeScript) joined by JSON Schema as the single source of every cross-language type. The rest of ADR-001 (standalone monorepo, engine in-process in a resident core, thin client) stands.

## Context

D3 asks for modules behind versioned, typed interfaces, an updater that replaces units without touching foreign internals, and restarts limited to what a change requires. D2/ADR-002 put the PLUR1BUS engine in-process in one resident core that is the only holder of the LanceDB and ONNX handles (T7). M1 acceptance 3 requires that a killed core or supervisor never blocks a command, and acceptance 11 requires `--help` p95 < 100 ms. Three forces follow:

1. Something must survive the failure of the process that holds the engine, and restart it: that cannot be the same process.
2. The command users type most (`plur1bus …`) must start fast and must not load Node, the engine or native modules.
3. Two processes in two languages must agree on every request, result, error and notification without hand-kept duplicates.

The owner asked for the process-model trade-off explicitly (D6) and accepted the language recommendation (D7) on 2026-09-24.

## Decision

**Process model B: a small Rust supervisor, one TypeScript core process per installation that holds the engine, and add-on modules as separate processes; a thin Rust CLI talks to the core over a local socket with JSON-RPC 2.0 (NDJSON), authenticated by a per-start token; the core excludes a second core with an OS-held lock taken through `node:sqlite`. Rust is used for the CLI, supervisor, installer and updater; TypeScript for the core and every module bound to a Node SDK; JSON Schema is the single source of RPC and configuration types, generated into both languages.**

### 1. Process model

```
OS service manager (launchd / systemd --user / Task Scheduler)      ← not ours
  └─ plur1bus supervise            Rust, tiny, always alive          ← H2
       ├─ core                     Node: engine, stores, models, JSON-RPC server
       └─ modules (none in 2a)     own processes, clients of the core
plur1bus <cmd>                     Rust CLI, thin client of core and supervisor
```

- **Core** (`packages/core`, `@plur1bus/core`): builds the engine once with `createEngine(host, config)` on the harness's own `HostServices` (`packages/core/src/engine.ts`, `host.ts`; `routing`, `pathOverrides`, `mutateConfig` absent, `runtime: null`), registers channel `cli`, replays the capture journal, then serves RPC. It is the only process that opens LanceDB or ONNX.
- **Supervisor** (H2): owns `config.json` (ADR-013), spawns and monitors core and modules, lifelines and adoption (spec §6.4). Not built in H1 — see §8.
- **Modules** (2a defines the manifest shape, ships none): separate processes that are clients of the core through `@plur1bus/module-api`.
- **CLI** (`crates/plur1bus`): never loads Node for a command; connects to the core, and in H2 to the supervisor. It never spawns the core implicitly.

#### Why B — the A/B/C trade-off (D6)

| Dimension | A: one process, hot reload | **B: supervisor + core + module processes** | C: one process, worker threads |
|---|---|---|---|
| Restart one unit | Not real: ESM modules cannot be unloaded, so a "restart" re-imports next to the old instance and leaves its timers, listeners and native handles behind. | Real: a module restart is a process restart; the core keeps running. | Partial: a worker can be terminated, but native handles opened through the main thread's addons stay. |
| Fault isolation | None: a faulty add-on (throw in a timer, OOM, native crash) takes the engine down. | Per process: an add-on crash is a module crash; the supervisor restarts it with backoff. | JS heaps are isolated, but a native crash or process-level OOM kills every worker at once. |
| Secret isolation | None: add-ons share the heap that later holds provider keys. | OS process boundary; a module sees only what the RPC surface gives it. | Workers share the process address space with the secrets. |
| Updater / third-party add-ons | Replacing a unit means restarting everything. | Replacing a unit is stop, swap, start; first- and third-party modules have one shape. | Same restart caveat as A for native parts. |
| RAM | Lowest (one Node heap). | 30–50 MB baseline per Node process. | Low (one process, several isolates). |
| Complexity | Low at first, rising with every add-on. | Supervisor, lifelines and adoption are new code (spec §6.4). | Medium; worker messaging plus the native-crash gap. |

B's only structural cost is RAM per process. It is mitigated by starting modules lazily (none run in 2a) and, later, by a first-party "module host" that runs trusted small modules as workers *inside* one B process — a C-style optimisation layered on B, never replacing the process boundary for third-party code.

### 2. Languages and the single source of types (D7)

- **Rust** for the CLI, supervisor, installer and updater: a static binary with no runtime to install, fast cold start for `--help` (B1), and process/service handling (lifelines, Job Objects, `launchd`/`systemd`/Task Scheduler) without a Node dependency on the recovery path.
- **TypeScript** for the core and every module bound to a Node SDK: the engine is Node, and MCP/ACP/A2A SDKs are TypeScript (ADR-001, ADR-008).
- **JSON Schema 2020-12 is the single source.** `packages/rpc-schema/schema/rpc.schema.json` defines every method's `params`/`result`, every notification, the error enum, the envelopes and the capture-journal line. TypeScript types are generated by `json-schema-to-typescript` (`packages/rpc-schema/src/build.mjs` → `generated/types.ts`, `generated/names.json`); Rust types by `typify` 0.8 in `crates/plur1bus-rpc/build.rs` (into `OUT_DIR`, `$defs` rewritten to `definitions` for schemars 0.8). The TypeScript server validates params with ajv, and **also validates every result** before sending it (`rpc/server.ts`: a result that violates the schema is logged and answered with `E_INTERNAL reason=result-schema`). `packages/config-schema/schema/config.schema.json` plays the same role for configuration (ADR-013).
- **Contract fixtures** (`packages/rpc-schema/fixtures/`): one valid request/response pair per method, every error code once, every notification once; the TypeScript server tests and the Rust client tests (`crates/plur1bus-rpc`) read the same files.
- **Workspace package resolution** (rulings R12, R14): `rpc-schema`, `config-schema` and `module-api` export `{ "source": "./src/index.ts", "types": "./src/index.ts", "default": "./dist/index.js" }`; `scripts/test-package.mjs` runs Node with `--conditions=source`, so cross-package tests always run against source, never a stale `dist/`. Production resolution (`default`) is unchanged.
- **CLI `--json`** (ruling R13) prints the raw `serde_json::Value` returned by the RPC call, never a re-serialised typed struct: `typify` drops unknown keys on open result types and drops empty optionals, so a typed round trip would silently change the documented shape. Typed structs are used only to read fields.

### 3. RPC transport and protocol

- **JSON-RPC 2.0, NDJSON**: one UTF-8 JSON value per line, at most 4 MiB per line (`MAX_LINE_BYTES` in `packages/module-api/src/framing.ts`, `MAX_LINE` in `crates/plur1bus-rpc/src/client.rs`, the Rust read is bounded to `MAX_LINE + 1` bytes). An over-long line is answered with `E_INVALID_PARAMS reason=line-too-long` and the connection is closed. One connection per client; notifications arrive on the same connection after `events.subscribe`.
- **Address**: POSIX `run/core.sock`; Windows `\\.\pipe\plur1bus-<first 16 hex of sha256(lower-cased home)>-core` (`packages/core/src/paths.ts` `coreAddress`; the Rust CLI derives the identical name, T11 ruling: `--home`/`PLUR1BUS_HOME` are absolutised and lexically normalised like Node's `path.resolve` on both sides).
- **Handshake `core.auth`**: the first request on every connection is `core.auth { token }`. Its result is `{ contract, rpc, instanceId, pid }`: the engine contract version (`1.4.1` today) and the RPC schema version (`x-rpc-version`, `1.0.0`). Any other method before a successful `core.auth` is answered `E_UNAUTHORIZED reason=auth-required`; a wrong token or malformed `core.auth` params get an error and the connection is closed; a connection that has not authenticated within 30 s is closed (`authIdleMs`). `core.status` repeats `contract` and `rpc`.
- **Version check** is the client's job: both clients (`crates/plur1bus-rpc` `SUPPORTED_RPC_MAJOR = 1`, `packages/module-api/src/client.ts`) read `rpc` from the `core.auth` result, compare the major **before** deserialising the rest (a future major may have a shape this client cannot read), and refuse with `E_RPC_VERSION reason=major-mismatch`.
- **Closed error enum** (`$defs/ErrorCode`): `E_UNAUTHORIZED`, `E_RPC_VERSION`, `E_NOT_AVAILABLE`, `E_CORE_UNAVAILABLE`, `E_INVALID_PARAMS`, `E_AGENT_UNKNOWN`, `E_CONFIG_INVALID`, `E_MODULE_UNKNOWN`, `E_INTERNAL`, **`E_LOCKED`**. The code travels in `error.data.error` with optional `reason` and `detail`; the numeric JSON-RPC `code` is `-32602` for invalid params, `-32600` for an invalid request, `-32700` for a parse error, `-32601` for an unknown method (reported as `E_INTERNAL reason=method-not-found`) and `-32000` otherwise (`packages/core/src/rpc/errors.ts`). `RpcError` refuses to construct a code outside the enum, so no method can invent one without a schema change.
- **`E_NOT_AVAILABLE` for engine gaps**: `memory.list|show|forget|correct|share|state` exist in the schema and answer `E_NOT_AVAILABLE reason=engine-pr-E1` until engine PR E1 (`MemoryOps`) lands — never a string-command emulation (D9).
- **Back-pressure**: if a connection's pending writes exceed 16 MiB (`MAX_PENDING_BYTES`), the core logs a warning and destroys that connection — a stalled local client cannot exhaust the core's memory (T6 ruling).
- **Client timeouts** (`crates/plur1bus-rpc/src/client.rs`): socket connect and the whole `core.auth` handshake run under `connect_timeout` (300 ms); later calls under `call_timeout` (an idle read timeout; default 30 s, set per command by the CLI, e.g. `core.recall.hardBudgetMs` + 400 ms for `memory recall`). After a timeout, an I/O error, an over-long line or EOF the client marks itself **poisoned** and refuses further calls until reconnected, because the stream position is unknown. A missing socket fails at once (ENOENT), which is how the CLI answers "core absent" in well under 300 ms.

**Notifications in H1** (`$defs/notifications`): `core.state { process }`, `agent.activity { agentId, activity }`, and `engine.event { name, agentId?, payload }`, which forwards every engine event verbatim, with `agentId` copied to the top level when the payload carries a valid one (so `events.subscribe { agentId }` can filter). `events.subscribe { names?, agentId? }` filters by notification method name; one delivery per connection.

### 4. Authentication and transport security

- **Token**: 32 random bytes (`crypto.randomBytes(32)`), hex-encoded (64 characters; the schema enforces the length on `core.auth`), generated fresh at every core start and written to `run/core.token` with mode `0600`. The core compares it with `crypto.timingSafeEqual` after an equal-length check (`rpc/server.ts` `tokenMatches`). Socket permissions plus the token make the caller `trust: "proved"`.
- **POSIX**: `run/` is created `0700` and re-`chmod`ed `0700` at listen; the socket is `chmod 0600` after `listen`. An existing socket file is probed first: if something answers, the core refuses (`address in use`); only a dead (stale) socket is unlinked.
- **Windows (deviation, deferred to H2)**: the named pipe is created by Node's `net` server without a user-SID ACL in H1; the token is the only access control on Windows until H2 adds the ACL. Likewise `securePath` returns `{ applied: false, reason: "acl-tool-unavailable" }` on Windows (`packages/core/src/platform.ts`), and the Rust client's Windows pipe reads have no deadline (`transport.rs`: "H2: overlapped I/O with timeouts"). Reason: Windows system tests wait for engine PR-11 anyway (spec §3), and an ACL written without a Windows test run would be unverified security code.
- **Principal on the CLI path**: the CLI sends only `CallerIdentity { channel: "cli", accountId: <hostname>, userId: <OS user> }` (`crates/plur1bus/src/identity.rs`); every params object is closed (`additionalProperties: false`), so a client cannot supply `trust`, `origin`, `background` or `incognito`. The core derives the engine `Principal` (`packages/core/src/principal.ts`): `user:v1:sha256(JSON.stringify([channel, accountId, userId]))`, `workspace-dir:v1:<realpath of agents/<id>/workspace>`, `trust: "proved"`, `AgentContext { origin: "user", background: false }`, and `incognito: false` set explicitly on captures. **Identity degrade (ruling R18):** an identity that is empty, longer than 128 characters or contains control characters does not fail the call; the core uses `trust: "inferred"` without a user principal (agent-private memory) and reports `degraded { reason: "principal-invalid", capability: "identity" }` on recall. The schema therefore carries no `maxLength` on `accountId`/`userId`; the 128 limit (the engine's `INPUT_LIMITS`) lives in the core only.

### 5. The core lock: `node:sqlite` `BEGIN EXCLUSIVE`, not `flock`

The core holds `state/core.lock` for its lifetime (`packages/core/src/lock.ts`). The file is a SQLite database: the core opens it with `node:sqlite` (`DatabaseSync`), sets `PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE`, runs `BEGIN EXCLUSIVE`, and records `{ pid, instance, at }` in a `holder` table inside the open transaction. An open EXCLUSIVE transaction is an `fcntl` (POSIX) / `LockFileEx` (Windows) lock held by the kernel for the process: a second core's `BEGIN EXCLUSIVE` fails immediately (busy timeout 0) and becomes `E_LOCKED reason=core-lock-held`; when the holder dies — including `SIGKILL` — the OS releases the lock. `release()` rolls back and closes. Verified: Node 24.21 during the plan's H1 pre-check, and permanently by `packages/core/test/lock.test.ts` ("refuses a second holder in another process and frees on SIGKILL") and `core.test.ts` (a second `createCore().start()` on the same home rejects with `E_LOCKED`).

Why not `flock`, as the spec says: Node has no `flock` API; the options were a native addon (a new prebuild matrix on five targets for one system call) or shelling out to a helper whose lifetime is not the core's. `node:sqlite` ships inside Node ≥ 24, already on the harness's dependency floor, and gives the same property — the lock dies with the process, "two cores on one LanceDB" is excluded by the OS, not by discipline.

**`E_LOCKED` (H1 addition to the spec's error enum).** The spec's closed enum had no code for "another core already holds this installation". Reusing `E_CORE_UNAVAILABLE` would have said the opposite of the truth (a core *is* running), and `E_INTERNAL` would have hidden an expected, user-actionable state. `E_LOCKED` is added to `$defs/ErrorCode`; the core process exits with code 3 when it is refused (`packages/core/src/bin.ts`), and the CLI maps `E_LOCKED` to exit code 3 too (`crates/plur1bus/src/output.rs`). A refused core never touches the running core's `run/core.token` or `run/core.pid`.

### 6. Why `contract`/`rpc` travel in `core.auth`, not in every response envelope

The spec (§6.2) says every response envelope carries `contract` and `rpc`. JSON-RPC 2.0 defines the response object's members exactly (`jsonrpc`, `result` or `error`, `id`); strict clients reject extra members, and the harness's own `$defs/Response` is closed (`additionalProperties: false`) so that the schema stays a faithful JSON-RPC 2.0 description. Putting the versions inside every `result` would pollute every method's result type. The purpose — a client learns both versions before it relies on any shape and refuses an unknown major — is met by the mandatory first call: `core.auth` returns `contract` and `rpc`, `core.status` repeats them, and a connection cannot issue any other call before `core.auth`.

### 7. Captures under core loss (the journal)

When the core cannot be reached, `memory add` does not fail: the CLI appends a `JournalLine` (schema `$defs/JournalLine`: `v`, `id`, `at`, `agentId`, `sessionKey`, `caller`, `messages` — the caller identity, not a principal; the core derives the principal at replay exactly as for a live call) to `state/journal/<agentId>.jsonl` and reports `degraded { reason: "core-unavailable", capability: "capture" }` with `journaled: true`; `memory recall` answers `degraded { reason: "core-unavailable", capability: "recall" }` with exit code 0 — missing memory is a visible state, not a command failure. The core replays the journal at start, before it opens the socket:

- **Ruling R20**: a line leaves the journal only if its capture resolved without a `reason` and `stored + skipped > 0`; any reason, zero counts or a rejected `done` keeps it (logged, retried next start, counted as `journalBacklog` in `core.status`). Replay first renames `<agent>.jsonl` to `<agent>.jsonl.replaying-<pid>`, so a concurrent CLI append lands in a fresh file; kept lines are appended back, each with its own newline, so a later append can never glue onto a kept torn tail; leftover `*.replaying-*` files from a crashed replay are processed first; each file is processed in isolation (a failed rename skips that file for this start). Criterion: "no journal line lost". Cost: a poison line is retried every start until fixed by hand, and a crash between append-back and delete gives at-least-once reprocessing, which the engine's capture dedup absorbs.
- **Ruling R19** (capture semantics): a capture's abort signal is the core's own shutdown signal only — never the client connection and never the `waitMs` timer. `memory.capture` with `wait: true` races `done` against `waitMs` (default 60 s, `core.capture.waitMs`) and answers `{ id, acceptedAt, pending: true }` if the timer wins; the capture keeps running. A client disconnect never aborts a capture. Cost: a capture can outlive its request until core shutdown.

### 8. H1 interims, superseded in H2

Plan H1 builds everything below the supervisor. Two interims exist only because the supervisor does not yet:

- **`plur1bus core run`** (internal subcommand, `crates/plur1bus/src/commands/core.rs`) runs the core in the foreground: it locates Node (`$PLUR1BUS_NODE`, then `<home>/runtime/node-*/bin/node`, then `node` on `PATH`) and `core.js` (`$PLUR1BUS_CORE_JS`, then `<home>/runtime/core/core.js`) and `exec`s it (POSIX) or waits for it (Windows). In H2 the same `core.js` entry becomes the supervisor's spawn target; the core already handles `SIGTERM`/`SIGINT` with one stop at a time, budget `core.shutdownBudgetMs`.
- **The CLI owns `config.json`** through `crates/plur1bus-config` (ADR-013 §5), and the core reads the file itself (`packages/core/src/config-load.ts`). H2 moves ownership to the supervisor and replaces the core's file read with the supervisor's `config.get` snapshot; `plur1bus-config` is the code the supervisor will run, so nothing is thrown away.

Also H2: the supervisor RPC (`config.*`, `module.*`, `daemon.*`), the `config.changed` and `module.state` notifications, lifelines and adoption (spec §6.4), size-based log rotation of child output, the Windows ACL.

### 9. Engine binding details that are architecture

- **Engine pin (ruling R4)**: `packages/core/package.json` depends on `git+https://github.com/Cyb3rb1ade/openclaw-plur1bus-memory.git#eaaf168fe602dcdb3a02bb84c4c6ba8fb2e88a72` — an exact commit, not a range. D2 decided an exact npm prerelease (`7.16.0-engine.N`); that prerelease does not exist until plan 2a-E's publish-on-tag workflow runs, and the `github:` shorthand fetches a codeload tarball the build proxy refuses while `git` over HTTPS works. Switching to the prerelease is a one-line change.
- **Harness-owned engine keys** are forced after the user's `engine.*` values (`packages/core/src/engine-config.ts`, T5 ruling): `baseDbPath`, `autoRecall: false`, `autoCapture: false`, `embedding.provider`, `reranker.enabled: true` and `reranker.provider`, `recall.softBudgetMs`/`globalInjectMaxChars` (from `core.recall.*`), `recall.decisionTrace.enabled: true`. See ADR-013 §7.
- **Test seam (ruling R17)**: `bin.ts --test-internals flat-embedder` (honoured only with `PLUR1BUS_ALLOW_TEST_INTERNALS=1`; `plur1bus core run` forwards `PLUR1BUS_TEST_INTERNALS`) injects `{ embeddings: <flat 384-d embedder>, reranker: null }` through the contract's `internals` option, because the production config always enables the reranker and the engine would otherwise download the ONNX model in every test with two or more memories. The real reranker runs in the nightly real-model test (criterion 1).

## Deviations from the spec, and why

| Spec says | H1 does | Reason |
|---|---|---|
| §6.2 closed enum of nine codes | Adds `E_LOCKED` | No existing code states "another core holds this installation" truthfully (§5). |
| §6.2 every response envelope carries `contract`, `rpc` | `core.auth` result (and `core.status`) carry them | JSON-RPC 2.0 responses have no room for extra members; the first call is mandatory (§6). |
| §6.4 `state/core.lock` via `flock` | Same path, `node:sqlite` `BEGIN EXCLUSIVE` | No native addon; same OS-released semantics, verified including SIGKILL (§5). |
| §4 named pipe with user-SID ACL (Windows) | Token auth only on Windows; ACL in H2 | Unverifiable without Windows system tests, which wait for engine PR-11 (§4). |
| §6.1 supervisor owns `config.json` | CLI owns it via `plur1bus-config`; core reads the file | No supervisor in H1 (§8). |
| §6.2 engine events forwarded as notifications named after the event | One `engine.event { name, agentId?, payload }` notification | Keeps the notification set closed in the schema while the engine's event list grows; the payload is still verbatim. |
| §6.2 notifications `config.changed`, `module.state` | Not in the H1 schema | Supervisor notifications; added with the supervisor methods in H2. |
| D2 exact npm prerelease | Exact git commit via `git+https` | Prerelease not yet published; `github:` shorthand blocked by the proxy (§9). |

## Consequences

- **Easier:** restarting or replacing a module without touching the core; third-party add-ons with the same shape as first-party ones; a CLI that answers in milliseconds and stays useful when the core is down; one schema edit changes both languages, and the fixtures fail the build on drift; a second core on the same home is impossible, not merely discouraged.
- **Harder:** two toolchains in CI (Cargo and pnpm) and two failure surfaces; every new method needs a schema edit, `pnpm gen`, fixtures and `pnpm docs:gen`; RAM grows by 30–50 MB per running module process; the supervisor's lifeline/adoption code (H2) is new code in a process that must not fail.
- **Revisit when:** RAM per module becomes a user complaint (build the in-process module host for trusted modules); the engine publishes the npm prerelease (switch the pin); H2 lands (Windows ACL, supervisor ownership, `config.changed`); a client needs versions on every response (it does not today — they are per connection).

## Alternatives considered

- **Process model A (single process, hot reload)** and **C (worker threads)**: rejected, see the table in §1.
- **One language (TypeScript for the CLI too)**: rejected by D7 — a Node CLI pays Node start-up on every command (B1 < 100 ms p95 is not reliably reachable) and puts Node on the recovery path of a broken Node installation.
- **Hand-written types on both sides**: rejected; drift between the Rust client and the TypeScript server is the most likely class of bug in a two-language system.
- **`contract`/`rpc` in every result**: rejected, pollutes every result type (§6).
- **`flock` through a native addon, or a PID file**: the addon adds a prebuild matrix for one call; a PID file is discipline, not exclusion (stale PIDs, PID reuse).
- **HTTP on loopback instead of a Unix socket / named pipe**: rejected for the local control path — a port is reachable by every local user and needs its own auth story; filesystem permissions on the socket are free on POSIX.
