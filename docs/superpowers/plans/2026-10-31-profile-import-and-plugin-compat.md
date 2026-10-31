# Profile Import and Foreign Plugin Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans for the assigned worker lane; the parent coordinates the native supervisor, schema, remote-fs and UI lanes. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement profile import from 7 new AI coding and chat tools into PLUR1BUS Core, Rust CLI, and Web UI (`ImportWizard`), and establish an out-of-process foreign plugin bridge for OpenClaw and Hermes tools under strict policy gating.

**Architecture:** Profile import extends `admin.import.*` and the existing `SourceReader`, ledger, and rollback facilities without writing to source hosts. Archive intake uses a hardened Rust extractor in `crates/plur1bus-ext`. Foreign plugins run in dedicated out-of-process worker processes exposing tools as local MCP servers, gated by D109 `decide()` with tainted results and scrubbed environments. All new components are written in Rust by Claude agents per D120 / ADR-019; foreign runtime shims live outside `packages/core` under `hosts/`.

**Tech Stack:** Existing Node 24/Rust 1.95 workspace, existing Engine ports, `admin.import.*` RPC, `@plur1bus/remote-fs`, `crates/plur1bus-ext`, `crates/plur1bus-cli`, React / Tailwind Web UI.

**Spec & Register:** [`docs/superpowers/specs/2026-10-27-profile-import-and-plugin-compat-design.md`](../specs/2026-10-27-profile-import-and-plugin-compat-design.md), [`docs/research/2026-10-27-profile-and-extension-sources.md`](../../research/2026-10-27-profile-and-extension-sources.md), [`docs/import.md`](../../import.md), ADR-003, ADR-005, ADR-010, ADR-011, ADR-019 / D120, D121.

---

## 1. Global Constraints & Core Principles

1. **D120 / ADR-019 Compliance:** Every NEW component is implemented in Rust, called by the TypeScript Core over RPC. All Rust packages are assigned to Claude agents, never Codex.
2. **Foreign Runtime Shim Exception:** The Node compatibility shim (`hosts/openclaw-shim/`) and Python compatibility shim (`hosts/hermes-shim/`) are explicit exceptions to ADR-019 because they execute inside the foreign runtime and contain no PLUR1BUS harness logic.
3. **D9 Preservation:** D9 ("no OpenClaw idiom crosses the boundary", quoting the owner against an "OpenClaw-Emulationsschicht") is strictly respected. The OpenClaw compatibility shim lives completely outside `packages/core` under `hosts/openclaw-shim/`. `packages/core` contains zero OpenClaw idioms, and only the dedicated host package is added to `ALLOW_DIRS` for `HYG-001`.
4. **Read-Only Source Host Access:** In accordance with `docs/import.md:21`, source filesystem access is strictly read-only (`O_NOFOLLOW` / `ReadonlyFs`). The importer never modifies, disables, or writes to source installations. Post-import actions are emitted solely as recommendations in the report for the human operator.
5. **No Secret Migration & Strict Key Allowlisting (ADR-005, ADR-011):** Zero credential or token migration for the new sources. Credential files (`~/.codex/auth.json`, `~/.claude/.credentials.json`, Cursor auth tokens in `state.vscdb`) are prohibited from being opened or parsed. Automated spike-11 tests assert that no code path reads credential files. All parsers enforce strict field-allowlists. Imported MCP servers reuse `import.mcp-candidate/1` (slot names preserved, env/args scrubbed, disabled by default).
6. **D116 Confidentiality & User Scope:** All imported memories receive default confidentiality `vertraulich`, never `teilbar`. User-scoped memory cards require an authenticated, proven human principal (`trust: "proved"`); unauthenticated CLI invocations route to agent-private scope or reject with `unresolved-user-scope`.
7. **Deterministic Conflict Resolution:** Instruction conflict detection uses deterministic normalized SHA-256 hash matching (`matched-existing` -> skip) and normalized token overlap / Jaccard similarity (`RULE_CONFLICT`). No cloud LLM inference is used for conflict detection. Default strategy is `keep-existing` (mapped to `--conflict skip`). All imported instructions route through the `propose-rule` review queue.
8. **Hardened Archive Intake:** Archive intake rejects naive unpacking. Decompression stream-selects named entries, enforces a 10 MiB per-entry limit, a 10:1 decompression ratio ceiling, and forbids symlinks, hardlinks, and directory traversal (`..`). The implementation reuses the strict Rust ZIP/tar audit in `crates/plur1bus-ext`.
9. **Bridge Security & Sandbox Precondition:** Foreign plugins run in separate OS processes with scrubbed environments; all calls default to `external`/ask under D109 `decide()`; results are marked tainted; tools duplicating native exec/fs/git are denied (D106); plugin directories are pinned by SHA-256 and re-verified on start. Full kernel sandboxing (Q16) is a formal precondition for production bridge execution.
10. **Milestone Scoping:** Milestones M7b (10–15 ad), M7c (3–5 ad), and X3b (16–23 ad split into J4a and J4b) sit outside the v0.1.0 total. X3b is scheduled strictly post-v0.1.0.

