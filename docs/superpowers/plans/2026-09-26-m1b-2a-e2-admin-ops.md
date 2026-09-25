# M1b-2a engine work: E2 (admin ops, shared copies, change proposals). Implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every stubbed `Engine.admin` member real without an OpenClaw runtime (`obsidian.*` with explicit paths, `migrate` over a store schema marker, `share`/`forget` as aliases of `Engine.memory`), give shared copies their D31 rules (the sharer retracts or refreshes, recipients propose a change, the sharer accepts or rejects), and make `Engine.close()` wait for in-flight memory operations. Contract **1.6.0**.

**Architecture:** Everything builds on E1's `engine/memory-ops/*`: one `createMemoryOpsContext` resolves `Principal` + `AgentContext` into a memory request context with the fail-closed guards, and every new member goes through it. Shared copies are single rows in the workspace or user pool (`lib/shared-memory.js` `storeSharedMemory`: `sourceAgentId`, `sourceMemoryId`, `storedBy` = the sharer), so "retract" is an archive-first soft delete of that row and "refresh" is correct-original + retract + re-share. Change proposals are small JSON files under `<dirname(baseDbPath)>/_proposals/<sharerAgentId>/`, written atomically, and they never modify memory until the sharer accepts. Obsidian ops wrap the existing `lib/obsidian-vault-confirmation-flow.js` / `lib/obsidian-vault-authority.js` (nonce + receipt) with explicit paths instead of `host.runtime`. The store schema marker is `<baseDbPath>/_schema.json`.

