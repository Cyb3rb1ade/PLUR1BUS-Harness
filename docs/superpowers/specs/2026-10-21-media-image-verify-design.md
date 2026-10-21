# Media image verification (TypeSafe System One) and media retention — design

**Status:** Specification and plan only, no product code. Owner decisions of 2026-10-21 incorporated (§2); open
questions in §17 · **Date:** 2026-10-21 · **Owner:** Christian (Cyb3rb1ade) · **Track:** media (ADR-017 follow-up) ·
**Proposed register entry:** D117 in the core spec's register
([`2026-09-24-m1b-2a-core-daemon-cli-design.md`](2026-09-24-m1b-2a-core-daemon-cli-design.md) §2), not entered yet ·
**Plan:** [`2026-10-21-media-image-verify.md`](../plans/2026-10-21-media-image-verify.md)

**Inputs read for this spec** (harness `origin/main` at the branch point of `docs/typesafe-image-verify`):
`packages/media/src/{jobs,store,http,types,adapters,png,units,video,registry}.ts`,
`packages/media/src/adapters/_shared/{images,metadata,retry}.ts`, [`docs/media.md`](../../media.md),
[`docs/media-adapters.md`](../../media-adapters.md), [ADR-017](../../adr/ADR-017-media.md),
`packages/core/src/composition/{media,index,tools}.ts`, `packages/core/src/rpc/media-surface.ts`,
`packages/core/src/channels/{core-host,switchboard}.ts`, `packages/channels-telegram/src/channel.ts`, the `media` and
`agents` sections of `packages/config-schema/schema/config.schema.json`, the `media.*` methods and notifications of
`packages/rpc-schema/schema/rpc.schema.json` (RPC 1.6.0, new methods carry `x-since` 1.7.0),
`packages/core/src/{budget,secrets,egress,privacy,system-jobs,inbox}/**`, [`docs/privacy.md`](../../privacy.md),
[`docs/inbox.md`](../../inbox.md), [`docs/budgets.md`](../../budgets.md), [`docs/egress.md`](../../egress.md),
`packages/web/src/pages/chat/model.ts`, `packages/web/src/pages/surfaces/media.ts`, `crates/plur1bus/src/commands/media.rs`,
and the TypeSafe documentation listed in §3 (fetched 2026-10-21).

## 1. Goal and non-goals

**Goal.** After this design is built:

1. An image a media adapter returns can be checked, before it reaches the person, by TypeSafe's System One model
   ("Jev") with structured questions. The check is **off by default** and switchable globally, per agent and per call.
2. The check has two purposes: **prompt fidelity** at three named strictness levels with fixed question sets and
   thresholds, and an **advanced** mode with free questions (Noul, Choice, Score) and thresholds, starting from templates.
3. A failed check triggers a new generation run, by default up to **2 retries (3 runs)**. A passing run is delivered at
   once; if none passes, the best failed image is delivered. Whenever more images were generated than delivered, the
   person is told that retries happened and asked whether they want the other images; **no** deletes them, **yes**
   delivers them, **no answer** leaves them to retention. Every run counts against the budget.
4. Every generated medium is kept only **n days**, the person sets n, and a live sweep deletes what is older.

**Non-goals.** Video verification (images only). Box questions (no pass/fail semantics, need `jev-1.14.0`). A local
verification backend (no local System One model with image input exists; see Q8). Replacing provider moderation
(ADR-017: provider moderation remains authoritative; the check is a quality gate, not a safety gate). A money dimension
(owner 2026-10-19: no USD; TypeSafe usage is counted as tokens).

## 2. Owner decisions (2026-10-21, binding)

Recorded in substance from the owner's brief; the controller's proposals are marked as such and are adopted as defaults
here unless a question in §17 says otherwise.

| # | Decision | Where in this spec |
|---|---|---|
| O1 | Optional check on the way back to the person: after the adapter result, before `store.put` in `packages/media/src/jobs.ts` (today line 95). Images only. Default off; switchable global / per agent / per call, like the ADR-017 O4 metadata switch. Compatible with ADR-017 §10 only as an opt-in. | §4, §5 |
| O2 | Purpose selectable: prompt fidelity in levels (for example lenient/normal/strict → question set + thresholds); advanced mode with freely configurable questions (noul/choice/score) with thresholds, templates as a starting point. | §6 |
| O3 | On failure: configurable, preset to 2 retries (max 3 runs). A passing run → deliver immediately, no further runs. None passes → deliver the best of the failures. Whenever more than one image was generated (passed or best-of-failures): tell the person that retries happened and ask whether they want the other images. No → delete the others. Yes → deliver. Every run counts against the budget. | §7, §8 |
| O4 | Retention: generated media are kept only n days; the person sets the period; automatic clean-up. Finding: `OutputStore` knows `retentionMs`, but `composition/media.ts`, `composition/index.ts` and `channels/core-host.ts` do not pass it, so nothing is ever pruned today and there is no config key. Part of the same work. | §13 |
| C1 | *(controller)* TypeSafe outage (timeout/4xx/5xx): fail-open, image marked "unchecked"; fail-closed configurable. | §9 |
| C2 | *(controller)* Check runs on a resized/converted copy (280–1568 px per side, ≤ 2 458 624 pixels, PNG/JPEG, EXIF orientation applied; below the minimum → skipped with a reason); the original stays unchanged. | §10 |
| C3 | *(controller)* Off under "Only local models"/privacy pin (refused with a typed reason); a clear notice for local backends (the image leaves the computer); egress through the egress policy. | §11 |
| C4 | *(controller)* Direct HTTP client in the `packages/media/src/http.ts` pattern, no new dependency (no `@typesafe-ai/sdk`); key in the secret store; cost as input tokens in the budget. | §3.6, §11 |

ADR-017 as committed has no numbered sections; "§10" and "O4" refer to the numbering of the 2026-10-07 proposal
(project document `plans/2026-10-07-adr-017-media-generation-proposal.md`). O4 is the call > agent > global > false
precedence of `embedMetadata` (`metadataEnabled()` in `packages/media/src/types.ts`); this design reuses that precedence.
ADR-017 gets an amendment paragraph (plan WP10) stating that verification is an opt-in quality gate that never replaces
provider moderation and never runs by default.

## 3. External service: what TypeSafe documents (2026-10-21)

Sources: `https://docs.typesafe.ai/images`, `/`, `/concepts/system-one`, `/confidence`, `/primitives`,
`/primitives/{choice,score,noul,box}`, `/introduction/quickstart`, `/patterns`, `/patterns/composite-scoring`, `/models`,
`/api/system-one`, `/api/errors`, `/legal`, `/model-jaggedness/jev-1.13`, the JavaScript SDK's `TypeSafeClientConfig` and
`RetryPolicy` pages, the OpenAPI document `https://api.typesafe.ai/openapi.json`, and the DPA
`https://typesafe.ai/legal/data-processing`. Everything below is quoted in substance; where a field name is given it is
exact.

### 3.1 Endpoint, auth, headers

- `POST https://api.typesafe.ai/v1/systemone` (operationId `systemone_v1_systemone_post`); `GET /v1/models` lists
  aliases only (versioned ids are accepted even when not listed).
- `Authorization: Bearer <API_KEY>` (security scheme `HTTPBearer`). Keys come from the TypeSafe console; the SDKs read
  `TYPESAFE_API_KEY` — the harness does **not**: the key comes from the secret store (§11.3).
- `TypeSafe-Danger-Zone-Images: true` (enum `["true"]`) is required on every request that carries an asset or a Box
  question. Images are off by default without it. `TypeSafe-Danger-Zone-Long-Context: true` exists and is not used.
- Body `application/json` or `multipart/form-data` (first part named `request`, `application/json`; every further part
  is one image, unique non-empty name, used by exactly one asset). The images page recommends multipart.
- `Content-Encoding` `gzip`, `x-gzip` or `zstd` accepted (one layer; zstd window ≤ 8 MiB); not used (base64 PNG
  compresses poorly).

### 3.2 Request shape (`SystemOneRequest`)

Required `model`, `state`, `questions`; optional `assets`.

| Field | Shape |
|---|---|
| `model` | string; alias (`jev-latest` → `jev-1.13.0`, `jev-preview` → `jev-1.14.0`) or versioned id (`jev-1.13.0`, `jev-1.14.0`; there is no `jev-1.13`). |
| `state` | string, object or array: the content every question refers to. Parts are addressed in instructions by a backticked path such as `` `image` ``. |
| `questions` | object, ≥ 1 entry, keyed by ids the caller chooses (the model never sees them). No documented maximum; the limit is context length (64k per request, 32k per question by default). |
| `assets` | object, ≥ 1 entry: opaque reference string → `{ "type": "image", "format": "png" \| "jpg" \| "jpeg", "data_base64": "..." }` or `{ "type": "image", "part": "<multipart part name>" }`. `format` is required with `data_base64`; standard base64 alphabet with padding, no whitespace, no `data:` prefix; `part` wins over `data_base64`. |

