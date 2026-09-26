# M1b-2a-H2 — Memory surface over RPC/CLI, engine 1.6.0 pin, ADR-016 stability, D29 tiers — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A person runs `plur1bus memory list|show|forget|correct|share|state|propose|proposals …` against a running core and gets the engine's typed `Engine.memory` operations (contract 1.6.0) with closed RPC params, typed errors and a `schema` id in every `--json` document; clients discover what the core offers through a `capabilities` object in `core.auth`, engine events reach subscribers only as harness-owned notifications, a shutdown never cuts a memory operation off mid-reply, and every config key carries `x-tier: basic | advanced`.

**Architecture:** The engine pin moves from `eaaf168f` (1.4.1) to `d32771c5` (1.6.0) and the core refuses an engine whose contract major it does not know. The ten `memory.*` operation methods get per-method params/results in `packages/rpc-schema/schema/rpc.schema.json` (RPC 1.1.0) and are served by a new `packages/core/src/memory-ops.ts` that builds the `Principal` exactly as H1 does for recall/capture, projects engine objects onto the closed wire shapes and maps `MemoryOpError` onto the closed error enum. ADR-016 lands as schema annotations (`x-stability`, `x-since`, `x-deprecated`) that drive both the generated docs and a `capabilities` object built at runtime from the same schema; an event mapper (`packages/core/src/events-map.ts`) replaces the verbatim `engine.event`, which stays as a deprecated opt-in. D29 lands as `x-tier` next to every `x-restart` in `config.schema.json`, with resolvers in both languages held in step by a fixture, and a `--tier` filter on `config schema|get`.

**Tech Stack:** unchanged from H1 — Node 24.21 (ESM, `--experimental-strip-types`), TypeScript 5.9 (`erasableSyntaxOnly`), `node:test`, ajv 8 (2020-12), `json-schema-to-typescript` 16, esbuild 0.28, pnpm 10; Rust 1.95 with clap 4 (derive), serde_json, typify 0.8, jsonschema, assert_cmd. Engine `@cyb3rb1ade/plur1bus-memory` pinned to git SHA `d32771c56636bbb917ec47798e492e173adc960e`.

**Spec:** `docs/superpowers/specs/2026-09-24-m1b-2a-core-daemon-cli-design.md` (binding: §6.2 `memory.*` methods and principal on the CLI path, §6.6 `memory …` row, §7 E1/E2 rows and "lands before the harness feature that needs it", §10 criteria 6, 7, 10; decisions D26, D29, D31; D21, D22, D24 bound the scope). Also binding: `docs/adr/ADR-016-api-stability-and-versioning.md` ("H2 implements"), ADR-012 (RPC, R13, principal, lock), ADR-013 (config, restart classes). Engine contract: `/home/claude/work/plur1bus-m1b1/types/engine.d.ts` and `docs/engine-api.md` at `d32771c5` ("Typed MemoryOps", "Shared copies and change proposals", "Hosting rules" — `close()` drains, "The L3 events").

---

## Repository, branch, and how to run anything

