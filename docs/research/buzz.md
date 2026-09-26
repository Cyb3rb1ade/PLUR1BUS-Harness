Status: research note, 2026-09-26, owner request.

# block/buzz: harness catalog, persona/agent, MCP-over-ACP

Source: `block/buzz`, Apache-2.0, commit `02c6309`, cloned read-only at
`/tmp/claude-0/ref/buzz`. Paths below are relative to that repo root. Owner
prompt (2026-09-26): "schau Dir mal den Desktop-Client von block/buzz an –
hier ist die Verkettung ACP↔MCP bzw. Harness-Model-Agent-Persona ziemlich
gut gelungen. Vielleicht auch eine Inspiration für uns?"

## What buzz is, and the chain

A desktop app (Tauri + Rust) that runs AI "agents" as managed local
processes, gives them Nostr relay identities for control/telemetry and
multi-owner reach, and drives external coding-agent CLIs as ACP subprocesses.
Roughly our harness role: process supervision, persona/config management, a
capability catalog, protocol plumbing — not the coding agent itself. Desktop
never speaks ACP: per agent identity it spawns one `buzz-acp` process (the
ACP client), and control/telemetry between desktop and `buzz-acp` go over the
Nostr relay (NIP-AO), not local IPC. `buzz-acp` spawns the runtime:
`claude-agent-acp`, `codex-acp`, `goose acp`, the in-house `buzz-agent`,
tier-2 presets baked into the binary (`openclaw`, `hermes-acp`, `opencode`,
`kimi`, `pi`, `devin`, `cursor`, `omp`, `grok`, `amp` —
`discovery/presets.rs`), or a custom JSON harness from
`<app-data>/custom_harnesses/` (`custom_harnesses.rs`, stripped of
install-command and avatar-URL power).

## Data model

**Single harness capability catalog.** `KnownAcpRuntime`
(`discovery/runtime_metadata.rs`) is the one source of truth per built-in
runtime: commands/aliases, install commands, model/provider env keys, a
thinking-effort contract, `skill_dir`, `config_file_path`, `auth_probe_args`.
Presets and custom harnesses use slimmer structs built the same way; all
three project into one `AcpRuntimeCatalogEntry` over IPC.
`desktop/src/features/agents/AGENTS.md` states the rule: "harness capability
facts have exactly one source: the Rust runtime catalog," "no hardcoded
harness-ID checks in render code," field absence gets a *named reason*
(`ownedByModelId`), never a `showX` boolean. `harness_max_parallelism`
(keyed by static command string) is a second, narrower source, projected the
same way.

**Persona → agent instance.** `AgentDefinition` (`managed_agents/types.rs`)
is the blueprint (prompt, runtime, model, provider, env, avatar, name pool,
`respond_to`, `session_policy`). `ManagedAgentRecord` is the 1:n running
instance, own key, may pin its own harness/model, carries a
`persona_content_hash` snapshot. `runtime.rs` recomputes the hash and
compares it to the pinned one to detect drift, driving a restart-when-idle
instead of live unsafe reconfiguration mid-turn.

**Resolver with provenance.** `resolve_effective_config`
(`effective_config/mod.rs`) returns `ResolvedField<T> { value, source }`
(`model`, `provider`, `system_prompt`; source = `Definition | Global |
InstanceLegacy`) — the one function both UI and spawn call, so nothing
computes "what does this agent actually run" a second way.

## MCP / ACP mechanics

MCP servers ride the ACP `session/new` `mcpServers` array (`McpServer {
name, command, args, env }`, `crates/buzz-acp/src/acp.rs`, matching the ACP
`McpServerStdio` schema). `build_mcp_servers` (`buzz-acp/src/lib.rs`) builds
exactly **one** server per session from a single global `config.mcp_command`,
injecting the process's relay URL and signing key.
`pool.rs::mcp_servers_with_git_origin` adds one per-session env var for
commit attribution — narrow, not a general session-scoped config mechanism.
`crates/buzz-persona/PERSONA_PACK_SPEC.md` §7 documents a richer design —
pack-level `.mcp.json` merged with per-persona `mcp_servers` frontmatter,
stdio and streamable_http transports, SSE rejected — but `build_mcp_servers`
never implements that merge: per-persona MCP is **documented but not wired
into buzz-acp**. A real gap, not a model to copy structurally — but the
spec's shape (pack + persona merged before `session/new`) is what our
D25/D17 already need.

**Session scoping.** `SessionScope` (`scope.rs`) is `Conversation |
Thread(channel_id, canonical_root)`, derived once from policy and thread
tags, never re-inferred from the last event. Each scope selects one of three
prompt fragments (`session_model_task.md`, `_thread.md`, `_channel.md`)
telling the model explicitly "you are one session of this agent."

**Owner observer/control channel.** `observer.rs` is an in-process broadcast
bus capturing raw ACP JSON-RPC traffic and turn events, republished as
encrypted Nostr frames per NIP-AO (kind 24200, ephemeral, relays MUST NOT
persist). The same channel carries owner control (cancel, model switch) back
down. `cancel_with_cleanup`/`_grace` (`acp.rs`) send `session/cancel`, then
keep reading until `stopReason: "cancelled"`, bounding a grace deadline
distinct from a natural turn timeout so Stop can't hang on a stuck adapter.

