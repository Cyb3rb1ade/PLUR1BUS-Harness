# Prompt cache layout (ADR-010 §1 R1–R8)

The builder in `packages/core/src/prompt/` returns provider-neutral segments and cache metadata.
This change adds no provider calls, adapter wiring, logging backend or UI confirmation flow.
The policy follows ADR-010 and M2 Acceptance 9; provider constants are the repository's recorded
matrix, not a claim of fresh live-provider verification.

## Rules, implementation and executable evidence

| Rule | Implementation | Tests under `packages/core/test/prompt/` |
| --- | --- | --- |
| R1: placement | Tools → system → frozen memory → conversation → volatile. Explicit markers only at eligible boundaries; provider limits per row of `packages/providers/schema/cache-profiles.json` (RE-D21). Long Anthropic conversations reserve an interior marker 15 positions before the trailing marker, within the 20-position lookback. Consecutive tool-use/result runs count as one position. | `breakpoints.test.ts`, `cache-layout.test.ts` (every adjacent pair, six engine blocks beyond every marker) |
| R2: minimum | The cache-profile table `packages/providers/schema/cache-profiles.json`: one row per model family and platform, with its source, verification date and status, validated against its schema on load; `model-table.ts` maps a row to the builder's view. The route (`RenderInput.route`: gateway, platform, local server) selects platform rows such as Bedrock's or Vertex's floors. No markers if zones 1–3 are below the floor, even with a long transcript. Individual boundaries must also clear the floor. No padding; `prompt.below-minimum` and `cache.reason` expose the decision. Unknown models fail closed. | `model-table.test.ts`, `cache-layout.test.ts` (each exact floor and one token below), `rulings.test.ts` |
| R3: deterministic prefix | Canonical JSON with sorted keys, NFC/LF text, stable tool order. `zoneHashes` and cumulative `prefixHashes` omit clock/routing metadata. `prefixKey` identifies the agent and normalised model. Caller-supplied stable content must omit timestamps, run/session IDs, counters and other volatile data. | `canonical.test.ts`, `prefix-stability.test.ts`, `b6-determinism.test.ts` (golden zone hashes, two renders, two process starts, metadata under different locales/time zones) |
| R4: explicit changes | Stable content changes emit `prompt.prefix-invalidated` with `reason: prefix-changed`; an explicit snapshot refresh uses `memory-refresh`. Tools/system/options are captured at session open. The host must obtain confirmation for cache-killer changes before applying them. | `prefix-stability.test.ts`, `session.test.ts`, `cache-layout.test.ts` |
| R5: per-model prefixes | One stable-prefix entry per agent/model. `setModel()` changes a session model; the next render emits `model-changed` with `previousModel`. Switching back retains the model's prefix and its TTL history. A switch event does not mean that the returning model's unchanged prefix is cold. | `prefix-stability.test.ts`, `cache-layout.test.ts` |
| R6: sticky routing | `session_id = sha256(canonicalJson({agentId, sessionId}))`, a bounded 64-character hint, independent of model and excluded from prefix bytes. Pass the host's actual `sessionId` to sessions/renders; omission selects a default session for the agent. OpenRouter's documented 10-minute routing idle timeout is independent of cache TTL. | `cache-layout.test.ts`, extended B6 |
| R7: TTL | Injected `now()` measures time since the previous render for this agent/model/session. Each row's `warmMs` gives the predicted window: Anthropic 5m (1h when selected), OpenAI 30m. Google and every row without a documented TTL are unknown (`null`) unless configured; unknown TTL, reversed clock, expired entries or changed content predict cold. `cacheTtlMs` overrides provider-class durations. The previous request's selected TTL governs expiry, so generation time counts. Existing `chooseCacheTtl()` recommends 1h for ≥3 projected reads; stable 1h markers precede trailing 5m markers. | `rulings.test.ts`, `cache-layout.test.ts` (fake clock, exact expiry, generation time, overrides, model/session isolation) |
| R8: usage | `CacheTelemetry.record(render, usage)` returns a detached per-turn record. `createCacheTelemetry()` keeps weighted totals per agent/model and per session. `hitRatio = cache_read / (cache_read + cache_creation + input)`, zero when total is zero. Invalid counts/overflow are rejected atomically. | `telemetry.test.ts`: synthetic 20-turn B5 script, every turn ≥3 has ≥0.90 read share, isolation and zero/invalid usage |

## Metadata contract

`zones` lists all five zones as `{zone, byteOffset, tokenEstimate, hash}` including empty zones.
`byteOffset` is the **exclusive end** in concatenated UTF-8 segment text, with no separators or
provider envelope. Zone token estimates are local (`ceil(UTF-16 text length / 4)`); zone hashes
are the existing canonical segment-content hashes. Each `breakpoints` entry has the same fields,
plus `segment`, `ttl`, `kind`: its token estimate is cumulative and its hash is SHA-256 of the
concatenated text through that segment. Different segment boundaries/roles can share a text hash;
use canonical `zoneHashes`/`prefixHashes` for content invalidation. A provider adapter must map
segment boundaries to its own wire representation; these offsets are not offsets into a provider
request. Estimates are heuristics, not tokenizer counts or a guarantee that a provider accepts a
cache write. Each marker is also exposed on `segments[segment].cache`.