**Tech stack:** engine repo `Cyb3rb1ade/openclaw-plur1bus-memory` (ESM JavaScript, `types/engine.d.ts` + `types/engine.conformance.ts`, `node --test`, LanceDB). Node ≥ 24.16 (`/home/claude/.node24/bin` in the cloud session). Branch `feat/e2-admin-ops` from `main` at `215193e5` (merge of #188, E1).

**Spec:** `docs/superpowers/specs/2026-09-24-m1b-2a-core-daemon-cli-design.md` — §2 **D31** (shared copies: sharer retracts, recipients propose back), D24 (one human across channels; the "same person" extension of D31 waits for `/link` in 2a-H2 and is out of scope here), D28 (one engine owner per store), §7 row **E2** ("`admin.*` without an OpenClaw runtime: `share`/`forget` delegate to E1; `obsidian`/`migrate` take explicit paths"), ADR-016 §6 (engine events are mapped by the core; the engine only has to emit them). Owner rulings 2026-09-25/26: Obsidian vault is per agent (`obsidianBridge.workspaces[]` already carries `agentId` + `path`), config paths may be `~`- or home-relative and the host/engine resolves them, `admin.migrate` is variant (a): a minimal store schema version marker.

**Exploration:** `/tmp/claude-0/explore-e2.md` (cloud session; verbatim quotes of every function this plan names, with line numbers as of `215193e5`). Line numbers below come from it; re-grep before editing.

## 2a-E sequence (the frame this plan sits in)

| Step | Branch / PR | Contract | Status |
|---|---|---|---|
| E0 | merge `main` into `feat/engine-api-m1b1` | 1.4.1 | merged `04067765` (#186) |
| E1 | `feat/e1-memory-ops` | 1.5.0 | merged `215193e5` (#188) |
| **E2** | `feat/e2-admin-ops` | **1.6.0** | **this plan** |
| E3 | `embedding.probe()`/`serve()` real | 1.7.0 | after E2 |
| E4 … E7, P | see the E1 plan's table | | |

The harness side (serving `memory.propose`/`memory.proposals.*`, `admin.obsidian.*`, `admin.migrate` over RPC; `/memory proposals` in the command layer, D21) is 2a-H2's work.

## Global constraints

- Contract amendment policy (`types/engine.d.ts:23-31`): every observable shape change bumps `ContractVersion`; `ContractVersion`, `types/engine.conformance.ts` and both adapters move together in one PR. E2 bumps once, to `"1.6.0"`, in Task 1; the literal appears in `types/engine.d.ts` (type + header changelog), `types/engine.conformance.ts`, `engine/create-engine.js` (×2: `contract:` and `status()`), `tests/engine-contract.test.js` (×2) — grep `"1.5.0"` repo-wide and move every hit.
- Engine gate per task: `npm run lint && npm test` (~9 min; run with a 590 s timeout) plus `TZ=UTC node --test tests/golden-prefix.test.js` (golden 9/9). The base is fully green; a failure is yours until proven otherwise.
- Conventions from E1 (`.superpowers/sdd/…/conventions.md`): (1) every new `engine/**/*.js` file is registered in `tests/helpers/runtime-sources.js` `ENGINE_PATHS` **and** `scripts/lib/deploy-integrity.mjs` `DEPLOY_FILES` (explicit lists; `readRuntimeSources()` throws on an unlisted file); (2) tests use `makeTempDir` from `tests/helpers/temp-dir.js`, never `mkdtempSync`; (3) never `git stash`; (4) destructive-op tests need a real writable `workspaceDir` and a `baseDbPath` nested under the same temp root (`opsContext.resolve` refuses a destructive op without a workspace).
- `engine/**` never imports `openclaw`, `lib/host-services.js`, `lib/runtime-shutdown.js`, `lib/providers/openclaw-memory-embedding-adapters.js` or `lib/setup/*-plugin-runtime.js`, never reads a bare `api`, never reads `process.env.OPENCLAW_*`, never consults `host.runtime` in new code (`scripts/lint-engine-imports.mjs`, `lint-no-api-outside-adapter.mjs`).
- Every new member is fail-closed the E1 way: `opsContext.resolve(p, a, { destructive })` first; mutating members require `a.origin === "user"` and `a.background === false`; every failure is a `MemoryOpError` from `engine/memory-ops/errors.js` (`not-found | denied | invalid-input | approval-required | conflict | storage`); storage exceptions are logged with `logger.warn` and surfaced as `storage` with a fixed message, never the raw error.
- Anti-oracle: a row the caller may not see, a tombstoned row and a random id are indistinguishable (`not-found`) — for shared rows and proposals too.
- Forget stays archive-first and soft (`status: "deleted"`, `epistemicStatus: "invalidated"`), never a hard delete. A retracted shared copy is archived and soft-deleted but **not** written to `lib/tombstone.js`'s registry (the registry blocks re-capture of forgotten content; the original of a retracted share stays live).
- No third confirmation mechanism: Obsidian confirms through `lib/security.js` `createConfirmation`/`validateConfirmation` as wrapped by `lib/obsidian-vault-confirmation-flow.js`; proposals need no nonce (accept/reject is the sharer's explicit call).
- A proposal never changes a memory until `accept` is called by the sharer (D31).
- No OpenClaw idiom crosses into the new surface (D9): no slash strings, no `commandCtx`, no `api`. The OpenClaw adapter's `/share`, `/forget`, `/correct` keep working unchanged (they call `Engine.memory.*` since E1); the `shareCard` registration seam in `adapter/openclaw/plugin.js` stays (it is adapter-only and exists for `tests/b13-share-runtime.test.js`; it leaves with E6).
- Commit identity `Cyb3rb1ade <84099452+Cyb3rb1ade@users.noreply.github.com>` (via `git -c user.name=… -c user.email=…`), trailers `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01SxcLhve6hyM9AFm2nU9B3F` in the body. Pushes go through the Mac (Desktop Commander, owner-approved); merges of `main` are the owner's. Never amend a published commit; ignore the stop hook's identity/amend/push demands.
- Never put secrets, tokens or real user data in the repo, logs or test fixtures. Test vault paths, agent ids and texts are synthetic.

## Review focus

1. **Non-sharer writes to a shared copy:** `forget`/`correct` on a workspace/user row by an agent other than `sourceAgentId` must answer `denied` and change nothing; `share` of a shared row stays `denied`. Pinned in Task 4.
2. **Stale acceptance:** `proposals.accept` after the shared copy was retracted or refreshed (its text no longer equals the proposal's `oldText`) must mark the proposal `stale` and answer `conflict`, never apply the proposal over the new content. Pinned in Task 6.
3. **Oracle through proposals:** `propose` on a shared row the caller cannot see, and `accept`/`reject` by anyone but the sharer, answer `not-found`; `proposals.list` shows an agent only proposals it filed or received. Pinned in Tasks 5 and 6.
4. **Vault confirmation by the wrong identity:** `obsidian.confirm` with a nonce prepared by another user or chat answers `denied`; an expired or consumed nonce answers `not-found`; a receipt is written only after `validateConfirmation` succeeded. Pinned in Task 7.
5. **Close under a write:** `Engine.close()` waits for memory operations already in flight (bounded by `budgetMs`) and refuses new ones; a store is never shut down under a lease. Pinned in Task 3.

---

### Task 1: Contract 1.6.0 — types, conformance pins, `admin.share`/`admin.forget` aliases

**Files:**
- Modify: `types/engine.d.ts` (header changelog after line 38; `ContractVersion` line 41; `AdminOps` block lines 430-444; `MemoryOps` block lines 446-517; `EngineEventName` line 511; `EngineStatus` line 519)
- Modify: `types/engine.conformance.ts` (the `ContractVersion` pin, line 105; new pins after the MemoryOps block, lines 107-121)
- Modify: `engine/create-engine.js` (`contract: "1.5.0"` ×2 near lines 3396 and 3405; `adminOps` lines 3358-3384: `share`/`forget` become aliases)
- Modify: `tests/engine-contract.test.js` (`"1.5.0"` lines 47 and 379-380; the `admin.share` rejection at line 352)
- Modify: `docs/engine-api.md` — only the contract-version mention in the header, the prose sections come in Task 8

**Interfaces (produces; later tasks implement exactly this):**

```ts
export type ContractVersion = "1.6.0";

// ---- AdminOps ----
/** @deprecated 1.6.0: `ShareResult`/`ForgetResult` are the MemoryOps result types; removed with 2.0 (E6). */
export type ShareResult = MemoryShareResult;
export type ForgetResult = MemoryForgetResult;
/** `applied` is false when `from === to`. Both are decimal strings ("0" = a store written before any marker existed). */
export interface MigrationResult { from: SchemaVersion; to: SchemaVersion; applied: boolean }

export interface ObsidianVaultCandidate {
  /** Absolute, normalised path. Input may be `~/…` or home-relative; the engine expands it. */
  path: string;
  /** `.obsidian/workspace.json` or `.obsidian/app.json` exists. */
  isVault: boolean;
  /** A confirmation receipt for this agent, workspace and vault exists (lib/obsidian-vault-authority.js). */
  confirmed: boolean;
  source: "config" | "workspace" | "candidate";
}
export interface ObsidianDetectResult { agentId: AgentId; vaults: ObsidianVaultCandidate[] }
export interface ObsidianPrepareResult { nonce: string; expiresAt: number; vaultPath: string; vaultDigest: string }
export interface ObsidianConfirmResult { confirmed: true; vaultPath: string; vaultDigest: string; alreadyConfirmed: boolean }

/**
 * Host-neutral Obsidian setup: explicit paths, no host runtime. `prepare` and `confirm` are
 * user-originated (`a.origin === "user"`, `a.background === false`) and need a proved principal
 * with a user; the nonce expires after 10 minutes and is consumed by the first `confirm`.
 * Every member rejects with MemoryOpError (`not-found`, `denied`, `invalid-input`, `storage`).
 */
export interface ObsidianOps {
  detect(p: Principal, a: AgentContext, opts?: { candidates?: string[] }): Promise<ObsidianDetectResult>;
  prepare(vaultPath: string, p: Principal, a: AgentContext): Promise<ObsidianPrepareResult>;
  confirm(nonce: string, p: Principal, a: AgentContext): Promise<ObsidianConfirmResult>;
}

export interface AdminOps {
  /** @deprecated 1.6.0: alias of `Engine.memory.share`; removed with 2.0 (E6). */
  share(id: string, target: "workspace" | "user", p: Principal, a: AgentContext, opts?: { allowSensitive?: boolean }): Promise<MemoryShareResult>;
  /** @deprecated 1.6.0: alias of `Engine.memory.forget`; removed with 2.0 (E6). */
  forget(id: string, p: Principal, a: AgentContext): Promise<MemoryForgetResult>;
  reembedding: { /* unchanged */ };
  workspacePolicy: { /* unchanged */ };
  obsidian: ObsidianOps;
  /** Store schema migration (E2, variant a). Rejects with MemoryOpError: `conflict` when `from` is not the store's
   *  current version, `invalid-input` for an unknown or downgrading `to`, `storage` when the marker is unreadable. */
  migrate(from: SchemaVersion, to: SchemaVersion): Promise<MigrationResult>;
}

// ---- MemoryOps additions ----
export interface MemoryCard {
  /* existing fields unchanged */
  /** 1.6.0, only on workspace/user copies: the sharing agent and its original card. */
  sharedBy?: AgentId;
  sourceId?: string;
}

export type MemoryProposalStatus = "pending" | "accepted" | "rejected" | "stale";
export interface MemoryProposal {
  id: string;
  /** The shared copy the proposal was filed against and the sharer's original behind it. */
  sharedId: string;
  sourceId: string;
  target: "workspace" | "user";
  sharerAgentId: AgentId;
  proposerAgentId: AgentId;
  oldText: string;
  newText: string;
  note: string | null;
  createdAt: number;
  status: MemoryProposalStatus;
  resolvedAt: number | null;
  /** accepted: the id of the refreshed shared copy. */
  resultId: string | null;
  resolutionNote: string | null;
}
export interface MemoryProposeResult { proposalId: string; sharedId: string; sharerAgentId: AgentId }
export interface MemoryProposalListQuery { status?: MemoryProposalStatus; /** Default 20, maximum 100. */ limit?: number }
export interface MemoryProposalListResult {
  agentId: AgentId;
  /** Proposals the agent filed or received, newest first. */
  items: MemoryProposal[];
  truncated: boolean;
  /** Proposal files that could not be parsed; never silently dropped. */
  unreadable: number;
}
/** `id` is the refreshed shared copy, `sourceId` the corrected original (both new ids). */
export interface MemoryProposalAcceptResult { proposalId: string; id: string; sourceId: string }
export interface MemoryProposalRejectResult { proposalId: string; status: "rejected" }

export interface MemoryProposalEvent {
  proposalId: string;
  status: MemoryProposalStatus;
  sharerAgentId: AgentId;
  proposerAgentId: AgentId;
  sharedId: string;
}
```

The `MemoryOps` doc comment (line 501-507) is replaced by:

```ts
/**
 * Every member rejects with MemoryOpError `storage` ("engine is closed") after `Engine.close()`.
 * `list` and `show` read the agent-private pool plus the workspace and user pools the principal can reach.
 * `forget`, `correct` and `share` act on the caller's own agent-private cards. On a shared (workspace/user)
 * copy (D31): `forget` by the sharing agent retracts the copy (archive-first, soft delete; `tombstoneId` is
 * null because the original stays live); `correct` by the sharing agent refreshes it (corrects the original,
 * retracts the old copy, shares the new one; the result id is the new copy); any other agent answers `denied`
 * and files `propose` instead; `share` of a copy is always `denied`. Proposals never change a memory until
 * the sharer calls `proposals.accept`.
 */
export interface MemoryOps {
  /* list, show, forget, correct, share, state unchanged */
  /** File a change proposal against a shared copy the caller can read but does not own (`a.origin === "user"`). */
  propose(sharedId: string, newText: string, p: Principal, a: AgentContext, opts?: { note?: string }): Promise<MemoryProposeResult>;
  proposals: {
    list(q: MemoryProposalListQuery, p: Principal, a: AgentContext): Promise<MemoryProposalListResult>;
    /** Sharer only (anyone else: `not-found`). Refreshes the copy with the proposal's text. */
    accept(proposalId: string, p: Principal, a: AgentContext): Promise<MemoryProposalAcceptResult>;
    reject(proposalId: string, p: Principal, a: AgentContext, opts?: { note?: string }): Promise<MemoryProposalRejectResult>;
  };
}
```

`EngineEventName` gains `| "memory.proposal"` (payload `MemoryProposalEvent`, emitted on create, accept, reject). `EngineStatus` gains `storeSchema: { current: SchemaVersion | null; expected: SchemaVersion }` (`current` null = marker present but unreadable).

Header changelog line to add after the 1.5.0 line: `1.6.0: AdminOps.share/forget alias Engine.memory (deprecated); ObsidianOps with explicit paths; migrate over a store schema marker; MemoryOps.propose/proposals (D31); MemoryCard.sharedBy/sourceId; "memory.proposal" event; EngineStatus.storeSchema (E2).`

- [ ] **Step 1:** Edit `types/engine.d.ts` exactly as above (keep every existing field; add, never reorder existing members). Bump `ContractVersion`.
- [ ] **Step 2:** In `types/engine.conformance.ts`: bump the `ContractVersion` pin; add, in the MemoryOps style:
  - `assertTrue<Exact<Engine["admin"], AdminOps>>();`
  - `assertTrue<Exact<AdminOps["share"], MemoryOps["share"]>>();` and the same for `forget`.
  - `assertTrue<Exact<AdminOps["obsidian"], ObsidianOps>>();` plus one `Exact<ObsidianOps["detect"|"prepare"|"confirm"], (…) => Promise<…>>` pin each with the parameter lists above.
  - `assertTrue<Exact<AdminOps["migrate"], (from: SchemaVersion, to: SchemaVersion) => Promise<MigrationResult>>>();`
  - `assertTrue<Exact<MemoryOps["propose"], (sharedId: string, newText: string, p: Principal, a: AgentContext, opts?: { note?: string }) => Promise<MemoryProposeResult>>>();` and pins for `proposals.list/accept/reject`.
  - `assertTrue<Exact<MemoryProposalStatus, "pending" | "accepted" | "rejected" | "stale">>();`
  - `assertTrue<Exact<Extract<EngineEventName, \`memory.${string}\`>, "memory.proposal">>();`
  - `assertTrue<Exact<EngineStatus["storeSchema"], { current: SchemaVersion | null; expected: SchemaVersion }>>();`
- [ ] **Step 3:** `engine/create-engine.js`: `adminOps.share = (...args) => engine.memory.share(...args)` and `forget` likewise — `engine` is the object literal assembled later, so define the aliases as thunks that read `internals.memoryWrite` the way `engine.memory` does (`async (id, target, p, a, opts) => { assertMemoryOpen(); return internals.memoryWrite.share(id, target, p, a, opts); }`), so the alias and the original are the same code path. Bump both `"1.5.0"` literals. Leave `obsidian.*` and `migrate` as `notInM1b1` for now (Tasks 2 and 7 replace them); `engine.memory.propose`/`proposals` are added by Tasks 5-6.
- [ ] **Step 4:** `tests/engine-contract.test.js`: bump both version assertions; replace line 352 with `await assert.rejects(() => engine.admin.forget(randomUUID(), provedPrincipal, userAgent), (e) => e.code === "not-found")` where `userAgent = { origin: "user", background: false }` (add a `propose`-shaped assertion later in Task 5). Add `assert.equal(typeof engine.admin.share, "function")`.
- [ ] **Step 5:** Run `npm run lint` (includes the typecheck) and `node --test tests/engine-contract.test.js`. Expected: PASS.
- [ ] **Step 6:** Commit `feat(contract): 1.6.0 — AdminOps aliases, ObsidianOps, migrate, MemoryOps proposals (types and pins)`.

### Task 2: Store schema marker and `admin.migrate`

**Files:**
- Create: `engine/store/schema-version.js`
- Modify: `engine/create-engine.js` (after the obsidian/provider-migration blocks that decide "empty legacy install", ~line 300; `status()` ~line 3405; `adminOps.migrate` line 3383)
- Modify: `tests/helpers/runtime-sources.js` (`ENGINE_PATHS.storeSchemaVersion`), `scripts/lib/deploy-integrity.mjs` (`DEPLOY_FILES`)
- Test: `tests/engine-store-schema.test.js`

**Interfaces:**
- Produces:
  ```js
  export const STORE_SCHEMA_VERSION = "1";          // the version this engine writes
  export const LEGACY_STORE_SCHEMA_VERSION = "0";   // a store with no marker
  export function schemaMarkerPath(baseDbPath)      // join(baseDbPath, "_schema.json")
  /** "0" when the marker is missing; null when present but unparsable or not { schemaVersion: /^\d+$/ }. */
  export function readStoreSchemaVersion(baseDbPath, { logger } = {})
  /** Atomic (tmp + rename). Creates baseDbPath. Payload { schemaVersion, writtenAt: ISO, engineVersion }. */
  export function writeStoreSchemaMarker(baseDbPath, version, { engineVersion, clock = Date.now })
  export function createStoreMigrator({ baseDbPath, logger, engineVersion, clock = Date.now })
    // → { current(): SchemaVersion | null, migrate(from, to): Promise<MigrationResult> }
  ```
  Migration steps live in the same file as `STORE_MIGRATIONS = Object.freeze({ "0->1": async () => {} })` with a comment: version 1 records the column set of contract 1.5.0 (`ensureSharedMemoryColumns`, `chunkGroupId` seed row); nothing to transform.
- `migrate(from, to)` semantics: both must match `/^\d+$/` (else `invalid-input`); `current()` null → `storage` "store schema marker unreadable"; `from !== current` → `conflict` "store is at schema <current>"; `to < from` → `invalid-input` "downgrade is not supported"; `to > STORE_SCHEMA_VERSION` → `invalid-input` "unknown schema version"; `from === to` → `{ from, to, applied: false }`; otherwise run every step `"n->n+1"` in order (a missing step → `invalid-input`), write the marker at `to`, return `applied: true`.
- Engine wiring: right after the "empty legacy install" checks, if `baseDbPath` does not exist or is an empty directory, write the marker at `STORE_SCHEMA_VERSION` (a fresh store starts current); an existing non-empty store without a marker stays `"0"` until the owner migrates. `status()` adds `storeSchema: { current: migrator.current(), expected: STORE_SCHEMA_VERSION }`. `adminOps.migrate = (from, to) => migrator.migrate(from, to)` (Task 3 wraps it in `track`). `engineVersion` comes from `package.json` the way the engine already reads its version (grep `version` in create-engine.js; if nothing reads it, read `package.json` once with `readFileSync` + `JSON.parse` relative to `import.meta.url`).

- [ ] **Step 1: Write the failing tests** in `tests/engine-store-schema.test.js` (use `createStubHost({ stateDir })` and `createEngine` as `tests/engine-contract.test.js` does; `baseDbPath` under `makeTempDir`):
  - (a) fresh `baseDbPath` (non-existent) → after `createEngine`, `_schema.json` exists, `JSON.parse(...).schemaVersion === "1"`, `(await engine.status()).storeSchema` deep-equals `{ current: "1", expected: "1" }`.
  - (b) pre-existing `baseDbPath` containing a dummy file (a legacy store) → `storeSchema.current === "0"`; `admin.migrate("0", "1")` → `{ from: "0", to: "1", applied: true }` and the marker now reads "1"; `migrate("0", "1")` again → rejects `conflict`; `migrate("1", "1")` → `applied: false`; `migrate("1", "0")` → `invalid-input`; `migrate("1", "2")` → `invalid-input`; `migrate("x", "1")` → `invalid-input`.
  - (c) marker file containing `not json` → `storeSchema.current === null`; `migrate("0", "1")` → rejects `storage`.
  - (d) unit: `writeStoreSchemaMarker` leaves no `.tmp` file behind and `readStoreSchemaVersion` returns the written version.
- [ ] **Step 2:** Run `node --test tests/engine-store-schema.test.js`. Expected: FAIL (module missing / `not available in M1b-1`).
- [ ] **Step 3:** Implement `engine/store/schema-version.js` and the wiring; register the file in `ENGINE_PATHS` and `DEPLOY_FILES`.
- [ ] **Step 4:** Run the new test file, `tests/engine-contract.test.js`, `tests/deploy-integrity*.test.js` (whatever consumes `DEPLOY_FILES`; find it with `grep -l deploy-integrity tests/*.test.js`) and the golden test. Expected: PASS, golden 9/9 (a fresh marker file must not change recall output).
- [ ] **Step 5:** Commit `feat(store): schema version marker and admin.migrate (variant a)`.

### Task 3: In-flight tracking — `Engine.close()` waits for memory and admin operations

**Files:**
- Modify: `engine/memory-ops/context.js` (`createMemoryOpsContext` gains `activeOperations`, `track`, `drain`)
- Modify: `engine/create-engine.js` (`closeEngine` lines 2891-2911; the `engine.memory` wrappers 3513-3523; the `adminOps` `migrate` thunk)
- Test: `tests/engine-close-inflight.test.js`

**Interfaces:**
- Produces on the ops context:
  ```js
  activeOperations: Set<Promise>   // exposed for tests
  track(run: () => Promise<T>): Promise<T>   // adds the promise while pending; never causes an unhandled rejection
  drain(): Promise<void>                      // Promise.allSettled([...activeOperations])
  ```
- `closeEngine(budgetMs)`: the ordered branch becomes `drain()` then `internals.closeResources()`, still inside the existing `Promise.race` against the budget timer, still never rejecting. `isClosed()` is already `closing != null`, so an operation arriving after `close()` began is refused at `resolve()` while operations already running are awaited.
- Every `engine.memory.*` wrapper (and, once they exist, `engine.memory.propose`, `engine.memory.proposals.*`, `engine.admin.obsidian.*`, `engine.admin.migrate`, the `admin.share`/`forget` aliases) becomes `async (...) => { assertMemoryOpen(); return memoryOpsContext.track(() => internals.memoryWrite.forget(id, p, a)); }`. Tasks 5-7 use the same shape for the members they add.

- [ ] **Step 1: Write the failing tests** in `tests/engine-close-inflight.test.js`. Build the engine with the flat-embedder seam the E1 tests use (`PLUR1BUS_ALLOW_TEST_INTERNALS=1`, `internals: { embeddings }`), where `embeddings.embed` is a stub that resolves immediately for capture and returns a **deferred** promise once a flag `holdNext` is set. Cases:
  - (a) capture one fact (await `done`), set `holdNext`, start `const op = engine.memory.correct(id, "changed", p, userAgent)` (do not await), start `const closed = engine.close({ budgetMs: 5000 })`; after 100 ms assert neither settled (`Promise.race` against a timer); resolve the deferred embed; then `await closed` resolves and `op` rejects with `code === "storage"` and message `engine is closed` (the mutate-time `assertOpen` in write.js refuses it — that is E1's I2 rule; the point is that `close()` waited).
  - (b) same setup with an embed that never resolves and `budgetMs: 300` → `close()` resolves within ~1 s and the stub logger saw a `warn` containing `close exceeded`.
  - (c) `memoryOpsContext.activeOperations.size === 0` after (a) settles (read it through `internalsOf(engine).memoryOpsContext`).
  - (d) a call started after `close()` (`engine.memory.show(id, p, userAgent)`) rejects with `storage` immediately, without waiting for the budget.
- [ ] **Step 2:** Run the file. Expected: FAIL (`track` is not a function).
- [ ] **Step 3:** Implement `track`/`drain`, wrap the wrappers, change `closeEngine`.
- [ ] **Step 4:** Run the new file, `tests/engine-contract.test.js`, `tests/engine-memory-ops*.test.js` (all E1 files). Expected: PASS.
- [ ] **Step 5:** Commit `feat(engine): close() drains in-flight memory and admin operations within the budget`.

### Task 4: Shared copies — `sharedBy`/`sourceId` on cards, retract and refresh by the sharer

**Files:**
- Create: `engine/memory-ops/shared.js`
- Modify: `engine/memory-ops/write.js` (`refuseMissingPrivate` lines 64-81 and its three call sites; `createMemoryWrite`'s return)
- Modify: `engine/memory-ops/read.js` (`toMemoryCard` lines 27-40)
- Modify: `lib/telegram-commands/memory-edit.js` only if `archiveCard` is not exported (export it; no behaviour change)
- Modify: `tests/helpers/runtime-sources.js`, `scripts/lib/deploy-integrity.mjs`
- Test: `tests/engine-memory-shared-ops.test.js`

**Interfaces:**
- Consumes: `findMemoryAcrossAccessPools` (`lib/telegram-commands/memory-query.js:340`, returns `{ card, sourceKind } | null`, card carries `scope`, `sourceAgentId`, `sourceMemoryId`, `workspaceId`, `ownerUserId`, `text`), `shareCard` (write.js line 12 import), `applyCorrection` (write.js:95, internal), `archiveCard` (memory-edit.js:199), `appendDestructiveOpLog(workspaceDir, entry)` (`lib/sql-safety.js:192`), `isRecallEntryLive` (`lib/recall-pipeline.js:177`), `opsContext.assertOpen`.
- Produces in `engine/memory-ops/shared.js`:
  ```js
  export function isSharer(card, agentId)            // card.sourceAgentId === agentId
  export function createSharedMemoryOps({ opsContext, pool, sharedMemoryPool, memoryDbAdapter, embeddings, applyCorrection, logger })
    // → {
    //   findSharedRow({ agentId, memoryCtx, id })                           → { card, sourceKind } | null  (sourceKinds ["workspace","user"], live only)
    //   retractSharedRow({ agentId, memoryCtx, workspaceDir, archiveDir, card, reason })
    //                                                                        → { id, archived: true, tombstoneId: null, alreadyForgotten: boolean }
    //   refreshShare({ agentId, memoryCtx, workspaceDir, archiveDir, card, newText, reason })
    //                                                                        → { sourceId, sharedId, retractedId }
    // }
  ```
  `createMemoryWrite` returns `{ forget, correct, share, shared }` where `shared` is the object above (Task 6 consumes `shared.findSharedRow` and `shared.refreshShare`).
- Behaviour:
  - `retractSharedRow`: `archiveCard(card, agentId, archiveDir)` first; then lease the pool the row lives in (`card.scope === "workspace"` → `sharedMemoryPool.withWorkspaceDb(memoryCtx, …)`, `"user"` → `withUserDb`); inside the lease call `opsContext.assertOpen()`, re-read the row by id (`db.table.query().where(\`id = "${safe}"\`)`), `status === "deleted"` → `alreadyForgotten: true` without writing; otherwise `db.table.update({ where, values: { status: "deleted", epistemicStatus: "invalidated" } })` (the same patch `tombstoneCard` writes, `lib/db-adapter.js:776-778`); then `appendDestructiveOpLog(workspaceDir, { op: "share-retract", id, scope, sourceMemoryId, actor, at })` — a `false` return makes the call fail `storage` ("audit failed") the way `forgetCard` does. No `lib/tombstone.js` write (Global constraints).
  - `refreshShare`: load the original `card.sourceMemoryId` from the sharer's private pool (`memoryDbAdapter.getCard(agentId, sourceMemoryId, { ctx: memoryCtx })`); missing or not live → `conflict` "the original of this shared copy is no longer live; retract it instead"; `applyCorrection({ agentId, memoryCtx, workspaceDir, id: sourceMemoryId, newContent: newText, card: original })` → `newId`; `retractSharedRow` on the old copy; `shareCard(pool, sharedMemoryPool, embeddings, agentId, newId, { targetScope: card.scope, allowSensitiveShare: true, ctx: memoryCtx, logger })` (the content was already shared with approval; the sharer's refresh renews it) → `!ok` → `storage` "share refresh failed after correcting the original" (logged with the old and new ids); return `{ sourceId: newId, sharedId, retractedId: card.id }`.
  - `write.js`: replace `refuseMissingPrivate(op, …)` by `const shared = await sharedOps.findSharedRow(…)`; null → `not-found` (unchanged message). Then per op: `forget` → sharer ? `retractSharedRow` : `denied` "only the sharing agent can retract a shared copy"; `correct` → sharer ? `refreshShare` and return `{ id: sharedId, archived: true }` : `denied` "shared copies are changed through a proposal (memory.propose)"; `share` → `denied` "a shared copy cannot be shared again". The destructive guard (`origin user`, `background false`, workspaceDir) is already applied by `resolve`.
  - `read.js` `toMemoryCard`: when `scope !== "agent-private"` and `card.sourceAgentId`, set `sharedBy: card.sourceAgentId` and `sourceId: card.sourceMemoryId || undefined`.

- [ ] **Step 1: Write the failing tests** in `tests/engine-memory-shared-ops.test.js`. Copy the two-agent workspace setup from E1's share test (`grep -l "memory.share" tests/engine-memory-ops*.test.js`): agents `anna` (sharer) and `bernd` in the same workspace principal, `carol` in another workspace, all `trust: "proved"`, `userAgent = { origin: "user", background: false }`, `cronAgent = { origin: "cron", background: true }`; `engine.duplicateThreshold: 1.01` for distinct facts. Cases:
  - (a) anna captures `F`, `share(F, "workspace")` → `sharedId`; `bernd.show(sharedId)` → `scope: "workspace"`, `sharedBy: "anna"`, `sourceId: F`; `anna.show(F)` has no `sharedBy`.
  - (b) `bernd.forget(sharedId)` → `denied`; `bernd.correct(sharedId, "x")` → `denied`; `bernd.share(sharedId, "workspace")` → `denied`; `carol.show(sharedId)` → `not-found`; `carol.forget(sharedId)` → `not-found`.
  - (c) `anna.forget(sharedId)` → `{ id: sharedId, archived: true, tombstoneId: null, alreadyForgotten: false }`; an archive file exists under `<stateDir>/memory/_archive/anna/`; `bernd.show(sharedId)` → `not-found`; `anna.show(F)` still live; `anna.forget(sharedId)` again → `not-found`; the tombstone registry for anna has no new entry (`readTombstoneRegistry` count unchanged); `<workspaceDir>/.adaptive-learning/destructive-ops.jsonl` has a line with `op: "share-retract"`.
  - (d) fresh share `S2` of a new fact `G`; `anna.correct(S2, "G corrected")` → `{ id: S3, archived: true }` with `S3 !== S2`; `bernd.show(S3).text === "G corrected"`, `sharedBy: "anna"`; `bernd.show(S2)` → `not-found`; `anna.show(G)` → `not-found` (superseded) and `anna.list({ topic: "G corrected" })` contains the new original whose id equals `bernd.show(S3).sourceId`.
  - (e) share `S4` of fact `H`, `anna.forget(H)` (the original), then `anna.correct(S4, "x")` → `conflict`; `anna.forget(S4)` still works (retract survives a dead original).
  - (f) `anna.forget(sharedId, …, cronAgent)` on a fresh share → `denied`.
  - (g) user-scope share (`share(F2, "user")`) → the same retract works through `withUserDb` (case (c) once more with `target: "user"`).
- [ ] **Step 2:** Run the file. Expected: FAIL (`sharedBy` missing, `denied "…cannot be changed through this call yet"`).
- [ ] **Step 3:** Implement `shared.js`, the write.js and read.js changes; register the new file in `ENGINE_PATHS` and `DEPLOY_FILES`. Keep every existing E1 test green — the "shared copies cannot be changed through this call yet" assertion in E1's tests (grep for it) changes to the new `denied` messages.
- [ ] **Step 4:** Run the new file plus `tests/engine-memory-ops*.test.js`, `tests/engine-contract.test.js`, `tests/adapter-register-commands.test.js`, `tests/b13-share-runtime.test.js`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(memory-ops): shared copies — sharedBy on cards, retract and refresh by the sharer (D31)`.

### Task 5: Change proposals — store, `memory.propose`, `memory.proposals.list`, event

**Files:**
- Create: `engine/memory-ops/proposal-store.js`, `engine/memory-ops/proposals.js`
- Modify: `engine/create-engine.js` (construct the store and `memoryProposals`; expose on `internals`; add `propose` and `proposals` to `engine.memory` with the Task 3 wrapper shape)
- Modify: `engine/events.js` only if event names are validated there (grep `EngineEventName`/a name list; add `"memory.proposal"`)
- Modify: `tests/helpers/runtime-sources.js`, `scripts/lib/deploy-integrity.mjs`
- Test: `tests/engine-memory-proposals.test.js` (part 1; Task 6 extends it)

**Interfaces:**
- Consumes: `opsContext.resolve`, `memoryWrite.shared.findSharedRow` (Task 4), `emitEngineEvent(host, name, payload)` (`engine/events.js`), `appendDestructiveOpLog`, `safeAgentId`/`safeUuid`/`resolveInside` (`lib/sql-safety.js`), `randomUUID`.
- Produces in `engine/memory-ops/proposal-store.js`:
  ```js
  export function proposalsRoot(baseDbPath)                       // join(dirname(baseDbPath), "_proposals") — a sibling of the LanceDB root, like _tombstones
  export function createProposalStore({ baseDbPath, logger, clock = Date.now })
    // → {
    //   create(proposal)                              → proposal   (file <root>/<sharerAgentId>/<id>.json, tmp + rename, flag "wx")
    //   get(sharerAgentId, proposalId)                → proposal | null   (null on missing; a corrupt file → throws memoryOpError("storage", "proposal unreadable"))
    //   update(proposal)                              → proposal   (atomic rewrite of the same file)
    //   listFor(agentId, { status = null, limit })    → { items, truncated, unreadable }   (sharer dir fully + other dirs filtered by proposerAgentId; newest first; corrupt files counted, warned, skipped)
    //   findPending({ sharerAgentId, sharedId, proposerAgentId })  → proposal | null
    // }
  ```
  Every path goes through `safeAgentId`, `safeUuid` and `resolveInside(root, …)`.
- Produces in `engine/memory-ops/proposals.js`:
  ```js
  export function createMemoryProposals({ opsContext, sharedOps, store, memoryDbAdapter, host, logger, clock = Date.now })
    // → { propose(sharedId, newText, p, a, opts), list(q, p, a), accept(proposalId, p, a), reject(proposalId, p, a, opts) }
    //   accept/reject are implemented in Task 6; in this task they throw memoryOpError("storage", "not implemented") and are not wired.
  ```
- `propose` rules: `resolve(p, a, { destructive: true })`; `safeUuid(sharedId)` → `invalid-input`; `newText` must be a non-empty string within the same length limit `correct` enforces (read `correct`'s validation in write.js and import/reuse its constant), `opts.note` optional string ≤ 500 chars; own private card (live in the caller's pool per `memoryDbAdapter.getCard(agentId, sharedId, { ctx: memoryCtx })`) → `invalid-input` "propose applies to shared copies; correct your own cards"; `findSharedRow` null → `not-found`; `isSharer` → `invalid-input` "the sharer corrects the original directly"; `newText === card.text` → `invalid-input` "no change"; `findPending` hit → `conflict` "a proposal by this agent is already pending"; create `{ id: randomUUID(), sharedId, sourceId: card.sourceMemoryId, target: card.scope, sharerAgentId: card.sourceAgentId, proposerAgentId: agentId, oldText: card.text, newText, note: opts?.note ?? null, createdAt: clock(), status: "pending", resolvedAt: null, resultId: null, resolutionNote: null }`; `appendDestructiveOpLog(workspaceDir, { op: "memory-propose", proposalId, sharedId, actor, at })`; `emitEngineEvent(host, "memory.proposal", { proposalId, status: "pending", sharerAgentId, proposerAgentId, sharedId })`; return `{ proposalId, sharedId, sharerAgentId }`.
- `list` rules: `resolve(p, a)` (no destructive guard); `q.status` must be one of the four statuses when present, `q.limit` integer 1..100, default 20 (`invalid-input` otherwise); returns `{ agentId, items, truncated, unreadable }`.

- [ ] **Step 1: Write the failing tests** in `tests/engine-memory-proposals.test.js` (same setup as Task 4's file; factor the setup into `tests/helpers/shared-workspace-engine.js` if both files need it, and register nothing — helpers are not engine files):
  - (a) anna shares `F` → `S`; `bernd.propose(S, "F better", …, { note: "typo" })` → `{ proposalId, sharedId: S, sharerAgentId: "anna" }`; a listener on `engine.events.on("memory.proposal")` saw `{ status: "pending", proposerAgentId: "bernd", sharerAgentId: "anna", sharedId: S }`; the file `<dirname(baseDbPath)>/_proposals/anna/<proposalId>.json` exists.
  - (b) `anna.proposals.list({})` → one item with `oldText === F's text`, `newText`, `note: "typo"`, `status: "pending"`; `bernd.proposals.list({})` → the same item; `carol.proposals.list({})` → empty; `anna.proposals.list({ status: "accepted" })` → empty; `list({ limit: 0 })` → `invalid-input`.
  - (c) `bernd.propose(S, "F better again")` → `conflict`; `bernd.propose(S, <same text as the copy>)` → `invalid-input`; `bernd.propose(randomUUID(), "x")` → `not-found`; `carol.propose(S, "x")` → `not-found`; `anna.propose(S, "x")` → `invalid-input`; `bernd.propose(<bernd's own private id>, "x")` → `invalid-input`; `bernd.propose(S, "x", …, cronAgent)` → `denied`.
  - (d) write `<root>/anna/garbage.json` containing `{` → `anna.proposals.list({})` returns the real item and `unreadable: 1`.
  - (e) `engine.close()` then `bernd.propose(...)` → `storage`.
- [ ] **Step 2:** Run the file. Expected: FAIL (`propose` is not a function).
- [ ] **Step 3:** Implement the store and `propose`/`list`; wire `engine.memory.propose` and `engine.memory.proposals.list` (Task 3 wrapper shape); register both files in `ENGINE_PATHS` and `DEPLOY_FILES`; extend `tests/engine-contract.test.js` with `typeof engine.memory.propose === "function"`.
- [ ] **Step 4:** Run the new file, `tests/engine-contract.test.js`, `tests/engine-memory-shared-ops.test.js`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(memory-ops): change proposals — store, propose and list, memory.proposal event (D31)`.

### Task 6: `memory.proposals.accept` and `reject`

**Files:**
- Modify: `engine/memory-ops/proposals.js`, `engine/create-engine.js` (wire `accept`/`reject`)
- Test: `tests/engine-memory-proposals.test.js` (part 2)

**Interfaces:**
- Consumes: `store.get/update` (Task 5), `sharedOps.findSharedRow`/`refreshShare` (Task 4), `emitEngineEvent`, `appendDestructiveOpLog`.
- `accept(proposalId, p, a)`: `resolve(p, a, { destructive: true })`; `safeUuid`; `store.get(agentId, proposalId)` — proposals are filed under the sharer, so anyone but the sharer gets null → `not-found`; `status !== "pending"` → `conflict` "proposal is <status>"; an in-process `resolving: Set<string>` refuses a concurrent accept/reject of the same id with `conflict`; `findSharedRow({ id: sharedId })` null → `store.update({ …, status: "stale", resolvedAt })`, event `stale`, `conflict` "shared copy is gone; proposal marked stale"; `card.text !== oldText` → the same with "shared copy changed since the proposal"; else `refreshShare({ card, newText, reason: "MemoryOps.proposals.accept" })` → `{ sourceId, sharedId }`; `store.update({ …, status: "accepted", resolvedAt, resultId: sharedId })`; audit `{ op: "memory-proposal-accept", proposalId, resultId }`; event `accepted`; return `{ proposalId, id: sharedId, sourceId }`.
- `reject(proposalId, p, a, opts)`: same lookup and pending check; `store.update({ …, status: "rejected", resolvedAt, resolutionNote: opts?.note ?? null })` (note ≤ 500 chars, else `invalid-input`); audit; event `rejected`; return `{ proposalId, status: "rejected" }`.

- [ ] **Step 1: Write the failing tests** (append to `tests/engine-memory-proposals.test.js`):
  - (a) proposal `P` by bernd on `S`; `bernd.proposals.accept(P)` → `not-found`; `carol.proposals.accept(P)` → `not-found`; `anna.proposals.accept(P)` → `{ proposalId: P, id: S2, sourceId: F2 }`; `bernd.show(S2).text === "F better"` and `.sharedBy === "anna"`; `bernd.show(S)` → `not-found`; `anna.proposals.list({ status: "accepted" })[0]` has `resultId: S2`, `resolvedAt` number; the event listener saw `status: "accepted"`.
  - (b) `anna.proposals.accept(P)` again → `conflict`; `anna.proposals.reject(P)` → `conflict`.
  - (c) new proposal `Q` on `S2`; `anna.proposals.reject(Q, …, { note: "no" })` → `{ proposalId: Q, status: "rejected" }`; list shows `resolutionNote: "no"`; event `rejected`.
  - (d) proposal `R` on `S2`; `anna.forget(S2)` (retract); `anna.proposals.accept(R)` → `conflict` and the stored status is `stale`; the event listener saw `stale`.
  - (e) proposal `T` on a fresh share `S5`; `anna.correct(S5, "anna's own change")` (refresh); `anna.proposals.accept(T)` → `conflict`, status `stale`.
  - (f) `anna.proposals.accept(P, …, cronAgent)` → `denied`; `anna.proposals.accept("nope")` → `invalid-input`; `anna.proposals.reject(P, …, { note: "x".repeat(501) })` → `invalid-input`.
- [ ] **Step 2:** Run the file. Expected: FAIL on the new cases.
- [ ] **Step 3:** Implement `accept`/`reject`; wire them under `engine.memory.proposals` with the Task 3 wrapper shape.
- [ ] **Step 4:** Run the file, `tests/engine-memory-shared-ops.test.js`, `tests/engine-contract.test.js`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(memory-ops): proposals accept (refresh the shared copy) and reject (D31)`.

### Task 7: `admin.obsidian.detect/prepare/confirm` with explicit paths

**Files:**
- Create: `engine/admin/obsidian.js`
- Modify: `engine/create-engine.js` (`adminOps.obsidian` lines 3378-3382 → the new ops; pass the engine's existing `confirmationStore` Map — grep `confirmationStore` in create-engine.js, it is already on `internals`)
- Modify: `lib/obsidian-vault-confirmation-flow.js` only if needed to expose the pending record's fields (it already stores `vaultDigest`; the vault path is kept engine-side, see below)
- Modify: `tests/helpers/runtime-sources.js`, `scripts/lib/deploy-integrity.mjs`
- Test: `tests/engine-admin-obsidian.test.js`

**Interfaces:**
- Consumes: `opsContext.resolve`, `discoverObsidianWorkspaces(rawConfig, { agentId })` (`lib/obsidian-bridge.js:341`; entries `{ workspaceId, agentId, path }`), `isOwnedVaultConfirmed({ baseDbPath, memoryCtx, vaultPath })` (`lib/obsidian-vault-authority.js`), `prepareVaultConfirmation({ baseDbPath, memoryCtx, vaultPath, confirmationStore, expiryMinutes })`, `confirmVaultConfirmation({ callbackData, confirmationStore, baseDbPath, memoryCtx, vaultPath })`, `vaultConfirmationCallbackForNonce(confirmationStore, nonce)` (all `lib/obsidian-vault-confirmation-flow.js`), `homedir` from `node:os`, `existsSync`/`statSync`/`realpathSync` from `node:fs`.
- Produces:
  ```js
  export function expandVaultPath(raw, homeDir)   // "~" | "~/x" → under homeDir; relative → join(homeDir, raw); absolute → as is; then path.normalize; throws memoryOpError("invalid-input") on empty/non-string
  export function createObsidianOps({ opsContext, baseDbPath, confirmationStore, getObsidianBridgeConfig, host, logger, clock = Date.now })
    // → { detect(p, a, opts), prepare(vaultPath, p, a), confirm(nonce, p, a) }
  ```
- `detect`: `resolve(p, a)`; candidates in order: (1) `discoverObsidianWorkspaces(getObsidianBridgeConfig(), { agentId })` paths → `source: "config"`; (2) `workspaceDir` from `resolve` → `"workspace"`; (3) `opts.candidates` (array of ≤ 20 strings, each `expandVaultPath`; anything else → `invalid-input`) → `"candidate"`; dedupe by normalised path (first source wins); per path: `isVault = existsSync(join(path, ".obsidian", "workspace.json")) || existsSync(join(path, ".obsidian", "app.json"))`; `confirmed = directory exists && isOwnedVaultConfirmed({ baseDbPath, memoryCtx, vaultPath: path })` (never call `ownedVaultDigest` on a missing path — it `realpathSync`s).
- `prepare`: `resolve(p, a, { destructive: true })`; `expandVaultPath`; not an existing directory → `invalid-input` "vault path is not a directory"; `memoryCtx.trust !== "proved"` or no `memoryCtx.userPrincipal` → `denied` "vault confirmation requires a proved principal with a user"; `prepareVaultConfirmation(...)` → `{ ok: false, reason: "identity_binding_required" }` → `denied`; keep `pending.set(nonce, { vaultPath, expiresAt })` in an engine-side Map (swept of expired entries on every call, capped at 64 entries, oldest evicted); return `{ nonce, expiresAt, vaultPath, vaultDigest }`.
- `confirm`: `resolve(p, a, { destructive: true })`; `safeUuid(nonce)` → `invalid-input`; `pending.get(nonce)` missing or expired → `not-found` "confirmation not found or expired"; `callbackData = vaultConfirmationCallbackForNonce(...)` empty → `not-found`; `confirmVaultConfirmation(...)`: `ok: false` with reason `security.wrong_user` / `security.wrong_chat` / an identity-binding mismatch → `denied`; `security.not_found_or_expired` / `security.expired` → `not-found`; any other failure → `storage` (logged); on success delete the pending entry and return `{ confirmed: true, vaultPath, vaultDigest: <from the receipt>, alreadyConfirmed: result.alreadyConfirmed === true }`. Read `confirmVaultConfirmation` (flow lines 105-150) for the exact result fields before mapping.

- [ ] **Step 1: Write the failing tests** in `tests/engine-admin-obsidian.test.js`. Host: `createStubHost({ stateDir })` with `workspaceDir` returning a temp vault directory that contains `.obsidian/app.json` (see how E1's destructive tests give the stub host a real workspace); `provedPrincipal` with `user`, `chat`, `accountId`, `channel` from `tests/engine-contract.test.js`; a second principal `otherUser` with a different `user`. Cases:
  - (a) `detect(p, userAgent)` → contains `{ path: <vault>, isVault: true, confirmed: false, source: "workspace" }`; `detect(p, userAgent, { candidates: ["~/does-not-exist-e2"] })` adds `{ path: join(homedir(), "does-not-exist-e2"), isVault: false, confirmed: false, source: "candidate" }`; `{ candidates: "x" }` → `invalid-input`.
  - (b) `prepare(<vault>, p, userAgent)` → `nonce` matches the UUID regex, `expiresAt > Date.now()`, `vaultPath === <vault>`, `vaultDigest` 64 hex; `prepare(<a file path>)` → `invalid-input`; `prepare(<vault>, { ...p, trust: "inferred" })` → `denied`; `prepare(<vault>, p, cronAgent)` → `denied`.
  - (c) `confirm(randomUUID(), p, userAgent)` → `not-found`; `confirm(nonce, otherUser, userAgent)` → `denied`; `confirm(nonce, p, userAgent)` → `{ confirmed: true, alreadyConfirmed: false, vaultDigest }`; a receipt exists under `<baseDbPath>/.plur1bus-authority/obsidian-vaults/<agent>/`; `detect` now reports `confirmed: true`; `confirm(nonce, p, userAgent)` again → `not-found` (consumed); a second `prepare` + `confirm` → `alreadyConfirmed: true`.
  - (d) unit: `expandVaultPath("~/v", "/h")` → `/h/v`; `("v", "/h")` → `/h/v`; `("/abs/v", "/h")` → `/abs/v`; `("", "/h")` throws `invalid-input`. On win32 use `path.join` expectations, not literal slashes.
- [ ] **Step 2:** Run the file. Expected: FAIL (`not available in M1b-1`).
- [ ] **Step 3:** Implement `engine/admin/obsidian.js` and the wiring (Task 3 wrapper shape); register the file in `ENGINE_PATHS` and `DEPLOY_FILES`.
- [ ] **Step 4:** Run the new file, `tests/engine-contract.test.js`, and every `tests/*obsidian*.test.js` (unchanged behaviour of the string command path). Expected: PASS.
- [ ] **Step 5:** Commit `feat(admin): obsidian detect/prepare/confirm with explicit paths, no host runtime`.

### Task 8: Docs, changelog, adapter check, full gate

**Files:**
- Modify: `docs/engine-api.md` (new sections after "Typed MemoryOps (`Engine.memory`, 1.5.0)": "Shared copies and change proposals (1.6.0, D31)", "AdminOps in 1.6.0: obsidian, migrate, the deprecated aliases", and a line in "The L3 events" for `memory.proposal`; update "What is implemented in M1b-1" so `admin.*` no longer lists the stubs)
- Modify: `CHANGELOG.md` (`[Unreleased]` → `### Hinzugefügt`/`### Geändert` entries in German, one bullet per surface: aliases, ObsidianOps, `admin.migrate` + `_schema.json`, shared-copy rules, proposals + event, `close()` drain, `MemoryCard.sharedBy/sourceId`, `EngineStatus.storeSchema`)
- Modify: `adapter/openclaw/register-commands.js` only if a reply mapping needs the new `denied` messages (check that `/forget` and `/correct` on a shared id by a non-sharer still answer a sensible localized text; E1 maps `denied` after auth to "failed" — keep that, it is not user-facing new UX; D31's chat UX is the harness's)
- Test: full gate

- [ ] **Step 1:** Write the docs and changelog sections. State the D31 rules exactly as the `MemoryOps` doc comment does, the proposals file layout (`<dirname(baseDbPath)>/_proposals/<sharer>/<id>.json`), the marker (`<baseDbPath>/_schema.json`, `"0"` for legacy stores, migrate `"0"→"1"` is a no-op marker write), the Obsidian flow (detect → prepare → confirm, 10-minute nonce, receipt under `.plur1bus-authority`), and the `close()` drain.
- [ ] **Step 2:** `grep -rn "not available in M1b-1\|notInM1b1" engine/ docs/ tests/` — only `reembedding.rollback/switch` fallbacks may remain; the docs must not list `admin.share/forget/obsidian/migrate` as stubs anywhere.
- [ ] **Step 3:** Full gate: `npm run lint && npm test` (590 s timeout) and `TZ=UTC node --test tests/golden-prefix.test.js`. Expected: all green, golden 9/9.
- [ ] **Step 4:** Commit `docs: E2 — contract 1.6.0 (admin ops, shared copies, proposals) in CHANGELOG and contract docs`.
- [ ] **Step 5:** Hand over: bundle `origin/main..feat/e2-admin-ops`, push via the Mac, open PR "E2: admin ops without a host runtime, shared-copy rules and change proposals (contract 1.6.0)" against `main`; the owner merges.

---

## Self-review notes

- **Spec coverage:** E2 row — `share`/`forget` delegate (Task 1), `obsidian` explicit paths (Task 7), `migrate` (Task 2). D31 — retract/refresh (Task 4), propose/list (Task 5), accept/reject + event (Task 6). Owner rulings — per-agent vault and `~`/home-relative paths (Task 7 `expandVaultPath`, config entries filtered by `agentId`), variant (a) marker (Task 2). E1 follow-ups — `close()` drain (Task 3), shared-copy `denied` replaced (Task 4), AdminOps pins (Task 1). Deferred with a reason: D24 "same person" for retract (needs `/link`), per-recipient hiding (D31 says so), the `shareCard` adapter seam (E6).
- **Type consistency:** `MemoryForgetResult` for retract (`tombstoneId: null`), `MemoryCorrectResult` for refresh (`id` = new shared id), `refreshShare` returns `{ sourceId, sharedId, retractedId }` and `accept` maps it to `{ proposalId, id: sharedId, sourceId }`; `sharedOps` is reached as `memoryWrite.shared` in Tasks 5-6.
- **Order:** 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8; Tasks 2, 3 and 7 touch disjoint code from 4-6 but share `create-engine.js`, so they stay sequential.