Asset rules: every asset must be referenced (else 400); references are matched as plain text anywhere in `state`,
`instructions` or `criteria` (so they must be unique strings such as UUIDs); **each occurrence adds another copy of the
image to the model input**; object keys (option names, question ids) are never replaced; a reference is ≤ 1 024 bytes,
all references together ≤ 65 536 bytes.

Question objects (discriminator `type`):

| `type` | Required | Fields |
|---|---|---|
| `noul` | `type` | `instructions` (string/object/array/null), optional `criteria` `{ "true": …, "false": … }` |
| `choice` | `type`, `criteria` | `instructions` optional; `criteria` object, 1–255 entries, option name → description (string/object/array/null) |
| `score` | `type`, `criteria` | `instructions` optional; `criteria` array, 1–10 level descriptions ordered low → high, level = zero-based position (the score page says at least two) |
| `box` | `type` | `instructions` only; needs `jev-1.14.0`/`jev-preview` and the images header |

### 3.3 Response shape (`SystemOneResponse`)

Required `model` (the versioned id that answered, may differ from the alias sent), `answers` (keyed by the caller's
question ids), `usage` `{ input_tokens, output_tokens }` (integers; output tokens currently free; image tokens are part
of `input_tokens` and of the context length).

| Answer `type` | Required fields | Meaning |
|---|---|---|
| `noul` | `noul` | number 0–1, probability of "yes"/"true". **No confidence**; `|2p − 1|` is the documented comparable measure. |
| `choice` | `choice`, `confidence`, `probabilities` | `choice` = most probable option; `probabilities` per option, sum 1; `confidence` 0–1 (1 = all mass on one option, 0 = uniform; only the top probability counts). |
| `score` | `score`, `confidence`, `legend`, `probabilities` | `score` = probability-weighted mean level (fractional, 0 … top level); `probabilities` keyed by level as string (`"0"`, `"1"`, …), sum 1; `legend` level → description; `confidence` 0–1, ordered (neighbouring mass lowers it less). |
| `box` | `box`, `confidence` | `box` `{ top, bottom, left, right }` fractions 0–1 from the top-left corner; `confidence` number or `null` (meaning of `null` undocumented). A Box answer is always a box (no "not found"). |

Questions are evaluated in parallel and in isolation (one answer never informs another); extra questions cost tokens,
add little latency.

### 3.4 Image limits (images page)

| Limit | Value |
|---|---|
| Formats | PNG or JPEG, still images only |
| File size | 16 MiB per image |
| Width and height | 280 to 1568 px each |
| Total pixels | 78 400 to 2 458 624 |
| Request body | 32 MiB (compressed and decompressed) |
| All images after processing | 32 MiB |
| Expanded request (each reference use counted) | 32 MiB |

Images outside the limits are **rejected, not resized; one bad image fails the whole request**. EXIF orientation is
**not** applied by the service; metadata is stripped by it. Recommended preparation: longest side ≤ 1568 px, rotate
pixels upright, PNG or JPEG, prefer baseline JPEG. Note: 2 458 624 = 1568², and 78 400 = 280², so the pixel bounds
follow from the side bounds; the side bounds are the operative check.

### 3.5 Errors, limits, retries

| Status | Documented meaning |
|---|---|
| 400 | Request rule broken (invalid UTF-8, nesting > 64, non-finite number, malformed compressed body); images not enabled; rejected image or asset; multipart rule violation; `max_tokens_exceeded` (request longer than the context length). |
| 401 | Missing or invalid API key. |
| 413 | Body over 32 MiB or another size limit. |
| 415 | Unsupported `Content-Encoding` or more than one layer. |
| 422 | Validation failed; body `HTTPValidationError` `{ detail: [{ loc, msg, type, input?, ctx? }] }`. |
| 429 | Rate limit exceeded (limits per organisation, tokens and requests per second, shown in the console). |
| 529 | TypeSafe temporarily overloaded. |

Only `max_tokens_exceeded` is a named error string; other error bodies are "a JSON body describing the problem" with no
documented fields. No `Retry-After` is documented for the API; the SDK's `RetryPolicy` defaults are: 2 retries, retry
408/429/500–599, backoff 500 ms doubling to 5 000 ms, jitter 0.25, honour `Retry-After`/`retry-after-ms` up to 60 000 ms,
retry connection errors and timeouts; SDK `timeout` default 10 000 ms per attempt.

### 3.6 Status, pricing, data handling

- Images and Box are **"Dreamer-ready"**: for prototyping, not production; request format, answers and limits may change
  between releases (§16.1).
- Pricing: `jev-1.13.0` and `jev-1.14.0` list $0.042 per million input tokens (input only); each image is billed as
  input tokens at the normal input price; images have no separate rate limit. The harness records tokens, never money.
- Data: the Privacy Policy states a "commitment not to train models on user data"; the DPA keeps customer personal data
  "for as long as necessary taking into account the purpose of the Processing" (no period), names no processing region,
  uses EU SCCs (Modules 2/3) and the UK Addendum, Irish law and supervisory authority, sub-processors at
  `trust.typesafe.ai/subprocessors`; zero data retention only for enterprise customers via sales.

### 3.7 Explicit unknowns and how the implementation copes

| Unknown | Coping rule |
|---|---|
| Latency of an image request (no figure anywhere) | `media.verify.service.timeoutMs` per check (default 30 000), per-attempt cap 15 000 ms; checks of one run's images run with `maxConcurrent` (default 2); progress shows the `verifying` stage (§5.3). Measured latency is recorded per check (`durationMs`) so the defaults can be tuned. |
| Image token count per image (not documented) | Budget admission uses `media.verify.service.estimatedInputTokens` (default 3 000) per check, settles at the reported `usage.input_tokens`/`output_tokens`; the status RPC shows the last observed per-check token median. |
| Docs contradiction: `/models` and `/concepts/system-one` say input is text only; `/images` says Jev 1.13 and 1.14 accept images | The model is pinned to a versioned id (`media.verify.service.model`, default `jev-1.13.0`, Q5). A 400/422 that indicates images are not accepted maps to unchecked reason `request-rejected`; the status RPC exposes the last rejection status so the person sees a broken pin. |
| Box answer shape | Documented in the OpenAPI document (§3.3); Box is not used. An answer of an unexpected type for a question id makes that check `invalid-response`; extra answer ids are ignored. |
| Retention, region, sub-processors at TypeSafe | Not decidable by code. The settings notice names "TypeSafe (outside this computer, no stated region)"; the docs page links the DPA; no claim of zero retention is made. |
| Rate-limit figures, `Retry-After` on the API | Retry policy as §9.2 with an advertised delay honoured up to 10 000 ms; beyond that the check is `rate-limited` (fail-open/closed applies). |
| Error body fields other than 422 `detail` | Never parsed for meaning, never stored, never logged: only the status code becomes a reason (§9.1). |
| Format or limit changes ("Dreamer-ready") | Version pin, `x-stability: experimental` on every new method, UI label "Preview", a contract fixture test built from §3.2–§3.4, and fail-open by default (§16.1). |
| Accuracy for non-English prompts (English is the primary training language; others "not as well") | Question texts are English; the prompt goes into `state` as written. Levels are tuned on English and German prompts in the live calibration (plan WP11). |
| Calibration of thresholds | Score levels are "weak in numerical calibration"; thresholds are used only as gates and for ranking candidates of one job (§6.4). Initial values in §6.2 are proposals pending the live calibration (Q7). |

## 3a. What exists today (verified)

