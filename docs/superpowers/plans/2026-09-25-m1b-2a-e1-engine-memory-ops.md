# M1b-2a engine work: E0 (land #186) and E1 (MemoryOps). Implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the M1b-1 engine API (PR #186) on the engine's `main`. Then give the engine a typed `MemoryOps` surface (`list`, `show`, `forget`, `correct`, `share`, `state`), each call taking a `Principal` and an `AgentContext`. That lets the harness serve `memory.list|show|forget|correct|share|state` without any string command. The OpenClaw adapter becomes a consumer of the same surface.

**Architecture:** The logic already exists and is host-neutral: `lib/telegram-commands/memory-edit.js` (forget/correct/share, archive-first plus two-phase tombstone), `memory-query.js` (ACL-filtered query across private, workspace and user pools) and `lib/tombstone.js`. What is missing is an engine-level typed entry point. Today the OpenClaw adapter builds the six command bodies and injects them into the engine through a mutable `commandBodies` object. E1 adds `engine/memory-ops/*`, which binds that logic to `Principal` and `AgentContext` through `memoryContextFromPrincipal`, and exposes it as `Engine.memory`. The adapter's slash commands then call `engine.memory.*` and keep only parsing, confirmation UX and rendering. The contract moves additively to **1.5.0**.

**Tech stack:** engine repo `Cyb3rb1ade/openclaw-plur1bus-memory` (ESM JavaScript, `types/engine.d.ts` + `types/engine.conformance.ts`, `node --test`, LanceDB). Node ≥ 24.16.

**Spec:** `docs/superpowers/specs/2026-09-24-m1b-2a-core-daemon-cli-design.md` (rev 2), §7 (E1–E6), §6.2 (`memory.*` methods, `E_NOT_AVAILABLE reason=engine-pr-E1` until E1), §10.11 (engine side of acceptance).

## 2a-E sequence (the frame this plan sits in)

| Step | Branch / PR | Contract | Detailed plan |
|---|---|---|---|
| **E0** | merge `main` into `feat/engine-api-m1b1`; owner merges #186 | 1.4.1 | **this plan, Task 1** |
| **E1** | `feat/e1-memory-ops` | 1.5.0 | **this plan, Tasks 2–8** |
| E2 | `admin.*` without an OpenClaw runtime (`share`/`forget` → E1, `obsidian`/`migrate` with explicit paths) | 1.6.0 | written after E1 merges |
| E3 | `embedding.probe()`/`serve(address \| null)` real (wire `lib/providers/scoped-embedding-ipc.js`) | 1.7.0 | written after E2 |
| E4 | `status()` with ledger health (last run per job, breaker, host-reported journal backlog, model readiness) + spec Q3 (a replay is never a new LLM session) | 1.8.0 | written after E3 |
| E5 | `engine-config.schema.json` (54 keys, types, defaults, `readAt`); honour `RecallQuery.budget`; fix the stale "56" comment in `engine.d.ts` | 1.9.0 | written after E4 |
| E6 | `HostServices` neutral (no `pathOverrides.openclawHome`, `routing?()` → optional `identity`, `HostRuntime` → typed capabilities, `lib/host-paths.js` without a default root; `Engine.commands`/`runCommand` leave the contract) | **2.0** | written after E5 |
| P | publish-on-tag workflow, `7.16.x-engine.N` prerelease on dist-tag `engine` (D2, `NPM_TOKEN` set by the owner); harness pins it exactly | — | with E6 |

The harness side (serving `memory.list|show|forget|correct|share|state` over RPC) is plan 2a-H2's work, after E1 is merged and published or pinned.

## Global constraints

