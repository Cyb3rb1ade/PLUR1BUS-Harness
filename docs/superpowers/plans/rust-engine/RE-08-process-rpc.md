# RE-08 — Engine process, RPC schema `x-server: "engine"`, supervisor slot, `EngineClient`, seams

**Package.** The Rust engine as a running thing in the harness: the `plur1bus-engine serve` process, its RPC surface
(`engine.*`) in the shared RPC schema, the reverse `host.*` methods the core serves to it with a dispatch-level guard,
the supervisor's `engine` slot, the core's `EngineClient` that implements the TypeScript `Engine` interface over that
RPC, the no-supervisor spawn path, the test seams, the configuration switch, and the distribution of the binary. Size L;
seven tasks, one pull request each. After T5 the harness can run end to end on the Rust engine behind a flag.

**Depends on.** RE-01 (types), RE-04 (the first recall through the slot; T5 needs it), RE-03 T6 (`FlatEmbedder`).
**Enables.** RE-09 (system runs with `PLUR1BUS_ENGINE_IMPL=rust`), RE-10.

**Assumes.** RE-D1 (process + RPC), RE-D3b (`libonnxruntime` per target), RE-D4, RE-D10 (binary in payload, image
and bundle). If RE-D1 flips to N-API, this brief is replaced; nothing else in the programme changes.

**Read first.**
- Plan §2.1 (the architecture diagram and the five bullets, including the corrected egress and guard rules), §2.2,
  RE-8 in §4, review-focus items 1 and 5, risks RE-R2, RE-R5; ADR-012 §8 (the developer path), §10 (slots, adoption,
  identity rule §10.2/§10.7), ADR-016 (append-only ids, `x-since`).
- Harness, in this order:
  - `packages/rpc-schema/schema/rpc.schema.json` (`"x-rpc-version": "1.6.0"`; every method's `x-server`, `x-stability`,
    `x-since`, closed params), `packages/rpc-schema/src/index.ts` (`RPC_VERSION`), the tests under
    `packages/rpc-schema/test` that enforce the three `x-server` values, `buildCapabilities` (search `packages/rpc-schema/src`
    and `packages/module-api/src`), `crates/plur1bus-rpc/src/capabilities.rs` (`capabilities(server, features)`),
    `scripts/gen-docs.mjs` (the `## Stability` section groups by server).
  - `packages/module-api/src/rpc-server.ts` (`CallContext { requestId, connectionId, signal }`, `Handler`,
    `createRpcServer(o: RpcServerOptions)`), `api-principal.ts` (`ApiDelegation { clientId: "harness-api", token, principal? }`,
    `verifyApiDelegation`, `bindApiPrincipal`, `apiPrincipal` — the pattern the engine principal copies),
    `client-principal.ts` (`bindClientContext`, `isClientContext`), `client.ts` (the RPC client `EngineClient` builds on),
    `paths.ts` (`unitAddress(home, role)` → `run/<role>.sock` or the named pipe; `coreTokenPath`, `corePidPath`,
    `moduleRunFiles`), `packages/core/src/rpc/server.ts` (`createRpcServer({ hello })`, `Hello`), `packages/core/src/engine.ts`
    (`bindEngine(host, engineConfig, testInternals)` — the one place that constructs the engine; `assertEngineContract`),
    `packages/core/src/engine-host-ports.ts` (`createEngineFetch`, `createEngineSecrets` — what becomes `host.*`),
    `packages/core/src/bin.ts:55-95` (the `--test-internals` seam and `PLUR1BUS_ALLOW_TEST_INTERNALS`),
    `packages/core/src/attestation/` (the precedent for spawning a sibling binary from the core; `PLUR1BUS_ATTEST_BIN`).
  - `crates/plur1bus/src/supervisor/state.rs` (`RoleKind { Core, Api, Module }`, `Role`), `child.rs` (`ChildSpec`,
    `core_spec(layout, instance_id)`, `api_spec`, `module_spec`), `adopt.rs` (`Peer`, `probe_child`), `api_transport.rs`
    (the delegation-credential trust model), `mod.rs` (slot start order), `crates/plur1bus/src/paths.rs`
    (`Layout::endpoints`), `crates/plur1bus-rpc/src/{win,acl}.rs` (Windows pipe DACL), `crates/plur1bus/src/commands/core.rs`
    (`core run`), `crates/plur1bus/src/commands/firstaid.rs` (`1staid.check/1` ids, append-only), `crates/plur1bus/src/install/targets.rs`.
  - `packages/config-schema/schema/config.schema.json` (every key with `x-restart` and `x-tier`; `pnpm gen` regenerates
    the fixtures and the web settings index), `docs/config.md` (generated).
  - Distribution: `scripts/release/assemble-payload.mjs`, `scripts/release/package.mjs`, `Dockerfile`,
    `containers/harness/Dockerfile`, `apps/desktop/scripts/build-bundle.mjs`, `docs/container.md`, `docs/desktop.md`.
  - `tests/system/helpers.ts` (`startCore`, `coreEnv`, `waitEngineReady`; env names `PLUR1BUS_BIN`, `PLUR1BUS_CORE_JS`,
    `PLUR1BUS_NODE`, `PLUR1BUS_TEST_INTERNALS`, `PLUR1BUS_SYSTEM_INTERNALS`).

