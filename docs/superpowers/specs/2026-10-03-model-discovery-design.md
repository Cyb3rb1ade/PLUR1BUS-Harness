# Model discovery — design (D112, specifies D42)

**Status:** Decided (owner 2026-10-03, decisions 1–3 in §4) · **Date:** 2026-10-03 · **Owner:** Christian (Cyb3rb1ade) · **Decision row:** core spec D112 (`2026-09-24-m1b-2a-core-daemon-cli-design.md` §2); details the model-list half of **D42 "Scan endpoints"** · **Milestone:** M2 (§8) · **Inputs:** core spec D42 (scan endpoints), D15 (provider profile), D16, D30 (model routing), D32 (typed harness catalog over RPC), D45 (voice providers), D110 and D111 rows · `docs/superpowers/specs/2026-09-30-openai-auth-design.md` §2.3 (`openai:chatgpt-plan` lists models via `/v1/models`, `siwc` wire profile), §2.5 (never list) · `docs/superpowers/specs/2026-10-01-logging-and-diagnostics-design.md` §2.2 (record), §2.6 (levels), §3 (catalogue), §4 (redaction), §5 (level policy) · ADR-005 "Declarative auth profiles" (`discovery`) and "Secret storage" (scoping; original §6.3), action 8 (redaction test) · ADR-009 (harness-owned scheduler, job registry, ledger, "every run, including every skip, writes one record") · ADR-013 §1, §2 (`providers.*`, `modelRoles.<role>` reserved), §8 (live appliers) · ADR-016 §4, §6 (additive RPC, harness-owned events) · `docs/rpc.md` `jobs.list`, `jobs.run`, `jobs.history`, `job.run` · `docs/provider-matrix.md` §2 (the "Discovery" column), §5a · `docs/learnings-hermes-openclaw.md` §2.12 (Hermes PR #59332: blocking probes removed from the critical path) · `docs/milestones.md` M2 · D109 (`docs/superpowers/specs/2026-09-28-basics-quality-bar-design.md` §D109: roots, deny-list).

**Owner purpose (D42, 2026-09-26, German):** "… die Modell-Listen aktuell hält, ohne alte Modelle einfach zu löschen."

## 1. Verified current state (`origin/main` @ `d87f5ce`)

| # | Fact | Where |
|---|---|---|
| F1 | D42 has two halves: (1) detect locally installed coding CLIs/ACP agents and local model servers, (2) query every configured provider/endpoint for its current models and write them into the provider profiles (D15) and the harness catalog (D32), marking removed models unavailable instead of deleting them. It runs on demand and on a schedule and "never sends credentials to an endpoint other than its own". **This spec details (2).** | core spec D42 |
| F2 | `plur1bus model` is a stub ("Models and provider profiles — M2"); no catalog file, no scanner, no `models.*` RPC method exists. | `docs/cli.md`; `docs/rpc.md` |
| F3 | D15 reserved the profile shape `{ vendor, lane, kind, transport, account, credentialRef, baseUrl, headers, metadata, models, quotas }`; ADR-013 reserves `providers.*` (live, open object) and `modelRoles.<role>` (live, roles `chat`, `reasoning`, `capture`, `dream`, `embedding`, `rerank`, `decision`, string values). Nothing writes either today. | core spec D15; ADR-013 §2 |
| F4 | ADR-005's profile schema has a `discovery` field with two values, `/v1/models` or a manual list. The provider matrix's "Discovery" column shows more shapes: `GET /v1/models` (OpenAI, OpenAI-compatible, OpenRouter-style), Anthropic `GET /v1/models`, Ollama `/api/tags`, LM Studio, mlx-lm and oMLX `/v1/models`, **llama.cpp "partially unverified (gap)"**, **Nous Portal "interactive picker only, no machine-readable list (gap)"**, xAI "not confirmed (gap)". | ADR-005 "Declarative auth profiles"; `docs/provider-matrix.md` §2 |
| F5 | D110: `openai:chatgpt-plan` lists models with `GET /v1/models` using the plan token ("no hard-coded models"); Realtime and GPT-Live ids are "read at setup (D42 scan), never hard-coded". D45: "exact model ids, endpoints and pricing are read from each provider at setup time (D42 scan)". | D110 §2.3; D45 |
| F6 | The scheduler lives in the core and drives a job registry; every run, skips included, writes one durable ledger record before any early return; `needsLlm` and `singleton` are registry flags. The registry is **per agent**: `jobs.run` and `jobs.history` require `agentId`; `jobs.list` returns `{ name, needsLlm, singleton, phase? }`. `job.run` (notification) carries a required `agentId`. | ADR-009; `docs/rpc.md` `jobs.*`, `job.run` |
| F7 | `config.json` is closed at the top level (`additionalProperties: false`); every key carries `x-restart` and `x-tier`; the file is written only by the supervisor and the CLI (ADR-013 §5). Runtime state lives outside it (`state/`, `logs/`). | ADR-013 §1, §2, §5 |
| F8 | D111 registers events in `packages/log-schema/catalogue.json` with `kinds`, `stream`, `level`, `levelRule`, `activity`; source kinds include `provider`; the activity feed (M3) is derived from events flagged `activity: true`. Redaction runs in the writer. | D111 §2.1, §2.3, §3 |
| F9 | Hermes removed four blocking probes from startup and first-prompt paths (agent init 1.0–3.3 s to 0.36–0.64 s); the harness criterion is "continuous/background discovery with a cache, never on the prompt path". | `docs/learnings-hermes-openclaw.md` §2.12 |

## 2. Decision D112

**PLUR1BUS keeps one core-owned model catalog per provider profile current with a scheduled and on-demand scan: each scanner talks only to its own endpoint with its own credential, a validated answer is reconciled into the catalog without ever deleting an entry and without ever touching a role assignment, a failed or empty answer changes nothing, and the owner is told what appeared.**

### 2.1 Scope

In: the model-list half of D42 for **configured** providers (F1 (2)); the catalog, scanners, enrichment, reconcile, schedule, errors, RPC, CLI, events. Out: detecting CLIs and local servers (D42 (1), unchanged; a found server becomes a configured provider and is scanned from then on; the GUI's "Scan endpoints" button runs both halves in M3), per-model probes (Ollama `/api/show`), price data, any third-party catalog, OS notifications (R16).

### 2.2 Architecture

**Approach A: a core job.** The scan is a **system job** (§2.3) in the existing `jobs.*` registry, run by the core's scheduler (ADR-009) next to the dreaming jobs. One process owns scheduling, ledger, pause, history and guards; the CLI, the GUI and the schedule all reach the same code through the same RPC.

Rejected alternatives are in §5.

```
 trigger (schedule | start catch-up | plur1bus model scan | GUI)
        │  jobs.run("models.scan") / models.scan
        ▼
 core scheduler ──► per-provider single flight ──► scanner[wire profile] ──► raw entries
        ▲                                                                       │ validate
        │ nextScanAt                                                            ▼
 catalog/models.json ◄── atomic write ◄── reconcile ◄── enrich (override > API > table > heuristic)
        │ after the durable write
        ▼
 models.changed notification · D111 events · scan state
```

### 2.3 The system job kind

The registry gains a second kind of job: **`kind: "system"`**, a job of the harness itself with no agent, no LLM and no agent principal. It is bound by D109's filesystem roots (§2.9) like all harness code; it is not an agent tool call and needs no approval.

| Surface | Today (agent jobs) | Addition (system jobs) |
|---|---|---|
| Registry entry | `{ name, needsLlm, singleton, phase? }` | adds `kind: "agent" \| "system"` (absent = `agent`) and, for system jobs, `schedule { every, jitter }`, `nextRunAt`. `models.scan` is `{ kind: "system", needsLlm: false, singleton: true }`; `singleton` is enforced **per provider** (§2.9). |
| `jobs.list` | no params; agent jobs | optional `kind: "agent" \| "system" \| "all"`, default `agent`, so every existing caller (`dreams status`) sees exactly what it sees now |
| `jobs.run` | `agentId` and `job` required | `agentId` becomes optional and is **required if and only if** the job is `kind: agent`; optional `args` object (`models.scan` takes `{ provider? }`); the existing invalid-params error otherwise. Result is the run record (`already_running` as in ADR-009). |
| `jobs.history` | `agentId` required, optional `job`, `since`, `limit` | `agentId` optional; **without it the result is the system runs**, so a caller that always passes `agentId` is unchanged. Rows carry `kind` and, for system runs, no `agentId`. |
| Ledger | per-agent rows | system runs go to a core-store table with the same columns minus the agent and plus `args`; every run and every skip (`already_running`, `disabled`, `no-scanner`) writes one row first (ADR-009 rule) |
| `job.run` notification | per finished agent run | **unchanged**; system runs announce through `models.changed` (§2.11), not through `job.run` (R2) |

All of it is additive under ADR-016 §4 (one RPC minor bump, `x-since` on each addition). The "Dreams" views never show system jobs.

### 2.4 Scanners

One scanner per **wire profile**; the profile's `discovery` field (ADR-005 "Declarative auth profiles") widens from `/v1/models | manual` to the closed set `openai-models | anthropic-models | google-models | ollama-tags | manual` (R9). A scanner is a pure function `(profile, lease, fetch) → rawEntries` with no catalog access.

| `discovery` | Request | Covers | Raw entry |
|---|---|---|---|
| `openai-models` | `GET {baseUrl}/models` (the base URL carries `/v1`) | OpenAI (API key, workload identity and the ChatGPT-plan token, D110), LM Studio, mlx-lm, oMLX, vLLM, OpenRouter, generic compatible endpoints | `{ id, created?, owned_by? }`; extras only from a fixed whitelist per vendor (OpenRouter `name`, `context_length`, `supported_parameters`, `architecture.modality`) |
| `anthropic-models` | `GET {baseUrl}/models?limit=1000`, paged by the response's cursor; `anthropic-version` header | Anthropic API | `{ id, display_name?, created_at? }` and any context or capability fields the response carries |
| `google-models` | `GET {baseUrl}/models?pageSize=1000`, paged by `pageToken`; the key travels in the `x-goog-api-key` header, **never in the query** | Google (Gemini API) | `{ name → id (the leading "models/" stripped), displayName?, inputTokenLimit?, supportedGenerationMethods? }` |
| `ollama-tags` | `GET {baseUrl}/api/tags` | Ollama local and Ollama Cloud | `{ name → id (tag included), modified_at → created?, details.family?, details.parameter_size? }` |
| `manual` | none | **Nous Portal** (no machine-readable list, F4) and **llama.cpp** until a live check verifies `/v1/models` (a data change to `openai-models` once verified) | the user's manual entries only |

**Per-endpoint credential scoping (D42, ADR-005 "Secret storage" scoping).** The scanner receives the base URL and **one** credential lease, both of its own profile, and its HTTP client is pinned to that origin (scheme, host, port):
- **Redirects are never followed with a credential**, and a redirect to another origin is not followed at all: the scan ends `failed:invalid`, reason `redirect_foreign_origin`. A same-origin redirect is followed at most 3 times, never `https` → `http`.
- Pagination is built by the scanner from the response's cursor token; a response URL (`next`, `nextPageToken` as a URL) is never fetched.
- Auth headers come from the profile's `auth_header_scheme` through the auth engine; the scanner never reads the secret store itself. No interactive login is ever started by a scan (the auth engine's normal proactive refresh still applies, ADR-005).
- The request carries the harness's own `User-Agent` (`plur1bus/<version>`); no other client's fingerprint (D110 §2.5 item 3).

**Limits (R11).** Connect timeout 5 s, request timeout 15 s, 60 s per provider scan (all pages); at most 10 pages; a response body at most 4 MiB after decompression (8 MiB over all pages), at most 5 000 entries; `Content-Type` must be JSON.

**Strict validation.** The envelope must match the scanner's schema (closed on the fields it reads, tolerant of unknown extras, which are dropped). Every entry must have an `id` matching `^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$`; every string field is length-capped (512 bytes) and control-character-free; numbers are finite positive integers. **One invalid entry fails the whole scan** (`failed:invalid`): a dropped entry would otherwise look "gone" and mark a real model unavailable. Duplicate ids keep the first (the id is present, nothing is lost) and are counted in the scan result.

### 2.5 Enrichment

Raw entries `{ id, displayName?, created?, raw extras }` are enriched from the curated table `packages/core/catalog/model-metadata.json`, shipped inside each harness release:

```json
{ "schema": "plur1bus.model-metadata/1", "revision": "2026-10-03.1",
  "vendors": {
    "generic": [ { "pattern": "^example-embed-.+$", "kind": "embedding", "capabilities": [] } ],
    "example-vendor": [
      { "pattern": "^example-chat-(large|small)(-\\d{8})?$", "kind": "chat", "contextWindow": 128000,
        "capabilities": ["tools", "vision", "reasoning"], "aliases": ["example-chat-latest"] } ] } }
```

(Synthetic ids; real entries are added in the M2 plan.)

- **Lookup.** The profile's `vendor` (D15) selects a section; `generic` is tried after it (local servers, compatible endpoints). Patterns are anchored regexes in the RE2-safe subset (no backreference, no lookaround, length ≤ 200); within a section the **first match wins**, most specific first.
- **Fields.** `kind`: `chat | embedding | tts | asr | image | moderation | rerank | realtime`, or `unknown`. `contextWindow`: a positive integer, or absent (unknown). `capabilities[]`: a registered vocabulary (`tools`, `vision`, `reasoning`, `audio_in`, `audio_out`, `structured_output`, `prompt_caching`; additions are additive). `aliases[]`: short names that resolve to the id wherever a model is named.
- **Precedence per field: user override > API value > table > name heuristic > `unknown`.** The heuristic is a fallback for `kind` only, from conservative id fragments (`embed`, `rerank`, `whisper|transcribe`, `tts|speech`, `moderation`, `dall-e|imagen|image`, `realtime`); an id that matches nothing is `unknown`, **never defaulted to `chat`**. Role pickers list entries of the role's kind first and `unknown` entries in a separate group, never silently excluded.
- **No network, no third party.** The table changes only with a harness release. Nothing is fetched from a community or vendor catalog (R8). After an upgrade the core re-enriches entries whose `source` is `table` from the new revision without a scan.
- Model kinds map onto D15 profile kinds (`chat`, `realtime`, `image`, `moderation` live under `llm`); GPT-Live ids (D110 kind `live`) classify as `realtime`, the profile kind carries the session path.

### 2.6 Catalog storage

`<home>/catalog/models.json`, **owned by the core** (single writer, one in-process mutation lock), schema id `plur1bus.model-catalog/1`:

```json
{ "schema": "plur1bus.model-catalog/1", "revision": 41, "tableRevision": "2026-10-03.1",
  "acknowledgedAt": "2026-10-03T08:00:00.000Z",
  "providers": { "example-compat": { "lastScanAt": "2026-10-03T07:12:44.120Z", "lastResult": "ok",
                                     "nextScanAt": "2026-10-04T06:51:09.804Z" } },
  "models": [
    { "provider": "example-compat", "id": "example-chat-large", "displayName": "Example Chat Large",
      "kind": "chat", "contextWindow": 128000, "capabilities": ["tools", "vision"], "aliases": [],
      "status": "available", "firstSeen": "2026-10-03T07:12:44.120Z", "lastSeen": "2026-10-03T07:12:44.120Z",
      "source": "table", "overrides": {} } ] }
```

| Field | Rule |
|---|---|
| `provider` | the D15 **profile id** (`openai:chatgpt-plan` and `openai:api-key` each have their own list; the plan token does not necessarily list what a key lists) |
| `id` | exactly as the API returned it (Ollama tag included) |
| `displayName`, `kind`, `contextWindow?`, `capabilities[]`, `aliases[]` | the **effective** values after §2.5's precedence |
| `status` | `available`, `unavailable` or `manual` |
| `firstSeen`, `lastSeen` | RFC 3339 UTC; `lastSeen` is the last scan that listed it, so it also says when an `unavailable` entry vanished |
| `source` | provenance of the descriptive fields at the last reconcile: `scan` (the API alone), `table` (the table filled at least `kind`, `contextWindow` or `capabilities`), `manual` (created by the person, §2.7) |
| `overrides` | the person's values only (`displayName`, `kind`, `contextWindow`, `capabilities`, `aliases`); they win over everything and survive `unavailable` and reappearance |
| per-provider state | `lastScanAt`, `lastResult` (`ok`, `failed:auth`, `failed:network`, `failed:server`, `failed:invalid`, `failed:empty`), `nextScanAt` |

**Relation to D15 and ADR-013.** A D15 profile **references** the catalog instead of holding its own `models` array: the profile keeps connection data, the catalog keeps models. The catalog is **runtime state, not configuration**: it is not in `config.json`, has no `x-restart` or `x-tier`, is never edited with `config set`, and is written by the core, not by the supervisor or the CLI. The configuration touched by this spec is only the two new live keys of §2.8 and the existing `modelRoles.<role>` (which the scan never writes). Catalog files hold no secret, travel in backups and exports, and are rebuilt by a scan if lost (manual entries are not rebuildable, hence the safety copy below). A `models` array on an imported profile (M7) becomes `manual` entries on first load (R3).

**File safety (R18).** Created `0600` (user + SYSTEM DACL on Windows, D111's private-file helper); written to `models.json.tmp-<pid>`, fsynced, renamed over the file; the previous file is kept once as `models.json.prev`. A file that fails validation is moved to `models.json.corrupt-<ts>`, the core starts from `.prev` if valid, else empty, and schedules an immediate scan.

### 2.7 Reconcile

Input: a validated, **non-empty** raw list `R` for provider `P`, `now`. Output: one catalog revision, written once and atomically; events fire only after the write succeeds, and a failed write advances no scan state (the scan is retried).

1. **`source: manual` entries are never touched** by a scan. A raw id equal to a manual entry's id is ignored for that entry and reported as `shadowed_by_manual`.
2. **New** (`id ∉ catalog[P]`): create `status: available`, `firstSeen = lastSeen = now`, enriched; counted as new.
3. **Present and available:** `lastSeen = now`; API-derived fields refresh, enrichment re-runs; overrides untouched.
4. **Present and `unavailable`:** back to `available`, `lastSeen = now`; counted as reappeared, not new.
5. **Missing:** an entry of `P` with `source` `scan` or `table` and `status: available` whose id is not in `R` becomes `unavailable`; `lastSeen` is left alone. **Nothing is ever deleted.**
6. **Roles:** for each `modelRoles.<role>` that resolves to a model now `unavailable`, record a warning (§2.11). **The role is not changed.** A turn that uses it still calls the provider: the catalog is a statement about the last scan, not an oracle, and the provider's typed model-not-found error (and D30 `auto` failover, if the agent's policy has it) is the honest outcome.
7. **Zero-model guard:** an **empty** `R` skips steps 3 to 5 completely: nothing becomes `unavailable`, `lastScanAt` is not advanced as a success, the result is `failed:empty` and a warning is logged. A scan is **all or nothing**: a failure on page 4 of 6 reconciles nothing.
8. **A new model is selectable at once** (owner decision 1): `available` is the only gate. Nothing is assigned: no role, no D30 tier list, no agent policy changes, ever, by a scan.

**Manual entries and overrides.** `plur1bus model override <provider> <id> --create` makes a `manual` entry (for scanner-less providers and for models an endpoint does not list); `--remove` deletes a manual entry (the only deletion the catalog has, and only by a person). On an entry of any other source, `override` writes `overrides` only.

### 2.8 Schedule

- **Cadence (R12):** `nextScanAt = lastScanAt + interval × (1 + 0.1 × (2u − 1))`, `u` uniform in [0, 1) per provider and per scan, so providers drift apart and a fleet does not hit a vendor at the same minute; floor 1 h.
- **Start catch-up:** after `core.process.ready` (never before, so nothing in startup or the prompt path waits on a probe, F9), every provider whose `lastScanAt` is missing or older than the interval is scheduled at `ready + u × 60 s`, at least 2 s apart. A start never scans a provider that was scanned within the interval.
- **Interval:** `models.scan.intervalHours` (default **24**, 1–168), `models.scan.enabled` (default `true`); both class `live`, tier `advanced`, new namespace `models`. A change recomputes `nextScanAt` from `lastScanAt` through the live applier (ADR-013 §8); a scan that is then overdue runs at the catch-up delay, not instantly. The schema change ships with M2; ADR-013 §2 lists the keys as "planned, D112" until then.
- **On demand:** `plur1bus model scan [--provider <id>] [--json]`, the RPC `models.scan` (the GUI's "Scan endpoints" button calls it, M3), and `jobs.run("models.scan")`. A manual scan resets that provider's `nextScanAt` and its failure backoff.

### 2.9 Errors and failure handling

Every failure leaves the provider's catalog entries exactly as they were and sets only the scan state (`lastResult`, `nextScanAt`).

| Condition | `lastResult` | Behaviour |
|---|---|---|
| connect or request timeout, DNS, TLS, reset | `failed:network` | warn; retry with exponential backoff |
| HTTP 5xx | `failed:server` | warn; retry with backoff |
| HTTP 429 | `failed:server` | warn; wait `Retry-After` (seconds or HTTP date, honoured up to 24 h), else backoff |
| HTTP 401 or 403 | `failed:auth` | error; hint "renew sign-in" (`plur1bus login <profile>`); **no automatic re-login**, no retry before the next regular slot or a manual scan |
| envelope or entry fails validation, size cap, foreign redirect, non-JSON | `failed:invalid` | error; next regular slot |
| valid but zero models | `failed:empty` | warn; nothing becomes `unavailable` (§2.7 step 7); next regular slot |
| another scan of that provider is running | none (a skip) | the second request returns `already_running` with the running run id; a scan of all providers reports it per provider |

- **Backoff:** delay `min(5 min × 2^n, 6 h)` for the n-th consecutive `network` or `server` failure, ×(1 ± 0.1) jitter; reset by a success or a manual scan; a 429's `Retry-After` replaces the step when larger.
- **Single flight per provider.** Different providers scan in parallel, at most 4 at once.
- **Redaction.** No token, header value, lease or response body is written to a log, `--json`, the ledger or the catalog; the writer's redaction (D111 §4) applies and ADR-005 action 8's canary test covers every output of this feature. Only counts, ids of models and typed error fields are logged.
- **D109.** The scan reads and writes **only under the harness home** (`catalog/`, the store, `logs/`); it opens no other path, runs no process and reads no credential file. **Network access goes only to configured endpoints**: each provider's own `baseUrl`, nothing else, no third-party catalog, no update or telemetry call.

### 2.10 Exposure

**RPC** (names in the style of D32's catalog methods; all `x-server: core`, `experimental`, one minor bump, params closed):

| Method | Params | Result |
|---|---|---|
| `models.list` | `provider?`, `kind?`, `status?`, `newOnly?` | `{ models[], providers[] (scan state), newCount, warnings[] }` |
| `models.scan` | `provider?` | per provider `{ provider, result, new[], reappeared[], unavailable[], unchanged, duplicates, warnings[], nextScanAt, error? }`; `already_running` per provider |
| `models.setOverride` | `provider`, `id`, `set?` (`displayName`, `kind`, `contextWindow`, `capabilities`, `aliases`), `clear?` (field names or `"all"`), `create?` | the entry |
| `models.removeManual` | `provider`, `id` | `{ removed }`; refused for a non-manual entry |
| `models.acknowledge` | none | `{ acknowledgedAt }`; clears the dashboard badge |

Overrides are validated: `kind` from the enum (or `unknown`), `contextWindow` a positive integer, `capabilities` from the registered vocabulary, `aliases` at most 16, unique within the provider and not colliding with another id.

**CLI** (`plur1bus model`, every command `--json` with the top-level `schema` id of the CLI conventions: `model.list/1`, `model.scan/1`, `model.override/1`):
- `model list [--provider <id>] [--kind <k>] [--status <s>] [--new [--ack]]`: a table with a status column, a marker on entries a role points to while unavailable, the scan state per provider ("last scan 3 h ago, ok", "renew sign-in"). With the core down it reads `catalog/models.json` read-only and says so (`stale: true` in `--json`).
- `model scan [--provider <id>] [--json]`: runs the scan and prints, per provider, what was found (`--json`: the `models.scan` result above, plus `startedAt` and `finishedAt`). Non-zero exit when any selected provider failed.
- `model override <provider> <id> [--name N] [--kind K] [--context-window N] [--capability C]... [--alias A]... [--clear <field>|--clear-all] [--create|--remove]`.

**D32 catalog.** The model catalog is the model half of D32's one typed harness catalog: the CLI and the GUI render model pickers only from `models.list`, never from a rival table. D32 (c)'s resolver reads `available` and `manual` entries for the `model` key; D30's tier lists draw from the catalog (replacing D15's per-profile `models` array) and resolution skips `unavailable` entries, while the stored tier list itself is never edited.

### 2.11 Notifications

| Surface | Content |
|---|---|
| **Activity stream** | the `models.changed` notification (core, `experimental`, harness-owned per ADR-016 §6): `{ provider, discovered[], reappeared[], unavailable[], at }`, emitted after the durable write when any list is non-empty; the M3 activity feed renders it from the two events flagged `activity` below |
| **D111 log events** | below; source `provider:<profile id>`; the run's `trace_id` |
| **Dashboard badge** | "N new models": `available` entries not `manual` with `firstSeen` after `acknowledgedAt`; cleared by `models.acknowledge` (M3) |
| **`scan --json`** | the full per-provider result, so scripts and the owner's own tooling see the same facts |
| `1staid check` | new append-only id `models.roles` (ADR-016): warns while a role points at an unavailable model |
| **OS notifications** | none for now (R16) |

D111 catalogue entries (`kinds: ["provider"]`, stream `diagnostic`, `since: "D112"`, `stability: "stable"`; one record per provider per scan, never one per model):

| Event | Level | `attrs` | `activity` |
|---|---|---|---|
| `model.discovered` | `info` | `provider`, `count`, `models` (first 20 ids), `reappeared` (first 20 ids), `truncated` | yes |
| `model.unavailable` | `info`; **`warn` when a role points at one of them** (`levelRule`) | `provider`, `count`, `models` (first 20), `roles` (the affected `modelRoles` keys), `truncated` | yes |
| `model.scan.failed` | `warn` for `network`, `server`, 429 and `empty`; `error` for `auth` and `invalid` (a hard signal that needs a person) | `provider`, `result`, `http_status?`, `retry_after_s?`, `next_scan_at`, `consecutive_failures`; `err { code, reason, retryable, hint }` with `code` from the D111 provider classes (`auth`, `network`, `timeout`, `server`, `rate-limited`, `invalid-request`) and `reason` a token such as `renew_sign_in`, `empty_list`, `redirect_foreign_origin`, `response_too_large` | no |
| `model.scan.completed` | `debug` | `provider`, `result`, `duration_ms`, counts | no |

The `model` area name is shared with D111's `model` source kind (local model servers); the catalogue's `kinds` list resolves it, so these four events are valid only from a `provider` source.

## 3. Interactions

- **D15:** the profile references the catalog (§2.6). **ADR-005:** `discovery` widens to the closed set of §2.4; the credential comes from the auth engine; policy status is unaffected (a scan does not make a `restricted` profile usable). **D16:** unchanged.
- **D18/D30:** roles and tier lists are never written by a scan; tier resolution and failover skip `unavailable` entries.
- **D32:** the catalog is the model half of the typed harness catalog (§2.10). **D42:** this spec details its model-list half; part (1) is unchanged.
- **D45, D110:** voice and Realtime model ids come from the same scan (`openai-models`), never hard-coded; the plan token lists with the `siwc` profile's own lease.
- **D109:** harness-home-only filesystem, configured-endpoints-only network (§2.9); the scan is a harness job, not an agent tool call. **D111:** events, redaction, `1staid check`.
- **ADR-009:** same scheduler and ledger rule; system jobs are a second kind, not a fourth dreaming phase. **ADR-013:** runtime state, two new live keys.

## 4. Owner decisions (as decided 2026-10-03)

The owner approved the points below; each is binding and implemented as written above.

| # | Decision | Where |
|---|---|---|
| 1 | A newly found model is immediately `available` and selectable, and the owner is notified. Role assignments (`modelRoles`, e.g. the chat model) never change automatically. | §2.7, §2.11 |
| 2 | Schedule: daily with random jitter, plus a scan at daemon start if the last scan is older than 24 h; the interval is configurable. On-demand: `plur1bus model scan [--provider <id>] [--json]` and the "Scan endpoints" button (GUI is M3; the RPC exists from M2). | §2.8, §2.10 |
| 3 | Metadata is what the API returns, enriched from a curated metadata table shipped with each harness release. Unknown values stay `unknown` and can be overridden by the user. No third-party catalog queries. | §2.5 |
| Architecture | Approach A (a core job in the `jobs.*` registry, new system kind), chosen over B and C. | §2.2, §5 |

## 5. Rejected alternatives

| | Approach | Why not |
|---|---|---|
| **B** | The Rust supervisor periodically runs the CLI (`plur1bus model scan`) | The logic would be split across two processes (scheduling in the supervisor, credentials, catalog and reconcile in the core), and pause, history and guardrails would be lost: the ledger, the single-flight rule, the live config and the D111 trace would each need a second implementation or a bridge. The supervisor also must not hold credentials or parse provider answers (its dependency budget, ADR-012 §10). |
| **C** | Scan on provider connect | It slows startup and puts blocking probes on the critical path, which the Hermes learnings warn against (F9: four probes removed from startup, about 80 % TTFT cut). A slow or down endpoint would delay the first turn, and a provider that reconnects often would be scanned often. |

## 6. Test strategy

No test uses a real provider, a real key or recorded real traffic. Fixtures are **synthetic**, written by hand to the documented response shapes, with invented ids and invented keys.

1. **Scanner contract (one per wire profile):** against synthetic responses a local fake serves for `openai-models` (plain, OpenRouter-style extras), `anthropic-models` (two pages), `google-models` (two pages, `models/` prefix), `ollama-tags`; each asserts the exact request (path, query, headers, the credential in the header and not in the URL), the parsed entries, and the refusals: wrong content type, oversized body, more than 5 000 entries, an invalid id, a missing envelope field, a response URL that must not be fetched, a gzip bomb over the decompressed cap, a timeout.
2. **Reconcile:** new (available and counted, role untouched), gone (becomes `unavailable`, `lastSeen` unchanged, not deleted), back (`available`, counted as reappeared), **override kept** across all three, **zero-response guard** (empty list changes nothing, `failed:empty`, no `unavailable`), **role pointing at an unavailable model** (warning, event level `warn`, `modelRoles` byte-identical before and after), manual entry untouched and a colliding raw id reported as shadowed, all-or-nothing on a failure mid-pagination, a failed write advances no state and emits no event.
3. **Scheduler (fake clock):** jitter stays within ±10 % over 1 000 draws and spreads providers; catch-up at start only for providers older than the interval, delayed 0–60 s after `core.process.ready`, nothing before ready; a changed `models.scan.intervalHours` recomputes `nextScanAt` live; backoff doubles to the 6 h cap and resets on success; a 429 `Retry-After` (seconds and date) is honoured; a 401 does not retry before the next slot; a second scan of the same provider returns `already_running`.
4. **Credential scoping:** a fake endpoint answers 302 to a second fake; the second receives **zero requests**, the scan ends `failed:invalid` (`redirect_foreign_origin`) and no credential reaches any host but the profile's own, including after a redirect, a pagination cursor that looks like a URL, and a `Location` that differs only by port or scheme; two profiles on two fakes never see each other's credential.
5. **Metadata table:** every pattern matches at least one known id in `packages/core/test/fixtures/model-ids/<vendor>.json`; **no duplicate pattern** within or across sections; every pattern compiles in the RE2-safe subset and is at most 200 characters; every `kind` and capability is in the registered vocabulary; first-match-wins is pinned by an ordering case; an id nothing matches is `unknown`, not `chat`.
6. **Redaction (ADR-005 action 8, extended):** planted canaries (a key, a bearer token, an authorization URL) driven through a scenario with failing scans; a grep over logs, `--json` of every `model` command, the ledger, `models.json`, RPC errors and exports finds none.
7. **End to end:** a local mock provider (OpenAI-style, then Ollama-style) behind a real core: `plur1bus model scan` finds two models, `model list` shows them, a model removed from the mock turns `unavailable` on the next scan, a returning one `available`, an override survives; `models.list`, `models.scan` and `jobs.run("models.scan")` agree; `--json` carries the `schema` ids; `models.changed` and the three D111 events arrive with the specified levels; stopping the mock makes `failed:network` while the catalog is unchanged.
8. **System job kind:** `jobs.list` default output is byte-identical to today's, `kind: "system"` and `"all"` show `models.scan`; `jobs.history` without `agentId` returns only system runs and with `agentId` only that agent's; `jobs.run` on a system job without `agentId` works and on an agent job without `agentId` is refused.
9. **Catalog file:** `0600` and the Windows DACL; atomic replace survives a kill between write and rename; `.prev` kept; a corrupted file is quarantined and the core recovers; `model list` works read-only with the core down.
10. **No stray access:** a filesystem-access spy proves nothing outside the harness home is opened; a network spy proves requests go only to configured base URLs.

**Acceptance (M2):** tests 1–10 green on the five CI targets with no live call; `docs/provider-matrix.md` "Discovery" column matches the `discovery` values shipped.

## 7. Rulings

- **R1 — Approach A.** Ruling: model discovery is a core job in the existing `jobs.*` registry. — why: one process already owns the scheduler, ledger, guards, live config, credentials and trace; the CLI and GUI reuse the same RPC. — cost: the registry grows a second job kind (R2), and an RPC minor bump.
- **R2 — System job kind, additive.** Ruling: `kind: "system"` jobs have no agent; `agentId` is optional on `jobs.run` and `jobs.history` and required only for agent jobs; `jobs.list` defaults to agent jobs; system runs do not emit `job.run`, they emit `models.changed`. — why: every existing caller keeps its exact behaviour (ADR-016 additive), and `job.run`'s required `agentId` need not be relaxed. — cost: two notification families for finished runs; a UI that wants one run feed merges them.
- **R3 — The catalog is runtime state, per profile.** Ruling: `catalog/models.json`, core-owned, one list per profile id; D15 profiles reference it; an imported `models` array becomes `manual` entries; the catalog is not in `config.json`. — why: ADR-013 forbids writers of `config.json` other than the supervisor and the CLI, and a scan every day would otherwise rewrite the person's config; the plan token and an API key list different models. — cost: the same model appears once per profile; a person edits roles in config and models in the catalog.
- **R4 — New means available now, assigned never.** Ruling: a new model is `available` and selectable at once and the owner is notified; no scan writes a role, a tier list or an agent policy. — why: owner decision 1; a vendor's new default must not silently change an agent's behaviour, cost or cache prefix. — cost: a person has to choose a new model to use it.
- **R5 — Unavailable, never deleted.** Ruling: a missing model becomes `unavailable` and returns to `available` when listed again; only a person deletes, and only a `manual` entry. — why: D42's purpose; a transient vendor omission must not lose overrides or history. — cost: the catalog grows monotonically; an explicit "forget" for old entries is a possible later person action, not designed here.
- **R6 — Empty and failed scans change nothing.** Ruling: any failure, a zero-model answer and a mid-pagination error leave all entries untouched; a scan is all or nothing; one invalid entry fails the scan. — why: a half or empty answer would otherwise mark every model `unavailable`; a dropped invalid entry looks like a vanished model. — cost: one malformed entry blocks all updates for that provider until the vendor fixes it (reported as `failed:invalid`, visible).
- **R7 — Precedence and `unknown`.** Ruling: per field, user override > API value > table > name heuristic > `unknown`; the heuristic covers `kind` only and never defaults to `chat`; GPT-Live ids classify as `realtime`. — why: owner decision 3; a wrongly guessed chat model offered for a role is worse than a visibly unknown one. — cost: some new models show `unknown` until the next release's table or an override.
- **R8 — A shipped table, nothing fetched.** Ruling: `packages/core/catalog/model-metadata.json` is updated with harness releases only; anchored RE2-safe patterns, first match wins; no vendor, community or third-party catalog is queried; entries enriched from the table are re-enriched after an upgrade without a scan. — why: owner decision 3; no new network destination, no remote content steering the catalog. — cost: metadata lags a vendor's release by up to one harness release.
- **R9 — Scanners by wire profile; some providers have none.** Ruling: `discovery` is the closed set `openai-models | anthropic-models | google-models | ollama-tags | manual`; Nous Portal and llama.cpp are `manual` (llama.cpp until a live check verifies `/v1/models`, then a data change). — why: provider-matrix gaps F4; guessing a list shape would risk marking models unavailable. — cost: two providers need manual lists for now.
- **R10 — Credentials never leave their endpoint.** Ruling: the client is pinned to the profile's origin; a cross-origin redirect is not followed; pagination never follows a response URL; the credential travels in a header only. — why: D42 and ADR-005 secret scoping; a redirect or a crafted cursor is the classic credential leak. — cost: a vendor that legitimately redirects its list endpoint to another host needs its `baseUrl` corrected.
- **R11 — Hard limits.** Ruling: 5 s connect, 15 s request, 60 s per scan, 10 pages, 4 MiB per body (8 MiB total), 5 000 entries, string and id caps. — why: a hostile or broken endpoint must not hold a job, memory or the catalog; OpenRouter-sized lists (hundreds of entries) fit with a wide margin. — cost: a very large future list needs the caps raised by a release.
- **R12 — Schedule.** Ruling: default 24 h, ±10 % jitter per provider and per scan, floor 1 h; catch-up at start after `ready` with a 0–60 s random delay and 2 s spacing; `models.scan.enabled` and `models.scan.intervalHours` live, advanced. — why: owner decision 2; jitter and spacing avoid a synchronised burst, and starting after `ready` keeps probes off the critical path (F9). — cost: a scan's exact time is not predictable; two keys in a new `models` namespace.
- **R13 — Failure policy.** Ruling: exponential backoff 5 min to a 6 h cap for network and server errors; `Retry-After` honoured up to 24 h; 401 and 403 are `failed:auth` with "renew sign-in" and no automatic re-login and no retry before the next slot; one scan per provider at a time, at most four providers in parallel. — why: a scan must never burn a quota, hammer a dead host or open a browser by itself (D110: the login is the person's own). — cost: a renewed sign-in is noticed at the next slot or a manual scan.
- **R14 — `source` and manual entries.** Ruling: `source` records provenance of the descriptive fields (`scan`, `table`, `manual`); `manual` entries are created and removed only by a person and never touched by a scan. — why: the field list is fixed by the owner; this keeps one meaning per value. — cost: `scan` versus `table` can flip between releases for the same model.
- **R15 — Roles at an unavailable model.** Ruling: a role pointing at an `unavailable` model raises a warning (event at `warn`, `1staid check models.roles`, `model list`, `--json` warnings) and is not changed; a turn still calls the provider. — why: owner decision 1; the catalog is the last scan's statement, so refusing locally would turn a transient omission into an outage. — cost: such a turn can fail with the provider's model-not-found error until a person acts.
- **R16 — Notifications.** Ruling: the `models.changed` notification, three D111 events plus a debug completion event (one record per provider per scan), a dashboard "N new models" badge cleared by `models.acknowledge`, `scan --json`; no OS notifications for now. — why: owner decision 1 asks for notice without a new delivery channel; batched records keep the activity feed readable and the idle log quiet (D111 test 15). — cost: no push for a new model until a later decision adds one.
- **R17 — RPC and CLI surface.** Ruling: `models.list`, `models.scan`, `models.setOverride`, `models.removeManual`, `models.acknowledge`; CLI `model list|scan|override` with `schema` ids `model.list/1`, `model.scan/1`, `model.override/1`; `model list` reads the file read-only when the core is down. — why: D32's one typed catalog, ADR-016 additive, and a person debugging a down daemon still sees the last state. — cost: five new experimental methods to stabilise.
- **R18 — File safety.** Ruling: `0600`, atomic replace, one `.prev`, quarantine of a corrupt file with a rescan. — why: manual entries and overrides are the only non-rebuildable data in the file. — cost: two extra files in `catalog/`.
- **R19 — Tests use no real data.** Ruling: synthetic fixtures only; no live provider call in CI; a filesystem and a network spy enforce D109's limits. — why: owner rules for D110 fixtures carried over; vendor shapes are documented, real traffic carries account data. — cost: a vendor shape change shows up only after a person re-reads the docs or a gated live check is added later.
- **R20 — Placement.** Ruling: M2, **3–5 ad** on top of M2's estimate; one acceptance item (18) and one scope bullet in `docs/milestones.md`. — why: the auth engine, provider profiles and the D111 provider events all land in M2, and the scheduler already exists from M1b. — cost: M2 total grows to 67–103 ad.

## 8. Placement and effort

| Part | Milestone | Effort (ad) |
|---|---|---|
| Scanners for four wire profiles with limits and strict validation, credential pinning | M2 | 1–1.5 |
| Catalog file, reconcile, overrides, roles check | M2 | 0.75–1.25 |
| System job kind in the registry (RPC additions, ledger table), scheduler trigger, catch-up, backoff | M2 | 0.5–1 |
| Metadata table, loader, fixtures, lint-style table test | M2 | 0.25–0.5 |
| `models.*` RPC, `model` CLI, `models.changed`, D111 catalogue entries, `1staid` check | M2 | 0.5–0.75 |

**Total 3–5 ad in M2** (+3–5 in the v0.1.0 total). The GUI parts (the "Scan endpoints" button, the "N new models" badge, the model pages) ride with M3's existing "Models page" scope, no extra estimate.

## 9. Conflicts with existing documents, and how they are resolved

| Document | Conflict | Resolution |
|---|---|---|
| core spec D15 | the profile holds a `models` array | R3: the profile references the catalog; an imported array becomes `manual` entries |
| ADR-005 `discovery` | two values (`/v1/models`, manual) | §2.4 widens it to the closed set of five; the ADR text is amended when the M2 plan lands |
| `docs/rpc.md` `jobs.*`, `job.run` | agent-only registry with required `agentId` | §2.3 and R2: additive kind, optional `agentId`, no change to `job.run` |
| ADR-013 §2 | closed top-level, no `models` namespace | two new live, advanced keys; the schema change ships with M2; listed as "planned, D112" until then |
| core spec D30 | tier lists "drawn from the provider profiles' `models`" | tier lists draw from the catalog; resolution skips `unavailable`; the stored list is never edited |
| core spec D42 | "write them into the provider profiles (D15) and the harness catalog (D32)" | the catalog is the single store; the profiles reference it (R3) |
| `docs/provider-matrix.md` | llama.cpp and Nous Portal discovery gaps | R9: both `manual` until verified or documented |

## 10. Open questions

None.
