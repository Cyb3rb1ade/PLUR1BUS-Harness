# ADR-010: Latency and caching

**Status:** Proposed · **Date:** 2026-09-22 · **Deciders:** Christian (owner) · **Inputs:** `docs/phase0/brief.md` D6, D7, D9 · `docs/phase0/auftrag-original-2026-09-21.md` §4, §6.1, §6.2, §10, §11, §12 · `docs/phase0/research/harness-engineering-state-of-the-art.md` §2, §3, §4, §"Top 15" · `docs/phase0/research/providers-chat-auth-caching.md` §"Prompt caching (cross-provider)" · `docs/phase0/research/plur1bus-host-contract.md` §1, §2, §5 · `docs/phase0/research/plur1bus-crons-embedding-portability.md` §2 · `docs/phase0/research/platform-binaries-and-startup.md` §"Node runtime facts", §"CLI cold-start technique comparison" · `docs/phase0/research/verification-log.md` V1–V4 · Companion: `docs/provider-matrix.md`, `docs/platform-matrix.md`, ADR-001 (process model), ADR-002 (engine budgets), ADR-006 (embed/rerank).

## Context

D6 makes latency a design goal with numbers: CLI cold start **< 100 ms** for `--help`/simple commands, core daemon warm in the background, recall inside a time budget **in parallel with prompt assembly**, first token streamed immediately, local embedding/rerank models pre-loaded, benchmarked from M1. D7 makes caching a three-layer requirement: provider prompt caching with a cache-stable layout (volatile recall/temporal/mood blocks placed *after* the cached prefix), an embedding cache keyed by embedding identity + content hash, and a response/tool-result cache with explicit invalidation.

The evidence base is unusually concrete for both halves.

**Caching.** Anthropic's rules are vendor-documented: prefixes build strictly **tools → system → messages**; a change at any level invalidates that level and everything after it; **max 4 breakpoints**; a write happens only at the breakpoint and reads walk back at most **20 block positions** (consecutive `tool_use` blocks count as one position, likewise consecutive `tool_result`); minimum cacheable prefix is model-dependent — **512** (Claude Fable 5.1 / Mythos 5.1, Opus 5, Fable 5, Mythos 5), **1 024** (Sonnet 5, Sonnet 4.6/4.5, Opus 4/4.1), **2 048** (Mythos Preview, Opus 4.7, Haiku 3.5), **4 096** (Opus 4.5/4.6, Haiku 4.5); below the minimum **nothing caches and no error is returned**; write costs **1.25×** (5 min) or **2.0×** (1 h) base input, read **0.1×** (0.025× on Fable 5.1 / Mythos 5.1); TTL is measured from the request and **generation time counts against the window** (`providers-chat-auth-caching.md` §Prompt caching; [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)). Break-even at 1.25× write / 0.1× read is **~1.28 reads**, i.e. caching pays from the second turn — so it is a default, not an optimisation flag (`harness-engineering-state-of-the-art.md` §3). Silent cache killers: changed tool definitions, toggled web search/citations, changed speed or effort settings, added/removed images, changed `tool_choice`, and **non-deterministic JSON key order in tool schemas** (ibid.).

OpenAI GPT-5.6+ offers implicit (auto-placed breakpoint) or explicit (`prompt_cache_options`) caching, **1 024 visible input tokens** minimum, TTL `"30m"` (the only supported value on 5.6+), read 0.1× / write 1.25×, and requires the rendered prefix to match **byte-for-byte**. Gemini 2.5+ caches implicitly and by default; minimum **4 096** tokens (Gemini 3.5/3.6/3.7/3.8 Flash, 3.1 Pro Preview) or **2 048** (Gemini 2.5 Flash/Pro); its TTL and cache pricing were **not obtainable from Google's own docs** this pass and are a recorded gap. OpenRouter translates syntaxes and adds sticky routing via `session_id`/`x-session-id` (≤256 chars, 10-minute idle timeout) (all: `providers-chat-auth-caching.md` §Prompt caching).