- Contract amendment policy (`types/engine.d.ts:23-31`): every observable shape change bumps `ContractVersion`, and `ContractVersion`, `types/engine.conformance.ts` and both adapters move together in one PR.
- Engine gate per PR: `npm run lint` (includes `scripts/typecheck.mjs`, `lint-no-api-outside-adapter.mjs`, `lint-engine-imports.mjs`), `npm test` (all of `tests/*.test.js test/*.test.js`), golden 9/9 (`tests/golden-prefix.test.js`, default TZ and `TZ=UTC`), contract conformance (`npm run typecheck`).
- `engine/**` never imports `openclaw`, `lib/host-services.js`, `lib/runtime-shutdown.js`, `lib/providers/openclaw-memory-embedding-adapters.js` or `lib/setup/*-plugin-runtime.js`, never reads a bare `api`, and never reads `process.env.OPENCLAW_*`. Dependencies arrive through a context object.
- Forget is archive-first and tombstoned, never a hard delete; `lib/tombstone.js`'s attempted → committed registry stays the only write path.
- Anti-oracle: a tombstoned card, a card the caller may not see, and a missing id are indistinguishable to the caller ("not-found").
- No OpenClaw idiom crosses into the new surface (D9): no slash strings, no `commandCtx`, no `api`.
- Commit identity `Cyb3rb1ade <84099452+Cyb3rb1ade@users.noreply.github.com>`, trailers kept. Pushes, PR merges and anything on `main` are done by the owner (bundles from the cloud session).
- Never put secrets, tokens or real user data in the repo, logs or test fixtures.

## Review focus

1. **Destructive op from a non-user origin:** `forget`/`correct`/`share` with `agent.origin !== "user"` or `agent.background !== false` must be refused (`denied`), never executed by a cron or subagent on its own. Pinned in Task 3.
2. **Inferred trust on a destructive op:** `Principal.trust === "inferred"` degrades reads to agent-private and must refuse writes to shared scopes. Pinned in Tasks 3 and 6.
3. **Oracle through error codes:** a card owned by another agent, a tombstoned card and a random UUID must all produce `not-found` from `show`, `forget` and `correct`. Pinned in Tasks 4 and 5.
4. **Crash between archive and tombstone:** the existing idempotent backfill path (`alreadyTombstoned`) must surface as a successful `forget` with `archived: false` and the tombstone id, not as an error. Pinned in Task 5.
5. **Archive location on a non-OpenClaw host:** archives must land under `<host.stateDir>/memory/_archive/<agent>/`, which is the same place as today for OpenClaw (its `stateDir` is `~/.openclaw`), and never under `~/.openclaw` on a harness host. Pinned in Task 3.

---

### Task 1: E0: bring `main` (7.16.0–7.16.9) into `feat/engine-api-m1b1` so #186 can merge

**Files:**
- Modify (merge): `CHANGELOG.md`, `index.js` (the only conflicts per `git merge-tree`), plus whatever post-M1b-1 module now owns the code that 7.16.3–7.16.6 added to `index.js`.
- Test: the full gate.

**Context:** `main` diverged from #186 by 37 commits (#187). `index.js` on `main` gained 30 lines (commits a3a3a11d 7.16.3 sleep plan to the memory page, 76772455 7.16.4 chat model per workspace, b620f9e9/e6c78889 7.16.5, 4d6b8d10 7.16.6 `recall.memoriesMaxChars` wiring, 677b9f88 memory-capability artifacts). On #186's side `index.js` is a thin shim, and that code now lives in `adapter/openclaw/*` or `engine/*`.

- [ ] **Step 1:** In the engine clone: `git switch feat/engine-api-m1b1 && git fetch origin && git merge origin/main`. Expect conflicts in `CHANGELOG.md` and `index.js`.
- [ ] **Step 2:** `CHANGELOG.md`: keep both sides. `main`'s 7.16.x entries go in their version order, and #186's M1b-1 section stays at the top as unreleased.
- [ ] **Step 3:** `index.js`: take #186's shim (`git checkout --theirs index.js` is **wrong** here: in `git merge origin/main`, "ours" is the feature branch, so use `git checkout --ours index.js`). Then list `main`'s 30 added lines with `git diff $(git merge-base origin/main HEAD) origin/main -- index.js`. For each hunk, find the post-M1b-1 home of the surrounding code (`grep` for its neighbours in `adapter/openclaw/` and `engine/`) and apply the same change there. Record every hunk and its new location in the merge commit body.
- [ ] **Step 4:** Check that the tests `main` added still pass against the new homes: `node --test tests/recall-memories-max-chars-wiring.test.js` plus every other test file `main` added (`git diff --name-only --diff-filter=A $(git merge-base origin/main HEAD) origin/main -- tests test`). A test that imported something from `index.js` gets its import pointed at the new module in the same commit.
- [ ] **Step 5:** Full gate: `npm run lint && npm test && TZ=UTC node --test tests/golden-prefix.test.js`. Expected: all green, golden 9/9.
- [ ] **Step 6:** `git commit` (merge commit, message `Merge main (7.16.0–7.16.9) into feat/engine-api-m1b1`, body lists the ported hunks).
- [ ] **Step 7:** Hand over: bundle `origin/feat/engine-api-m1b1..feat/engine-api-m1b1`. The owner pushes and merges #186 on GitHub (merge commit, not squash, so `eaaf168f` stays reachable for the harness pin). Wait for that before Task 2.