| Area | Today | Gap for this design |
|---|---|---|
| `JobRunner.run` (`jobs.ts`) | reserve budget → adapter → `store.put(id, …)` → settle → `succeeded`; recovery: an existing output with the job id means success | no hook between adapter result and `store.put`; one run per job |
| Turn tools `image.*`/`media.*` (`composition/tools.ts:115-155`) | call the adapter directly, `store.put(randomUUID(), …)`, return `{ id, files, metadata }` | do **not** go through `JobRunner`; a hook only in `jobs.ts` would skip every agent-generated image |
| RPC surface (`rpc/media-surface.ts`) | one budget reservation per job at submit; `recover()` marks unfinished jobs `interrupted` (never resubmits) | no per-run admission; no verification state |
| `OutputStore` | `prune()` honours `options.retentionMs`; listeners `onPut`/`onDelete` (media index) | constructed **without options** in `composition/media.ts:44`, in the no-adapter fallback of `composition/index.ts:202` and in `channels/core-host.ts:70`; nothing schedules `prune()`; three separate instances, only one carries the index listener |
| Progress | `stage: 'queued' \| 'running' \| 'downloading'` | no `verifying` stage, no run counter |
| Image decoding | none (dependency-free package); header-only `declaredSize`, metadata strippers; ffmpeg/ffprobe on PATH only for video | resizing needs a decoder (§10) |
| Channels | the switchboard collects `{ id, files }` objects from a turn's tool results (`findOutputIds`) and sends them after the reply; `channels.<name>.locale` (`en`/`de`) drives the bot's own messages | no offer/question; any `{ id, files }` object in a tool result is sent automatically |
| Web chat | `tool.result` → `outputReference(value)` → an image entry | no offer card |
| System One client | none in the harness (D18/D70 reserve a `jev` decision backend; not implemented) | first client; §3a.1 |

**3a.1 Relation to the decision service.** D70 plans a `jev` (TypeSafe cloud) backend for the decision module. This
design adds the first System One client, text-agnostic but image-capable, in `packages/media/src/verify/client.ts`. The
decision module may later reuse it (Q12); this design does not depend on that module.

## 4. Placement in the job pipeline

### 4.1 One loop, two callers

The loop lives in `packages/media/src/verify/loop.ts` (`runVerifiedGeneration`) and is called from:

1. `JobRunner.run` (`packages/media/src/jobs.ts`): when the job carries a resolved verify configuration
   (`job.verify`, §5.1) and `request.kind !== 'video'`, the first adapter result goes into the loop instead of straight
   into `store.put`. The loop ends with **exactly one** `store.put(job.id, …)` of the delivered images, so the existing
   recovery rule ("an output with the job id means success") stays true.
2. The turn tools in `packages/core/src/composition/tools.ts`: same loop, same candidate store, no job persistence (a
   turn does not survive a restart; orphaned candidates are swept, §13.4). The tool keeps returning `{ id, files,
   metadata }` and adds `verification` and `offer` (§8.2).

Without a verify configuration both callers behave byte-for-byte as today (regression test, plan WP4).

### 4.2 Sequence of one verified job

```text
admit run 1 (images = n)            [existing reservation at submit]
loop k = 1..maxRuns:
  generate run k        adapter[op](request_k)                stage "running", run k
  stage candidates      candidates.put(cid, request_k, result, embed=false)   (durable, hidden)
  check each file       prepare copy → TypeSafe → verdict     stage "verifying", run k
  persist job.verify    (candidate ids, checks, verdicts)
  settle run k          images = files produced in run k (+ check tokens settled per check)
  stop if passing ≥ n  |  k = maxRuns  |  check unavailable (§9)  |  budget refuses run k+1  |  cancelled
  admit run k+1         images = n − passing, seed rule §7.3
finalize:
  choose delivered files (§7.2)  → store.put(job.id, request, files, embed = resolved O4 flag)
  remove delivered candidates; remaining candidates = alternates
  if alternates exist → create offer (§8)
```

### 4.3 Job phases and progress

`Progress` gains optional fields (additive, `packages/media/src/types.ts`):
`stage: 'queued' | 'running' | 'downloading' | 'verifying'`, `run?: number`, `maxRuns?: number`.
Fraction: run k occupies `[(k−1)/maxRuns, k/maxRuns)`; generation reports into the first 80 % of that slice, checking
into the last 20 %; finalize sets 1. An early pass jumps to 1 (accepted; the bar only promises monotonicity).
`media.job.progress` gains the optional properties `stage`, `run`, `maxRuns`; `media.job.get`/`list` gain `verification`
(summary, §12.2) and `offerId`. `job.state` stays `running` for the whole loop.

## 5. Configuration

### 5.1 Resolution and snapshot

Precedence per field: **call > agent > global > default**, the O4 rule; `enabled` resolves to `false` when nobody sets it.
`questions` (advanced) is replaced as a whole, never merged. The resolved configuration is computed at submit (RPC) or
at tool invocation and persisted in the job record as `job.verify.config` with a SHA-256 `questionSetHash` over its
canonical JSON; config changes during a loop never change that job's verdicts.

### 5.2 Config keys (config-schema; every key has `x-restart` and `x-tier`)

Global, new object `media.verify` (`additionalProperties: false`, `default: {}`):

| Key | Type / range | Default | `x-restart` | `x-tier` | Notes |
|---|---|---|---|---|---|
| `media.verify.enabled` | boolean | `false` | live | basic | `x-audit: true` |
| `media.verify.mode` | `"prompt-fidelity"` \| `"advanced"` | `"prompt-fidelity"` | live | basic | |
| `media.verify.level` | `"lenient"` \| `"normal"` \| `"strict"` | `"normal"` | live | basic | prompt-fidelity only |
| `media.verify.maxRetries` | integer 0–5 | `2` | live | basic | runs = retries + 1 |
| `media.verify.onUnavailable` | `"open"` \| `"closed"` | `"open"` | live | advanced | §9 |
| `media.verify.template` | string ≤ 64, `^[a-z0-9-]+@[0-9]+$` | unset | live | advanced | provenance of `questions`, informational |
| `media.verify.questions` | array ≤ 16 of `VerifyQuestion` (§6.3) | `[]` | live | advanced | advanced only |
| `media.verify.minAggregate` | number 0–1 | unset | live | advanced | advanced only, extra gate |
| `media.verify.service.apiKeyRef` | string, secret-name pattern of the adapters | unset | live | advanced | `x-audit: true`; a handle, never the key |
| `media.verify.service.baseUrl` | absolute URL ≤ 2048 | `https://api.typesafe.ai` | live | advanced | https; plain http only for loopback (tests) |
| `media.verify.service.model` | string 1–64 | `"jev-1.13.0"` | live | advanced | versioned id recommended (Q5) |
| `media.verify.service.timeoutMs` | integer 1 000–120 000 | `30000` | live | advanced | whole check incl. retries |
| `media.verify.service.maxAttempts` | integer 1–4 | `2` | live | advanced | §9.2 |
| `media.verify.service.maxConcurrent` | integer 1–8 | `2` | live | advanced | checks in flight per job |
| `media.verify.service.estimatedInputTokens` | integer 100–100 000 | `3000` | live | advanced | budget admission per check |

Per agent, new object `agents.<id>.media.verify` with the same non-service keys (`enabled`, `mode`, `level`,
`maxRetries`, `onUnavailable`, `template`, `questions`, `minAggregate`); `x-restart: live`, `x-tier` as above,
`x-write-roles: ["owner", "admin"]` and `x-audit: true` on `enabled`. Service keys are installation-wide only (one key,
one endpoint, one egress decision).

Retention: `media.retentionDays` (integer 1–3650, default 30 — Q1; `x-restart: live`, `x-tier: basic`,
`x-write-roles: ["owner", "admin"]`, `x-audit: true`), §13.

