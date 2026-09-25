# M1b-2a — Core daemon, supervisor and CLI: design

**Status:** Draft rev 2 for owner review · **Date:** 2026-09-24 · **Owner:** Christian (Cyb3rb1ade) · **Milestone:** M1b-2a (first of M1b-2a → M1b-2b → M1b-3 → M1b-2c, owner order 2026-09-24) · **Inputs:** ADR-001, ADR-002, ADR-004, ADR-006, ADR-008, ADR-009, ADR-010 · `docs/milestones.md` §M1 · `docs/platform-matrix.md` §5, §7 · `docs/superpowers/specs/2026-09-23-m1b-1-engine-api-design.md` · engine contract `types/engine.d.ts` 1.4.1 (`openclaw-plur1bus-memory` PR #186) · Cobot architecture analysis · owner decisions of 2026-09-24 (recorded in §2, D1–D20).

## 1. Goal

The harness becomes the engine's native host. After M1b-2a a person installs `plur1bus` with one command, a resident core process holds the PLUR1BUS engine, a thin CLI talks to it over a local socket, a fact captured in one session is recalled in a later one with rerank, a killed core or supervisor never blocks a command, a configuration change restarts only what it must, and an agent on the machine can operate and repair the installation from a shipped skill. No LLM provider, no chat turn, no MCP, no GUI yet — those are M2, M1b-2c, M1b-2b and M3.

Success is milestone M1 acceptance 1 (two-session recall with rerank), 3 (kill soak, 0 blocked turns, degraded state visible), 5 (T7: one core process, one LanceDB/ONNX handle), 11 (B1 `--help` p95 < 100 ms, B8 core ready < 3 s / < 15 s with model), plus the M1b-2a-specific criteria in §10.

## 2. Owner decisions carried in (2026-09-24)

| # | Decision | Owner words / context |
|---|---|---|
| D1 | M1b-2 is cut into 2a (core + supervisor + CLI), 2b (MCP transport; its ADR is ADR-014, not ADR-012), 2c (session store + submit/event turn loop + compaction), executed **2a → 2b → M1b-3 → 2c**. | "Gewissenhaftigkeit ist besser als Geschwindigkeit." |
| D2 | Engine is consumed as an **npm prerelease pinned exactly** (`@cyb3rb1ade/plur1bus-memory@7.16.0-engine.N`, dist-tag `engine`), published by a **publish-on-tag workflow** in the PLUR1BUS repo (`NPM_TOKEN` as repo secret, set by the owner). Local development may use a `link:` override that never enters a lockfile. | "ja, das ist gut." |
| D3 | **Modules, internal APIs, no monolith.** Every unit is a package with a versioned, typed interface; add-ons hang only on those interfaces; an updater must be able to replace units without touching foreign internals; **individual modules restart without restarting the whole**; a config change restarts only what it must. | "alles in Module … viel mit APIs … Updater … Drittanbieter-Add-ons"; "kein Monolith"; "Config-Änderung ohne dass man die ganzen Prozesse neu startet." |
| D4 | **Operations skill** ships with the harness so agents can configure, debug and repair it themselves. | "Skill … damit die Agenten den Harness selber warten können." |
| D5 | State root `~/.plur1bus/` (POSIX), `%LOCALAPPDATA%\PLUR1BUS` (Windows, per-user, no admin), overridable by `PLUR1BUS_HOME`; one `config.json` with `$schema` and `schemaVersion`. `%ProgramData%\PLUR1BUS` is reserved for the machine-wide service install (M8). | "Local App Data wäre natürlich auch vollkommen in Ordnung." |
| D6 | Process model **B**: supervisor + core + module processes (§4). | Owner asked for the A/B/C trade-off (recorded in ADR-012) and accepted B. |
| D7 | **Rust** for CLI, supervisor, installer, updater; **TypeScript** for the core and every SDK-bound module; **JSON Schema** as the single source of RPC types, generated into both languages. ADR-001's "single-stack" wording is amended by ADR-012. | "Wenn du jetzt entscheiden müsstest …" → owner accepted the recommendation. |
| D8 | Targets: **macOS arm64, Linux x64/arm64, Windows x64/arm64**. darwin-x64 is dropped. Owner holds an Apple Developer account (signing + notarisation in CI); Windows signing is an M8 item (SignPath Foundation proposed). | "macOS 64-Bit spielt gar keine Rolle mehr." |
| D9 | **No OpenClaw idiom crosses the engine boundary into the harness.** Where the engine offers only an OpenClaw-shaped path, the engine gets a real API and the adapter becomes its consumer. Modules that would only work as an emulation are rewritten. | "nicht so wirken, als hätten wir … eine OpenClaw-Emulationsschicht gebaut … Wenn wir dann ein Modul neu schreiben müssen, dann müssen wir ein Modul neu schreiben." |
| D10 | Activity states per agent (`recalling`, `dreaming`, later `thinking`, `replying`) are a **separate layer** from process health; they never drive restarts. | Owner proposal, accepted with the separation. |
| D11 | Children **reconnect instead of respawn** when a parent returns within a grace window (§6.4). | "dass das Kind nicht neu gespawnt werden muss." |
| D12 | The diagnostic/repair command is **`1staid`** with `check` and `repair` subcommands. `doctor` is not used. | "1stAid finde ich schöner … First Aid braucht ja auch Check und Repair Optionen." |
| D13 | **Agent ≡ Persona.** An agent is one persona (Bernd, not "instance 3"). `SOUL.md`, `USER.md`, `persona-voice.md`, memory, `agentId` are one unit. Sessions (*n*), model roles (*n*), users (*n*) are separate dimensions. | "ich meine Persona." |
| D14 | **Module manifest** gains `provides`, `consumes`, `implements`, `extensionPoints`, `scope: installation\|agent`, `priority`. **Priority bands** are 100-wide: 0–99 Foundation, 100–199 Core services, 200–299 Services, 300–399 Aggregators, 400–499 Orchestration, 500–999 Add-ons. A `module graph` command visualises the dependency tree. | "jeder Bereich sollte mindestens 25 Slots breit sein" (→ 100 for headroom). |
| D15 | **Provider profiles** (M2): `{ vendor, lane: "api"\|"cli", kind: "llm"\|"embedding"\|"rerank"\|"asr"\|"tts"\|"nmt", transport: "rest"\|"grpc"\|"stdio", account, credentialRef, baseUrl, headers, metadata, models, quotas }`. Multiple profiles per vendor. API lane = user's own key or OAuth; CLI lane = official CLI as agent via ACP/stdio. ~18 coding CLIs supported. 2a reserves the config shape and the model role `decision`. | "CLI und API — wie besprochen." |
| D20 | **NVIDIA Riva / NIM speech** must work, hosted and self-hosted. Hosted: gRPC `grpc.nvcf.nvidia.com:443` (TLS, metadata `function-id` selects the model, `authorization: Bearer nvapi-…`); LLM/embedding NIMs of the same platform via the OpenAI-compatible REST endpoint `integrate.api.nvidia.com/v1` with the same key. Self-hosted: Riva/NIM container, gRPC `:50051`, same protos (`nvidia.riva`: `RivaSpeechRecognition.Recognize\|StreamingRecognize`, `Health`). Protos vendored from `nvidia-riva/common` (licence checked at plan time), generated with `@grpc/grpc-js` + `@grpc/proto-loader` inside a `speech` module (`scope: installation`, `provides: ["asr","tts"]`), never in the core. One vendor, one key, several lanes — which is why D15 carries `kind` and `transport`. Lands with providers (M2, ASR/TTS profiles) and voice channels (M4). | Owner PS 2026-09-24. |
| D21 | **Channel-neutral command layer in the harness.** A message starting with `/` never reaches the LLM: a command router in front of the turn loop maps it onto the same RPC methods the CLI uses (one implementation; CLI, chat channels and GUI only render differently). Mapping: `/status`, `/health` → `core.status`, `agent.status`, `1staid check` (2a); `/forget`, `/correct`, `/memory` … → `memory.*` (E1 + harness side); `/new`, `/sessions`, `/resume`, `/compact` → `session.*` (2c); `/model` → model-role change (M2); Telegram/Discord as channels (M4). In a channel with a single conversation (a Telegram chat) there is one active session per chat; `/new` closes it with a `session-end` checkpoint and opens the next; several parallel sessions per agent are the normal case in the chat module and GUI (D13). | Owner 2026-09-25: "gerade unter Telegram wichtig, weil da gibt es ja nur ein Gespräch." |
| D22 | **Conversation setting drives recall balance and sensitivity.** The setting of a turn is `Principal.chat.kind` (+ chat id), independent of `AgentContext.origin` (who triggered it; a group message is `origin: "user"`, `chat.kind: "group"`). Capture stamps every memory with its setting from the `Principal` on the typed path (no session-key or text heuristic): channel, `chat.kind`, the chat id (Telegram `chat.id`, Discord `guild_id`/`channel_id`) and, for forum topics/threads, the thread id (Telegram `message_thread_id`); ids are stored, display names are resolved at render time. It also classifies each memory sensitive or not. Setting model (channel-neutral, WhatsApp/Matrix/Discord/Telegram alike): `chat = { channel, id, kind: direct|group|broadcast (determined per message from the humans present, not a sticky label — a Matrix DM a third person joins is a group), container?: { kind: guild|space|community|workspace, id }, thread?: { id }, participants?, encrypted?, bridgedFrom?: { channel, id } (a bridged room is one conversation, never stored twice) }`. Recall never excludes by setting. **Knowledge and experience** (facts about products, technologies, how-tos; the engine's knowledge/canonical memories) are setting-neutral and carry full weight everywhere — that is the agent's expertise. **Personal and episodic** memories follow proximity: same thread > same chat > same container > same kind > the rest (private ↔ group, group A ↔ group B), with configurable weights. **Sensitive memories are recalled only in a private conversation with the human they belong to** and are filtered out (not down-ranked) in groups; an unknown setting counts as a group (fail-closed). Engine PR E7. | Owner 2026-09-25: "gerne dürfen im persönlichen Chat auch Gruppenerinnerungen gerecallt werden … Aber die Priorisierung muss eben eine andere sein. Und sensible Informationen dürfen natürlich nur im privaten Gespräch gerecallt werden." |
| D23 | **Progressive compaction.** Above a soft threshold of the context window (default 65 %) a background job summarises the oldest history segment into a ready summary without touching the transcript (history is append-only, so the summary cannot go stale); above the hard threshold (default 88 %) the segment is swapped for the prepared summary at once, so a turn never waits on a compaction LLM call. `/compact` stays as the manual trigger. Cuts only at turn boundaries (a tool call and its result are never separated); older summaries may be summarised again (tiered). Every swap is preceded by an engine checkpoint `compaction` so facts from the dropped segment reach long-term memory. Swaps happen in large, rare blocks to respect the prompt-cache zones (§3). The background job uses its own cheap model role `summarize` (M2) with a budget and breaker. Lands in 2c. | Owner 2026-09-25: "dass wir zwar hart kompaktieren können, aber zum Ende des Context-Windows im Hintergrund schon die Informationen am Beginn … vor-kompaktiert werden." |
| D24 | **One human across channels.** The harness keeps a person registry (the users dimension, D13/M2); each person links channel identities (Telegram, Discord, WhatsApp, Matrix, …) **only by proof**: `/link` in a private chat on one channel yields a short-lived one-time code that is sent back by `/link <code>` in a private chat on the other, or the owner links via CLI with the same code confirmation. Never by display name, avatar or style. The user principal handed to the engine is person-level, so the agent knows it is the same human everywhere and that human's sensitive memories are recallable in any of their private chats. Memories stored under a channel identity before linking stay reachable through engine user aliases (the counterpart of `workspaceAliases`). `/unlink` at any time; every link and unlink is audit-logged; the D22 setting filter is unaffected (a linked person in a group still gets nothing sensitive). Harness: M2 with the D21 router; engine user aliases: E7. | Owner 2026-09-25: "dass man matchen kann, wo es derselbe Mensch ist. Damit Bernd in Telegram und Discord weiß, dass ich es bin." |
| D25 | **ACP and MCP, both directions.** Outbound ACP (Zed's Agent Client Protocol): the harness drives official coding CLIs as agents over stdio (the D15 CLI lane, M2). Inbound ACP: the harness is itself an ACP agent server, so an ACP editor (Zed and others) can talk to an agent such as Bernd directly; it maps onto the same RPC methods and session store as every other front end (D21), runs under the editor user's principal, and lands in M2 next to the outbound lane. MCP outbound (client) and inbound (server) per agent stay as in D17 (2b). | Owner 2026-09-25: "Wir sollten beides eingehend und ausgehend realisieren." |
| D26 | **API stability (ADR-016).** Public surfaces (RPC, module API and manifest, extension points, CLI incl. `--json`, `config.json`, slash commands and ACP/MCP server surfaces) follow semver with written additive/breaking rules; clients discover **capabilities** in the handshake instead of sniffing versions; every surface is `x-stability: experimental | stable`; a stable surface breaks only after a deprecation of at least two minor releases and six months, listed by `1staid check`; servers support the current and previous major, the supervisor loads current and previous module `apiVersion` side by side; engine events reach clients only through harness-owned schemas (replaces the verbatim `engine.event` of H1); fixtures ship as a conformance kit. The engine contract stays internal to the core. H2 implements capabilities, tiers, event mapping and the CLI `schema` field before the first module exists. | Owner 2026-09-25: "nicht ständig irgendwelche Breaking Changes … die dann den Skill- und Plugin-Entwicklern den Teppich unter den Füßen wegreißt. Und vor allem auch den Usern." |
| D27 | **PIM integration, local first.** Provider-neutral domains `pim.mail`, `pim.calendar`, `pim.contacts`, `pim.tasks`, `pim.notes` with versioned interfaces (ADR-016), implemented by modules via `provides` (D14) and exposed to agents as MCP tools (D17). **Local first:** on a Mac the `pim-apple` module talks to EventKit (calendars and reminders, including the upgraded reminders CalDAV cannot reach), the Contacts framework and AppleScript/Shortcuts (Notes, Mail) through a small Swift helper over stdio, behind the user's macOS permission prompt; EventKit and Apple Mail also see every account configured there (iCloud, Google, Exchange/Outlook, CalDAV), so no OAuth is needed for them; on the iPhone the companion app is a device node that exposes the same domains. **Cloud as fallback** for headless hosts (Linux, NAS) and for what has no local path: Microsoft Graph (Outlook/M365 mail, calendar, contacts, To Do, OneNote; classic vs. new Outlook is irrelevant, EWS is not used), Google APIs (Gmail, Calendar, People, Tasks), generic IMAP/SMTP/CalDAV/CardDAV (iCloud mail/calendar/contacts with app-specific passwords, Fastmail, Nextcloud, Exchange on-prem). Connections belong to a person (D24) and are granted per agent; OAuth via D16 templates with bring-your-own client id as the self-hosting default; PIM content is sensitive by default (D22); reads and drafts are free, sending, deleting and inviting need the user's approval unless explicitly allowed; memory ingestion is opt-in; freshness by on-demand calls plus delta sync jobs (M1b-3 scheduler), since provider webhooks need a public endpoint. Prerequisites: M2 (OAuth, secrets, persons), M3 (authenticated remote module transport with pairing for device nodes), 2b (approval/provenance for side effects). Own milestone after M2. | Owner 2026-09-25: "Bernd hätte … in meinen Apple-Kalender auf dem iPhone geschrieben … dazu braucht es ja nicht irgendwelche komischen Cloud-APIs"; "und natürlich alle Google Online-Dienste, Office 365 … die gängigen Classics." |
| D28 | **Two operating modes, one memory owner.** **Mode A, standalone:** the harness can replace OpenClaw or Hermes completely (own channels M4, agents, sessions 2c); `plur1bus import openclaw\|hermes` (M1b-3) brings agents, personas, memory and sessions over. **Mode B, central memory:** the harness is the memory service and external agentic systems (OpenClaw, Hermes, Codex, Claude Code, Cobot, …) attach to the **same agent with the same memories**; the turn runs in the external system, the harness answers recall and takes capture. Transport: the 2b MCP server (memory tools plus a recall/capture pair for turn hooks), local socket or the authenticated remote transport of M3; every connection carries a principal (agentId, person per D24, setting per D22, the external system's channel registered in the harness) and is authorised per agent. **Rule (T7):** exactly one engine owner per store — an external system never embeds its own engine against the harness's store; the existing plugin either keeps its own separate memory (as today) or becomes a thin client (hooks → harness calls, no engine), never both on one machine. **The OpenClaw plugin** stays maintained in its own repository as long as the owner wants; engine PRs keep the adapter green with fixes only, no new plugin features; the thin-client rewrite is the owner's choice, not a harness requirement (M8 PR-14 reworded accordingly). **Parity list** (`docs/plugin-parity.md`, written with M1b-3): every plugin feature (dashboard, feature crons, dreams, slash commands, Obsidian bridge, skill workshop, wiki, critical push, …) with its harness counterpart or a deliberate drop; nobody migrates a live install before it is complete. **The owner's Linux VPS stays on the plugin**; a test environment (the Ubuntu VM) proves both modes first. | Owner 2026-09-25: "sowohl eigenständig benutzen können, als auch zentrale Memory-Einheit über diverse agentische Systeme hinweg … über Plur1bus OpenAI Codex an Bernd koppeln und parallel auch OpenClaw an denselben Bernd"; "eine Migration meines LiveSystems … nicht ohne Not direkt am Anfang". |
| D16 | **OAuth 2.1 client** (M2): generic implementation with **provider templates** for every vendor that allows third-party clients (Kimi, GitHub Copilot, Gemini, Grok, etc.). The harness's own OAuth server for inbound MCP. Claude/Anthropic: no template shipped — the docs explain how a user who has their own OAuth app registration can set it up themselves. | "Trotzdem möchte ich … den Claude-OAuth-Weg baust" — built as user-facing documentation, not a shipped client template. |
| D17 | **MCP client and server per agent** (2b): `scope: installation` (shared) or `scope: agent` (private); idle timeout 15 min, tool-schema cache survives timeout; central context-window management (2c). **MCP Apps** (`ui://` resources rendered by the host): the 2b client advertises the UI extension, fetches the resource and proxies the app's tool calls under the agent's principal with the D19 provenance envelope; the sandboxed iframe renderer and postMessage bridge are an M3 GUI requirement (own module, `scope: agent`); the CLI only reports "app available". Sandbox rules go into ADR-014. | Owner requirement; MCP Apps confirmed 2026-09-24. |
| D18 | **Decision service** (M2, ADR-015): TypeSafe Jev (cloud) + Laya (local ONNX, Apache-2.0), three primitives (`Choice`, `Score`, `Noul`), 14 use cases. 2a reserves the model role `decision` and the config namespace `decision.*`. A **Laya spike** at the end of 2a checks ONNX export availability and latency on macOS arm64. | "Macht das einen Unterschied?" — no, for 2a only the reservation matters. |
| D19 | **Trust-routing provenance** (ADR-014, 2b): every cross-system message carries `{ origin: { system, agent, principal, trust }, hops, transformedBy }`. Persona-colouring is not a separate LLM call — the agent speaks through SOUL/persona-voice in the system prompt. | Owner requirement for A2A MCP forwarding. |

## 3. Non-goals

MCP server and client (2b, ADR-014; scope `installation|agent`, idle timeout 15 min with tool-schema cache, trust-routing provenance envelope — D17, D19) · session store, submit/event turn loop, compaction, central context-window management (2c) · dreaming scheduler (M1b-3) · LLM providers, secrets, provider profiles, OAuth 2.1 client with templates (M2; D15, D16; config shape and model role `decision` reserved in 2a) · speech providers (NVIDIA Riva/NIM gRPC and REST — D20; ASR/TTS profiles in M2, voice channels in M4) · decision service (M2, ADR-015; Laya spike at end of 2a — D18) · HTTP API and GUI (M3) · channels (M4) · Windows named-pipe transport in the engine's embedding IPC (PR-11; Windows runs unit + contract tests + `service install` in 2a, system tests after PR-11) · updater as a function (2a ships the manifest check and the binary layout; download-and-swap is M8) · token-efficiency levers from the owner's 2026-09-23 input (profile cache, vault de-dup, layered registry, intent slicing) — they belong to prompt assembly (2c/M2) and the MCP client (M6); 2a only keeps the block output cache-breakpoint-friendly. · Token caching zones notation (2c): `tools` (stable), `system-static` (SOUL, persona-voice — breakpoint 1), `system-session` (USER.md, trust context — breakpoint 2), `history` (breakpoint 3), `volatile` (time, memories, reminders — never cached); max 4 explicit breakpoints per Anthropic API, 20-block lookback window.

## 4. Process model (ADR-012)

```
OS service manager (launchd / systemd --user / Task Scheduler)      ← not ours
  └─ plur1bus supervise            Rust, tiny, always alive          ← ours
       ├─ core                     Node: engine, stores, models, JSON-RPC server
       └─ modules (none in 2a)     own processes, clients of the core
plur1bus <cmd>                     Rust CLI, thin client of core and supervisor
```

- **Supervisor** (`plur1bus supervise`, started by the OS service manager or `plur1bus daemon start`): owns `config.json`, the module manifest registry, spawn/monitor/restart with backoff, log rotation per child, the adoption handshake (§6.4), and its own RPC endpoint (`run/supervisor.sock` + token) for `config.*`, `module.*`, `daemon.*`. It has no heavy dependencies and no reason to crash; a supervisor crash is a first-class bug.
- **Core** (`@plur1bus/core`, one process per installation): builds `createEngine(host, config)` on the harness `HostServices`, holds LanceDB and ONNX handles (the only process that does — T7), runs the in-process embedding owner (ADR-001 C1: the loopback claim listener is not started on the harness path), serves JSON-RPC 2.0 over `run/core.sock` (POSIX, `0600`, directory `0700`) or a named pipe with a user-SID ACL (Windows), with a 32-byte token compared by `timingSafeEqual`.
- **Modules** (2a defines the shape, ships none): separate processes started by the supervisor from a manifest (D14):
  ```jsonc
  {
    "name": "mcp-host",
    "version": "0.1.0",
    "apiVersion": "1",
    "entry": "dist/index.js",
    "needs": ["core"],
    "provides": ["mcp-server", "mcp-client"],
    "consumes": ["memory", "agent"],
    "implements": ["transport"],
    "extensionPoints": {
      "on-recall-complete": "chain",   // sequential, each sees predecessor's result
      "collect-status": "collect"      // parallel, results merged
    },
    "scope": "installation",           // or "agent" — per-agent instance
    "restart": "on-failure",
    "lifeline": true,
    "priority": 200                    // 0–99 Foundation, 100–199 Core, 200–299 Services,
                                       // 300–399 Aggregators, 400–499 Orchestration, 500–999 Add-ons
  }
  ```
  They are clients of the core through `@plur1bus/module-api`. First-party (scheduler, MCP, HTTP API, channels) and third-party add-ons have the same shape; the updater and the add-on mechanism are one mechanism. `module graph` (§6.6) visualises the dependency tree from `provides`/`consumes`/`needs`.
- **CLI** (`plur1bus`): connects directly to the core for memory/agent/jobs commands and to the supervisor for config/module/daemon commands. Never spawns the core itself; if nothing is running it says so (§6.3) and offers `daemon start`.

Why B over A (single process with hot reload) and C (worker threads): ESM cannot unload, so A's "restart" leaves timers, listeners and native handles behind and a faulty add-on takes the core down; C isolates JS heaps but a native crash or OOM kills every worker, and add-ons share the process memory with secrets. B's only real cost is RAM per process (30–50 MB baseline each), mitigated by lazy module start and, later, a first-party "module host" that runs trusted small modules as workers *inside* B. Full table in ADR-012.

## 5. Repository layout and packages

Monorepo `PLUR1BUS-Harness`, two toolchains, one CI:

| Path | Language | Package | Purpose |
|---|---|---|---|
| `crates/plur1bus` | Rust | binary `plur1bus` | CLI + supervisor + installer + updater skeleton. Subcommands: `setup`, `1staid check|repair`, `agent`, `memory`, `dreams`, `config`, `module`, `daemon`, `service`, `supervise` (internal), stubs `user|model|login|channel|project|import|update|uninstall`. Every command has `--json`. |
| `crates/plur1bus-rpc` | Rust | lib | Generated RPC types (from `packages/rpc-schema`), JSON-RPC client over UDS/named pipe, token handling, reconnect. |
| `packages/rpc-schema` | JSON Schema + codegen | `@plur1bus/rpc-schema` | The single source: methods, params, results, notifications, error codes, `x-restart` classes for config keys. Generates `types.ts` and `types.rs` (`json-schema-to-typescript`, `typify`) and the contract fixtures. |
| `packages/core` | TypeScript | `@plur1bus/core` | The core process: harness `HostServices`, engine binding, RPC server, event fan-out, journal replay, activity derivation, lifeline client. |
| `packages/module-api` | TypeScript | `@plur1bus/module-api` | Manifest schema, core client with reconnect, lifeline client, state reporting. Used by every module, first- or third-party. |
| `packages/config-schema` | JSON Schema | `@plur1bus/config-schema` | `config.json` schema with `x-restart` per key, migrations `vN → vN+1`. Consumed by the supervisor (validation, diff) and the CLI (`config set` preview). Reserves namespaces `providers.*` (D15), `oauth.*` (D16), `decision.*` (D18) and model role `decision` for M2. |
| `skills/plur1bus-harness` | Markdown | — | The operations skill (§9). |
| `tests/system` | TypeScript + shell | — | Stack-level tests: two-session recall, kill soak, config restart classes, T7. |
| `docs/` | — | — | ADR-012 (process model and languages), ADR-013 (configuration and restart classes), generated `docs/rpc.md` and `docs/cli.md`, `docs/operations.md`, `docs/config-engine-keys.md`, `docs/module-guide.md` (manifest fields, README convention, `AGENTS.md` for each module — D14). ADR-014 (MCP host adapter, trust-routing provenance — D19) is written in 2b. ADR-015 (decision service) is written in M2. |

Package manager `pnpm` (workspaces); Rust workspace with `cargo-zigbuild` for the five targets; TypeScript built once (`esbuild`, ESM, Node ≥ 24.16). Test runners: `cargo test`, `node:test` (as in the engine; no second JS framework).

## 6. Design

### 6.1 State root and configuration (ADR-013)

```
~/.plur1bus/                      %LOCALAPPDATA%\PLUR1BUS\        (PLUR1BUS_HOME overrides)
  config.json                     $schema, schemaVersion, harness keys, "engine": { … }
  config.json.bak-<schemaVersion> written by every migration
  state/                          engine stateDir; per-agent stores; core.lock
  state/journal/<agentId>.jsonl   captures written while the core was unavailable
  agents/<agentId>/               one directory per persona (D13: agent ≡ persona)
    SOUL.md                        persona definition (identity, values, voice)
    USER.md                        owner/user context
    persona-voice.md               idiolect (managed block, seed + learned bullets)
    workspace/                     workspace dir handed to the engine
  run/                            core.sock core.token core.pid supervisor.sock supervisor.token supervisor.pid module-<name>.lock   (0700 / user-SID ACL)
  logs/<role>.log                 JSON lines, rotated by size (default 20 MB × 5)
  runtime/node-<version>/         pinned Node runtime installed by `setup` (SHA-256-verified)
  models/                         local model cache (engine-managed)
  modules/<name>/                 installed modules (manifest + payload)
  skills/plur1bus-harness/        the operations skill, copied by `setup`
```

- **One owner.** The supervisor owns `config.json`. It exposes `config.get|set|watch`; core and modules load their configuration from it at start and subscribe to `config.changed`. Direct file edits are detected by a watcher, validated, and treated like a `set`; an invalid edit is rejected with the reason and the file left untouched (the running configuration stays the last valid one).
- **Every key carries `x-restart`** in `config-schema`: `live` (log level, budgets, timeouts, rerank choice; from M2 provider profiles and keys), `module:<name>` (restarts that module only), `core` (embedding identity, `stateDir`, and every engine key the engine reads in `createEngine()`). `config set` shows the consequence before applying ("changes `mcp.port` → restarts module mcp, ~1 s") and applies after confirmation or `--yes`. `config set --dry-run` prints the plan only.
- **Apply sequence:** validate → write atomically (temp + `rename`, backup) → emit `config.changed { diff, restartPlan }` → subscribers apply `live` keys themselves → supervisor executes the restart plan in dependency order (modules before core when both are affected, core first when modules depend on the new core state) → report result and duration.
- **Engine key inventory.** A companion table `docs/config-engine-keys.md` (produced by the implementation plan's first documentation task) classifies each of the 54 engine keys as `live` or `core`; the harness cannot make a construction-time key live without an engine change. Which keys should become live is an engine follow-up (`mutateConfig` is the seam), out of 2a.
- **Naming:** harness keys use harness language (`memory.recall.softBudgetMs`, not `recall.globalInjectMaxChars`). Until engine PR E5 (§7) lands, `packages/core/src/engine-config.ts` is the single, clearly marked translation to the engine's current key names.

### 6.2 RPC contract (`packages/rpc-schema`)

JSON-RPC 2.0, newline-delimited over the socket, one connection per client, notifications on the same connection for subscriptions. Every response envelope carries `contract` (engine contract version, 1.4.1 today, 2.0 after E6) and `rpc` (schema version). A client that sees an unknown major refuses with `E_RPC_VERSION` instead of guessing.

Core methods: `core.status`, `core.shutdown`, `memory.recall`, `memory.capture`, `memory.checkpoint`, `memory.list|show|forget|correct|share|state` (via E1's `MemoryOps`; before E1 these return `E_NOT_AVAILABLE` with `reason: "engine-pr-E1"` — never a string-command emulation), `agent.list|open|close|status`, `jobs.list|run|history`, `events.subscribe|unsubscribe`.

Supervisor methods: `config.get|set|watch`, `module.list|start|stop|restart`, `daemon.status`, `daemon.stop`, `daemon.adopt` (internal, §6.4).

Notifications: `core.state`, `module.state`, `agent.activity`, `config.changed`, and every engine event (`recall.degraded`, `recall.block-clipped|dropped`, `recall.completed`, `job.run`, `dream.completed`, `acl.denied`, `embedding.identity.changed`) forwarded verbatim with `{ agentId, … }`.

Error codes are a closed enum (`E_UNAUTHORIZED`, `E_RPC_VERSION`, `E_NOT_AVAILABLE`, `E_CORE_UNAVAILABLE`, `E_INVALID_PARAMS`, `E_AGENT_UNKNOWN`, `E_CONFIG_INVALID`, `E_MODULE_UNKNOWN`, `E_INTERNAL`); a method never invents a new one without a schema change. Contract fixtures: for every method one valid request/response pair, every error code once, every notification once; both the Rust client and the TypeScript server are tested against the same fixture files.

**Principal on the CLI path.** Socket permissions plus the token authenticate the caller; that is `trust: "proved"`. `channel: "cli"`, `accountId: <hostname>`, `userId: <OS user name>`, from which the engine derives `user:v1:sha256(…)`. Workspace `workspace-dir:v1:<agents/<id>/workspace>` (case- and separator-normalised on Windows before hashing). `origin: "user"`, `background: false`, `incognito: false` set explicitly — the engine fails closed on anything else. There is no ticket and no session-key parsing anywhere on this path.

### 6.3 Core: harness host and engine binding

`packages/core/src/host.ts` implements `HostServices` (1.4.1; 2.0 after E6):

| Member | Harness implementation |
|---|---|
| `logger` | JSON lines to `logs/core.log` with level, role, agentId, requestId |
| `stateDir` | `<root>/state` |
| `configPath()` / `config()` | from the supervisor snapshot; `mutateConfig` forwards to `config.set` |
| `routing` | **absent**; the CLI supplies the principal, the engine needs no session parsers |
| `pathOverrides` | absent (after E6 the member is gone) |
| `workspaceDir(agentId)` | `<root>/agents/<agentId>/workspace`, created by `agent create` |
| `llm`, `secrets`, `runtime` | absent / `null` in 2a (M2) |
| `events.emit` | fan-out to `events.subscribe` clients |
| `platform` | own implementation of `securePath`, `ipcAddress`, `isUnsafeLink`, `canonicalIdentityPath` with Windows branches |
| `clock` | `Date.now` (tests inject) |

**Agent ≡ Persona (D13).** An agent directory (`agents/<agentId>/`) is a persona: it holds `SOUL.md` (identity, values, voice), `USER.md` (owner/user context), `persona-voice.md` (idiolect — managed block between markers, seed + learned bullets, directive built only from managed block), and `workspace/` (the engine's `workspaceDir`). `agent create <id>` scaffolds the directory with template files; the engine reads persona-voice from the workspace at construction. Sessions, model roles and users are separate dimensions attached to the agent, not identity-defining.

Engine configuration in 2a: `autoRecall` and `autoCapture` off (the harness calls explicitly), rerank on, embedding per ADR-006 (`setup` non-interactive → E5-small; interactive → the use-class question; NC licence only with explicit confirmation, audit-logged).

Lifecycle: `core` starts → loads config from supervisor → `createEngine` → replays `state/journal/*.jsonl` (each line a `TurnRecord` minus signal; success deletes the line, failure keeps it and logs) → opens the socket → reports `ready` on the lifeline handshake. Models warm in the background; `core.status.degraded = { reason: "models-warming" }` until they are ready, recall answers lexically-degraded meanwhile (engine behaviour). Shutdown: lifeline EOF past grace, `core.shutdown`, or SIGTERM → `engine.close({ budgetMs: 30_000 })` → socket removed → lock released → exit.

Activity derivation: the core keeps `agent.activity` per agent — `idle | recalling | capturing | checkpointing | dreaming(phase, job) | consolidating | maintenance(job)` with `since` — from recall start/completion, capture handles and `job.run`; it emits `agent.activity` on every transition and exposes it in `agent.status`. `1staid check` flags an activity older than a threshold (default 10 min for jobs, 30 s for recall) as suspicious. Turn-loop states (`thinking`, `replying`, `waiting-for-tool`, `waiting-for-approval`) join the same enum in 2c without a model change.

### 6.4 Supervision, lifelines, adoption, degraded mode

**Process health states** (one per process, the same enum everywhere): `starting | ready | degraded(reason) | orphaned(since) | stopping | stopped | crashed(exit, signal, at)`. The supervisor holds them for its children; `daemon status`, `1staid check` and the `core.state`/`module.state` notifications all read that single source.

**Spawn and monitor.** The supervisor spawns children with stdout/stderr piped to their log, a **lifeline** (a pipe whose write end only the supervisor holds), the child's token and socket paths, and an instance id. Readiness is the RPC handshake on the child's socket, never a port probe. Health: `core.status` every 5 s; three consecutive failures → `degraded(unresponsive)`; a hung child past 30 s → SIGTERM, then SIGKILL after 10 s.

**Backoff.** Exponential 1 s → 2 s → 4 s … 60 s, counter reset after 10 min stable; five crashes within 10 min → `crashed` with the last exit reason, no further attempts until `daemon start`, `module start <name>` or a config change touching that unit. A fault must become visible, not loop.

**Lifeline and grace.** A child that reads EOF on its lifeline enters `orphaned(since)` and keeps serving everything that does not need the supervisor. After the grace window (`supervisor.graceMs`, default 60 000) it shuts down cleanly (engine close, journal closed, socket and lock removed). Backstops for a hung child: `PR_SET_PDEATHSIG` (Linux), a Job Object with `KILL_ON_JOB_CLOSE` (Windows), lifeline plus `ppid` polling (macOS).

**Locks.** The core holds `state/core.lock` (`flock`; released by the OS on exit), modules hold `run/module-<name>.lock`. A second core cannot start while the lock is held — "two cores on one LanceDB" is excluded by the OS, not by discipline.

**Adoption.** A starting supervisor checks locks first. For each held lock it reads `run/<role>.pid` and the instance id, writes a fresh nonce to `run/supervisor.token` (only the supervisor may write there), and calls `daemon.adopt { nonce, lifelineFd }` on the child. The child verifies the nonce against the token file, accepts the new lifeline, leaves `orphaned`, and returns its full state; the supervisor rebuilds its view from that reply — the child is the source of truth about itself. A child that does not answer, or answers with a foreign instance id, is terminated and respawned once its lock is free.

**Clients under core loss.** The CLI connects with a 300 ms timeout; if the core is absent it answers immediately with `degraded: { reason: "core-unavailable", detail: <supervisor state> }` and exit code 0 plus a marked line — missing memory is a visible state, not a command failure. Recall budgets soft 400 ms / hard 600 ms are end-to-end from the CLI call; the engine returns what is complete with `degraded: timeout`. Modules keep their core client with automatic reconnect, report `degraded(core-restarting)`, and resume on `ready`; they are never respawned for a core restart. Captures during core loss go to `state/journal/<agentId>.jsonl` (the CLI writes them; the core replays at start).

**Core restart is short and visible, not invisible.** `engine.close()` (≤ 30 s for LanceDB writes) → new process → `ready` without models < 3 s (T4/B8) → models warm in the background. A blue/green core swap (new core warms, old one hands over) is noted as a later option; it costs double model RAM and a single-writer hand-off and is not in 2a.

### 6.5 Service registration, installer, updater skeleton

`plur1bus setup` (also reachable via a `curl | sh` / PowerShell one-liner that downloads the signed binary and runs it): creates the state root, downloads the pinned Node runtime into `runtime/` (SHA-256 verified against a manifest baked into the binary), installs `@plur1bus/core` with its native prebuilds, writes an initial `config.json` from the schema defaults, copies the skill, registers the supervisor with the OS service manager (`launchd` LaunchAgent with `KeepAlive`, `systemd --user` unit with `Restart=on-failure`, Task Scheduler "at logon, restart on failure" — all without admin), starts it, and runs `1staid check`. `--no-service` skips registration for development. `service install|uninstall|status` is the same code as a standalone command and is real in 2a (the kill soak needs it).

Updater skeleton: `plur1bus update --check` reads the installed manifest (`root/manifest.json`: binary version, core version, module versions, `apiVersion`s) and a release manifest, and reports what would change and which units would restart. Download-and-swap is M8.

Signing: macOS binaries signed with the owner's Developer ID and notarised (`notarytool`) in the release workflow from GitHub secrets; Windows unsigned in 2a with a documented SmartScreen note (SignPath Foundation proposed for M8).

### 6.6 CLI commands in 2a

| Command | Talks to | Does |
|---|---|---|
| `setup [--non-interactive] [--accept-nc-licence] [--no-service]` | — | §6.5 |
| `1staid check [--json]` | supervisor + core | Supervisor/core/module states, socket and token permissions, locks and stale PIDs, Node runtime and hash, model cache, last job runs, config schema version, suspicious activities, journal backlog. Read-only. |
| `1staid repair [--yes] [--dry-run]` | supervisor | Fix `run/` permissions, remove stale sockets/PIDs, check `config.json` against backup, re-download a missing/invalid runtime, renew service registration. Shows the plan first; never touches `state/`. |
| `agent list|create <id>|remove <id>|status <id>` | supervisor (config) + core | Agent registry lives in `config.agents`; `create` makes the workspace and opens the store; `remove` closes and leaves data in place (deletion is a separate, confirmed `agent purge` — M2). |
| `memory add --agent A [--session S] <text>` | core | `memory.capture` with a one-message `TurnRecord`; `--session` is a key only (cache, reactivation) until 2c. Writes the journal if the core is unavailable. |
| `memory recall --agent A [--session S] [--joined] <query>` | core | `memory.recall`; prints the six blocks, deferrals, `degraded`, timing; `--joined` prints the harness's own join under `capChars` (default 17 000). |
| `memory list|show|forget|correct|share|state` | core | Via `MemoryOps` (E1). Until E1 merges: `E_NOT_AVAILABLE reason=engine-pr-E1`. |
| `dreams status|run <job>|log [--agent A]` | core | `jobs.list|run|history`; shows breaker, retries, `already_running`, ledger health. |
| `config get [key]|set <key> <value> [--yes|--dry-run]|schema` | supervisor | §6.1 |
| `module list|start|stop|restart <name>` | supervisor | §6.4 (no first-party modules in 2a; the commands are tested with a fixture module) |
| `module graph [--json]` | supervisor | Prints the dependency tree from `provides`/`consumes`/`needs` of all registered module manifests; `--json` returns the adjacency list. Detects cycles and unresolved dependencies. |
| `daemon start|stop|restart|status` | supervisor / OS | Start = via service manager if registered, else spawn `supervise` detached |
| `service install|uninstall|status` | OS | §6.5 |
| `update --check` | — | §6.5 |
| `user|model|login|channel|project|import|uninstall` | — | Stubs: print the milestone that delivers them, exit 2 |

Every command supports `--json` (stable shape, documented in `docs/cli.md` generated from the command definitions) and `--home <path>`.

## 7. Engine work in 2a (PLUR1BUS repo, PRs E1–E6)

Each is its own PR with the M1b-1 gate (full suite, lint, golden 9/9, contract conformance) and lands before the harness feature that needs it.

| PR | Scope | Contract |
|---|---|---|
| E1 | **`MemoryOps`**: typed `list`, `show`, `forget` (archive-first, tombstone), `correct`, `share`, `state`, each with `Principal` + `AgentContext`; logic moves out of `lib/telegram-commands/*` into `engine/memory-ops/`; the OpenClaw adapter maps its slash commands onto it. `runCommand` with strings becomes adapter-internal. | 1.5.0 (additive) |
| E2 | `admin.*` without an OpenClaw runtime (`share`, `forget` delegate to E1; `obsidian`, `migrate` take explicit paths/hosts). | additive |
| E3 | `embedding.probe()` and `serve()` real for the in-process owner; `serve` accepts the harness's `IpcAddress` or `null` for "in-process only". | additive |
| E4 | `status()` with ledger-derived health (last run per job, breaker state, journal backlog if the host reports one) and readiness of models. | additive |
| E5 | Host-neutral `engine-config.schema.json` in the engine (the 54 keys with types, defaults, and a `readAt: construction|live` flag); the adapter translates for `openclaw.plugin.json`. | additive |
| E6 | **`HostServices` neutralised**: `pathOverrides.openclawHome` removed, `configPath()` documented as the host's own config, `routing?()` replaced by an optional `identity` capability, `HostRuntime` removed in favour of typed optional capabilities; `lib/host-paths.js` has no default root (a host supplies its paths); `ChatKind` becomes the functional vocabulary `direct | group | broadcast` (`dm` folds into `direct`, Telegram-style `channel` becomes `broadcast`) so the D22 model needs no second breaking change. | **2.0** (observable change) |
| E7 | **Conversation setting (D22):** capture takes `chatKind` from the `Principal` when present (today the typed path loses it and a group message is stamped `dm`); memory rows gain nullable `channel`, `chatKind`, `chatId`, `threadId` columns (today the chat id is used for ACL at capture but never persisted), with a migration that leaves existing rows unknown; the D22 setting fields (`container`, `thread`, `participants`, `encrypted`, `bridgedFrom`) are optional additions to `Principal.chat`; engine user aliases for D24; knowledge vs episodic weighting; sensitivity classification at capture; recall ranks by setting proximity with configurable weights and filters sensitive memories outside a private conversation with their owner; golden fixtures extended for both settings. | additive (after 2.0) |

Also in the engine backlog from the #186 review, scheduled before M1b-3, not 2a: ledger index/rotation, pid+instance on run markers, job-body signal plumbing, tool execution with `Principal` (needed by 2b).

### 7.1 Laya spike (end of 2a, D18)

Half-day spike, independent of the rest. Goal: confirm that the Laya multilingual model (Apache-2.0) has an ONNX export or that we can produce one; measure inference latency for the three primitives (`Choice`, `Score`, `Noul`) on macOS arm64. The result determines whether ADR-015 (M2) starts with a local default model or cloud-only. Deliverable: a short report with latency numbers and an ONNX availability verdict, no code shipped.

## 8. Data flow examples

**Two-session recall.** `memory add --agent bernd --session s1 "the roadmap review is on Thursday"` → CLI builds `TurnRecord` (principal from OS user, `incognito:false`) → `memory.capture` → core returns the handle immediately, awaits `done` up to 60 s in the background, logs `stored/skipped` → CLI prints the result. Later `memory recall --agent bernd --session s2 "when is the roadmap review"` → `memory.recall` with `AbortSignal.timeout(600)` → engine embeds the query (E5-small), searches, reranks → blocks → CLI prints them; `--joined` applies the harness join.

**Config change with module restart.** `config set mcp.port 7420` → CLI asks the supervisor for the plan (`x-restart: module:mcp`) → prints "restarts module mcp (~1 s)" → on confirmation the supervisor writes the file, emits `config.changed`, stops and starts `mcp`, reports `{ applied: true, restarted: ["mcp"], durationMs }`.

**Core killed mid-use.** Core receives SIGKILL → supervisor sees exit, sets `crashed`, schedules restart (1 s) → a CLI `memory recall` in that second gets `degraded: core-unavailable (restarting, attempt 1)` in < 300 ms → a `memory add` is journaled → new core starts, replays the journal, reports `ready` → next recall finds the journaled fact.

**Supervisor killed, returns in 5 s.** Core reads lifeline EOF → `orphaned` → keeps serving → new supervisor finds `state/core.lock` held, adopts via nonce → core back to `ready`, models still warm, no restart.

## 9. Operations skill

`skills/plur1bus-harness/SKILL.md` (installed to `<root>/skills/`): what the harness is and which processes exist; the ladder — `1staid check` → `1staid repair` → `module restart <name>` → `daemon restart` → `service status` → ask the owner — with the criterion for each rung; changing configuration (`config get|set`, reading `x-restart`, `--dry-run`); finding and reading logs (`logs/<role>.log`, JSON lines, `--follow` via `daemon logs`); interpreting `core.state`, `agent.activity`, `degraded` reasons; what never to do (touch `state/`, edit `config.json` by hand, `kill -9` outside the soak). Every command with a `--json` example. A CI test parses the skill, checks that every named command exists and supports `--json`, so the skill cannot go stale silently. `docs/operations.md` is the human version of the same content.

## 10. Acceptance criteria (each is a test)

1. **Two-session recall with rerank** (M1 #1): fixture corpus, `memory add` in session s1, `memory recall` in s2 returns the fact in `memories` with the reranker having run (decision trace shows rerank), real E5-small + local reranker nightly, stub in every PR.
2. **Kill soak** (M1 #3): 1 000 turns (`add` + `recall`), core SIGKILLed at random (median every 20 turns), supervisor killed once with return < grace and once > grace; 0 blocked commands (every CLI call < 1 s), every outage visible in `core.state` and `1staid check --json`, no journal line lost, exactly one core and one supervisor afterwards, one LanceDB handle (T7, M1 #5).
3. **Reconnect not respawn:** supervisor return within grace → core pid unchanged, model cache warm; beyond grace → core exited cleanly (lock released, socket removed) and was restarted.
4. **Config restart classes:** one `live`, one `module:*` (fixture module), one `core` key each changed via `config set`; only the declared units restart; `--dry-run` changes nothing; an invalid value is rejected and the running config is unchanged.
5. **Module isolation:** fixture module crashed → core untouched, module restarted with backoff, state visible; `module restart` works while a recall is in flight.
6. **No OpenClaw object in the core:** an import hook asserts no `openclaw`, `adapter/openclaw`, `host-services`, or `*-plugin-runtime` module is loaded by the core process; grep gate: no `/state`, `/forget`, `OPENCLAW_` strings in `packages/` or `crates/`.
7. **Contract fixtures:** Rust client and TypeScript server pass the same `rpc-schema` fixtures; `packages/core` type-checks against `types/engine.d.ts` of the pinned engine.
8. **Benchmarks:** B1 `--help` p95 < 100 ms (macOS arm64, Windows x64), B8 core ready < 3 s / < 15 s with model, B9 0 socket/spawn syscalls during recall assembly, **B11** CLI→core `core.status` roundtrip p95 < 5 ms. B1, B9, B11 gate; B8 advisory until M3.
9. **Service:** `service install|status|uninstall` in user context on all five targets; supervisor restarted by the OS after a kill on macOS and Linux (Windows once PR-11 lands).
10. **Skill freshness test** (§9) green; `docs/rpc.md` and `docs/cli.md` regenerated and committed.
11. **Engine side:** E1–E6 merged with green gates (E7 scheduled before M4), contract 2.0 published as prerelease, harness pinned exactly; the adapter's OpenClaw suite still green.
12. **Fixture module zero-edit:** a fixture module with a manifest (`provides`, `consumes`, `extensionPoints`, `scope: installation`, `priority: 500`) is installed via `module` commands and appears in `module list` and `module graph` without editing any existing harness code — the module system is purely declarative (D14).

## 11. Risks and open questions

| # | Risk / question | Mitigation / owner |
|---|---|---|
| R1 | Two toolchains in CI (Rust cross-compile + Node) cost setup time and a second failure surface. | `cargo-zigbuild` once; matrix reuses one Node build; contract fixtures catch drift between the two sides. |
| R2 | E6 (contract 2.0) touches the OpenClaw adapter broadly; regression risk in the adapter. | Golden corpus + full suite as in M1b-1; adapter changes are mechanical renames. |
| R3 | Adoption handshake is new code in the process that must not fail. | Small surface (nonce + state reply), property tests on the supervisor state machine, soak covers both windows. |
| R4 | Windows system tests wait for PR-11 (engine named pipe). | Windows runs unit + contract + `service install` in 2a; the gap is listed, not hidden. |
| R5 | RAM per process. | Lazy module start; no modules in 2a; measured and reported in the test report. |
| Q1 | Grace window default 60 s — owner may prefer longer for machines that sleep. | Configurable; decide at gate. |
| Q2 | `agent remove` leaves data; `agent purge` deferred to M2 — acceptable? | Owner. |
| Q3 | Journal replay order vs. dedup: the engine's capture dedup handles replays of the same text; confirm in E4 that a replay is never counted as a new LLM session. | Engine PR E4 acceptance. |
| Q4 | Memories from end-to-end encrypted chats (WhatsApp, Matrix, Signal): sensitive by default? Proposal: yes, participants expect confidentiality. | Owner, before E7. |

## 12. Exit

Demo guide (two-session recall, kill the core and watch, config change with module restart, `1staid`), test report with B1/B8/B9/B11 baselines on all five targets, open points, CHANGELOG, `docs/milestones.md` updated (M1b-2a/2b/2c, E1–E6), owner gate. Then M1b-2b (MCP transport, ADR-014 per Bernd's spec draft) starts from this stack.