---

## 2. Work Packages and Execution Matrix

| Package ID | Scope & Deliverables | Language | Executor | Estimate | Dependencies |
|---|---|---|---|---|---|
| **P-J1** | Research inventory, design specification, and implementation plan (D121). | Markdown | agy | 2 ad | None (Completed in PR #840) |
| **P-J2a** | Rust archive intake & security audit in `crates/plur1bus-ext`: stream-select, 10 MiB per-entry cap, 10:1 ratio ceiling, anti-zip-slip, symlink/hardlink ban for `.zip` and `.tar.gz`. | Rust | Claude Agent | 2–3 ad | P-J1 |
| **P-J2b** | Core profile parsers & mapping for 7 new sources (Claude, Codex, Cursor, Kimi, AGY/Gemini, Grok paste; Grokbot Telegram dropped) in `packages/core/src/import/profile/`: strict field-allowlists, `secret-file-names` protection, `import.mcp-candidate/1` integration, spike-11 credential ban test. | TypeScript | agy / Codex / Claude | 4–6 ad | P-J1, P-J2a |
| **P-J2c** | Conflict detection engine (SHA-256 + token overlap / Jaccard similarity, no cloud calls, default `keep-existing` / `skip`), `admin.import.*` RPC extensions (1.13.0), and Rust CLI `plur1bus import profile` integration. | TypeScript + Rust | Claude Agent (Rust CLI) / agy (TS Core) | 3–4 ad | P-J2b |
| **P-J2d** | Leak-sweep, redactor patterns (`sk-ant-`, JWT, OAuth refresh tokens), and offline test fixtures (synthetic non-Jina identities). | TypeScript | agy | 1–2 ad | P-J2b |
| **P-J3** | Web UI `ImportWizard` extension (M7c): add tiles for 7 new sources, component checklist, side-by-side rule conflict resolution screen, archive dropzone, report & rollback. | TypeScript / React | agy / Codex | 3–5 ad | P-J2c |
| **P-J4a** | Foreign plugin bridge runtime (OpenClaw/Node) — tools only, out-of-process stdio MCP server, Rust bridge supervisor (`crates/plur1bus-ext`), Node compatibility shim in `hosts/openclaw-shim/` (outside `packages/core`), D109 `decide()` policy integration, tainted results, scrubbed env, no services/commands/context rewriting in v1. Q16 sandbox as precondition. | Rust + Node.js | Claude Agent (Rust supervisor) / agy (shim) | 8–11 ad | P-J1, P-J2c, D121-J1, Q16 |
| **P-J4b** | Foreign plugin bridge runtime (Hermes/Python) — tools only, Python shim in `hosts/hermes-shim/`, blocked behind Python runtime producer and dependency audit. | Rust + Python | Claude Agent (Rust supervisor) / agy (shim) | 8–12 ad | P-J4a, Python runtime producer, audit allowlist |

---

## 3. Detailed Work Package Specifications

### P-J1: Specification and Plan (Spec J)
- **Files:** `docs/superpowers/specs/2026-10-27-profile-import-and-plugin-compat-design.md`, `docs/research/2026-10-27-profile-and-extension-sources.md`, `docs/superpowers/plans/2026-10-31-profile-import-and-plugin-compat.md`, `docs/import.md`, `docs/milestones.md`, `docs/web-ui.md`, `docs/superpowers/specs/2026-09-27-extensions-ecosystem-design.md`.
- **Tasks:**
  - [x] Survey eleven external ecosystems with verified path facts, formats, and access methods.
  - [x] Design mapping from external concepts to PLUR1BUS Zone 1, Zone 2, and Zone 3 structures.
  - [x] Formulate D121 Owner Decision Table with binding recommendations (D121-J1 to D121-J6).
  - [x] Validate with `check-doc-links.mjs` and `lint-hygiene.mjs`.

### P-J2a: Rust Archive Intake & Security Audit (`crates/plur1bus-ext`)
- **Assignee:** Claude Agent (Rust component per ADR-019 / D120).
- **Scope:** Provide safe archive inspection and extraction for `.zip` and `.tar.gz` export packages.
- **Constraints:**
  - Decompression ratio ceiling of 10:1 to prevent zip-bomb denial of service.
  - Maximum 10 MiB decompressed size per single entry; maximum 100 MiB total per archive.
  - Rejection of symlinks, hardlinks, absolute target paths, and path traversal components (`..`).
  - Selective extraction: extract only allowlisted filenames required by detected parsers; ignore unrelated archive contents.
- **Tasks:**
  - [ ] Implement `ArchiveAuditor` in `crates/plur1bus-ext/src/archive.rs`.
  - [ ] Expose C-ABI / RPC interface for Core integration.
  - [ ] Add unit tests for zip bomb, traversal attacks, nested symlinks, and corrupted headers.

### P-J2b: Core Profile Parsers & Mapping (`packages/core/src/import/profile/`)
- **Scope:** Parsers for the 7 new sources: Claude Code, OpenAI Codex, Cursor, Kimi, AGY/Gemini, Grok (paste only), and Grokbot (dropped/unsupported).
- **Constraints:**
  - Strict key-allowlist parsers: parse only documented configuration and rule keys; discard all unrecognized fields.
  - Credential file ban: never attempt to read or parse `auth.json`, `.credentials.json`, private keys, or session tokens.
  - Read-only filesystem operations using `SourceReader` and `O_NOFOLLOW`.
  - MCP server configs map to `import.mcp-candidate/1` (disabled by default, slot names kept, arguments and env values scrubbed).
  - Default confidentiality level `vertraulich` for all imported memory cards.
  - Instructions route to `propose-rule` review queue, never auto-activated.
- **Tasks:**
  - [ ] Implement source detectors and parsers in `packages/core/src/import/profile/`.
  - [ ] Write spike-11 test asserting that no code path attempts to read credential files.
  - [ ] Implement mapping to `SOUL.md`, `IDENTITY.md`, `USER.md`, and `AGENTS.md`.

### P-J2c: Conflict Engine, RPC & Rust CLI
- **Scope:** Side-by-side conflict detection, `admin.import.*` RPC methods, and `plur1bus import profile` CLI.
- **Constraints:**
  - Deterministic conflict detection: exact normalized SHA-256 match -> `matched-existing` (skip); normalized token overlap / Jaccard similarity -> `RULE_CONFLICT`.
  - Zero cloud model dependencies for conflict detection; optional local engine embedding if available.
  - Extend `admin.import.*` namespace (detect, plan, apply, rollback) with next free RPC minor (1.13.0).
  - Rust CLI `plur1bus import profile` with `--detect`, `--preview`, `--apply`, `--rollback`, and `--conflict` (`skip`, `rename`, `overwrite`; default `skip`). Exit codes conformed to `docs/errors.md`.
- **Tasks:**
  - [ ] Implement `RuleConflictDetector` in TypeScript core.
  - [ ] Extend `admin.import.*` RPC schemas and handler methods.
  - [ ] Implement `plur1bus import profile` CLI subcommand in `crates/plur1bus-cli`.

### P-J2d: Leak-Sweep, Redactor & Parity Fixtures
- **Scope:** Secrets redaction and test fixtures for all 7 sources.
- **Constraints:**
  - Extend redactor patterns for `sk-ant-`, JWT, OAuth refresh tokens.
  - Ensure synthetic, non-Jina embedding identities are used for all fixtures.
- **Tasks:**
  - [ ] Update `secret-file-names.ts` and redactor regexes.
  - [ ] Commit synthetic test fixtures for the 7 supported sources.
  - [ ] Run automated leak-sweep verification across test outputs and reports.

### P-J3: Web UI ImportWizard Extension (M7c)
- **Scope:** Extend `ImportWizard` (F37) to support profile import.
- **Tasks:**
  - [ ] Add source selection tiles for the 7 new tools alongside existing OpenClaw/Hermes/Packet O tiles.
  - [ ] Add granular component selection checklist (Persona, Instructions, User Facts, Skills, MCP).
  - [ ] Add side-by-side rule conflict resolution screen with Keep / Replace / Synthesize options.
  - [ ] Add archive drag-and-drop dropzone with client-side format validation.
  - [ ] Implement execution progress, download report (`report.json`), and one-click rollback.
  - [ ] Validate bilingual DE/EN accessibility with axe-core.

### P-J4a: Foreign Plugin Bridge Runtime — OpenClaw/Node (X3b-a)
- **Assignee:** Claude Agent (Rust supervisor per ADR-019) + agy (Node shim).
- **Scope:** Process-isolated MCP bridge for OpenClaw tool plugins.
- **Constraints:**
  - Tools only in v1: no services, no commands, no memory/channel/provider plugins, no context rewriting.
  - Rust bridge supervisor (`crates/plur1bus-ext`) manages worker lifecycle, process limits, and stdio pipes.
  - Node compatibility shim lives in `hosts/openclaw-shim/` (outside `packages/core`).
  - Gated by D109 `decide()`: default effect `external`/ask; results marked tainted; scrubbed environment.
  - Plugins duplicating native exec/fs/git tools are denied (D106).
  - Plugin tree pinned by SHA-256 and re-verified on start.
  - Q16 kernel sandbox is a precondition for production activation.
- **Tasks:**
  - [ ] Implement Rust bridge supervisor in `crates/plur1bus-ext`.
  - [ ] Implement minimal Node.js tool registration shim in `hosts/openclaw-shim/`.
  - [ ] Wire stdio MCP transport to Core MCP client with D109 `decide()` integration.
  - [ ] Create synthetic CI contract test suite using real top-20 OpenClaw tool plugin fixtures.

### P-J4b: Foreign Plugin Bridge Runtime — Hermes/Python (X3b-b)
- **Status:** DEFERRED behind Python runtime producer and dependency audit.
- **Scope:** Process-isolated MCP bridge for Hermes tool plugins.
- **Constraints:**
  - Requires pinned Python runtime producer (D58) and dependency audit clearance.
  - Python compatibility shim lives in `hosts/hermes-shim/`.
  - Same security and gating constraints as P-J4a.
- **Tasks:**
  - [ ] Implement Python tool registration shim in `hosts/hermes-shim/`.
  - [ ] Extend Rust supervisor to support Python virtual environment invocation.
  - [ ] Add CI contract tests with Hermes `@tool` fixtures.

---

## 4. Verification Gates and Acceptance Criteria

1. **Documentation Hygiene:**
   - `node scripts/check-doc-links.mjs`: Zero broken links or missing anchors.
   - `node scripts/lint-hygiene.mjs`: Clean (`hygiene ok`). Zero OpenClaw idioms in `packages/core`.
2. **Credential Safety Gate:**
   - Automated test proving that attempting to import a mock directory containing `auth.json` or `.credentials.json` never opens or reads those files.
3. **Deterministic Conflict Gate:**
   - Conflict tests verifying that identical rules skip (`matched-existing`), opposing rules trigger `RULE_CONFLICT`, and no external network/LLM calls are made during conflict resolution.
4. **Archive Safety Gate:**
   - Fuzz/unit tests asserting that zip-slip paths, decompression ratios > 10:1, and entries > 10 MiB are rejected with typed errors.
5. **Bridge Isolation Gate:**
   - Contract test asserting that an OpenClaw plugin attempting to register a memory provider or channel fails fast with `E_UNSUPPORTED_PLUGIN_KIND`.
   - Security test asserting that bridged tool execution inherits a scrubbed environment and emits tainted result metadata under D109.