`live` is achievable for every key: the verifier is composed per check from the current config (secret lease, egress
decision, privacy check happen at operation time, exactly like `composeMedia`'s `run`).

### 5.3 Per call

RPC `media.generate`/`media.edit` `params.request` gains `verify` (closed object):
`{ enabled?: boolean, level?: "lenient"|"normal"|"strict", template?: string, maxRetries?: 0..5 }`. `level` selects
prompt-fidelity, `template` selects advanced with that built-in template's questions; both together are refused
(`E_INVALID_PARAMS`). Free questions per call are not offered (they live in config). The turn tools' input schema gains
the same `verify` object (Q14). CLI flags in §12.4.

## 6. Questions, levels, templates, verdict

### 6.1 State sent to TypeSafe

```json
{ "prompt": "<request.prompt as given>",
  "negative_prompt": "<request.negativePrompt, only when set>",
  "image": "<asset reference: random UUID v4>",
  "reference": "<second asset reference, edit only: first reference image, §10.5>" }
```

`assets` holds one entry per reference (`type: "image"`, `format: "png"`, `data_base64`). Each reference string occurs
**exactly once** (in `state`); questions name the image by its state key in backticks (`` `image` ``), never by the
UUID, so every image is sent once (§3.2: each occurrence is a copy). Question texts are fixed English (§3.7).

Transport: `application/json` with `data_base64`. Multipart is recommended by the docs and saves the base64 overhead;
JSON is chosen for v1 because a prepared image is ≤ ~10 MB (§10), the JSON form has no part-ordering or filename
ambiguity, and the fake server can assert it byte-exactly. Multipart is a later optimisation behind the same client
interface.

### 6.2 Prompt fidelity: question sets and thresholds

Question bank (ids are the request's question ids):

| Id | Type | Instructions (sent verbatim) | Criteria | Goodness g |
|---|---|---|---|---|
| `fidelity` | score | "How well does the picture in `image` match the description in `prompt`?" | 0 "The picture has nothing to do with the description." · 1 "The picture shares only a general theme with the description; most requested elements are missing or wrong." · 2 "Several requested elements are present, but important ones are missing or clearly wrong." · 3 "Almost everything requested is present; at most minor details differ." · 4 "Everything the description asks for is present and correct." | score / 4 |
| `subject` | noul | "Is the main subject that `prompt` asks for clearly visible in `image`?" | — | p |
| `contradiction` | noul | "Does `image` show something that contradicts `prompt`?" | true: "Something in the picture contradicts the description (wrong colour, wrong object, wrong number of main subjects, wrong setting)." · false: "Nothing in the picture contradicts the description." | 1 − p |
| `text` | noul | "Is every piece of text that `prompt` asks to appear in the picture spelled correctly in `image`?" | — | p |
| `negative` | noul | "Does `image` show any of the things listed in `negative_prompt`?" | — | 1 − p |
| `style` | noul | "Does `image` have the visual style that `prompt` asks for?" | true: "The description names no style, or the picture has the style it names (for example photo, drawing, painting, 3D render)." · false: "The description names a style and the picture has a different one." | p |
| `defects` | score | "How free of visible generation defects (distorted hands or faces, melted shapes, garbled details) is `image`?" | 0 "Obvious defects that spoil the picture." · 1 "Minor defects that are visible on close inspection." · 2 "No visible defects." | score / 2 |

Conditional questions: `text` only when the prompt contains a quoted span (`"…"`, `„…“`, `“…”`, `'…'` of 1–200
characters); `negative` only when `negativePrompt` is set. Counting questions are deliberately absent (jaggedness page:
counting is unreliable; "wrong number of main subjects" is folded into `contradiction`). High always means yes (noul
guidance); inverted goodness is computed in code.

Levels (all thresholds are hard gates; "—" = question not asked):

| Question | weight | lenient | normal | strict |
|---|---|---|---|---|
| `fidelity` | 0.45 | score ≥ 2.0 | score ≥ 2.8 | score ≥ 3.4 and confidence ≥ 0.40 |
| `subject` | 0.20 | p ≥ 0.50 | p ≥ 0.70 | p ≥ 0.85 |
| `contradiction` | 0.10 | — | p ≤ 0.30 | p ≤ 0.15 |
| `text` (conditional) | 0.10 | — | p ≥ 0.60 | p ≥ 0.80 |
| `negative` (conditional) | 0.10 | — | p ≤ 0.30 | p ≤ 0.15 |
| `style` | 0.05 | — | — | p ≥ 0.70 |
| `defects` | 0.05 | — | — | score ≥ 1.5 |
| Questions per check | | 2 | 3–5 | 5–7 |

The tables are versioned (`prompt-fidelity-<level>@1`); a change of wording or threshold bumps the version, which is
recorded in every manifest (§12.1). Values are proposals until the live calibration (Q7).

### 6.3 Advanced mode

`VerifyQuestion` (closed object):

| Field | Rule |
|---|---|
| `id` | `^[a-z][a-z0-9_]{0,39}$`, unique |
| `type` | `"noul"` \| `"choice"` \| `"score"` |
| `instructions` | string 1–2 000; may name `` `image` ``, `` `prompt` ``, `` `negative_prompt` ``, `` `reference` `` |
| `criteria` | noul: optional `{ true, false }` strings ≤ 500; choice: object 2–32 options (name `^[a-z0-9_-]{1,40}$` → description ≤ 500); score: array 2–10 strings ≤ 500 |
| `pass` | noul: exactly one of `{ min }` / `{ max }` (0–1); choice: `{ accept: [names…], minProbability?: 0–1 }`; score: `{ min: 0 … levels−1 }`; all types: optional `minConfidence` (choice/score only) |
| `weight` | number 0–1, default 1 |

Caps are tighter than the API (255 options, no question maximum) to keep requests well inside the 32k per-question
context. Choice passes when `choice ∈ accept`, or, with `minProbability`, when the summed probability of the accepted
options reaches it. A check that references `` `reference` `` without a reference image (generate) is refused at
config validation.

Templates (built in, versioned, served by `media.verify.templates`): the three prompt-fidelity levels as editable
question lists; `text-rendering@1` (spelling and legibility of requested text); `product-photo@1` (single product,
plain background, no watermark, no text added); `no-people@1` (noul "Is there a person in `image`?", max 0.2);
`photoreal@1` (choice photo / illustration / 3d-render / other, accept photo); `composition@1` (subject centred and
uncropped; horizon level when present). Choosing a template copies its questions into `media.verify.questions` and sets
`media.verify.template` to `<name>@<version>`; later edits are the person's.

### 6.4 Verdict, aggregate, best image

Per question: goodness `g ∈ [0, 1]` (§6.2 table; advanced: noul `p` or `1 − p` for a `max` gate, score `score/(levels−1)`,
choice summed probability of accepted options), `passed` (gate met; a `minConfidence` miss is a fail), `confidence`
(choice/score from the answer, noul `|2p − 1|`, recorded only).

Per image: **verdict `passed`** iff every asked question passed and, in advanced mode, `aggregate ≥ minAggregate` when
set. **Aggregate** = Σ wᵢ·gᵢ / Σ wᵢ over the questions actually asked (weighted composite, the documented
composite-scoring pattern). Status `unchecked` when no verdict exists (§9, §10).

**Best image** among candidates of one job, used for delivery order and best-of-failures, sorted by:
1. status: `passed` > `unchecked` > `failed` (an unchecked image carries no evidence of mismatch; a failed one does);
2. aggregate, descending (unchecked has none; ties within `unchecked` go to step 4);
3. number of passed gates, descending, then goodness of the first question in order (`fidelity` for prompt fidelity);
4. earlier run, then lower file index (deterministic).

The aggregate compares candidates **of the same job and question set only**; it is never shown as an absolute quality
number across jobs (Score calibration caveat, §3.7).

## 7. Retry loop

### 7.1 Rules

- `maxRuns = maxRetries + 1` (default 3). Run k requests `n − passing` images (n = requested count, default 1); for
  n = 1 this is exactly O3. Slots are interchangeable: any passing image fills any open slot.
- **Early exit:** as soon as `passing ≥ n`, no further run is started (O3: deliver immediately).
- **Stop reasons** (`job.verify.stoppedBecause`): `passed`, `max-runs`, `unavailable` (§9), `budget-exhausted`,
  `cancelled`, `interrupted` (§7.5).
- Partial adapter results (`partial: true`, fewer files) are accepted; open slots carry into the next run.
- An adapter error in run k ≥ 2 (`backend_unavailable`, `timeout`, `content_policy`, …) ends the loop with the
  candidates so far; when there are none (run 1), the job fails exactly as today.

### 7.2 Delivery

Deliver up to n images: all `passed` candidates by the §6.4 order, then fill remaining slots with the best others
(`best-of-failed`/`unchecked`). Each delivered file's manifest entry records `delivery`: `passed`, `best-of-failed` or
`unchecked`. Everything generated and not delivered is an **alternate** (§8).

### 7.3 Seeds

When the request sets `seed`, run k uses `seed + (k − 1)` (recorded per file); otherwise the provider chooses. Without
this rule deterministic backends (Draw Things, Core ML, seeded gateway models) would return the same image three times.

### 7.4 Budget per run

- Run 1 keeps today's admission (RPC: `checkBeforeCall` at submit; tool: before the adapter call), `images = n`.
- Run k ≥ 2: a new `checkBeforeCall` with `images = n − passing`, same principal/agent/project/provider/model, taken
  just before the adapter call. A refusal stops the loop (`budget-exhausted`) and finalizes with what exists; it is
  never an error of the job.
- Each run settles at the images it **produced** (stored as candidates), whether they are delivered, offered or later
  deleted: every run counts (O3).
- Each check is its own reservation: provider `typesafe`, model = configured model, `estimatedInputTokens` from config,
  `maxOutputTokens` 64, settled at the reported `usage.input_tokens`/`usage.output_tokens`; a failed request settles 0.
  A refused check makes that image `unchecked` with reason `budget-exhausted` and stops the loop. (C4 says "cost as
  input tokens"; output tokens are settled as reported because the budget counts input + output; they are a few dozen.)
- `JobRunner`'s `BudgetPort` keeps its signature; the loop uses keys `<jobId>#r<k>` and `<jobId>#c<candidateId>`
  (idempotent per key).

### 7.5 Cancellation and restart

- **Cancel** (`media.job.cancel`, caller abort, turn abort): the current adapter call and check are aborted through the
  existing combined signal; every candidate of the job is deleted; no offer; job `cancelled`; reservations settled as
  today (an aborted generation settles with nothing delivered; produced runs settle at their images).
- **Restart mid-loop** (jobs survive restarts): `job.verify` is persisted after every step (candidate stored, check
  done, run settled). Recovery in `media-surface.recover()`:
  1. output with the job id exists → `succeeded` (unchanged rule), then clean up delivered candidates and create the
     offer if `job.verify.offerId` is missing but alternates exist;
  2. else, ≥ 1 candidate stored → re-run the checks that have no result (allowed only if verification is still
     permitted under the current privacy/egress/secret state, else those become `unchecked` with that reason), then
     finalize (§7.2) with `stoppedBecause: "interrupted"`; **no new generation run is started** (docs/media.md: interrupt
     recovery never resubmits; Q3);
  3. else → `failed`/`interrupted` as today.
- Recovery runs after `FileJobPersistence.recoverClaims()` and the candidate store's `recoverStaging()`.

## 8. The follow-up offer

### 8.1 Storage

- **Candidate store:** a second `OutputStore` at `<home>/media/candidates/` (mode 0700, same atomic publish, same quota
  accounting when a quota is configured). Candidates are stored with `embedMetadata: false` (raw provider bytes);
  metadata embedding (O4 precedence) happens when a file is delivered or accepted. No surface lists, indexes, previews
  or sends anything from this root: the media index listener is not attached, the gallery and `media.output.*` never
  read it, the switchboard cannot authorize its ids. A separate root fails safe; hiding flags inside the outputs root
  would need a filter in every reader.
- **Offer record** `<home>/media/offers/<offerId>.json` (0600, `atomicJson`):
  `{ schema: "media.offer/1", id, kind: "alternates" | "unchecked-hold", jobId | null, agentId, userId, sessionId | null,
  channel | null, deliveredOutputId | null, candidateIds, runs, createdAt, state: "open" | "accepted" | "declined" |
  "expired", resolvedAt | null, resolvedBy | null }`. `expiresAt` is derived (oldest candidate `createdAt` +
  `media.retentionDays`), never stored, so a retention change applies to open offers at once.

### 8.2 Wording

Condition: alternates exist (generated > delivered). For n = 1 this is "more than one image was generated"; for n > 1
it also covers a failed image of run 1 replaced in run 2. The question always says that retries happened, how many
images are offered, and that they expire.

| Key | en | de |
|---|---|---|
| `media.offer.passed` | "I checked the picture against your description and generated it {runs} times; attempt {run} passed the check." | „Ich habe das Bild mit deiner Beschreibung abgeglichen und es dafür {runs}-mal erzeugt; Versuch {run} hat die Prüfung bestanden.“ |
| `media.offer.bestOfFailed` | "I checked the picture against your description and generated it {runs} times; none fully passed, so this is the closest one." | „Ich habe das Bild mit deiner Beschreibung abgeglichen und es dafür {runs}-mal erzeugt; keiner der Versuche hat die Prüfung ganz bestanden, das hier kommt ihr am nächsten.“ |
| `media.offer.question` | "Do you want the other {count} picture(s) too? Otherwise they are deleted after {days} days." | „Möchtest du die anderen {count} Bilder auch haben? Sonst werden sie nach {days} Tagen gelöscht.“ |
| `media.offer.hold` | "The image check was unavailable, so I did not deliver the picture. Do you want it anyway, unchecked?" | „Die Bildprüfung war nicht erreichbar, deshalb habe ich das Bild nicht zugestellt. Möchtest du es trotzdem ungeprüft haben?“ |
| `media.offer.accepted` / `.declined` / `.expired` | "Here are the other pictures." / "The other pictures are deleted." / "The other pictures have expired." | „Hier sind die anderen Bilder.“ / „Die anderen Bilder sind gelöscht.“ / „Die anderen Bilder sind abgelaufen.“ |

`{days}` is the remaining whole days until `expiresAt` (at least 1).

### 8.3 Asking and answering, per surface

The question is rendered **by the harness** on every surface (deterministic, localized), never left to the model. The
answer is taken by a button where the surface has one, and otherwise by the agent, which calls a tool.

| Surface | Question | Yes / No | No answer |
|---|---|---|---|
| Web chat | The tool result carries `offer` (below); `chat/model.ts` adds an `offer` entry next to the image (as `outputReference` does for images); an offer card shows `media.offer.*` text and two buttons. | Buttons call `media.offer.resolve`; a typed answer goes to the agent (row "Channels"). The card follows `media.offer.resolved` and `media.offer.get`; accepted alternates render as normal image entries. | Card stays open until `expiresAt`, then shows "expired". |
| Channels (Telegram and every switchboard channel) | `#collectMedia` also collects `offer` objects of the turn's tool results; after `flushMedia` sent the images, the switchboard sends the question text in `channels.<name>.locale` through the existing `output()` policy (behaviour profile, rate limits). If the policy suppresses it (reply `never`, rate limit), the offer simply stays open. | The person answers in free text; the turn's agent sees the earlier tool result and calls the tool `media.offer.resolve { offerId, accept }`. On accept the tool result lists the alternates as `{ id, files, metadata }` objects, so the existing `findOutputIds` → `sendOutput` path delivers them; on decline the tool result has no such objects. Inline buttons: Q9. | Same as web. |
| CLI chat (`plur1bus chat`) | Printed after the tool result line (English, the CLI's language). | Typed answer → agent → tool; or `plur1bus media offer accept|decline <id>`. | Same. |
| RPC-direct jobs (`plur1bus media generate --wait`, web gallery) | `--wait`: the question on stderr with the offer id; the `--json` document carries `offer`. Gallery: the job toast and the gallery's "Pending alternates" filter. Optional inbox entry (Q11). | `plur1bus media offer accept|decline <id>`; gallery buttons → `media.offer.resolve`. | Same. |

Tool result additions (turn tools; the alternates are deliberately **not** `{ id, files }` objects, so no channel can send
them before a yes):

```json
{ "id": "…", "files": [ … ], "metadata": { … },
  "verification": { "status": "passed", "delivery": "passed", "runs": 3, "run": 3, "aggregate": 0.84 },
  "offer": { "offerId": "…", "kind": "alternates", "count": 2, "expiresAt": 1763000000000,
             "next": "The harness has asked the person whether they want the 2 other pictures. Do not ask again. When they answer, call media.offer.resolve with this offerId and accept true or false." } }
```

`media.offer.resolve` (turn tool) is registered whenever a media tool is registered and verification is configured for
the agent; capability `media.generate` (accept delivers stored media; decline deletes the caller's own candidates), risk
low, input `{ offerId: uuid, accept: boolean }` closed.

### 8.4 Resolution semantics

- **Who:** a principal with `agent.use` on the offer's agent **and** (the offer's `userId` or an Owner/Admin). In a group
  chat only the requester (or Owner/Admin) can resolve; others get `E_DENIED`.
- **Yes:** each alternate is promoted from the candidate store into the outputs store under its candidate id (one
  locked copy + manifest write, embedding per the job's resolved O4 flag, owner record with the offer's agent/user),
  then removed from the candidate store; state `accepted`; result `{ state, outputIds }`. Promotion keeps the original
  `createdAt`, so retention counts from generation (Q2).
- **No:** every candidate of the offer is deleted at once; state `declined`.
- **Expiry:** the sweep (§13) deletes expired candidates and sets `expired`; resolving then answers `E_CONFLICT`
  reason `offer-expired`; a second resolve answers `E_CONFLICT` reason `offer-resolved`; an unknown id `E_NOT_FOUND`.
- Idempotent per candidate: a crash in the middle of an accept leaves each candidate either in one store or the other;
  a repeated accept finishes the rest.

## 9. Failure of the check service

### 9.1 Classification (closed set of unchecked reasons)

| Reason | Cause |
|---|---|
| `local-only` | privacy.localOnly applies to the agent (§11.1) |
| `not-configured` | no `apiKeyRef` and the base URL is not loopback |
| `key-unresolved` | the secret is missing |
| `egress-denied` | the egress policy refused the base URL |
| `too-small`, `aspect-out-of-range`, `unsupported-format`, `preprocess-unavailable`, `too-large` | §10 |
| `timeout` | per-attempt or total timeout |
| `rate-limited` | 429 after retries |
| `overloaded` | 529 after retries |
| `auth-failed` | 401 (also 403 if ever sent) |
| `request-rejected` | 400, 413, 415, 422 (status kept, body discarded; `max_tokens_exceeded` is a 400) |
| `service-error` | other 5xx after retries |
| `network-error` | connection refused/reset, DNS, TLS |
| `invalid-response` | non-JSON, missing/unknown answer, value out of range, `answers` missing a question id |
| `budget-exhausted` | the check's token reservation was refused |
| `cancelled`, `interrupted` | §7.5 |

Error bodies, URLs and keys never enter a reason, a manifest, a log line or an error (the MediaError rule).

### 9.2 Retries of one check

Retry 429, 529, 500, 502, 503, 504, connection errors and per-attempt timeouts, up to `maxAttempts` (default 2) within
`timeoutMs`; backoff 500 ms doubling, cap 5 000 ms, jitter 0.25; an advertised `Retry-After`/`retry-after-ms` is honoured
up to 10 000 ms, a longer one ends the check as `rate-limited`. A resend can only bill tokens twice (no other side
effect), which the budget settles.

### 9.3 Fail-open (default) and fail-closed

| | `onUnavailable: "open"` (default, C1) | `onUnavailable: "closed"` |
|---|---|---|
| Unchecked image in run 1 | delivered at once, `status: "unchecked"`, reason recorded; **no further runs** (retries would spend generation budget without a signal) | not delivered; held as an offer of kind `unchecked-hold` (§8.2); job `failed` with the existing error `backend_unavailable` and `verification.unchecked` set |
| Unchecked image in run k ≥ 2 | loop stops (`unavailable`); delivery by §7.2 (unchecked ranks above failed) | loop stops; delivered only if a `passed` image exists, else the job fails as above and all candidates are held in the offer |
| Configuration reasons (`not-configured`, `key-unresolved`, `egress-denied`) | as above; the status RPC and settings show the cause | as above |
| `local-only` | §11.1 — never fail-closed: under local-only the step is off, not broken |

## 10. Image preparation (on a copy)

### 10.1 Rules

The original bytes are never modified; the prepared copy exists only in memory and is never written to a manifest or
disk. Steps:

1. Sniff the format from magic bytes (`sniffFormat`), never trust `format`; refuse decoding beyond 8192 px per side
   (the request limit) or 2²⁸ pixels (`assertDimensions`) → `too-large`.
2. Orientation: read EXIF orientation (JPEG APP1, the existing `exifOrientation` parser; WebP `EXIF` chunk); 2–8 →
   rotate/flip pixels.
3. Scale factor `s = min(1, 1568 / max(w, h))`; `w' = round(w·s)`, `h' = round(h·s)`. (The pixel cap 2 458 624 = 1568² is
   implied.) If `min(w', h') < 280`: `too-small` when the original's short side is < 280, else `aspect-out-of-range`
   (a very long panorama cannot meet both bounds). No upscaling.
4. Output PNG (8-bit RGB or RGBA; 16-bit inputs are reduced) without any ancillary chunk; ≤ 16 MiB is guaranteed by the
   size bound (1568² × 4 bytes uncompressed ≈ 9.4 MiB).
5. Animated input (APNG, animated WebP): the default image / first frame.

### 10.2 Fast path

PNG or JPEG already within 280–1568 per side, ≤ 16 MiB, no orientation tag other than 1: send the bytes after
`stripMetadata` (no re-encode). This covers the common generated sizes 1024×1024, 1024×1536 and 1536×1024. JPEG is sent
as `format: "jpeg"`.

### 10.3 Decoders without new dependencies

- **PNG** (all colour types, bit depths 1–16, Adam7 interlace, `tRNS`): decoded in TypeScript with `node:zlib`
  (`inflateSync` with a `maxOutputLength` bound), area-average downscale, PNG encode with `deflateSync`. No dependency;
  this covers most generated images (`packages/media/src/verify/png-codec.ts`).
- **JPEG and WebP** that need scaling or rotation: local `ffmpeg` (already required for video, ADR-017), invoked like
  `processVideo` (no shell, `-protocol_whitelist file,pipe`, private temp dir, bounded output, abort signal):
  `-frames:v 1 -vf <transpose/flip>,scale=<w'>:<h'>:flags=area -f image2 -c:v png`. Orientation filters are derived
  from our own EXIF reading (ffmpeg does not apply image EXIF orientation reliably). No ffmpeg → `preprocess-unavailable`.
- Pure-TS JPEG/WebP decoders are out of scope (size and attack surface).

### 10.4 Limits checked before sending

Prepared image ≤ 16 MiB; JSON body ≤ 30 MiB (headroom under 32 MiB); one image per request (edit: two, §10.5). A
request that would exceed a limit is not sent (`too-large`).

### 10.5 Edits

For `edit`, the first reference image is prepared the same way and sent as `reference` (one extra image, tokens
counted). Advanced questions may use it; prompt-fidelity uses it only in `contradiction` wording
("…contradicts `prompt` as an edit of `reference`?") — Q10.

## 11. Privacy, egress, secrets

### 11.1 "Only local models"

The check is a model call. Decision order per check, before any I/O (as in `composeMedia`): privacy → egress → secret.

- `localOnlyFor(config, agentId)` true (installation switch or the agent's own override, the `privacy/local-only.ts`
  rule):
  - inherited verification (global/agent config): the step is skipped, every image `unchecked` with reason
    `local-only`, the job delivers as without verification; no request, no egress decision, no secret lease;
  - explicit per-call `verify.enabled: true` (RPC or tool): refused before generation with `E_DENIED` reason
    `local-only` and `LOCAL_ONLY_HINT` (no generation budget is spent on a request that cannot be honoured).
- The settings panel shows verification disabled with the reason; `media.verify.status` reports `blocked: "local-only"`.
- A loopback or `privacy.localEndpoints` base URL does **not** lift this (C3: off under local-only; Q8).

### 11.2 Local backends notice

When verification is enabled (global or for an agent) and any configured media adapter is local (Draw Things, Core ML,
or an adapter whose every endpoint is local per `composeMedia`'s `local()`), the person is told plainly that
**the generated image and the prompt leave this computer and go to TypeSafe**:

- Settings > Media and Agents > agent > Media: a warning banner beside the switch (text: "Image check sends each
  generated picture and its prompt to TypeSafe, outside this computer — also for local generators such as Draw Things
  or Core ML. TypeSafe names no processing region; see its data processing terms.").
- CLI: `plur1bus media verify status` prints it; `plur1bus config set media.verify.enabled true` (and the agent key)
  prints it on stderr after a successful write (the `--json` document is unchanged).
- Manifest: `verification.leftDevice: true` on every checked file whose adapter was local.

### 11.3 Secret

`media.verify.service.apiKeyRef` names a secret (`plur1bus secret set typesafe`, value on stdin; suggested name
`typesafe`, shared with a future decision backend, Q12). It is leased per check through `createAuthSecretStore`
(audited lease, the core's `kind: core`), registered with the redaction registry (`registerSecret`), held only for the
request, never written to the job record, manifest, offer, log, metric or error. A key is refused for a private/loopback
host (the `HttpTransport` rule); a loopback base URL works **without** a key (fake servers, local test endpoints).

### 11.4 Egress

`egress.decide(baseUrl)` before the lease; refused → `egress-denied`. The egress inventory gains the base URL's host
while verification is enabled anywhere (`egressHosts`-style helper `verifyEgressHosts(config)`), so an allowlist policy
can list `api.typesafe.ai` before the first check. Redirects are refused (`redirect: "error"`), the response body is
bounded (1 MiB), https is required except for loopback.

### 11.5 What leaves the machine

Exactly: the prepared copy of the image (and, for edit, of the first reference), the prompt and negative prompt, the
fixed or configured question texts, the model id. Never: the original bytes, metadata, agent or person ids, other
images, manifests.

## 12. Records and surfaces

### 12.1 Manifest (`media.output/1`, additive optional field)

```json
"verification": {
  "schema": "media.verify/1",
  "mode": "prompt-fidelity", "level": "normal", "template": null,
  "questionSet": "prompt-fidelity-normal@1", "questionSetHash": "<sha256>",
  "maxRuns": 3, "runs": 2, "stoppedBecause": "passed",
  "service": { "host": "api.typesafe.ai", "modelRequested": "jev-1.13.0" },
  "offerId": "<uuid> | null",
  "files": [ {
    "index": 0, "candidateId": "<uuid>", "run": 2, "seed": 43,
    "status": "passed", "delivery": "passed", "aggregate": 0.84,
    "modelAnswered": "jev-1.13.0", "checkedAt": 1763000000000, "durationMs": 1830, "attempts": 1,
    "usage": { "inputTokens": 1450, "outputTokens": 31 },
    "prepared": { "width": 1024, "height": 1024, "format": "png", "resized": false, "rotated": false, "sha256": "<sha256>", "bytes": 1534211 },
    "leftDevice": false,
    "questions": [ { "id": "fidelity", "type": "score", "instructions": "…", "criteria": ["…"], "pass": { "min": 2.8 }, "weight": 0.45 } ],
    "answers": [ { "id": "fidelity", "type": "score", "value": 3.31, "confidence": 0.62, "probabilities": { "0": 0, "1": 0.02, "2": 0.08, "3": 0.47, "4": 0.43 }, "goodness": 0.83, "passed": true } ],
    "unchecked": null
  } ]
}
```

`unchecked` is `{ "reason": "<§9.1 reason>", "httpStatus": 429 }` (status only where one exists). Alternates carry the
same per-file record in their candidate manifest. Question texts are stored in full (a few hundred bytes) so a manifest
explains itself after templates change. No key, URL path, error body or person id is stored.

### 12.2 RPC (rpc-schema; `x-server: "core"`, `x-stability: "experimental"`, `x-since: "1.7.0"`, closed params)

| Method / notification | Params | Result |
|---|---|---|
| `media.generate`, `media.edit` (changed) | `request.verify` (§5.3) | unchanged |
| `media.job.get`, `media.job.list` (changed) | — | job gains `verification` `{ status, runs, maxRuns, stoppedBecause }` and `offerId` |
| `media.job.progress` (changed) | — | optional `stage`, `run`, `maxRuns` |
| `media.offer.get` | `{ id }` | offer view: `{ id, kind, jobId, agentId, deliveredOutputId, count, runs, state, createdAt, expiresAt, resolvedAt }` (no candidate bytes, no candidate ids) |
| `media.offer.list` | `{ agentId?, state? }` | `{ offers }`, filtered by `agent.read` |
| `media.offer.resolve` | `{ id, accept }` | `{ state, outputIds }` |
| `media.offer.resolved` (notification) | — | `{ offerId, agentId, state }`, audience: the submitting connection and every connection of the offer's user (the `media.job.finished` rule) |
| `media.verify.status` | `{ agentId? }` | effective config (no secret), `configured`, `keyResolved`, `egressAllowed`, `blocked` (`local-only` or null), `localAdapters` (ids for the §11.2 notice), `lastRejection` status, observed token median and latency median |
| `media.verify.templates` | `{}` | built-in templates and level presets with their question lists and versions |
| `media.verify.test` | `{ outputId, agentId, verify? }` | runs one check on a stored image (no generation; budgeted; used to tune advanced questions); result = the §12.1 per-file record |

RBAC: reads need `agent.read`, `resolve`/`test` need `agent.use` (plus §8.4), `media.verify.status` with an `agentId`
needs `agent.read`, without needs `settings.read`. `media.offer.*` and `media.verify.test` are offered as WebMCP tools
like the other media methods; `media.verify.status` exposes no secret. No new error codes: `E_DENIED`
(`local-only`, rights), `E_NOT_FOUND`, `E_CONFLICT` (`offer-resolved`, `offer-expired`), `E_INVALID_PARAMS`,
`E_NOT_AVAILABLE` (reason `verify-unconfigured` for `media.verify.test` without a configured service). New reason strings
are documented in `docs/errors.md`.

### 12.3 Web

- Settings > Media (`packages/web/src/pages/surfaces/media.ts`, beside `MetadataPreference`): "Image check (Preview)"
  — switch, level picker with one plain sentence per level, retries stepper (0–5), behaviour when unavailable,
  service key (secret picker linking to Settings > Secrets), model, timeout; advanced editor (template picker →
  question list: type, text, criteria, gate, weight; "Test on an image" calls `media.verify.test`); the §11.2 banner;
  local-only state; "Keep generated media for N days" with the warning "Shortening deletes older media at once".
- Agents > agent > Media: the per-agent override (inherit / on / off, level, retries, advanced).
- Chat: offer card (§8.3); verification badge on delivered images (`passed`, `closest match`, `unchecked`) with a
  details drawer (questions, answers, model).
- Gallery: the same badge and drawer; filter "Pending alternates" (open offers with accept/decline); expired outputs
  referenced from chat render as "expired".
- i18n: de/en for every string (`scripts/check-i18n.mjs`); no inline styles.

### 12.4 CLI (Rust, `crates/plur1bus/src/commands/media.rs`)

- `plur1bus media generate|edit … [--verify[=lenient|normal|strict]] [--verify-template NAME] [--verify-retries N]
  [--no-verify]` → `request.verify`.
- `--wait`: the job document carries `verification` and `offer`; the question goes to stderr with the offer id.
- `plur1bus media offers [--agent ID] [--state open|accepted|declined|expired]` → `media.offer.list`, schema id
  `media.offers/1`.
- `plur1bus media offer show <id>` (`media.offer.show/1`), `media offer accept <id> [--out DIR]`
  (`media.offer.accept/1`; `--out` saves the accepted images as new files, never overwriting), `media offer decline <id>`
  (`media.offer.decline/1`).
- `plur1bus media verify status [--agent ID]` (`media.verify.status/1`), `media verify templates`
  (`media.verify.templates/1`), `media verify test <output-id> [--agent ID] [--verify…]` (`media.verify.test/1`).
- Every `--json` document is the raw RPC value plus the top-level `schema` id (AGENTS.md); `docs/cli.md` regenerated.

## 13. Retention

### 13.1 Setting

`media.retentionDays` (1–3650, default 30, Q1), live. One value for every generated medium; the person sets it in
Settings > Media or with `plur1bus config set media.retentionDays N`.

### 13.2 Wiring fix (O4 finding)

One `OutputStore` instance per home, built by a new `composition/media-store.ts` (`mediaOutputStore(home, config)`), used
by `composition/media.ts`, the no-adapter fallback in `composition/index.ts`, `rpc/media-surface.ts` and
`channels/core-host.ts`, so the media-index listener sees every deletion and retention applies even with no adapter
configured. `OutputStore.prune(now, { olderThanMs })` gains the optional second argument (additive; `options.retentionMs`
stays for library callers), so the live value is read at sweep time instead of being frozen in the constructor.

### 13.3 Sweep

- System job `media.retention` (`needsLlm: false`, `singleton: true`, `exclusive: true`,
  `schedule: { every: 3 600 000, jitter: 300 000 }`), registered like the capabilities recheck in
  `composition/index.ts` (interval timer → `systemJobs.run(…, { trigger: "cron" })`), run once at core start after
  recovery (`trigger: "harness"`) and after a change of `media.retentionDays` (`trigger: "harness"`). Ledger rows record
  counts only (`{ outputs, candidates, jobs, offers, ownerRecords }`), never ids or prompts.
- Deletes, for `now − createdAt ≥ retentionDays × 86 400 000`:
  1. outputs (images, video with poster, manifest) through `OutputStore.prune` → listeners (media index) notified;
  2. candidates (alternates) of terminal jobs and of offers; candidates of `queued`/`running` jobs are never touched;
     orphaned candidates (no job record and no offer, older than 1 h) are removed at core start;
  3. open offers whose candidates are gone → `expired` (+ `media.offer.resolved`); resolved offers older than retention
     → record deleted;
  4. terminal job records (`succeeded`, `failed`, `cancelled`) older than retention — they hold persisted reference and
     mask bytes, which are user data;
  5. owner records (`media/owners/<id>.json`) whose output is gone.
- Not covered (documented): copies already sent to Telegram or other channels, files saved with `--out`, chat transcript
  text, budget ledger rows (counts only), audit entries.
- Sharing: today `canShare` is always false; a future share link must expire with its output (requirement recorded for
  the sharing design). A "keep" pin that exempts an output from retention is Q1.

### 13.4 Upgrade safety

An existing home can hold media older than the default. To avoid silent loss on upgrade: if `media.retentionDays` is
unset and outputs older than the default exist at the first sweep, the sweep defers deletion by 7 days and writes one
inbox entry (kind `system`, Owner/Admin) "Media older than 30 days will be deleted on <date>; set Settings > Media to
keep them longer." (Q1).

## 14. Test strategy (no network)

- **Fake TypeSafe server** `packages/media/test/fixtures/typesafe-fake.ts`: an in-process `fetch` implementation (to
  assert `Authorization: Bearer`, which a loopback HTTP server cannot receive because keys are refused for private hosts)
  plus a 127.0.0.1 HTTP server for the keyless transport path. Scripted per request: answers, status, delay,
  `Retry-After`, malformed bodies. It validates every request against §3.2/§3.4: `TypeSafe-Danger-Zone-Images: true`,
  `model`, `state` keys, every asset referenced exactly once, `format` present with `data_base64`, base64 without
  whitespace or `data:` prefix, decoded PNG/JPEG sides within 280–1568, ≤ 16 MiB, body ≤ 32 MiB.
- **Guard:** a test-wide fetch spy fails any request to a non-loopback host; the default base URL is never contacted.
- **Client:** pass/fail per answer type; 401, 400 (`max_tokens_exceeded`), 413, 415, 422 (`detail`), 429 with and
  without `Retry-After`, 529, 500/503, timeout, connection reset, non-JSON, missing answer id, noul out of range, unknown
  answer type, response `model` differing from the request (recorded); no body text in any error.
- **Preparation:** synthetic PNGs (all colour types, 16-bit, interlaced, tRNS) 2048² → 1568², 1792×1024 → 1568×896,
  200×200 → `too-small`, 4000×300 → `aspect-out-of-range`; JPEG with orientation 6 and WebP via ffmpeg (skipped when
  ffmpeg is absent, like the native video tests) or `preprocess-unavailable`; decompression-bomb header → `too-large`;
  the original's SHA-256 unchanged.
- **Verdict:** level tables applied exactly (boundary values on both sides); conditional questions; advanced gates
  (noul min/max, choice accept/minProbability, score min, minConfidence, minAggregate); tie-break determinism.
- **Loop:** pass in run 1 (one adapter call), pass in run 2, all fail → best-of-failed, n = 3 slot filling, partial
  results, seed + (k − 1), adapter error in run 2, budget refusal of run 2, check budget refusal, fail-open/closed
  matrices, cancellation during generation and during a check (candidates deleted), restart after each persisted step
  (kill points like `PLUR1BUS_TEST_EXT_FAIL_AT`: recovery finalizes, **zero** adapter calls after restart), unchanged
  behaviour without verify (byte-identical manifest).
- **Privacy/secrets:** local-only inherited → zero requests, `unchecked: local-only`; explicit per-call → `E_DENIED`
  before the adapter is called; egress denied; secret missing; the key never appears in job, manifest, offer, logs,
  tool results (marker-free: the test compares against the leased value, no token-shaped literal in the source).
- **Offers:** accept/decline/expire/idempotent accept after a crash between two promotions; RBAC (requester vs. other
  member vs. Owner); switchboard rig: question after the images in `en` and `de`, suppressed by a `never` profile,
  free-text "yes" → tool → alternates sent via `sendOutput`, "no" → nothing sent and candidates gone; web model test for
  the offer entry and card; CLI parse and `--json` schema ids.
- **Retention:** fake clock; live change of `retentionDays`; outputs, candidates, job records, owner records, offers;
  media-index listener receives `onDelete`; running jobs untouched; upgrade deferral and inbox entry.
- **Schemas/docs:** config and RPC schema tests (every new key has `x-restart`/`x-tier`, methods have
  `x-stability`/`x-since`/`x-server`, params closed); `pnpm docs:gen` output committed (needs the CLI build; plan WP6).

## 15. Data model summary

| Record | Path | New fields |
|---|---|---|
| Job | `media/jobs/<id>.json` | `verify: { config, questionSetHash, maxRuns, run, phase, candidates: [{ id, run, index, seed, status, aggregate, check }], stoppedBecause, offerId }` |
| Candidate output | `media/candidates/<id>/` | normal manifest + `verification` per file |
| Output | `media/outputs/<id>/` | optional `verification` (§12.1) |
| Offer | `media/offers/<id>.json` | §8.1 |
| Config | `config.json` | `media.verify.*`, `agents.<id>.media.verify.*`, `media.retentionDays` |

## 16. Risks

### 16.1 "Dreamer-ready" image input

Format, answers and limits may change between releases; the models page contradicts the images page. Mitigations: a
versioned model pin; the contract fixture test of §14 fails loudly when we change our side; fail-open by default (a
broken service degrades to unchecked delivery, never to lost images); `x-stability: experimental` everywhere and the
"Preview" label; `lastRejection` in the status RPC; the whole step is off by default.

### 16.2 Cost

Up to 3 generations instead of 1 (the dominant cost; the budget's image limits bound it) plus up to 3·n checks (image
tokens of unknown size, $0.042/Mtok list price, recorded as tokens only). Defaults keep it bounded: 2 retries, early exit,
no retries after an unchecked run, per-run admission.

### 16.3 Latency

Each retry adds a full generation plus a check of unknown latency. A turn tool call can take several minutes with slow
providers; the job progress shows run k/maxRuns; the turn's own deadline applies (a deadline abort is `timeout`,
candidates are deleted).

### 16.4 Quality of the judgement

Score calibration is weak, counting is unreliable, the model reads instructions literally, non-English prompts are
judged less accurately, and text in a generated image could try to steer the answer (jaggedness: adversarial content).
Mitigations: atomic questions, no counting, thresholds as gates only, best-of ranking only within a job, the levels'
live calibration (WP11), and the person always gets the alternates on request.

### 16.5 Privacy

Images and prompts leave the machine, also for local generators; TypeSafe states no region and no retention period
(ZDR only for enterprise). Mitigations: off by default, local-only blocks it, §11.2 notice, egress inventory, DPA link.

### 16.6 Retention data loss

A short default deletes media people expected to keep. Mitigations: §13.4 deferral and notice, audit on changes,
warning on shortening, Q1 (pin/keep).

## 17. Owner questions — decided 2026-10-21

Q1, Q9, Q10 and Q14 were answered by the owner; the others were settled by the controller (technical, reversible) and are binding unless the owner reverses them. Where a decision differs from the proposal in the earlier sections, this table wins.

| # | Question | Decision |
|---|---|---|
| Q1 | Default `media.retentionDays`; "keep forever" or a per-output keep pin? | **Owner:** 30 days default, user-configurable; a per-output **keep pin** (exempt from retention) is part of this package, not a follow-up; no global "forever". §13.4 deferral on upgrade stays. |
| Q2 | Alternate's retention clock | At generation (`createdAt`). |
| Q3 | Restart mid-loop | Finalize with the stored candidates; recovery never starts a new paid run. |
| Q4 | `n > 1` | Slot-based retries: only missing images are re-requested. |
| Q5 | Model pin | `jev-1.13.0`, gated by a live probe (WP11 moved first, see below): the docs disagree on image input, so no implementation package starts before the probe shows images are accepted. |
| Q6 | Failure default | Fail-open (marked "unchecked"); fail-closed holds the image as an `unchecked-hold` offer and fails the job with `backend_unavailable`. |
| Q7 | Thresholds | Calibrate in WP11 with the owner's key (entered by the owner via `plur1bus secret set typesafe`), then fix the `@1` tables. |
| Q8 | Local-only | No: under "Only local models" the check is always off. |
| Q9 | Channels | **Owner:** inline yes/no buttons now (Telegram inline keyboard, Discord components and any channel with an equivalent) through a generic channel choice port; free-text answer through the agent as the fallback where a channel has no buttons. |
| Q10 | Edits | **Owner:** yes, with its own switch — verification of generation and of edits is configured separately (global / agent / call), so an edit's reference image is only sent when edit verification is on. |
| Q11 | Inbox kind | Yes, `media-offer`, owner of the job only, settled on resolve/expiry. |
| Q12 | Secret | One shared secret `typesafe`. |
| Q13 | Retention scope | Also deletes terminal job records and orphaned owner records. |
| Q14 | Agent per call | **Owner:** tighten only — the agent may switch verification on or choose a stricter level per call (within budget), never switch off or loosen what the user/agent configuration requires. |
| Q15 | Schema changes | Released: WP6 changes config-schema and rpc-schema in one PR (it was an internal agent rule, not an owner rule). |

### Order change from these decisions

WP11's live probe (one image, the three `normal` questions, against the owner's key) runs **before WP1**; the full calibration stays in WP11. If the probe shows the pinned model rejects images, the package stops and the spec goes back to the owner.
