# D112 Model discovery (D42 model-list half) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Execution stops after Task 11. Task 12 is BLOCKED on D15 + D110 + D111; do not start it.**

**Goal:** The core keeps one model catalog per provider profile current with a scheduled and an on-demand scan, never deleting an entry and never touching a role assignment, and tells the owner what appeared, all built now behind four narrow ports so D15, D110 and D111 plug in later without rework.

**Architecture:** A `packages/core/src/discovery/` module (catalog store, metadata table, origin-pinned HTTP client, four scanners, reconcile, service, scheduler) reaches profiles, credentials, events and time only through ports with in-memory adapters (P1). The scan is a harness-side *system job* in a small new `system-jobs/` registry with its own ledger; `jobs.list|run|history` merge it with the engine's agent jobs per R2 (P3, P4). RPC `models.*` and the `plur1bus model` CLI sit on the one service.

**Tech Stack:** TypeScript on Node 24.21 (`erasableSyntaxOnly`, `node:http`/`node:https`/`node:zlib`, `node:test`), JSON Schema (rpc, config), Rust 1.95 (clap 4, serde_json; no new crate).

**Spec:** `docs/superpowers/specs/2026-10-03-model-discovery-design.md` (binding: D112, R1-R20, tests in §6, effort §8). Read with `AGENTS.md`, `docs/rpc.md` (`jobs.*`), ADR-009 (ledger row before the body), ADR-013 §2, §8, ADR-016 §4, §8.

## Global Constraints

Every task's requirements implicitly include this section. Values are copied from the spec.

- **Never deleted, never assigned:** a missing model becomes `unavailable` and returns to `available` when listed again; only a person deletes, and only a `manual` entry (R5). A scan writes no role, no D30 tier list, no agent policy (R4). `modelRoles` is byte-identical before and after any scan.
- **Failure changes nothing:** an empty list, any failure and a mid-pagination error leave every entry as it was; a scan is all or nothing; **one invalid entry fails the whole scan** (R6). Failures set only `lastResult`, `nextScanAt` (and the failure counter).
- **Credentials never leave their endpoint (R10):** the client is pinned to the profile's origin (scheme, host, port); a cross-origin redirect is not followed (`failed:invalid`, `redirect_foreign_origin`); same-origin redirects at most 3, never `https` to `http`; pagination never fetches a response URL; the credential travels in a header only; `User-Agent: plur1bus/<version>`; no interactive login is ever started by a scan.
- **Limits (R11):** connect timeout 5 s, request timeout 15 s, 60 s per provider scan, at most 10 pages, body at most 4 MiB after decompression (8 MiB over all pages), at most 5 000 entries, `Content-Type` must be JSON; id regex `^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$`; strings at most 512 bytes and control-character free; numbers finite positive integers; duplicate ids keep the first and are counted.
- **Schedule (R12, R13):** default 24 h, `nextScanAt = lastScanAt + interval x (1 + 0.1 x (2u - 1))`, floor 1 h; catch-up only after `core.process.ready`, `ready + u x 60 s`, at least 2 s apart; backoff `min(5 min x 2^n, 6 h)` x (1 +/- 0.1) for the n-th consecutive network or server failure (the first failure waits 5 min); `Retry-After` honoured up to 24 h; 401/403 `failed:auth`, no retry before the next regular slot; one scan per provider, at most 4 providers in parallel. Config keys `models.scan.enabled` (default `true`) and `models.scan.intervalHours` (default `24`, 1-168), both `x-restart: "live"`, `x-tier: "advanced"`.
- **Catalog file (R18):** `<home>/catalog/models.json`, schema id `plur1bus.model-catalog/1`, `0600`, written to `models.json.tmp-<pid>`, fsynced, renamed; previous file kept once as `models.json.prev`; an invalid file moves to `models.json.corrupt-<ts>`, the core starts from `.prev` if valid else empty, and a rescan follows. Core-owned, one writer, one in-process mutation lock; not in `config.json`.
- **Events (R16):** `models.changed` after the durable write only; D111-shaped events `model.discovered`, `model.unavailable` (`warn` when a role points at one), `model.scan.failed` (`warn` for network, server, 429, empty; `error` for auth, invalid), `model.scan.completed` (`debug`); one record per provider per scan, first 20 ids, never one per model. No OS notifications.
- **D109:** reads and writes only under the harness home (`catalog/`, `state/`, `logs/`); opens no other path, runs no process, reads no credential file; network only to each profile's own `baseUrl`.
- **Redaction:** no token, header value, lease, response body or authorization URL in a log, `--json`, the ledger, the catalog or an error message. Only counts, model ids and typed error fields.
- **Tests use no real data (R19):** synthetic ids (`example-*`), invented keys (`CANARY-*`), loopback fakes; no live provider call.
- **RPC (ADR-016):** every `models.*` method and `models.changed` carry `x-server: "core"`, `x-stability: "experimental"`, `x-since: "1.5.0"`; params closed (`additionalProperties: false`); one minor bump `1.4.0` to `1.5.0`; `job.run` unchanged. Never hand-edit `generated/` or a generated doc: run `pnpm gen` and `pnpm docs:gen`.
- **CLI (ADR-016 §8):** `--json` prints the raw RPC value plus the top-level `schema` id inserted by `output.rs`; ids `model.list/1`, `model.scan/1`, `model.override/1`; leaf commands carry `[experimental]`.
- **Code:** TypeScript with `erasableSyntaxOnly` (no `enum`, no parameter properties); the hygiene rule of `AGENTS.md` holds (`node scripts/lint-hygiene.mjs`: no host-adapter idiom or host env name in source); English.
- **Commits:** `git -c user.name=Cyb3rb1ade -c user.email=84099452+Cyb3rb1ade@users.noreply.github.com commit`; every body ends with the two trailers shown in each task's commit step. Never push, amend, rebase, stash or change git config.

## Review Focus

Five inputs the spec implies but no §6 line names, most likely first. Each is pinned by a named test in its owning task.

1. **A vendor answers 200 with an empty list, or dies on page 4 of 6.** Expected: nothing becomes `unavailable`, state says `failed:empty` / `failed:server`, the catalog is byte-identical. Task 5 (reconcile refuses `[]`), Task 6 (`a mid-pagination failure reconciles nothing`, `an empty list is failed:empty`).
2. **Legal but odd ids and one bad entry among hundreds:** `llama3.2:latest`, `vendor/model@v1+x`, ids differing only by case, a 256-char id; versus a space, an emoji, a control character, a 257-char id. Expected: the legal ones are kept distinct, one bad one fails the scan with `invalid_entry` and nothing else changes. Task 3 (`validate.test.ts`), Task 4.
3. **A role names a vanished model by alias or `provider/model`, where the provider id contains `:` and the model id contains `/`.** Expected: resolved by the longest provider prefix, then bare id or alias; warning, role untouched; the same answer from TypeScript and Rust. Task 5 (`roles.test.ts` on the shared vectors), Task 10.
4. **The clock misbehaves: laptop asleep for days, system clock stepped back.** Expected: one scan per provider on wake (no burst), then a fresh jittered slot; a `nextScanAt` far in the future is clamped to at most 1.1 x interval ahead. Task 8.
5. **A hostile or sloppy `baseUrl`:** userinfo (`https://u:p@host/v1`), a query string, plain `http` to a non-loopback host with a credential. Expected: `failed:invalid` (`invalid_base_url` or `insecure_transport`) before any socket opens, and the value never logged. Task 3.

---

## How to run anything

```bash
export PATH=/home/claude/.node24/bin:$PATH      # node -v prints v24.21.0
cd /home/claude/work/plan-md                     # branch docs/model-discovery-plan is for this plan only; implement on a new branch feat/d112-model-discovery from origin/main
# One core test file (CT <file> below means exactly this, run in packages/core):
cd packages/core && node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning --test --test-concurrency=1 test/<path>.test.ts
```

Green before every commit that touches more than one package: `pnpm gen && pnpm build && pnpm lint && pnpm test && cargo fmt --all -- --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace --no-fail-fast && pnpm docs:check`. Expected tail of `pnpm test`: every package `# fail 0`.

## Plan rulings (beyond the spec; numbered P1...)