### Task 2: E1 contract: `MemoryOps` types, `Engine.memory`, contract 1.5.0

**Files:**
- Modify: `types/engine.d.ts` (after the `AdminOps` block, near lines 410-494; `ContractVersion` line 40)
- Modify: `types/engine.conformance.ts` (the `ContractVersion` pin near line 105, new `MemoryOps` pins)
- Modify: `engine/create-engine.js:3355,3364` (`contract: "1.5.0"`)
- Test: `tests/engine-contract.test.js`

**Interfaces:**
- Produces (verbatim, later tasks implement exactly this):

```ts
/** Reason codes a MemoryOps call can fail with. `not-found` also covers
 *  "exists but you may not see it" and "tombstoned" (anti-oracle). */
export type MemoryOpErrorCode =
  | "not-found" | "denied" | "invalid-input" | "approval-required"
  | "conflict" | "storage";

/** Thrown by every MemoryOps member on failure; `code` is stable, `message` is English and log-safe. */
export interface MemoryOpError extends Error { readonly code: MemoryOpErrorCode }

export type MemoryScope = "agent-private" | "workspace" | "user";

export interface MemoryCard {
  id: string;
  scope: MemoryScope;
  text: string;
  summary: string;
  createdAt: number | null;
  origin: string | null;
  epistemicStatus: string | null;
  /** Present on list results from a topic query; absent on show. */
  score?: number;
}

export interface MemoryListQuery {
  /** Topic query (semantic + lexical). Exactly one of `topic` and `since` is required. */
  topic?: string;
  /** Epoch ms lower bound for a time listing. */
  since?: number;
  until?: number;
  /** Default 20, maximum 100. */
  limit?: number;
}

export interface MemoryListResult { agentId: AgentId; items: MemoryCard[]; truncated: boolean }
export interface MemoryForgetResult { id: string; archived: boolean; tombstoneId: string | null; alreadyForgotten: boolean }
export interface MemoryCorrectResult { id: string; archived: true }
export interface MemoryShareResult { sourceId: string; sharedId: string; target: "workspace" | "user" }
export interface MemoryState {
  agentId: AgentId;
  cards: { agentPrivate: number | null; workspace: number | null; user: number | null };
  tombstones: number;
  archiveDir: string;
}

export interface MemoryOps {
  list(q: MemoryListQuery, p: Principal, a: AgentContext): Promise<MemoryListResult>;
  show(id: string, p: Principal, a: AgentContext): Promise<MemoryCard>;
  forget(id: string, p: Principal, a: AgentContext): Promise<MemoryForgetResult>;
  correct(id: string, newText: string, p: Principal, a: AgentContext): Promise<MemoryCorrectResult>;
  /** `allowSensitive` is the caller's explicit confirmation after an `approval-required` refusal. */
  share(id: string, target: "workspace" | "user", p: Principal, a: AgentContext, opts?: { allowSensitive?: boolean }): Promise<MemoryShareResult>;
  state(p: Principal, a: AgentContext): Promise<MemoryState>;
}
```
- Also: `export type ContractVersion = "1.5.0";`, and in `interface Engine` the line `memory: MemoryOps;` after `checkpoint`. Add a JSDoc line to `runCommand`: `/** @deprecated since 1.5.0; string commands are adapter-internal. Removed in contract 2.0 (E6). Use Engine.memory. */`.

- [ ] **Step 1: Write the failing test** (append to `tests/engine-contract.test.js`, reusing its existing `createStubHost()` setup):

