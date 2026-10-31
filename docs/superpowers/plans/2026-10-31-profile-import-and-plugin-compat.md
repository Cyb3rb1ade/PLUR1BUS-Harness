# Profile Import and Foreign Plugin Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans for the assigned worker lane; the parent coordinates the native supervisor, schema, remote-fs and UI lanes. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement profile import from 7 new AI coding and chat tools into PLUR1BUS Core, Rust CLI, and Web UI (`ImportWizard`), and establish an out-of-process foreign plugin bridge for OpenClaw and Hermes tools under strict policy gating.

**Architecture:** Profile import extends `admin.import.*` and the existing `SourceReader`, ledger, and rollback facilities without writing to source hosts. Archive intake uses a hardened Rust extractor in `crates/plur1bus-ext`. Foreign plugins run in dedicated out-of-process worker processes exposing tools as local MCP servers, gated by D109 `decide()` with tainted results and scrubbed environments. All new components are written in Rust by Claude agents per D120 / ADR-019; foreign runtime shims live outside `packages/core` under `hosts/`.

**Tech Stack:** Existing Node 24/Rust 1.95 workspace, existing Engine ports, `admin.import.*` RPC, `@plur1bus/remote-fs`, `crates/plur1bus-ext`, `crates/plur1bus-cli`, React / Tailwind Web UI.

**Spec & Register:** [`docs/superpowers/specs/2026-10-27-profile-import-and-plugin-compat-design.md`](../specs/2026-10-27-profile-import-and-plugin-compat-design.md), [`docs/research/2026-10-27-profile-and-extension-sources.md`](../../research/2026-10-27-profile-and-extension-sources.md), [`docs/import.md`](../../import.md), ADR-003, ADR-005, ADR-010, ADR-011, ADR-019 / D120, D121.

---

## 1. Global Constraints & Core Principles