`cache` reports `provider`, `mechanism`, `minimumTokens`, `eligible`, `reason`, `expected`, `ageMs`
and `ttlMs`. Reasons distinguish eligible explicit prefixes, implicit providers, below-minimum,
empty prefixes and unknown models. `prefix.status` tracks content identity (cold/warm/invalidated);
`cache.expected` predicts warm/cold reuse by age. Neither confirms a provider cache entry exists:
rendering alone cannot prove dispatch, a write or a hit. Only provider usage measures that.
The TTL prediction concerns zones 1–3, not the shorter trailing conversation TTL.

## Frozen snapshot and live memory (L7)

`createPromptSession()` freezes `memorySnapshot` at session start. No clock, append or recall
refreshes it. `refreshMemorySnapshot(snapshot)` is the only in-session replacement; the next
render reports the memory invalidation when the rendered bytes change. This explicit API
supersedes PR #125's no-refresh default recorded in ADR-010's historical implementation record.
Recalls enter as the current volatile `context` or correlated `tool_result`, after the last
breakpoint. After an append, historical recall folds into the append-only conversation at its
original anchor, as in PR #125; the current live recall remains uncached. All six engine blocks
share the host's join/cap policy and clip/drop events. No recall rewrites the frozen snapshot.

## Provider emitter (RE-D22)

The builder's output is provider-neutral; `packages/core/src/composition/cache-emit.ts` is the one place that writes
provider cache fields. `providerFetch` calls it inside a turn (a rendered prompt in scope) for the
`anthropic_messages`, `chat_completions` and `codex_responses` wires; Gemini's wire is never rewritten. Each provider's
route comes from its base URL through the table's `hosts` list (`cacheRouteForUrl`): an OpenRouter gateway, a platform
(Bedrock, Vertex, the ChatGPT plan) or a provider's own API (`vendor`). A provider's body fields go only to its own API.

| Class (table `class`) | Example | What the emitter writes |
| --- | --- | --- |
| explicit breakpoints | Anthropic wire | `cache_control` on the builder's blocks (stable zones, conversation), never on the recall tail |
| explicit breakpoints | OpenAI GPT-5.6+ on Responses | `instructions` become a leading developer message, one `input_text` part per stable segment; `prompt_cache_breakpoint: {mode: "explicit"}` on the marked parts, the last user text or a tool output; `prompt_cache_options: {mode: "explicit"}`, which with no breakpoint also suppresses a paid write. Chat Completions and the ChatGPT plan get no breakpoint fields (not documented there) |
| explicit breakpoints | OpenRouter to Claude | `cache_control` on system, user and tool text parts and on the last tool; `session_id` |
| implicit with a TTL tier | Moonshot K3 | `prompt_cache_options: {mode: "implicit", ttl}` (the stable TTL the builder chose, `5m` by default) and `prompt_cache_key` |
| implicit with a routing key | xAI, OpenAI before 5.6, Mistral | the row's affinity key per wire, for example `x-grok-conv-id` (xAI Chat) or `prompt_cache_key` |
| implicit, no control; local KV cache | DeepSeek, Gemini, Z.ai, local servers | nothing |

The affinity value is the builder's `session_id`, cut to the field's length limit; an existing value is never
overwritten. `modelProfiles.*.cache` feeds the builder: `hint: "prefer"` or `ttlSeconds` of at least 3600 choose the 1h
tier where the model offers it, `hint: "none"` places no breakpoint. The wire tool block is sorted by name, as the
builder's tool zone is, so the same tool set gives the same prefix bytes.

## Usage hook example

```ts
const builder = createPromptBuilder({ now: () => Date.now() });
const telemetry = createCacheTelemetry();
const render = builder.render({ agentId, model, sessionId, tools, system,
  memory: memorySnapshot, conversation });
// Adapter follow-up: translate provider usage into mutually exclusive buckets.
const record = telemetry.record(render, { cache_read: 950, cache_creation: 0, input: 50 });
const sessionTotals = telemetry.summary(agentId, model, sessionId);
```

Call `record` once per provider-usage report. The interface does not deduplicate repeated reports.
`input` means **uncached** input: adapters reporting inclusive input totals must subtract cached
reads/writes first. Turn records include cacheReadTokens, cacheCreationTokens, inputTokens,
totalInputTokens, hitRatio, model, breakpointCount and zoneHashes. Totals are token-weighted,
not an average of per-turn ratios. The B5 fixture demonstrates the measurement contract; it
is not evidence of ≥0.90 hits on a live provider. Registries/totals are in-memory and a new
builder/telemetry instance resets warmth history/totals; deterministic hashes and routing IDs
remain identical across process starts.

## Verification and follow-ups

Offline prompt tests (Node 24.21, dependencies already installed):

```sh
node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning \
  --test --test-concurrency=1 packages/core/test/prompt/*.test.ts
```

`no-io.test.ts` traps socket, DNS, fetch and spawn calls during assembly/session/telemetry.
B6 is included there and the existing `pnpm bench` gate still uses the pinned synthetic corpus.
Repository typecheck and lint/hygiene must also pass. CI unit jobs exercise the same tests on
Linux, macOS and Windows; their actual results are reported on the PR.

Follow-ups: map markers to provider `cache_control`/explicit options, pass sticky routing headers,
normalise actual usage into this interface, integrate host confirmation and scheduler TTL
projections, publish telemetry in UI/doctor, and verify cache-hit targets against provider
fixtures/live acceptance. Provider-adapter, scheduler and UI changes are outside this PR's scope.