```js
test("contract 1.5.0 exposes a typed MemoryOps surface", async () => {
  const engine = createEngine(createStubHost(), {});
  assert.equal(engine.contract, "1.5.0");
  assert.equal((await engine.status()).contract, "1.5.0");
  for (const m of ["list", "show", "forget", "correct", "share", "state"]) {
    assert.equal(typeof engine.memory[m], "function", `engine.memory.${m}`);
  }
  assert.ok(Object.isFrozen(engine.memory));
  await engine.close();
});
```
- [ ] **Step 2:** Run `node --test tests/engine-contract.test.js`. Expected: FAIL (`engine.memory` is undefined; contract is 1.4.1).
- [ ] **Step 3:** Add the types above to `engine.d.ts`, bump `ContractVersion`, and add conformance pins in `engine.conformance.ts` in the file's existing style (`assertTrue<Exact<ContractVersion, "1.5.0">>()`, plus one `Exact` pin per `MemoryOps` member signature and for `MemoryOpErrorCode`). Also update any test in `tests/` that asserts `"1.4.1"` literally (`grep -rn '"1.4.1"' tests test types engine`); each such line moves to `"1.5.0"`.
- [ ] **Step 4:** In `create-engine.js`, set both contract literals to `"1.5.0"`, and add a temporary `memory: Object.freeze({ list: notInM1b1("memory.list"), show: notInM1b1("memory.show"), forget: notInM1b1("memory.forget"), correct: notInM1b1("memory.correct"), share: notInM1b1("memory.share"), state: notInM1b1("memory.state") })` to the engine object. Tasks 3–7 replace each stub.
- [ ] **Step 5:** Run `node --test tests/engine-contract.test.js && npm run typecheck`. Expected: PASS.
- [ ] **Step 6:** Commit `feat(contract): 1.5.0 — typed MemoryOps surface (Engine.memory), runCommand deprecated`.

### Task 3: E1 `engine/memory-ops/context.js`: Principal → memory context, guards, errors

**Files:**
- Create: `engine/memory-ops/context.js`, `engine/memory-ops/errors.js`
- Test: `tests/e1-memory-ops-context.test.js`

**Interfaces:**
- Consumes: `memoryContextFromPrincipal(principal, { workspaceDir, logger })` (`engine/identity/principal.js:43`).
- Produces:
  - `memoryOpError(code, message) → Error & { code }` and `isMemoryOpError(e) → boolean`.
  - `createMemoryOpsContext({ host, logger }) → { resolve(p, a, { destructive, target? }) → Promise<{ agentId, memoryCtx, workspaceDir, archiveDir }> }`.

```js
// engine/memory-ops/errors.js
export const MEMORY_OP_ERROR_CODES = Object.freeze(["not-found", "denied", "invalid-input", "approval-required", "conflict", "storage"]);
export function memoryOpError(code, message) {
  if (!MEMORY_OP_ERROR_CODES.includes(code)) throw new TypeError(`unknown MemoryOp error code: ${code}`);
  const err = new Error(message);
  err.name = "MemoryOpError";
  Object.defineProperty(err, "code", { value: code, enumerable: true });
  return err;
}
export const isMemoryOpError = (e) => e instanceof Error && e.name === "MemoryOpError" && MEMORY_OP_ERROR_CODES.includes(e.code);
```

```js
// engine/memory-ops/context.js
import { join } from "node:path";
import { memoryContextFromPrincipal } from "../identity/principal.js";
import { memoryOpError } from "./errors.js";

const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** Binds MemoryOps calls to the host: Principal → memory request context, plus the fail-closed guards. */
export function createMemoryOpsContext({ host, logger }) {
  return {
    async resolve(p, a, { destructive = false, target = null } = {}) {
      if (!p || typeof p.agentId !== "string" || !AGENT_ID.test(p.agentId)) throw memoryOpError("invalid-input", "principal.agentId is invalid");
      if (!a || typeof a.origin !== "string") throw memoryOpError("invalid-input", "agent context is required");
      if (destructive && (a.origin !== "user" || a.background !== false)) {
        throw memoryOpError("denied", "destructive memory operations require origin \"user\" and background false");
      }
      const workspaceDir = await host.workspaceDir(p.agentId);
      const memoryCtx = memoryContextFromPrincipal(p, { workspaceDir, logger });
      if (target && memoryCtx.trust !== "proved") throw memoryOpError("denied", `sharing to ${target} requires a proved principal`);
      return { agentId: memoryCtx.agentId, memoryCtx, workspaceDir, archiveDir: join(host.stateDir, "memory", "_archive") };
    },
  };
}
```

- [ ] **Step 1: Write the failing tests** (`tests/e1-memory-ops-context.test.js`):

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryOpsContext } from "../engine/memory-ops/context.js";
import { isMemoryOpError, memoryOpError } from "../engine/memory-ops/errors.js";

