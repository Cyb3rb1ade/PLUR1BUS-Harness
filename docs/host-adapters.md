# Host adapters: attaching external agentic systems to the harness's memory

**Status:** Draft (2026-09-25, D28) · **Owner:** Christian · **Companion:** spec D22 (setting), D24 (one human across channels), D25 (ACP/MCP both ways), D28 (one harness, both roles); ADR-008 (protocols); ADR-016 (API stability).

The harness is the memory. An external agentic system never brings its own engine against the harness's store (T7); it attaches through one of the tiers below and talks to the same agent, with the same memories, in parallel with every other attached system and with the harness's own channels.

## The tiers

| Tier | Mechanism | Recall/capture | Host code | Milestone |
|---|---|---|---|---|
| **0 — memory proxy** | The harness exposes an OpenAI-compatible chat endpoint (later also the Anthropic Messages shape). Before the model call it injects the recall blocks; after the reply it captures the turn. The API key is bound to `{ agentId, person, channel }`, so the principal (D22/D24) is exact. Streaming and tool calls pass through; model and cost stay the user's. | automatic | none (set a base URL) | M3 (HTTP API) |
| **1 — memory-provider plugin** | The host has an exclusive memory slot filled by a plugin; the plugin implements the host's provider interface and forwards every hook to the harness over MCP or RPC. No engine, no database, no models in the plugin. | automatic | 400–600 lines per host | after 2b |
| **2 — turn hooks / filters** | The host offers pre-/post-turn hooks without a memory slot; a small filter calls recall before and capture after. | automatic | 100–200 lines | after 2b |
| **3 — MCP tools only** | The harness's MCP server (2b) exposes `memory_recall`, `memory_store` and the D21 operations; the agent calls them itself, steered by a system-prompt snippet we publish. | agent-driven, less reliable | none | 2b |

Every tier builds on one **client kit**: `@plur1bus/memory-client` (TypeScript) and `plur1bus-memory-client` (Python) — recall/capture pair, principal construction, the D22 setting, reconnect, the ADR-016 capability check. An adapter maps host hooks onto the kit and nothing else.

## Host matrix

Evidence levels: **verified 2026-09-25** (read at the cited source today), **knowledge (≤ 2026-06)** (from training, re-check before implementing), **open** (unknown).

| Host | Tier | What we know | Evidence | Notes |
|---|---|---|---|---|
| OpenClaw | 1 | `agents.*.memorySlot` selects one plugin; the plugin calls `registerMemoryCapability({ runtime, … })` and hooks `before_agent_start`, `agent_end`, `before_compaction`. | verified (local checkout `b9421f4`, `src/plugin-sdk/memory-host-core.ts`, `src/plugins/hook-types.ts`) | Today's PLUR1BUS plugin fills this slot with an embedded engine; the thin plugin fills it with kit calls. |
| NemoClaw (NVIDIA) | 1 (same plugin as OpenClaw) | Runs standard OpenClaw plugins, baked into a version-matched runtime image (`openclaw plugins install` at image build); network egress needs a sandbox policy preset per hostname. | verified ([NVIDIA docs](https://docs.nvidia.com/nemoclaw/user-guide/openclaw/manage-sandboxes/install-openclaw-plugins)) | The thin plugin needs an egress preset for the harness host; the harness is usually outside the sandbox. |
| Hermes | 1 | `memory.provider` selects exactly one external provider; a plugin under `plugins/memory/<name>/` implements `MemoryProvider` (`initialize`, `system_prompt_block`, `prefetch`, `sync_turn`, `get_tool_schemas`/`handle_tool_call`, `on_pre_compress`, `on_session_end`, …). Supermemory, Mem0, Honcho, Hindsight are shipped this way, each a thin client of a remote service. | verified (local checkout `743ee72`, `agent/memory_provider.py`, `plugins/memory/*`) | A Python provider, new work; `on_pre_compress` maps to a `compaction` checkpoint. |
| ZeroClaw | 1 or 0 | Rust; plugins are WASM (`wasm32-wasip2`, deny-by-default); the memory provider is a pluggable trait selected in `config.toml`; does not run OpenClaw plugins; imports OpenClaw setups; talks to OpenAI-compatible endpoints. | verified ([zeroclaw.net](https://zeroclaw.net/)) | **Open:** whether a memory provider can be a WASM plugin or must be compiled in. Tier 0 works regardless. |
| NanoClaw | 3 (+ 0 via the Anthropic shape) | Claude Agent SDK in containers; per-agent `CLAUDE.md` memory, not pluggable; MCP servers supported. | verified ([GitHub](https://github.com/nanocoai/nanoclaw)) | Tier 0 needs the Anthropic Messages proxy shape (`ANTHROPIC_BASE_URL`). |
| Nanobot (HKUDS) | 3 or 0 | Python; file-based memory (`MEMORY.md`, `history.jsonl`, `SOUL.md`/`USER.md`), no provider abstraction; a `Consolidator` with before/after hooks; MCP registry; OpenAI-compatible providers. | verified ([memory.py](https://github.com/HKUDS/nanobot/blob/main/nanobot/agent/memory.py)) | Tier 0 is the natural fit; a small upstream PR could add a provider seam (tier 1). |
| Open WebUI | 2 (+ 0, 3) | Filter functions (Python) with `inlet`/`outlet` around every turn; native MCP; a built-in, non-pluggable Memory feature; OpenAI-compatible backends. | knowledge (≤ 2026-06) | Re-check the filter API version before implementing. |
| LibreChat | 3 or 0 | MCP servers and agents; a built-in memory feature (not pluggable); OpenAI-compatible custom endpoints. | knowledge (≤ 2026-06) | Tier 0 via a custom endpoint. |
| Jan | 3 or 0 | Local-model desktop app with MCP support; OpenAI-compatible providers. | knowledge (≤ 2026-06) | Tier 0 via provider base URL. |
| Claude Code, Codex, OpenCode, Gemini CLI, Cursor … | 3 (memory) + ACP (control) | MCP clients; driven as agents over ACP (ADR-011). | ADR-011 | Memory through MCP tools; the harness drives them, not the other way round. |

## Rules for every adapter

1. **No engine in the host.** The adapter holds no store, no model, no journal; if the harness is unreachable it reports degraded to the host and drops nothing silently (a capture is retried through the kit's journal on the host side only if the host allows local files).
2. **Principal, not guesswork.** The adapter passes the host's user, chat and setting (D22) explicitly; the harness derives the person (D24). Sensitive content follows D22 regardless of the host.
3. **One agent per binding.** A binding (API key or plugin config) names exactly one `agentId`; several hosts may bind the same agent.
4. **Stability.** Adapters consume only `stable` surfaces (ADR-016); a host-API change breaks the adapter, never the harness.
5. **Parity.** Tier-1 adapters for OpenClaw and Hermes are the plugin's successors; `docs/plugin-parity.md` decides what a host adapter must still cover.

## Sequence

1. 2b: MCP server with `memory_recall`/`memory_store`, the D21 operations, per-agent authorisation — tier 3 for every MCP client.
2. M3: HTTP API with the memory proxy (OpenAI shape first, Anthropic shape second) and the two client kits — tier 0 and the base for tiers 1–2.
3. Then, ordered by demand: thin OpenClaw plugin (also NemoClaw), Hermes `MemoryProvider`, Open WebUI filter, ZeroClaw provider once the WASM question is answered.