Measured effect of getting the shape right: **99.9 % cache hits** and inputs effectively priced at ~0.1× list (Writer, *The Harness Effect*, arXiv 2607.06906); and swapping *only* the orchestration layer, model and task held constant, gave **38 % fewer tokens/task (14.2k → 8.8k), 41 % lower cost ($0.21 → $0.12), 44 % lower median latency (48 s → 27 s)** across 6 models / 3 weight classes / 5 vendors — with the caveat that n = 22 tasks and the quality delta (0.78 → 0.81) is explicitly directional (ibid., via `harness-engineering-state-of-the-art.md` §3).

**Latency.** Cold start dominates short tasks: the Claude Agent SDK for TypeScript, spawning a fresh CLI per query, measured **13.13 s / 13.88 s / 13.00 s** for three identical queries with no improvement across calls — process spawn 4–5 s, CLI init 3–4 s, model loading 2–3 s, the actual LLM call 2–3 s, i.e. **~75 % of wall-clock is reusable overhead** ([claude-agent-sdk-typescript#33](https://github.com/anthropics/claude-agent-sdk-typescript/issues/33), 2025-10-18). The fix is structural: codex-rs's submit/event model, where the client submits `Op`s and the core emits an event stream and the UI never calls into the core synchronously ([codex-rs architecture](https://codex.danielvaughan.com/2026/03/28/codex-rs-rust-rewrite-architecture/)).

The most transferable checklist is Hermes PR [#59332](https://github.com/NousResearch/hermes-agent/pull/59332): removing four blocking probes from the critical path — Discord capability detection over HTTPS (~2.0 s), an Ollama `/api/show` probe fired against non-Ollama providers (~0.3 s), python3/pip subprocess probes during first prompt build (~0.5 s), an MCP package import on every between-turn refresh (~0.4 s) — cut **AIAgent init 1.0–3.3 s → 0.36–0.64 s, first system-prompt build 0.93 s → 0.32 s, and CLI submit → request dispatch ~4.3 s → ~0.9 s** (measured, cold process, OpenRouter). The rule it yields: **no network call and no subprocess spawn on the prompt-build path**; capability detection is memory cache → 24 h disk cache → permissive default + background refresh; and the user's typing window is free time to spend on recall and assembly.

**What PLUR1BUS already gives us.** Its system-prompt contribution is *static* — `registerMemoryPromptSupplement` returns constants (`index.js:7073-7088` @ `89148f9`, read directly) — and everything volatile is a per-turn prepend capped at 17 000 chars over six named blocks (`index.js:13315-13325`, read directly). The research note's conclusion is the one this ADR builds on: "the system prompt itself is stable… Everything volatile is a per-turn `prependContext` prefix on the user turn… which is cache-friendlier than a system-prompt rewrite" (`plur1bus-host-contract.md` §2). It also already has an embedding cache whose key is `provider \0 model \0 dimensions \0 scopeId \0 cacheVersion \0 textHash` (`lib/embedding-cache.js:57-58`, read directly — correctly includes dimensions) and an LLM result cache with a 64 MiB default cap (`index.js:4556-4565`, read directly).

## Decision

**Adopt a four-tier cache-stable prompt layout, deliver every volatile memory block outside the cached prefix, enforce determinism in tool-schema serialisation with a CI hash test, and build the harness as a resident core with thin clients from day one.** Cache-hit rate per turn is a first-class telemetry field, not a diagnostic. Three cache layers (prompt, embedding, response/tool-result) each have an explicit key and an explicit invalidation rule. Budgets are enforced by the prompt builder per agent, project and user — never by asking the model to be brief.

### 1. Cache-stable prompt layout

Assemble in exactly this order, mapped onto Anthropic's four breakpoints (and the same shape for OpenAI's explicit breakpoints and Gemini's implicit prefix):

| Zone | Content | Breakpoint | Stability rule |
|---|---|---|---|
| **1 · tools** | Tool definitions, deterministically serialised | BP1 | Changes only when the agent's tool set changes. Per-agent MCP/allowlist changes therefore invalidate everything — surface that cost in the UI before applying |
| **2 · system** | Soul/persona (static), engine static prompt supplement (`registerMemoryPromptSupplement` constants), safety preamble, operating instructions | BP2 | **Nothing time-varying above BP2.** Banned in zones 1–3: timestamps, "current time", session IDs, run IDs, token counters, mood, cost figures |
| **3 · frozen memory snapshot** | The agent's curated long-term memory as of **session start**, frozen for the session | BP3 | Hermes's frozen-snapshot trick, kept for the cache benefit but without its cost (Hermes's memory is frozen *and* there is no live path; ours has both) |
| **4 · conversation** | Message history, append-only | BP4, trailing | Append-only growth keeps hitting BP4 as long as a turn adds fewer than 20 block positions |
| **volatile (uncached)** | **Recall, temporal, temporal-continuity, mood/persona-directive, reactivation, reminder, Neo lanes** — the six engine blocks of ADR-002 | — | Delivered **after** the last breakpoint, as a `tool_result` (when recall was tool-invoked) or as a trailing user-context block |

This is D7's requirement stated mechanically, and it resolves the documented conflict between a live memory engine and prefix caching: "frozen snapshot in the *stable zone*, plus mid-session recall injected as *tool results in the volatile tail* — never by rewriting the system block" (`harness-engineering-state-of-the-art.md` §2, §"What better means" item 7). PLUR1BUS's existing split already matches it, which is why the engine needs no change here — only the harness's placement decision (ADR-002: "the engine returns text; the harness decides whether a block rides in the cached prefix").

Concrete rules:

- **R1 — breakpoint placement.** At most 4; BP4 on the last block identical across requests. For long conversations place a second trailing breakpoint ~15–20 block positions back so the 20-position lookback keeps hitting as the transcript grows (`providers-chat-auth-caching.md`).
- **R2 — minimum-prefix awareness.** The builder knows each model's minimum (512/1 024/2 048/4 096) from the provider matrix and **logs a warning when zones 1–3 fall below it**, because nothing caches and no error is returned. It does **not** pad automatically (see pi's dissent below).
- **R3 — deterministic serialisation.** Tool schemas, and every JSON object rendered into zones 1–3, are serialised with **sorted keys** and a pinned number/string formatting. **CI test:** render `(tools + system + frozen snapshot)` for two synthetic turns and for two consecutive process starts, hash each zone, and fail on any drift. This is called out as "the highest-ROI test in the repo" (`harness-engineering-state-of-the-art.md` §3) and it is cheap.
- **R4 — no cache-killer toggles mid-session.** Changing `tool_choice`, effort/speed settings, web-search/citations flags or adding an image invalidates. The harness treats each as an explicit, confirmed action with a visible "this will cost a full re-read" notice — the same courtesy Hermes's FAQ says is missing for model switching ("the cache key includes the model, so the first message after every switch re-reads the whole conversation at full input price", `harness-engineering-state-of-the-art.md` §7).
- **R5 — per-model prefixes.** Maintain one cached prefix per (agent, model) so a switch does not destroy the other model's warm cache; warn and confirm before a switch that will invalidate.
- **R6 — sticky routing.** Pass a stable `session_id`/`x-session-id` (≤256 chars) on OpenRouter calls so its sticky routing hits the same upstream cache from the first follow-up; note the 10-minute idle timeout.
- **R7 — TTL awareness.** Anthropic's 5-minute window starts at the request and **generation time counts against it** — a 4-minute response leaves ~1 minute. The scheduler tracks per-session cache age and, for sessions with slow turns, uses the 1-hour TTL (2.0× write) when projected reads ≥ 3. When mixing, 1-hour entries must precede 5-minute entries in the request.
- **R8 — telemetry.** Every turn records `{cacheReadTokens, cacheCreationTokens, inputTokens, hitRatio, model, breakpointCount, zoneHashes}`. `total_input = cache_read + cache_creation + input`; `input_tokens` counts only what follows the last breakpoint. Published per session in the UI and in `doctor`.

### 2. Embedding cache

Key = **embedding identity ‖ content hash**, where identity is §6.2's full definition (model + revision/artifact hash + quantisation + dimension + prefix/task scheme + normalisation + token cap, plus the pinned upstream for aggregators). PLUR1BUS already has most of this: `key = provider \0 model \0 dimensions \0 scopeId \0 cacheVersion \0 textHash`, SQLite-backed, with per-scope byte caps and columns `key_hash, provider, model, dimensions, scope_id, cache_version, text_hash, vector, debug_text, created_at, accessed_at, expires_at` (`lib/embedding-cache.js:57-58, 67-71, 216, 485`; `plur1bus-crons-embedding-portability.md` §2). Two gaps to close, both already identified in ADR-002: the key carries `dimensions` but not the full identity fingerprint (two different models at the same width collide), and it has no per-identity `scopeId` for multi-identity recall. In-memory layer defaults today: 128 entries, 300 s TTL, coalescing on, persistence off (`lib/providers/embedding-openai.js:49-63`) — the harness turns persistence **on** by default, since the whole point is surviving a restart.

Invalidation: identity change ⇒ new key space (never evict, never mix — §6.2's "Niemals Vektorräume mischen"); content change ⇒ new hash; explicit purge only via the re-embedding migration.

### 3. Response and tool-result cache

PLUR1BUS ships `createLlmResultCache({enabled, ttlMs, maxEntries: 256, persist, maxBytes: 67_108_864, metrics, baseDbPath})` (`index.js:4556-4565`, read directly) for internal feature LLM calls. The harness generalises it with explicit invalidation:

| Cached thing | Key | Invalidated by |
|---|---|---|
| Internal feature LLM result (classification, summarisation, emotion tier-3) | `sha256(feature, model, promptTemplateVersion, inputDigest)` | template version bump, model change, TTL |
| Deterministic read-only tool result | `sha256(toolName, schemaHash, normalisedArgs)` + declared `readOnly` | TTL (short, default 60 s), explicit invalidation event from the tool's domain (file change, store write) |
| Capability probe (provider models, tool support, context length) | `sha256(providerId, baseUrl)` | **memory cache → 24 h disk cache → permissive default + background refresh** — never a blocking probe (Hermes PR #59332) |
| Rendered prompt zones 1–3 | `zoneHash` | any input to that zone |

Only tools declaring `readOnly: true` and `idempotent: true` are cacheable — the same metadata that gates parallel and speculative execution (`harness-engineering-state-of-the-art.md` §1, top-15 rule 6). Destructive tools are never cached. Cached tool results carry their age in the UI-facing channel so the model is not silently shown stale data.

### 4. Budget enforcement

Per **agent**, **project** and **user**, enforced in the prompt builder and the scheduler, not in prompts: a per-zone character/token allocation with telemetry (zone 3's cap is the engine's 17 000-char inject budget by default, ADR-002); per-turn and per-session token and cost ceilings; per-class retry budgets from a typed failure taxonomy (transient / schema / semantic / fatal) so retries cannot become a cost sink; and subagent returns capped at **~2 000 tokens** by the protocol rather than requested in a prompt. Rationale: the harness owns 4 of 5 input-side cost terms plus the retry multiplier (`harness-engineering-state-of-the-art.md` §3). Hermes's documented absence of any cost governance is the counter-example (ibid. §7).

### 5. Latency

| Rule | Detail | Source |
|---|---|---|
| **L1 — CLI cold start < 100 ms for trivial paths** | Single bundled entry (esbuild/rolldown), **lazy `import()` for every provider, channel, protocol adapter, ONNX/LanceDB/sharp binding**, and `module.enableCompileCache()` / `NODE_COMPILE_CACHE`. Measured evidence for the compile cache: npm's own CLI merged it for performance ([npm/cli#7901](https://github.com/npm/cli/pull/7901)); a blog benchmark reports median **290 ms → 238 ms (~20 %)** and "20–30 % boost in server start-up time" attributed to Node 25's compile-cache work, with bundling needed first to see the gain ([ben3d.ca](https://ben3d.ca/blog/introducing-node-prewarm)) — **one blog's measurement, not an official benchmark** | `platform-binaries-and-startup.md` §Node runtime facts, §CLI cold-start technique comparison |
| **L2 — resident core, thin clients** | Core daemon with an async **submit/event** API (client submits `Op`s; core emits a typed event stream that TUI, CLI, HTTP API and tests all consume identically). Retro-fitting a daemon is hard; starting with one is free | [codex-rs](https://codex.danielvaughan.com/2026/03/28/codex-rs-rust-rewrite-architecture/); [claude-agent-sdk-typescript#33](https://github.com/anthropics/claude-agent-sdk-typescript/issues/33) (13.0–13.9 s per fresh-CLI query, ~75 % reusable overhead; daemon projected 13 s → 2–3 s, 100 queries 1 300 s → 265 s — **projection, not measurement**) |
| **L3 — no network probes and no subprocess spawns on the critical path** | Enforced by a test that fails on any socket or spawn syscall during prompt assembly (ADR-001 T3). Capability detection follows the cache ladder in §3 | Hermes [PR #59332](https://github.com/NousResearch/hermes-agent/pull/59332) (submit→dispatch ~4.3 s → ~0.9 s) |
| **L4 — recall in parallel with prompt assembly, inside a budget** | Zones 1–4 are assembled while `engine.recall()` runs; the volatile block is appended when recall returns or when the hard deadline fires, whichever is first. Budgets from ADR-002: **soft 400 ms / hard 1 200 ms**, reactivation race **50 ms** unchanged, in-recall embed 800 ms, in-recall rerank 300 ms. Recall never blocks the turn — degraded result, visible | D6; ADR-002; `index.js:12967-12969`, `:13337-13346` |
| **L5 — use the typing window** | Start recall and prompt assembly when the input gains focus, not on submit. Free hundreds of ms | Hermes PR #59332 ("CLI pre-imports run off-thread during the idle banner window") |
| **L6 — TTFT streamed immediately** | Stream the first provider token straight through to the client; never buffer for post-processing. Post-turn work (capture, light-dream triage) is enqueued, not awaited | D6; §4.1 non-blocking capture |
| **L7 — local models pre-warmed with a RAM budget** | Embedding and reranker models loaded once in the core daemon at startup, in the background, never blocking the first turn. **RAM budget with LRU unload, pinning, a ceiling, and a warning when creating an agent with a new local model** (§6.2). This is not optional: PLUR1BUS's shared pool only calls `dispose()` with no RSS accounting, and the known issue records that "RSS growth is a hard-coded 1 GiB per window, **which loading a local embedding model exceeds by design**", producing liveness warnings; the scheduler's own pressure gates are 3.0/4.5 GiB | `plur1bus-crons-embedding-portability.md` §2 "RAM handling"; `KNOWN-ISSUES.md:57-62`; `lib/runtime-scheduler.js:21-22` |
| **L8 — parallel tool calls** | Independent tool calls issued concurrently, gated by per-tool `readOnly`/`idempotent`/`destructive` metadata | Anthropic multi-agent research system: parallel tool calling cut research time "by up to 90 %" |
| **L9 — layered compaction, cheapest first** | L1 tool-result trimming → L2 cache-prefix protection → L3 LLM summary as last resort; "hide, don't delete"; and **flush to memory before compacting** (the engine's `checkpoint()`, ADR-002) | `harness-engineering-state-of-the-art.md` §2, top-15 rules 4 and 10 |

## Options considered

### Option A: Provider-agnostic "just keep the prefix stable" (no explicit breakpoints)

| Dimension | Assessment |
|---|---|
| Complexity | Low |
| Fit with brief D1–D11 | Partial: satisfies the spirit of D7 but not the "cache-stable layout" requirement's precision |
| Cross-platform risk | None |
| Maintenance burden | Low |
| Latency / token cost | Leaves Anthropic's four-tier independence on the table: any tool-definition change would invalidate the memory snapshot too |

**Pros:** works everywhere including Gemini's implicit caching; nothing to get wrong.
**Cons:** on Anthropic, one breakpoint means every tool change re-writes the whole prefix; no way to keep tools warm while rotating the memory snapshot.

### Option B: Four-tier explicit breakpoints with a provider-capability abstraction (recommended)

| Dimension | Assessment |
|---|---|
| Complexity | Medium: one prompt builder, a per-provider cache-capability descriptor (explicit/implicit, min tokens, TTLs, max breakpoints), and the CI hash test |
| Fit with brief D1–D11 | **Exactly D7.** Also serves D6 (cache reads cut TTFT directly) |
| Cross-platform risk | None (pure prompt assembly) |
| Maintenance burden | The per-model minimum table needs upkeep as models ship — it lives in `docs/provider-matrix.md`, already maintained |
| Latency / token cost | Best available: the four tiers are cached independently, so updating the memory snapshot doesn't invalidate tools |

**Pros:** maps 1:1 onto Anthropic's documented tiers; degrades cleanly to implicit caching on Gemini and pre-5.6 OpenAI (the zone order is the same, only the breakpoints go unused).
**Cons:** the builder must know provider capabilities, which is one more thing to keep accurate; zone-hash tests fail loudly on legitimate changes (intended, but noisy at first).

### Option C: Per-turn memory rewrite into the system prompt (what a naive memory integration does)

| Dimension | Assessment |
|---|---|
| Complexity | Lowest |
| Fit with brief D1–D11 | **Violates D7** explicitly |
| Cross-platform risk | None |
| Maintenance burden | Low |
| Latency / token cost | **Worst possible:** every turn writes a new cache entry at 1.25×–2.0× and reads nothing at 0.1× |

**Pros:** the model always sees current memory in the most authoritative position.
**Cons:** it is the anti-pattern the whole ADR exists to avoid; PLUR1BUS already avoids it (`plur1bus-host-contract.md` §2). Listed only to record that the current engine behaviour is *already correct* and must not be "improved" into a system-prompt rewrite.

## Benchmarks (run from M1, in CI)

| ID | Metric | Target | How measured |
|---|---|---|---|
| **B1** | `plur1bus-harness --help` wall-clock | **p95 < 100 ms** cold (compile cache warm), macOS arm64 + Windows x64 | `hyperfine --warmup 3 --runs 50`; recorded per platform per commit; regression gate at +20 % |
| **B2** | CLI submit → first provider byte dispatched, warm daemon | **p95 < 300 ms** | In-process timestamps at `submit` and at the HTTP request's first byte, against a **mock provider** so provider RTT is excluded |
| **B3** | TTFT end-to-end against a mock provider that emits its first token at t=0 | **p95 < 400 ms** | Client-side event timestamp of the first `message_delta` |
| **B4** | Recall latency and budget adherence | p50 < 250 ms, **p99 ≤ hard budget (1 200 ms)**, 0 budget overruns | Engine-emitted `RecallResult` timings over a fixed 500-query corpus |
| **B5** | **Cache-hit ratio per session** | **≥ 0.90** cache-read share of eligible input tokens from turn 3 onward, on a 20-turn scripted session | From provider `usage`: `cache_read / (cache_read + cache_creation + input)`, logged per turn (R8) |
| **B6** | **Zone determinism** | Byte-identical zone hashes across 2 renders and 2 process starts | The R3 CI test; fails the build on drift |
| **B7** | Tokens per task on the 20-case golden set | Track absolute; alert on **> 10 % regression** | Sum of `total_input + output` per task, mock provider with deterministic responses |
| **B8** | Core daemon cold start → ready | **< 3 s** without local models; **< 15 s** with the default local embedding model warmed in background and never blocking B2 | Daemon readiness event timestamp |
| **B9** | No probes on the critical path | **0** socket/spawn syscalls during prompt assembly | Syscall assertion harness (ADR-001 T3) |
| **B10** | RAM ceiling with local models | RSS below the configured ceiling; LRU unload demonstrably fires | Soak with two local embedding identities + one reranker loaded |

B1, B5, B6 and B9 are **gates** (build fails); the rest are tracked with regression alerts. All run against mock providers so the numbers are about the harness, not the network — which is the point: "Benchmark the harness, not just the model" (`harness-engineering-state-of-the-art.md` §6).

## Trade-off analysis

The caching decisions are close to free: the layout costs one ordering discipline and one CI test, and pays from the second turn of every session. The genuine tension is between **freshness and cacheability of memory**. Freezing the snapshot at session start (zone 3) is what makes the prefix stable; delivering live recall in the volatile tail is what keeps the agent current. That split costs us one thing: the frozen snapshot can be stale within a long session, and a fact written at turn 3 appears in the cached zone only at the next session. We accept that, because the live path (recall as a tool result) covers it and because the alternative — rewriting zone 3 mid-session — destroys the cache for every subsequent turn.

The latency decisions trade build-time complexity for run-time speed. Lazy imports and a bundle make the dependency graph less obvious and the stack traces worse; the resident daemon adds supervision, IPC, and a whole class of "stale daemon" bugs. Both are cheap now and expensive later, which is the argument for doing them first.

The weakest part of the evidence base is worth stating: the Writer numbers are n = 22 with a directional quality delta; the daemon speed-up figure in `claude-agent-sdk-typescript#33` is a **projection**, not a measurement (only the 13 s cold-start figures are measured); the compile-cache percentages come from one blog; and the "84 % token reduction from compaction" figure circulating in aggregators **could not be verified against a primary Anthropic page** and is deliberately not used here (`harness-engineering-state-of-the-art.md` §Gaps).

## Consequences

- **Easier:** cost per session becomes predictable and measurable; a cache regression is caught by a unit test instead of a bill; the resident core makes the CLI, the API, the channels and the tests one consumer of one event stream; recall can be made richer without hurting TTFT because it runs in parallel inside a deadline.
- **Harder:** the prompt builder becomes a load-bearing, test-gated component that nobody may edit casually; any per-agent tool or MCP change is now a visible, costly action rather than a free toggle; deterministic serialisation constrains how we render schemas and configs; the daemon needs supervision, upgrade-in-place and "which daemon am I talking to" diagnostics; lazy imports must be enforced by lint, or the first careless top-level import silently costs 100 ms.
- **Revisit when:** (a) a provider changes its caching contract (the per-model minimum table is the fragile part — it lives in `docs/provider-matrix.md`); (b) B5 cannot reach 0.90 on a real provider despite B6 passing, which would mean the volatile/stable split is drawn wrong; (c) we ever self-host inference, at which point prefill/decode disaggregation (~40 % higher sustainable throughput, Together AI via Zylos **[secondary]**) and speculative decoding become real levers rather than notes.

## Conflicts with the brief

**C1 — pi's dissent: a minimal system prompt cannot be cached at all, and D7 assumes caching is always available.**
*Finding:* pi's entire system prompt **including tool definitions is under 1 000 tokens, with a 73-token core prompt** ([Zechner, 2025-11-30](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/)), and the measured harness literature argues *for* minimal prompts ("ETH Zurich study of 138 agentfiles: LLM-generated CLAUDE.md/AGENTS.md hurt performance and raised token cost 20 %+; human-written files gave ~4 %"). But Anthropic's minimum cacheable prefix is **512 tokens at best and 4 096 for several current models**, and below the minimum **nothing caches and no error is returned**. A 73-token system zone is therefore uncacheable, and on a 4 096-token-minimum model even zones 1–3 together may be. The research note states the fork explicitly: "Either accept that, or deliberately pad Tier 2/3 with genuinely useful stable content to clear the floor" (`harness-engineering-state-of-the-art.md` §3).
*Source:* [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) via `providers-chat-auth-caching.md` §Prompt caching; [Zechner 2025-11-30](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/) via `harness-engineering-state-of-the-art.md` §2, §3.
*Options:* (1) **accept it** — small prompts, no caching for zones 1–2 on small-prompt agents, and rely on zones 3–4 (frozen memory snapshot + conversation) to clear the floor, which they usually will once a real memory snapshot is present; (2) **pad deliberately** with genuinely useful stable content (skills index, project conventions) until the floor is cleared — but this is exactly the over-instruction the ETH study measured as harmful; (3) **pad with filler** — rejected outright.
*Recommended resolution:* **(1), with (2) available as an explicit, per-agent, opt-in setting and never a default.** The builder implements R2 (warn, don't pad) and B5 measures the consequence. This is recorded as a **documented tension, not a resolved question**: D7 says caching is a design requirement, and for a deliberately minimal agent on a 4 096-minimum model it may simply not be achievable for zones 1–2. The honest position is that cache-hit rate is a *target*, not a guarantee, and that the biggest single cache-hit lever is zone 3 — which is memory, i.e. our product.

**C2 — D6's "< 100 ms CLI cold start" is not independently measurable against any published baseline.**
*Finding:* No primary source with measured cold-start numbers for Claude Code or the Codex CLI was found; the codex-rs article claims a binary "starts in milliseconds" with no measurement, and no ms figures were found for lazy imports or bundling specifically (`harness-engineering-state-of-the-art.md` §Gaps; `platform-binaries-and-startup.md` §CLI cold-start technique comparison, gaps 8).
*Source:* as cited.
*Options:* (1) keep 100 ms as an internal target measured by B1 on our own machines and accept that it is not comparative; (2) relax it to a measured-baseline-relative target; (3) drop the number.
*Recommended resolution:* **(1).** 100 ms is achievable for a bundled Node CLI with compile cache and lazy imports, and B1 makes it verifiable on the two platforms that matter. Recorded so nobody later cites an external benchmark that does not exist.

## Open questions for the owner

1. **Q1 — Anthropic 1-hour TTL.** It costs 2.0× on write instead of 1.25×. Do we enable it automatically when the scheduler projects ≥ 3 reads in the window (proposed), only manually, or never?
2. **Q2 — zone 3 refresh policy.** The frozen memory snapshot is fixed for a session. Should a long session (say > 2 h or > 50 turns) get **one** deliberate snapshot refresh — paying one full cache write to avoid a badly stale snapshot — or stay frozen until the next session?
3. **Q3 — C1's padding option.** Accept uncacheable small prompts (proposed default), or expose a per-agent "pad stable zone to the model's cache minimum with the skills index" switch? The ETH evidence argues against; the economics argue for.
4. **Q4 — tool-result cache TTL.** 60 s default for `readOnly` tools. Too aggressive for file reads in a project a human is editing?
5. **Q5 — cache-hit telemetry visibility.** Per-turn cache stats in the UI for every user, or only for Owner/Admin roles (it reveals prompt structure and cost)?
6. **Q6 — local model pre-warm default.** Pre-warm on daemon start (fast first turn, ~500 MB–1 GB RSS always resident) or lazily on first embedding call (slower first recall)? Proposal: pre-warm, with an opt-out for low-RAM machines.
7. **Q7 — benchmark gate strictness.** B1/B5/B6/B9 as hard build gates from M1 (proposed) may block unrelated work early. Acceptable, or advisory until M3?

## Action items

1. [ ] Add the per-provider **cache-capability descriptor** (explicit/implicit, max breakpoints, per-model minimum tokens, TTL options, write/read multipliers, sticky-routing key) as a required column set in `docs/provider-matrix.md`, and mark Gemini's TTL and cache pricing as the known gap.
2. [ ] Land the **R3 zone-hash CI test** and the **B9 syscall assertion** before any prompt-builder code — both are cheap and both stop the failure class permanently.
3. [ ] Specify the prompt builder's zone contract (inputs, ordering, ban list for zones 1–3, breakpoint placement rules) as a typed interface reviewed together with ADR-002's `RecallResult`.
4. [ ] Extend the engine's embedding-cache key to the full embedding identity fingerprint and a per-identity `scopeId` (ADR-002 P8 dependency); turn persistence on by default.
5. [ ] Build the mock-provider harness (deterministic responses, synthetic `usage` including cache fields, configurable TTFT) — B2/B3/B5/B7 all depend on it.
6. [ ] Re-verify Gemini's context-caching TTL and pricing against `ai.google.dev` directly, and vLLM's Automatic Prefix Caching defaults from source, before either is relied on in the provider matrix.
7. [ ] Add the RAM-budget/LRU-unload design to ADR-006 with the numbers from `KNOWN-ISSUES.md:57-62` and `lib/runtime-scheduler.js:21-22` as the starting bounds, and wire B10 to it.
8. [ ] Record C1 (pi's dissent) in `docs/assumptions.md` as an open tension so it is re-examined when model cache minimums next change.
