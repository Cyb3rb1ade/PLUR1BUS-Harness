# M1b-2a engine work: E5 (host-neutral engine-config schema; recall-path follow-ups from 2a-H3a). Implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The engine ships a host-neutral `engine-config.schema.json` (every config key with type, default, description, `readAt: construction | live`, `x-tier`, `x-sensitive`), the OpenClaw manifest's `configSchema` is generated from it and cannot drift, and a host can read it without constructing an engine. The same PR fixes the four engine defects 2a-H3a found on the recall path: capture/recall latency that grows with the LanceDB fragment count, no side-effect-free way to warm the heavy recall path, a `timing.totalMs` that leaves out the queue wait and the neo prelude, and a neo worker thread that keeps the process alive after `close()`. Contract **1.9.0**, additive.

**Architecture:** `engine/config/engine-config.schema.json` becomes the single source of truth; `engine/config/engine-config-schema.js` loads it (frozen) and derives the key table, and `adapter/openclaw/config-schema.js` strips the engine-only keywords to produce `openclaw.plugin.json`'s `configSchema` and `secretInputs` (generator script with `--check`, drift test). The one live-read key goes through a host-neutral `readLiveConfigValue(host, path)`. A per-agent `FragmentCompactor` runs a bounded `table.optimize()` when a table passes a fragment threshold (checked every N writes and on a slow timer). The recall assembler gets an honest phase timer that starts at `Engine.recall` entry (`entry`, `queue`, `prelude` phases) and a `warmOnly` branch that runs only the read-only heavy steps (neo prelude reads, query embedding, read-only LanceDB open, vector search, rerank). The shared neo worker becomes a ref-counted lease released by `close()`.

**Tech stack:** engine repo `Cyb3rb1ade/openclaw-plur1bus-memory` (ESM JavaScript, `types/engine.d.ts` + `types/engine.conformance.ts`, `node --test`, LanceDB). Node ≥ 24.16 (`/home/claude/.node24/bin` in the cloud session). Branch `feat/e5-engine-config-schema` from `origin/main` **after the merge of #195** (E4.1 replay guard; `main` was `d0842424` before it). Record the base SHA in the first report.

**Spec:** `docs/superpowers/specs/2026-09-24-m1b-2a-core-daemon-cli-design.md` (harness repo) — §7 row **E5** ("Host-neutral `engine-config.schema.json` in the engine (the keys with types, defaults, and a `readAt: construction|live` flag); the adapter translates for `openclaw.plugin.json`", additive); §5 naming note (`packages/core/src/engine-config.ts` is the translation "until engine PR E5"); **D29** (`x-tier: basic | advanced`, "all engine keys are `advanced`"); **D28** (the OpenClaw plugin gets fixes only). Follow-ups: harness ledger `.superpowers/sdd/2026-09-26-m1b-2a-h3-supervisor-installer-warmup/progress.md` (Task 12 B1, H3-R22, H3-R23, nightly root cause) and `/home/claude/work/e4-1-report.md`.

## 2a-E sequence

