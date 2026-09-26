# M1b-2a engine work: E3 (embedding probe/serve real, detect per-vault tolerance, typed pushCriticalButtons). Implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the two `EmbeddingService` placeholders with real members — `probe()` exercises the provider once and reports identity and readiness (the harness's model-warming primitive), `serve(address | null)` starts or stops the engine's own scoped-embedding IPC server on an `IpcAddress` (platform default via `host.platform.ipcAddress`) without the loopback claim listener — plus the parked E2 finding R11 (per-vault tolerance in `admin.obsidian.detect`) and a typed optional host capability `pushCriticalButtons`. Contract **1.7.0**, additive.

**Architecture:** One new engine file, `engine/providers/embedding-service.js`, holds address validation, the probe (coalesced, memoized on success) and the serving state machine (serialized, idempotent per address, torn down by `close()`); `engine/create-engine.js` only wires it. The transport stays `lib/providers/scoped-embedding-ipc.js` — same envelope, token, identity binding and caps — extended by two server options (`address`, `claim`) and one client option (`address`), with the legacy OpenClaw lifecycle path byte-for-byte unchanged when the options are absent. On the harness path the engine is the in-process owner (ADR-001 C1): no claim listener, `serve(null)` means "in-process only".

**Tech stack:** engine repo `Cyb3rb1ade/openclaw-plur1bus-memory` (ESM JavaScript, `types/engine.d.ts` + `types/engine.conformance.ts`, `node --test`, `node:net`). Node ≥ 24.16 (`/home/claude/.node24/bin` in the cloud session). Branch `feat/e3-embedding-service` from `main` at `d32771c5` (merge of #192, port 7.16.11, on top of E2).

**Spec:** `docs/superpowers/specs/2026-09-24-m1b-2a-core-daemon-cli-design.md` — §7 row **E3** ("`embedding.probe()` and `serve()` real for the in-process owner; `serve` accepts the harness's `IpcAddress` or `null` for 'in-process only'", additive); §4 core bullet (in-process embedding owner, "ADR-001 C1: the loopback claim listener is not started on the harness path"); §5 lifecycle ("Models warm in the background; `core.status.degraded = { reason: "models-warming" }` until they are ready"); §3 out-of-scope list and R4 (Windows named-pipe transport is **PR-11**, Windows system tests wait for it). ADR-001 C1 (in-process owner, no claim listener), ADR-006 §IPC (envelope/token/fingerprint unchanged; Windows: `\\.\pipe\plur1bus-embedding-<sha256[0:32]>`), E2 ledger ruling **R11** (detect: catch per candidate, report `confirmed: false`).

## 2a-E sequence (the frame this plan sits in)

| Step | Branch / PR | Contract | Status |
|---|---|---|---|
| E1 | `feat/e1-memory-ops` | 1.5.0 | merged `215193e5` (#188) |
| E2 | `feat/e2-admin-ops` | 1.6.0 | merged (in `d32771c5`) |
| **E3** | `feat/e3-embedding-service` | **1.7.0** | **this plan** |
| E4 | `status()` ledger health + model readiness | 1.8.0 | after E3; consumes `embeddingProbe.lastResult()` from Task 3 |
| E5 … E7 | see the spec's §7 table | | |

The harness side (calling `probe()` in the background after `ready` and clearing `models-warming`, calling `serve(null)` on its own path, any RPC exposure) is 2a-H2's work.

## Global constraints

- Contract amendment policy (`types/engine.d.ts:23-31`): every observable shape change bumps `ContractVersion`; `ContractVersion`, `types/engine.conformance.ts` and both adapters move together in one PR. E3 bumps once, to `"1.7.0"`, in Task 1. Literal sites (grep `1\.6\.0` repo-wide, excluding `package-lock.json`, `CHANGELOG.md` history and `.superpowers/`): `types/engine.d.ts` (header line 4 "Contract version", line 5 "amended seven times" → "eight", changelog after line 39, `ContractVersion` line 42), `types/engine.conformance.ts:106`, `engine/create-engine.js` (`contract:` lines 3468 and 3481, comment 3466), `tests/engine-contract.test.js` (lines 46, 48, 51, 384, 386, 387), `docs/engine-api.md` (line 3, "amended seven times", line 369, line 422). Historical "(1.6.0)" annotations on members stay.
- Engine gate per task: `npm run lint && npm test` (~9-10 min; run with a **590000 ms** timeout) plus `TZ=UTC node --test tests/golden-prefix.test.js` (golden **11/11**). The base is fully green; a failure is yours until proven otherwise.
- Conventions from E1/E2: (1) every new `engine/**/*.js` file is registered in `tests/helpers/runtime-sources.js` `ENGINE_PATHS` **and** `scripts/lib/deploy-integrity.mjs` `DEPLOY_FILES` (explicit lists; `readRuntimeSources()` throws on an unlisted file); (2) new tests use `makeTempDir` from `tests/helpers/temp-dir.js`, never `mkdtempSync`; (3) typed failures are `MemoryOpError` from `engine/memory-ops/errors.js` (`not-found | denied | invalid-input | approval-required | conflict | storage`) with fixed, log-safe English messages; raw exceptions go to `logger.warn` only, never into a message.
- `engine/**` never imports `openclaw`, `lib/host-services.js`, `lib/runtime-shutdown.js`, `lib/providers/openclaw-memory-embedding-adapters.js` or `lib/setup/*-plugin-runtime.js`, never reads a bare `api`, never reads `process.env.OPENCLAW_*`, and new code never consults `host.runtime` (`scripts/lint-engine-imports.mjs`, `lint-no-api-outside-adapter.mjs`). `engine/**` may import `lib/providers/scoped-embedding-ipc.js` and `lib/platform.js` (already reachable today); the platform default address comes from `host.platform.ipcAddress`, not from a direct `lib/platform.js` call.
- The IPC protocol is unchanged: envelope keys `{dimensions, fingerprintId, model, request, token}`, operations `query|passage|batch`, `MAX_EMBED_TEXTS 64`, `MAX_REQUEST_BYTES 256 KiB`, `timingSafeEqual` token, model/dimension/fingerprint binding. The token file stays `<baseDbPath>/control/embedding-ipc/owner.token` (0600, directory 0700) for every address; no result, log line or error ever contains the token.
- The legacy OpenClaw path is behaviour-neutral: `createScopedEmbeddingIpcServer` called without `address`/`claim` behaves exactly as at `d32771c5` (claim listener, `owner.sock` in the private directory), and every existing test in `tests/scoped-embedding-ipc.test.js` passes unchanged.
- No new third-party dependency. No Windows pipe-ACL code (Node's `net` cannot set a DACL; that is PR-11).
- Commit identity via `git -c user.name=Cyb3rb1ade -c user.email=84099452+Cyb3rb1ade@users.noreply.github.com commit …`; trailers in the body: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01SxcLhve6hyM9AFm2nU9B3F`. Never `git stash`, never `--amend`, never push, never change git config; pushes and merges are the owner's (via the Mac). Ignore stop-hook demands about identity/amend/push.
- Never put secrets, tokens or real user data in the repo, logs or test fixtures. Paths, agent ids, model names and texts in tests are synthetic.

## Review focus

1. **Stale or foreign socket at the serve address:** a unix-socket file left by a crashed core must be detected dead (connect probe), unlinked and re-bound; a live foreign listener must answer `conflict` and keep its socket and the token untouched. Pinned in Tasks 2 and 4.
2. **Unsafe socket directory:** a unix-socket address whose parent is missing, a symlink, or group/world-accessible must answer `invalid-input` before anything listens or any token is written. Pinned in Task 4.
3. **Close while serving, then a new engine on the same address:** `close()` must stop the listener, cut open connections, remove the socket file and the token, so a fresh engine can `serve` the same address at once. Pinned in Task 4.
4. **Concurrent and aborted probes:** two concurrent `probe()` calls share one provider call; one caller's abort answers that caller `{ ok: false, error: "aborted" }` without cancelling the other; a failed probe is not memoized, so a retry exercises the provider again. Pinned in Task 3.
5. **Wrong credentials over a served address:** a client with a wrong token, model or fingerprint gets an error frame and no vectors; the serve result exposes `tokenPath`, never the token. Pinned in Task 4.

---

### Task 1: Contract 1.7.0 — types, conformance pins, literal sites

**Files:**
- Modify: `types/engine.d.ts` (header lines 4-5 and changelog after 39; `ContractVersion` 42; `HostCapabilities` 189-195; Embedding block 387-408)
- Modify: `types/engine.conformance.ts` (pin line 106; new pins after line 142 and after line 166)
- Modify: `engine/create-engine.js` (lines 3466, 3468, 3481 only)
- Modify: `tests/engine-contract.test.js` (lines 46, 48, 51, 384, 386, 387)

**Interfaces (produces; later tasks implement exactly this):**

```ts
export type ContractVersion = "1.7.0";

// ---- HostCapabilities addition ----
/** 1.7.0: argument of HostCapabilities.pushCriticalButtons (engine/jobs/internal-job-bodies.js). */
export interface CriticalButtonPushArgs {
  agentId: AgentId;
  /** The classify-recent classifier result (pushMessages, errors, …); host-opaque. */
  result: unknown;
  /** The host's own command context, passed back unchanged; host-opaque. Revisited with HostRuntime in 2.0 (E6). */
  commandCtx: unknown;
  /** Partial-failure note for the last card; "" when there is none. */
  warning: string;
}
/** `sent` cards went out with buttons; `unsentTexts` go out as plain cron text; `reason` is host-defined. */
export interface CriticalButtonPushResult { sent: number; unsentTexts: string[]; reason?: string }

export interface HostCapabilities {
  /* resolvePath?, registrationMode?, memoryArchiveDir? unchanged */
  /** 1.7.0: deliver Critical Push cards with accept/reject buttons. `null` = not ready; the engine then replies
   *  with the plain cron text, as it does when the capability is absent, throws, or returns no `unsentTexts`. */
  pushCriticalButtons?(args: CriticalButtonPushArgs): Promise<CriticalButtonPushResult | null>;
  [capability: string]: unknown;
}

// ---- Embedding ----
export type EmbeddingProbeError = "aborted" | "provider-failed" | "invalid-vector" | "dimension-mismatch";
export interface EmbeddingProbeResult {
  /** The provider returned a finite vector of `identity.dimensions`: the model is loaded and ready. */
  ok: boolean;
  error?: EmbeddingProbeError;
  /** true: the memoized result of an earlier successful probe of this engine; no provider call was made. */
  cached: boolean;
  identity: EmbeddingIdentity;
  /** Provider call time of the probe that produced this result. */
  durationMs: number;
  /** Clock time (host.clock) when that probe finished. */
  checkedAt: number;
}
/** The values a client must put into the IPC envelope next to the token. */
export interface EmbeddingEnvelopeIdentity { model: string; dimensions: number; fingerprintId: string }
export interface EmbeddingServeResult extends Disposable {
  /** The bound address; null after serve(null) (in-process only). */
  address: IpcAddress | null;
  /** Where the 0600 token file lives; null when not serving. The token itself is never returned. */
  tokenPath: string | null;
  identity: EmbeddingEnvelopeIdentity | null;
}

/**
 * probe(): exercises the provider once (a query embed of a fixed probe text with a per-engine nonce, so a
 * persisted embedding cache cannot answer it) and memoizes a successful result; concurrent calls share one
 * provider call; `refresh: true` forces a new provider call. Never rejects for a provider failure (the result
 * says `ok: false`); rejects with MemoryOpError `storage` ("engine is closed") after close().
 * serve(address): starts the engine's scoped-embedding IPC server on `address` (omitted → the platform default,
 * `host.platform.ipcAddress(<baseDbPath>/control/embedding-ipc)`), without the loopback claim listener
 * (ADR-001 C1). Idempotent for the address already served (same result object); `null` stops serving and resolves
 * `{ address: null, tokenPath: null, identity: null }` (in-process only). `dispose()` stops that server if it is
 * still the served one (fire and forget). close() stops serving. Rejects with MemoryOpError: `invalid-input`
 * (malformed address, a kind the platform does not use, an unsafe socket directory), `conflict` (another address
 * already served, the address in use, the host lifecycle owns the IPC, the engine is an IPC client),
 * `storage` (closed, or the listener failed to start).
 */
export interface EmbeddingService {
  embed(/* unchanged */): Promise<Float32Array[]>;
  rerank(/* unchanged */): Promise<RerankHit[]>;
  probe(opts?: { signal?: AbortSignal; refresh?: boolean }): Promise<EmbeddingProbeResult>;
  identities(): EmbeddingIdentity[];
  serve(address?: IpcAddress | null): Promise<EmbeddingServeResult>;
}
```

Header changelog line after the 1.6.0 line: `1.7.0 — EmbeddingService.probe(opts?) → EmbeddingProbeResult (identity, readiness, memoized); serve(address?: IpcAddress | null) → EmbeddingServeResult (real scoped IPC, in-process owner, no claim listener); HostCapabilities.pushCriticalButtons? typed (E3).`

- [ ] **Step 1:** Edit `types/engine.d.ts` exactly as above (add, never reorder; keep the existing `probe`/`serve` positions). Bump `ContractVersion` and the header.
- [ ] **Step 2:** `types/engine.conformance.ts`: import the new names; bump the pin to `"1.7.0"`; add under a `// 1.7.0: EmbeddingService probe/serve; HostCapabilities.pushCriticalButtons (E3 Task 1).` comment:
  - `assertTrue<Exact<Engine["embedding"]["probe"], (opts?: { signal?: AbortSignal; refresh?: boolean }) => Promise<EmbeddingProbeResult>>>();`
  - `assertTrue<Exact<Engine["embedding"]["serve"], (address?: IpcAddress | null) => Promise<EmbeddingServeResult>>>();`
  - `assertTrue<Exact<EmbeddingProbeError, "aborted" | "provider-failed" | "invalid-vector" | "dimension-mismatch">>();`
  - `assertTrue<Exact<EmbeddingServeResult["address"], IpcAddress | null>>();` and `assertTrue<EmbeddingServeResult extends Disposable ? true : false>();`
  - `assertTrue<Exact<HostCapabilities["pushCriticalButtons"], ((args: CriticalButtonPushArgs) => Promise<CriticalButtonPushResult | null>) | undefined>>();`
  - `assertTrue<Exact<CriticalButtonPushArgs["warning"], string>>();`
  - a host literal after `hostWithCapabilities`: `const hostWithButtons: HostServices = { ...minimalHost, capabilities: { pushCriticalButtons: async () => null } }; void hostWithButtons;`
- [ ] **Step 3:** Bump the two `contract: "1.6.0"` literals and the comment in `engine/create-engine.js`; bump the six hits in `tests/engine-contract.test.js`. No runtime change yet.
- [ ] **Step 4:** Run `npm run lint` and `node --test tests/engine-contract.test.js`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(contract): 1.7.0 — EmbeddingService probe/serve types, typed pushCriticalButtons capability (pins)`.

### Task 2: Scoped IPC transport — `address`/`claim` on the server, `address` on the client

**Files:**
- Modify: `lib/providers/scoped-embedding-ipc.js` (`createScopedEmbeddingIpcServer` lines 294-484; `requestIpc` 509-556; `IpcScopedEmbeddingProvider` 561-631; `ReloadSafeIpcScopedEmbeddingProvider` constructor 634-652)
- Test: `tests/scoped-embedding-ipc.test.js` (new `describe("scoped embedding IPC on an explicit address (E3)")`)

**Interfaces:**
- Produces:
  ```js
  createScopedEmbeddingIpcServer({ stateRoot, embeddings, fingerprintId, logger, requestFrameTimeoutMs,
                                   address /* IpcAddress | undefined */, claim /* boolean, default address === undefined */ })
    // → Object.freeze({ start, shutdown, identity /* { model, dimensions, fingerprintId }, frozen */, tokenPath /* string */ })
  new IpcScopedEmbeddingProvider({ stateRoot, model, dimensions, fingerprintId, address /* IpcAddress | undefined */ })
  new ReloadSafeIpcScopedEmbeddingProvider({ ..., address })   // passed through to each IpcScopedEmbeddingProvider
  ```
- Server behaviour with `address`: the listen target is `address.address`; `claim: false` skips the claim listener entirely. `unix-socket`: the existing stale-socket logic runs against `address.address` (lstat → refuse symlink/non-socket; connect probe live → `ownerAlreadyActiveError()`; dead → unlink), then `securePath(address, 0o600)` after listen and `removeOwnedPath(…, "socket")` on shutdown. `abstract-socket` and `named-pipe`: no filesystem step; `EADDRINUSE` from `listen` → `ownerAlreadyActiveError(error)`; shutdown only closes the listener. Token handling, activation epoch, request processing and shutdown order are shared with the legacy path (one code path, the target is a variable).
- Client behaviour with `address`: `requestIpc` connects to `address.address` instead of `paths.socketPath`; token read from `paths.tokenPath` as today.

- [ ] **Step 1: Write the failing tests** (embedder `{ model: "fixture/e5", dimensions: () => 2, embedQuery: async () => [1, 0], embedPassage: async () => [0, 1], embedBatch: async (t) => t.map(() => [0.5, 0.5]) }`, `stateRoot = makeTempDir("e3-ipc-")`, `ACTIVE_FINGERPRINT_ID`):
  - (a) explicit unix socket: `const dir = makeTempDir("e3-sock-"); chmodSync(dir, 0o700); const address = { kind: "unix-socket", address: join(dir, "e.sock") }`; server with `{ address, claim: false }` → `start()`; `new IpcScopedEmbeddingProvider({ stateRoot, model: "fixture/e5", dimensions: 2, fingerprintId: ACTIVE_FINGERPRINT_ID, address })` → `embedQuery("q")` deep-equals `[1, 0]`; `statSync(address.address).mode & 0o777 === 0o600`; `server.identity` deep-equals `{ model: "fixture/e5", dimensions: 2, fingerprintId: ACTIVE_FINGERPRINT_ID }`; `server.tokenPath === resolveScopedEmbeddingIpcPaths(stateRoot).tokenPath`; after `shutdown()` neither the socket file nor the token file exists.
  - (b) `claim: false` opens no claim listener: while (a)'s server runs, `createServer().listen(resolveScopedEmbeddingOwnerClaimAddress(resolveScopedEmbeddingIpcPaths(stateRoot).directory))` succeeds (close that probe listener again). Off Linux this is a loopback TCP port, which is exactly what ADR-001 C1 forbids on the harness path.
  - (c) abstract socket (`{ skip: process.platform !== "linux" }`): `address = { kind: "abstract-socket", address: "\0plur1bus-e3-test-" + randomUUID() }`; round trip as (a); a second server on the same address rejects `/owner is already active/`.
  - (d) stale socket recovery: `leaveStaleUnixSocket(address.address)` (existing helper) then start → succeeds and serves.
  - (e) wrong fingerprint client on the explicit address (`STALE_FINGERPRINT_ID`) → rejects `/fingerprint does not match/`.
- [ ] **Step 2:** Run `node --test tests/scoped-embedding-ipc.test.js`. Expected: new cases FAIL (the server ignores `address`), every existing case PASS.
- [ ] **Step 3:** Implement the options. Keep `resolveScopedEmbeddingIpcPaths(stateRoot)` as the token location for every address.
- [ ] **Step 4:** Run the file again plus `tests/adapter-register-gateway.test.js` and `tests/llm-result-cache-lifecycle.test.js`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(ipc): scoped embedding server on an explicit IpcAddress without the claim listener; client address option`.

### Task 3: `embedding.probe()` real

**Files:**
- Create: `engine/providers/embedding-service.js`
- Modify: `engine/create-engine.js` (`embeddingService` lines 3392-3411: `probe`; expose `internals.embeddingProbe`)
- Modify: `tests/helpers/runtime-sources.js` (`ENGINE_PATHS.embeddingService`), `scripts/lib/deploy-integrity.mjs` (`DEPLOY_FILES`)
- Test: `tests/engine-embedding-probe.test.js`

**Interfaces:**
- Produces in `engine/providers/embedding-service.js`:
  ```js
  export const PROBE_TEXT_PREFIX = "plur1bus embedding probe";
  /** → { probe(opts?): Promise<EmbeddingProbeResult>, lastResult(): EmbeddingProbeResult | null } */
  export function createEmbeddingProbe({ getEmbeddings, getIdentity, logger, clock = Date.now, nonce = randomUUID() })
  ```
  `lastResult()` is what E4 reads for model readiness (not wired to `status()` here).
- Algorithm (the tests do not fully determine it): one `inFlight` promise; `probe(opts)` → if `opts.refresh !== true` and a memoized ok result exists, return `{ ...memo, cached: true }`; else reuse `inFlight` or start one: `t0 = clock()`, `vector = await getEmbeddings().embedQuery(\`${PROBE_TEXT_PREFIX} ${nonce}:${attempt++}\`)` (no signal: the shared call must not be cancelled by one caller); classify: throw → `provider-failed` (raw error to `logger.warn("embedding.probe: provider failed: …")`), not an array/typed array or any non-finite entry → `invalid-vector`, `length !== identity.dimensions` → `dimension-mismatch`; result `{ ok, error?, cached: false, identity: getIdentity(), durationMs: clock() - t0, checkedAt: clock() }`; memoize only when `ok`; clear `inFlight` in `finally`. Each caller awaits `raceAbort(inFlight, opts.signal)`; an abort answers that caller `{ ok: false, error: "aborted", cached: false, identity, durationMs: clock() - callerStart, checkedAt: clock() }` and leaves `inFlight` running.
- Engine wiring: `probe: async (opts) => { assertMemoryOpen(); return memoryOpsContext.track(() => embeddingProbe.probe(opts)); }` (close drains an in-flight probe within the budget); `getEmbeddings: () => internals.embeddings`, `getIdentity: () => embeddingService.identities()[0]`, `clock` the engine's clock.

- [ ] **Step 1: Write the failing tests** (engine per `tests/engine-close-inflight.test.js`'s `config()`/`stubHost()`, `testOptions.internals.embeddings` a 384-dim stub counting `embedQuery` calls):
  - (a) first `probe()` → `ok: true, cached: false`, `identity` deep-equals `engine.embedding.identities()[0]`, `durationMs >= 0`; second `probe()` → `cached: true`, same `checkedAt`, call count 1; `probe({ refresh: true })` → `cached: false`, count 2; the probe texts start with `PROBE_TEXT_PREFIX` and differ between the two calls.
  - (b) concurrency: stub `embedQuery` parks on a deferred; `const a = probe(), b = probe({ signal: AbortSignal.abort() })`; `await b` → `{ ok: false, error: "aborted" }`; release; `await a` → `ok: true`; call count 1.
  - (c) stub throws `new Error("boom sk-secret")` → `{ ok: false, error: "provider-failed", cached: false }`, the result JSON does not contain `"sk-secret"`, a warn line contains `embedding.probe`; the stub then succeeds and `probe()` → `ok: true` (failure not memoized).
  - (d) stub returns 383 numbers → `dimension-mismatch`; returns `[NaN, …]` (384) → `invalid-vector`.
  - (e) `await engine.close()` then `probe()` → rejects `MemoryOpError` `storage` "engine is closed".
- [ ] **Step 2:** Run the file. Expected: FAIL (`cached` stays false, no `identity`).
- [ ] **Step 3:** Implement `createEmbeddingProbe` and the wiring; register the file in `ENGINE_PATHS` and `DEPLOY_FILES`.
- [ ] **Step 4:** Run the file, `tests/engine-contract.test.js`, `tests/deploy-integrity.test.js`, `tests/lint-engine-imports.test.js`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(embedding): probe() exercises the provider, memoizes readiness, coalesces concurrent calls`.

### Task 4: `embedding.serve(address | null)` real, `close()` integration

**Files:**
- Modify: `engine/providers/embedding-service.js` (add `validateIpcAddress`, `assertPrivateSocketDirectory`, `createEmbeddingServing`)
- Modify: `engine/create-engine.js` (build `embeddingServing` right after `scopedEmbeddingServer` at line 1423; pass it to `createResourceCloser` at 2923-2940; `embeddingService.serve` at 3410; expose `internals.embeddingServing`)
- Modify: `engine/lifecycle/close-resources.js` (new option `embeddingServer`, stopped first inside `localModelResources`, before `scopedEmbeddingServer`)
- Modify: `tests/llm-result-cache-lifecycle.test.js:258` (the pinned `createResourceCloser({ … })` regex gains `embeddingServer: embeddingServing,` after `scopedEmbeddingServer,`)
- Test: `tests/engine-embedding-serve.test.js`

**Interfaces:**
- Consumes: `createScopedEmbeddingIpcServer({ …, address, claim: false })`, `.identity`, `.tokenPath` (Task 2); `resolveScopedEmbeddingIpcPaths` (lib); `host.platform.ipcAddress`, `host.platform.isUnsafeLink`; `memoryOpError`.
- Produces:
  ```js
  /** Frozen copy { kind, address } or throws MemoryOpError("invalid-input"). */
  export function validateIpcAddress(address, { platform = process.platform } = {})
  /** Parent of a unix-socket path: exists, is a directory, !isUnsafeLink, and on POSIX (mode & 0o077) === 0; else invalid-input. */
  export function assertPrivateSocketDirectory(socketPath, { platform = process.platform, isUnsafeLink } = {})
  /** → { serve(address): Promise<EmbeddingServeResult>, current(): EmbeddingServeResult | null, shutdown(): Promise<void> } */
  export function createEmbeddingServing({ stateRoot, getEmbeddings, fingerprintId, defaultAddress /* () => IpcAddress */,
    hostOwned /* boolean */, isClient /* () => boolean */, isClosed /* () => boolean */, isUnsafeLink, logger,
    createServer = createScopedEmbeddingIpcServer, platform = process.platform })
  ```
- `validateIpcAddress` rules (messages fixed): not an object with exactly the string keys `kind`, `address` → "address must be an IpcAddress or null"; unknown `kind` → "unsupported IPC address kind"; `unix-socket`: `platform === "win32"` → "unix sockets are not used on Windows; use a named pipe", not absolute → "socket path must be absolute", `Buffer.byteLength > (darwin ? 103 : 107)` → "socket path exceeds the platform limit", contains `\0` → "invalid socket path"; `abstract-socket`: `platform !== "linux"` → "abstract sockets are Linux-only", not `/^\0[\x21-\x7e]{1,107}$/` → "invalid abstract socket name"; `named-pipe`: `platform !== "win32"` → "named pipes are Windows-only", not `/^\\\\\.\\pipe\\[A-Za-z0-9._-]{1,200}$/` → "invalid named pipe name".
- `serve(address)` semantics, all calls serialized through one promise chain:
  1. `isClosed()` → `storage` "engine is closed" (checked on entry and again inside the chain).
  2. `address === null` → stop the current server if any (`await server.shutdown()`), resolve `NOT_SERVING = Object.freeze({ address: null, tokenPath: null, identity: null, dispose() {} })`. This is a no-op, not a `conflict`, when `hostOwned` or `isClient()`.
  3. `hostOwned` (the OpenClaw lifecycle server exists, i.e. `scopedEmbeddingServer !== null`) → `conflict` "embedding IPC is owned by the host lifecycle"; `isClient()` (`getEmbeddings() instanceof ReloadSafeIpcScopedEmbeddingProvider`) → `conflict` "this engine is an embedding IPC client, not the owner".
  4. `address === undefined` → `defaultAddress()` = `host.platform.ipcAddress(resolveScopedEmbeddingIpcPaths(stateRoot).directory)`; then `validateIpcAddress`; `unix-socket` → `resolveScopedEmbeddingIpcPaths(stateRoot)` first (creates and secures the private directory, so the darwin default passes), then `assertPrivateSocketDirectory`.
  5. Serving the same `{kind, address}` → return the current result object; serving another → `conflict` "embedding IPC is already served on another address".
  6. `createServer({ stateRoot, embeddings: getEmbeddings(), fingerprintId, logger, address, claim: false })`, `await start()`; `error.code === "scoped_embedding_owner_already_active"` → `conflict` "embedding IPC address is in use"; any other throw (including the provider-identity checks) → `logger.warn("embedding.serve: start failed: …")` and `storage` "embedding IPC server failed to start".
  7. Result `Object.freeze({ address, tokenPath: server.tokenPath, identity: server.identity, dispose })`; `dispose()` enqueues a stop only while this result is still `current()`, logs a failed stop, returns `undefined`.
- Engine wiring: `embeddingServing` is built at line ~1424 so the closer (line 2923) can receive it; its callbacks read late-bound state — `getEmbeddings: () => internals.embeddings` (`internals` is declared at line 2972; the callbacks only run after construction), `isClosed: () => closing !== null`, `hostOwned: scopedEmbeddingServer !== null`, `fingerprintId: activeEmbeddingFingerprintId`, `stateRoot: baseDbPath`, `defaultAddress: () => host.platform.ipcAddress(resolveScopedEmbeddingIpcPaths(baseDbPath).directory)`, `isUnsafeLink: host.platform.isUnsafeLink`. `embeddingService.serve = async (address) => { assertMemoryOpen(); return embeddingServing.serve(address); }` (no `track`: `shutdown()` already waits for the serve chain).
- `shutdown()` (the closer's `embeddingServer.shutdown`): waits for the chain, stops the current server, is idempotent; `closeResources` runs it before `scopedEmbeddingServer.shutdown()` and `embeddings.shutdown()`. In-flight IPC requests are cut (their sockets destroyed), as the legacy shutdown does.

- [ ] **Step 1: Write the failing tests** (engine as in Task 3, stub embedder with `model: "fixture/e5"` and `dimensions: () => 384`; `sockDir = makeTempDir("e3-srv-")` chmod 0700):
  - (a) `serve({ kind: "unix-socket", address: join(sockDir, "e.sock") })` → `address` deep-equals the input, `tokenPath` ends with `join("control", "embedding-ipc", "owner.token")`, `identity.dimensions === 384`, `JSON.stringify(result)` does not contain the token file's content; a client `new IpcScopedEmbeddingProvider({ stateRoot: baseDbPath, ...result.identity, address: result.address })` → `embedQuery("x").length === 384`.
  - (b) idempotent: the same call again returns the identical object (`strictEqual`); `serve({ kind: "unix-socket", address: join(sockDir, "other.sock") })` → `conflict`; `serve(null)` → `{ address: null, tokenPath: null, identity: null }` and the socket and token files are gone; `serve(null)` again resolves the same.
  - (c) default address (`{ skip: process.platform !== "linux" }`): `serve()` → `address.kind === "abstract-socket"` and equals `host.platform.ipcAddress(join(baseDbPath, "control", "embedding-ipc"))`; round trip works.
  - (d) invalid input: `serve({ kind: "named-pipe", address: "\\\\.\\pipe\\x" })` on Linux → `invalid-input` "named pipes are Windows-only"; `serve({ kind: "unix-socket", address: "rel.sock" })` → "socket path must be absolute"; a 0755 directory → "socket directory must be private (0700)"; a symlinked directory → `invalid-input`; `serve("x")` → "address must be an IpcAddress or null". None of these leaves a token file.
  - (e) in use: a live foreign listener (`createServer().listen(path)` in the test process) at the address → `conflict` "embedding IPC address is in use" and the foreign socket file still exists; a dead stale socket file (copy the spawn-and-SIGKILL fixture `leaveStaleUnixSocket` from `tests/scoped-embedding-ipc.test.js`) → `serve` succeeds.
  - (f) `dispose()` of the result stops serving (poll until the socket file is gone, ≤ 1 s); a stale result's `dispose()` after a re-serve does not stop the new server.
  - (g) close: serve, `await engine.close()`, socket file and token gone; `serve(…)` after close → `storage`; a new engine on a fresh `baseDbPath` serves the same socket path at once.
  - (h) wrong credentials: a raw `createConnection(address)` frame with a random 64-hex token → `{ ok: false, error: { code: "scoped_embedding_auth_failed" } }`.
  - (i) unit, `createEmbeddingServing({ hostOwned: true, … })` with a `createServer` spy → `serve(addr)` → `conflict` "embedding IPC is owned by the host lifecycle", the spy was never called; `serve(null)` resolves `{ address: null, … }`. Same with `hostOwned: false, isClient: () => true` → "this engine is an embedding IPC client, not the owner". (Unit level on purpose: an engine with `coordinatesLocalModelGeneration` pulls in the local-model lifecycle.)
  - (j) unit: `validateIpcAddress({ kind: "named-pipe", address: "\\\\.\\pipe\\plur1bus-embedding-" + "a".repeat(32) }, { platform: "win32" })` passes; the same with `platform: "linux"` throws; `{ kind: "abstract-socket", … }` with `platform: "darwin"` throws; a 104-byte unix path with `platform: "darwin"` throws "socket path exceeds the platform limit".
- [ ] **Step 2:** Run the file. Expected: FAIL (`serve` returns a bare `{ dispose }`).
- [ ] **Step 3:** Implement, wire, extend `createResourceCloser` and update the pinned regex in `tests/llm-result-cache-lifecycle.test.js`.
- [ ] **Step 4:** Run the new file, `tests/engine-embedding-probe.test.js`, `tests/scoped-embedding-ipc.test.js`, `tests/llm-result-cache-lifecycle.test.js`, `tests/engine-close-inflight.test.js`, `tests/engine-contract.test.js`, `tests/adapter-register-gateway.test.js`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(embedding): serve(address | null) runs the scoped IPC server as the in-process owner; close() stops it`.

### Task 5: R11 — `admin.obsidian.detect` tolerates a vault that vanishes mid-check

**Files:**
- Modify: `engine/admin/obsidian.js` (`createObsidianOps` options line 116; `detect` lines 180-186)
- Test: `tests/engine-admin-obsidian.test.js`

**Interfaces:**
- `createObsidianOps` gains an optional test seam `isVaultConfirmed = isOwnedVaultConfirmed` (same call shape `({ baseDbPath, memoryCtx, vaultPath }) => boolean`), used by `detect` only.
- `detect` per candidate: `confirmed` goes through `guardVaultFs` as today; a `MemoryOpError` with `code === "not-found"` from it is caught **for that candidate only**: `logger.warn("admin.obsidian.detect: vault vanished during detect; reported unconfirmed")` and the entry becomes `{ path, isVault: isExistingDirectory(path) && isVaultDirectory(path), confirmed: false, source }`. Every other error (`storage`, `denied`, …) still fails the whole call. `prepare`/`confirm` are unchanged.

- [ ] **Step 1: Write the failing tests** (unit level, calling `createObsidianOps` directly with `opsContext = { resolve: async () => ({ agentId: "agent-r11", memoryCtx: { trust: "proved", userPrincipal: "user:v1:" + "0".repeat(64) }, workspaceDir: vaultA }) }`, three vault dirs from `makeVaultDir`, `getObsidianBridgeConfig: () => ({})`, `confirmationStore: new Map()`, a logger collecting warnings):
  - (a) `isVaultConfirmed` removes `vaultB` (`rmSync(…, { recursive: true })`) and throws an `ENOENT` error when asked for `vaultB`, returns `false` otherwise; `detect(p, a, { candidates: [vaultB, vaultC] })` resolves with three vaults: `vaultA` and `vaultC` `{ isVault: true, confirmed: false }`, `vaultB` `{ isVault: false, confirmed: false, source: "candidate" }`; one warning matches `/vanished during detect/`.
  - (b) `isVaultConfirmed` throws an `EACCES` error for `vaultB` while `vaultB` still exists → `detect` rejects `MemoryOpError` `storage` "vault confirmation failed" (unchanged).
- [ ] **Step 2:** Run `node --test tests/engine-admin-obsidian.test.js`. Expected: (a) FAIL (whole call `not-found`), (b) PASS.
- [ ] **Step 3:** Implement the seam and the per-candidate catch.
- [ ] **Step 4:** Run the file and every `tests/*obsidian*.test.js`. Expected: PASS.
- [ ] **Step 5:** Commit `fix(admin): obsidian detect reports a vault that vanished mid-check as unconfirmed instead of failing the call (R11)`.

### Task 6: `pushCriticalButtons` — engine behaviour pins

**Files:**
- Modify: `engine/jobs/internal-job-bodies.js` (comment at lines 283-287 only: name the typed capability `HostCapabilities.pushCriticalButtons` and its `null` meaning)
- Test: `tests/openclaw-default-llm-runtime.test.js` (next to the three stub-host cases at lines 838-909, reusing `runClassifyRecentOnStubHost`)

**Interfaces:**
- Consumes: the Task 1 type. Verified against the call site (`internal-job-bodies.js:294-299` passes `{ agentId: internalAgent, result, commandCtx, warning: classifierPartialFailureWarning(result) }`, `warning` is always a string) and the adapter (`adapter/openclaw/plugin.js:153-172` returns `null` until the click handler is ready, else `deliverCriticalButtonPush` → `{ sent, unsentTexts, reason? }`, `lib/critical-button-delivery.js:25-63`). No runtime change: these tests characterise existing behaviour and are expected to pass on first run; a failure is a real regression to report, not a test to bend.

- [ ] **Step 1: Write the tests:**
  - (a) `"engine classify-recent keeps the cron text when the capability returns null"`: capability `async (args) => { calls.push(args); return null; }` → output matches `/^🧠 PLUR1BUS hat eine Erinnerung als möglicherweise besonders wichtig erkannt\./` and `/\/plur1bus critical accept /`; `calls.length === 1`; `calls[0].agentId` is the test agent; `typeof calls[0].warning === "string"`; `"commandCtx" in calls[0]`.
  - (b) `"… keeps the cron text when nothing was sent"`: returns `{ sent: 0, unsentTexts: ["x"], reason: "no_telegram_target" }` → the same cron text (not `"x"`).
  - (c) `"… answers NO_REPLY when every card went out with buttons"`: returns `{ sent: 1, unsentTexts: [] }` → `output.text === "NO_REPLY"`.
  - (d) `"… sends only the unsent cards as text"`: returns `{ sent: 1, unsentTexts: ["Rest-Karte E3"] }` → `output.text` contains `"Rest-Karte E3"` and not the seeded memory text.
- [ ] **Step 2:** Run `node --test tests/openclaw-default-llm-runtime.test.js`. Expected: PASS (all seven stub-host cases).
- [ ] **Step 3:** Update the comment in `internal-job-bodies.js`.
- [ ] **Step 4:** Run `npm run lint`. Expected: PASS.
- [ ] **Step 5:** Commit `test(jobs): pin classify-recent's text fallback for a null or partial pushCriticalButtons result`.

### Task 7: Docs, changelog, full gate

**Files:**
- Modify: `docs/engine-api.md` (header line 3 and "amended eight times"; a **1.7.0** entry after the 1.6.0 entry at line 69; new section "EmbeddingService in 1.7.0: probe and serve" after "AdminOps in 1.6.0"; replace the placeholder bullet at lines 417-420; line 369 "full 1.7.0 `Engine` surface"; line 422 `contract: "1.7.0"`; line 428 list gains `embedding.probe`/`serve`; the Hosting rules gain one bullet on `HostCapabilities.pushCriticalButtons`)
- Modify: `CHANGELOG.md` (`[Unreleased]` → `### Hinzugefügt` / `### Geändert` / `### Behoben`, German)
- Test: full gate

- [ ] **Step 1:** Write the docs section: the probe semantics (fixed text + per-engine nonce, memoized success, `refresh`, coalescing, abort per caller, `error` vocabulary, the harness uses it as the warm-up and E4 reads `lastResult()`); the serve semantics (default address per platform: Linux abstract socket, macOS `<baseDbPath>/control/embedding-ipc/owner.sock`, Windows `\\.\pipe\plur1bus-embedding-<32 hex>`; no claim listener; token at `<baseDbPath>/control/embedding-ipc/owner.token`; idempotency, `null`, `dispose`, `close()`; the error table); the security model (private 0700 directory + 0600 socket on POSIX; an abstract socket and a named pipe have no filesystem permission, the `timingSafeEqual` token plus identity binding is the guard; the Windows user-SID pipe ACL and Windows system tests are PR-11); R11; the typed capability.
- [ ] **Step 2:** CHANGELOG bullets (German), e.g. „**`Engine.embedding.probe()`** prüft den Embedding-Provider einmal echt (Identität, Bereitschaft, gemerkt bei Erfolg) — Contract 1.7.0", „**`Engine.embedding.serve(address | null)`** startet den Scoped-Embedding-IPC-Server als In-Process-Owner ohne Loopback-Claim-Listener (ADR-001 C1); `null` = nur In-Process", „**`HostCapabilities.pushCriticalButtons`** ist typisiert", `### Behoben`: „`admin.obsidian.detect` scheitert nicht mehr als Ganzes, wenn ein Vault während der Prüfung verschwindet (R11)", `### Geändert`: „`createScopedEmbeddingIpcServer` nimmt optional `address`/`claim`, der Client optional `address`; der OpenClaw-Pfad bleibt unverändert".
- [ ] **Step 3:** `grep -rn "placeholder\|no-op \`Disposable\`" docs/engine-api.md` returns nothing about `probe`/`serve`; `grep -rn '"1\.6\.0"' engine types tests docs` returns only historical annotations.
- [ ] **Step 4:** Full gate: `npm run lint && npm test` (590000 ms timeout) and `TZ=UTC node --test tests/golden-prefix.test.js`. Expected: all green, golden 11/11.
- [ ] **Step 5:** Commit `docs: E3 — contract 1.7.0 (embedding probe/serve, detect tolerance, pushCriticalButtons) in CHANGELOG and contract docs`.
- [ ] **Step 6:** Hand over: bundle `origin/main..feat/e3-embedding-service` for the owner to push via the Mac and open the PR "E3: embedding probe/serve real, detect per-vault tolerance, typed pushCriticalButtons (contract 1.7.0)" against `main`; the owner merges.

---

## Self-review notes

- **Spec coverage:** E3 row — `probe()` real (Task 3), `serve()` real for the in-process owner with `IpcAddress | null` (Tasks 2, 4); ADR-001 C1 no claim listener on the engine-served path (Task 2 `claim: false`, Task 4 always passes it); ADR-006 envelope unchanged, Windows pipe name via `ipcAddress` (Task 4 default, Task 7 docs); §5 models warming → `probe` is the warm-up primitive, `lastResult()` for E4 (Task 3). R11 (Task 5). Typed `pushCriticalButtons` with conformance pin and engine tests (Tasks 1, 6). Contract 1.7.0 sites, docs, German CHANGELOG (Tasks 1, 7). Deferred with a reason: pipe ACL and Windows system tests (PR-11), `status()` readiness (E4), harness RPC exposure and the warm-up call (2a-H2).
- **Type consistency:** `EmbeddingServeResult { address, tokenPath, identity, dispose }` is built only in Task 4 from Task 2's `server.identity`/`server.tokenPath`; `EmbeddingProbeResult` fields match between Task 1's type and Task 3's algorithm; `createEmbeddingServing`'s `shutdown()` is what the closer receives as `embeddingServer`.
- **Order:** 1 → 2 → 3 → 4 → 5 → 6 → 7. Tasks 5 and 6 are independent of 2-4 but share the gate; keep them sequential.