**Rules that apply.** Schema first: `x-server: "engine"` methods and the `host.*` methods are added to `rpc.schema.json`
with `x-stability: "experimental"`, `x-since` = the new RPC version, closed params; `pnpm gen` and `pnpm docs:gen` follow;
nothing under `generated/` is edited. `host.*` is engine-only **at dispatch** (plan §2.1), not by capability listing.
Every seam is honoured only with `PLUR1BUS_ALLOW_TEST_INTERNALS=1`. `--json` outputs of existing commands do not
change (ruling R13). The pid identity rule (ADR-012 §10.7) applies to the engine child.

**Modules added by the 2026-10-23 audit** (rows owned by RE-08 in [`MODULE-MAP.md`](MODULE-MAP.md), all folds): `lib/platform.js`
(453 — the four platform decisions become a table in `platform.rs`), `lib/safe-logging.js` + `lib/log-redact.js` (421 + 216 — the
engine logs through `plur1bus-log-schema`; T2 compares the engine's redaction patterns with `packages/log-schema/schema/redaction.json`
and adds what is missing there), `lib/peercred.js`, `lib/windows-acl-parse.js`, `lib/private-fs.js`, `lib/process-singleton.js`
(→ `plur1bus-rpc`'s `acl.rs`/`win.rs` and the supervisor's lock identity), `lib/metrics.js`, `lib/metrics-debounce.js`,
`lib/event-loop-lag-snapshot.js` (→ `engine.status` counters; scheduler lag instead of event-loop lag), `engine/lifecycle/close-resources.js`
(the close path, T2). `lib/abort.js` and `lib/with-timeout.js` are RE-01's `Cancel`; `lib/input-limits.js` RE-01's constants.
Not ported: `lib/host-paths.js`, `lib/host-sdk-loader.js`, `lib/plugin-meta.js` (Node module plumbing).

## Files

- Create: `crates/plur1bus-engine/src/rpc/{mod,server,methods,host_client,seams,lifeline}.rs`, `crates/plur1bus-engine/src/main.rs`
  (replace the placeholder), `crates/plur1bus-engine/tests/{rpc_server,seams,host_guard_contract,hop_budget}.rs`,
  `packages/core/src/engine/{client,spawn,select,host-methods,engine-principal}.ts`, `packages/core/test/engine/{client,host-guard,select,spawn}.test.ts`,
  `crates/plur1bus/tests/supervisor_engine_slot.rs`
- Modify: `packages/rpc-schema/schema/rpc.schema.json` (+ `pnpm gen` outputs), the `x-server` enforcement tests,
  `buildCapabilities`/`capabilities.rs`, `scripts/gen-docs.mjs`, `docs/rpc.md` (generated), `packages/core/src/engine.ts`,
  `packages/core/src/bin.ts`, `packages/core/src/rpc/server.ts` (register `host.*`), `packages/module-api/src/paths.ts`
  (`engineAddress`, `engineRunFiles`), `crates/plur1bus/src/paths.rs`, `crates/plur1bus/src/supervisor/{state,child,mod,adopt}.rs`,
  `crates/plur1bus/src/commands/{core,firstaid}.rs`, `crates/plur1bus-rpc/src/lib.rs` (`Endpoint::Engine`),
  `packages/config-schema/schema/config.schema.json` (+ `pnpm gen`), `docs/config.md`, `docs/cli.md` (generated),
  `scripts/release/assemble-payload.mjs`, `scripts/release/package.mjs`, `Dockerfile`, `containers/harness/Dockerfile`,
  `apps/desktop/scripts/build-bundle.mjs`, `docs/ci.md`, `docs/architecture.md`, `docs/engine-stores.md` (hop budget numbers),
  `AGENTS.md` (env vars `PLUR1BUS_ENGINE_BIN`, the new seam wiring; "Where things live")