const stateDir = mkdtempSync(join(tmpdir(), "e1-ctx-"));
const ws = mkdtempSync(join(tmpdir(), "e1-ws-"));
const host = { stateDir, workspaceDir: async () => ws };
const P = { agentId: "bernd", workspace: `workspace-dir:v1:${ws}`, channel: "cli", accountId: "host", chat: { id: "cli:u", kind: "direct" }, trust: "proved" };
const USER = { origin: "user", background: false };

test("archive dir is <stateDir>/memory/_archive (same as OpenClaw's ~/.openclaw/memory/_archive)", async () => {
  const r = await createMemoryOpsContext({ host }).resolve(P, USER, {});
  assert.equal(r.archiveDir, join(stateDir, "memory", "_archive"));
  assert.equal(r.agentId, "bernd");
});
for (const a of [{ origin: "cron", background: true }, { origin: "subagent", background: false }, { origin: "user", background: true }, { origin: "user" }]) {
  test(`destructive op refused for ${JSON.stringify(a)}`, async () => {
    await assert.rejects(createMemoryOpsContext({ host }).resolve(P, a, { destructive: true }), (e) => isMemoryOpError(e) && e.code === "denied");
  });
}
test("sharing requires proved trust", async () => {
  await assert.rejects(createMemoryOpsContext({ host }).resolve({ ...P, trust: "inferred" }, USER, { destructive: true, target: "workspace" }), (e) => e.code === "denied");
});
test("invalid agent id is invalid-input", async () => {
  await assert.rejects(createMemoryOpsContext({ host }).resolve({ ...P, agentId: "../x" }, USER), (e) => e.code === "invalid-input");
});
test("unknown error codes are a programming error", () => {
  assert.throws(() => memoryOpError("nope", "x"), TypeError);
});
```
- [ ] **Step 2:** Run `node --test tests/e1-memory-ops-context.test.js`. Expected: FAIL (module not found).
- [ ] **Step 3:** Create both files with the code above.
- [ ] **Step 4:** Run the test again, then `npm run lint`. Expected: PASS; `lint-engine-imports` is clean.
- [ ] **Step 5:** Commit `feat(memory-ops): Principal-bound context with fail-closed guards and typed errors`.

### Task 4: E1 `list` and `show`

**Files:**
- Create: `engine/memory-ops/read.js`
- Modify: `engine/create-engine.js` (replace the `memory.list`/`memory.show` stubs; pass `pool`, `sharedMemoryPool`, `embeddings`, `memoryDbAdapter` from the constructor scope, lines ~1215, 1216, 1338, 1409)
- Test: `tests/e1-memory-ops-read.test.js`

**Interfaces:**
- Consumes: `queryMemoryAcrossAccessPools({ privatePool, sharedPool, embeddings, agent, parsed, ctx, now })` and `projectMemoryQueryCard(row)` (`lib/telegram-commands/memory-query.js:220,144`); `memoryDbAdapter.getCard(agent, id, { ctx })` (`lib/db-adapter.js:676`); `checkAccess(ctx, memory)` (`lib/acl-middleware.js:103`); `safeUuid` (`lib/sql-safety.js`).
- Produces: `createMemoryRead({ opsContext, pool, sharedMemoryPool, embeddings, memoryDbAdapter, logger }) → { list, show }`.

Implementation rules (the implementer writes the code against the real signatures):
- `list`:
  - Validate first: exactly one of `topic` and `since` is set; `topic` is 1–2 000 chars; `limit` defaults to 20 and is clamped to 1..100. Any violation → `invalid-input`.
  - Build `parsed` the way `parseQuery` in `memory-query.js:64` produces it for the equivalent `/memory <topic>` or time query. Read that function and construct the same object shape directly; never go through the string parser.
  - Call `queryMemoryAcrossAccessPools`.
  - Map each item to `MemoryCard`. `scope` comes from the item's ACL scope field, whatever `projectRecallEntry` names it. Read `lib/recall-pipeline.js` for the name.
  - `truncated = items.length > limit`, and return `items.slice(0, limit)`.
- `show`:
  - `safeUuid(id)`. An invalid id → `invalid-input`.
  - Load with `getCard(agentId, id, { ctx: memoryCtx })`.
  - If the card is missing, tombstoned (`status === "deleted"`), or refused by `checkAccess` → `not-found`, with the same message in all three cases.
  - Project with `projectMemoryQueryCard` and map to `MemoryCard`.
- Neither method is destructive. Call `opsContext.resolve(p, a)` with no guard options.
- Storage exceptions (LanceDB, timeouts) → `storage`, message `memory read failed`. Log the underlying error with `logger.warn`, not in the thrown message.

- [ ] **Step 1: Write the failing tests.** Use the engine's existing flat or stub embedding test seam: `createEngine(createStubHost({ stateDir }), cfg, { internals: { embeddings } })`, as other `tests/engine-*.test.js` files do; copy their setup, including `duplicateThreshold` if they need distinct facts. Seed facts with `engine.capture(turnRecord)` and await `done`. Cases:
  - (a) `list({ topic })` returns the seeded fact, with `scope: "agent-private"` and a numeric `score`.
  - (b) `list({ since: 0, limit: 1 })` over two facts returns 1 item with `truncated: true`.
  - (c) `show(id)` returns the card, and `show(randomUUID())` → `not-found`.
  - (d) After `engine.memory.forget(id)` (Task 5; mark this case `todo` until Task 5 lands, then enable it), `show(id)` → `not-found`.
  - (e) A card captured by agent `anna` is `not-found` for principal agent `bernd`.
  - (f) `list({})` and `list({ topic: "x", since: 1 })` → `invalid-input`.
- [ ] **Step 2:** Run the tests. Expected: FAIL (the stubs throw "not available").
- [ ] **Step 3:** Implement `read.js` and wire it in `create-engine.js`.
- [ ] **Step 4:** Run the new test file plus `node --test tests/engine-contract.test.js`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(memory-ops): list and show over the ACL-filtered access pools`.

