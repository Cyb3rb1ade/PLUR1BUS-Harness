# Profile Import and Foreign Plugin Compatibility Specification

**Status:** Design specification · **Date:** 2026-10-27 (revised 2026-10-31) · **Deciders:** Christian (owner) · **Author:** agy (Antigravity) · **Inputs:** `docs/phase0/auftrag-original-2026-09-21.md` §4.2; `docs/import.md`; `docs/superpowers/specs/2026-09-27-extensions-ecosystem-design.md` §3, §7.3, §8; `docs/research/2026-10-27-profile-and-extension-sources.md`; [`docs/superpowers/plans/2026-10-31-profile-import-and-plugin-compat.md`](../plans/2026-10-31-profile-import-and-plugin-compat.md); ADR-003, ADR-005, ADR-010, ADR-011, ADR-019 / D120; Proposed Register Entry **D121** (sub-ids D121-J1 to D121-J6).

---

## 1. Overview and Objectives

### 1.1 Context and Problem Statement

The PLUR1BUS Harness provides offline and supervised import capabilities for legacy OpenClaw and Hermes installations ([`docs/import.md`](../../import.md) §10–§13). However, two critical gaps remain:

1. **No profile import from modern AI coding and chat tools**: While the harness can drive external coding agents via the Agent Bridge ([ADR-011](../../adr/ADR-011-external-coding-agents.md)), it cannot import user profiles, custom instructions, persona definitions, project rules, skills, or MCP server configurations from tools such as Claude Code, OpenAI Codex, Cursor, Kimi, AGY/Gemini, or Grok. Note that legacy OpenClaw, Hermes, HM1, and HM2 remain fully covered by their existing dedicated M v2 importers (`docs/import.md` §13); the profile importer focuses strictly on the 7 new tool sources.
2. **Web UI Import wizard extension**: The original commission ([`docs/phase0/auftrag-original-2026-09-21.md`](../../phase0/auftrag-original-2026-09-21.md) §4.2) requires a re-runnable UI wizard. On main, F37 already describes the built `ImportWizard` ([`docs/web-ui.md`](../../web-ui.md) F37, `packages/web/src/pages/import/*`), and Paket O ([#838](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/pull/838)) adds prompt import. Milestone M7c extends `ImportWizard` (F37) with new tiles for the 7 new sources, granular component selection, side-by-side instruction conflict resolution, archive dropzone, and atomic rollback.
3. **Foreign plugin policy revision (Owner directive 2026-10-27)**: The Extensions specification ([`docs/superpowers/specs/2026-09-27-extensions-ecosystem-design.md`](2026-09-27-extensions-ecosystem-design.md) §3, §7.3) originally excluded foreign plugin code as "not portable". On 2026-10-27, the owner directed that OpenClaw and Hermes plugins should "just work" where viable. This specification provides the empirical survey, technical architecture, and decision framework for that capability, addressing D9 explicitly and defining strict isolation boundaries.

### 1.2 Core Objectives

- **Scoped profile intake**: Ingest persona, instructions, user facts, memories, skills, and MCP configurations across new AI tool sources (Claude Code, OpenAI Codex, Cursor, Kimi, AGY/Gemini via direct file intake; Grok via user paste / prompt export; Grokbot dropped/unsupported as multi-party transcript).
- **Extended Web wizard (extending F37 `ImportWizard`)**: Deliver a fully accessible, bilingual (DE/EN) wizard extension with automatic source detection, granular entity selection, side-by-side conflict resolution, transactional execution, and one-click rollback.
- **Process-separated foreign plugin bridge (Option B, conditional)**: Provide an out-of-process bridge for OpenClaw (Node) and Hermes (Python) plugins, exposing tools as local stdio MCP servers governed by the D109 `decide()` policy evaluator, while cleanly rejecting host-level memory, channel, provider, and context-engine overrides. V1 is strictly limited to tools only; services and turn hooks are excluded. The D106 tool sandbox (`tools.sandbox.required: true`, `sandboxSpawn`) is an explicit runtime precondition; full kernel sandboxing (Q16) is a formal precondition for production activation.
- **Strict security & zero credential migration (ADR-005, ADR-011)**: Untrusted imported instructions never enter the prompt cache or system prompt without explicit user preview and quarantine in `propose-rule` (in v1 reported as `instructions-not-imported` per Paket O). Sensitive tokens are scrubbed using the central redactor. Zero credential or session hijacking is permitted; no code path reads credential files (`auth.json`, `.credentials.json`, Cursor `state.vscdb`).

---

## 2. Mapping Architecture

### 2.1 Target Model Mapping

PLUR1BUS structures agent cognition and runtime configuration through explicit architectural zones defined in ADR-003 and ADR-010. Foreign concepts map deterministically into this model:

| Source Entity | PLUR1BUS Target | Architectural Placement | Rationale & Cache Rules (ADR-010) |
|---|---|---|---|
| **Persona / Tone / Voice** | `SOUL.md` (exactly one per agent, D14) | System Prompt (Zone 2, above BP2) | Static persona definition; changes invalidate prompt cache from BP2 downwards. |
| **Agent Operational Identity** | `IDENTITY.md` | System Prompt (Zone 2, above BP2) | Operating context and environment facts for the agent. |
| **User Facts & Preferences** | `USER.md` + Engine Memory Cards (`scope: user`) | Frozen Memory Snapshot (Zone 3, BP3) | Stable facts about the human user. Bound to verified human principal (`trust: "proved"`). Without proved user, rejected with `unresolved-user-scope` (no automatic fallback to agent-private scope per ADR-007 Q4). Default confidentiality is `vertraulich` (D116 (6)), never `teilbar`. |
| **Global / Operating Instructions** | Agent Operating Instructions (`AGENTS.md` / `SOUL.md` sections) | System Prompt (Zone 2, above BP2) | General guidelines ("always do X", "never do Y"). In v1, presented in preview and report as `instructions-not-imported` (per Paket O) to prevent automated prompt injection; optionally routed to `propose-rule` review queue (P-J2e). |
| **Project / Workspace Rules** | Workspace Guidelines (`AGENTS.md`) | Workspace Scope (Zone 2 for active workspace) | Context rules derived from `.cursorrules`, `CLAUDE.md`, or project `AGENTS.md`. Quarantined in `propose-rule` review queue (or `instructions-not-imported`). |
| **Skills** | Agent Skills (`skills/<id>/SKILL.md`) | Extensions Registry (`skills/`) | Conforms to Agent Skills standard (Extensions Spec §4.3). Trust tier `imported`. |
| **MCP Servers** | `mcp-servers` configuration | Tool Definitions (Zone 1, BP1) | Declarative stdio/HTTP server entries. Conforms to `import.mcp-candidate/1`: slot names preserved, arguments and env values scrubbed, disabled by default. Changes invalidate BP1. |
| **Foreign Plugins** (Tools only) | Bridged MCP Server (Option B) | Tool Definitions (Zone 1, BP1) under D109 | Foreign tool plugins exposed as isolated stdio MCP endpoints; calls gated by `decide()`. Default effect `external`/ask; results marked tainted. Native duplicates denied per D106. |
| **Foreign Memory / Channels / Providers** | *Excluded from Bridge* | N/A | Handled natively by PLUR1BUS core and engine. Rejected fast with `E_UNSUPPORTED_PLUGIN_KIND`. |

#### Confidentiality & Principal Constraints (D116, ADR-007)
- **Confidentiality Level:** In accordance with D116 (6), all imported memories default to `vertraulich`. They are never imported as `teilbar` without explicit per-item promotion by the operator.
- **User Scope vs. Agent-Private:** As decided in ADR-007 Q4 and Paket O, `scope: user` memory cards require an unambiguous human principal authenticated with `trust: "proved"`. The CLI cannot mint a proved human principal; unauthenticated CLI profile imports fail with `unresolved-user-scope` (no automatic fallback to agent-private scope per ADR-007 Q4).
- **Prompt Cache (ADR-010) Impact:** Zone 1 holds tools, Zone 2 holds system prompt instructions (`SOUL.md`, `IDENTITY.md`, `AGENTS.md`), Zone 3 holds memory snapshots, and Zone 4 holds conversation history. Breakpoint 2 closes Zone 2 (system prompt). Any addition or edit to instructions forces a re-computation of the prompt cache from BP2 downwards. To prevent accidental cache invalidation and reasoning instability, incoming instructions never touch Zone 2 directly; in v1 they are reported as `instructions-not-imported` per Paket O, or held in a dedicated review queue (P-J2e).

---

### 2.2 Multi-Source Conflict Resolution

When importing instructions into an agent that already contains configured guidelines, conflicting rules can arise (e.g., "always provide concise bullet points" vs. "provide exhaustive explanations").

> [!IMPORTANT]
> **Strict Rule: No Silent Concatenation.**
> Concatenating opposing instructions pollutes Zone 2 of the system prompt, confuses model reasoning, and degrades prompt cache performance. Conflicting rules must be detected and resolved deterministically without external cloud LLM dependencies.

#### Conflict Resolution Workflow

```mermaid
flowchart TD
    Scan["Ingest Incoming Instructions\n(from Files, Archives, or Paste)"] --> Normalize["Syntax Normalization\n(Whitespace trimming, Unicode NFC, case-fold)"]
    Normalize --> HashCheck{"Exact Normalized\nSHA-256 Match?"}
    HashCheck -- "Yes" --> Dedup["Mark as Matched-Existing\n(Skip with provenance link)"]
    HashCheck -- "No" --> ClashDetect{"Deterministic Overlap Check\n(Normalized token overlap / Jaccard similarity\nor local engine embedding)"}
    ClashDetect -- "No Clash" --> AutoMerge["In v1: Report as instructions-not-imported\n(Or queue in propose-rule under P-J2e)"]
    ClashDetect -- "Clash Detected" --> UserDiff["Present Side-by-Side Diff\nin Wizard / CLI (--conflict)"]
    UserDiff --> Choice{"Operator Resolution Choice"}
    Choice -- "Skip (Default)" --> Discard["Discard Incoming Rule (--conflict skip)"]
    Choice -- "Rename" --> Rename["Save Suffix Copy (--conflict rename)"]
    Choice -- "Replace (Reviewed)" --> ReplaceProposal["Create Replace Proposal (--conflict replace;\nOperator confirmation mandatory)"]
    Choice -- "Synthesize / Edit" --> Synthesize["Operator Edits Combined Text"]
```

1. **Exact Deduplication**: Normalized rules matching existing entries by SHA-256 hash are flagged as `matched-existing` and skipped.
2. **Deterministic Overlap Detection**: Rules with overlapping vocabulary or near-duplicate intent are detected locally via normalized token overlap and Jaccard similarity, optionally supplemented by the local Rust engine embedding if available offline. **Zero cloud LLM inference is permitted** for conflict detection to respect `privacy.localOnly` and prevent data leaks. Semantic opposition that shares no tokens is surfaced via side-by-side operator review.
3. **Interactive Resolution (`--on-conflict` / `--conflict`)**:
   - *Skip* (default, `--conflict skip`): Preserves current PLUR1BUS agent behavior; drops incoming entry.
   - *Rename* (`--conflict rename`): Preserves the existing file and writes the imported content under a suffixed file (e.g. `SOUL.imported-<source>.md`, `AGENTS.imported-<date>.md`).
   - *Replace* (`--conflict replace`): In v1, never performs a direct unconfirmed overwrite of Zone 2 files; it creates a proposal flagged to replace existing content, requiring explicit operator review and confirmation before applying.
   - *Synthesize / Edit*: Opens an inline editor allowing the operator to combine both intents.
4. **Plan Hash and Byte Invariance**: The preview displayed in the CLI or Web UI must exactly equal the applied bytes (plan hash). Preprocessing and normalization must not strip content (such as HTML comments or bidirectional Unicode characters) in preview while leaving them in apply.
5. **Per-Entry Bounds**: Following Paket O standards, individual imported instruction entries are capped at 512 KiB total entry size and 4 000 characters per statement text (matching `SOUL.md` and neo caps).
6. **Provenance Tracking**: Every imported rule and memory card carries immutable metadata:
   - `provenance: "imported"`
   - `sourceRef: "<source>:<kind>:<id>;run=<runId>"`

---

## 3. Interfaces and Security Architecture

### 3.1 CLI Interface

Profile import integrates into the existing `plur1bus import` command structure, strictly scoped to the 7 new sources:

```bash
# Detect available profile sources across the host
plur1bus import profile --detect

# Preview profile import from a specific source (dry-run by default)
plur1bus import profile claude --preview --agent main

# Apply profile import with explicit conflict resolution strategy (options: skip | rename | replace; default: skip)
plur1bus import profile cursor --apply --agent dev --workspace ws-alpha --conflict skip

# Import from a manual export archive (.zip or .tar.gz)
plur1bus import profile gemini --archive ~/Downloads/takeout-gemini.zip --apply

# Rollback a completed profile import run
plur1bus import profile --rollback <runId-or-report-path>
```

#### CLI Exit Codes (Aligned with `docs/errors.md`)
The `plur1bus import` command passes through the importer's exit codes (1..255 per `docs/errors.md`):
- `0`: Success (dry-run plan generated or apply completed cleanly).
- `1`: Application or validation error (`source-unreadable`, invalid archive, schema mismatch, internal failure).
- `2`: Usage error or refused before work (missing required arguments, invalid flag combinations).
- `3`: `E_LOCKED` (concurrent lock held).

#### Source Delegation
Legacy OpenClaw, Hermes, HM1, and HM2 sources are handled by the existing dedicated importers (`plur1bus import openclaw` and `plur1bus import hermes`, `docs/import.md` §13). Invoking `plur1bus import profile openclaw` delegates to `plur1bus import openclaw` with a diagnostic notice.

---

### 3.2 RPC Interface

Profile import extends the existing administrative import namespace (`admin.import.*`, `docs/import.md` §13.1) rather than creating a parallel API surface. All methods are Owner/Admin only, require authenticated sessions, and are assigned the **next free RPC minor version at implementation time** (extending `SourceType`, `source-catalog.json`, and the source registry under `packages/core/src/import/sources/`):

- `admin.import.detect`: Extended to return detected profile sources alongside existing OpenClaw/Hermes installations.
- `admin.import.plan`: Generates an immutable preview manifest for a profile source, archive, or prompt text, checking for instruction conflicts against target agents.
- `admin.import.apply`: Requires fresh preflight and downtime consent; takes import locks, journals intent, snapshots mutated state, applies memory cards and curated files atomically, and writes `report.json` (0600).
- `admin.import.rollback`: Reverts changes associated with a specific `importRunId` using the cold recovery snapshot.

Agents and WebMCP receive no import methods (`docs/import.md` §13.1).

---

### 3.3 Web UI Wizard (Extending F37 `ImportWizard`)

The Web UI extends the existing `ImportWizard` ([`docs/web-ui.md`](../../web-ui.md) F37, `packages/web/src/pages/import/*`):

```mermaid
sequenceDiagram
    autonumber
    actor User as Human Operator
    participant UI as ImportWizard (Web UI F37)
    participant Core as PLUR1BUS Core (admin.import.*)
    participant Ext as Rust Archive Auditor (crates/plur1bus-ext)
    participant Redact as Central Secrets Redactor

    User->>UI: Navigate to /import -> New Source Tile
    UI->>Core: admin.import.detect()
    Core-->>UI: Return Detected Tools (Claude, Cursor, Codex, Kimi, AGY)
    User->>UI: Step 1: Select Source or Drop Archive / Paste Text
    opt Archive Upload
        UI->>Core: Upload Archive
        Core->>Ext: Stream audit & unpack allowlisted files
        Ext-->>Core: Verified unpacked entries
    end
    User->>UI: Step 2: Choose Components (Persona, Rules, Skills, MCP)
    UI->>Core: admin.import.plan(selection)
    Core->>Redact: Scrub secrets (sk-ant-, JWT, OAuth)
    Core-->>UI: Step 3: Present Per-Agent Preview & Unified Diffs
    opt Conflicts Detected
        UI->>User: Step 4: Side-by-Side Conflict Screen
        User->>UI: Choose Keep Existing, Replace, or Synthesize
    end
    User->>UI: Step 5: Confirm Apply (Downtime & Snapshot Consent)
    UI->>Core: admin.import.apply(plan)
    Core-->>UI: Step 6: Completion Report & Rollback Button
```

1. **Step 1: Detect & Select Source**: Adds tiles for the 7 new tools alongside existing OpenClaw, Hermes, and Prompt Import tiles. Provides an archive dropzone (`.zip`, `.tar.gz`) and prompt paste box.
2. **Step 2: Component Selection**: Granular checklist grouped by category (Persona/Identity, Instructions, User Facts, Skills, MCP Servers).
3. **Step 3: Preview**: Unified diffs for `SOUL.md`, `IDENTITY.md`, `USER.md`, and `AGENTS.md`, alongside proposed memory cards and MCP tool additions.
4. **Step 4: Conflict Resolution**: Side-by-side comparison screen for detected rule clashes with Keep / Replace / Synthesize options.
5. **Step 5: Apply & Execution**: Displays progress bar, takes pre-flight snapshot, and writes state atomically.
6. **Step 6: Report & Rollback**: Comprehensive run statistics, download for `report.json`, and one-click rollback.

---

### 3.4 Container Mode Strategy

When PLUR1BUS runs inside a container (e.g., Docker desktop bundle per D77):
- **No Insecure Host Mounts**: Blindly mounting the host home directory (`-v ~:/host-home:ro`) is strictly prohibited, as it exposes sensitive directories (`~/.ssh`, `~/.aws`, browser profiles, crypto wallets) and violates the snapshot-producer design (D91/D107).
- **No Unauthenticated Probing**: `/.dockerenv` sniffing is avoided. In accordance with F37, only authenticated container deployment metadata may propose host endpoints (`host.docker.internal`).
- **Supported Workflows in Containers**:
  1. *Archive Upload & Text Paste*: The Web UI enables direct drag-and-drop of export archives and copy-pasted exports.
  2. *Authenticated Desktop Helper (D90 / D2)*: When paired with the native desktop shell helper, the helper gathers sanitized source snapshots on the host and transmits them over the authenticated host bridge (`host.importSnapshot`).
  3. *Producer-Side Allowlist for `host.importSnapshot`*: The helper applies a strict allowlist of recognized configuration paths (`config.toml`, `.claude.json`, `.cursorrules`, `.cursor/rules/*.mdc`, `.cursor/mcp.json`, `~/.gemini/config/skills/`). All files matching credential patterns (`*auth*`, `*credential*`, `*token*`, `*.vscdb`, `*key*`, `*secret*`, `*.pem`, `*.env*`) are excluded on the producer host before creating the archive tar.

---

### 3.5 Security, Credential Defense, and Data Boundaries

#### Single Canonical Read vs. Never-Read Boundary Table (N2)

| Source | Target Category | Exactly What is READ | Exactly What is NEVER READ (Strictly Banned) |
|---|---|---|---|
| **Claude Code** | Global/Project rules, MCP config | `~/.claude/CLAUDE.md`, `<workspace>/CLAUDE.md`, `<workspace>/.claude/CLAUDE.md`. Mixed file `~/.claude.json` / `<workspace>/.mcp.json`: streaming key-allowlist extractor extracts `mcpServers` ONLY. | `~/.claude/.credentials.json` (banned), all non-allowlisted keys in `~/.claude.json` (`oauth_tokens`, `account`, `session` dropped immediately), `~/.claude/history/`. |
| **OpenAI Codex** | Instructions, skills, MCP config | `~/.codex/config.toml` (only `[developer_instructions]` and `[mcp_servers]`), `<workspace>/AGENTS.md`, `~/.codex/skills/`. | `~/.codex/auth.json` (banned), `~/.codex/sessions/*.json` (sensitive transcripts; dropped), shell hooks in `~/.codex/hooks.json` (skipped). |
| **Cursor** | Project rules, global rules, MCP | `.cursorrules`, `.cursor/rules/*.mdc`, `.cursor/mcp.json`, `settings.json` (`cursor.general.rulesForAi`). User instructions via paste. | `state.vscdb` (SQLite storage with auth tokens/chat history; **NEVER opened or read**), `~/.cursor/extensions/` native binaries. |
| **Kimi** | Rules, skills, MCP config | `~/.kimi-code/AGENTS.md`, `<workspace>/AGENTS.md`, `~/.kimi-code/skills/`, `~/.kimi-code/mcp.json`. | Shell hooks in `config.toml` `[[hooks]]` (skipped), web session credentials, private API keys. |
| **Gemini / AGY** | Rules, skills, MCP config | `~/.gemini/antigravity-cli/rules/*.md`, `<workspace>/AGENTS.md`, `~/.gemini/config/skills/`, `mcp/<server>/` schemas. | Cloud account credentials, OAuth tokens, browser session stores. |
| **Grok** | Instructions, memories | User paste or prompt export (`PLUR1BUS-MEMORY-EXPORT v1`). | No filesystem access (cloud-only). Zero scraping. |
| **Grokbot** | Transcripts, chats | **None (Dropped entirely)**. | Telegram export JSON / desktop database (contains multi-party chats; sensitive). |

- **Prompt Injection Defense**: All imported instructions originate from external environments and are treated as untrusted text. In v1 they are never automatically activated into Zone 2; they are presented in preview and report as `instructions-not-imported` per Paket O, or routed to a dedicated review queue under P-J2e.
- **Strict Key-Allowlist Parsers**: Parsers only extract explicitly documented configuration keys. Unknown, unparsed, or executable fields are discarded.
- **Zero Credential Migration (ADR-005, ADR-011)**:
  - Credential files (`~/.codex/auth.json`, `~/.claude/.credentials.json`, tokens in Cursor `state.vscdb`) are prohibited from being opened or read.
  - Automated spike-11 tests assert that no code path opens or reads credential files.
  - A mixed-file test seeds sentinel secrets into non-allowlisted keys of `~/.claude.json` and asserts that no log, report, or output contains them.
  - `secret-file-names.ts` and leak-sweep fixtures are extended to prevent reading credential stores.
  - Imported MCP server configs reuse `import.mcp-candidate/1` (`mcp-config.ts`): command arguments and environment variables are scrubbed, slot names are preserved, servers are set to disabled by default, and unsupported configurations route to manual setup.
- **Enhanced Centralized Redaction**: The central redactor (`crates/plur1bus/src/firstaid_bundle/redact.rs` and `packages/core/src/logs/redact.ts`) is extended to match Anthropic keys (`sk-ant-`), JSON Web Tokens (JWT), OAuth refresh tokens, and private key blocks.
- **Safe Filesystem Traversal**: File reading uses `SourceReader` / `readSourceFileSafe` with `O_NOFOLLOW` and the `@plur1bus/remote-fs` read-only port to guarantee that symlinked files (e.g., a `.cursorrules` pointing to `~/.ssh/id_rsa`) are rejected.
- **Hardened Archive Extraction**: Archive intake in `plur1bus-tools` (or worker child `plur1bus ext __worker` per X1-R2) enforces stream selection of named entries, a 10 MiB limit per decompressed file, 100 MiB total uncompressed bytes, a 100:1 maximum decompression ratio (matching `zipaudit`), and rejects symlinks, hardlinks, absolute paths, directory traversal (`..`), and nested archives. Selective extraction supports `.zip` and `.tar.gz`.

---

## 4. Foreign Plugin Compatibility: Analysis and Decision Matrix

### 4.1 Real Plugin Ecosystem Survey and Taxonomy

To evaluate the owner's directive that "Hermes and OpenClaw plugins should just work", we examine the actual host contracts and plugin taxonomies across both ecosystems based on repository evidence (`host-contract.md`, `openclaw` `b9421f4`, `hermes` `743ee72`). Note that the surveyed plugin names in §4.2 and §4.3 represent an illustrative sample of external ecosystem extensions and are not checked-in repository fixtures.

#### Real Plugin Kinds in OpenClaw and Hermes

| Plugin Kind | Real Host API (OpenClaw) | Real Host API (Hermes) | Description | V1 Bridge Viability (Option B) |
|---|---|---|---|---|
| **Tool / Function** | `api.registerTool` | `register_tool` (host evidence); `@tool` [**U**] | Adds callable functions for LLM execution. | **Full** (Mapped to stdio MCP tools) |
| **Command** | `api.registerCommand` | `register_command`, `register_cli_command` | Adds slash commands / CLI utilities. | **Excluded in v1** (OpenClaw commands short-circuit turns [`host-contract.md:118`]; HYG-003 bans slash command emulation; MCP prompts only ingest content via `tool_result`) |
| **Service / Daemon** | `api.registerService` | `BackgroundService` [**U**] | Long-running background helper processes. | **Excluded in v1** (Requires supervised service manager; deferred) |
| **Hook / Interceptor** | `before_prompt_build`, `before_agent_reply`, `before_dispatch`, `before_tool_call` | `register_hook`, `register_middleware` | Lifecycle hooks modifying prompts or context. | **Excluded** (Rewriting prompts breaks ADR-010 cache layout; MCP has no turn lifecycle events) |
| **Channel / Messaging** | `api.registerGatewayMethod`, `api.registerHttpRoute` | `register_platform` (host evidence); `ChannelPlugin` [**U**] | Implements chat platform adapters. | **Excluded** (Native harness responsibility) |
| **Memory Provider** | `api.registerMemoryPromptSupplement` | `MemoryProvider` [**U**] | Replaces memory/vector backend. | **Excluded** (Native engine responsibility) |
| **LLM Provider** | Custom provider adapters | `ProviderPlugin` [**U**] | Replaces LLM inference routing. | **Excluded** (Native providers package) |

---

### 4.2 Top 20 Plugins Survey: OpenClaw

Evaluated against the real OpenClaw host contract:

| # | Plugin Name (Illustrative Sample) | Real Kind | Real APIs Invoked | Required Permissions | Option B Support (V1 Tools Only) |
|---|---|---|---|---|---|
| 1 | `@openclaw/plugin-web-search` | Tool | `api.registerTool`, `fetch` | Network | **Yes** (via MCP tool) |
| 2 | `@openclaw/plugin-weather` | Tool | `api.registerTool`, `fetch` | Network | **Yes** (via MCP tool) |
| 3 | `@openclaw/plugin-shell` | Tool | `api.registerTool`, `child_process.spawn` | Process | **Denied by D106** (Duplicates native exec tool) |
| 4 | `@openclaw/plugin-filesystem` | Tool | `api.registerTool`, `fs/promises` | Filesystem | **Denied by D106** (Duplicates native fs tool) |
| 5 | `@openclaw/plugin-git` | Tool | `api.registerTool`, `execFile('git')` | Process, Filesystem | **Denied by D106** (Duplicates native git tool) |
| 6 | `@openclaw/plugin-postgres` | Tool | `api.registerTool`, `pg.Pool` | Network | **Yes** (via MCP tool) |
| 7 | `@openclaw/plugin-sqlite` | Tool | `api.registerTool`, `better-sqlite3` | Filesystem | **Yes** (via MCP tool; pure JS / portable only) |
| 8 | `@openclaw/plugin-calculator` | Tool | `api.registerTool`, pure JS math | None | **Yes** (via MCP tool) |
| 9 | `@openclaw/plugin-fetch` | Tool | `api.registerTool`, `fetch` | Network | **Yes** (via MCP tool) |
| 10 | `@openclaw/plugin-github` | Tool | `api.registerTool`, `@octokit/rest` | Network | **Yes** (via MCP tool) |
| 11 | `@openclaw/plugin-docker` | Tool | `api.registerTool`, `dockerode` | Process, Socket | **Denied by D106** (Duplicates native exec / process tool) |
| 12 | `@openclaw/plugin-datetime` | Tool | `api.registerTool`, `Intl` | None | **Yes** (via MCP tool) |
| 13 | `@openclaw/plugin-clipboard` | Tool | `api.registerTool`, clipboard | Process | **Denied by D106** (Duplicates native clipboard family) |
| 14 | `@openclaw/plugin-transcribe` | Tool / Service | `api.registerTool`, `ffmpeg` | Process, Network | **Yes** (Tool leg only via MCP) |
| 15 | `@openclaw/plugin-image-gen` | Tool | `api.registerTool`, `fetch` | Network | **Yes** (via MCP tool) |
| 16 | `@openclaw/plugin-slack` | Channel | `api.registerGatewayMethod` | Network | **No** (Channel: Native harness) |
| 17 | `@openclaw/plugin-discord` | Channel | `api.registerGatewayMethod` | Network | **No** (Channel: Native harness) |
| 18 | `@openclaw/plugin-memory-redis` | Memory | `api.registerMemoryPromptSupplement` | Network | **No** (Memory: Native engine) |
| 19 | `@openclaw/plugin-anthropic` | Provider | Provider adapter | Network | **No** (Provider: Native providers) |
| 20 | `@openclaw/plugin-summarizer` | Hook | `before_prompt_build` | Internal | **No** (Hook: ADR-010 cache violation) |

**OpenClaw V1 Viability**: 15 of 20 (75.0%) are tools without filtering. However, D106 denies native duplicates (shell, filesystem, git, docker, clipboard), leaving **10 of 20 (50.0%)** distinct tools running cleanly over Option B.

---

### 4.3 Top 20 Plugins Survey: Hermes

Evaluated against the real Hermes host contract (`register(ctx)`):

| # | Plugin Name (Illustrative Sample) | Real Kind | Real APIs Invoked | Required Permissions | Option B Support (V1 Tools Only) |
|---|---|---|---|---|---|
| 1 | `hermes-plugin-web-search` | Tool | `register_tool`, `httpx` | Network | **Yes** (via MCP tool) |
| 2 | `hermes-plugin-weather` | Tool | `register_tool`, `requests` | Network | **Yes** (via MCP tool) |
| 3 | `hermes-plugin-bash` | Tool | `register_tool`, `subprocess` | Process | **Denied by D106** (Duplicates native exec tool) |
| 4 | `hermes-plugin-files` | Tool | `register_tool`, `pathlib` | Filesystem | **Denied by D106** (Duplicates native fs tool) |
| 5 | `hermes-plugin-git` | Tool | `register_tool`, `gitpython` | Process, Filesystem | **Denied by D106** (Duplicates native git tool) |
| 6 | `hermes-plugin-duckduckgo` | Tool | `register_tool`, `duckduckgo_search` | Network | **Yes** (via MCP tool) |
| 7 | `hermes-plugin-wikipedia` | Tool | `register_tool`, `wikipedia-api` | Network | **Yes** (via MCP tool) |
| 8 | `hermes-plugin-arxiv` | Tool | `register_tool`, `arxiv` | Network | **Yes** (via MCP tool) |
| 9 | `hermes-plugin-python-eval` | Tool | `register_tool`, `code.Interactive` | Process | **Denied by D106** (Arbitrary process eval / native exec) |
| 10 | `hermes-plugin-system-info` | Tool | `register_tool`, `psutil` | Process | **Denied by D106** (Duplicates native sys family) |
| 11 | `hermes-plugin-rss` | Tool | `register_tool`, `feedparser` | Network | **Yes** (via MCP tool) |
| 12 | `hermes-plugin-sql` | Tool | `register_tool`, `sqlalchemy` | Network, Filesystem | **Yes** (via MCP tool) |
| 13 | `hermes-plugin-browser` | Tool / Service | `register_tool`, `playwright` | Process, Network | **Yes** (Tool leg only via MCP) |
| 14 | `hermes-plugin-chart` | Tool | `register_tool`, `matplotlib` | Filesystem | **Yes** (via MCP tool) |
| 15 | `hermes-plugin-clipboard` | Tool | `register_tool`, `pyperclip` | Process | **Denied by D106** (Duplicates native clipboard family) |
| 16 | `hermes-plugin-telegram` | Channel | `register_platform` | Network | **No** (Channel: Native harness) |
| 17 | `hermes-plugin-discord` | Channel | `register_platform` | Network | **No** (Channel: Native harness) |
| 18 | `hermes-plugin-chroma` | Memory | `MemoryProvider` [**U**] | Filesystem, Network | **No** (Memory: Native engine) |
| 19 | `hermes-plugin-ollama` | Provider | `ProviderPlugin` [**U**] | Network | **No** (Provider: Native providers) |
| 20 | `hermes-plugin-audit-log` | Hook | `register_hook` | Filesystem | **No** (Hook: MCP has no turn events) |

**Hermes V1 Viability**: 15 of 20 (75.0%) are tools without filtering. After applying D106 duplicate denial (bash, files, git, python-eval, system-info, clipboard), **9 of 20 (45.0%)** distinct tools remain viable over Option B.

**Combined Viability**: Across both surveyed sets, 30 of 40 (75.0%) are unconstrained tools. Exactly 10 plugins are non-tool kinds (channels, memory providers, LLM providers, turn hooks) that cannot run over MCP. After enforcing D106 native duplicate denials (denying shell, fs, git, docker, sys, clipboard), **19 of 40 (47.5%)** plugins remain viable.

---

### 4.4 Options Comparison: Technical and Security Evaluation

```mermaid
flowchart LR
    subgraph OptionA["Option A: Status Quo (Native Rewrite per D9)"]
        A1["Plugins Not Portable"]
        A2["Port Foreign Tools to Native MCP / Skills"]
        A3["Strict Adherence to D9"]
    end

    subgraph OptionB["Option B: Process-Separated Bridge (Conditional Exception)"]
        B1["Stdio Local MCP Extension"]
        B2["Worker Process: Pinned Node / Python\nwith hosts/openclaw-shim/ (Outside Core)"]
        B3["Stdio JSON-RPC MCP Server"]
        B4["Core MCP Client under D109 decide()\n(Default effect: external/ask; Tainted results;\nD106 sandbox precondition; Q16 milestone)"]
        B1 --> B2 --> B3 --> B4
    end

    subgraph OptionC["Option C: Full In-Process Emulation"]
        C1["In-Process Node/Python Runtime"]
        C2["Emulate Host Channels, Memory, Providers"]
        C3["Direct Harness Memory Mutation"]
    end
```

| Evaluation Dimension | Option A: Maintain Status Quo (D9) | Option B: Process-Separated Bridge (Conditional) | Option C: Full Emulation |
|---|---|---|---|
| **Architectural Purity** | **Highest**: Zero foreign code enters harness; tools rewritten natively per D9. | **Moderate**: Foreign code runs in separate subprocess; interacts strictly via standard MCP protocol. | **Poor**: Foreign abstractions compromise core harness boundaries. |
| **Security & Isolation** | **Highest**: No foreign runtime execution. | **Restated Honestly**: Process separation + per-call invocation approval; **NO OS kernel sandbox in v1**. Scrubbed env; tainted results; denied native duplicates (D106). D106 tool sandbox is a runtime precondition; Q16 kernel sandbox is a production activation precondition. | **Dangerous**: Foreign plugin code runs in core daemon memory space. |
| **D9 Boundary Compliance** | **Full**: Follows D9 ("modules that would only work as an emulation are rewritten"). | **Reopened by Exception**: Acknowledges that D9 argues against shims; reopens D9 strictly for tool-kind plugins out-of-process. Shim isolated in `hosts/openclaw-shim/`. | **Violated**: Massive OpenClaw emulation layer inside core. |
| **Ecosystem Coverage** | **0%** automated (native manual porting). | **47.5% – 55.0%** viable under D106 (75.0% theoretical unconstrained tools). | **100%** theoretical (severe maintenance reality). |
| **Prompt Cache Stability (ADR-010)** | **Unaffected**. | **Preserved**: Tools declared deterministically in Zone 1. Context engines and hooks rejected. | **Broken**: Context engines rewrite prompts unpredictably. |
| **Implementation Effort** | 0 ad. | **16–23 ad** (split into J4a: OpenClaw/Node 8–11 ad; J4b: Hermes/Python 8–12 ad). | **40–60 ad** (perpetual maintenance sink). |
| **Upstream Drift Resilience** | High. | **Moderate**: Minimal tool registration shim; upstream drift in hooks or channels has zero impact. | **Very Low**: Breaks on every minor upstream host update. |

---

### 4.5 Addressing Decision D9 and Codebase Hygiene

Decision D9 ([`docs/superpowers/specs/2026-09-24-m1b-2a-core-daemon-cli-design.md`](2026-09-24-m1b-2a-core-daemon-cli-design.md#2-owner-decisions-carried-in-2026-09-24), line 23) states verbatim:
> **Register Text:** *"No OpenClaw idiom crosses the engine boundary into the harness. Where the engine offers only an OpenClaw-shaped path, the engine gets a real API and the adapter becomes its consumer. Modules that would only work as an emulation are rewritten."*
> **Owner Quote:** *"nicht so wirken, als hätten wir … eine OpenClaw-Emulationsschicht gebaut … Wenn wir dann ein Modul neu schreiben müssen, dann müssen wir ein Modul neu schreiben."*

#### Critical Architectural Re-evaluation
The owner's verbatim quote (*"dann müssen wir ein Modul neu schreiben"*) and register text fundamentally oppose building an emulation layer or compatibility shim. Option A represents the direct, faithful execution of D9: foreign plugins are not shimmed; instead, valuable foreign tools are ported to native MCP servers or skills.

Option B requires hosting a compatibility shim (`api.registerTool`) so that unadapted foreign plugin packages can initialize. If the owner approves Option B, it constitutes an **explicit, conscious reopening and exception to D9**:
1. **Reopening D9:** Owner Decision D121-J1 acknowledges the owner quote, explicitly notes that D9 argues against shims, and reopens D9 **strictly for tool-kind plugins running out-of-process in a dedicated worker**.
2. **Package Isolation Outside Core:** The shim code must never live in `packages/core/`. It is placed in a dedicated, isolated package under `hosts/openclaw-shim/`.
3. **Hygiene Rule Enforcement:** `packages/core` remains strictly subject to `HYG-001` (zero OpenClaw idioms permitted). Only the isolated package `hosts/openclaw-shim/` is added to `ALLOW_DIRS` for `HYG-001`.

---

### 4.6 Detailed Bridge Architecture (Option B)

1. **Local Stdio MCP Architecture:** Rather than inventing a bespoke supervisor, the bridge packages the shim as a local stdio `mcp-server` extension, managed through the existing MCP client (`docs/mcp-client.md`). The existing MCP client already provides command allowlisting, scrubbed environments, 1 MiB frame limits, and crash recovery.
2. **Pinned Runtimes:** OpenClaw plugins execute using the pinned Node 24 runtime. Hermes plugins execute using the pinned Python runtime (D58; blocked behind the Python runtime producer and audit). Only pure JS/Python plugins with vendored dependencies are accepted in v1; plugins requiring native C/C++ addons or install hooks (`npm install`) are marked `nonportable` and refused.
3. **Tool-Only Shims:** `hosts/openclaw-shim/index.js` provides mock objects for `api.registerTool`. Attempts to call `registerGatewayMethod`, `registerHttpRoute`, `registerService`, `registerCli`, `registerMemoryPromptSupplement`, or lifecycle hooks (`api.on`, `before_prompt_build`) fail fast with `E_UNSUPPORTED_PLUGIN_KIND`.
4. **MCP Translation:** The shim wraps registered tools into a standard Model Context Protocol (MCP) server listening on stdio JSON-RPC.
5. **Gating via D109 `decide()`:** The harness connects to the worker as an MCP client. Every tool execution passes through the native `decide()` policy evaluator:
   - Default effect is `external`/ask. Annotations may only raise the requirement, never lower it.
   - All results from foreign tools are tagged as **tainted** (D109).
   - Duplicate tools that replicate native exec, fs, git, docker, clipboard, or sysinfo are denied (D106).
6. **Execution Integrity:** The bridge process runs with a scrubbed environment (`PATH`, `HOME`, minimal temp dir). Plugin trees are pinned by SHA-256 and re-verified on start (Extensions Spec §8.7). If `extensions.allowUnsigned=false`, the bridge is disabled.
7. **Sandbox Preconditions:**
   - **Runtime Precondition (D106 Sandbox):** The bridge requires the D106 tool sandbox (`tools.sandbox.required: true`, `sandboxSpawn`, max tasks). On platforms where `sandboxSpawn` is unavailable, the bridge refuses to start with `sandbox-unavailable`.
   - **Production Precondition (Q16 Sandbox):** Full kernel-level OS sandboxing (bubblewrap on Linux, sandbox-exec on macOS, AppContainer on Windows per Q16) is a formal precondition for general production activation (Milestone X3b, post-v0.1.0). Until Q16 lands, all bridged tool calls require per-call interactive operator approval.

---

### 4.7 Mapping Other Ecosystems

Ecosystems without full plugin runtimes map onto standard PLUR1BUS extension types:
- **Cursor**: `.cursorrules` and `.cursor/rules/*.mdc` map to workspace rules (Zone 2, via `propose-rule` or `instructions-not-imported`). `.cursor/mcp.json` maps to `mcp-servers`. User instructions imported via paste; `state.vscdb` is never opened or read.
- **Gemini / AGY**: Skills in `~/.gemini/config/skills/` map to Agent Skills (`skills/`). MCP schemas map to `mcp-servers`.
- **Codex / Kimi**: Skills map to Agent Skills (`skills/`). Prompts and hooks are both **skipped and reported as skipped** in accordance with Extensions Spec §3 and §7.3, and HYG-003 (prompts do not map to slash commands).

---

## 5. Implementation Plan and Milestones

Implementation details, work package breakdowns, assignees, and verification gates are specified in [`docs/superpowers/plans/2026-10-31-profile-import-and-plugin-compat.md`](../plans/2026-10-31-profile-import-and-plugin-compat.md).

### 5.1 Scoped Milestones in `docs/milestones.md`

All three milestones sit outside the v0.1.0 total; X3b is scheduled strictly post-v0.1.0:

1. **`M7b` — Profile Import Core & CLI (`plur1bus import profile`)**:
   - Extraction parsers for new AI tools across Linux, macOS, and Windows.
   - Hardened selective archive intake & security audit in `plur1bus-tools` / `crates/plur1bus-ext` (P-J2a).
   - Deterministic conflict detection engine, `admin.import.*` RPC extensions (assigned the next free RPC minor version at implementation time), and Rust CLI `plur1bus import profile` (options: `skip | rename | replace`).
   - PII/secret scrubbing, leak-sweep fixtures, and spike-11 credential ban test.
   - Total effort: **10–15 ad**.
2. **`M7c` — Profile Import Web Wizard (Extending F37 `ImportWizard`)**:
   - Extends existing `ImportWizard` (F37) with tiles for the new tools, component checklist, side-by-side conflict resolution screen, archive dropzone, and atomic rollback.
   - Full bilingual DE/EN accessibility (axe-core green).
   - Total effort: **3–5 ad**.
3. **`X3b` — Foreign Plugin Bridge (Split into X3b-a and X3b-b)**:
   - **`X3b-a` (OpenClaw / Node)**: Local stdio MCP bridge extension, Node shim in `hosts/openclaw-shim/`, tools-only MCP bridge, D109 `decide()` gating. Runtime precondition: D106 tool sandbox; production precondition: Q16 sandbox. Effort: **8–11 ad**.
   - **`X3b-b` (Hermes / Python)**: Python shim in `hosts/hermes-shim/`, deferred behind Python runtime producer and audit. Effort: **8–12 ad**.

---

## 6. Decision Register D121 (Owner Questions and Recommendations)

The following architectural decisions are submitted to the owner for binding confirmation under register entry **D121**:

| ID | Decision Question | Context & Constraints | Options | Recommendation | Decided | Notes |
|---|---|---|---|---|---|---|
| **D121-J1** | Foreign Plugin Compatibility Strategy | Owner directed that OpenClaw and Hermes plugins should work where viable. D9 (`docs/superpowers/specs/2026-09-24-m1b-2a-core-daemon-cli-design.md:23`) explicitly mandates: *"Modules that would only work as an emulation are rewritten"* and quotes owner: *"nicht so wirken, als hätten wir … eine OpenClaw-Emulationsschicht gebaut … Wenn wir dann ein Modul neu schreiben müssen, dann müssen wir ein Modul neu schreiben."* D9 directly opposes an emulation shim. 75.0% (30/40) of top plugins are unconstrained tools, but after D106 duplicate denial (denying shell, fs, git, docker, sys, clipboard), viable tool coverage is **47.5% – 55.0% (19/40 – 22/40)**. | **Option B (Conditional D9 Reopening)**: Out-of-process stdio MCP bridge, tools only, no services in v1. D106 tool sandbox is runtime precondition; Q16 OS sandbox is production precondition. D9 explicitly reopened as a conscious exception for tool-kind plugins.<br>**Option A (Strict D9 Adherence)**: Status quo. Foreign plugins are not shimmed; valuable foreign tools are ported/rewritten natively as MCP servers or skills.<br>**Option C**: In-process emulation (rejected: violates security & D9). | **Adopt Option B conditionally if owner chooses to reopen D9**: Tools only, OpenClaw/Node first (X3b-a), no services in v1. Hermes/Python (X3b-b) deferred behind Python runtime producer and audit. Deny native duplicate tools (D106). Reopen D9 explicitly for tool-kind plugins. If the owner does not want to reopen D9, adopt Option A (native porting per D9). | Pending Owner | Preconditions: D106 sandbox (runtime); Q16 sandbox (production). |
| **D121-J2** | Lint Hygiene Allowlist & Shim Package Location | `scripts/lint-hygiene.mjs` enforces `HYG-001` (banning OpenClaw idioms). D9 requires keeping harness core clean of foreign idioms. | **Option A (Recommended)**: Place shim completely outside `packages/core` under `hosts/openclaw-shim/`. Allowlist only that host package. Zero OpenClaw idioms in `packages/core`.<br>**Option B**: Place adapter in `packages/core/src/adapters/` (rejected: violates D9 and HYG-001). | **Adopt Option A**: Dedicated package `hosts/openclaw-shim/`. No foreign idioms in `packages/core`. | Pending Owner | Preserves D9 integrity. |
| **D121-J3** | Default Instruction Conflict Resolution & Zone 2 Safety | When importing instructions into an agent with existing guidelines, how should conflicts resolve, and how is Zone 2 protected against prompt injection? | **Option A (Recommended for v1)**: In v1, instructions are presented in preview and report as `instructions-not-imported` (matching Paket O). No automated writes to Zone 2. Default `--conflict skip`.<br>**Option B**: Implement dedicated Rule Proposal Review Queue (P-J2e: Rust engine store + approval RPC + Web diff UI); `--conflict replace` creates a proposal flagged to replace existing content, requiring explicit operator approval before write.<br>**Option C**: Direct unconfirmed overwrite (`replace`) or concatenation (rejected: violates Zone 2 integrity and prompt cache). | **Adopt Option A for v1**: Default `skip`. In v1, instructions are reported as `instructions-not-imported` per Paket O; schedule P-J2e if automated proposal workflow is desired. Replace never bypasses preview. | Pending Owner | Aligned with Paket O and ADR-010. |
| **D121-J4** | Confidentiality and Memory Scope Defaults | Ingesting facts and memories into engine stores under D116 and ADR-007 Q4. | **Option A (Recommended)**: Default D116 confidentiality level is `vertraulich` (never `teilbar`). `scope: user` requires proved human principal; unauthenticated CLI calls fail with `unresolved-user-scope` (no fallback per ADR-007 Q4).<br>**Option B**: Import as `teilbar` or fallback to agent-private (rejected: potential data leak / scope breach). | **Adopt Option A**: Default `vertraulich`. Strict adherence to ADR-007 Q4 and Paket O. | Pending Owner | Follows D116 (6). |
| **D121-J5** | Source Scope Partitioning | Multiple overlapping import paths exist in the harness (M v2, Paket O, profile import). | **Option A (Recommended)**: Scope `plur1bus import profile` strictly to the new sources (5 direct file-based: Claude, Codex, Cursor, Kimi, AGY; Grok via user paste / prompt export; Grokbot dropped). Existing OpenClaw, Hermes, HM1, HM2 remain with existing M v2 importers.<br>**Option B**: Re-implement OpenClaw/Hermes in profile importer (rejected: code duplication). | **Adopt Option A**: Strict scope boundary. Sources 8–11 delegate to existing M v2 importers. | Pending Owner | Prevents parallel API surfaces. |
| **D121-J6** | Milestone Boundaries & ADR-019 / D120 Compliance | Sequencing and technology choice for implementation. | **Option A (Recommended)**: M7b, M7c, and X3b sit outside v0.1.0 total; X3b is post-v0.1.0. RPC minor assigned as next free at implementation time. All new components in Rust by Claude agents per D120 / ADR-019.<br>**Option B**: Implement bridge supervisor in TypeScript (rejected: violates D120 / ADR-019). | **Adopt Option A**: Rust components assigned to Claude agents. Milestones scheduled outside v0.1.0. | Pending Owner | Complies with ADR-019. |