- Test: the Rust and TypeScript test files above; `tests/system/*` with `PLUR1BUS_ENGINE_IMPL=rust` (RE-09 runs them)

## Interfaces

**Consumes:** RE-01 `Engine` trait and every contract type; RE-03 `FlatEmbedder`; RE-04 `recall`; the harness RPC
server and client (`@plur1bus/module-api`), `crates/plur1bus-rpc`.

**Produces:**

```text
RPC schema (x-rpc-version 1.6.0 → 1.7.0, additive):
  x-server "engine" methods (served by plur1bus-engine):
    engine.auth { token, clientId } → { contract, rpc, instanceId, pid, capabilities }   (the handshake, like module.auth)
    engine.status {} → EngineStatus                       engine.shutdown {} → {}
    engine.recall { query: RecallQuery, options?: RecallOptions } → RecallResult
    engine.capture { turn: TurnRecord, options?: CaptureOptions } → { id, acceptedAt }
    engine.capture.wait { id, timeoutMs? } → CaptureResult | { pending: true }      engine.capture.abort { id, reason? } → {}
    engine.checkpoint { agentId, reason } → CheckpointResult                          engine.systemSupplement { agent } → { text: string | null }
    engine.jobs.list {} / engine.jobs.run { job, agentId, trigger?, dryRun? } / engine.jobs.history { agentId, job?, since?, limit? }
    engine.embedding.embed { texts, kind, identity } / .rerank { query, docs, topN } / .probe { refresh? } / .identities {} / .serve {}
    engine.embedding.fingerprint { normalized } → { fingerprintId }   engine.config.normalizeEmbedding { raw } → { normalized }
    engine.models {} → ModelInfo[]
    engine.memory.<each MemoryOps member> and engine.memory.curation.{list,keep,drop}
    engine.admin.<each AdminOps member>                 engine.stores.adopt { path, expectedSchema? } → AdoptReport
    engine.snapshot.create { out } / engine.snapshot.verify { dir }    engine.tombstones.reapply {} → ReapplyReport
  x-server "engine" notifications: engine.event { name, payload }, engine.capture.done { id, result }
  x-server "core" methods, engine-only at dispatch: host.llm.complete { params } → LlmResult, host.egress.decide { scheme, host, port } → Decision,
    host.secret.get { name } → { value } (never logged), host.workspaceDir { agentId } → { path | null }, host.event { name, payload } → {},
    host.journalBacklog {} → JournalBacklog | null
  x-server "core" notification: egress.changed {}

Rust (crates/plur1bus-engine):
  rpc::server::serve(engine: Arc<dyn Engine>, layout: &EngineLayout, lifeline: Lifeline) -> Result<(), ServeError>
  rpc::host_client::RpcHost  — implements HostServices over a lazy, reconnecting client to the core's endpoint;
                               HostError::Unavailable while the core is not up; egress decisions cached per Target (RE-03)
  rpc::seams::from_env() -> Result<Option<Seam>, SeamError>  — reads PLUR1BUS_TEST_INTERNALS only with PLUR1BUS_ALLOW_TEST_INTERNALS=1
  main: `plur1bus-engine serve --home <dir> [--lifeline stdin --instance <uuid>]`; exit codes: 0 clean, 2 usage, 3 another engine owns the home

Rust (crates/plur1bus):
  RoleKind::Engine; supervisor::child::engine_spec(layout, instance_id) -> Result<ChildSpec, String>
    (binary `plur1bus-engine` beside current_exe(), override PLUR1BUS_ENGINE_BIN; env ORT_DYLIB_PATH to the shipped runtime;
     PLUR1BUS_TEST_INTERNALS passed through under PLUR1BUS_ALLOW_TEST_INTERNALS=1)
  plur1bus_rpc::Endpoint::Engine; Layout::endpoints gains run/engine.{sock|pipe,token,pid}

TypeScript (packages/core):
  engine/client.ts   export class EngineClient implements Engine   — one class, the drop-in for createEngine()
  engine/select.ts   export function selectEngine(cfg, host, engineConfig, testInternals): Engine   — reads cfg.engine.implementation
  engine/spawn.ts    export async function spawnEngine(home, opts): Promise<{ address, token, pid, stop() }>  — the no-supervisor path
  engine/host-methods.ts  export function registerHostMethods(server, deps)  — host.* handlers, each guarded
  engine/engine-principal.ts  bindEnginePrincipal(ctx), isEngineContext(ctx), verifyEngineDelegation(v, token)
  module-api/paths.ts  engineAddress(home), engineRunFiles(home)

Config: engine.implementation: "node" | "rust" (x-restart "core", x-tier "advanced", default "node" until RE-11)
```