### Task 5: E1 `forget` and `correct`, with machine-readable failure codes in `memory-edit.js`

**Files:**
- Modify: `lib/telegram-commands/memory-edit.js` (every `return { ok: false, error }` in `forgetCard` (lines 241-363) and `correctCard` (lines 380-402) additionally gets a `code`)
- Create: `engine/memory-ops/write.js`
- Modify: `engine/create-engine.js` (replace the `forget`/`correct` stubs)
- Test: `tests/e1-memory-ops-write.test.js`, `test/memory-edit.test.js` (extend)

**Interfaces:**
- Consumes: `forgetCard(db, agent, id, opts)` → `{ ok, error?, code?, archivePath?, id?, alreadyTombstoned? }`, and `correctCard(db, agent, id, newContent, opts)` → `{ ok, error?, code?, archivePath?, id? }`. The `opts` used today are `{ lang, tone, workspaceDir, logger, ctx, baseDbPath, actor, actorType, reason, archiveDir }` (see `adapter/openclaw/register-commands.js:700-710`).
- Produces: `createMemoryWrite({ opsContext, memoryDbAdapter, baseDbPath, logger }) → { forget, correct }`.

Code mapping, added as an extra field next to `error` (the adapter keeps using `error`):

| `forgetCard`/`correctCard` branch | `code` |
|---|---|
| db read throws | `"storage"` |
| card missing, tombstoned (correct), or ACL denied | `"not-found"` (ACL denial is not-found to the caller; the ACL audit log line stays) |
| archive write failed | `"storage"` |
| tombstone/update write failed | `"storage"` |
| audit/registry commit failed | `"storage"` |