1. **D120 / ADR-019 Compliance:** Every NEW component is implemented in Rust, called by the TypeScript Core over RPC. All Rust packages are assigned to Claude agents, never Codex. TypeScript work packages (P-J2b, P-J2c, P-J2d, P-J3) are justified under ADR-019 (3) as direct extensions of the existing TypeScript importer under `packages/core/src/import/`.
2. **Foreign Runtime Shim Exception:** The Node compatibility shim (`hosts/openclaw-shim/`) and Python compatibility shim (`hosts/hermes-shim/`) are explicit exceptions to ADR-019 because they execute inside the foreign runtime and contain no PLUR1BUS harness logic.
3. **D9 Reopening (D121-J1):** Decision D9 ([`docs/superpowers/specs/2026-09-24-m1b-2a-core-daemon-cli-design.md`](../specs/2026-09-24-m1b-2a-core-daemon-cli-design.md#2-owner-decisions-carried-in-2026-09-24), line 23) states: *"No OpenClaw idiom crosses the engine boundary into the harness. Where the engine offers only an OpenClaw-shaped path, the engine gets a real API and the adapter becomes its consumer. Modules that would only work as an emulation are rewritten"* and quotes the owner: *"nicht so wirken, als hätten wir … eine OpenClaw-Emulationsschicht gebaut … Wenn wir dann ein Modul neu schreiben müssen, dann müssen wir ein Modul neu schreiben."* D9 directly opposes an emulation shim and favors native module rewrites. Option B requires an explicit owner decision to reopen D9 as a conscious exception strictly for tool-kind plugins running out-of-process in a dedicated worker. The compatibility shim lives strictly outside `packages/core` under `hosts/openclaw-shim/`, leaving `packages/core` free of OpenClaw idioms under `HYG-001`.
4. **Read-Only Source Host Access:** In accordance with `docs/import.md:21`, source filesystem access is strictly read-only (`O_NOFOLLOW` / `ReadonlyFs`). The importer never modifies, disables, or writes to source installations. Post-import actions are emitted solely as recommendations in the report for the human operator.
5. **No Secret Migration & Strict Key Allowlisting (ADR-005, ADR-011):** Zero credential or token migration for the new sources. Credential files (`~/.codex/auth.json`, `~/.claude/.credentials.json`, Cursor `state.vscdb`) are prohibited from being opened or read. Automated spike-11 tests assert that no code path opens or reads credential files. Mixed file `~/.claude.json` is read strictly via a streaming key-allowlist extractor for `mcpServers` only; all other keys are immediately dropped. The desktop helper `host.importSnapshot` applies a producer-side allowlist filtering out credential patterns before archiving. Imported MCP servers reuse `import.mcp-candidate/1` (slot names preserved, env/args scrubbed, disabled by default).
6. **D116 Confidentiality & User Scope:** All imported memories receive default confidentiality `vertraulich`, never `teilbar`. User-scoped memory cards require an authenticated, proven human principal (`trust: "proved"`); unauthenticated CLI invocations fail with `unresolved-user-scope` (no automatic fallback to agent-private scope per ADR-007 Q4).
7. **Deterministic Conflict Resolution & Zone 2 Safety:** Instruction conflict detection uses deterministic normalized SHA-256 hash matching (`matched-existing` -> skip) and normalized token overlap / Jaccard similarity (`RULE_CONFLICT`). No cloud LLM inference is used for conflict detection. Strategy options: `--conflict skip | rename | replace` (default `skip`). In v1, imported instructions are presented in preview and report as `instructions-not-imported` per Paket O to prevent unconfirmed prompt injection; `--conflict replace` never performs an unreviewed write to Zone 2.
8. **Hardened Selective Archive Intake:** Archive intake in `plur1bus-tools` (or worker child `plur1bus ext __worker` per X1-R2) stream-selects named entries, enforces a 10 MiB per-entry limit, 100 MiB total uncompressed bytes, a 100:1 decompression ratio ceiling (matching `zipaudit`), and forbids symlinks, hardlinks, absolute paths, directory traversal (`..`), and nested archives.
9. **Bridge Security & Sandbox Preconditions:** Foreign plugins run in separate OS processes with scrubbed environments; all calls default to `external`/ask under D109 `decide()`; results are marked tainted; tools duplicating native exec/fs/git/docker/sys/clipboard are denied (D106); plugin directories are pinned by SHA-256 and re-verified on start. Runtime precondition: D106 tool sandbox (`tools.sandbox.required: true`, `sandboxSpawn`); production precondition: full Q16 OS kernel sandboxing.
10. **Milestone Scoping:** Milestones M7b (10–15 ad), M7c (3–5 ad), and X3b (16–23 ad split into J4a and J4b) sit outside the v0.1.0 total. X3b is scheduled strictly post-v0.1.0.

---

## 2. Work Packages and Execution Matrix

| Package ID | Scope & Deliverables | Language | Executor | Estimate | Dependencies |
|---|---|---|---|---|---|
| **P-J1** | Research inventory, design specification, and implementation plan (D121). | Markdown | agy | 2 ad | None (Completed in PR #840) |
| **P-J2a** | Rust archive intake & security audit in `plur1bus-tools` / `crates/plur1bus-ext`: stream-select, 10 MiB per-entry cap, 100 MiB total, 100:1 ratio ceiling, anti-zip-slip, symlink/hardlink ban for `.zip` and `.tar.gz`. Called over harness RPC. | Rust | Claude Agent | 2–3 ad | P-J1 |
| **P-J2b** | Core profile parsers & mapping for new sources in `packages/core/src/import/profile/`: strict field-allowlists, `~/.claude.json` streaming extractor, `secret-file-names` protection, `import.mcp-candidate/1` integration, spike-11 credential ban test. Justified under ADR-019 (3). | TypeScript | agy / Codex / Claude | 4–6 ad | P-J1 |
| **P-J2c** | Conflict detection engine (SHA-256 + token overlap / Jaccard similarity, no cloud calls, options `skip` / `rename` / `replace`), `admin.import.*` RPC extensions (next free RPC minor version), and Rust CLI `plur1bus import profile`. Justified under ADR-019 (3). | TypeScript + Rust | Claude Agent (Rust CLI) / agy (TS Core) | 3–4 ad | P-J2b |
| **P-J2d** | Leak-sweep, redactor patterns (`sk-ant-`, JWT, OAuth refresh tokens), and offline test fixtures (synthetic non-Jina identities). Justified under ADR-019 (3). | TypeScript | agy | 1–2 ad | P-J2b |
| **P-J2e** | Optional Rule Proposal Review Queue & Zone 2 Curated Writer: Rust engine queue store in `crates/plur1bus-engine`, proposal RPC under `admin.import.*`, review UI in `ImportWizard`, and safe curated file writer with snapshot/ledger. | Rust + TypeScript | Claude Agent (Rust store) / agy (TS RPC & UI) | 2–3 ad | P-J2c, D121-J3 (Option B) |
| **P-J3** | Web UI `ImportWizard` extension (M7c): add tiles for new tools, component checklist, side-by-side rule conflict resolution screen, archive dropzone, report & rollback. Justified under ADR-019 (3). | TypeScript / React | agy / Codex | 3–5 ad | P-J2c |
| **P-J4a** | Foreign plugin bridge runtime (OpenClaw/Node) — tools only, local stdio MCP server extension, Node compatibility shim in `hosts/openclaw-shim/` (outside `packages/core`), D109 `decide()` policy integration, tainted results, scrubbed env, no services/commands/context rewriting in v1. D106 tool sandbox is runtime precondition; Q16 sandbox is production precondition. | Rust + Node.js | Claude Agent (Rust sandbox) / agy (shim) | 8–11 ad | X1–X3, D106 tool sandbox, D121-J1 |
| **P-J4b** | Foreign plugin bridge runtime (Hermes/Python) — tools only, Python shim in `hosts/hermes-shim/`, blocked behind Python runtime producer and dependency audit. | Rust + Python | Claude Agent (Rust sandbox) / agy (shim) | 8–12 ad | P-J4a, Python runtime producer, audit allowlist |

---

## 3. Detailed Work Package Specifications

### P-J1: Specification and Plan (Spec J)
- **Files:** `docs/superpowers/specs/2026-10-27-profile-import-and-plugin-compat-design.md`, `docs/research/2026-10-27-profile-and-extension-sources.md`, `docs/superpowers/plans/2026-10-31-profile-import-and-plugin-compat.md`, `docs/import.md`, `docs/milestones.md`, `docs/web-ui.md`, `docs/superpowers/specs/2026-09-27-extensions-ecosystem-design.md`.
- **Tasks:**
  - [x] Survey eleven external ecosystems with verified path facts, formats, and access methods.
  - [x] Design mapping from external concepts to PLUR1BUS Zone 1, Zone 2, and Zone 3 structures.
  - [x] Formulate D121 Owner Decision Table with binding recommendations (D121-J1 to D121-J6).
  - [x] Validate with `check-doc-links.mjs` and `lint-hygiene.mjs`.

### P-J2a: Rust Archive Intake & Security Audit (`plur1bus-tools` / `crates/plur1bus-ext`)
- **Assignee:** Claude Agent (Rust component per ADR-019 / D120).
- **Scope:** Provide safe selective archive inspection and extraction for `.zip` and `.tar.gz` export packages, invoked over harness RPC through `plur1bus-tools` (or worker child `plur1bus ext __worker` per X1-R2; HYG-007–010) with JSON Schema types.
- **Constraints:**
  - Decompression ratio ceiling of 100:1 (matching `zipaudit`) to prevent compression bombs while allowing valid sparse JSON exports.
  - Maximum 10 MiB decompressed size per single entry; maximum 100 MiB total uncompressed bytes per archive.
  - Rejection of symlinks, hardlinks, absolute target paths, directory traversal components (`..`), and nested archives.
  - Selective extraction: stream-selects only allowlisted filenames required by detected parsers; ignores and skips unrelated entries without decompressing them; supports ZIP64 and `.tar.gz` via streaming unpacker.
- **Tasks:**
  - [ ] Implement `ArchiveAuditor` in `plur1bus-tools` / `crates/plur1bus-ext/src/archive.rs`.
  - [ ] Expose harness RPC interface with JSON Schema types for Core integration (ADR-019 (1)).
  - [ ] Add unit tests for zip bomb, traversal attacks, nested symlinks, and corrupted headers.

### P-J2b: Core Profile Parsers & Mapping (`packages/core/src/import/profile/`)
- **Scope:** Parsers for the new sources: Claude Code, OpenAI Codex, Cursor, Kimi, AGY/Gemini via direct file intake; Grok via user paste / prompt export; Grokbot dropped/unsupported. Justified under ADR-019 (3) as a direct extension of the existing TypeScript importer under `packages/core/src/import/`.
- **Constraints:**
  - Strict key-allowlist parsers: parse only documented configuration and rule keys; discard all unrecognized fields.
  - Credential file ban: never attempt to open or read `auth.json`, `.credentials.json`, private keys, or session tokens. Cursor `state.vscdb` is strictly prohibited from being opened or read (Cursor user rules come in via paste/file drop).
  - Mixed file handling: `~/.claude.json` is read strictly through a streaming key-allowlist extractor for `mcpServers` only; all other keys (`oauth_tokens`, `account`, `session`) are immediately dropped.
  - Producer-side snapshot allowlist: `host.importSnapshot` applies an allowlist of named configuration files on the host, excluding files matching credential patterns before archive creation (D90/D2).
  - Read-only filesystem operations using `SourceReader` and `O_NOFOLLOW`.
  - MCP server configs map to `import.mcp-candidate/1` (disabled by default, slot names kept, arguments and env values scrubbed).
  - Default confidentiality level `vertraulich` for all imported memory cards.
  - User-scoped memories require an authenticated proved human principal; unauthenticated CLI calls fail with `unresolved-user-scope` (no fallback to agent-private scope per ADR-007 Q4).
  - In v1, instructions are presented in preview and report as `instructions-not-imported` per Paket O to prevent unconfirmed prompt injection.
- **Tasks:**
  - [ ] Implement source detectors and parsers in `packages/core/src/import/profile/`.
  - [ ] Implement streaming key-allowlist parser for `~/.claude.json`.
  - [ ] Write spike-11 test asserting that no code path attempts to read credential files.
  - [ ] Add mixed-file sentinel test proving non-`mcpServers` fields never leak into logs, reports, or output.
  - [ ] Implement mapping to `SOUL.md`, `IDENTITY.md`, `USER.md`, and `AGENTS.md`.

### P-J2c: Conflict Engine, RPC & Rust CLI
- **Scope:** Side-by-side conflict detection, `admin.import.*` RPC methods, and `plur1bus import profile` CLI. Justified under ADR-019 (3) as an extension of the existing TypeScript import pipeline.
- **Constraints:**
  - Deterministic conflict detection: exact normalized SHA-256 match -> `matched-existing` (skip); normalized token overlap / Jaccard similarity -> `RULE_CONFLICT`.
  - Zero cloud model dependencies for conflict detection; optional local engine embedding if available. Semantic opposition sharing no tokens is surfaced via side-by-side operator review.
  - Extend `admin.import.*` namespace (detect, plan, apply, rollback) with the next free RPC minor version at implementation time.
  - Rust CLI `plur1bus import profile` with `--detect`, `--preview`, `--apply`, `--rollback`, and `--on-conflict` (alias `--conflict`, options: `skip`, `rename`, `replace`; default `skip`).
  - Semantics: `skip` drops incoming entry; `rename` writes suffixed copy (e.g. `SOUL.imported-<source>.md`); `replace` in v1 creates a reviewed proposal and never overwrites Zone 2 without operator preview.
  - Exit codes conformed to `docs/errors.md` and `docs/import.md`: pass-through 1..255; unreadable source reports `source-unreadable` with exit 1.
- **Tasks:**
  - [ ] Implement `RuleConflictDetector` in TypeScript core (ADR-019 (3) extension).
  - [ ] Extend `admin.import.*` RPC schemas and handler methods.
  - [ ] Implement `plur1bus import profile` CLI subcommand in `crates/plur1bus-cli`.

### P-J2d: Leak-Sweep, Redactor & Parity Fixtures
- **Scope:** Secrets redaction and test fixtures for all supported sources. Justified under ADR-019 (3).
- **Constraints:**
  - Extend redactor patterns for `sk-ant-`, JWT, OAuth refresh tokens, and private key blocks in `packages/core/src/logs/redact.ts` (ported from Rust `redact.rs`).
  - Ensure synthetic, non-Jina embedding identities are used for all fixtures.
- **Tasks:**
  - [ ] Update `secret-file-names.ts` and port redactor regexes to `packages/core/src/logs/redact.ts`.
  - [ ] Commit synthetic test fixtures for supported sources.
  - [ ] Run automated leak-sweep verification across test outputs and reports.

### P-J2e: Rule Proposal Review Queue & Zone 2 Curated Writer (Optional / Conditional on D121-J3 Option B)
- **Assignee:** Claude Agent (Rust queue store in `crates/plur1bus-engine` per ADR-019) / agy (TS RPC & UI per ADR-019 (3)).
- **Scope:** Dedicated store for quarantined rule proposals, RPC under `admin.import.*`, review UI in `ImportWizard`, and transactional curated file writer (`AGENTS.md` / `SOUL.md`) with snapshot and ledger.
- **Constraints:**
  - Rule proposals stored in engine queue until explicitly approved or rejected by operator.
  - Approve action creates snapshot, writes curated file with ledger entry, and invalidates prompt cache cleanly from BP2 downwards.
  - Estimate: 2–3 ad. Dependencies: P-J2c, D121-J3 (Option B).
- **Tasks:**
  - [ ] Implement rule proposal store in `crates/plur1bus-engine`.
  - [ ] Expose `admin.import.proposals.*` RPC methods.
  - [ ] Add review & diff screen in `ImportWizard`.
  - [ ] Implement atomic curated file writer with rollback snapshot.

### P-J3: Web UI ImportWizard Extension (M7c)
- **Scope:** Extend `ImportWizard` ([`docs/web-ui.md`](../../web-ui.md) F37) to support profile import. Justified under ADR-019 (3).
- **Tasks:**
  - [ ] Add source selection tiles for the new tools alongside existing OpenClaw/Hermes/Packet O tiles.
  - [ ] Add granular component selection checklist (Persona, Instructions, User Facts, Skills, MCP).
  - [ ] Add side-by-side rule conflict resolution screen with Keep / Replace / Synthesize options.
  - [ ] Add archive drag-and-drop dropzone with client-side format validation.
  - [ ] Implement execution progress, download report (`report.json`), and one-click rollback.
  - [ ] Validate bilingual DE/EN accessibility with axe-core.

### P-J4a: Foreign Plugin Bridge Runtime — OpenClaw/Node (X3b-a)
- **Assignee:** Claude Agent (Rust sandbox integration per ADR-019) + agy (Node shim).
- **Scope:** Process-separated stdio MCP bridge for OpenClaw tool plugins.
- **Constraints:**
  - Tools only in v1: no services, no commands, no memory/channel/provider plugins, no context rewriting.
  - Bridge packaged as an unsigned local stdio `mcp-server` extension, reusing existing core MCP client runtime (`docs/mcp-client.md`: command allowlisting, scrubbed env, 1 MiB frame cap, restart on next use).
  - Node compatibility shim lives in `hosts/openclaw-shim/` (outside `packages/core`).
  - Gated by D109 `decide()`: default effect `external`/ask; results marked tainted; scrubbed environment.
  - Plugins duplicating native exec/fs/git/docker/sys/clipboard tools are denied (D106).
  - Plugin tree pinned by SHA-256 and re-verified on start (Extensions Spec §8.7). Disabled if `extensions.allowUnsigned=false`.
  - Only pure-JS plugins with vendored dependencies accepted in v1 (tier `unsigned` with §8.3 acknowledgment and §8.7 hash); native addons classified `nonportable`.
  - Honest isolation disclaimer: unsandboxed plugin code has the OS user's full fs, network, and process authority, and MCP is only the invocation channel.
  - Runtime Precondition: D106 tool sandbox (`tools.sandbox.required: true`, `sandboxSpawn`). Bridge refuses to launch without D106 tool sandbox on platforms requiring sandboxing.
  - Production Precondition: Q16 OS container sandbox is formal precondition for general production activation.
- **Dependencies:** `X1–X3, D106 tool sandbox, D121-J1`.
- **Tasks:**
  - [ ] Implement minimal Node.js tool registration shim in `hosts/openclaw-shim/`.
  - [ ] Wire stdio MCP transport to Core MCP client with D109 `decide()` integration.
  - [ ] Add D106 sandbox verification test proving bridge refuses to start when sandbox is unavailable.
  - [ ] Create synthetic CI contract test suite using illustrative OpenClaw tool plugin fixtures.

### P-J4b: Foreign Plugin Bridge Runtime — Hermes/Python (X3b-b)
- **Status:** DEFERRED behind Python runtime producer and dependency audit.
- **Scope:** Process-separated MCP bridge for Hermes tool plugins.
- **Constraints:**
  - Requires pinned Python runtime producer (D58) and dependency audit clearance.
  - Python compatibility shim lives in `hosts/hermes-shim/`.
  - Same security, D106 sandbox runtime precondition, and gating constraints as P-J4a. Unconfirmed Hermes APIs marked [**U**].
- **Tasks:**
  - [ ] Implement Python tool registration shim in `hosts/hermes-shim/`.
  - [ ] Extend bridge launcher to support Python virtual environment invocation.
  - [ ] Add CI contract tests with synthetic Hermes tool fixtures.

---

## 4. Verification Gates and Acceptance Criteria

1. **Documentation Hygiene:**
   - `node scripts/check-doc-links.mjs`: Zero broken links or missing anchors.
   - `node scripts/lint-hygiene.mjs`: Clean (`hygiene ok`). Zero OpenClaw idioms in `packages/core`.
2. **Credential Safety Gate:**
   - Automated spike-11 test asserting that attempting to import a mock directory containing `auth.json` or `.credentials.json` never opens or reads those files.
   - Mixed-file test for `~/.claude.json`: seed sentinel secrets into non-allowlisted keys and assert they never appear in any output, report, or log.
   - Assert `state.vscdb` is never opened, read, or parsed.
   - Producer-side snapshot allowlist test verifying `host.importSnapshot` excludes credential filenames before archiving.
3. **Deterministic Conflict Gate:**
   - Conflict tests verifying that identical rules skip (`matched-existing`), near-duplicate rules trigger `RULE_CONFLICT`, and no external network/LLM calls are made during conflict resolution. Semantic opposition sharing no tokens is surfaced for operator review.
4. **Archive Safety Gate:**
   - Fuzz/unit tests asserting that zip-slip paths, decompression ratios > 100:1, entries > 10 MiB, archives > 100 MiB uncompressed, and symlinks/hardlinks are rejected with typed errors.
5. **Bridge Execution & Sandbox Refusal Gate:**
   - Contract test asserting that an OpenClaw plugin attempting to register a memory provider or channel fails fast with `E_UNSUPPORTED_PLUGIN_KIND`.
   - Security test asserting that bridged tool execution inherits a scrubbed environment and emits tainted result metadata under D109 `decide()`.
   - Precondition test proving the bridge refuses to start with `sandbox-unavailable` when the D106 tool sandbox is absent on platforms requiring it.
6. **Read-Only Source & Scope Gate:**
   - Test asserting that source filesystem access is strictly read-only (`O_NOFOLLOW`) and never modifies source directories.
   - Test asserting that unauthenticated CLI imports produce `rejected/unresolved-user-scope` without automatic fallback to agent-private scope.
   - Test asserting the bridge is disabled when `extensions.allowUnsigned=false`.
   - Register new error codes `E_UNSUPPORTED_PLUGIN_KIND` and `RULE_CONFLICT` in `docs/errors.md` and CLI exit code mappings.