**Per-harness system-prompt transport.** `session_new_full` (`acp.rs`,
~684-741) dispatches the system prompt three ways per adapter: a bare
`systemPrompt` field (buzz-agent), `_meta.systemPrompt` as replacement text
(Buzz's `pi-acp` fork), or `_meta.systemPrompt: {"append": text}` for
claude-agent-acp, preserving Claude's native preset instead of replacing it.

## Engrams

NIP-AE defines `kind:30174` addressable, NIP-44 encrypted memory events per
`(agent, owner)` pair, a reserved `core` slug plus arbitrary `memory`
entries. `engram_fetch.rs::build_core_section` fetches the core engram once
at session start, rendered as a `<core-memory>` block. Discipline: a fetch
error is **not** "no core" — `Ok(None)` only on relay-confirmed empty
results; any ambiguous/unreadable state emits no section at all, never the
onboarding nudge, so a relay outage is never mistaken for absent identity.

## What we adopt

1. **One typed harness catalog** (`KnownAcpRuntime` + the AGENTS.md rule) →
   ADR-011 / D21: CLI, GUI and command router render from one core-owned
   catalog (commands, model/provider/effort keys, auth probe, skill dir,
   parallelism, MCP capability), never a second copy.
2. **Persona = blueprint, agent = instance, drift → restart when idle** →
   extends D13 for M2: an instance inherits a persona but may override
   harness/model (D30's tier list); a persona edit restarts when idle
   instead of diverging silently.
3. **One resolver returning a source** (`ResolvedField<T>`) → D29's
   transparency and `config get --json`: spawn, UI and CLI agree by
   construction, from one pure function.
4. **MCP over ACP `session/new`, both directions** confirms the mechanics
   D17/D25 assume; the unwired persona-level merge is a cautionary example —
   our merge (global + persona + channel) must actually reach the session.
5. **`SessionScope` as the single session key, with a self-aware prompt** →
   D21: one active session per Telegram chat vs. several parallel sessions
   in chat/GUI both need the scope decided once, and the model told which.
6. **Observer/control stream mapped to typed events** → ADR-016's events and
   D21's `/stop`/`/model`: control rides the same typed channel as
   telemetry, never a side-channel CLI call.
7. **Per-harness system-prompt transport table** → our ACP outbound lane
   (D25) needs a per-runtime prompt-delivery table from day one; append vs.
   replace is a correctness difference, not style.

Bonus for our memory layer (E1/E2, D31): NIP-AE's fetch-error ≠
confirmed-empty rule for `core` is the discipline a recall failure needs —
never indistinguishable from "no memory exists."

## What we reject, and why

- **Blanket `allow_once` auto-approval** (`handle_permission_request`) —
  fine for a trusted single-owner desktop app; opposite of D21/D24, where
  side effects route through the human's own channel.
- **Env-var-only configuration** — model/provider/effort as env vars, no
  live reconfiguration, any change needs a respawn. D29/D30 need live,
  typed config with per-key `x-restart` classification.
- **CLI-side-effect replies instead of the ACP stream** — some preset/custom
  harnesses have no structured response channel back through ACP. Our
  harness/model/agent boundary should not accept a runtime that can't speak
  back through the protocol — it would break event provenance (ADR-016).
- **Relay-as-only-bus** — even desktop talking to its own locally-spawned
  `buzz-acp` goes over the relay network, making relay availability a hard
  dependency for purely local control. We keep local control on the local
  RPC transport (UDS/named pipe, D6), relay/remote (M3) only when wanted.
- **Legacy sprawl** — vestigial "will be removed" fields, an
  `InstanceLegacy` resolver branch, named-absence reasons papering over
  migrations. D26's explicit deprecation windows are meant to keep us from
  accumulating the same scar tissue.

## File index

| Path | What |
|---|---|
| `desktop/src-tauri/src/managed_agents/discovery/runtime_metadata.rs` | `KnownAcpRuntime` catalog struct |
| `desktop/src-tauri/src/managed_agents/discovery/catalog.rs` | Built-in runtimes (goose, claude, codex, buzz-agent) |
| `desktop/src-tauri/src/managed_agents/discovery/presets.rs` | Tier-2 presets (openclaw, hermes-acp, opencode, kimi, …) |
| `desktop/src-tauri/src/managed_agents/custom_harnesses.rs` | User JSON harness loader |
| `desktop/src/features/agents/AGENTS.md` | Contributor rule: catalog is the one capability source |
| `desktop/src-tauri/src/managed_agents/types.rs` | `AgentDefinition`, `ManagedAgentRecord` |
| `desktop/src-tauri/src/managed_agents/persona_events.rs` | `persona_content_hash` |
| `desktop/src-tauri/src/managed_agents/runtime.rs` | Drift detection → restart when idle |
| `desktop/src-tauri/src/managed_agents/effective_config/mod.rs` | `resolve_effective_config`, `ResolvedField<T>` |
| `crates/buzz-acp/src/acp.rs` | `McpServer`, `session_new_full`, `handle_permission_request`, `cancel_with_cleanup*` |
| `crates/buzz-acp/src/lib.rs` | `build_mcp_servers` |
| `crates/buzz-acp/src/pool.rs` | `mcp_servers_with_git_origin` |
| `crates/buzz-persona/PERSONA_PACK_SPEC.md` §7 | Documented but unwired per-persona MCP merge |
| `crates/buzz-acp/src/scope.rs` | `SessionScope::{Conversation, Thread}` |
| `crates/buzz-acp/src/observer.rs` | In-process observer bus |
| `docs/nips/NIP-AO.md` | Agent Observability (kind 24200) |
| `docs/nips/NIP-AE.md` | Agent Engrams (kind 30174) |
| `crates/buzz-acp/src/engram_fetch.rs` | `build_core_section`, fetch-error discipline |