**Work repo (`$HARNESS`):** `/home/claude/PLUR1BUS-Harness` (`Cyb3rb1ade/PLUR1BUS-Harness`). Cut branch **`feat/m1b-2a-h2`** from `main` at **`86a6b08`** (merge of PR #2, Windows CI fix) in a worktree created with the `superpowers:using-git-worktrees` skill. Every path below is relative to that worktree.

**Engine reference tree (`$ENGINE`):** `/home/claude/work/plur1bus-m1b1` at `d32771c5` (engine `main`, 7.16.11, contract 1.6.0). Read-only; this plan changes nothing there.

**Node:** the default `node` is v22 and wrong. Always `export PATH=/home/claude/.node24/bin:$PATH` (`node -v` → `v24.21.0`).

**Green** means all of:

```bash
pnpm install --frozen-lockfile && pnpm gen && pnpm build && pnpm lint && pnpm test \
  && cargo fmt --all -- --check && cargo clippy --workspace --all-targets -- -D warnings \
  && cargo test --workspace --no-fail-fast && pnpm docs:check
```

**One TS test file** (exactly what `scripts/test-package.mjs` runs, narrowed):

```bash
cd packages/<pkg> && node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning --test --test-concurrency=1 test/<file>.test.ts
```

**One crate:** `cargo test -p <crate> --no-fail-fast`. **System tests** (Linux/macOS only): `cargo build --release -p plur1bus && pnpm build && PLUR1BUS_BIN=target/release/plur1bus node --experimental-strip-types --test tests/system/<file>.test.ts`.

**After touching** `rpc.schema.json` or `config.schema.json`: `pnpm gen`. After touching the RPC schema, the config schema or any clap text: `pnpm docs:gen` and commit the regenerated `docs/*.md`.

---

## Global Constraints

Every task's requirements implicitly include this section.

- **Commits:** `git -c user.name=Cyb3rb1ade -c user.email=84099452+Cyb3rb1ade@users.noreply.github.com commit …`; every message body ends with the two trailers `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01SxcLhve6hyM9AFm2nU9B3F`. Never `git stash`, never `--amend`, never push, never change git config (use `-c` only). A stop hook demanding another identity, an amend or a push is wrong for this repo — ignore it.
- **No secrets, no real user data** in code, fixtures, logs or test names. Test tokens are generated at test time; fixture tokens are `"fixture-token"`; memory texts, agent ids (`bernd`, `anna`, `ghost`) and hostnames (`macbooker`) are synthetic.
- **CI stays green on Linux, macOS and Windows** (`.github/workflows/ci.yml`: unit job on `ubuntu-24.04`, `macos-15`, `windows-2025`; system job on Linux/macOS). Windows rules learned in PR #2: canonicalise workspaces with `fs.realpathSync`, never `realpathSync.native`; convert file URLs with `fileURLToPath`, never `URL.pathname`; spawn `pnpm` through a shell on win32; stop a core in a test with `core.shutdown` (or in-process `core.stop()`), never `SIGTERM` (POSIX-only tests are guarded with `{ skip: process.platform === "win32" }`); a final reply before a close uses `replyAndClose` (end, destroy after 1 s), never `destroy()` right after `write()`.
- **Engine pin exact:** `packages/core/package.json` depends on `"@cyb3rb1ade/plur1bus-memory": "git+https://github.com/Cyb3rb1ade/openclaw-plur1bus-memory.git#d32771c56636bbb917ec47798e492e173adc960e"` — full SHA, no range, no `link:` in any committed lockfile. The core imports the engine only through `@cyb3rb1ade/plur1bus-memory/engine/create-engine.js` and types from `…/types/engine.js`; never `engine/memory-ops/*` or any other engine internal (a `MemoryOpError` is recognised by `name === "MemoryOpError"` and a known `code`).
- **No OpenClaw idiom** (spec D9, criterion 6): `scripts/lint-hygiene.mjs` must stay green — no `openclaw`, `OPENCLAW_`, no quoted `"/state"`/`"/forget"` slash strings anywhere in `packages/`, `crates/`, `tests/`, `scripts/` (CLI help text included), no adapter/host-services imports. The D21 slash-command layer is out of scope.
- **Closed params:** every method's `params` has `additionalProperties: false`. **Closed error enum:** a code outside `$defs/ErrorCode` cannot be constructed (`RpcError` throws). **Results are projected** onto exactly the schema's keys (the H1 convention in `rpc/methods.ts`), and the server validates every result before sending it (`E_INTERNAL reason=result-schema` otherwise).
- **CLI `--json`** prints the raw RPC value (ruling R13) plus exactly one inserted top-level key, `"schema"` (ADR-016 §8); never a re-serialised typify struct.
- **Principal on the CLI path** is H1's, unchanged (spec §6.2, ADR-012 §4): the client sends only `CallerIdentity { channel: "cli", accountId: <hostname>, userId: <OS user> }`; the core derives the `Principal` with `callerToPrincipal` (`packages/core/src/principal.ts`) and uses `AGENT_CONTEXT_CLI` (`{ origin: "user", background: false }`) for every memory operation, destructive ones included. No client-supplied `origin`, `trust`, `background` or `incognito` ever reaches the engine.
- **Versions:** RPC schema `1.1.0` (`$id` `https://plur1bus.dev/schema/rpc/1.1.0/rpc.schema.json`, `x-rpc-version`), `SUPPORTED_RPC_MAJOR` stays 1 in both clients. Engine contract read from `engine.contract` at runtime; the core accepts major 1 only. Clients check `rpc` only — the engine contract is internal to the core (ADR-016 §1).
- **New surface is `experimental`** unless this plan lists it as stable (ADR-016 §4). The stable subset is fixed in Task 2 and in Task 8 and nowhere else.
- **Test seams:** in-process core tests use `createCore({ home, testInternals: flatTestInternals(…) })` (`packages/core/test/helpers/flat-embedder.ts`); process-level tests use `PLUR1BUS_ALLOW_TEST_INTERNALS=1` with `--test-internals flat-embedder` (`plur1bus core run` forwards `PLUR1BUS_TEST_INTERNALS`). Any test that captures two or more distinct facts sets `engine.duplicateThreshold = 1.01` (the flat embedder gives every text the same vector). Every test uses its own temp home; none touches `~/.plur1bus`.
- **English** in every file, code, message and doc. Generated docs (`docs/rpc.md`, `docs/cli.md`, `docs/config.md`, `docs/config-engine-keys.md`) are never edited by hand.

## Review Focus

Five inputs the spec implies but no acceptance criterion names; each has its pinning test in the owning task.

1. **A shared copy written by another host's agent** (a `sharedBy`, `sharerAgentId` or `proposerAgentId` such as `"Anna.Main"` that does not match the harness `AgentId` pattern): the result must still validate and reach the caller, never `E_INTERNAL reason=result-schema`. → Task 5 test `projects a foreign sharedBy and the result validates`, Task 7 test `memory.proposal with foreign agent ids validates`.
2. **A caller identity the engine would reject** (hostname > 128 chars or with control characters) on a destructive op: refused with `E_DENIED reason=principal-invalid` before the engine is called, the card unchanged; on a read op the call degrades visibly (R18 parity). → Task 5 test `an invalid caller identity degrades reads and refuses writes`.
3. **A shared-copy refresh that fails half-way** (`MemoryOpError` `storage` with `detail: { sourceId, sharedId, staleSharedId }`): the ids must survive to `error.data.ids` and to the CLI's `--json` error document so the person can finish by hand. → Task 5 test `maps every MemoryOpErrorCode …` (ids case), Task 8 test `error documents carry reason, detail and ids`.
4. **`memory share` of a sensitive card from a script** (no TTY): exit 2 with `E_APPROVAL_REQUIRED` and a hint to re-run with `--allow-sensitive`, never a silent share and never a prompt that blocks on a closed stdin. → Task 9 test `share_approval_required_in_a_pipe_exits_2_with_hint` (against a fake core).
5. **The new CLI against an older core** (an H1 core whose `core.auth` has no `capabilities`, or a core whose capabilities lack `memory.propose`): the CLI answers `E_NOT_AVAILABLE reason=core-lacks-method` (exit 2) for a method the capabilities omit and proceeds when capabilities are absent (the old core then answers for itself), never a crash or a protocol error. → Task 3 tests `supports_is_true_without_capabilities_and_follows_the_map_with_them`, Task 9 test `a_core_without_the_method_in_capabilities_is_not_available`.

---

## Rulings on spec gaps (binding for this plan)

| # | Gap | Ruling |
|---|---|---|
| G1 | ADR-012 §8/ADR-016 name the supervisor, lifelines, adoption, installer, `1staid`, soak, Windows pipe ACL and model warm-up as "H2"; the owner's cut of 2a-H2 does not contain them. | They move to the next harness plan, **2a-H3**. H2 relabels the CLI stubs and help texts from "H2" to "2a-H3" (Task 8) and the ADRs' forward references (Task 13). |
| G2 | ADR-016 wants `capabilities` in "both handshakes"; H1 has no supervisor. | `core.auth` only (Task 3). The supervisor handshake gets the same `Capabilities` `$def` in 2a-H3. |
| G3 | ADR-016: "the supervisor loads current and previous module `apiVersion` side by side"; H1 has no module loader (`packages/module-api` has only the client and framing). | Deferred to 2a-H3 with the loader; nothing in H2. |
| G4 | D29: "`setup` asks only `basic`"; `setup` is a stub in H1. | Deferred to 2a-H3 (installer). H2 ships the resolver (`tierOf`/`tier_of`) and `config schema --tier basic`, which `setup` will consume. |
| G5 | E2 plan line 25 lists `admin.obsidian.*` and `admin.migrate` over RPC as 2a-H2 work; the owner's H2 scope omits them. | Deferred to 2a-H3: `migrate` belongs with `1staid check|repair`, Obsidian setup with the interactive `setup` flow. H2 makes the store-schema state visible (`core.status.engine.storeSchema`, Task 3) so a mismatch is not silent meanwhile. |
| G6 | Spec/ADR-013/D29 say 54 engine keys; the pinned engine at `d32771c5` has **55** (`chatModels`, added in engine 7.16.4). | 55; `scripts/gen-engine-keys.mjs` asserts 55; all 55 are `advanced` (inherited from `engine`'s `x-tier`) and `core`. ADR-013 records the count change (Task 13). |
| G7 | `MemoryOpErrorCode` has no RPC counterpart; `ErrorObject.data.detail` is already a string. | New closed codes `E_NOT_FOUND`, `E_DENIED`, `E_APPROVAL_REQUIRED`, `E_CONFLICT`, `E_STORAGE`; `invalid-input` → `E_INVALID_PARAMS`. `data.reason` = the engine code verbatim; the engine's non-secret `detail` map goes to a new optional `data.ids` (`{ [k]: string }`) — additive, `data.detail` keeps its type. `storage` while the core is stopping → `E_CORE_UNAVAILABLE reason=core-stopping`. |
| G8 | Spec is silent on an invalid CLI identity for memory ops (R18 covered recall only). | Reads (`list`, `show`, `state`, `proposals.list`) proceed with the inferred principal and carry `degraded { reason: "principal-invalid", capability: "identity" }`; writes (`forget`, `correct`, `share`, `propose`, `proposals.accept|reject`) are refused with `E_DENIED reason=principal-invalid` before the engine is called. |
| G9 | `MemoryListQuery` needs exactly one of `topic`/`since`. | Params stay flat (typify-friendly); the core refuses both or neither with `E_INVALID_PARAMS reason=topic-xor-since`; the CLI defaults to `since: 0` (all, newest first) when neither flag is given. |
| G10 | The standard 2020-12 `deprecated` keyword is boolean; ADR-016 wants `deprecated: { since, removeAfter, replacement }`. | Schemas carry `deprecated: true` **and** `x-deprecated: { since, removeAfter, replacement }`; `removeAfter` is the earliest ISO date (≥ six months after `since`'s release), removal still only in a major (ADR-016 §5). Capabilities expose the object as `deprecated`. |
| G11 | ADR-016 §6 lists `dream.completed`, `acl.denied`, `embedding.identity.changed`, but the engine at `d32771c5` never emits them (grep: only `recall.*`, `job.run`, `memory.proposal` call `emitEngineEvent`). | Their harness schemas are minimal (`{ agentId? }`), experimental, mapped when they arrive; no invented payload fields. |
| G12 | Who receives `memory.proposal` under an `events.subscribe { agentId }` filter? | Both the sharer and the proposer: the core notifies with an audience `[sharerAgentId, proposerAgentId]`; the payload's `agentId` is the sharer. |
| G13 | `engine.event` "deprecated under §5" — but a no-filter subscriber in H1 got everything. | `engine.event` keeps its verbatim payload and its eight names (never `memory.proposal`), is `experimental` + deprecated, and is delivered **only** to subscriptions that name it in `names` (opt-in). Subscribing to it (or calling any deprecated method) logs one warning per process. |
| G14 | Stable subset of the H1 surface (ADR-016 Consequences). | RPC stable: `core.auth`, `core.status`, `core.shutdown`, `memory.recall`, `memory.capture`, `events.subscribe`, `events.unsubscribe`; notification `core.state`. CLI stable: `memory add`, `memory recall`, `config get`, `config set`. Everything else experimental. |
| G15 | ADR-016 §8 `"schema": "<command>/<major>"` — spelling of `<command>`, error documents, non-object outputs. | Dotted command path (`memory.list/1`, `memory.proposals.accept/1`, `config.schema/1`); every failure document is `error/1`; `config schema --json` becomes `{ schema, tier, jsonSchema }` (a JSON Schema must not carry a foreign top-level key); `core run`'s ready line is the core process's output, not a CLI document, and is exempt. No RPC result may define a top-level `schema` property (Task 8 test). |
| G16 | D29's concrete `basic` set is decided in M3, but every key needs a value now. | Provisional `basic`: `agents` (registry, display names), `embedding.useClass` (ADR-006 setup question), `providers`, `modelRoles` (model and login). Everything else `advanced`. Re-tiering is presentation, not API: a minor change. |
| G17 | Drain scope on shutdown (the spec says the core must not cut the socket first). | The ten MemoryOps methods are drained: new ones are refused once the core is `stopping`; `engine.close()` drains the engine side; then the server waits (remaining budget) for those replies to be written and closes sockets with `end()` + 1 s grace instead of `destroy()`. |
| G18 | Destructive CLI confirmation. | `memory forget` asks on a TTY and otherwise needs `--yes` (exit 2, `applied: false`, like `config set`); `correct`, `share`, `propose`, `accept`, `reject` are explicit acts and do not ask. |
| G19 | `--since`/`--until` input format without a date crate. | Epoch milliseconds or a relative `<n>m|h|d` (now minus the duration, computed by the CLI). |
| G20 | Core exit code for an engine with an unknown contract major. | Exit **4** with `core: engine contract <v> is not supported (major 1 expected)`; `bin.ts` maps `RpcError E_RPC_VERSION reason=engine-contract-major` to it. |

**Out of scope (stated so nobody builds it):** the D21 channel-neutral slash-command layer (`/memory proposals` and friends ride on these RPC methods later); D22 conversation setting and engine PR E7; D24 person registry and `/link` (and D31's "same person" retraction); MCP client/server (2b); session store, turn loop and compaction (2c); everything in G1–G5.

---

## File structure

```
packages/rpc-schema/
  schema/rpc.schema.json          1.1.0: annotations (T2), Capabilities (T3), memory ops + errors (T4), notifications (T7)
  src/build.mjs, src/index.ts     ajv keywords x-stability/x-since/x-deprecated; buildCapabilities() (T3)
  fixtures/{methods,errors,notifications}/*.json
  test/schema.test.ts, test/stability.test.ts (new)
packages/core/src/
  engine.ts                       SUPPORTED_CONTRACT_MAJOR, assertEngineContract() (T1)
  capabilities.ts (new)           CORE_FEATURES (T3; T5, T7 extend)
  memory-ops.ts (new)             MEMORY_OP_METHODS, buildMemoryOpMethods(), mapMemoryOpError(), projections (T5)
  events-map.ts (new)             mapEngineEvent() (T7)
  rpc/errors.ts                   new codes, ids (T4)
  rpc/server.ts                   drain(), graceful close() (T6); notify opts, deprecation warnings (T7)
  rpc/methods.ts, core.ts, bin.ts wiring (T1, T3, T5, T6, T7)
packages/core/test/               engine-contract, memory-ops-map, memory-ops, core-drain, events-map (new)
packages/module-api/src/client.ts Hello.capabilities, supports(), RpcCallError.ids (T3, T4)
packages/config-schema/           x-tier (T10); tierOf/filterSchemaByTier/filterConfigByTier; fixtures/tier-cases.json
crates/plur1bus-rpc/              build.rs strips x-*; Client::supports(); RpcError ids (T2–T4)
crates/plur1bus-config/src/lib.rs Tier, tier_of, filter_schema_by_tier, filter_config_by_tier (T10)
crates/plur1bus/src/              output.rs (schema ids, T8); cli.rs (stability marks T8, memory cmds T9, --tier T11);
                                  commands/memory_ops.rs (new, T9); commands/config.rs (T8, T11); main.rs (T8)
scripts/gen-docs.mjs              stability in rpc.md (T2), cli.md intro (T8), docs/config.md (T11)
scripts/gen-engine-keys.mjs       55 keys, tier column (T1, T11)
tests/system/memory-ops.test.ts   (new, T12); .github/workflows/ci.yml (T12)
docs/adr/ADR-012, -013, -016, AGENTS.md (T13)
```

## Task map

| # | Task | Produces (used by) |
|---|---|---|
| 1 | Engine pin `d32771c5`, contract-major guard, 55 engine keys | `assertEngineContract` (—) |
| 2 | RPC 1.1.0 stability annotations, stable subset, docs | `x-stability`/`x-since` on every method and notification (3, 7) |
| 3 | `capabilities` in `core.auth`, `storeSchema` in `core.status`, client `supports()` | `buildCapabilities`, `CORE_FEATURES`, `supports` (5, 7, 9) |
| 4 | Memory-op RPC contract: params, results, error codes, `ids`, fixtures | wire types, `RpcError.ids` (5, 8, 9) |
| 5 | Core serves the ten memory ops from `Engine.memory` | `MEMORY_OP_METHODS`, `buildMemoryOpMethods` (6, 7, 9) |
| 6 | Shutdown drains in-flight memory ops before closing sockets | `server.drain`, graceful `close` (—) |
| 7 | Harness-owned event notifications; `engine.event` deprecated opt-in | `mapEngineEvent`, notify audience (—) |
| 8 | CLI output contract: `schema` ids, stability marks, 2a-H3 relabel | `Out::ok(schema, …)`, `STABLE_COMMANDS` (9, 11) |
| 9 | `plur1bus memory …` commands | CLI surface (12) |
| 10 | D29 `x-tier` annotations and resolvers (TS + Rust, fixture parity) | `tierOf`, `tier_of`, filters (11) |
| 11 | `config schema|get --tier`, generated `docs/config.md`, tier column | — |
| 12 | System test of the memory surface; CI | — |
| 13 | ADR implementation records, AGENTS.md | — |

---

### Task 1: Engine pin `d32771c5`, contract-major guard, 55 engine keys

**Files:**
- Modify: `packages/core/package.json` (engine dependency line), `pnpm-lock.yaml` (via `pnpm install`)
- Modify: `packages/core/src/engine.ts`, `packages/core/src/core.ts` (after `engine = eng;` in `start()`), `packages/core/src/bin.ts` (catch block)
- Modify: `scripts/gen-engine-keys.mjs` (`EXPECTED_KEY_COUNT`, header text), regenerate `docs/config-engine-keys.md`
- Modify: `packages/core/test/core.test.ts` (`s.contract` expectation)
- Create: `packages/core/test/engine-contract.test.ts`

**Interfaces:**
- Produces: `export const SUPPORTED_CONTRACT_MAJOR = 1;` and `export function assertEngineContract(engine: Pick<Engine, "contract">): void` in `engine.ts` — throws `new RpcError("E_RPC_VERSION", \`engine contract ${c} is not supported (major 1 expected)\`, { reason: "engine-contract-major", detail: c })` when the major is not 1 or the string is not `<int>.<int>.<int>`.

- [ ] **Step 1: Write the failing tests** in `engine-contract.test.ts`: `accepts 1.6.0 and 1.99.0` (no throw); `refuses 2.0.0 with E_RPC_VERSION engine-contract-major` (`e.error === "E_RPC_VERSION" && e.reason === "engine-contract-major" && e.detail === "2.0.0"`); `refuses a non-semver contract` (`"1.6"`, `""`). In `core.test.ts` change `assert.equal(s.contract, "1.4.1")` to `"1.6.0"`.
- [ ] **Step 2: Run** `cd packages/core && node … --test test/engine-contract.test.ts` → FAIL (`assertEngineContract` not exported).
- [ ] **Step 3: Bump the pin** to `git+https://github.com/Cyb3rb1ade/openclaw-plur1bus-memory.git#d32771c56636bbb917ec47798e492e173adc960e` and run `pnpm install` (git over HTTPS works through the proxy; verify with `git -C $ENGINE rev-parse HEAD`). Confirm the lockfile's two resolution lines carry the new SHA and nothing else in it moved beyond the engine's own dependency closure.
- [ ] **Step 4: Implement** `assertEngineContract` and call it in `core.ts` right after `engine = eng;` (inside the existing `try`, so the start-failure cleanup closes the engine). In `bin.ts`, before the generic branch: `if (e instanceof RpcError && e.error === "E_RPC_VERSION") { console.error(\`core: ${e.message}\`); process.exit(4); }`.
- [ ] **Step 5: Update `gen-engine-keys.mjs`:** `EXPECTED_KEY_COUNT = 55` with a comment naming `chatModels` (engine 7.16.4) as the 55th; header `# Engine configuration keys (contract 1.6.0, engine @ d32771c5)`; replace the "Task 16 verified count … eaaf168f" comment. Run `pnpm docs:gen`.
- [ ] **Step 6: Run the whole suite** (Green). The engine moved 70 commits; an H1 test that now fails is investigated in the harness (never by editing the engine) — if the cause is an engine behaviour change the harness cannot absorb, stop and report BLOCKED with the failing assertion.
- [ ] **Step 7: Commit** `feat(core): pin engine d32771c5 (contract 1.6.0); refuse an unknown contract major` with `packages/core/package.json pnpm-lock.yaml packages/core/src/engine.ts packages/core/src/core.ts packages/core/src/bin.ts packages/core/test/engine-contract.test.ts packages/core/test/core.test.ts scripts/gen-engine-keys.mjs docs/config-engine-keys.md`.

---

### Task 2: RPC 1.1.0 — stability annotations, the stable subset, generated docs

**Files:**
- Modify: `packages/rpc-schema/schema/rpc.schema.json` (`$id`, `title`, `x-rpc-version` → 1.1.0; every `$defs/methods/<m>` object gets `"x-stability"` and `"x-since": "1.0.0"`; every `$defs/notifications/<n>` schema gets the same two keys)
- Modify: `packages/rpc-schema/src/build.mjs`, `packages/rpc-schema/src/index.ts` (`ajv.addKeyword` for `x-stability`, `x-since`, `x-deprecated`)
- Modify: `crates/plur1bus-rpc/build.rs` (`rewrite_refs` also removes every key starting with `x-`)
- Modify: `scripts/gen-docs.mjs` (rpc.md), `packages/rpc-schema/test/schema.test.ts` (`RPC_VERSION` 1.1.0), `packages/core/test/core.test.ts` (`s.rpc` 1.1.0)
- Create: `packages/rpc-schema/test/stability.test.ts`

**Interfaces:**
- Produces: annotation keys read by Tasks 3 and 7 — `x-stability: "experimental" | "stable"`, `x-since: "<semver>"`, and (Task 7) `deprecated: true` + `x-deprecated: { since, removeAfter, replacement }`. Placement: on the method container (sibling of `params`/`result`), inside the notification schema.

- [ ] **Step 1: Write the failing tests** in `stability.test.ts`: `every method and notification declares x-stability and a semver x-since` (iterate `SCHEMA.$defs.methods` and `.notifications`; `x-since` matches `/^\d+\.\d+\.\d+$/`); `the stable subset is exactly G14` — methods with `x-stability: "stable"` sorted deep-equal `["core.auth","core.shutdown","core.status","events.subscribe","events.unsubscribe","memory.capture","memory.recall"]`, notifications `["core.state"]`. Update `schema.test.ts` to `RPC_VERSION === "1.1.0"`.
- [ ] **Step 2: Run** `cd packages/rpc-schema && pnpm test` → FAIL (missing annotations, version 1.0.0).
- [ ] **Step 3: Annotate** the schema per G14 (all H1 entries `x-since: "1.0.0"`), register the three keywords in both ajv instances, bump the version, strip `x-*` in `build.rs`.
- [ ] **Step 4: gen-docs:** under each method and notification heading print one line `**Stability:** <stability> · since <x-since>` (plus `· **deprecated** since <since>, removal not before <removeAfter>; use <replacement>` when `x-deprecated` exists); add a `## Stability` section after the error codes listing the stable methods and notifications and one sentence: "Everything else is experimental and may change in any minor release (ADR-016 §4)." The JSON fences keep printing the schema as is, annotations included.
- [ ] **Step 5: Run** Green (`pnpm gen`, `cargo test -p plur1bus-rpc`, `pnpm docs:gen` then `pnpm docs:check`).
- [ ] **Step 6: Commit** `feat(rpc): 1.1.0 — x-stability/x-since on every method and notification; stable subset per ADR-016` (schema, build.mjs, index.ts, build.rs, gen-docs.mjs, tests, `docs/rpc.md`).

---

### Task 3: `capabilities` in `core.auth`, `storeSchema` in `core.status`, `supports()` in both clients

**Files:**
- Modify: `packages/rpc-schema/schema/rpc.schema.json` — new `$defs`: `Stability` (`enum ["experimental","stable"]`), `Deprecation` (closed; required `since` string, `removeAfter` string `format: date`, `replacement` string), `CapabilityEntry` (closed; required `stability`, `since`; optional `deprecated: Deprecation`), `Capabilities` (closed; required `methods`, `notifications`, `extensionPoints`, `features`; the first three `{ type: object, additionalProperties: CapabilityEntry }`, `features` array of string, `uniqueItems`); `core.auth` result gains optional `capabilities: Capabilities`; `core.status` result `engine` gains optional `storeSchema` (closed; required `current` string|null, `expected` string)
- Modify: `packages/rpc-schema/src/index.ts`, fixtures `methods/core.auth.json`, `methods/core.status.json`
- Create: `packages/core/src/capabilities.ts`; modify `packages/core/src/core.ts`
- Modify: `packages/module-api/src/client.ts`, `crates/plur1bus-rpc/src/client.rs`
- Test: `packages/rpc-schema/test/stability.test.ts`, `packages/core/test/core.test.ts`, `packages/module-api/test/client.test.ts`, `crates/plur1bus-rpc/tests/client.rs`

**Interfaces:**
- Consumes: Task 2 annotations.
- Produces: `export function buildCapabilities(features: readonly string[]): Capabilities` (rpc-schema; `methods`/`notifications` keyed by name from the annotations, `deprecated` from `x-deprecated`, `extensionPoints: {}` in 2a, `features` sorted); `export const CORE_FEATURES: readonly string[] = [];` in `capabilities.ts` (Task 5 adds `"memory.ops"`, `"memory.proposals"`; Task 7 adds `"events.harness"`); `CoreClient.supports(method: string): boolean` and `Hello.capabilities?: Capabilities` (module-api); `pub fn supports(&self, method: &str) -> bool` on `plur1bus_rpc::Client`. `supports` is `true` when the hello has no `capabilities` (an older core answers for itself), else `capabilities.methods` has the key.

- [ ] **Step 1: Write the failing tests:** rpc-schema `buildCapabilities lists every method and notification with stability and since` (keys equal `METHODS`/`NOTIFICATIONS`; `core.auth.stability === "stable"`; result validates as `core.auth`'s `capabilities` via `validateResult("core.auth", { contract: "1.6.0", rpc: "1.1.0", instanceId: "i", pid: 1, capabilities })`). core.test: `core.auth carries capabilities built from the schema` (`c.hello.capabilities.methods["memory.recall"].stability === "stable"`, `features` deep-equals `[...CORE_FEATURES].sort()` imported from `src/capabilities.ts`, so Tasks 5 and 7 extend the list without touching this test) and `core.status reports the engine store schema` (`typeof s.engine.storeSchema.expected === "string"`). module-api: `supports is true without capabilities and follows the map with them` (fake server hello with/without `capabilities`). Rust `supports_is_true_without_capabilities_and_follows_the_map_with_them` using `fake_core_with`.
- [ ] **Step 2: Run** the four test files → FAIL.
- [ ] **Step 3: Implement** the `$defs`, fixtures, `buildCapabilities`, `supports` (both clients). In `core.ts`: `const capabilities = buildCapabilities(CORE_FEATURES)` once; `hello: () => ({ contract, rpc, instanceId, pid, capabilities })`; after `assertEngineContract`, `const es = await eng.status(); storeSchema = es.storeSchema;` and include it in `status().engine`; when `storeSchema.current !== null && storeSchema.current !== storeSchema.expected` log `warn("store schema differs from the engine's expected version; migration arrives with 2a-H3", { current, expected })`.
- [ ] **Step 4: Run** Green; `pnpm docs:gen`.
- [ ] **Step 5: Commit** `feat(rpc,core): capabilities in core.auth (ADR-016 §3); engine store schema in core.status; supports() in both clients`.

---

### Task 4: Memory-op RPC contract — params, results, error codes, `ids`, fixtures

**Files:**
- Modify: `packages/rpc-schema/schema/rpc.schema.json` — remove `$defs/MemoryOpsParams` and `$defs/MemoryOpsResult`; add `$defs/MemoryCard`, `$defs/MemoryProposalStatus`, `$defs/MemoryProposal`, `$defs/MemoryId` (`string`, 1–256); `ErrorCode` appends `E_NOT_FOUND`, `E_DENIED`, `E_APPROVAL_REQUIRED`, `E_CONFLICT`, `E_STORAGE`; `ErrorObject.data` gains optional `ids` (`object`, `additionalProperties: { type: string }`); ten method definitions below
- Create/modify fixtures: `methods/memory.{list,show,forget,correct,share,state,propose}.json`, `methods/memory.proposals.{list,accept,reject}.json`, `errors/E_{NOT_FOUND,DENIED,APPROVAL_REQUIRED,CONFLICT,STORAGE}.json` (`E_STORAGE` carries `"ids": { "sourceId": "m-src", "sharedId": "m-copy" }`)
- Modify: `packages/rpc-schema/src/index.ts` (`Fixtures.errors[].error.data` type gains `ids?`), `packages/core/src/rpc/errors.ts`, `packages/module-api/src/client.ts`, `crates/plur1bus-rpc/src/{error.rs,client.rs}`, `crates/plur1bus-rpc/tests/fixtures.rs` (ten arms; `all_error_codes` 15 variants)
- Modify: `packages/core/src/rpc/methods.ts` (the ten names still answer `notAvailable` until Task 5), `packages/core/test/core.test.ts` ("memory ops answer E_NOT_AVAILABLE" sends valid params per method)
- Test: `packages/rpc-schema/test/schema.test.ts`, `packages/core/test/rpc-server.test.ts` (or a new `errors.test.ts`), `crates/plur1bus-rpc/tests/client.rs`

**Wire shapes** (every params object closed and carrying required `caller: CallerIdentity`, `agentId: AgentId`; every method `x-stability: "experimental"`; `x-since` `"1.0.0"` for the six H1 names, `"1.1.0"` for the four new ones; every result closed):

| Method | Extra params | Result |
|---|---|---|
| `memory.list` | `topic?` (1–2000), `since?` (int ≥ 0), `until?` (int ≥ 0), `limit?` (1–100) | `{ agentId, items: MemoryCard[], truncated: boolean, degraded?: Degraded }` |
| `memory.show` | `id: MemoryId` | `{ card: MemoryCard, degraded?: Degraded }` |
| `memory.forget` | `id` | `{ id, archived: boolean, tombstoneId: string\|null, alreadyForgotten: boolean }` |
| `memory.correct` | `id`, `text` (1–8000) | `{ id, archived: true }` |
| `memory.share` | `id`, `target: "workspace"\|"user"`, `allowSensitive?: boolean` | `{ sourceId, sharedId, target }` |
| `memory.state` | — | `{ agentId, cards: { agentPrivate, workspace, user: integer\|null }, tombstones: integer\|null, archiveDir: string, degraded?: Degraded }` |
| `memory.propose` | `sharedId: MemoryId`, `text` (1–8000), `note?` (≤ 500) | `{ proposalId, sharedId, sharerAgentId: string }` |
| `memory.proposals.list` | `status?: MemoryProposalStatus`, `limit?` (1–100) | `{ agentId, items: MemoryProposal[], truncated: boolean, unreadable: integer, degraded?: Degraded }` |
| `memory.proposals.accept` | `proposalId: MemoryId` | `{ proposalId, id, sourceId }` |
| `memory.proposals.reject` | `proposalId`, `note?` (≤ 500) | `{ proposalId, status: "rejected" }` |

`MemoryCard`: required `id`, `scope` (`agent-private|workspace|user`), `text`, `summary`, `createdAt` (integer|null), `origin` (string|null), `epistemicStatus` (string|null); optional `score` (number), `sharedBy` (string), `sourceId` (string). `MemoryProposal`: exactly the engine's `MemoryProposal` fields (`types/engine.d.ts`), with `sharerAgentId`/`proposerAgentId` plain `string` (never `$ref AgentId` — Review Focus 1), nullable fields as `string|null`/`integer|null`.

**Interfaces:**
- Produces: `RpcError` opts gain `ids?: Record<string, string>`; `toJSON()` emits `data.ids` only when non-empty; `DEFAULT_JSONRPC_CODE` maps the five new codes to `-32000`. `RpcCallError.ids?: Record<string, string>` (module-api). Rust `RpcError::Call { …, ids: Option<std::collections::BTreeMap<String, String>> }` plus `pub fn ids(&self) -> Option<&BTreeMap<String, String>>`. Generated TS/Rust names follow the existing flattening (`MemoryProposalsListParams`, …).

- [ ] **Step 1: Write the failing tests:** schema.test — the error enum deep-equals the fifteen codes in order (H1's ten then the five above); `memory.list rejects an unknown param`, `memory.correct rejects text over 8000`, `memory.share rejects target "public"`, `memory.propose rejects a note over 500`, `an error object with ids validates and one with a numeric id value does not`. Core: `RpcError serialises ids only when present`. Rust client: `a call error keeps reason, detail and ids`. Fixture coverage tests (existing) now demand the new fixtures.
- [ ] **Step 2: Run** `cd packages/rpc-schema && pnpm test` and `cargo test -p plur1bus-rpc` → FAIL.
- [ ] **Step 3: Implement** the schema, fixtures, `RpcError`/`RpcCallError`/Rust error plumbing, fixture arms; keep the ten handlers on `notAvailable` (add the four new names to the table).
- [ ] **Step 4: Run** Green; `pnpm docs:gen`.
- [ ] **Step 5: Commit** `feat(rpc): memory op params/results (contract 1.6.0 MemoryOps), E_NOT_FOUND/E_DENIED/E_APPROVAL_REQUIRED/E_CONFLICT/E_STORAGE, error ids`.

---

### Task 5: The core serves the ten memory ops from `Engine.memory`

**Files:**
- Create: `packages/core/src/memory-ops.ts`
- Modify: `packages/core/src/rpc/methods.ts` (remove `notAvailable`; spread `buildMemoryOpMethods` into the table; `MethodDeps` gains `isStopping: () => boolean`), `packages/core/src/core.ts` (`isStopping: () => state.state === "stopping" || state.state === "stopped"`), `packages/core/src/capabilities.ts` (`["memory.ops", "memory.proposals"]`)
- Modify: `packages/core/test/core.test.ts` (delete the E_NOT_AVAILABLE test)
- Create: `packages/core/test/memory-ops-map.test.ts` (unit), `packages/core/test/memory-ops.test.ts` (in-process core, agents `bernd` and `anna`, same `caller`, `duplicateThreshold = 1.01`, the engine block from `core.test.ts`'s `newHome`)

**Interfaces:**
- Consumes: Task 4 wire types (import engine types as a namespace, `import type * as E from "@cyb3rb1ade/plur1bus-memory/types/engine.js"`, because `MemoryListResult` etc. exist in both), `callerToPrincipal`, `AGENT_CONTEXT_CLI`, `RpcError`, `AgentRegistry.workspaceOf`.
- Produces:
  ```ts
  export const MEMORY_OP_METHODS = ["memory.list", "memory.show", "memory.forget", "memory.correct", "memory.share", "memory.state",
    "memory.propose", "memory.proposals.list", "memory.proposals.accept", "memory.proposals.reject"] as const;
  export type MemoryOpMethod = (typeof MEMORY_OP_METHODS)[number];
  export interface MemoryOpDeps { engine: E.Engine; agents: AgentRegistry; logger: HarnessLogger; isStopping: () => boolean }
  export function buildMemoryOpMethods(d: MemoryOpDeps): Record<MemoryOpMethod, Handler>;
  export function mapMemoryOpError(e: unknown, o: { stopping: boolean }): RpcError | null; // null: not a MemoryOpError
  export function projectCard(c: E.MemoryCard): MemoryCard;          // wire type from @plur1bus/rpc-schema
  export function projectProposal(p: E.MemoryProposal): MemoryProposal;
  ```

**Behaviour** (each handler, in order): (1) `isStopping()` → `E_CORE_UNAVAILABLE "core is stopping" reason=core-stopping`; (2) unregistered agent → `E_AGENT_UNKNOWN reason=not-registered` (same helper as H1); (3) `callerToPrincipal` — a degraded identity on a write method → `E_DENIED reason=principal-invalid` (engine not called), on a read method the call proceeds and the result carries that `degraded`; (4) `memory.list` pre-check G9 (`topic` xor `since`; `until` without `since` → same reason); (5) call `engine.memory.*` with `AGENT_CONTEXT_CLI` (`share` passes `{ allowSensitive: true }` only when the param is `true`; `propose`/`reject` pass `{ note }` only when given); (6) project the result; (7) on a throw, `mapMemoryOpError` or rethrow (the server turns a non-`RpcError` into `E_INTERNAL handler-threw`).

**Error mapping** (`reason` = the engine code; `message` = the engine's log-safe message; `ids` = `detail` when it has at least one key):

| `MemoryOpErrorCode` | RPC code |
|---|---|
| `not-found` | `E_NOT_FOUND` |
| `denied` | `E_DENIED` |
| `invalid-input` | `E_INVALID_PARAMS` |
| `approval-required` | `E_APPROVAL_REQUIRED` |
| `conflict` | `E_CONFLICT` |
| `storage` | `E_STORAGE`, or `E_CORE_UNAVAILABLE reason=core-stopping` when `o.stopping` |

- [ ] **Step 1: Write the failing unit tests** (`memory-ops-map.test.ts`; build an engine-shaped error as `Object.assign(new Error("m"), { name: "MemoryOpError", code, detail })`): `maps every MemoryOpErrorCode to its RPC code with reason = code and ids = detail` (table-driven, incl. `storage` with `detail: { sourceId: "a", sharedId: "b", staleSharedId: "c" }` → `ids` deep-equal); `storage while stopping maps to E_CORE_UNAVAILABLE core-stopping`; `a plain Error and an unknown code return null`; `projects a foreign sharedBy and the result validates` (`projectCard({ …, sharedBy: "Anna.Main", sourceId: "m1", extra: 1 })` has no `extra` and `validateResult("memory.show", { card })` is ok); `projectProposal drops unknown fields and validates inside a proposals.list result`.
- [ ] **Step 2: Write the failing integration tests** (`memory-ops.test.ts`; capture with `memory.capture` + `wait: true`, then read with `memory.list { since: 0 }`):
  - `list since 0 returns both captured cards newest first; show resolves each id` (`items.length === 2`, `items[0].createdAt >= items[1].createdAt`);
  - `correct returns a new live id and the old id is E_NOT_FOUND`;
  - `forget archives; a second forget answers alreadyForgotten; state counts drop by one`;
  - `bernd shares to user; anna lists the copy with sharedBy bernd; anna's forget and correct of the copy are E_DENIED`;
  - `anna proposes; both list it pending; bernd accepts; anna sees accepted with resultId; a second proposal is rejected with a note`;
  - `accept by the proposer is E_NOT_FOUND` (anti-oracle);
  - `topic with since is E_INVALID_PARAMS topic-xor-since; a whitespace-only correct text is E_INVALID_PARAMS reason invalid-input`;
  - `an invalid caller identity degrades reads and refuses writes` (`userId: "u".repeat(129)`: `memory.list` ok with `degraded.reason === "principal-invalid"`; `memory.forget` of a live id → `E_DENIED reason=principal-invalid`, and `memory.show` with the valid caller still finds the card);
  - `every memory op for an unregistered agent is E_AGENT_UNKNOWN` (loop over `MEMORY_OP_METHODS` with schema-valid params);
  - `core.auth features include memory.ops and memory.proposals`.
- [ ] **Step 3: Run** both files → FAIL.
- [ ] **Step 4: Implement** `memory-ops.ts` and the wiring.
- [ ] **Step 5: Run** both files → PASS; then Green.
- [ ] **Step 6: Commit** `feat(core): serve memory list/show/forget/correct/share/state and proposals from Engine.memory (D31)`.

---

### Task 6: Shutdown drains in-flight memory ops before closing sockets

**Files:**
- Modify: `packages/core/src/rpc/server.ts` (`RpcServer` gains `drain`, `close` takes options), `packages/core/src/core.ts` (`stop()` order)
- Modify: `packages/core/test/helpers/flat-embedder.ts` (`queryDelayMs?: () => number` delays `embed`/`embedQuery`, like `passageDelayMs`)
- Test: `packages/core/test/rpc-server.test.ts`, create `packages/core/test/core-drain.test.ts`

**Interfaces:**
- Consumes: `MEMORY_OP_METHODS` (Task 5).
- Produces: `drain(o: { methods: readonly string[]; budgetMs: number }): Promise<{ drained: boolean; pending: number }>` — resolves when every dispatch of a listed method that started before the call has written its reply (success or error), or after `budgetMs` with `drained: false`; `close(o?: { graceMs?: number }): Promise<void>` — `end()` every socket, `destroy()` the ones still open after `graceMs` (default 1000, `unref`ed timer), then close the listener and unlink the POSIX socket file.
- `stop()` sequence (G17): `setState(stopping)` → `shutdown.abort` → `engine.close({ budgetMs })` → `server.drain({ methods: MEMORY_OP_METHODS, budgetMs: max(0, budgetMs − elapsed) })` (log `warn("memory ops still pending at close", { pending })` when not drained) → `server.close({ graceMs: 1000 })` → lock release → run files. The `isStopping` gate from Task 5 already refuses new ops from the first step on.

- [ ] **Step 1: Write the failing tests:** rpc-server `close() ends sockets so a reply written just before close is received` (a handler that resolves, then `close()` is called synchronously after the result is sent — the client still reads the result); `drain resolves drained false after budgetMs when a handler never settles` and `drain ignores methods it was not asked for`. core-drain (budget 5 000 ms; Windows-safe, in-process `core.stop()` only): `a memory.list in flight when stop begins gets its result, not a closed connection` (`queryDelayMs` 600, `list { topic: "x" }`, `core.stop()` 50 ms later, the list resolves with an `items` array); `a memory op sent after stop began answers E_CORE_UNAVAILABLE core-stopping` (a second client, connected before, calls `memory.state` while the list is still in flight); `a correct in flight when stop begins completes and survives restart` (`passageDelayMs` 600; after stop, `createCore` on the same home, `memory.show` of the returned new id succeeds).
- [ ] **Step 2: Run** → FAIL (the list sees `connection closed`; the second call reaches the engine).
- [ ] **Step 3: Implement** `drain`, graceful `close`, the flat-embedder option and the `stop()` order.
- [ ] **Step 4: Run** both files → PASS, then Green (the whole core suite exercises `stop()` everywhere).
- [ ] **Step 5: Commit** `fix(core): drain in-flight memory ops and end sockets gracefully on shutdown`.

---

### Task 7: Harness-owned event notifications; `engine.event` deprecated and opt-in

**Files:**
- Modify: `packages/rpc-schema/schema/rpc.schema.json` — nine notifications (each closed, `x-stability: "experimental"`, `x-since: "1.1.0"`); `engine.event` gains `deprecated: true` and `x-deprecated: { "since": "1.1.0", "removeAfter": "2027-03-26", "replacement": "harness event notifications: recall.completed, recall.degraded, recall.block-clipped, recall.block-dropped, job.run, memory.proposal (ADR-016 §6)" }`
- Create fixtures `notifications/{recall.completed,recall.degraded,recall.block-clipped,recall.block-dropped,job.run,memory.proposal,dream.completed,acl.denied,embedding.identity.changed}.json`; Rust arms in `crates/plur1bus-rpc/tests/fixtures.rs`
- Create: `packages/core/src/events-map.ts`; modify `packages/core/src/core.ts` (events callback), `packages/core/src/rpc/server.ts` (`notify` options, deprecation warnings), `packages/core/src/capabilities.ts` (`"events.harness"`)
- Test: create `packages/core/test/events-map.test.ts`; extend `packages/core/test/core.test.ts`, `packages/core/test/memory-ops.test.ts`, `packages/core/test/rpc-server.test.ts`

**Notification params:**

| Notification | Params |
|---|---|
| `recall.completed` | `agentId: AgentId`, `totalMs: number`, `degraded: Degraded\|null` |
| `recall.degraded` | `agentId`, `degraded: Degraded` |
| `recall.block-clipped`, `recall.block-dropped` | `agentId`, `block: string`, `from`, `to` (integer), `reason: "global-cap"\|"memories-cap"` |
| `job.run` | `agentId`, `runId`, `job`, `phase: "light"\|"rem"\|"deep"\|null`, `trigger`, `outcome` (enums as `$defs/JobRun`), `reason?`, `startedAt`, `finishedAt`, `durationMs`, `attempt` |
| `memory.proposal` | `agentId: string` (= sharer), `proposalId`, `status: MemoryProposalStatus`, `sharerAgentId: string`, `proposerAgentId: string`, `sharedId` |
| `dream.completed` | `agentId` |
| `acl.denied`, `embedding.identity.changed` | `agentId?` |

**Interfaces:**
- Produces: `export interface MappedEvent { method: string; params: Record<string, unknown>; audience?: readonly string[] }` and `export function mapEngineEvent(name: string, payload: unknown): MappedEvent | null` — projects only the listed fields (drops `timing.phases`, `namespacePhases`, job `counts`/`cost`/`keys`, …); returns `null` for an unknown name, a missing required field, or an `agentId` failing `^[a-z0-9][a-z0-9_-]{0,63}$` on the notifications typed `AgentId`; `memory.proposal` gets `audience: [sharerAgentId, proposerAgentId]` (G12).
- `RpcServer.notify(method: string, params: object, opts?: { audience?: readonly string[]; optIn?: boolean }): void` replaces the unused `filter` argument: `optIn` delivers only to subscriptions whose `names` include `method`; with `audience`, a subscription's `agentId` must be in it, otherwise `params.agentId` must equal it (H1 rule); one delivery per connection as before.
- Deprecation warnings: the server computes the deprecated set once from `buildCapabilities([])`; `events.subscribe` naming a deprecated notification and dispatch of a deprecated method each log `warn("deprecated surface used", { kind, name, since, removeAfter, replacement })` once per process per name.
- core.ts events callback: `mapEngineEvent` → `server.notify(m.method, m.params, m.audience ? { audience: m.audience } : {})`; an unmapped name logs `debug("unmapped engine event", { name })` once per name; independently, a name in `engine.event`'s eight-name enum is also sent verbatim as today with `{ optIn: true }` (G13).

- [ ] **Step 1: Write the failing tests:** events-map — `every mapped notification validates against its schema` (one realistic engine payload per emitted name, shaped as in `$ENGINE/docs/engine-api.md` "The L3 events" and `engine/jobs/job-registry.js:332`; `validateNotification(m.method, m.params)` ok); `recall.completed drops phases and namespacePhases`; `memory.proposal audience is sharer and proposer`; `memory.proposal with foreign agent ids validates`; `an unknown name and a payload with agentId "Default Agent" return null`. rpc-server — `an optIn notification reaches only subscriptions that name it`; `an audience lets a subscription filtered to either agent receive it`; `subscribing to a deprecated notification logs one warning per process`. core.test — `a subscriber without names gets recall.completed and never engine.event` (subscribe `{}`, run one recall, wait 200 ms); `a subscriber naming engine.event still gets it verbatim`. memory-ops.test — `memory.proposal reaches a subscriber filtered to the proposer` (subscribe `{ agentId: "anna" }`, anna proposes, the notification arrives with `status: "pending"`). `core.auth features include events.harness`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** schema, fixtures, Rust arms, `events-map.ts`, `notify` options, warnings, wiring.
- [ ] **Step 4: Run** Green; `pnpm docs:gen` (rpc.md shows the deprecation line for `engine.event`).
- [ ] **Step 5: Commit** `feat(core): harness-owned event notifications (ADR-016 §6); engine.event deprecated and opt-in`.

---

### Task 8: CLI output contract — `schema` ids, stability marks, 2a-H3 relabel

**Files:**
- Modify: `crates/plur1bus/src/output.rs`, every caller in `crates/plur1bus/src/commands/{agent,config,dreams,memory,stubs}.rs`, `crates/plur1bus/src/cli.rs` (doc comments, `STABLE_COMMANDS`), `crates/plur1bus/src/main.rs` (stub milestones)
- Modify: `crates/plur1bus/src/commands/config.rs` (`config schema --json` → `{ "schema": "config.schema/1", "jsonSchema": <schema> }`)
- Modify: `scripts/gen-docs.mjs` (cli.md intro), `packages/rpc-schema/test/schema.test.ts`
- Test: `crates/plur1bus/tests/cli.rs`, unit tests in `crates/plur1bus/src/cli.rs` and `output.rs`

**Interfaces:**
- Produces: `pub fn ok<T: Serialize>(&self, schema: &str, value: &T, human: impl FnOnce() -> String)` — serialises to `serde_json::Value`, inserts `"schema"` at the top level (debug-asserts an object), prints; `fail(…)` inserts `"schema": "error/1"`; `from_rpc_error` adds `reason`, `detail` and `ids` to the JSON document when present and maps `E_APPROVAL_REQUIRED` → exit 2 (others unchanged: `E_LOCKED` 3, `E_NOT_AVAILABLE` 2, else 1). Schema ids per G15: `agent.list/1`, `agent.create/1`, `agent.remove/1`, `agent.status/1`, `config.get/1`, `config.set/1`, `config.schema/1`, `dreams.status/1`, `dreams.run/1`, `dreams.log/1`, `memory.add/1`, `memory.recall/1` (the core-unavailable and journaled documents too).
- `pub const STABLE_COMMANDS: &[&str] = &["memory add", "memory recall", "config get", "config set"];` in `cli.rs`. Every other implemented command's doc comment starts with `[experimental] `. Stubs keep their milestone text; `setup`, `1staid`, `module`, `daemon`, `service`, `update` now say `2a-H3` (`main.rs` `milestone(…, "2a-H3", …)` and the `cli.rs` doc comments).

- [ ] **Step 1: Write the failing tests:** cli.rs integration — `every_json_document_carries_a_schema_id` (no core needed: `agent list`, `config get core.logLevel`, `config schema`, `memory recall --agent bernd q` against an absent core, `setup` → `error/1`; each stdout JSON has `schema` matching `^[a-z0-9]+(\.[a-z0-9-]+)*/\d+$` or equal to `error/1`); `config_schema_json_wraps_the_schema` (`jsonSchema.$id` is the config `$id`, no top-level `$schema` key next to `schema`); `stubs_name_2a_h3` (replaces `h2_commands_are_stubs_in_h1`); `error_documents_carry_reason_detail_and_ids` (unit test on `Out`'s document builder with a synthetic `RpcError::Call` carrying `ids`). cli.rs unit — `leaf_commands_are_stable_or_marked_experimental` (walk `Cli::command()`: every non-hidden leaf path is in `STABLE_COMMANDS`, a stub, or has `about` starting with `[experimental]`). rpc-schema — `no method result declares a top-level schema property`.
- [ ] **Step 2: Run** `cargo test -p plur1bus` → FAIL (and the rpc-schema test passes already — keep it as a guard).
- [ ] **Step 3: Implement.** Extract the document builder in `output.rs` as a pure `fn document(schema: &str, value: Value) -> Value` so it is unit-testable; update all call sites with the ids above. gen-docs intro: "Every `--json` document carries `schema: "<command>/<major>"` (failures: `error/1`). Commands marked `[experimental]` may change in any minor release; `memory add`, `memory recall`, `config get` and `config set` are stable (ADR-016). Commands marked 2a-H3, M2, M3, M4, M1b-3 or M8 are stubs that name the milestone delivering them and exit 2."
- [ ] **Step 4: Run** Green; `pnpm docs:gen`.
- [ ] **Step 5: Commit** `feat(cli): schema id in every --json document (ADR-016 §8); stability marks; stubs name 2a-H3`.

---

### Task 9: `plur1bus memory …` commands

**Files:**
- Modify: `crates/plur1bus/src/cli.rs` (`MemoryCmd`), `crates/plur1bus/src/commands/memory.rs` (dispatch), `crates/plur1bus/src/commands/mod.rs`
- Create: `crates/plur1bus/src/commands/memory_ops.rs`
- Test: `crates/plur1bus/tests/cli.rs`, unit tests in `memory_ops.rs`

**Interfaces:**
- Consumes: `Client::supports` (Task 3), `RpcError::ids` (Task 4), `Out::ok(schema, …)`/`from_rpc_error` (Task 8), `connect`/`require_agent` from `memory.rs` (make them `pub(crate)`).
- Produces (clap, all with doc comments starting `[experimental] `; `--agent` required everywhere):
  ```rust
  List { #[arg(long)] agent: String, #[arg(long, conflicts_with_all = ["since", "until"])] topic: Option<String>,
         #[arg(long)] since: Option<String>, #[arg(long, requires = "since")] until: Option<String>, #[arg(long)] limit: Option<u32> },
  Show { #[arg(long)] agent: String, id: String },
  Forget { #[arg(long)] agent: String, id: String, #[arg(long)] yes: bool },
  Correct { #[arg(long)] agent: String, id: String, #[arg(required = true)] text: Vec<String> },
  Share { #[arg(long)] agent: String, id: String, #[arg(long, value_enum)] to: ShareTarget, #[arg(long)] allow_sensitive: bool },
  State { #[arg(long)] agent: String },
  Propose { #[arg(long)] agent: String, shared_id: String, #[arg(long)] note: Option<String>, #[arg(required = true)] text: Vec<String> },
  Proposals { #[command(subcommand)] sub: ProposalsCmd },
  // ProposalsCmd: List { agent, #[arg(long, value_enum)] status: Option<ProposalStatus>, limit: Option<u32> },
  //               Accept { agent, proposal_id: String }, Reject { agent, proposal_id: String, #[arg(long)] note: Option<String> }
  ```
  `pub(crate) fn parse_time_arg(s: &str, now_ms: u64) -> Result<u64, String>` (G19: digits → epoch ms; `^\d+[mhd]$` → `now_ms − n × unit`, saturating; anything else → `Err`).
- Schema ids: `memory.list/1`, `memory.show/1`, `memory.forget/1`, `memory.correct/1`, `memory.share/1`, `memory.state/1`, `memory.propose/1`, `memory.proposals.list/1`, `memory.proposals.accept/1`, `memory.proposals.reject/1`.

**Behaviour** (every command, in order): load config → `require_agent` (exit 1 before any connection) → `forget` gate (G18: TTY and not `--json` → prompt `forget <id> for <agent>? [y/N]`; otherwise without `--yes` → `fail("E_INVALID_PARAMS", "re-run with --yes to forget <id>", {"applied": false}, 2)`) → `connect` (call timeout 30 s) → `!client.supports(method)` → `fail("E_NOT_AVAILABLE", …, {"reason": "core-lacks-method", "method": m}, 2)` → call with `identity::caller()` → `out.ok(id, &v, human)`. Core unavailable (`is_unavailable`) → `fail("E_CORE_UNAVAILABLE", …, {"degraded": {"reason": "core-unavailable", "capability": "memory-ops", "detail": d}}, 1)` — memory ops never journal. `share` on `E_APPROVAL_REQUIRED`: TTY and not `--json` and not `--allow-sensitive` → prompt `this memory is marked sensitive; share it anyway? [y/N]` and on `y` repeat with `allowSensitive: true`; otherwise `from_rpc_error` (exit 2) after printing the hint `re-run with --allow-sensitive after the person confirmed` to stderr. `list` without `--topic`/`--since` sends `since: 0`. Human output: list rows `<id>  <scope>[ · shared by <sharedBy>]  <summary>`; proposals rows `<id>  <status>  <proposer> → <sharer>  "<newText>"`; others one line naming the resulting ids.

- [ ] **Step 1: Write the failing tests:** unit `parse_time_arg` (`"1700000000000"`, `"7d"` with a fixed `now_ms`, `"90m"`, rejects `"7w"`, `""`, `"-1"`). cli.rs (no core, temp home with agent `bernd` created through `agent create`): `memory_forget_without_yes_in_a_pipe_exits_2_and_changes_nothing` (`applied: false`, schema `error/1`); `memory_list_rejects_topic_with_since` (clap exit 2); `memory_ops_without_a_core_fail_fast_with_core_unavailable` (each of the ten commands with valid args: exit 1, `error: "E_CORE_UNAVAILABLE"`, wall time < 1 s); `memory_ops_for_an_unregistered_agent_fail_before_connecting` (`E_AGENT_UNKNOWN`); `memory_help_names_every_subcommand`. Against a fake core (POSIX only, `#[cfg(unix)]`; a small scripted UDS server in the test that answers `core.auth` and one method — reuse the shape of `crates/plur1bus-rpc/tests/client.rs` `fake_core_with`, writing `run/core.token` and binding `run/core.sock` in the temp home): `share_approval_required_in_a_pipe_exits_2_with_hint` (fake answers `E_APPROVAL_REQUIRED`; exit 2, stderr contains `--allow-sensitive`); `a_core_without_the_method_in_capabilities_is_not_available` (fake hello with `capabilities.methods` lacking `memory.propose`; exit 2, `reason: "core-lacks-method"`).
- [ ] **Step 2: Run** `cargo test -p plur1bus` → FAIL.
- [ ] **Step 3: Implement** `memory_ops.rs` and the clap tree.
- [ ] **Step 4: Run** Green (`cargo clippy -D warnings` included); `pnpm lint` (no slash strings in help); `pnpm docs:gen`.
- [ ] **Step 5: Commit** `feat(cli): plur1bus memory list/show/forget/correct/share/state/propose/proposals`.

---

### Task 10: D29 — `x-tier` annotations and resolvers in both languages

**Files:**
- Modify: `packages/config-schema/schema/config.schema.json` (an `x-tier` next to every `x-restart`, per G16: `basic` on `agents`, `embedding.useClass`, `providers`, `modelRoles`; `advanced` on every other annotated node incl. `$schema`, `schemaVersion`, `engine`, `engine.baseDbPathOverride`, `oauth`, `decision`); `engine.description` says 55 keys
- Modify: `packages/config-schema/src/index.ts`, `packages/config-schema/src/gen-defaults.mjs` (also writes `fixtures/tier-cases.json`)
- Create: `packages/config-schema/fixtures/tier-cases.json` (generated), `packages/config-schema/test/tier.test.ts`
- Modify: `crates/plur1bus-config/src/lib.rs`, `crates/plur1bus-config/tests/config.rs`

**Interfaces:**
- Produces (TS): `export type Tier = "basic" | "advanced"; export function tierOf(keyPath: string): Tier` (the `restartClassOf` walk: nearest ancestor declaring `x-tier` wins, root default `"advanced"`); `export function filterSchemaByTier(schema: Record<string, any>, tier: Tier): Record<string, any>`; `export function filterConfigByTier(config: unknown, tier: Tier): Record<string, unknown>`. `ajv.addKeyword("x-tier")`.
- Produces (Rust): `pub enum Tier { Basic, Advanced }` (serde lowercase), `pub fn tier_of(key: &str) -> Tier`, `pub fn filter_schema_by_tier(schema: &Value, tier: Tier) -> Value`, `pub fn filter_config_by_tier(config: &Value, tier: Tier) -> Value`.
- Filter algorithm (both languages, identical): an **annotated** node (declares `x-tier`) is kept whole iff its tier equals the requested one; an **unannotated container** is recursed through `properties` and kept iff at least one child is kept, with `properties` reduced and `required` filtered to the kept keys; the root keeps `$schema`, `$id`, `title`, `type`, `additionalProperties` and its filtered `properties`/`required`. The config filter walks the value tree with the same schema decisions (annotated → keep the value iff the tier matches; unannotated object → recurse; keys the schema does not describe are dropped).
- `tier-cases.json`: `{ "cases": [{ "key", "tier" }], "filtered": { "basic": <schema>, "advanced": <schema> } }` for the keys `$schema`, `schemaVersion`, `core.logLevel`, `core.recall.capChars`, `supervisor.graceMs`, `logs.keep`, `agents`, `agents.bernd`, `agents.bernd.displayName`, `embedding.useClass`, `embedding.acceptedNcLicence`, `engine`, `engine.chatModels`, `engine.recall.softBudgetMs`, `providers.x`, `oauth`, `decision`, `modelRoles.chat`, `nope.nothing`.

- [ ] **Step 1: Write the failing tests:** TS `every node that declares x-restart declares x-tier (basic|advanced) and vice versa` (walk the whole schema incl. `additionalProperties` schemas); `tierOf follows G16` (`agents.bernd.displayName` basic, `embedding.useClass` basic, `engine.chatModels` advanced, `engine.recall.softBudgetMs` advanced, `nope.nothing` advanced); `filterSchemaByTier basic keeps agents, embedding.useClass, providers, modelRoles only` (`Object.keys(f.properties).sort()` deep-equals `["agents","embedding","modelRoles","providers"]`, `f.properties.embedding.properties` has only `useClass`, `f.required` is `[]`); `filterConfigByTier(defaults(), "advanced") has no agents key`; `tier-cases.json matches tierOf and the filters` (fixture freshness). Rust `tier_cases_match_the_typescript_fixture`, `filtered_schemas_match_the_typescript_fixture`.
- [ ] **Step 2: Run** `cd packages/config-schema && pnpm test`, `cargo test -p plur1bus-config` → FAIL.
- [ ] **Step 3: Implement** annotations, resolvers, filters, generator.
- [ ] **Step 4: Run** Green (`pnpm gen` regenerates the fixture; the defaults fixture must not change).
- [ ] **Step 5: Commit** `feat(config): x-tier basic|advanced on every key (D29), resolvers and filters in TS and Rust`.

---

### Task 11: `config schema|get --tier`, generated `docs/config.md`, tier column for engine keys

**Files:**
- Modify: `crates/plur1bus/src/cli.rs` (`ConfigCmd`), `crates/plur1bus/src/commands/config.rs`
- Modify: `scripts/gen-docs.mjs` (writes and `--check`s `docs/config.md`), `scripts/gen-engine-keys.mjs` (a `Tier` column, `advanced` on every row)
- Create (generated): `docs/config.md`; regenerate `docs/config-engine-keys.md`, `docs/cli.md`
- Test: `crates/plur1bus/tests/cli.rs`

**Interfaces:**
- Consumes: `tier_of`, `filter_schema_by_tier`, `filter_config_by_tier` (Task 10).
- Produces: `Get { key: Option<String>, #[arg(long, value_enum, conflicts_with = "key")] tier: Option<TierArg> }` (`TierArg`: `basic|advanced`) and `Schema { #[arg(long, value_enum, default_value = "all")] tier: TierFilter }` (`TierFilter`: `all|basic|advanced`). Output: `config get <key>` → `{ schema: "config.get/1", key, value, restart, tier }` (human line gains `[<restart>, <tier>]`); `config get --tier basic` → `{ schema, key: null, tier: "basic", value: <filtered config> }`; `config schema --tier basic` → `{ schema: "config.schema/1", tier: "basic", jsonSchema: <filtered> }` (`tier: "all"` for the default). `config get` and `config set` stay stable (additive field); `config schema` stays experimental.
- `docs/config.md`: title `# Configuration reference (schemaVersion 1)`, generated-by note, then `## Basic settings` and `## Advanced settings`, each a table `| Key | Type | Default | Restart | Description |` over the annotated nodes of that tier in schema order; the `engine` row's description links `docs/config-engine-keys.md` ("55 engine keys, all advanced and core").

- [ ] **Step 1: Write the failing tests:** `config_schema_tier_basic_filters` (`jsonSchema.properties` keys are exactly `agents, embedding, modelRoles, providers`); `config_get_key_shows_restart_and_tier` (`embedding.useClass` → `tier: "basic"`, `restart: "core"`); `config_get_tier_filters_without_key_and_conflicts_with_key` (`--tier advanced` value has `core` and no `agents`; `config get core.logLevel --tier basic` is a clap error, exit 2).
- [ ] **Step 2: Run** `cargo test -p plur1bus` → FAIL.
- [ ] **Step 3: Implement** the CLI changes and both generators; run `pnpm docs:gen`.
- [ ] **Step 4: Run** Green (`pnpm docs:check` now covers `docs/config.md`).
- [ ] **Step 5: Commit** `feat(cli,docs): config schema/get --tier (D29); generated docs/config.md; tier column for engine keys`.

---

### Task 12: System test of the memory surface; CI

**Files:**
- Create: `tests/system/memory-ops.test.ts`
- Modify: `.github/workflows/ci.yml` (system job: run both `tests/system/two-session-recall.test.ts` and `tests/system/memory-ops.test.ts`)

**Interfaces:**
- Consumes: `home`, `cli`, `startCore`, `stopCore` from `tests/system/helpers.ts`; the whole CLI surface of Tasks 8–9.

- [ ] **Step 1: Write the test** `memory surface end to end through the CLI` (flat embedder only — skip when `REAL`): `agent create bernd`, `agent create anna`, `config set engine.duplicateThreshold 1.01 --yes`; start the core; `memory add` two distinct facts for bernd; `memory list --agent bernd` → two items, `schema === "memory.list/1"`; `memory show` the first id; `memory correct` it → new id; `memory forget --yes` the second; `memory state` agent-private count 1; `memory share --to user` the corrected card; `memory list --agent anna` contains a card with `sharedBy === "bernd"`; `memory propose --agent anna <sharedId> "…"`; `memory proposals list --agent bernd` → one pending; `memory proposals accept`; `memory proposals list --agent anna --status accepted` → one; `memory forget --agent anna --yes <copyId>` → exit 1, `error === "E_DENIED"`, `schema === "error/1"`. Every `cli()` call's wall time < 2 s. Stop with `stopCore`.
- [ ] **Step 2: Run** (release build + `pnpm build`) → the test passes against Tasks 1–11; a failure here is a bug in the owning task, fixed there.
- [ ] **Step 3: Wire CI** (explicit file list; the system job stays Linux/macOS — Windows system tests wait for engine PR-11, spec §3).
- [ ] **Step 4: Run** Green plus both system tests.
- [ ] **Step 5: Commit** `test(system): memory surface end to end through the CLI; run it in CI`.

---

### Task 13: ADR implementation records and AGENTS.md

**Files:**
- Modify: `docs/adr/ADR-012-process-model-and-languages.md` — §3: error enum (15 codes, `data.ids`), `core.auth` result with `capabilities`, RPC 1.1.0, memory ops served (replaces the `E_NOT_AVAILABLE engine-pr-E1` paragraph), notifications (harness-owned list, `engine.event` deprecated opt-in, audience rule); §2 R13 amended by the `schema` key; §5-§8 forward references "H2" → "2a-H3" where the item moved (G1); §9 pin `d32771c5`, contract 1.6.0, `assertEngineContract` and exit code 4; deviations table rows for G7, G13; the warm-up deviation now names 2a-H3.
- Modify: `docs/adr/ADR-013-configuration-and-restart-classes.md` — `x-tier` (resolution, provisional basic set G16, filters, `docs/config.md`), 55 engine keys (G6), forward references → 2a-H3.
- Modify: `docs/adr/ADR-016-api-stability-and-versioning.md` — append `## Implementation record (2a-H2)`: the stable subset (G14), annotation keys and `x-deprecated` (G10), capabilities placement and features (`memory.ops`, `memory.proposals`, `events.harness`), event mapping and G11–G13, CLI `schema` ids (G15), deferred items (G2, G3; `1staid` listing of deprecations with 2a-H3).
- Modify: `AGENTS.md` — `memory …` commands in the "Where things live" row, conventions: `x-stability`/`x-since` on every method and notification, `x-tier` next to every `x-restart`, the `schema` key in `--json`, no top-level `schema` in RPC results, `docs/config.md` generated, the 2a-H3 stub label; drop "H2 adds the first module" wording in favour of 2a-H3.

- [ ] **Step 1: Write the records** from the code as merged in Tasks 1–12 (cite files and function names, not line numbers).
- [ ] **Step 2: Run** `pnpm lint` and `pnpm docs:check` → both exit 0.
- [ ] **Step 3: Commit** `docs(adr): 2a-H2 implementation records (ADR-012, ADR-013, ADR-016); AGENTS.md`.

---

## Self-review (done while writing)

- **Spec coverage:** §6.2 memory methods → Tasks 4, 5; propose/proposals (D31) → 4, 5, 9; engine pin and contract major → 1; drain → 6; ADR-016 capabilities → 3, x-stability/deprecated + docs → 2, 7, stable subset → 2, 8, events → 7, CLI `schema` → 8, side-by-side `apiVersion` → G3 deferred; D29 annotation/filter/docs → 10, 11, `setup` → G4 deferred; criteria 6 (hygiene) and 7 (fixtures) are enforced by the existing gates each task runs; criterion 10 (generated docs) by `pnpm docs:check`.
- **Type consistency:** `MEMORY_OP_METHODS` (T5) is consumed by T6; `buildCapabilities`/`CORE_FEATURES` (T3) extended by T5, T7; `supports` (T3) used by T9; `RpcError.ids`/`RpcError::ids` (T4) used by T5, T8, T9; `Out::ok(schema, …)` (T8) used by T9, T11; `tier_of`/filters (T10) used by T11.
- **Review Focus:** each of the five lines names a test in its owning task.