| Step | Branch / PR | Contract | Status |
|---|---|---|---|
| E1-E3 | #188, #192, #193 | 1.5.0-1.7.0 | merged |
| E4 | `feat/e4-status-shared-platforms` (#194) | 1.8.0 | merged `d0842424` |
| E4.1 | `fix/e4-1-replay-guard-records-on-rows-settled` (#195) | 1.8.0 | merging (base of E5) |
| **E5** | `feat/e5-engine-config-schema` | **1.9.0** | **this plan** |

Harness side (not this plan): `scripts/gen-engine-keys.mjs` and `docs/config-engine-keys.md` read `engineConfigKeys()` instead of the manifest; `engine-config.ts` keeps only the harness-owned overrides; the warm-up (`packages/core/src/warmup.ts`) switches from `memory.list` to `engine.recall({ …, warmOnly: true })`; the `engine` node's description drops "until E5".

## Global constraints

- Contract amendment policy (`types/engine.d.ts:23-31`): `ContractVersion`, `types/engine.conformance.ts` and both adapters move together in one PR. E5 bumps once, to `"1.9.0"`, in Task 1. Literal sites (grep `1\.8\.0` excluding `package-lock.json`, `CHANGELOG.md` history, `.superpowers/` and "(1.8.0)" member annotations): `types/engine.d.ts` (header line 4, line 5 "amended nine times" → "ten", changelog, `ContractVersion`), `types/engine.conformance.ts` (pin ~107), `engine/create-engine.js` (`contract: "1.8.0"` in the status reporter and the engine object, the "contract 1.8.0" comment), `tests/engine-contract.test.js` (six hits), `docs/engine-api.md` (header, "full 1.8.0 `Engine` surface", status description), and from Task 2 on `engine/config/engine-config.schema.json` `"x-contract"`.
- Engine gate per task: `npm run lint && npm test` (~10 min; **590000 ms** timeout) plus `TZ=UTC node --test tests/golden-prefix.test.js` (golden **11/11**). Known container-baseline failures (E4.1 report): `b13-installed-host-loader`, `feature-cron-plugin-runtime`, `engine-close-inflight`, `rerank-single-timeout`, `reranker-cohere-timeout`. Anything else failing is yours until proven otherwise.
- Every new `engine/**/*.js` file goes into `tests/helpers/runtime-sources.js` `ENGINE_PATHS` **and** `scripts/lib/deploy-integrity.mjs` `DEPLOY_FILES`; new `lib/*.js`, `adapter/**/*.js` and runtime-read JSON files (`engine/config/engine-config.schema.json`) go into `DEPLOY_FILES`. Tests use `makeTempDir` (`tests/helpers/temp-dir.js`), never `mkdtempSync`. Typed failures are `MemoryOpError` with fixed, log-safe English messages.
- `engine/**` never imports `openclaw`, `adapter/**`, `lib/host-services.js`, `lib/runtime-shutdown.js`, never reads a bare `api` or `process.env.OPENCLAW_*` (`scripts/lint-engine-imports.mjs`, `lint-no-api-outside-adapter.mjs`). The generator script may import both engine and adapter modules.
- `openclaw.plugin.json` changes only through the generator (Task 4): `configSchema` and `configContracts.secretInputs.paths` are generated, every other manifest field is untouched. Its top-level key count stays **55**; new keys are nested (the harness asserts 55).
- Tests that enable neo must `await engine.close()` (after Task 5 that terminates the worker); every other test keeps `neo: { enabled: false }` as today.
- No new third-party dependency, no native addon, no JSON-Schema validator library (the schema is validated by `lib/setup/config-contract.js` as today, through the derived manifest).
- Commit identity via `git -c user.name=Cyb3rb1ade -c user.email=84099452+Cyb3rb1ade@users.noreply.github.com commit …`; body trailers `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01SxcLhve6hyM9AFm2nU9B3F`. Never `git stash`, never `--amend`, never push, never change git config; pushes and merges are the owner's (via the Mac).
- Never put secrets, tokens or real user data in the repo, logs or fixtures; agent ids, paths and texts in tests are synthetic.

## Review focus

1. **Warm-up on a half-set-up install:** an agent without a table yet, a principal with a workspace identity but no shared root, a `KNOWLEDGE.md` whose embedding cache is stale, a missing neo root — a `warmOnly` recall must create, rename, delete or append nothing anywhere (home, `baseDbPath`, workspace, neo root) and must not consume the start notice, a due reminder, a skill nudge or the neo injection mark a real recall needs next. Pinned in Task 9 (a), (c), (d), (e).
2. **Compaction racing live traffic:** `optimize()` running while captures store rows, recalls search and `memory.forget` rewrites a row; LanceDB's "retryable commit conflict"; `close()` while an optimize runs. Expected: no lost or duplicated row, no failed recall, bounded retries, `close()` within its budget and no optimize started afterwards. Pinned in Task 6 (d), (e).
3. **A LanceDB build without `table.stats()`:** the fragment count is unknown, so the compactor must fall back to a writes-since-last-compaction threshold instead of never compacting. Pinned in Task 6 (c).
4. **Honest timing moves the soft budget:** a recall that waited in the queue now reaches `softBudgetMs` earlier; the OpenClaw hook path must still answer with the neo/start fallback blocks, not nothing, and the scheduler's timeout log keeps its phase list. Pinned in Task 8 (d).
5. **One neo worker, several engines:** the OpenClaw adapter builds more than one engine per process and its `gateway_stop` still closes the runtime directly; closing one engine must not break another engine's neo work, a double `close()` must not double-release, and the process must exit once the last engine closed. Pinned in Task 5 (b), (c).

---

### Task 1: Contract 1.9.0 — types, conformance pins, literal sites

**Files:**
- Modify: `types/engine.d.ts` (header, changelog, `ContractVersion`; `EngineConfig` doc comment — it says "56 keys", replace with a pointer to the schema; new "Engine config schema" block after `EngineConfig`; `RecallQuery`; `RecallTiming` doc)
- Modify: `types/engine.conformance.ts` (pin; new 1.9.0 block after the 1.8.0 block)
- Modify: the literal sites in Global constraints (runtime and test literals only)

**Interfaces (produces; later tasks implement exactly this):**

```ts
export type ContractVersion = "1.9.0";

/** 1.9.0: when the engine reads a config value. construction: from createEngine's `config` argument, once — a change
 *  needs a new engine. live: per operation through HostServices.config() (engine/config/live-config.js). */
export type EngineConfigReadAt = "construction" | "live";
export type EngineConfigTier = "basic" | "advanced";
/** A node of engine/config/engine-config.schema.json (JSON Schema 2020-12 plus three annotations). */
export interface EngineConfigSchemaNode {
  type?: string | string[];
  default?: unknown;
  description?: string;
  /** Required on every top-level key; a nested node may override its parent. */
  readAt?: EngineConfigReadAt;
  "x-tier"?: EngineConfigTier;
  /** true on credential inputs (the manifest's secretInputs). */
  "x-sensitive"?: boolean;
  properties?: Record<string, EngineConfigSchemaNode>;
  [keyword: string]: unknown;
}
export interface EngineConfigSchema extends EngineConfigSchemaNode {
  $schema: "https://json-schema.org/draft/2020-12/schema";
  $id: "plur1bus-engine-config";
  "x-contract": ContractVersion;
  properties: Record<string, EngineConfigSchemaNode & { description: string; readAt: EngineConfigReadAt; "x-tier": EngineConfigTier }>;
}
/** One top-level key as engineConfigKeys() reports it. */
export interface EngineConfigKey {
  key: string;
  type: string | string[] | null;
  default?: unknown;
  description: string;
  readAt: EngineConfigReadAt;
  /** Paths below this key whose readAt differs from the key's own (e.g. "reembedding.activeGeneration"). */
  liveOverrides: string[];
  tier: EngineConfigTier;
  /** true when the key or any path below it is x-sensitive. */
  sensitive: boolean;
}

export interface RecallQuery {
  /* existing members unchanged */
  /** 1.9.0: run only the read-only heavy path (neo prelude reads, query embedding, read-only store open, vector search,
   *  rerank) and answer { blocks: [], degraded: null, timing }. Writes nothing, emits no event, never uses or fills the
   *  recall cache, never calls an LLM, runs at background priority. */
  warmOnly?: boolean;
}
```

`RecallTiming` doc comment (no type change): "1.9.0: `totalMs` runs from `Engine.recall` entry (for the OpenClaw hook path: assembler entry); `phases.completed` begins with `entry` (Engine.recall only), `queue` and `prelude`." Changelog line: `1.9.0 — engine-config.schema.json with readAt/x-tier/x-sensitive and its types (EngineConfigSchema, EngineConfigKey, EngineConfigReadAt); RecallQuery.warmOnly; RecallTiming.totalMs covers queue wait and prelude (E5).`

- [ ] **Step 1:** Edit `types/engine.d.ts` as above (add, never reorder).
- [ ] **Step 2:** `types/engine.conformance.ts`: pin `"1.9.0"`; under `// 1.9.0: engine config schema, warm-only recall (E5 Task 1).` add `Exact<EngineConfigReadAt, "construction" | "live">`, `Exact<EngineConfigKey["tier"], "basic" | "advanced">`, `Exact<EngineConfigSchema["x-contract"], ContractVersion>`, `Exact<RecallQuery["warmOnly"], boolean | undefined>`, and `const warmQuery: RecallQuery = { query: "q", principal: minimalPrincipal, agent: minimalAgent, signal: new AbortController().signal, warmOnly: true }; void warmQuery;` (reuse the file's existing principal/agent literals).
- [ ] **Step 3:** Bump the runtime literals in `engine/create-engine.js` and the six test hits.
- [ ] **Step 4:** `npm run lint && npm run typecheck && node --test tests/engine-contract.test.js`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(contract): 1.9.0 — engine config schema types, RecallQuery.warmOnly, honest recall timing (pins)`.

### Task 2: `engine-config.schema.json` and its loader

**Files:**
- Create: `engine/config/engine-config.schema.json`, `engine/config/engine-config-schema.js`
- Modify: `tests/helpers/runtime-sources.js`, `scripts/lib/deploy-integrity.mjs`
- Test: `tests/engine-config-schema.test.js`

**Interfaces:**
- Produces:
  ```js
  // engine/config/engine-config-schema.js
  export const ENGINE_CONFIG_SCHEMA_FILE = "engine/config/engine-config.schema.json"; // package-relative
  /** Parsed once (readFileSync(new URL("./engine-config.schema.json", import.meta.url))), deep-frozen, cached. */
  export function loadEngineConfigSchema(): EngineConfigSchema
  /** Top-level keys in schema order. */
  export function engineConfigKeys(schema = loadEngineConfigSchema()): EngineConfigKey[]
  /** readAt of a dotted path: nearest node on the path that declares readAt; unknown path → null. */
  export function readAtOf(path: string, schema = loadEngineConfigSchema()): EngineConfigReadAt | null
  /** Every dotted path whose resolved readAt is "live", sorted. */
  export function livePaths(schema = loadEngineConfigSchema()): string[]
  /** Every dotted path of a node with "x-sensitive": true, in depth-first schema order. */
  export function sensitivePaths(schema = loadEngineConfigSchema()): string[]
  ```
- Content rules for the JSON (created once from the current manifest; the transformation is not committed as a script):
  1. Root: `"$schema": "https://json-schema.org/draft/2020-12/schema"`, `"$id": "plur1bus-engine-config"`, `"x-contract": "1.9.0"`, then `openclaw.plugin.json` `configSchema` verbatim (`$defs`, `type`, `additionalProperties`, `properties`, key order preserved).
  2. Every top-level property gains, after its existing keywords, `"readAt": "construction"` and `"x-tier": "advanced"`, and a `description` where it has none: one English sentence taken from that key's row or section in `docs/configuration.md` (no defaults or German in the text).
  3. `properties.reembedding.properties.activeGeneration` gains `"readAt": "live"` (the one key the engine reads per operation: `readConfiguredReembeddingSelection`, `engine/create-engine.js` ~1706; audited in Task 3).
  4. The eight credential nodes `embedding.apiKey`, `embedding.fallback.apiKey`, `reranker.apiKey`, `merging.apiKey`, `schicht15.apiKey`, `skillMiner.apiKey`, `criticalPush.apiKey`, `emotion.t3.apiKey` gain `"x-sensitive": true` next to their `$ref`.
- `engineConfigKeys`: `type` = the node's `type`, or `"enum"` when only `enum` is present, else `null`; `default` only when the node has one; `liveOverrides` = `livePaths()` entries under the key whose readAt differs from the key's; `sensitive` = any `sensitivePaths()` entry equals or starts with `key + "."`.

- [ ] **Step 1: Write the failing tests:**
  - (a) `"the schema carries every manifest key with type, description, readAt and x-tier"`: `engineConfigKeys().length === 55`; the key list deep-equals `Object.keys(manifest.configSchema.properties)` (read `openclaw.plugin.json` with `readFileSync`); every key has a non-empty `description` without `ä|ö|ü|ß`, `readAt === "construction"`, `tier === "advanced"`; `loadEngineConfigSchema()["x-contract"] === "1.9.0"`.
  - (b) `"readAt resolves through the nearest declaring node"`: `readAtOf("recall.softBudgetMs") === "construction"`; `readAtOf("reembedding.activeGeneration") === "live"`; `readAtOf("reembedding.fingerprintId") === "construction"`; `readAtOf("nope.x") === null`; `livePaths()` deep-equals `["reembedding.activeGeneration"]`; `engineConfigKeys().find((k) => k.key === "reembedding").liveOverrides` deep-equals the same.
  - (c) `"credential inputs are marked sensitive"`: `sensitivePaths()` deep-equals the eight paths in rule 4 in that order; `engineConfigKeys().filter((k) => k.sensitive).map((k) => k.key)` deep-equals `["embedding", "reranker", "merging", "schicht15", "skillMiner", "criticalPush", "emotion"]`.
  - (d) `"the loaded schema is frozen and cached"`: `loadEngineConfigSchema() === loadEngineConfigSchema()`; assigning `schema.properties.gc.default = 1` throws in strict mode (`Object.isFrozen` on a nested node).
  - (e) `"defaults match the manifest"`: for every key with a `default` in the manifest, `engineConfigKeys()` reports the same value (`deepStrictEqual`).
- [ ] **Step 2:** Run `node --test tests/engine-config-schema.test.js`. Expected: FAIL (module missing).
- [ ] **Step 3:** Write the JSON per the rules and implement the loader; register both files.
- [ ] **Step 4:** Run the file and `tests/config-contract.test.js`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(config): host-neutral engine-config.schema.json with readAt, x-tier and x-sensitive, and its loader`.

### Task 3: `readAt` audit and a host-neutral live read

**Files:**
- Create: `engine/config/live-config.js`
- Modify: `engine/create-engine.js` (`readConfiguredReembeddingSelection` ~1706-1710 uses the helper)
- Modify: `tests/helpers/runtime-sources.js`, `scripts/lib/deploy-integrity.mjs`
- Test: `tests/engine-config-readat.test.js`

**Interfaces:**
- Consumes: `livePaths()` (Task 2).
- Produces:
  ```js
  export const PLUGIN_CONFIG_KEY = "memory-lancedb-namespaced";
  export const LIVE_CONFIG_PATHS = Object.freeze(["reembedding.activeGeneration"]);
  /** The engine's own config as the host sees it now: `host.runtime?.config?.current?.() || host.config()`, then
   *  `.plugins.entries[PLUGIN_CONFIG_KEY].config` when that is an object; otherwise, only when `host.runtime` is null
   *  (a harness-style host whose config() IS the engine config), the object itself; otherwise null. Never throws. */
  export function livePluginConfig(host): Record<string, unknown> | null
  /** Reads one LIVE_CONFIG_PATHS path from livePluginConfig(host); a path not in the list throws TypeError. */
  export function readLiveConfigValue(host, path: string): unknown
  ```
- The engine's config is otherwise read from `createEngine`'s `config` argument (`let cfg = resolveEffectiveConfig(rawPluginConfig)`, `create-engine.js` ~182) and never re-read; every other `plugins.entries[…]` access in `engine/` and `lib/` reads the host config only to mutate it or to show the current value in a command (verified sites below). The test pins that inventory.

- [ ] **Step 1: Write the failing tests:**
  - (a) `"LIVE_CONFIG_PATHS equals the schema's live paths"`: `deepStrictEqual([...LIVE_CONFIG_PATHS].sort(), livePaths())`.
  - (b) `"only live-config.js reads the engine entry of the host config at run time"`: scan every `.js` file under `engine/` and `lib/` for `/plugins\??\.entries\??\.\[\s*(PLUGIN_KEY|PLUGIN_ID|pluginKey|pluginId|PLUGIN_CONFIG_KEY|"memory-lancedb-namespaced")/`; the set of matching files deep-equals `CONFIG_MUTATION_SITES ∪ {"engine/config/live-config.js"}` where `CONFIG_MUTATION_SITES` (declared in the test, each with a one-line reason) = `engine/commands/plur1bus-command.js`, `lib/chat-model.js`, `lib/dashboard-settings.js`, `lib/featureModels.js`, `lib/obsidian-bridge.js`, `lib/reembedding/runtime-config.js`, `lib/setup/control-ui-write.js`, `lib/setup/feature-cron-plan.js`, `lib/setup/feature-profiles.js`, `lib/telegram-commands/feature-toggle.js`, `lib/temperament-command.js`. `engine/create-engine.js` is not in the set.
  - (c) `"every readLiveConfigValue call names a live path"`: every string literal in `readLiveConfigValue\(\s*\w+\s*,\s*"([^"]+)"` across `engine/` and `lib/` is in `LIVE_CONFIG_PATHS`; at least one call exists.
  - (d) `"a harness-style host is read live"`: `host = { runtime: null, config: () => current }` with `current = { reembedding: { activeGeneration: "g2" } }` → `"g2"`; after `current = { reembedding: { activeGeneration: "g3" } }` → `"g3"`.
  - (e) `"an OpenClaw-style host is read from its plugin entry"`: `runtime.config.current()` returns `{ plugins: { entries: { "memory-lancedb-namespaced": { config: { reembedding: { activeGeneration: "g4" } } } } } }` → `"g4"`; a runtime whose current config has no entry → `undefined` (not the host file's top level); `current()` throwing → `livePluginConfig` returns null.
  - (f) `readLiveConfigValue(host, "recall.softBudgetMs")` throws `TypeError`.
- [ ] **Step 2:** Run the file. Expected: FAIL (module missing; (b) lists `engine/create-engine.js`).
- [ ] **Step 3:** Implement; `readConfiguredReembeddingSelection` becomes `Object.freeze({ generation: readLiveConfigValue(host, "reembedding.activeGeneration") ?? null })`.
- [ ] **Step 4:** Run the file and every `tests/*reembedding*.test.js`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(config): readAt audit — one live key, read host-neutrally through readLiveConfigValue`.

### Task 4: OpenClaw manifest generated from the engine schema

**Files:**
- Create: `adapter/openclaw/config-schema.js`, `scripts/gen-openclaw-config-schema.mjs`
- Modify: `openclaw.plugin.json` (regenerated: `configSchema` gains the new descriptions; nothing else changes), `package.json` (`"gen:config-schema": "node scripts/gen-openclaw-config-schema.mjs"`), `scripts/lib/deploy-integrity.mjs`
- Test: `tests/engine-config-schema-openclaw.test.js`

**Interfaces:**
- Consumes: `loadEngineConfigSchema`, `sensitivePaths` (Task 2).
- Produces:
  ```js
  // adapter/openclaw/config-schema.js
  export const ENGINE_ONLY_ROOT_KEYS = Object.freeze(["$schema", "$id", "x-contract"]);
  export const ENGINE_ONLY_KEYWORDS = Object.freeze(["readAt", "x-tier", "x-sensitive"]);
  /** Deep copy without the engine-only root keys and, in every object node (including $defs), without ENGINE_ONLY_KEYWORDS; key order kept. */
  export function deriveOpenClawConfigSchema(engineSchema): object
  /** sensitivePaths(engineSchema).map((path) => ({ path, expected: "string" })) */
  export function deriveSecretInputPaths(engineSchema): Array<{ path: string; expected: "string" }>
  /** manifest with configSchema and configContracts.secretInputs.paths replaced, other fields and their order untouched. */
  export function applyEngineSchemaToManifest(manifest, engineSchema): object
  ```
  `scripts/gen-openclaw-config-schema.mjs [--check] [--manifest <path>]`: writes `JSON.stringify(result, null, 2) + "\n"` to the manifest (default `openclaw.plugin.json`); `--check` writes nothing, exits 0 when the file is byte-identical to the result, else prints `openclaw.plugin.json is out of date: run npm run gen:config-schema` and exits 1.

- [ ] **Step 1: Write the failing tests:**
  - (a) `"the manifest configSchema is derived from the engine schema"`: `deepStrictEqual(manifest.configSchema, deriveOpenClawConfigSchema(loadEngineConfigSchema()))`, and `JSON.stringify(manifest.configSchema)` contains none of `readAt`, `x-tier`, `x-sensitive`, `x-contract`.
  - (b) `"secretInputs follow x-sensitive"`: `deepStrictEqual(manifest.configContracts.secretInputs.paths, deriveSecretInputPaths(schema))` (the eight existing entries, same order).
  - (c) `"uiHints sensitive flags agree with x-sensitive"`: the `uiHints` keys with `sensitive: true` deep-equal `sensitivePaths()`; every `uiHints` key has `readAtOf(key) !== null`.
  - (d) `"--check passes on the repository and fails on a drifted copy"`: `spawnSync(process.execPath, [script, "--check"])` → status 0; copy the manifest to a temp dir, set `configSchema.properties.gc.default = "x"` there, `--check --manifest <copy>` → status 1 and stdout matches `/out of date/`; without `--check` on the copy → the copy is fixed and a second `--check` passes.
  - (e) `"deriving is idempotent and leaves the input untouched"`: derive twice → equal; the engine schema is still frozen and still has `readAt` on `gc`.
- [ ] **Step 2:** Run the file. Expected: FAIL (module missing; after it exists, (a) fails until the manifest is regenerated).
- [ ] **Step 3:** Implement, run `npm run gen:config-schema`, review the manifest diff (only added `description` lines inside `configSchema.properties.*`).
- [ ] **Step 4:** Run the file, `tests/config-contract.test.js`, `tests/config-docs-contract.test.js`, `tests/config-audit.test.js`, `tests/installer-config.test.js`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(adapter): openclaw.plugin.json configSchema and secretInputs are generated from engine-config.schema.json (drift test, --check)`.

### Task 5: The neo worker is released by `close()` (the process exits)

**Why:** `neo.enabled` defaults to `true`. The engine takes the process-wide neo worker (`getSharedNeoWorkerRuntime`, `lib/neo-worker-runtime.js:40`), every recall calls `neoWorkerRuntime.warmUp()` (`assemble-prompt-context.js` ~233), and only the OpenClaw adapter's `gateway_stop` closes it (`adapter/openclaw/register-gateway.js:107`). `createResourceCloser` (`engine/lifecycle/close-resources.js`) never touches it, so on any other host the Worker's MessagePort keeps the event loop alive after `close()`.

**Files:**
- Modify: `lib/neo-worker-runtime.js` (add the lease; `getSharedNeoWorkerRuntime` stays as is for existing callers)
- Modify: `engine/create-engine.js` (~953: take a lease; pass it to `createResourceCloser`), `engine/lifecycle/close-resources.js` (release after the pool shutdown)
- Modify: `tests/llm-result-cache-lifecycle.test.js` (the pinned closer list, if it pins the argument names)
- Test: `tests/engine-close-neo-worker.test.js`

**Interfaces:**
- Produces:
  ```js
  /** Retains the shared runtime (creating it, or replacing a closed one, like getSharedNeoWorkerRuntime). release() is
   *  idempotent per lease; the last release of a runtime closes it and resets the singleton if it still points to it. */
  export function acquireSharedNeoWorkerRuntime(options = {}): { runtime: NeoWorkerRuntime; release(): Promise<void> }
  // createResourceCloser({ …, neoWorker = null }) → awaits neoWorker?.release(); a throw is logged like the other resources.
  ```
  The ref count lives in a module-level `WeakMap<runtime, number>`; a runtime closed directly (adapter `gateway_stop`) makes later `release()` calls a no-op.

- [ ] **Step 1: Write the failing tests** (engine config as in `tests/engine-close-inflight.test.js` but `neo: { enabled: true }`, stub `internals.embeddings`):
  - (a) `"close() terminates the neo worker"`: `const rt = internalsOf(engine).neoWorkerRuntime; rt.warmUp();` → `process.getActiveResourcesInfo().filter((r) => r === "MessagePort").length` is greater than before the engine was created; `await engine.close()` → `rt.isClosed() === true` and the MessagePort count is back to the baseline (poll ≤ 1 s).
  - (b) `"two engines share one worker until the last closes"`: engines A and B (separate temp dirs) → `internalsOf(A).neoWorkerRuntime === internalsOf(B).neoWorkerRuntime`; `await A.close()` → not closed, `warmUp() === true`; `await A.close()` again → still not closed (no double release); `await B.close()` → closed.
  - (c) `"a runtime closed by the adapter is not closed twice"`: engine A; `await internalsOf(A).neoWorkerRuntime.close()` (what `gateway_stop` does); a new engine B gets a fresh, open runtime; `await A.close()` leaves B's runtime open.
  - (d) `"the process exits after close with neo enabled"`: write a module to a temp dir that imports `engine/create-engine.js` by absolute file URL, creates an engine with `neo: { enabled: true }` and a stub embedder, awaits one `engine.recall({ …, signal })` (which warms the worker), awaits `engine.close()` and returns without `process.exit`; `spawn(process.execPath, [file])` → exits with code 0 within 15 s (on timeout: kill, fail with "process did not exit after close()").
- [ ] **Step 2:** Run the file. Expected: (a), (b), (d) FAIL.
- [ ] **Step 3:** Implement the lease and the closer step.
- [ ] **Step 4:** Run the file, `tests/adapter-register-gateway.test.js`, every `tests/*neo-worker*.test.js`, `tests/llm-result-cache-lifecycle.test.js`. Expected: PASS.
- [ ] **Step 5:** Commit `fix(engine): close() releases the shared neo worker so the process can exit`.

### Task 6: Fragment compaction outside consolidate-daily

**Why:** every `add()`/`update()` writes a LanceDB fragment; only `consolidate-daily` runs `optimize()` (`engine/jobs/internal-job-bodies.js` ~205), and `dailyConsolidation.enabled` defaults to `false`, so a harness install never compacts and capture/recall latency grows with every turn (2a-H3a Task 12, B1; `lib/lancedb-optimize.js` header: 352 fragments → vector search 191 ms, 23 ms after optimize).

**Files:**
- Create: `engine/store/fragment-compactor.js`
- Modify: `lib/db-adapter.js` (add `fragmentCount(agent)` next to `optimizeTable` ~892)
- Modify: `engine/capture/capture-turn.js` (after `rowsSettled = true` ~676: `ctx.noteTableWrite?.(agentId)` when `stored > 0`)
- Modify: `engine/create-engine.js` (build the compactor after `memoryDbAdapter` ~1456; `noteTableWrite` into the capture context view; `internals.fragmentCompactor`), `engine/lifecycle/close-resources.js` (`fragmentCompactor.close()` before the pool shutdown)
- Modify: `engine/config/engine-config.schema.json` (`runtime.properties.lancedbCompaction`, below), then `npm run gen:config-schema`
- Modify: `tests/helpers/runtime-sources.js`, `scripts/lib/deploy-integrity.mjs`
- Test: `tests/fragment-compactor.test.js`

**Interfaces:**
- Consumes: `memoryDbAdapter.optimizeTable(agent, opts)` (existing; retries commit conflicts), `resolveLancedbOptimizePlan(cfg.dailyConsolidation?.lancedbOptimize)` for `keepVersionsHours`.
- Produces:
  ```js
  export const DEFAULT_LANCEDB_COMPACTION = Object.freeze({ enabled: true, fragmentThreshold: 64, checkEveryWrites: 16, checkIntervalMs: 600_000, timeoutMs: 60_000 });
  /** Validated copy of runtime.lancedbCompaction merged over the defaults (out-of-range values → default). */
  export function resolveLancedbCompaction(raw): typeof DEFAULT_LANCEDB_COMPACTION
  /** → { noteWrite(agentId): void, check(agentId): Promise<CompactionOutcome>, compactNow(agentId): Promise<CompactionOutcome>, close(): Promise<void> }
   *  CompactionOutcome = { agentId, action: "skipped" | "compacted" | "failed", reason?: "disabled" | "closed" | "below-threshold" | "no-table" | string,
   *                        fragmentsBefore: number | null, fragmentsAfter: number | null, ms: number } */
  export function createFragmentCompactor({ config, fragmentCount, optimize, keepVersionsHours, logger, clock = Date.now, timers = { setInterval, clearInterval } })
  // lib/db-adapter.js
  fragmentCount(agent): Promise<number | null>   // table.stats().fragmentStats.numFragments via the existing toNumber; no table / no stats() / timeout (5 s) → null
  ```
- Schema addition (readAt `construction` inherited from `runtime`): `"lancedbCompaction": { "type": "object", "additionalProperties": false, "description": "Bounded LanceDB fragment compaction between consolidate-daily runs.", "properties": { "enabled": { "type": "boolean", "default": true }, "fragmentThreshold": { "type": "integer", "minimum": 8, "default": 64 }, "checkEveryWrites": { "type": "integer", "minimum": 1, "default": 16 }, "checkIntervalMs": { "type": "integer", "minimum": 60000, "default": 600000 }, "timeoutMs": { "type": "integer", "minimum": 10000, "default": 60000 } } }`.
- Algorithm: `noteWrite` counts per agent (and remembers the agent for the timer); every `checkEveryWrites` writes it schedules `check(agentId)` without awaiting it (errors logged). `check`: closed → skipped/closed; one check per agent in flight (a second call returns the same promise); checks run one at a time engine-wide (a FIFO chain), so at most one `optimize()` touches disk. `fragmentCount` → `n`; when `n === null` the writes counted since this agent's last compaction stand in for `n`. `n < fragmentThreshold` → skipped/below-threshold. Otherwise `optimize(agentId, { cleanupOlderThan: new Date(clock() - keepVersionsHours * 3_600_000), timeoutMs, maxAttempts: 3, retryDelayMs: 1_000 })`; `ok` → compacted (reset the agent's write count; `fragmentsAfter` from `fragmentCount`), else failed with the adapter's reason and one `logger.warn`. The interval timer (`unref()`) calls `check` for every remembered agent. `close()`: stop the timer, refuse new checks, await the chain (the engine's close budget bounds it). `compactNow` = `check` with the threshold treated as 0 (tests and a future admin op).

- [ ] **Step 1: Write the failing tests:**
  - (a) unit `"a check compacts only above the threshold"`: fakes `fragmentCount` → 10 then 70, `optimize` spy `{ ok: true }` → first `check` skipped/below-threshold, second compacted; `optimize` got `timeoutMs: 60000`, `maxAttempts: 3` and a `cleanupOlderThan` 24 h before the fake clock.
  - (b) unit `"writes trigger a check every checkEveryWrites"`: `checkEveryWrites: 4` → 3 `noteWrite` → no `fragmentCount` call; the 4th → one call; concurrent `check("a")` calls share one promise; checks for "a" and "b" never overlap (a parked `optimize` for "a" delays "b"'s `fragmentCount`).
  - (c) unit `"without stats the write count stands in"`: `fragmentCount` → null, `fragmentThreshold: 8`, 8 writes → compacted; after that 7 writes → below-threshold.
  - (d) integration `"compaction runs beside captures and recalls without losing rows"` (real LanceDB, stub embedder as in `tests/engine-capture-replay.test.js`, `runtime.lancedbCompaction: { fragmentThreshold: 8, checkEveryWrites: 4 }`): 24 captures of distinct texts; then start `compactNow("agent-a")` together with 8 more captures, 8 `engine.memory.list({ topic })` calls and one `memory.forget` of an earlier card; all settle without a rejection; `memory.list({ since: 0, limit: 100 })` has exactly 31 live cards; `db-adapter.fragmentCount("agent-a")` after a final `compactNow` is ≤ 8 (skip that assertion with `t.diagnostic` when it returns null).
  - (e) integration `"close() stops compaction"`: `optimize` wrapped (internals seam `fragmentCompactor` override or a spy on `internals.memoryDbAdapter.optimizeTable`) to park; `compactNow` started, `engine.close({ budgetMs: 2000 })` resolves within 2.5 s; after close `noteWrite` ×100 starts no `optimize`.
  - (f) `"resolveLancedbCompaction rejects out-of-range values"`: `{ fragmentThreshold: 2, checkIntervalMs: 5 }` → defaults for both; `{ enabled: false }` → `check` answers skipped/disabled and never calls `fragmentCount`.
- [ ] **Step 2:** Run `node --test tests/fragment-compactor.test.js`. Expected: FAIL (module missing).
- [ ] **Step 3:** Implement, wire, add the schema key, regenerate the manifest.
- [ ] **Step 4:** Run the file, `tests/engine-config-schema.test.js`, `tests/engine-config-schema-openclaw.test.js`, `tests/engine-capture-replay.test.js`, `tests/engine-close-inflight.test.js`, every `tests/*consolidat*.test.js`. Expected: PASS (known baseline excepted).
- [ ] **Step 5:** Commit `fix(store): bounded LanceDB fragment compaction between consolidate-daily runs (threshold, write count, timer)`.

### Task 7: Compaction benchmark — flat latency

**Files:**
- Test: `tests/fragment-compaction-benchmark.test.js` (`{ timeout: 240_000 }`)

**Interfaces:**
- Consumes: Task 6 (`runtime.lancedbCompaction`, `lib/db-adapter.js` `fragmentCount`).

- [ ] **Step 1: Write the test** — two engines on separate temp dirs with the same stub embedder, A `lancedbCompaction: { enabled: false }`, B `{ fragmentThreshold: 16, checkEveryWrites: 8 }`. Each captures 160 distinct texts in four windows of 40; after each window: median of 5 `engine.memory.list({ topic: "benchmark topic" }, …)` durations (`performance.now()`), median capture duration of the window, and `fragmentCount`. `t.diagnostic` prints a table (window, A/B list ms, A/B capture ms, A/B fragments). Assertions: B's last-window list median ≤ 2 × B's first-window median + 20 ms; B's last-window capture median ≤ 2 × its first + 20 ms; when `fragmentCount` is available: B's final fragments ≤ 24, A's final fragments ≥ 160 (the problem the fix addresses). Wait for B's pending checks before measuring each window (`await internalsOf(B).fragmentCompactor.check("agent-a")`).
- [ ] **Step 2:** Run it on the Task 6 code. Expected: PASS; paste the diagnostic table into the task report. Also run it once with B's `enabled: false` locally (not committed) and report that the latency assertion fails there — the test must be able to fail.
- [ ] **Step 3:** Commit `test(store): benchmark — capture and list latency stay flat with fragment compaction`.

### Task 8: Honest recall timing

**Files:**
- Modify: `lib/recall-phase-timer.js` (`startedAt` option)
- Modify: `engine/recall/assemble-prompt-context.js` (timer at ~182; scheduled callback start ~198; prelude end after the prelude log ~301)
- Modify: `engine/create-engine.js` (`Engine.recall` passes `startedAt`)
- Test: `tests/engine-recall-honest-timing.test.js`, `tests/recall-phase-timer.test.js` (new case)

**Interfaces:**
- Produces:
  ```js
  createRecallPhaseTimer({ softBudgetMs, hardTimeoutMs, logger, startedAt })  // finite startedAt → elapsedMs() counts from it before any start()
  // assemblePromptContext(event, hookCtx, opts): opts.startedAt?: number (Date.now() clock)
  ```
- Assembler: `const startedAt = Number.isFinite(opts.startedAt) ? opts.startedAt : Date.now();` passed to the timer; when `opts.startedAt` was given, `phaseTimer.record("entry", assemblerEntryAt - opts.startedAt)`. Right before `runtimeScheduler.runRecall`: `const enqueuedAt = Date.now()`; first line of the callback: `timer.record("queue", Date.now() - enqueuedAt)`; then `timer.start("prelude")` before the principal resolution and `timer.end("prelude")` after the prelude log block (before the short-prompt return). `timing.totalMs` stays `phaseTimer.elapsedMs()`, which is now honest on every exit, the soft budget included. `Engine.recall`: `const startedAt = Date.now()` as its first statement, forwarded in the assembler's third argument.

- [ ] **Step 1: Write the failing tests:**
  - (a) unit `"a timer with startedAt counts from it"`: `createRecallPhaseTimer({ startedAt: Date.now() - 50 }).elapsedMs() >= 50` before any `start()`; `summary().elapsedMs >= 50`.
  - (b) `"queue wait is a phase and inside totalMs"` (`runtime.maxConcurrentRecall: 1`; `internals.embeddings.embedQuery` parks the first call on a deferred): recall 1 started and parked, recall 2 started, 120 ms later release → recall 2's `timing.phases.completed` has `entry`, `queue` (≥ 100 ms) and `prelude` in that order at the head; `timing.totalMs >= queue.ms`; `timing.totalMs <= wall` and `>= wall - 30` where `wall` is the caller's `performance.now()` delta.
  - (c) `"the neo prelude is a phase"` (`neo: { enabled: true, globalRecall: { embedTimeoutMs: 1000 } }`, `embedQuery` delays 80 ms): `prelude.ms >= 70`; `await engine.close()` at the end.
  - (d) `"the soft budget now counts the queue wait"` (assembler called directly as the OpenClaw hook path does, no `startedAt`; `recall.softBudgetMs: 50`; queue wait 120 ms as in (b)): the result is not `undefined`, has the neo/start fallback or the pipeline's soft-budget partial, `timing.phases.completed[0].phase === "queue"`, and no `entry` phase.
- [ ] **Step 2:** Run both files. Expected: (a)-(c) FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run both files, `tests/engine-assemble-prompt-context.test.js`, `tests/engine-contract.test.js`, every `tests/*runtime-scheduler*.test.js`, and the golden prefix test. Expected: PASS, golden 11/11.
- [ ] **Step 5:** Commit `fix(recall): timing.totalMs covers the queue wait and the prelude (entry, queue and prelude phases)`.

### Task 9: `RecallQuery.warmOnly` — the side-effect-free warm path

**Write sites and how each is gated** (engine at `d0842424` + #195; line numbers approximate). "Not reached": the warm branch returns before it.

| Site | Write / side effect | Gate |
|---|---|---|
| `assemble-prompt-context.js` 148, 152, 1240, 1278-1320 | `recall.degraded` / `recall.block-*` / `recall.completed` events | local `emit` is a no-op when `warmOnly` |
| scheduler cache (`lib/runtime-scheduler.js` `setCachedRecall`) | cached answer for the next turn | `cacheKey: ""` (neither read nor written) |
| 236 `markNeoRecallInjection` | in-memory injection mark (the next real recall would lose its neo block) | not reached |
| 248-252 `neoStore.recordHook(Async)` | `hook-state.json` counter | not reached |
| `getNeoStore` (`create-engine.js` ~991) | `sessionWorkspaceKeys` map, `onNeoStore` host hook, `cleanupStaleNeoTempFiles` (unlink) | warm uses `peekNeoStore` (no remember, no hook, `createNeoStore(…, { readOnly: true })` skips the cleanup) |
| 316 `consumePlur1busStartNotice` | deletes the one-time start notice | not reached |
| 330 `purgeExpiredThrottled` | GC delete | not reached |
| 318 `pool.withWriteDb` + `db.init()` | may create the agent's table and directory | warm opens `withAccessReadDbs` only (read-only `init()` answers false without a table) |
| 351, 362 fast-bernd pending turns | rename + unlink | not reached |
| 377-400 emotion inference and mood files | LLM (T3) call, `.emotional-state.json`, `.current-mood.txt` | not reached |
| 508 `appendRetrievalLedger` (via `retrievalLogger`) | `retrieval-ledger.jsonl` | `retrievalLogger: null` |
| 670-821 overlays, contradictions | LLM calls, overlay and contradiction files | not reached |
| 886 `recordPendingReplyOutcome` | pending reply outcome | not reached |
| 1041, 1094-1101 dream-echo and topic cooldowns | cooldown files | not reached |
| 1157 `recordPresentation` | skill-proposal presentation ledger | not reached |
| 1180 `recordActivity` | last-activity file | not reached |
| 1198-1207 `presentReminder`, `writePendingReminders` | reminder row update, pending file | not reached |
| `recall-pipeline.js` 845 `writeKnowledgeCache` | `.adaptive-learning/knowledge-cache` | new `readOnly` param → `getKnowledgeChunks(…, { persist: false })` |
| `recall-pipeline.js` 1600, 2159 `emitRetrievalLedger` | retrieval ledger | `retrievalLogger: null` |
| `recall-pipeline.js` 1995 `recordGraphRecallMetrics` | graph metrics file | skipped when `readOnly` |
| `recall-pipeline.js` 1519-1530 `querySummarizer` | LLM call (+ LLM result cache) | `querySummarizer: null` |

Kept on purpose: `neoWorkerRuntime.warmUp()` (spawns the worker, no file), the neo reads (`readCandidates`, `readBehaviorCards`, `readGraphEdges`, `runNeoGlobalSearch`), the query embedding(s), vector search, graph expansion, rerank.

**Files:**
- Create: `engine/recall/neo-prelude.js` (the read half of the neo prelude, moved out of the assembler unchanged), `engine/recall/warm-recall-path.js`
- Modify: `engine/recall/assemble-prompt-context.js` (use `readNeoPrelude` and `autoRecallParams` — the `_autoRecallBaseParams` object ~459-512 moves to `engine/recall/recall-params.js`; `warmOnly` branch), `lib/recall-pipeline.js` (`readOnly`), `lib/neo-arch.js` (`createNeoStore(rootDir, workspaceKey, { readOnly = false } = {})`), `engine/create-engine.js` (`peekNeoStore`; `Engine.recall` forwards `warmOnly: q.warmOnly === true`; recall context view gains `peekNeoStore`, `warmRecallPath`)
- Create: `engine/recall/recall-params.js`; register the three new engine files
- Test: `tests/engine-recall-warm-only.test.js`, `tests/recall-pipeline-read-only.test.js`, `tests/helpers/fs-snapshot.js`

**Interfaces:**
- Produces:
  ```js
  // engine/recall/neo-prelude.js — exactly the current reads, logs and prelude timing fields
  export async function readNeoPrelude({ neoStore, requester, prompt, embeddings, embedTimeoutMs, timeoutSymbol, runNeoGlobalSearch, logger, prelude })
    // → { neoItems, queryVector, neoGlobalIds, neoLanes }
  // engine/recall/recall-params.js — the same object the assembler builds today; overrides win
  export function autoRecallParams(ctx, { query, timer, signal, workspaceDir, workspaceKey, agentId, memoryCtx, graphEdges, emotionalState, decisionTrace, useAssociative, assocCfg, querySummarizer, retrievalLogger, readOnly = false })
  // engine/recall/warm-recall-path.js
  /** → (event, hookCtx, { signal, memoryCtx, timer }) => Promise<RecallResult> — blocks [], degraded null */
  export function createWarmRecallPath(ctx)
  // create-engine.js
  peekNeoStore(ctx, event)   // workspaceKeyFromContext(...) without mutating sessionWorkspaceKeys or emitting onNeoStore; createNeoStore(neoRoot, key, { readOnly: true })
  // lib/recall-pipeline.js
  runRecallPipeline({ …, readOnly = false })   // readOnly → canonical cache not persisted, graph metrics not recorded
  ```
- Assembler with `opts.warmOnly === true`: `emit` no-op; `cacheKey = ""`, `background = true`, `priority: "low"`; `skipInternalRecall` ignored; the callback runs `throwIfAborted`, records `queue`, starts `prelude`, then `return warmRecallPath(event, hookCtx, { signal, memoryCtx: opts.memoryCtx, timer })` (Engine.recall always passes `memoryCtx`; the OpenClaw hook path never sets `warmOnly`). The result goes through the existing `withTiming`; the scheduler's abort/timeout branches keep their `degraded` answers, without events.
- Warm path: `timer.start("prelude")` already open → if `neoEnabled`: `neoWorkerRuntime?.warmUp?.()`, then, when `prompt.length >= 5`, `readNeoPrelude` on `peekNeoStore(hookCtx, event)`; `timer.end("prelude")`; `withAccessReadDbs(pool, sharedMemoryPool, agentId, { ...memoryCtx, logger }, async (readDbs) => …)` initialising each read db (drop `init() === false` or table-less entries; none left → return); `graphEdges` from `peekNeoStore(...).readGraphEdges(5_000)` (errors → `[]`); `runMergedNamespaceRecall(readDbs, autoRecallParams(ctx, { …, emotionalState: null, decisionTrace: null, querySummarizer: null, retrievalLogger: null, readOnly: true }), null, timer, { strictReadErrors: false, onNamespacePhases: () => {} })`; return `recallResult({ blocks: [] })`. A thrown error other than an abort → `recallResult({ degraded: { reason: "warm-failed", capability: "recall", detail } })` logged at debug.

- [ ] **Step 1: Write the failing tests:**
  - `tests/helpers/fs-snapshot.js`: `snapshotTree(root) → Map<relPath, { type, size, mtimeMs }>` (missing root → empty map), `diffSnapshots(a, b) → { added, removed, changed }`.
  - (a) `"a warm-only recall changes nothing on disk"`: engine with `neo: { enabled: true }`, stub embedder (records calls), stub reranker (records calls), `host.llm.complete` spy, `host.events.emit` spy, an `engine.events.on("recall.completed")` listener; seed: 12 captures (stored), `workspaceDir/memory/KNOWLEDGE.md` with two sections and no cache, a due reminder (seed through the reminder store the existing reminder tests use), a pending skill proposal (written with `lib/jobs/skill-miner/proposal-writer.js` into `skillLedgerDirForAgent(agentId)`, presentation age past the weekly gate), a start notice via `writePlur1busStartNotice(stateDir)` (`lib/setup/feature-profiles.js:575`, as `tests/plur1bus-start-flow.test.js` does). Snapshot `stateDir`, `baseDbPath`, `workspaceDir` and the neo root; `await engine.recall({ query: "what about the roadmap review", principal, agent, signal, warmOnly: true })` → result `blocks` `[]`, `degraded` null; all four snapshots unchanged (`diffSnapshots` empty); `llm.complete` 0 calls; `events.emit` 0 calls; listener 0 calls.
  - (b) `"a warm-only recall runs the heavy path"`: same engine → `embedQuery` called with the query (at least twice: neo prelude and pipeline); the reranker called once; `timing.phases.completed.map((c) => c.phase)` includes `queue`, `prelude`, `namespace-recall`; `timing.totalMs > 0`.
  - (c) `"a warm-only recall leaves the next real recall intact"`: after (a)'s warm, a real `recall` with the same query → returns a `neo` block and the `reminder` and `start` blocks; the stub embedder saw new `embedQuery` calls (not served from the recall cache).
  - (d) `"warming an agent without a table creates nothing"`: fresh `baseDbPath`, agent `agent-new` → `degraded` null, `blocks` `[]`, `baseDbPath` snapshot unchanged (no agent directory, no `_capture-turns`).
  - (e) `"warming a workspace principal does not create the shared root"` (setup from `tests/helpers/shared-workspace-engine.js`, fresh base; `{ skip: !stableDirectoryCapabilitiesSupported() }`): no `.plur1bus-shared` directory afterwards.
  - (f) `"warm-only honours abort and close"`: an aborted signal → `degraded.reason === "aborted"`, no events; after `close()` → `engine-closed`.
  - `tests/recall-pipeline-read-only.test.js` (g): `runRecallPipeline` on a real table with `canonicalEnabled: true` and a workspace with `KNOWLEDGE.md` → with `readOnly: true` no `.adaptive-learning` directory; with `readOnly: false` the cache file exists (current behaviour).
  - (h) unit `"createNeoStore readOnly skips the stale temp cleanup"`: a neo workspace dir with a stale `*.tmp` file matching `NEO_STALE_TMP_RE`, mtime set 2 days back with `utimesSync` → `createNeoStore(root, key, { readOnly: true })` leaves it; without the option it is removed.
- [ ] **Step 2:** Run the three files. Expected: (a)-(h) FAIL except (f)'s close case.
- [ ] **Step 3:** Move the neo reads into `readNeoPrelude` and the params into `autoRecallParams` first (behaviour-neutral); run `tests/engine-assemble-prompt-context.test.js`, every `tests/*neo*.test.js`, the golden prefix test → PASS; then add `readOnly`, `peekNeoStore`, the warm path and the assembler branch.
- [ ] **Step 4:** Run the three files, `tests/engine-assemble-prompt-context.test.js`, `tests/engine-recall-honest-timing.test.js`, `tests/engine-contract.test.js`, every `tests/*recall*.test.js` and `tests/*neo*.test.js`, and the golden prefix test. Expected: PASS, golden 11/11.
- [ ] **Step 5:** Commit `feat(recall): RecallQuery.warmOnly — the heavy recall path without writes, events, cache or LLM calls`.

### Task 10: Docs, changelog, full gate for 1.9.0

**Files:**
- Modify: `docs/engine-api.md` (header and "amended ten times"; a **1.9.0** entry after the 1.8.0 entry; new section "Engine configuration schema in 1.9.0" after the 1.8.0 status section; recall section: `warmOnly` and the timing phases; "full 1.9.0 `Engine` surface"; Hosting rules: bullets on `readAt` / `readLiveConfigValue`, on `warmOnly` for warm-ups, on fragment compaction)
- Modify: `docs/configuration.md` (German row for `runtime.lancedbCompaction.*`), `CHANGELOG.md` (`[Unreleased]`, German)

- [ ] **Step 1:** Docs section: where the schema lives and how to read it (`engine/config/engine-config.schema.json` in the package; `loadEngineConfigSchema`, `engineConfigKeys`, `readAtOf`, `livePaths`, `sensitivePaths`); the three annotations and what `live` means for a host whose `config()` returns the engine config vs. its whole config file; that `recall.*` are construction keys; the manifest is generated (`npm run gen:config-schema`, `--check`); `warmOnly` (what runs, the no-write guarantee and its table in short, background priority, not cached; hosts should warm with it after `models.warm()`); timing phases and the soft-budget consequence; compaction (defaults, fallback without stats, shared pools and explicit extra namespaces are not compacted by it — consolidate-daily still covers the agent table); neo worker lease.
- [ ] **Step 2:** CHANGELOG (German), e.g. `### Hinzugefügt`: „**`engine-config.schema.json`** beschreibt alle Engine-Schlüssel host-neutral (Typ, Default, Beschreibung, `readAt`, `x-tier`, `x-sensitive`); `openclaw.plugin.json` wird daraus erzeugt — Contract 1.9.0", „**`RecallQuery.warmOnly`** wärmt den schweren Recall-Pfad ohne Schreibzugriffe, Events, Cache oder LLM-Aufrufe"; `### Behoben`: „Capture- und Recall-Latenz wachsen nicht mehr mit der Zahl der LanceDB-Fragmente: begrenzte Kompaktierung zwischen den consolidate-daily-Läufen (`runtime.lancedbCompaction`)", „`timing.totalMs` enthält jetzt Warteschlange und Neo-Vorlauf", „Mit aktivem Neo hält die Engine nach `close()` keinen Worker-Thread mehr offen; der Prozess endet"; `### Geändert`: „Das weiche Recall-Budget zählt ab Aufruf, inklusive Warteschlange", „`reembedding.activeGeneration` wird host-neutral live gelesen".
- [ ] **Step 3:** `grep -rn '"1\.8\.0"' engine types tests docs` returns only historical annotations; `npm run gen:config-schema -- --check` exits 0.
- [ ] **Step 4:** Full gate: `npm run lint && npm run typecheck && npm test` (590000 ms) and `TZ=UTC node --test tests/golden-prefix.test.js`. Expected: green except the known baseline, golden 11/11.
- [ ] **Step 5:** Commit `docs: E5 — contract 1.9.0 (engine config schema, warm-only recall, honest timing, compaction, neo worker lease) in CHANGELOG and contract docs`.
- [ ] **Step 6:** Hand over: bundle `origin/main..feat/e5-engine-config-schema` for the owner to push via the Mac and open the PR "E5: host-neutral engine-config schema, warm-only recall, honest timing, fragment compaction, neo worker lease (contract 1.9.0)" against `main`; the owner merges.

---

## Self-review notes

- **Spec coverage:** E5 row — schema with types, defaults, descriptions and `readAt` (Task 2), the adapter translating for `openclaw.plugin.json` with a no-drift test (Task 4), the harness able to consume it (exported loader and key table, Task 2; docs Task 10); `x-tier` per D29 (all `advanced`) and sensitivity (Task 2); `readAt` made honest by an audited inventory and a host-neutral live read (Task 3). Follow-ups: (a) compaction outside consolidate-daily, bounded and concurrency-safe (Task 6) with a benchmark that can fail (Task 7); (b) warm path with every write site enumerated and gated (Task 9 table and tests); (c) timer from entry with `queue`/`prelude` phases (Task 8); (d) neo worker closed, process exits (Task 5). Contract, docs, German CHANGELOG (Tasks 1, 10).
- **Deferred with a reason:** harness consumption (its own PR); compaction of shared pools and explicit extra namespaces (consolidate-daily never covered them either; recorded in docs); warming the reranker when the agent has no candidates (the harness already reranks once per pass).
- **Type consistency:** `EngineConfigKey`/`EngineConfigSchema` (Task 1) are what `engineConfigKeys`/`loadEngineConfigSchema` return (Task 2); `livePaths()` (Task 2) is pinned against `LIVE_CONFIG_PATHS` (Task 3); `sensitivePaths()` (Task 2) feeds `deriveSecretInputPaths` (Task 4); `opts.startedAt` (Task 8) and `opts.warmOnly` (Task 9) are the assembler's two new options, both forwarded by `Engine.recall`; `fragmentCount` returns `number | null` in the adapter and the compactor.
- **Order:** 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10. Task 5 precedes the neo-enabled tests of Tasks 8 and 9; Task 6 needs Task 4's generator; Task 9 needs Task 8's `queue`/`prelude` phases.