- `forget(id, p, a)`:
  - `resolve(p, a, { destructive: true })`, then `safeUuid(id)` (invalid → `invalid-input`).
  - Call `forgetCard(memoryDbAdapter, agentId, id, { lang: "en", workspaceDir, logger, ctx: memoryCtx, baseDbPath, archiveDir, actor: memoryCtx.userPrincipal || "principal:" + agentId, actorType: "human", reason: "MemoryOps.forget" })`.
  - Map `ok: false` to `memoryOpError(code ?? "storage", <english message per code>)`.
  - Map `ok: true` to `{ id, archived: !alreadyTombstoned, tombstoneId, alreadyForgotten: Boolean(alreadyTombstoned) }`. `tombstoneId` comes from the committed tombstone record. If `forgetCard` does not return it yet, add `tombstoneId` to its `ok: true` results (additive, from `buildTombstone`'s id) in this same task.
- `correct(id, newText, p, a)`:
  - `newText` must be 1–8 000 chars after trim (else `invalid-input`).
  - Run the same guards as `forget`, then `correctCard(...)` with the same opts.
  - Success returns `{ id, archived: true }`.

- [ ] **Step 1: Write the failing tests.** In `test/memory-edit.test.js`, assert `code` for each branch that already has a test there (missing card → `"not-found"`, archive failure → `"storage"`). In `tests/e1-memory-ops-write.test.js`, use the same engine setup as Task 4. Cases:
  - (a) `forget` → `archived: true`, a tombstone id, an archive file under `<stateDir>/memory/_archive/bernd/`, then `list` no longer returns the card.
  - (b) `forget` twice → the second call returns `alreadyForgotten: true` without throwing.
  - (c) `forget(randomUUID())` → `not-found`.
  - (d) `forget` of `anna`'s card as `bernd` → `not-found`.
  - (e) `forget` with `{ origin: "cron", background: true }` → `denied`, and the card is still listed.
  - (f) `correct` changes the text shown by `show`, and an archive file exists.
  - (g) `correct(id, "   ")` → `invalid-input`.
  - (h) Tombstone registry: `readTombstonesFromRegistry(baseDbPath, "bernd")` has exactly one committed entry after (a) and (b).
  - Enable Task 4's todo case (d).
- [ ] **Step 2:** Run both files. Expected: FAIL.
- [ ] **Step 3:** Add `code` to `memory-edit.js`, implement `write.js`, and wire it.
- [ ] **Step 4:** Run both files, then `npm test`. Expected: PASS. The adapter tests are unchanged and still green, because `error` strings are untouched.
- [ ] **Step 5:** Commit `feat(memory-ops): forget (archive-first, tombstone) and correct; machine codes on memory-edit results`.

### Task 6: E1 `share`

**Files:**
- Modify: `engine/memory-ops/write.js` (add `share`)
- Modify: `lib/telegram-commands/memory-edit.js` (`shareCard` failure results get a `code`)
- Modify: `engine/create-engine.js` (replace the `share` stub; `pool`, `sharedMemoryPool` and `embeddings` are already in scope)
- Test: `tests/e1-memory-ops-write.test.js` (extend)

**Interfaces:**
- Consumes: `shareCard(privatePool, sharedPool, embeddings, agent, id, { targetScope, allowSensitiveShare, ctx, logger })` → `{ ok, sharedId?, error?, code? }` (`memory-edit.js:495`). The failure strings to map: `"share.invalid_id"` → `invalid-input`; any `error` starting with `"share.explicit approval required"` → `approval-required`; source missing, not owned, or ACL-denied (the adapter's `sourceDenied(error)` predicate in `register-commands.js`, which you move into `memory-edit.js` as an exported `shareFailureCode(error)`) → `not-found`; content drift after re-embed (`shareSourceFingerprint` mismatch) → `conflict`; anything else → `storage`.
- Produces: `share(id, target, p, a, { allowSensitive = false } = {})` → `MemoryShareResult`.

- `target` must be `"workspace"` or `"user"` (else `invalid-input`).
- Call `resolve(p, a, { destructive: true, target })`. For `target === "workspace"` the memory context must carry a workspace principal; for `"user"` a user principal. When missing → `denied`, mirroring the adapter's `requireWorkspace`/`requireUser`.

- [ ] **Step 1: Write the failing tests:**
  - (a) Share to `workspace` → `sharedId` set; `list` for a second agent in the same workspace returns the shared card with `scope: "workspace"`.
  - (b) A card the sensitivity check flags (reuse the fixture text of the existing share-sensitivity test in `tests/`; grep `sensitiveShareReason`) → `approval-required`. The same call with `{ allowSensitive: true }` succeeds.
  - (c) An inferred principal → `denied`.
  - (d) `target: "everyone"` → `invalid-input`.
  - (e) Sharing `anna`'s card as `bernd` → `not-found`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement, move `sourceDenied` into `memory-edit.js` as `shareFailureCode`, and point the adapter's `sourceDenied` at it (one-line change; behaviour identical).
- [ ] **Step 4:** Run the file plus `node --test tests/adapter-register-commands.test.js`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(memory-ops): share with explicit-approval flow as a typed refusal`.

### Task 7: E1 `state`

**Files:**
- Modify: `engine/memory-ops/read.js` (add `state`)
- Modify: `engine/create-engine.js`
- Test: `tests/e1-memory-ops-read.test.js` (extend)

**Interfaces:**
- Consumes: the private pool's per-agent DB (`pool.withReadDb` or the accessor `queryMemoryAcrossAccessPools` uses; read `lib/shared-memory.js` `withAccessReadDbs`) and `MemoryDB`'s row count (`engine/store/memory-db.js:986` uses `this.table.countRows()`); `readTombstonesFromRegistry(baseDbPath, agentId)` (`lib/tombstone.js:293`).
- Produces: `state(p, a)` → `MemoryState`.

- Counts are **live** cards only: active or status null, not expired. Count with a filtered `countRows(filter)` using the same `lifecycleSql` as `memory-query.js`, so a forgotten card drops out.
- A pool that is not reachable for this principal (no workspace or user principal) or fails to open reports `null` for its count, never throws.
- `tombstones` counts committed registry entries.
- `archiveDir` comes from the context.

- [ ] **Step 1: Write the failing test:** two captured facts → `cards.agentPrivate === 2`; after one `forget` → `1`, and `tombstones === 1`. For a principal without a user principal, `cards.user === null`. `archiveDir` ends with `memory/_archive` (use `path.join` for the expected value so the test also passes on Windows).
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement and wire.
- [ ] **Step 4:** Run the read test file. Expected: PASS.
- [ ] **Step 5:** Commit `feat(memory-ops): state — live card counts per scope, tombstones, archive dir`.

### Task 8: E1 adapter consumes `engine.memory`, docs, gate, PR

**Files:**
- Modify: `adapter/openclaw/register-commands.js` (`runMemoryCommand` ~640-668, `runForgetCommand` 672-743, `runCorrectCommand` 745-964, share handler ~1175-1235)
- Modify: `adapter/openclaw/plugin.js` (hand the engine instance, or `engine.memory`, to `registerChatCommands` if not already in `ctx`)
- Modify: `CHANGELOG.md`, `docs/` engine contract page (whichever file documents `Engine` members; `grep -rln "runCommand" docs`), `AGENTS.md` if it lists the engine surface
- Test: `tests/adapter-register-commands.test.js` (extend)

- For each slash command, keep in the adapter: parsing, LLM input normalisation (`normalizeCommandInput`), candidate disambiguation (`resolveCandidates`), the nonce confirmation store, locale, rendering, and `checkAuth`. Replace the final effect call:
  - `forgetCard(...)` → `engine.memory.forget(targetId, principal, agentContext)`
  - `correctCard(...)` → `engine.memory.correct(...)`
  - `registeredShareCard(...)` → `engine.memory.share(...)`, with `allowSensitive: true` on the confirmed path
  - `queryMemoryAcrossAccessPools(...)` in `runMemoryCommand` stays as is, because `/memory` needs `--explain` and filter syntax that `MemoryListQuery` does not model. Note this in a code comment as deliberate.
- The adapter builds `principal` and `agentContext` from its `memoryCtx` with `principalFromMemoryContext(memoryCtx, trust)` (`engine/identity/principal.js:118`). `agentContext` is `{ origin: "user", background: false }` for a slash command typed by a person.
- Map `MemoryOpError.code` back to today's localized replies: `not-found` → the `*_not_found` key, `denied` → the existing denial reply, everything else → the `*_failed` key. The user-visible text for every existing test must be unchanged.
- `registeredShareCard` injection (`plugin.js:80,95`) stays only if a test depends on it. Otherwise remove the injection seam and its fallback.

- [ ] **Step 1: Write the failing test.** In `tests/adapter-register-commands.test.js`, a `/forget` confirm flow asserts that `engine.memory.forget` was called once with a principal whose `agentId` matches and `agentContext.origin === "user"`, using a spy wrapped around the real engine's `memory.forget`.
- [ ] **Step 2:** Run. Expected: FAIL (the adapter still calls `forgetCard` directly).
- [ ] **Step 3:** Rewire the four handlers.
- [ ] **Step 4:** Full gate: `npm run lint && npm test && TZ=UTC node --test tests/golden-prefix.test.js`. Expected: all green, golden 9/9, and every pre-existing adapter command test passes unchanged.
- [ ] **Step 5:** CHANGELOG entry: under "Unreleased — contract 1.5.0", the six `Engine.memory` members, the error codes, `runCommand` deprecated, and archives under `<stateDir>/memory/_archive` (unchanged for OpenClaw). Update the engine contract doc.
- [ ] **Step 6:** Commit `feat(adapter): slash commands forget/correct/share run through Engine.memory`. Hand over: bundle `origin/main..feat/e1-memory-ops`; the owner pushes and opens the PR (title `feat(engine): E1 — typed MemoryOps (contract 1.5.0)`).