## Tasks

### T1 — Schema: `engine.*`, `host.*`, the fourth server value (one pull request)

- [ ] **Step 1: failing tests.** In `packages/rpc-schema/test`: `every engine.* method has x-server engine, experimental
  stability, x-since 1.7.0 and closed params`, `buildCapabilities("engine") lists only engine.* and no notification but
  engine.event and engine.capture.done`, `buildCapabilities("core") lists host.* only when the engine feature flag is on`
  (the capability builder's `features` input gains `engine: true`); in `crates/plur1bus-rpc`: the mirror test for
  `capabilities(Server::Engine, …)`.
- [ ] **Step 2: schema edits** as in Interfaces; bump `x-rpc-version` to `1.7.0`; `pnpm gen`; extend the `x-server`
  enforcement (tests, `buildCapabilities`, `capabilities.rs`, `gen-docs.mjs`'s stability grouping); `pnpm docs:gen`.
- [ ] **Step 3:** `pnpm test --filter @plur1bus/rpc-schema`, `cargo test -p plur1bus-rpc`, `pnpm docs:check` — green.
  **Commit** `RE-08/T1: rpc schema 1.7.0 with x-server engine and host.* methods`.

### T2 — The engine process: server, lifeline, seams (one pull request)

- [ ] **Step 1: failing tests** `crates/plur1bus-engine/tests/rpc_server.rs`: `auth_with_the_token_file_lists_the_engine_capabilities`,
  `a_wrong_token_is_refused_before_any_method`, `status_recall_capture_roundtrip_over_the_socket` (FakeHost, flat
  embedder, a temp home), `capture_done_is_notified_and_wait_returns_the_result`, `shutdown_closes_cleanly_and_removes_run_files`,
  `a_second_engine_on_the_same_home_exits_3`; `tests/seams.rs`: `flat_embedder_is_refused_without_the_allow_flag` (exit
  2, message names the flag), `flat_embedder_cold_delays_the_first_two_query_embeds`; `tests/host_guard_contract.rs`:
  `host_calls_fail_unavailable_until_the_core_answers_and_recover_after` (a fake core RPC server in the test).
- [ ] **Step 2: implement** `rpc/server.rs` over `plur1bus-rpc`'s transport (Unix socket / Windows named pipe with the
  DACL of `win.rs`), method dispatch from the schema's generated names, the run files, the single-instance lock
  (RE-02 `JobLock` with the pid identity), `lifeline.rs` (`--lifeline stdin`: exit when the supervisor's write end
  closes, as the core does), `host_client.rs`, `seams.rs`, `main.rs`.
- [ ] **Step 3: commit** `RE-08/T2: plur1bus-engine serve`.

### T3 — Core: `EngineClient`, selection, host methods with the dispatch guard (one pull request)

- [ ] **Step 1: failing tests** `packages/core/test/engine/client.test.ts`: `EngineClient implements every Engine member
  the core calls` (the 27 of plan §1.3, against a fake engine RPC server), `recall maps a transport error to
  E_NOT_AVAILABLE reason=engine-unavailable and never throws a raw socket error`, `capture returns a handle whose done
  resolves from engine.capture.done`; `host-guard.test.ts`: `an ordinary authenticated client calling host.secret.get by
  name gets E_DENIED and the spy secret store records no read`, `the same for host.llm.complete`, `the engine connection
  succeeds`, `core.auth omits host.* for ordinary callers` (listing check, kept as UX); `select.test.ts`:
  `implementation node returns the Node engine, rust returns EngineClient, anything else fails config validation`.
- [ ] **Step 2: implement** `client.ts` (over `@plur1bus/module-api`'s client; `assertEngineContract` on the handshake;
  the `fetch`/`secrets` ports of `engine-host-ports.ts` become `host.*` handlers: `host.egress.decide` uses `egress.decide`,
  `host.secret.get` uses the secret store with the same lease/audit path as today, `host.llm.complete` the provider
  router with the engine's `LlmParams`), `engine-principal.ts` (modelled on `api-principal.ts`; the delegation token is
  the engine's `run/engine.token`), `host-methods.ts` (every handler starts with `if (!isEngineContext(ctx)) throw new
  RpcError("E_DENIED", …)`), `select.ts`, the `engine.implementation` key in `config.schema.json` (+ `pnpm gen`, `docs:gen`).
- [ ] **Step 3: commit** `RE-08/T3: EngineClient, host.* with dispatch guard, engine.implementation`.

### T4 — Supervisor slot and the no-supervisor spawn (one pull request)

- [ ] **Step 1: failing tests** `crates/plur1bus/tests/supervisor_engine_slot.rs` (pattern: the existing supervisor
  tests with `fake-core.mjs`; add a `fake-engine` mode or use the real `plur1bus-engine` binary with the flat embedder):
  `daemon_start_starts_engine_then_core_and_status_lists_both`, `an_engine_crash_is_restarted_with_backoff_and_the_core_survives`,
  `a_running_engine_is_adopted_after_a_supervisor_restart`, `one_staid_check_reports_engine_process_and_engine_store`,
  `windows_pipe_acl_applies_to_the_engine_pipe` (cfg(windows)); `packages/core/test/engine/spawn.test.ts`:
  `core run without a supervisor spawns the engine beside the executable and stops it on exit`, `PLUR1BUS_ENGINE_BIN
  overrides the path`, `--test-internals is forwarded to the child only with the allow flag`.
- [ ] **Step 2: implement** `RoleKind::Engine`, `engine_spec`, start order (engine → core → api; the core's readiness
  does not wait for the engine — recall degrades until it answers), health through `engine.status`, adoption, the
  `1staid check` ids `engine.process`, `engine.store`, `engine.runtime` (append-only; document in the generated docs),
  `Endpoint::Engine`, `Layout::endpoints`, `paths.ts`, `spawn.ts` and the `bin.ts` forwarding.
- [ ] **Step 3: commit** `RE-08/T4: supervisor engine slot and core run spawn`.

### T5 — End to end and the hop budget (one pull request)

- [ ] **Step 1:** `tests/system/helpers.ts`: `PLUR1BUS_ENGINE_IMPL=rust` sets `engine.implementation: "rust"` in the
  test home's config and asserts the binary exists; run `two-session-recall`, `memory-ops`, `reconnect`, `kill-soak`
  locally with it and quote the results in the PR (RE-09 wires CI).
- [ ] **Step 2: measure** `crates/plur1bus-engine/tests/hop_budget.rs` (ignored by default, run with `--ignored` in the
  PR): 10,000 `engine.status` round trips and 1,000 `engine.recall` with the flat embedder on Linux, macOS and Windows
  runners; record p50/p99 in `docs/engine-stores.md`. **p99 over 5 ms on any platform re-opens RE-D1** (plan §2.2) —
  stop and report instead of optimising.
- [ ] **Step 3: commit** `RE-08/T5: system runs on the Rust engine, hop budget recorded`.

### T6 — Distribution (one pull request)

- [ ] **Step 1: failing tests:** `scripts/release/test/*.test.ts` gains `the payload for every target contains
  plur1bus-engine and the ONNX runtime library`; `scripts/release/test/container-files.test.ts` gains the Dockerfile
  copy step; `apps/desktop` bundle test gains the binary.
- [ ] **Step 2: implement** the payload, image and bundle changes; `docs/container.md`, `docs/desktop.md`, `docs/ci.md`.
- [ ] **Step 3: commit** `RE-08/T6: ship plur1bus-engine in payload, image and bundle`.

### T7 — Documentation (folded into T5 or T6)

- [ ] `docs/architecture.md` (the engine slot), AGENTS.md ("Where things live" row, env vars `PLUR1BUS_ENGINE_BIN` and
  the seam wiring under "Running the core by hand"), `docs/rpc.md`/`docs/cli.md`/`docs/config.md` regenerated.

## Acceptance

- `pnpm docs:check`, `pnpm lint`, `cargo test --workspace`, `cargo clippy --workspace --all-targets -- -D warnings` green.
- The negative invocation tests of T3 green: no `host.*` handler runs for a non-engine connection.
- `tests/system/two-session-recall.test.ts` with `PLUR1BUS_ENGINE_IMPL=rust` answers `degraded: null` on both recalls
  on a Linux runner with `PLUR1BUS_CI_RECALL_HARD_MS=3000`, and meets the 400/600 ms targets on reference hardware.
- Hop budget recorded; under 5 ms p99 on all three platforms.
- `daemon status` shows the engine slot; `1staid check --json` lists the three new ids.

## Out of scope

Moving core logic into the engine (RE-10); flipping the default to `rust` (RE-11); model download by the engine.

## Hand-off

Seven PRs; T1 first (everyone else generates from the schema), T2 and T3 in parallel, T4 after both, T5 after RE-04
merged, T6 anytime after T2. The `host.*` method list is consumed by RE-10 — additions there go through the schema
with `x-since`.