| # | Choice | Why and cost |
|---|---|---|
| P1 | **Port boundary.** `ports.ts` defines `ProfileSource`, `CredentialResolver`, `DiscoveryEvents`, `Clock` (plus `Rng = () => number`, needed for jitter and kept beside `Clock`). Nothing outside `ports.ts` and `defaults.ts` names a D15, D110 or D111 type. `modelRoles` is read from the live config through a plain `() => Record<string, string>`, not a port. Until Task 12 the core runs the defaults: empty `ProfileSource`, a resolver that returns `null`, `Clock` over `Date`/timers, events written through the core logger. | Owner decision 2026-10-03. Cost: with no profiles source the shipped core scans nothing until Task 12; tests inject adapters through `CoreOptions.discovery`. |
| P2 | **Twelve tasks, not ten.** Scanners split into client+validation (T3) and the four scanners (T4); reconcile (T5, pure) is split from the service (T6, orchestration, errors, events, state); the scheduler (T8) is split from the system job (T7). | Each is a reviewer's separate gate; T5 and T3 are pure and parallelisable. |
| P3 | **System jobs live in the harness.** New `packages/core/src/system-jobs/` (`ledger.ts`, `index.ts`); the engine registry is untouched. Names in the system registry are refused at registration if the engine already has the same job name. | The engine's registry is per agent and cannot hold an agentless job (spec F6). |
| P4 | **Wire shape for system runs.** `$defs/JobRun` requires `agentId`, so a system run cannot be a `JobRun`. New closed `$defs/SystemJobRun` (`runId`, `job`, `kind: "system"`, `trigger`, `startedAt`, `finishedAt`, `durationMs`, `outcome`, `reason?`, `runningRunId?`, `attempt`, `args?`); `jobs.run` result and `jobs.history` rows become `oneOf [JobRun, SystemJobRun]`; `jobs.list` items gain optional `kind`, `schedule`, `nextRunAt`. Agent rows stay byte-identical (no `kind` added). | Spec §2.3 says rows "carry `kind`" and "no `agentId`" but leaves `JobRun` required-`agentId`; loosening it would break typed clients. Cost: a `oneOf` in two results. |
| P5 | **Ledger = one JSONL file**, `state/system-jobs/ledger.jsonl` (0600), not a "core-store table": the core has no store of its own (the engine owns LanceDB). ADR-009 order: a `started` row is appended and fsynced before the body, a `finished` row after; a `started` without a `finished` and no run in flight reads back as `abandoned`, reason `core_stopped`. A skip appends both rows before returning. No rotation (about one row per provider per day). | Closest honest reading of ADR-009 and the spec's "table". |
| P6 | **Trigger mapping:** schedule tick `cron`, start catch-up `harness`, RPC/CLI/`jobs.run` `manual` (the existing `JobTrigger` enum, no new value). **`disabled`:** `models.scan.enabled = false` arms no timer; any run request (RPC, CLI, `jobs.run`) is a skip with outcome `disabled` and a ledger row. | Spec lists `disabled` as a skip reason but not who asks. |
| P7 | **State semantics.** `lastScanAt` is the last **successful** scan (spec §2.9: failures set only `lastResult` and `nextScanAt`); `consecutiveFailures` is persisted in the provider state (extra integer, omitted when 0) so backoff survives a restart. After a non-retryable failure (`auth`, `invalid`, `empty`) `nextScanAt = now + regular interval` (jittered, floor 1 h). The 1 h floor applies to the regular cadence **after** jitter; a backoff retry may be sooner than 1 h. Catch-up scans a provider when `lastScanAt` is missing or older than the interval **and** `nextScanAt` is missing or not in the future (a provider in backoff is not hammered by restarts). A manual scan sets `consecutiveFailures` to 0 first. A failed catalog write changes no persisted state; the result reports `nextScanAt = now + 5 min` and the scheduler arms from the result. | The spec's "lastScanAt not advanced as a success" only makes sense this way. |
| P8 | **HTTP client is `node:http`/`node:https`, not `fetch`.** The lease is bound into the client (`Scanner = (profile, client)`), not passed as a third argument. A credential goes over `http:` only to loopback (`127.0.0.0/8`, `::1`, `localhost`), else `failed:invalid` `insecure_transport`; a `baseUrl` with userinfo or a query is `invalid_base_url`. Other 4xx (for example 404) is `failed:invalid`, reason `http_<status>`. | Control over connect timeout, redirects and the decompression cap that undici does not give; the spec is silent on non-401/403/429 4xx and plain http. |
| P9 | **Role resolution (D15/D18 define no value format yet).** A `modelRoles.<role>` string resolves, in order: (1) `<provider>/<rest>` for the longest provider id `P` in the catalog with `value` starting `P + "/"`, matching `rest` against id or alias of `P`; (2) bare value against id or alias of every entry. A role warns only if every match is `unavailable`. The rule is tested on one shared vector file, `packages/core/test/fixtures/discovery/role-vectors.json`, also read by the Rust unit test (Task 10), because `model list` and `1staid` resolve roles with the core down. Task 12 re-checks it against D18's final format. | Provider ids contain `:`, OpenRouter-style model ids contain `/`. |
| P10 | **`models.scan` result carries `startedAt` and `finishedAt`** (ISO) so `--json` stays the raw RPC value (spec §2.10 puts them on the CLI document, which R13 forbids). `models.changed.at` is an RFC 3339 string like every catalog timestamp. `jobs.list` system entry: `schedule: { every: <ms>, jitter: 0.1 }`, `nextRunAt: <epoch ms> \| null`. | Spec leaves the types open. |
| P11 | **Model entries carry an `api` object** (the descriptive values the API gave at the last scan: `displayName`, `kind`, `contextWindow`, `capabilities`), internal, never on the wire. Needed to re-run precedence after a table upgrade without a scan (§2.5) and to recompute after `clear`. Absent on `manual` entries. | The spec's entry has nowhere to keep API values apart from effective ones. |
| P12 | **File write helper.** D111's private-file helper does not exist; the store uses `createPlatformCapabilities(...).securePath` (module-api `createSecurePath`: `chmod 0600` on POSIX, user + SYSTEM DACL on Windows) on the temp file and `.prev`, with `fsync` before `rename`. `models.json.prev` is copied from the validated in-memory previous file, never renamed, so `models.json` always exists. After quarantine or `.prev` recovery the store clears every provider's `lastScanAt` so the first catch-up rescans. | `config-load.ts`'s write has no fsync; the spec asks for one. |
| P13 | **Metadata table seed.** The spec's own synthetic example (`generic` `example-embed-*`, vendor `example-vendor`) ships as the table; the JSON is imported with `with { type: "json" }` (bundled into `dist/core.js`, no file to ship). Real vendor ids and context windows are **not invented here**: they arrive as a data-only change after someone reads each vendor's published list (R8, R19). The loader, validator and table test are complete. | Spec §2.5 defers real entries to "the M2 plan"; this plan cannot source them without guessing. |
| P14 | **`1staid check models.roles` is in Task 10** (spec §2.11 and §8 list it; the owner's decomposition did not). Read-only, from `catalog/models.json` and `config.json`. | One missing spec surface. |
| P15 | **WebMCP deny list** gains `models.scan`, `models.setOverride`, `models.removeManual`, `models.acknowledge` (owner actions, not agent tools, D109); `models.list` stays opt-in as any experimental method. | Same reasoning as the `ext.*` mutations. |
| P16 | **Test seams.** `CoreOptions.discovery?: Partial<DiscoveryAdapters> & { scheduler?: boolean }` (in-process). For the binary: `PLUR1BUS_TEST_DISCOVERY_PROFILES=<json file>`, honoured only with `PLUR1BUS_ALLOW_TEST_INTERNALS=1`, builds the in-memory `ProfileSource`/`CredentialResolver` and turns the scheduler off (a random catch-up scan would race the system test). It is independent of `--test-internals` (one variant string only). | Needed by Task 11; stays after Task 12 as a test seam. |
| P17 | **Effort** maps to spec §8 in "Task map" below: 4.4 ad now plus 0.4 ad blocked = 4.8 ad, inside the spec's 3-5. | |

## File structure

```
packages/core/src/discovery/   types.ts ports.ts testing.ts defaults.ts catalog-store.ts metadata.ts http.ts validate.ts
                               scanners/{openai,anthropic,google,ollama,index}.ts reconcile.ts overrides.ts roles.ts
                               schedule.ts service.ts events-logger.ts job.ts scheduler.ts
packages/core/src/system-jobs/ ledger.ts index.ts
packages/core/catalog/model-metadata.json
packages/core/test/discovery/  *.test.ts (one per source file above) + discovery-e2e.test.ts
packages/core/test/fixtures/   model-ids/<vendor>.json  discovery/*.json
packages/core/test/helpers/    fake-endpoint.ts
crates/plur1bus/src/commands/model.rs   crates/plur1bus/tests/model_cli.rs   tests/system/model-discovery.test.ts
```

## Task map and effort

| # | Task | Produces (used by) | ad |
|---|---|---|---|
| 1 | Types, ports, test adapters, catalog store (R18) | `CatalogStore`, ports (2-12) | 0.4 |
| 2 | Metadata table, loader, enrichment (R7, R8) | `enrich`, `CompiledTable` (5, 6) | 0.25 |
| 3 | Pinned HTTP client and strict validation (R10, R11) | `PinnedClient`, `validate` (4, 6) | 0.5 |
| 4 | Four wire-profile scanners (R9) | `SCANNERS` (6) | 0.5 |
| 5 | Reconcile, overrides, role resolution (R4-R6, R14, R15) | pure catalog domain (6, 9) | 0.5 |
| 6 | Schedule math, discovery service, logger events | `DiscoveryService` (7-9) | 0.4 |
| 7 | System job kind, ledger, `jobs.*` merge, core wiring (R2) | `SystemJobs` (8, 9) | 0.35 |
| 8 | Scheduler, config keys, ready hook (R12, R13) | live schedule | 0.4 |
| 9 | RPC `models.*`, `models.changed`, schema bump, WebMCP deny | RPC (10, 11) | 0.4 |
| 10 | CLI `model list\|scan\|override`, `1staid check models.roles` (R17) | CLI | 0.4 |
| 11 | End to end through RPC and CLI, D109 spies, docs (R19) | acceptance | 0.3 |
| 12 | **BLOCKED:** wire real adapters (D15, D110, D111) | | 0.4 |

Mapping to spec §8 (3-5 ad): scanners T3+T4 = 1.0 (1-1.5); catalog, reconcile, overrides, roles T1+T5 = 0.9 (0.75-1.25); system job, scheduler, backoff T7+T8 = 0.75 (0.5-1); metadata T2 = 0.25 (0.25-0.5); RPC, CLI, events T9+T10 = 0.8 (0.5-0.75, over by 0.05; it carries `1staid`); T6 and T11 (service integration, end to end) are not priced as rows by the spec and are absorbed in the ranges' upper ends. **Now: 4.4 ad; with T12: 4.8 ad.**

Order: T1 first; T2, T3 parallel after T1; T4 after T3; T5 after T1, T2; T6 after T3-T5; T7 after T6; T8 after T7; T9 after T7; T10 after T9; T11 after T8, T10.

---

### Task 1: Types, ports, test adapters, catalog store

**Files:**
- Create: `packages/core/src/discovery/{types,ports,testing,catalog-store}.ts`
- Modify: `packages/core/src/paths.ts` (`Layout` gains `catalog`, `catalogModels`, `systemJobs`), `packages/core/src/core.ts` (`mkdirSync` list adds `l.catalog`, `l.systemJobs`)
- Test: `packages/core/test/discovery/catalog-store.test.ts`, `packages/core/test/discovery/fake-clock.test.ts`, `packages/core/test/paths.test.ts`

**Interfaces:**
- Produces (`types.ts`):
```ts
export const MODEL_KINDS = ["chat","embedding","tts","asr","image","moderation","rerank","realtime","unknown"] as const;
export const CAPABILITIES = ["tools","vision","reasoning","audio_in","audio_out","structured_output","prompt_caching"] as const;
export const DISCOVERY_KINDS = ["openai-models","anthropic-models","google-models","ollama-tags","manual"] as const;
export type ModelKind = typeof MODEL_KINDS[number]; export type Capability = typeof CAPABILITIES[number]; export type DiscoveryKind = typeof DISCOVERY_KINDS[number];
export type ModelStatus = "available" | "unavailable" | "manual"; export type ModelSource = "scan" | "table" | "manual";
export type ScanResultCode = "ok" | "failed:auth" | "failed:network" | "failed:server" | "failed:invalid" | "failed:empty";
export type ScanOutcomeCode = ScanResultCode | "already_running" | "disabled" | "no-scanner";
export type RunTrigger = "cron" | "manual" | "harness";
export interface ModelOverrides { displayName?: string; kind?: ModelKind; contextWindow?: number; capabilities?: Capability[]; aliases?: string[] }
export interface ApiFields { displayName?: string; kind?: ModelKind; contextWindow?: number; capabilities?: Capability[] }
export interface RawEntry extends ApiFields { id: string; created?: number /* epoch ms */ }
export interface CatalogModel { provider: string; id: string; displayName: string; kind: ModelKind; contextWindow?: number; capabilities: Capability[]; aliases: string[];
  status: ModelStatus; firstSeen: string; lastSeen: string; source: ModelSource; overrides: ModelOverrides; api?: ApiFields }
export interface ProviderScanState { lastScanAt?: string; lastResult?: ScanResultCode; nextScanAt?: string; consecutiveFailures?: number }
export interface CatalogFile { schema: "plur1bus.model-catalog/1"; revision: number; tableRevision: string; acknowledgedAt?: string;
  providers: Record<string, ProviderScanState>; models: CatalogModel[] }
export type ScanWarning = { code: "role_unavailable"; role: string; provider: string; id: string } | { code: "shadowed_by_manual"; provider: string; id: string } | { code: "empty_list"; provider: string };
export interface ScanErrorInfo { code: "auth"|"network"|"timeout"|"server"|"rate-limited"|"invalid-request"; reason: string; retryable: boolean; hint: string; httpStatus?: number; retryAfterS?: number }
export function emptyCatalog(tableRevision: string): CatalogFile;   // revision 0, no providers, no models
```
- Produces (`ports.ts`):
```ts
export interface ProfileInfo { id: string; discovery: DiscoveryKind; baseUrl: string; vendor?: string }
export interface ProfileSource { list(): readonly ProfileInfo[] }
export interface CredentialLease { origin: string; headerName: string; headerValue: string }
export class CredentialUnavailableError extends Error { readonly reason: "renew_sign_in" | "no_credential" }
export interface CredentialResolver { /** null = the profile needs no credential. Throws CredentialUnavailableError; refuses an origin that is not the profile's own. */
  resolve(profileId: string, origin: string): Promise<CredentialLease | null> }
export interface DiscoveryEvents {
  discovered(e: { provider: string; count: number; models: string[]; reappeared: string[]; truncated: boolean; traceId: string }): void;
  unavailable(e: { provider: string; count: number; models: string[]; roles: string[]; truncated: boolean; traceId: string }): void;
  scanFailed(e: { provider: string; result: ScanResultCode; httpStatus?: number; retryAfterS?: number; nextScanAt: string; consecutiveFailures: number; err: ScanErrorInfo; traceId: string }): void;
  scanCompleted(e: { provider: string; result: ScanResultCode; durationMs: number; counts: { new: number; reappeared: number; unavailable: number; unchanged: number; duplicates: number }; traceId: string }): void }
export interface TimerHandle { cancel(): void }
export interface Clock { now(): number; setTimer(fn: () => void | Promise<void>, ms: number): TimerHandle }
export type Rng = () => number;   // [0, 1)
```
- Produces (`testing.ts`): `class InMemoryProfileSource implements ProfileSource { constructor(profiles: ProfileInfo[]); set(profiles: ProfileInfo[]): void }`, `class StaticCredentialResolver implements CredentialResolver { constructor(byProfile: Record<string, { origin: string; headerName: string; headerValue: string } | "renew_sign_in" | null>) }` (throws on an origin that differs from the registered one), `class RecordingEvents implements DiscoveryEvents { readonly log: { name: string; e: unknown }[] }`, `class FakeClock implements Clock { constructor(start: number); advance(ms: number): Promise<void> /* fires due timers in order, awaits each */; jump(ms: number): Promise<void> /* moves time, fires each overdue timer once */; pending(): number }`, `function sequenceRng(values: number[]): Rng` (cycles).
- Produces (`catalog-store.ts`):
```ts
export class CatalogWriteError extends Error { readonly cause: unknown }
export function validateCatalog(raw: unknown): { ok: true; file: CatalogFile } | { ok: false; errors: string[] };
export interface LoadResult { file: CatalogFile; recovered: "none" | "prev" | "empty"; quarantinedTo?: string }
export interface CatalogStore {
  load(): LoadResult;                       // sync, at core start; removes stray models.json.tmp-*; quarantines, recovers (P12)
  read(): CatalogFile;                      // a deep copy of the current in-memory file
  mutate<T>(fn: (c: CatalogFile) => { next: CatalogFile; result: T }): Promise<T>;   // one lock; revision + 1; durable write before memory changes; throws CatalogWriteError
}
export function createCatalogStore(o: { path: string; tableRevision: string; clock: Clock; securePath: (p: string) => unknown;
  logger: { info(m: string, f?: object): void; warn(m: string, f?: object): void }; hooks?: { beforeRename?: () => void } }): CatalogStore;
```
- `Layout` additions: `catalog` = `<home>/catalog`, `catalogModels` = `<home>/catalog/models.json`, `systemJobs` = `<home>/state/system-jobs`.

- [ ] **Step 1: Write the failing tests** (`catalog-store.test.ts`, temp home from `tempDir("p1b-cat-")`):
```ts
it("creates models.json 0600 with the schema id and revision 1", { skip: win }, ...)   // mode & 0o777 === 0o600; parsed.schema === "plur1bus.model-catalog/1"; revision === 1
it("secures the temp file before the rename and the .prev copy", ...)   // securePath spy: first arg matches /models\.json\.tmp-\d+$/; a later one ends "models.json.prev"
it("keeps exactly one .prev", ...)   // after 3 mutations models.json.revision === 3 and models.json.prev.revision === 2; no models.json.tmp-* left
it("a kill between write and rename leaves the old file intact", ...)   // hooks.beforeRename throws: models.json still revision N; a new store's load() removes models.json.tmp-*
it("a failed write advances no state and releases the lock", ...)   // mutate rejects CatalogWriteError; read().revision unchanged; the next mutate succeeds
it("mutations are serialised", ...)   // two concurrent mutates: revisions 1 and 2, both effects present
it("quarantines an invalid file and starts from a valid .prev", ...)   // recovered "prev"; models.json.corrupt-<digits> exists; every providers[*].lastScanAt undefined; models kept
it("both files invalid starts empty", ...)   // recovered "empty"; revision 0; models []
it("validateCatalog refuses", ...)   // other schema id, status "deleted", duplicate (provider,id), missing models, models.json larger than 16 MiB
it("the real securePath applies a user+SYSTEM DACL on win32", { skip: !win }, ...)   // createSecurePath()(models.json).applied === true
```
and `fake-clock.test.ts`: `advance(1000)` fires timers set at 300, 100, 700 in the order 100, 300, 700 and leaves one at 1500 pending; `cancel()` removes a timer; `jump(3 * 86_400_000)` fires each pending timer exactly once; `paths.test.ts`: `layout("/h").catalogModels === "/h/catalog/models.json"`.
- [ ] **Step 2: Run, expect failure.** `CT discovery/catalog-store` → FAIL `ERR_MODULE_NOT_FOUND ... catalog-store.ts`.
- [ ] **Step 3: Implement** `types.ts`, `ports.ts`, `testing.ts`, `catalog-store.ts` with the signatures above; write path: open `models.json.tmp-<pid>` mode `0o600`, `writeSync`, `fsyncSync`, `securePath(tmp)`, copy validated previous to `.prev` and `securePath` it, `hooks.beforeRename?.()`, `renameSync`; update memory only after the rename. `validateCatalog` is hand-written (no ajv), strict on fields it knows.
- [ ] **Step 4: Run, expect pass.** `CT discovery/catalog-store`, `CT discovery/fake-clock`, `CT paths` → `# fail 0`.
- [ ] **Step 5: Commit**
```bash
git add packages/core/src/discovery packages/core/src/paths.ts packages/core/src/core.ts packages/core/test/discovery packages/core/test/paths.test.ts
git -c user.name=Cyb3rb1ade -c user.email=84099452+Cyb3rb1ade@users.noreply.github.com commit -m "feat(core): model catalog store, discovery ports and test adapters (D112 R18)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SxcLhve6hyM9AFm2nU9B3F"
```

---

### Task 2: Metadata table, loader, enrichment

**Files:**
- Create: `packages/core/catalog/model-metadata.json` (the spec §2.5 example verbatim, revision `2026-10-03.1`, P13), `packages/core/src/discovery/metadata.ts`
- Test: `packages/core/test/discovery/metadata.test.ts`; fixtures `packages/core/test/fixtures/model-ids/generic.json` (`["example-embed-small","example-embed-large"]`), `packages/core/test/fixtures/model-ids/example-vendor.json` (`["example-chat-large","example-chat-small","example-chat-large-20260101"]`)

**Interfaces:**
- Consumes: `ModelKind`, `Capability`, `ApiFields`, `ModelOverrides`, `CatalogModel`, `CatalogFile` (Task 1).
- Produces:
```ts
export interface MetadataRule { pattern: string; kind: ModelKind; contextWindow?: number; capabilities: Capability[]; aliases?: string[] }
export interface CompiledTable { revision: string; sections: Map<string, { rule: MetadataRule; re: RegExp }[]> }
export function loadMetadataTable(raw?: unknown): CompiledTable;   // default: the bundled JSON; throws Error listing every violation
export function lookup(t: CompiledTable, vendor: string | undefined, id: string): MetadataRule | null;   // vendor section first, then "generic"; first match wins
export function heuristicKind(id: string): ModelKind;               // "unknown" when nothing matches, never "chat"
export type Effective = Pick<CatalogModel, "displayName" | "kind" | "contextWindow" | "capabilities" | "aliases">;
export function enrich(id: string, api: ApiFields, overrides: ModelOverrides, t: CompiledTable, vendor: string | undefined): { fields: Effective; source: "scan" | "table" };
export function reenrichCatalog(c: CatalogFile, t: CompiledTable, vendorOf: (provider: string) => string | undefined): CatalogFile;
```
Precedence per field: override > API > table > heuristic (`kind` only) > `unknown` / absent / `[]`; `displayName` falls back to the id; `aliases` come from override, else table. `source` is `table` when the table supplied at least `kind`, `contextWindow` or `capabilities` that the API did not. Heuristic fragments: `embed`, `rerank`, `whisper|transcribe` to `asr`, `tts|speech` to `tts`, `moderation`, `dall-e|imagen|image` to `image`, `realtime`, and `gpt-live` to `realtime` (R7, GPT-Live ids). `reenrichCatalog` rewrites only entries with `source: "table"` from their `api` object (P11), keeps overrides, sets `tableRevision`, leaves `source: "scan"` and `manual` entries alone.

- [ ] **Step 1: Write the failing tests** (spec §6 item 5):
```ts
it("every pattern matches at least one known id in fixtures/model-ids/<section>.json", ...)   // per rule: some fixture id whose first match is that rule
it("has no duplicate pattern within or across sections", ...)
it("every pattern is anchored, at most 200 characters and in the RE2-safe subset", ...)   // loadMetadataTable rejects "(a)\\1", "(?=x)", "(?<!x)", "(?<n>x)\\k<n>", a 201-char pattern, an unanchored "example"; accepts "^example-chat-(large|small)(-\\d{8})?$"
it("every kind and capability is in the registered vocabulary", ...)   // a rule with kind "chatty" or capability "telepathy" is rejected
it("first match wins, order pinned", ...)   // [^example-chat-.+$ (kind chat), ^example-chat-large$ (kind rerank)] returns chat; reversed returns rerank
it("an id nothing matches is unknown, not chat", ...)   // enrich("zzz-frobnicate", {}, {}, t, undefined).fields.kind === "unknown"
it("precedence override > API > table > heuristic", ...)   // table 128000, API 64000, override 32000 -> 32000; without override 64000; without API 128000
it("heuristicKind", ...)   // whisper-large asr, tts-1 tts, dall-e-3 image, gpt-live-example realtime, acme-rerank-v2 rerank, acme-chat unknown
it("source is table only when the table filled a field", ...)
it("reenrichCatalog re-reads table entries only", ...)   // a table-source entry takes a new revision's kind; a scan-source and a manual entry and every override stay as they were; tableRevision updated
```
- [ ] **Step 2: Run, expect failure.** `CT discovery/metadata` → FAIL `ERR_MODULE_NOT_FOUND`.
- [ ] **Step 3: Implement `metadata.ts`**; import the table with `import table from "../../catalog/model-metadata.json" with { type: "json" }`. RE2-safe check = reject backreferences, named groups with `\k`, lookaround, length > 200, and require `^` and `$`.
- [ ] **Step 4: Run, expect pass.** `CT discovery/metadata` → `# fail 0`; `pnpm --filter @plur1bus/core build` succeeds and `grep -c example-embed packages/core/dist/core.js` prints `1` or more (the table is bundled).
- [ ] **Step 5: Commit** (`git add packages/core/catalog packages/core/src/discovery/metadata.ts packages/core/test/discovery/metadata.test.ts packages/core/test/fixtures/model-ids`) with subject `feat(core): curated model metadata table, loader and enrichment precedence (D112 R7, R8)` and the same two trailers.

---

### Task 3: Pinned HTTP client and strict validation

**Files:**
- Create: `packages/core/src/discovery/{http,validate}.ts`, `packages/core/test/helpers/fake-endpoint.ts`
- Test: `packages/core/test/discovery/http.test.ts`, `packages/core/test/discovery/validate.test.ts`

**Interfaces:**
- Consumes: `CredentialLease`, `ScanResultCode`, `RawEntry` (Task 1).
- Produces (`http.ts`):
```ts
export const LIMITS: { connectTimeoutMs: 5000; requestTimeoutMs: 15000; scanTimeoutMs: 60000; maxPages: 10; maxBodyBytes: 4194304; maxTotalBytes: 8388608; maxEntries: 5000; maxRedirects: 3; maxStringBytes: 512 };
export class ScanError extends Error { readonly result: Exclude<ScanResultCode, "ok" | "failed:empty">; readonly reason: string; readonly httpStatus?: number; readonly retryAfterMs?: number }
export interface PinnedClient { get(req: { path: string; query?: Record<string, string> }, headers?: Record<string, string>): Promise<unknown>   /* parsed JSON */; readonly pages: number }
export interface PinnedClientOptions { baseUrl: string; lease: CredentialLease | null; userAgent: string; signal?: AbortSignal; limits?: Partial<typeof LIMITS>; lookup?: net.LookupFunction /* test seam */ }
export function createPinnedClient(o: PinnedClientOptions): PinnedClient;   // throws ScanError invalid_base_url / insecure_transport
export function parseRetryAfter(value: string | undefined, nowMs: number): number | undefined;   // ms, seconds or HTTP date, capped at 86_400_000
```
  `get` joins `path` onto the base path (`baseUrl` already carries `/v1`), encodes `query` values, checks the request URL's origin equals the base origin before every socket, follows same-origin redirects at most 3 times with the same headers, refuses any other origin without opening a socket, counts pages, and enforces every R11 limit; `Accept-Encoding: gzip`, decompression through `zlib` with `maxOutputLength`.
- Produces (`validate.ts`):
```ts
export const ID_RE: RegExp;   // ^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$
export function checkId(v: unknown): string;                       // throws ScanError failed:invalid invalid_entry
export function checkString(v: unknown): string;                   // <= 512 UTF-8 bytes, no C0/DEL/C1 control characters
export function checkPositiveInt(v: unknown): number;              // finite positive integer
export function finalizeEntries(entries: RawEntry[]): { entries: RawEntry[]; duplicates: number };   // keeps the first duplicate; > 5000 -> too_many_entries
```
- Produces (`helpers/fake-endpoint.ts`): `startFakeEndpoint(handler: (req: { method: string; url: string; headers: IncomingHttpHeaders }) => { status?: number; headers?: Record<string, string>; json?: unknown; body?: Buffer; stall?: boolean }): Promise<{ origin: string; port: number; requests: { url: string; headers: IncomingHttpHeaders }[]; close(): Promise<void> }>` on `127.0.0.1`.

- [ ] **Step 1: Write the failing tests.** `http.test.ts` (each asserts a `ScanError` with the given `result` and `reason`):
```ts
it("sends GET with the credential in a header and the plur1bus User-Agent only", ...)   // requests[0].headers.authorization === "Bearer CANARY-KEY-1"; user-agent matches /^plur1bus\/\d+\.\d+\.\d+/; no cookie header; url has no "CANARY"
it("refuses a non-JSON Content-Type", ...)               // failed:invalid content_type
it("refuses a body over 4 MiB, declared or streamed", ...)   // failed:invalid response_too_large
it("refuses a gzip bomb over the decompressed cap", ...)    // ~8 KiB gzip of zeros expanding past 4 MiB -> response_too_large
it("refuses more than 8 MiB over all pages and an 11th page", ...)   // third 3 MiB body -> response_too_large; 11th get -> too_many_pages
it("times out a stalled request", ...)                   // limits.requestTimeoutMs 50 -> failed:network request_timeout
it("times out the connect phase", ...)                   // lookup that never calls back, limits.connectTimeoutMs 50 -> failed:network connect_timeout
it("does not follow a 302 to another origin", ...)       // second fake: requests.length === 0; failed:invalid redirect_foreign_origin; second never saw a credential
it("treats a Location differing only by port or by scheme as foreign", ...)   // table of three Locations, each redirect_foreign_origin, zero requests to the target
it("follows at most 3 same-origin redirects", ...)       // 3 -> ok; 4 -> failed:invalid too_many_redirects
it("sends a cursor that looks like a URL as an encoded query value to the same origin", ...)   // second fake zero requests; first fake saw query pageToken equal to the full "http://127.0.0.1:<second>/steal" string
it("two clients on two fakes never see each other's credential", ...)
it("maps statuses", ...)   // 401 and 403 failed:auth renew_sign_in; 429 + Retry-After "120" failed:server rate_limited retryAfterMs 120000; 503 failed:server http_503; 404 failed:invalid http_404; ECONNREFUSED failed:network connection_refused
it("refuses a baseUrl with userinfo or a query", ...)    // failed:invalid invalid_base_url, message free of the password
it("refuses a credential over http to a non-loopback host before any socket", ...)   // http://192.0.2.1/v1 + lease -> insecure_transport; net.connect spy count 0
it("parseRetryAfter", ...)   // "120" 120000; a date 90 s ahead 90000; ten days 86_400_000; "soon" undefined; a past date 0
it("no ScanError message contains a header value", ...)  // CANARY-KEY-1 absent from every message above
```
`validate.test.ts`:
```ts
it("accepts legal ids", ...)   // "llama3.2:latest", "vendor/model@v1+x", "A", 256 chars; "Model" and "model" stay distinct after finalizeEntries
it("rejects illegal ids", ...) // "", " x", "-x", "a b", "a\u{1F600}", 257 chars
it("one invalid entry fails the whole scan", ...)   // [ok, bad, ok] through the openai-shaped mapper helper -> failed:invalid invalid_entry
it("caps strings by bytes and refuses control characters", ...)   // 513 bytes (170 x U+20AC) refused; "\u0007" and "\u0085" refused; 512 bytes accepted
it("numbers are finite positive integers", ...)   // 0, -1, 1.5, Infinity (from JSON 1e400) refused; 1 accepted
it("duplicates keep the first and are counted", ...)   // ids [a, b, a] -> [a, b], duplicates 1, first displayName kept
it("5000 entries pass, 5001 fail", ...)   // too_many_entries
```
- [ ] **Step 2: Run, expect failure.** `CT discovery/http` → FAIL `ERR_MODULE_NOT_FOUND`.
- [ ] **Step 3: Implement** `http.ts`, `validate.ts`, `fake-endpoint.ts`. `node:http`/`node:https` `request` with `agent: false`, a connect timer cleared on `connect`/`secureConnect`, a request timer, and an `AbortSignal.any([o.signal, timeout(scanTimeoutMs)])`; never put `lease.headerValue` into an Error message, URL or log field.
- [ ] **Step 4: Run, expect pass.** `CT discovery/http` and `CT discovery/validate` → `# fail 0`.
- [ ] **Step 5: Commit** (`git add packages/core/src/discovery/http.ts packages/core/src/discovery/validate.ts packages/core/test`) subject `feat(core): origin-pinned scan client with R11 limits and strict entry validation (D112 R10, R11)`, same trailers.

---

### Task 4: Four wire-profile scanners

**Files:**
- Create: `packages/core/src/discovery/scanners/{openai,anthropic,google,ollama,index}.ts`; fixtures `packages/core/test/fixtures/discovery/{openai-plain,openai-openrouter,anthropic-p1,anthropic-p2,google-p1,google-p2,ollama-tags}.json`
- Test: `packages/core/test/discovery/scanners.test.ts`

**Interfaces:**
- Consumes: `PinnedClient`, `ScanError` (Task 3), `ProfileInfo` (Task 1), `checkId`, `checkString`, `checkPositiveInt`, `finalizeEntries` (Task 3).
- Produces:
```ts
export interface ScanOutput { entries: RawEntry[]; duplicates: number; pages: number }
export type Scanner = (profile: ProfileInfo, client: PinnedClient) => Promise<ScanOutput>;
export const SCANNERS: Readonly<Record<Exclude<DiscoveryKind, "manual">, Scanner>>;   // "manual" is absent: no scanner
```
Requests (spec §2.4; `baseUrl` of the fake is `<origin>/v1` or as noted): `openai-models` `GET /models`; `anthropic-models` `GET /models?limit=1000`, next page adds `after_id=<last_id>` while `has_more`, header `anthropic-version: 2023-06-01`; `google-models` `GET /models?pageSize=1000`, next `pageToken=<nextPageToken>`, key only in the lease header (`x-goog-api-key`), `models/` prefix stripped; `ollama-tags` `GET /api/tags`. Maps: OpenAI `created` seconds to ms; OpenRouter-style extras only from the whitelist (`name` to displayName, `context_length` to contextWindow, `supported_parameters` containing `tools` / `structured_outputs` / `reasoning` to capabilities, `architecture.modality` whose input side contains `image` to `vision`); Anthropic `display_name`, `created_at` (RFC 3339) and, where documented, `max_input_tokens` to contextWindow; Google `displayName`, `inputTokenLimit` to contextWindow, `embedContent` without `generateContent` to kind `embedding`; Ollama `name` (tag included), `modified_at` to `created`; `details.family` and `details.parameter_size` are validated and dropped (the catalog has no field). Unknown extras are dropped; envelopes are closed on the fields read.

- [ ] **Step 1: Read the vendors' published Models API references** (OpenAI, Anthropic, Google Gemini, Ollama `GET /api/tags`) and hand-write the fixtures to those documented shapes with invented ids; put the URL and the date read in each fixture's `"_source"` field. Any mapped key above that the page does not document is dropped from the scanner and from its test. No recorded traffic (R19).
- [ ] **Step 2: Write the failing tests** (`scanners.test.ts`, against `startFakeEndpoint`; lease `{ headerName: "authorization", headerValue: "Bearer CANARY-KEY-1" }`, Google `x-goog-api-key: CANARY-KEY-2`):
```ts
it("openai-models plain", ...)   // GET /v1/models; entries deepEqual [{ id: "example-chat-large", created: 1_700_000_000_000 }, { id: "example-embed-small", created: 1_700_000_100_000 }]
it("openai-models OpenRouter extras", ...)   // { id: "example-router/chat-pro", displayName: "Example Pro", contextWindow: 200000, capabilities: ["tools","vision"] }; a non-whitelisted extra "pricing" absent
it("anthropic-models pages", ...)   // request 1 url "/v1/models?limit=1000", request 2 "/v1/models?limit=1000&after_id=<last_id of page 1>", header anthropic-version "2023-06-01"; ids of both pages in order; pages === 2
it("google-models pages and prefix", ...)   // url "/v1beta/models?pageSize=1000" then "...&pageToken=tok-2"; ids without "models/"; header x-goog-api-key "CANARY-KEY-2"; no request url contains "CANARY" or "key="
it("ollama-tags keeps the tag", ...)   // GET /api/tags; id "example-llama:latest"; created from modified_at
it("every scanner refuses a missing envelope field", ...)   // {} -> failed:invalid bad_envelope
it("a response URL is never fetched", ...)   // openai "next", anthropic "next_page_url", google nextPageToken "http://127.0.0.1:<second>/x": second fake requests.length === 0
it("more than 10 pages fails", ...)   // anthropic has_more forever -> failed:invalid too_many_pages
it("a failure on page 2 returns nothing", ...)   // page 2 status 500 -> rejects failed:server; no partial output
it("wrong content type, oversized body, 5001 entries, invalid id and timeout are refused through each scanner", ...)   // the Task 3 refusals, once per scanner, same reasons
it("manual has no scanner", ...)   // SCANNERS has exactly the four keys
```
- [ ] **Step 3: Run, expect failure.** `CT discovery/scanners` → FAIL `ERR_MODULE_NOT_FOUND`.
- [ ] **Step 4: Implement** the four scanners and `index.ts`; each scanner builds its next request from the response's cursor token only, passes the token through `query`, and ends at 10 pages with `too_many_pages`.
- [ ] **Step 5: Run, expect pass.** `CT discovery/scanners` → `# fail 0`.
- [ ] **Step 6: Commit** (`git add packages/core/src/discovery/scanners packages/core/test`) subject `feat(core): openai, anthropic, google and ollama model scanners (D112 R9)`, same trailers.

---

### Task 5: Reconcile, overrides, role resolution

**Files:**
- Create: `packages/core/src/discovery/{reconcile,overrides,roles}.ts`, `packages/core/test/fixtures/discovery/role-vectors.json`
- Test: `packages/core/test/discovery/{reconcile,overrides,roles}.test.ts`

**Interfaces:**
- Consumes: `CatalogFile`, `CatalogModel`, `RawEntry`, `ScanWarning` (Task 1), `enrich`, `CompiledTable` (Task 2).
- Produces:
```ts
// reconcile.ts (pure: never reads a clock, a file or the network; does not bump revision)
export interface ReconcileInput { catalog: CatalogFile; provider: string; raw: readonly RawEntry[]; now: string; table: CompiledTable; vendor?: string; roles: Readonly<Record<string, string>> }
export interface ReconcileResult { catalog: CatalogFile; new: string[]; reappeared: string[]; unavailable: string[]; unchanged: number; shadowed: string[]; warnings: ScanWarning[] }
export function reconcile(i: ReconcileInput): ReconcileResult;   // throws RangeError on an empty raw list (the caller owns the zero-model guard)
// roles.ts
export function resolveRole(value: string, catalog: CatalogFile): { provider: string; id: string; state: "available" | "unavailable" } | null;   // P9
export function roleWarnings(catalog: CatalogFile, roles: Readonly<Record<string, string>>, provider?: string): ScanWarning[];   // role_unavailable, only when every match is unavailable
// overrides.ts
export class CatalogError extends Error { readonly code: "invalid" | "conflict" | "not-found" | "not-manual"; readonly field?: string }
export interface SetOverride { provider: string; id: string; set?: ModelOverrides; clear?: (keyof ModelOverrides)[] | "all"; create?: boolean }
export function applyOverride(c: CatalogFile, p: SetOverride, now: string, t: CompiledTable, vendor: string | undefined): { catalog: CatalogFile; entry: CatalogModel };
export function removeManualEntry(c: CatalogFile, provider: string, id: string): CatalogFile;
```
Reconcile follows spec §2.7 steps 1-6 and 8 (step 7, the guard, is `RangeError` here and `failed:empty` in Task 6): manual entries untouched and a colliding raw id lands in `shadowed` and a `shadowed_by_manual` warning; new entries `available`, `firstSeen = lastSeen = now`, enriched, `api` stored (P11); present entries refresh `lastSeen`, API-derived fields and enrichment, overrides untouched; `unavailable` entries return to `available` (counted `reappeared`, not `new`); missing `scan`/`table` entries that are `available` become `unavailable` with `lastSeen` unchanged; entries of other providers untouched; `roles` is read, never written.
Overrides validation: `kind` in `MODEL_KINDS`; `contextWindow` positive integer; `capabilities` in the registered vocabulary; `aliases` at most 16, unique within the provider, not equal to another id of the provider (else `conflict`); `create` makes a `manual` entry (`status: "manual"`, `source: "manual"`, timestamps `now`) and a second create of the same id is `conflict`; any other source gets `overrides` only; `clear` recomputes effective values from `api`, the table and the heuristic; `removeManualEntry` refuses a non-manual entry (`not-manual`) and a missing one (`not-found`).

- [ ] **Step 1: Write the failing tests** (`reconcile.test.ts`, spec §6 item 2):
```ts
it("new: available, counted, role untouched", ...)   // new ["example-chat-large"]; firstSeen === lastSeen === now; JSON.stringify(roles) identical before and after
it("gone: becomes unavailable, lastSeen unchanged, not deleted", ...)   // models.length unchanged; entry.status "unavailable"; entry.lastSeen === the earlier time
it("back: available again, counted as reappeared not new", ...)
it("an override is kept across new, gone and back", ...)   // overrides { displayName: "My Large", contextWindow: 32000 } and effective values survive all three
it("refresh: API value changes, override still wins", ...)
it("a role pointing at an unavailable model warns and is unchanged", ...)   // warnings deepEqual [{ code: "role_unavailable", role: "chat", provider: "example-compat", id: "example-chat-large" }]; roles byte-identical
it("a manual entry is untouched and a colliding raw id is reported as shadowed", ...)   // shadowed ["example-manual"]; the manual entry deepEquals itself before
it("manual entries never become unavailable; other providers are untouched", ...)
it("source flips between table and scan", ...)
it("an empty raw list throws RangeError", ...)
```
`overrides.test.ts`: `kind: "chatty"`, `contextWindow` 0, -1, 1.5, a capability "telepathy", 17 aliases, a duplicate alias, an alias equal to another id: each throws `CatalogError` with the field name; `create` with an existing id is `conflict`; `set` on a missing entry without `create` is `not-found`; `clear: ["kind"]` and `clear: "all"` return to the table/heuristic values; `removeManualEntry` on a `scan` entry is `not-manual`.
`roles.test.ts` loads `role-vectors.json` (fields `catalog[]` of `{ provider, id, aliases, status }`, `value`, `expect`): provider prefix with a `:` in the provider id (`openai:chatgpt-plan/example-chat-large`), model id containing `/` (`example-router/vendor/model`), longest provider prefix wins (`example-compat/x` never resolves under provider `example`), bare id, alias, bare id on two providers with one `available` (no warning), unknown value (`null`).
- [ ] **Step 2: Run, expect failure.** `CT discovery/reconcile` → FAIL `ERR_MODULE_NOT_FOUND`.
- [ ] **Step 3: Implement** the three files with the signatures above; write the vector file with at least the eight cases named.
- [ ] **Step 4: Run, expect pass.** `CT discovery/reconcile`, `CT discovery/overrides`, `CT discovery/roles` → `# fail 0`.
- [ ] **Step 5: Commit** (`git add packages/core/src/discovery/{reconcile,overrides,roles}.ts packages/core/test`) subject `feat(core): catalog reconcile, overrides and role resolution (D112 R4-R6, R14, R15)`, same trailers.

---

### Task 6: Schedule math, discovery service, logger events

**Files:**
- Create: `packages/core/src/discovery/{schedule,service,events-logger,defaults}.ts`
- Test: `packages/core/test/discovery/{schedule,service,events-logger}.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1-5.
- Produces (`schedule.ts`, pure):
```ts
export function nextRegularAt(fromMs: number, intervalHours: number, rng: Rng): number;   // fromMs + interval x (1 + 0.1 x (2u - 1)), floor 1 h after jitter
export function backoffDelayMs(consecutiveFailures: number, rng: Rng): number;           // min(300_000 x 2^(n-1), 21_600_000) x (1 +/- 0.1), n >= 1
export function retryDelayMs(consecutiveFailures: number, retryAfterMs: number | undefined, rng: Rng): number;   // max(backoff step, Retry-After)
```
- Produces (`defaults.ts`): `systemClock: Clock` (over `Date.now`/`setTimeout`, timers `unref`'d), `EmptyProfileSource`, `NoCredentialResolver` (always `null`).
- Produces (`events-logger.ts`): `createLoggerEvents(logger: HarnessLogger): DiscoveryEvents` writing records named `model.discovered`, `model.unavailable`, `model.scan.failed`, `model.scan.completed` with fields `source: "provider:<id>"`, `trace_id` and the event fields; levels per R16 (unavailable `warn` iff `roles.length > 0`; failed `warn` for `failed:network|server|empty`, `error` for `failed:auth|invalid`; completed `debug`).
- Produces (`service.ts`):
```ts
export interface ScanSettings { enabled: boolean; intervalHours: number }
export interface DiscoveryServiceDeps { store: CatalogStore; profiles: ProfileSource; credentials: CredentialResolver; events: DiscoveryEvents; clock: Clock; rng: Rng;
  table: CompiledTable; roles: () => Readonly<Record<string, string>>; settings: () => ScanSettings; logger: { debug(m: string, f?: object): void; info(m: string, f?: object): void; warn(m: string, f?: object): void };
  scanners?: Partial<typeof SCANNERS>; makeClient?: typeof createPinnedClient; traceId?: () => string; runId?: () => string; userAgent?: string; maxParallel?: number /* default 4 */ }
export interface ScanRequest { trigger: RunTrigger; signal?: AbortSignal; runId?: string }
export interface ProviderScanResult { provider: string; result: ScanOutcomeCode; runningRunId?: string; new: string[]; reappeared: string[]; unavailable: string[]; unchanged: number;
  duplicates: number; warnings: ScanWarning[]; nextScanAt: string | null; error?: ScanErrorInfo }
export interface ModelEntry extends Omit<CatalogModel, "api"> {}
export interface ListQuery { provider?: string; kind?: ModelKind; status?: ModelStatus; newOnly?: boolean }
export interface ModelsList { models: ModelEntry[]; providers: (ProviderScanState & { provider: string })[]; newCount: number; warnings: ScanWarning[] }
export interface ModelsChanged { provider: string; discovered: string[]; reappeared: string[]; unavailable: string[]; at: string }
export interface DiscoveryService {
  scanProvider(provider: string, r: ScanRequest): Promise<ProviderScanResult>;       // throws CatalogError not-found for a provider the ProfileSource does not list
  scanAll(r: ScanRequest, only?: string): Promise<ProviderScanResult[]>;             // parallel, at most maxParallel at once
  list(q: ListQuery): ModelsList;                                                     // newCount: available, not manual, firstSeen after acknowledgedAt (absent = all); warnings live from the current roles
  setOverride(p: SetOverride): Promise<ModelEntry>; removeManual(provider: string, id: string): Promise<{ removed: true }>; acknowledge(): Promise<{ acknowledgedAt: string }>;
  onChanged(cb: (e: ModelsChanged) => void): () => void;                              // after the durable write, only when a list is non-empty
  nextRunAt(): number | null;                                                         // earliest persisted nextScanAt of a scannable provider
  scannable(): ProfileInfo[];                                                         // profiles whose discovery is not "manual"
}
export function createDiscoveryService(d: DiscoveryServiceDeps): DiscoveryService;
```
Per-scan flow: single flight per provider (a second request returns `already_running` with `runningRunId`); `disabled` (P6) and `no-scanner` skips; resolve the lease (`CredentialUnavailableError` becomes `failed:auth`, reason `renew_sign_in`, hint `renew sign-in: plur1bus login <provider>`); scan; empty becomes `failed:empty` (`empty_list`, warning logged, nothing changes); reconcile and one `store.mutate` that also writes `lastScanAt = now`, `lastResult: "ok"`, `nextScanAt = nextRegularAt(now)`, `consecutiveFailures` cleared; events after the write, one `discovered` and one `unavailable` per provider (first 20 ids, `truncated`), then `scanCompleted`; a `models.changed` callback. Failures: `network` and `server` (429 included, `Retry-After` through `retryDelayMs`) increment the counter and set `nextScanAt = now + retryDelayMs`; `auth`, `invalid`, `empty` set `nextScanAt = nextRegularAt(now)`; `scanFailed` emitted with `consecutiveFailures`. Error mapping to `ScanErrorInfo.code`: auth to `auth`, connect/request timeouts to `timeout`, other network to `network`, 5xx to `server`, 429 to `rate-limited`, invalid and empty to `invalid-request`.

- [ ] **Step 1: Write the failing tests.** `schedule.test.ts`:
```ts
it("jitter stays within +/-10% over 1000 draws and spreads providers", ...)   // every nextRegularAt(0, 24, Math.random) in [0.9, 1.1] x 86_400_000; at least 900 distinct values
it("the 1 h floor applies after jitter", ...)   // intervalHours 1, u = 0 -> exactly 3_600_000
it("backoff doubles to the 6 h cap", ...)   // rng 0.5 (no jitter): n=1 300_000, n=2 600_000, n=3 1_200_000 ... n=7 and n=20 21_600_000; rng 0 and 0.999999 stay within +/-10%
it("Retry-After replaces the step when larger", ...)   // retryDelayMs(1, 7_200_000, rng) === 7_200_000; retryDelayMs(1, 1000, rng) === backoff step
```
`service.test.ts` (fake endpoint, `InMemoryProfileSource`, `StaticCredentialResolver`, `RecordingEvents`, `FakeClock`, a catalog store in a temp dir):
```ts
it("an ok scan stores models, emits one discovered event and sets state", ...)   // count 2; log names ["discovered","completed"]; providers.p.lastResult "ok"; nextScanAt within +/-10% of 24 h; role map untouched
it("a mid-pagination failure reconciles nothing", ...)   // anthropic page 2 returns 500: catalog JSON identical before and after except providers.p.lastResult "failed:server" and nextScanAt; no discovered event
it("an empty list is failed:empty and changes no entry", ...)   // {"data": []} -> result "failed:empty", error.reason "empty_list"; no model unavailable; lastScanAt unchanged; nextScanAt regular; scanFailed emitted
it("error table", ...)   // 401 failed:auth (hint contains "plur1bus login p", counter unchanged, nextScanAt regular); 503 failed:server counter 1, nextScanAt = now + ~5 min; 429 + Retry-After 7200 -> now + 7200 s; non-JSON failed:invalid; refused credential failed:auth renew_sign_in
it("a manual scan resets the failure counter", ...)   // three 503s (counter 3), then trigger "manual" failing again -> counter 1; succeeding -> counter absent
it("a failed catalog write advances no state and emits no event", ...)   // hooks.beforeRename throws: persisted state identical; result nextScanAt = now + 300 s; no events; the next scan works
it("a second scan of the same provider returns already_running", ...)   // gated scanner; second result "already_running", runningRunId === first runId; a scan of all providers reports it per provider
it("no-scanner and disabled skips", ...)   // discovery "manual" -> "no-scanner"; settings.enabled false -> "disabled"; no request reaches the endpoint
it("models.changed callback fires after the write and only for a change", ...)   // { provider, discovered: [...], reappeared: [], unavailable: [], at } ; none for an unchanged second scan
it("list filters and acknowledge", ...)   // provider, kind, status, newOnly; newCount 2 then 0 after acknowledge(); warnings computed from the current roles
it("canaries reach no output", ...)   // scenario: 401 whose body echoes CANARY-KEY-1, 500 whose body holds "Bearer CANARY-TOKEN-2", a 302 whose Location holds https://auth.example.invalid/authorize?code=CANARY-URL-3, a network error: JSON of every RecordingEvents entry, every captured logger line, models.json and every thrown message contain none of the three canaries
```
`events-logger.test.ts`: a recording logger shows `model.unavailable` at `warn` with `roles: ["chat"]` and `info` with `[]`; `model.scan.failed` `warn` for `failed:network`, `failed:server`, `failed:empty` and `error` for `failed:auth`, `failed:invalid`; `model.scan.completed` at `debug`; every record has `source` `provider:<id>` and `trace_id`.
- [ ] **Step 2: Run, expect failure.** `CT discovery/schedule` → FAIL `ERR_MODULE_NOT_FOUND`.
- [ ] **Step 3: Implement** the four files; the service holds a `Map<string, { runId: string }>` for single flight and a counting semaphore for `maxParallel`.
- [ ] **Step 4: Run, expect pass.** `CT discovery/schedule`, `CT discovery/service`, `CT discovery/events-logger` → `# fail 0`.
- [ ] **Step 5: Commit** (`git add packages/core/src/discovery packages/core/test`) subject `feat(core): discovery service, schedule math and logger events (D112 R6, R12, R13, R16)`, same trailers.

---

### Task 7: System job kind, ledger, `jobs.*` merge, core wiring

**Files:**
- Create: `packages/core/src/system-jobs/{ledger,index}.ts`, `packages/core/src/discovery/job.ts`
- Modify: `packages/rpc-schema/schema/rpc.schema.json` (`x-rpc-version` to `1.5.0`; `jobs.list|run|history`; `$defs/SystemJobRun`), `packages/rpc-schema/fixtures/methods/jobs.{list,run,history}.json` (fixtures are per method: extend the three, add a system-run example to each result), `packages/core/src/rpc/methods.ts` (`MethodDeps` gains `systemJobs`, `discovery`), `packages/core/src/core.ts` (builds store, service, system jobs with the P1 defaults, `CoreOptions.discovery`)
- Test: `packages/core/test/system-jobs.test.ts`

**Interfaces:**
- Consumes: `DiscoveryService`, `ProviderScanResult` (Task 6), `Clock` (Task 1), `RunTrigger`.
- Produces (`system-jobs/index.ts`):
```ts
export interface SystemJobSpec { name: string; needsLlm: false; singleton: true; schedule: { every: number; jitter: number } }
export interface SystemJobOutcome { outcome: "completed" | "skipped" | "failed"; reason?: string; runningRunId?: string; detail: unknown }
export interface SystemJobHandler { readonly spec: SystemJobSpec; nextRunAt(): number | null; validateArgs(args: unknown): Record<string, unknown> /* throws RpcError E_INVALID_PARAMS */;
  run(args: Record<string, unknown>, ctx: { runId: string; trigger: RunTrigger; signal: AbortSignal }): Promise<SystemJobOutcome> }
export interface SystemRunRecord { runId: string; job: string; kind: "system"; trigger: RunTrigger; startedAt: number; finishedAt: number; durationMs: number;
  outcome: "completed" | "skipped" | "incomplete" | "failed" | "abandoned"; reason?: string; runningRunId?: string; attempt: 1; args?: Record<string, unknown> }
export interface SystemJobEntry { name: string; kind: "system"; needsLlm: false; singleton: true; schedule: { every: number; jitter: number }; nextRunAt: number | null }
export interface SystemJobs { register(h: SystemJobHandler): void; has(name: string): boolean; list(): SystemJobEntry[];
  run(name: string, args: unknown, o: { trigger: RunTrigger; signal: AbortSignal }): Promise<{ record: SystemRunRecord; detail: unknown }>;
  history(q: { job?: string; since?: number; limit?: number }): SystemRunRecord[] }
export function createSystemJobs(o: { ledgerPath: string; clock: Clock; securePath: (p: string) => unknown; logger: { warn(m: string, f?: object): void }; engineHasJob: (name: string) => boolean }): SystemJobs;
```
- Produces (`discovery/job.ts`): `createModelsScanJob(svc: DiscoveryService, settings: () => ScanSettings): SystemJobHandler` with `spec` `{ name: "models.scan", needsLlm: false, singleton: true, schedule: { every: 86_400_000, jitter: 0.1 } }` and args `{ provider?: string }` (closed; an unknown key or a provider the profile source does not list is `E_INVALID_PARAMS`, reason `unknown-provider`). Aggregate outcome: any provider `failed:*` gives `failed` (reason `provider_failed`); otherwise all providers skipped gives `skipped` with the shared reason (`already_running`, `disabled`, `no-scanner`, else `mixed`); otherwise `completed`; `runningRunId` copied from an `already_running` provider; `detail` is the `ProviderScanResult[]`.
- Ledger (`ledger.ts`): JSONL, 0600, `{"v":1,"runId":...,"phase":"started"|"finished",...}`; `begin` appends and `fsync`s before the body; `finish` appends after; unreadable lines are skipped and counted; a `started` row with no `finished` row and no run in flight reads as `outcome: "abandoned"`, `reason: "core_stopped"`.
- Schema (P4): `jobs.list` params gain `kind` (`"agent"|"system"|"all"`, default `agent`); items gain optional `kind`, `schedule`, `nextRunAt`. `jobs.run` params: `required: ["job"]`, `agentId` optional, `args` object. `jobs.history` params: `agentId` optional. `$defs/SystemJobRun` closed as in P4; `jobs.run` result and `jobs.history` rows `oneOf [JobRun, SystemJobRun]`. `job.run` is not touched.
- Handler rules (`methods.ts`): `jobs.list` without `kind` or with `agent` returns `{ jobs: d.engine.jobs.list() }` unchanged; `all` appends the system entries. `jobs.run`: a name in `systemJobs` is a system job: `agentId` present is `E_INVALID_PARAMS` (`detail: "agentId"`), run through `systemJobs.run(name, args, { trigger: "manual" })`, result `record`; any other name keeps today's path, and a missing `agentId` there is `E_INVALID_PARAMS` (`detail: "agentId"`). `jobs.history` without `agentId` returns `systemJobs.history(...)`; with `agentId` the engine's rows only, and `[]` when `job` names a system job.

- [ ] **Step 1: Write the failing tests** (`system-jobs.test.ts`, spec §6 item 8; fake engine jobs `{ list, run, history }`, a stub `SystemJobHandler` for ledger cases, and the real `buildMethods`):
```ts
it("jobs.list default output is byte-identical to the engine's", ...)   // JSON.stringify(await call("jobs.list", {})) === JSON.stringify({ jobs: engine.jobs.list() })
it("kind system and all show models.scan", ...)   // entry deepEquals { name: "models.scan", kind: "system", needsLlm: false, singleton: true, schedule: { every: 86400000, jitter: 0.1 }, nextRunAt: null }; "all" = engine entries then system entries
it("jobs.history without agentId is the system runs, with agentId only that agent's", ...)   // system rows carry kind "system" and no agentId key
it("jobs.run on a system job without agentId works", ...)   // record.kind "system", job "models.scan", outcome "completed"
it("jobs.run: agentId on a system job and no agentId on an agent job are refused", ...)   // both E_INVALID_PARAMS detail "agentId"
it("jobs.run args are closed", ...)   // { x: 1 } and { provider: "nope" } -> E_INVALID_PARAMS (reason "unknown-provider" for the second)
it("every run, skips included, writes started and finished rows before returning", ...)   // disabled, already_running, no-scanner: ledger has two rows per request, finished.outcome "skipped", reason equal to the skip
it("a throwing handler still leaves a failed row", ...)   // outcome "failed", reason "exception"; the error message is not stored
it("a started row without a finished row reads back as abandoned", ...)
it("a corrupt ledger line is skipped", ...)
it("the ledger is 0600", { skip: win }, ...)
it("an engine job named models.scan is refused at registration", ...)
it("system runs emit no job.run notification", ...)   // server.notify spy never sees "job.run"
```
- [ ] **Step 2: Run, expect failure.** `CT system-jobs` → FAIL `ERR_MODULE_NOT_FOUND`.
- [ ] **Step 3: Implement** ledger, registry, job handler, the schema edits and `methods.ts`. In `core.ts`: after the logger exists, `catalog = createCatalogStore(...)`, `store.load()`; services built from `CoreOptions.discovery ?? defaults` (P1); the engine's job list is the `engineHasJob` source.
- [ ] **Step 4: Regenerate and run.** `pnpm gen && pnpm --filter @plur1bus/rpc-schema test` then `CT system-jobs` and `CT rpc-server`, `CT core` → `# fail 0` (existing `jobs.*` callers and fixtures unchanged in behaviour). Grep for literals that mean "the current RPC version": `grep -rn '"1\.4\.0"' packages crates tests clients | grep -v generated | grep -v rpc.schema.json`; move the ones that mean the current version to `1.5.0`.
- [ ] **Step 5: Commit** (`git add packages crates clients`) subject `feat(core): system job kind, harness ledger and jobs.* merge, RPC 1.5.0 (D112 R2)`, same trailers.

---

### Task 8: Scheduler, config keys, ready hook

**Files:**
- Create: `packages/core/src/discovery/scheduler.ts`
- Modify: `packages/config-schema/schema/config.schema.json` (new `models` namespace), `packages/core/src/core.ts` (start after ready, `cs.onChange` replan, stop), `packages/config-schema/test/config-schema.test.ts`
- Test: `packages/core/test/discovery/scheduler.test.ts`, `packages/core/test/discovery/core-discovery.test.ts`

**Interfaces:**
- Consumes: `DiscoveryService`, `nextRegularAt`, `retryDelayMs` (Task 6), `SystemJobs` (Task 7), `Clock`, `Rng`, `FakeClock`.
- Produces:
```ts
export interface ScanScheduler { start(): void /* call once, after core.process.ready */; replan(): void /* settings changed */; stop(): void; armed(): { provider: string; at: number }[] }
export function createScanScheduler(o: { service: DiscoveryService; store: CatalogStore; systemRun: (provider: string, trigger: RunTrigger, signal: AbortSignal) => Promise<unknown> /* goes through SystemJobs.run so every tick has a ledger row */;
  clock: Clock; rng: Rng; settings: () => ScanSettings; logger: { debug(m: string, f?: object): void } }): ScanScheduler;
```
Rules: nothing is armed before `start()`. `start()` and re-enabling: for each scannable provider, due = `lastScanAt` missing or older than the interval, and `nextScanAt` missing or not in the future (P7); due providers are sorted by `u x 60_000` draws and spaced at least 2 000 ms apart, run with trigger `harness`; others are armed at their persisted `nextScanAt`, clamped to at most `now + 1.1 x interval` (clock stepped back). A timer fires one `systemRun(provider, "cron")`; after it the next timer is armed from the service result's `nextScanAt`. A sleep or wake that fires many overdue timers runs each provider once. `replan()` recomputes each provider's `nextScanAt = nextRegularAt(lastScanAt)` through `store.mutate`; a provider that is then overdue runs at a catch-up delay (0-60 s), never instantly. `enabled: false` cancels every timer. `stop()` cancels timers and aborts a scan in flight. Parallelism is the service's cap of 4.
Config schema: `models: { type: object, additionalProperties: false, default: {}, properties: { scan: { type: object, additionalProperties: false, default: {}, properties: { enabled: { type: boolean, default: true, x-restart: live, x-tier: advanced }, intervalHours: { type: integer, minimum: 1, maximum: 168, default: 24, x-restart: live, x-tier: advanced } } } } }`.
Core wiring: `scheduler.start()` directly after `setState(ready)` (and not when `CoreOptions.discovery.scheduler === false`); the settings reader is `() => cfg().models.scan`; the `cs.onChange` handler calls `scheduler.replan()` when `models.scan.*` changed; `stop()` calls `scheduler.stop()` before the engine closes and aborts through `shutdown.signal`.

- [ ] **Step 1: Write the failing tests** (`scheduler.test.ts`, spec §6 item 3, `FakeClock` and a scanner stub that records calls):
```ts
it("arms nothing before start", ...)   // clock.pending() === 0 after construction
it("catch-up scans only providers older than the interval, 0-60 s after start, 2 s apart", ...)   // p1 no lastScanAt, p2 25 h old, p3 1 h old; sequenceRng [0.10, 0.10] -> p1 at 6 s, p2 pushed to 8 s; advance(5_999) -> 0 scans; advance(2_001) -> [p1, p2]; p3 never scanned
it("a start never scans a provider scanned within the interval", ...)   // p3 armed at its persisted nextScanAt
it("a provider in backoff is not hammered by a restart", ...)   // lastScanAt 3 days old but nextScanAt in 4 min -> armed at 4 min, not at catch-up
it("a changed intervalHours recomputes nextScanAt live and an overdue scan waits the catch-up delay", ...)   // 24 -> 1 with lastScanAt 2 h old: advance(0) 0 scans; advance(60_000) 1 scan
it("disabling cancels every timer and enabling re-arms", ...)   // pending() 0, then equals the scannable count
it("a 401 does not retry before the next regular slot", ...)   // failed:auth; advance(23 h) -> no further scan
it("a network failure retries at 5 min then 10 min, +/-10%", ...)   // advance(5.6 min) -> second scan; the third is armed ~10 min later
it("one scan per provider after a three-day sleep", ...)   // jump(3 days): each provider scanned exactly once, next slot from now
it("clamps a nextScanAt far in the future", ...)   // persisted 10 days ahead, interval 24 h -> armed at most 1.1 x 24 h from now
it("at most 4 providers scan at once", ...)   // 6 timers due at the same instant, gated scanner: max concurrency 4
it("stop() cancels timers and aborts a scan in flight", ...)
it("every tick writes one ledger row through SystemJobs", ...)   // trigger "cron" for a tick, "harness" for catch-up
```
`core-discovery.test.ts` (in-process `createCore` with `discovery` adapters and a `FakeClock`; flat embedder): no request reaches the fake endpoint during `core.start()`; after `clock.advance(60_000)` exactly one; a `config.changed` of `models.scan.intervalHours` delivered through the config source replans; `scheduler: false` arms nothing. `config-schema.test.ts`: `defaults().models.scan` deepEquals `{ enabled: true, intervalHours: 24 }`; `intervalHours` 0 and 169 are invalid; both keys are `live` in the restart plan and `advanced` in `filterConfigByTier`.
- [ ] **Step 2: Run, expect failure.** `CT discovery/scheduler` → FAIL `ERR_MODULE_NOT_FOUND`.
- [ ] **Step 3: Implement** the scheduler, the schema keys and the core wiring.
- [ ] **Step 4: Regenerate and run.** `pnpm gen && pnpm docs:gen`; `CT discovery/scheduler`, `CT discovery/core-discovery`, `pnpm --filter @plur1bus/config-schema test`, `cargo test -p plur1bus-config` → `# fail 0` / `test result: ok`.
- [ ] **Step 5: Commit** (`git add packages crates docs`) subject `feat(core): model scan scheduler, catch-up after ready and models.scan.* config (D112 R12, R13)`, same trailers.

---

### Task 9: RPC `models.*`, `models.changed`, WebMCP deny list

**Files:**
- Modify: `packages/rpc-schema/schema/rpc.schema.json` (five methods, one notification, `$defs/ModelEntry`, `ModelProviderState`, `ModelScanWarning`, `ModelScanProviderResult`), `packages/rpc-schema/fixtures/methods/models.{list,scan,setOverride,removeManual,acknowledge}.json`, `packages/rpc-schema/fixtures/notifications/models.changed.json`, `packages/rpc-schema/fixtures/capabilities/core.json`, `packages/core/src/rpc/methods.ts`, `packages/core/src/core.ts` (`discovery.onChanged` to `server.notify("models.changed", ...)`), `packages/webmcp/src/provider.ts` (`FORBIDDEN_EXACT`)
- Test: `packages/core/test/models-rpc.test.ts`, `packages/webmcp/test/provider.test.ts`

**Interfaces:**
- Consumes: `DiscoveryService`, `SystemJobs` (Tasks 6, 7).
- Produces (wire, all `x-server: "core"`, `x-stability: "experimental"`, `x-since: "1.5.0"`, params closed):
  - `models.list` params `{ provider?, kind?, status?, newOnly? }` result `{ models: ModelEntry[], providers: ModelProviderState[], newCount: integer, warnings: ModelScanWarning[] }`.
  - `models.scan` params `{ provider? }` result `{ startedAt: string, finishedAt: string, providers: ModelScanProviderResult[] }` (`ModelScanProviderResult` = `ProviderScanResult` with `result` the enum of `ScanOutcomeCode`).
  - `models.setOverride` params `{ provider, id, set?: { displayName?, kind?, contextWindow?, capabilities?, aliases? }, clear?: string[] | "all", create?: boolean }` result `ModelEntry`.
  - `models.removeManual` params `{ provider, id }` result `{ removed: true }`.
  - `models.acknowledge` params `{}` result `{ acknowledgedAt: string }`.
  - notification `models.changed` params `{ provider, discovered: string[], reappeared: string[], unavailable: string[], at: string }`.
- Error mapping: `CatalogError` `invalid` to `E_INVALID_PARAMS` (`detail` the field), `conflict` to `E_CONFLICT`, `not-found` to `E_NOT_FOUND`, `not-manual` to `E_INVALID_PARAMS` reason `not-manual`; `CatalogWriteError` to `E_STORAGE` reason `catalog-write-failed`; an unknown `provider` to `E_INVALID_PARAMS` reason `unknown-provider`.
- `models.scan` runs through `systemJobs.run("models.scan", { provider }, { trigger: "manual" })` and returns the run's `detail` plus `startedAt`/`finishedAt` of the record (P10), so a ledger row exists for it exactly as for `jobs.run`.

- [ ] **Step 1: Write the failing tests** (`models-rpc.test.ts`, real RPC server in-process like `rpc-server.test.ts`, fake endpoint with two models; results are schema-validated by the server):
```ts
it("models.list after a scan", ...)   // models.length 2; providers[0].lastResult "ok"; newCount 2; warnings []
it("models.scan result matches the schema", ...)   // providers[0] { provider: "example-compat", result: "ok", new: ["example-chat-large","example-chat-small"], reappeared: [], unavailable: [], unchanged: 0, duplicates: 0 }; startedAt <= finishedAt
it("models.setOverride returns the entry, create makes a manual one", ...)
it("models.removeManual refuses a non-manual entry", ...)   // E_INVALID_PARAMS reason "not-manual"
it("models.acknowledge clears the badge", ...)   // newCount 0 afterwards
it("unknown provider and unknown params are refused", ...)   // models.scan { provider: "nope" } E_INVALID_PARAMS reason "unknown-provider"; models.list { extra: 1 } E_INVALID_PARAMS
it("models.changed is delivered after a change and not after an unchanged scan", ...)   // params deepEqual { provider: "example-compat", discovered: ["example-chat-large","example-chat-small"], reappeared: [], unavailable: [], at: <ISO> } once; the second scan sends none
it("models.scan writes one ledger row and no job.run", ...)
it("setOverride validation errors carry the field", ...)   // contextWindow 0 -> E_INVALID_PARAMS detail contains "contextWindow"; alias collision E_CONFLICT
```
`provider.test.ts` (webmcp): `models.scan`, `models.setOverride`, `models.removeManual`, `models.acknowledge` are refused even when passed as extra methods; `models.list` is offered only when listed as an extra. Schema tests already enforce `x-server`, `x-stability`, `x-since` and closed params for every method; add `it("models.* are core, experimental, since 1.5.0, closed")` to `packages/rpc-schema/test/stability.test.ts`.
- [ ] **Step 2: Run, expect failure.** `CT models-rpc` → FAIL (`method-not-found` for `models.list`).
- [ ] **Step 3: Implement** the schema entries (with descriptions, they feed `docs/rpc.md`), the five fixtures, the notification fixture, the capabilities fixture (the five methods and the notification, `experimental`, since `1.5.0`), the handlers and the deny-list entries.
- [ ] **Step 4: Regenerate and run.** `pnpm gen && pnpm docs:gen`; `CT models-rpc`; `pnpm --filter @plur1bus/rpc-schema test`; `pnpm --filter @plur1bus/webmcp test` → `# fail 0`; `pnpm docs:check` exits 0.
- [ ] **Step 5: Commit** (`git add packages docs`) subject `feat(core): models.list|scan|setOverride|removeManual|acknowledge and models.changed (D112 R17)`, same trailers.

---

### Task 10: CLI `model list|scan|override`, `1staid check models.roles`

**Files:**
- Create: `crates/plur1bus/src/commands/model.rs`, `crates/plur1bus/tests/model_cli.rs`
- Modify: `crates/plur1bus/src/cli.rs` (`Cmd::Model { sub: ModelCmd }`, `ModelCmd`), `crates/plur1bus/src/main.rs`, `crates/plur1bus/src/commands/mod.rs`, `crates/plur1bus/src/paths.rs` (`Layout::catalog()`, `Layout::catalog_models()`), `crates/plur1bus/src/commands/firstaid.rs` (`CHECK_IDS` appends `models.roles`; a `check_models_roles(layout) -> Check`), `crates/plur1bus/tests/{cli.rs,firstaid.rs}` (drop `model` from the stub list; `EXPECTED_ORDER` gains `models.roles`), `skills/plur1bus-ops/playbooks/diagnose.md` (names `models.roles`, required by `skill_freshness`)
- Test: unit tests in `model.rs`, `tests/model_cli.rs`

**Interfaces:**
- Consumes: RPC `models.*` (Task 9), `commands::memory_ops::connect_core` and `require_supports`, `Out::ok(schema, value, human)`.
- Produces (`cli.rs`):
```rust
#[derive(Subcommand, Debug)]
pub enum ModelCmd {
    /// [experimental] List the model catalog (reads the file read-only when the core is down)
    List { #[arg(long)] provider: Option<String>, #[arg(long)] kind: Option<String>, #[arg(long)] status: Option<String>, #[arg(long)] new: bool, #[arg(long, requires = "new")] ack: bool },
    /// [experimental] Scan configured providers for their current models (non-zero exit when a selected provider failed)
    Scan { #[arg(long)] provider: Option<String> },
    /// [experimental] Set or clear a person's values on a model, create or remove a manual entry
    Override { provider: String, id: String, #[arg(long)] name: Option<String>, #[arg(long)] kind: Option<String>, #[arg(long, value_name = "N")] context_window: Option<u64>,
              #[arg(long = "capability")] capability: Vec<String>, #[arg(long = "alias")] alias: Vec<String>, #[arg(long = "clear")] clear: Vec<String>, #[arg(long)] clear_all: bool,
              #[arg(long, conflicts_with = "remove")] create: bool, #[arg(long)] remove: bool },
}
```
- Produces (`model.rs`): `pub fn run(out: &Out, layout: &Layout, cmd: ModelCmd)`; `fn override_params(...) -> serde_json::Value` (maps flags to `models.setOverride` params: `--clear-all` to `"all"`, `--clear f` to `["f"]`); `fn read_stale(layout: &Layout, filter: &ListFilter) -> Result<serde_json::Value, String>` (builds `{ models, providers, newCount, warnings, stale: true }` from `catalog/models.json`; a missing file gives empty lists plus `note`); `fn role_warnings(catalog: &Value, roles: &Value) -> Vec<Value>` implementing P9, tested on `packages/core/test/fixtures/discovery/role-vectors.json` (the same file the TypeScript test reads); `fn check_models_roles(layout: &Layout) -> Check` (`ok` with no roles or no warnings; `warn` with `detail.roles` when a role points at an unavailable model; `skip` when no catalog exists).
- Behaviour: `model list` tries the core; on `E_CORE_UNAVAILABLE` it reads the file, prints `core not running: showing the last scan from catalog/models.json` (human) and sets `stale: true`; the human table has a status column, the marker `(role: <name>)` on an entry a role points to while `unavailable`, and per provider `last scan <age>, <result>` or `renew sign-in`. `model list --new --ack` lists then calls `models.acknowledge`. `model scan` prints per provider what was found, exits 1 when any provider result starts with `failed`. `model override` with `--remove` calls `models.removeManual`; both print schema `model.override/1`. Schema ids: `model.list/1`, `model.scan/1`, `model.override/1`. Exit codes follow `connect_core` (`E_CORE_UNAVAILABLE` 1).

- [ ] **Step 1: Write the failing tests.** Unit (`model.rs`):
```rust
#[test] fn override_flags_map_to_params()            // --name N --context-window 128000 --capability tools --alias a1 --clear kind -> {"provider","id","set":{"displayName":"N","contextWindow":128000,"capabilities":["tools"],"aliases":["a1"]},"clear":["kind"]}; --clear-all -> "clear":"all"
#[test] fn stale_read_filters_and_counts()           // a fixture catalog with 2 available (1 after acknowledgedAt) and 1 unavailable: --status unavailable -> 1 model; newCount 1; stale true
#[test] fn stale_read_of_a_missing_file_is_empty()   // models [], providers [], newCount 0, stale true, a note
#[test] fn role_warnings_match_the_shared_vectors()  // every case in role-vectors.json
#[test] fn models_roles_check_statuses()             // ok, warn (detail.roles ["chat"]), skip
```
`tests/model_cli.rs` (no core running, temp home): `model list --json` with a written `catalog/models.json` prints `schema: "model.list/1"` and `stale: true`; `model scan --json` and `model override p m --json` exit 1 with `error: "E_CORE_UNAVAILABLE"`; `model --help` shows `[experimental]` on each leaf; `1staid check --json` has `models.roles` last in `checks` (`skip` without a catalog). Update `tests/cli.rs` so `model` is no longer a stub and `tests/firstaid.rs` `EXPECTED_ORDER` ends with `"models.roles"`.
- [ ] **Step 2: Run, expect failure.** `cargo test -p plur1bus --test model_cli` → compile error `ModelCmd` not found, or `stubs_exit_2_and_name_their_milestone` failing for `model`.
- [ ] **Step 3: Implement** the CLI, the paths, the read-only reader, the check; `cargo build -p plur1bus`.
- [ ] **Step 4: Run, expect pass.** `cargo fmt --all -- --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test -p plur1bus` (includes `skill_freshness` and `cli.rs`) → `test result: ok`; `pnpm docs:gen && pnpm docs:check` exits 0.
- [ ] **Step 5: Commit** (`git add crates skills docs packages/core/test/fixtures`) subject `feat(cli): plur1bus model list|scan|override and 1staid check models.roles (D112 R17)`, same trailers.

---

### Task 11: End to end through RPC and CLI, D109 spies, docs

**Files:**
- Create: `packages/core/test/discovery/discovery-e2e.test.ts`, `tests/system/model-discovery.test.ts`
- Modify: `packages/core/src/bin.ts` (the `PLUR1BUS_TEST_DISCOVERY_PROFILES` seam, P16), `docs/adr/ADR-005-auth-policy-and-secrets.md` (`discovery` widened to the closed set of five, one paragraph), `docs/adr/ADR-013-configuration-and-restart-classes.md` (§2: the two keys shipped), `docs/adr/ADR-016-api-stability-and-versioning.md` (implementation record: RPC 1.4.0 to 1.5.0, the methods, `SystemJobRun`, schema ids `model.list/1`, `model.scan/1`, `model.override/1`, `1staid.check/1` id `models.roles`), `docs/provider-matrix.md` (a short "D112 `discovery` tokens" note under §2 mapping each row to `openai-models | anthropic-models | google-models | ollama-tags | manual`; llama.cpp and Nous Portal `manual`), `AGENTS.md` ("Where things live": `model` no longer a stub; the `discovery/` and `system-jobs/` modules, the test seams)
- Test: the two files above

**Interfaces:**
- Consumes: everything above.
- Produces: the seam file format `{ "profiles": [ { "id": string, "discovery": string, "baseUrl": string, "vendor"?: string, "credential"?: { "headerName": string, "headerValue": string } } ] }`; the seam builds `InMemoryProfileSource`, a `StaticCredentialResolver` registered for each profile's own origin, and sets `scheduler: false`.

- [ ] **Step 1: Write the failing tests.** `discovery-e2e.test.ts` (in-process real core, real `createPinnedClient` against a loopback mock, `RecordingEvents`-wrapped logger events; spec §6 items 6, 7, 10):
```ts
it("openai-style mock: scan finds two models, list shows them, removal turns unavailable, return turns available, override survives", ...)   // ids example-chat-large and example-chat-small with vendor example-vendor: kind "chat", contextWindow 128000 from the table; after removing example-chat-small status "unavailable", lastSeen unchanged; after restoring "available"; displayName override "My Small" kept across all three
it("ollama-style mock", ...)   // the same sequence with ids example-llama:latest and example-llama:8b
it("models.list, models.scan and jobs.run('models.scan') agree", ...)   // same ids; two ledger rows, both trigger "manual"
it("models.changed and the three D111-shaped events arrive with the specified levels", ...)   // discovered info; unavailable info, then warn when modelRoles.chat names the removed model; scan.failed warn for network
it("stopping the mock gives failed:network and leaves the catalog unchanged", ...)
it("a role at a vanished model keeps modelRoles byte-identical", ...)
it("filesystem spy: nothing outside the harness home is opened", ...)   // wrap openSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, renameSync, copyFileSync, readdirSync, statSync, existsSync, rmSync around one full scenario; every string path starts with home
it("network spy: requests go only to configured base URLs, no process is spawned", ...)   // wrap http.request, https.request, net.Socket.prototype.connect, child_process.spawn/exec/execFile/fork; the set of targets is exactly { "127.0.0.1:<mock port>" } plus the test's own socket under home; spawn count 0
it("canaries (ADR-005 action 8, extended)", ...)   // CANARY-KEY-1, "Bearer CANARY-TOKEN-2", https://auth.example.invalid/authorize?code=CANARY-URL-3 driven through failing scans, RPC errors and every models/jobs RPC reply: grep over core.log, models.json, models.json.prev, the ledger file and the JSON of every reply finds none
```
`tests/system/model-discovery.test.ts` (built binary, `PLUR1BUS_ALLOW_TEST_INTERNALS=1`, seam file pointing at a loopback mock; same `cli()`/`startCore` helpers as `memory-ops.test.ts`):
```ts
it("model scan --json carries schema model.scan/1 and finds two models", ...)
it("model list --json shows them with schema model.list/1; --new lists both; --new --ack then clears newCount", ...)
it("a removed model turns unavailable on the next scan and a returning one available", ...)
it("an override survives: model override ... --name 'My Small' then a rescan keeps it; schema model.override/1", ...)
it("stopping the mock exits model scan non-zero with failed:network and the list is unchanged", ...)
it("with the core stopped, model list --json reads the file read-only", ...)   // stale: true, same ids
```
- [ ] **Step 2: Run, expect failure.** `CT discovery/discovery-e2e` → FAIL (seam or assertions); `PLUR1BUS_BIN=target/release/plur1bus node --experimental-strip-types --test tests/system/model-discovery.test.ts` → FAIL (`model scan` finds no models: the core has no profiles).
- [ ] **Step 3: Implement** the `bin.ts` seam (gated by `PLUR1BUS_ALLOW_TEST_INTERNALS=1`, refused without it) and the docs edits; no production code beyond the seam is expected, anything else found is a bug in Tasks 1-10 to fix there.
- [ ] **Step 4: Run, expect pass.** `cargo build --release -p plur1bus && pnpm build && CT discovery/discovery-e2e`; `PLUR1BUS_BIN=target/release/plur1bus node --experimental-strip-types --test tests/system/model-discovery.test.ts` → `# fail 0`. Then the full green line from "How to run anything", `node scripts/lint-hygiene.mjs` exits 0, and `pnpm docs:check` exits 0. Acceptance (spec §6, tests 1-10) is green with no live call; only the "Discovery column matches the shipped values" half waits for Task 12.
- [ ] **Step 5: Commit** (`git add packages tests docs AGENTS.md`) subject `feat(core): model discovery end to end, D109 spies and docs (D112 R19)`, same trailers.

---

### Task 12: Wire real adapters  **BLOCKED on D15 + D110 + D111 (unchecked on purpose; an executor stops before this task)**

> **STOP.** Do not start. None of D15 (provider profile schema), D110 (credential store and auth engine) or D111 (`packages/log-schema`) exists in this repository. Resume only when all three have landed on `main`. Nothing above depends on this task: Tasks 1-11 ship working, tested software against the in-memory and default adapters.

**Files (when unblocked):** Create `packages/core/src/discovery/adapters/{profile-source,credential-resolver,events}.ts`; Modify `packages/core/src/core.ts` (replace the P1 defaults), `packages/log-schema/catalogue.json` (four entries), `docs/adr/ADR-005-auth-policy-and-secrets.md`, `docs/provider-matrix.md`.

**Port to real implementation:**
- `ProfileSource` <- the D15 profile reader over `providers.*` in the live config, mapping `{ id, discovery, baseUrl, vendor }`; an imported `models` array becomes `manual` entries on first load (R3, with M7's importer).
- `CredentialResolver` <- the D110 auth engine's lease API: header name and value from the profile's `auth_header_scheme`, refuses any origin but the profile's own, throws `CredentialUnavailableError("renew_sign_in")` when sign-in is needed, never starts a login, never lets the scanner read the secret store.
- `DiscoveryEvents` <- a D111 typed emitter over the four catalogue entries: `kinds: ["provider"]`, stream `diagnostic`, `since: "D112"`, `stability: "stable"`, `levelRule` on `model.unavailable` (`warn` when `roles` is non-empty), `activity: true` on `model.discovered` and `model.unavailable`; `createLoggerEvents` stays as the fallback.
- `Clock` stays `systemClock` (already real since Task 6).
- `1staid check models.roles` and `roles.ts` re-checked against D18's final `modelRoles` value format (P9).

**Acceptance to re-run (unchecked):**
- [ ] `packages/core/test/discovery/discovery-e2e.test.ts` with the real adapters in place of `CoreOptions.discovery` (profile `example-compat` defined in the test config, credential in the test auth store), all cases green.
- [ ] `tests/system/model-discovery.test.ts` with a config-defined profile instead of `PLUR1BUS_TEST_DISCOVERY_PROFILES`, all cases green.
- [ ] The canary scenario (ADR-005 action 8, extended) green against the D111 writer's redaction.
- [ ] A D111 catalogue test asserts the four events, their levels and `levelRule`; `pnpm build && pnpm test && cargo test --workspace` green on the five CI targets.
- [ ] `docs/provider-matrix.md` "Discovery" column equals the `discovery` values the shipped profiles carry.
- [ ] Commit `feat(core): wire D15, D110 and D111 into model discovery (D112)` with the two trailers.

---

## Self-review (done while writing)

- **Spec coverage.** §2.3 system job: T7 (list/run/history merge, ledger, `job.run` untouched). §2.4 scanners, limits, validation, scoping: T3, T4. §2.5 enrichment, re-enrichment: T2. §2.6 catalog and file safety: T1. §2.7 reconcile 1-8: T5 (guard in T6). §2.8 schedule, keys: T6 math, T8. §2.9 errors, backoff, single flight, redaction, D109: T3, T6, T8, T11. §2.10 RPC and CLI: T9, T10. §2.11 notifications, `1staid models.roles`, events: T6 (`models.changed` callback, logger events), T9, T10; D111 catalogue entries and the badge's GUI half are T12 and M3. §6 tests 1-10: 1 T4/T3, 2 T5/T6, 3 T6/T8, 4 T3, 5 T2, 6 T6/T11, 7 T11, 8 T7, 9 T1/T10, 10 T11. §9 conflicts: ADR-005, ADR-013, ADR-016 in T11; D15/D30/D42 text belongs to their own docs. Gap: the Windows DACL test runs only on a Windows target (spec acceptance says five targets).
- **Step scan.** Every code step names file, signature and the values the spec fixes; bodies appear nowhere except the formulas the spec states in prose.
- **Type consistency.** `ScanOutcomeCode`, `ProviderScanResult`, `SystemRunRecord`, `ModelEntry`, `ModelsChanged`, `Scanner`, `PinnedClient.get`, `CatalogStore.mutate`, `SetOverride`, `SystemJobs.run` are defined once (T1, T3-T7) and used with the same names in T6-T11; the wire `ModelScanProviderResult` equals `ProviderScanResult`.
- **Review Focus.** Lines 1-5 point at T5/T6, T3/T4, T5/T10, T8, T3.
- **Proportion.** 97 KB against the spec's 46 KB (about 2.1x), almost all of it signatures, test names with values and run lines; no function body appears.

## Contradictions and gaps found in the spec (for the owner)

1. `$defs/JobRun` requires `agentId`, yet §2.3 says system run rows carry no `agentId` and `jobs.run` returns "the run record" (P4).
2. §2.3 puts the system ledger in "a core-store table"; the core has no store of its own (P5).
3. §2.6 gives an entry no place for API-derived values, but §2.5 re-enrichment and `clear` need them (P11).
4. §2.4 "redirects are never followed with a credential" versus "a same-origin redirect is followed at most 3 times": read as "never to another origin".
5. §2.9 `lastScanAt` "not advanced as a success" (empty) versus "sets only `lastResult`, `nextScanAt`" (all failures) only agree if `lastScanAt` is the last success (P7); "floor 1 h" versus a 5 min backoff only agree if the floor is for the regular cadence (P7).
6. §2.10 puts `startedAt`/`finishedAt` on the CLI `--json` document, but R13 says `--json` is the raw RPC value (P10).
7. §2.7 step 6 needs "a role resolves to a model", but D15/D18 define no `modelRoles` value format (P9).
8. §2.5 says real table entries arrive "in the M2 plan"; this plan cannot source real ids and context windows (P13).
9. Unspecified: other 4xx statuses, plain `http` with a credential, `models.scan.enabled=false` versus an on-demand scan, `acknowledgedAt` on a fresh catalog (absent means everything is new), the `conflict` and `not-manual` error codes (P6, P8, T9).

## Questions for the owner (the plan runs on each default)

| # | Question | Default |
|---|---|---|
| Q1 | Who adds the real vendor sections to `model-metadata.json` (P13)? | A data-only PR after reading each vendor's list; not part of this plan. |
| Q2 | An on-demand scan while `models.scan.enabled` is `false`: refuse or run? | Refuse as a `disabled` skip (P6). |
| Q3 | Estimate 4.4 ad now plus 0.4 blocked is the upper half of 3-5. Trim? | Accept; to trim, drop T10's `1staid` check (-0.1) and fold T6's logger events into Task 12. |
