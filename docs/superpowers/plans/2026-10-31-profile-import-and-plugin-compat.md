# Profile Import and Foreign Plugin Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans for the assigned worker lane; the parent coordinates the native supervisor, schema, remote-fs and UI lanes. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement profile import from 7 new AI coding and chat tools into PLUR1BUS Core, Rust CLI (`crates/plur1bus`), and Web UI (`ImportWizard`), and establish read-only foreign plugin manifest discovery and a native port pipeline per Owner Decisions D121 and D9.

**Architecture:** Profile import extends `admin.import.*` and the existing `SourceReader`, ledger, and rollback facilities without writing to source hosts. Archive intake uses a hardened Rust extractor in `plur1bus-tools`. Foreign plugin compatibility strictly avoids emulation shims and execution bridges, upholding Decision D9 (*"Modules that would only work as an emulation are rewritten"*). Compatibility is achieved through read-only manifest discovery during import (4-way classification, local demand counting without telemetry) and a 6-stage native port pipeline (license check, target form [Skill, MCP, `plur1bus-tools` module], behavior tests, D109 capability declarations, human review, signed catalog distribution vs. sandboxed local ports from `plur1bus code`). All new Rust components are implemented by Claude agents per D120 / ADR-019 (1); TypeScript core extensions are justified under ADR-019 (3); the Web UI SPA is justified under ADR-019 (4).

**Tech Stack:** Existing Node 24/Rust 1.95 workspace, existing Engine ports, `admin.import.*` RPC, `@plur1bus/remote-fs`, `crates/plur1bus-tools`, `crates/plur1bus`, React / Tailwind Web UI.

**Spec & Register:** [`docs/superpowers/specs/2026-10-27-profile-import-and-plugin-compat-design.md`](../specs/2026-10-27-profile-import-and-plugin-compat-design.md), [`docs/research/2026-10-27-profile-and-extension-sources.md`](../../research/2026-10-27-profile-and-extension-sources.md), [`docs/import.md`](../../import.md), ADR-003, ADR-005, ADR-010, ADR-011, ADR-019 / D120, D121.

---

## 1. Global Constraints & Core Principles

1. **D120 / ADR-019 Compliance:** Every NEW component is implemented in Rust, called by the TypeScript Core over RPC. All Rust packages are assigned to Claude agents, never Codex. TypeScript work packages (P-J2b, P-J2c, P-J2d, P-J4a) are justified under ADR-019 (3) as direct extensions of the existing TypeScript importer under `packages/core/src/import/`. The Web UI SPA (P-J3) is justified under ADR-019 (4).
2. **Decision D9 and Owner Decision D121-J1:** Decision D9 ([`docs/superpowers/specs/2026-09-24-m1b-2a-core-daemon-cli-design.md`](../specs/2026-09-24-m1b-2a-core-daemon-cli-design.md#2-owner-decisions-carried-in-2026-09-24), line 23) states verbatim: *"No OpenClaw idiom crosses the engine boundary into the harness. Where the engine offers only an OpenClaw-shaped path, the engine gets a real API and the adapter becomes its consumer. Modules that would only work as an emulation are rewritten"* and quotes the owner: *"nicht so wirken, als hätten wir … eine OpenClaw-Emulationsschicht gebaut … Wenn wir dann ein Modul neu schreiben müssen, dann müssen wir ein Modul neu schreiben."* In accordance with Owner Decision D121-J1 (decided 2026-10-31), no compatibility shims or execution bridges are built. Foreign plugin compatibility is achieved exclusively via native ports and read-only manifest discovery during import. `packages/core` remains 100% clean of OpenClaw idioms under `HYG-001`.
3. **Read-Only Source Host Access:** In accordance with `docs/import.md:21`, source filesystem access is strictly read-only (`O_NOFOLLOW` / `ReadonlyFs`). The importer never modifies, disables, or writes to source installations. Post-import actions are emitted solely as recommendations in the report for the human operator.
4. **No Secret Migration & Strict Key Allowlisting (ADR-005, ADR-011):** Zero credential or token migration for the new sources. Credential files (`~/.codex/auth.json`, `~/.claude/.credentials.json`, Cursor `state.vscdb`) are prohibited from being opened or read. Automated spike-11 tests assert that no code path opens or reads credential files. Mixed file `~/.claude.json` is read strictly via a streaming key-allowlist extractor for `mcpServers` only; non-allowlisted keys are never retained or emitted. The desktop helper `host.importSnapshot` applies a producer-side key allowlist running the same extractors on the host and emits only extracted fields, excluding files matching credential patterns before transmission (R3-M3). Imported MCP servers reuse `import.mcp-candidate/1` (slot names preserved, env/args scrubbed, disabled by default).
5. **D116 Confidentiality & User Scope:** All imported memories receive default confidentiality `vertraulich`, never `teilbar`. User-scoped memory cards require an authenticated, proven human principal (`trust: "proved"`); unauthenticated CLI invocations fail with `unresolved-user-scope` (no automatic fallback to agent-private scope per ADR-007 Q4).
6. **Deterministic Conflict Resolution & Zone 2 Safety (N1):** Instruction conflict detection uses deterministic normalized SHA-256 hash matching (`matched-existing` -> skip) and normalized token overlap / Jaccard similarity (`RULE_CONFLICT`). No cloud LLM inference is used for conflict detection. Strategy options: `--conflict skip | rename | replace` (default `skip`). In v1 under D121-J3 Option A:
   - `--conflict` applies strictly to skills, MCP entries, and memory cards.
   - Persona definitions and operating instructions are presented in preview and report as `instructions-not-imported` per Paket O with read-only copy-out.
   - The importer never automatically writes, renames, replaces, or concatenates into Zone 2 files (`SOUL.md` or `AGENTS.md`).
   - Input payload bounds: 512 KiB total input (`MAX_INPUT_BYTES`) and 4 000 characters per entry text (`MAX_ENTRY_CHARS`).
7. **Hardened Selective Archive Intake (M5):** Archive intake in `plur1bus-tools` stream-selects named entries, enforces a 10 MiB per-entry limit, 100 MiB total uncompressed bytes, a 100:1 decompression ratio ceiling (matching `zipaudit`), and forbids symlinks, hardlinks, absolute paths, directory traversal (`..`), and nested archives. For sequential `.tar.gz` streams, all decompressed bytes count towards the ratio ceiling and total caps.
8. **Plugin Manifest Discovery during Import:** Scans plugin manifests only (`openclaw.plugin.json`, `package.json`, `plugin.yaml`), executing zero foreign code. Maps discovered plugins to 4 categories: 1. Native equivalent available, 2. Known MCP server available, 3. Candidate for port, 4. Non-portable (with reason). Displays findings in preview and report. Local demand counter is incremented strictly on the user's machine without telemetry.
9. **Native Port Pipeline:** 6-stage structured procedure: 1. License audit (permissive ok, copyleft as standalone add-on under same license, unlicensed prohibited), 2. Target form selection (Skill, MCP config, `plur1bus-tools` module), 3. Behavior-derived tests, 4. D109 capability declarations, 5. 4-eyes human review, 6. Signed catalog distribution vs. sandboxed local ports from `plur1bus code`.
10. **Milestone Scoping:** Milestones M7b (10–15 ad), M7c (3–5 ad), and X3b (6–10 ad) sit outside the v0.1.0 total.

---

## 2. Work Packages and Execution Matrix

| Package ID | Scope & Deliverables | Language | Executor | Estimate | Dependencies |
|---|---|---|---|---|---|
| **P-J1** | Research inventory, design specification, and implementation plan (D121). | Markdown | agy | 2 ad | None (Completed in PR #840) |
| **P-J2a** | Rust archive intake & security audit in `plur1bus-tools`: stream-select, 10 MiB per-entry cap, 100 MiB total, 100:1 ratio ceiling, anti-zip-slip, symlink/hardlink ban for `.zip` and `.tar.gz`. Called over harness RPC. | Rust | Claude Agent | 2–3 ad | P-J1 |
| **P-J2b** | Core profile parsers & mapping for new sources in `packages/core/src/import/profile/`: strict field-allowlists, `~/.claude.json` streaming extractor, `secret-file-names` protection, `import.mcp-candidate/1` integration, spike-11 credential ban test. Justified under ADR-019 (3). | TypeScript | agy / Codex / Claude | 4–6 ad | P-J1 |
| **P-J2c** | Conflict detection engine (SHA-256 + token overlap / Jaccard similarity for skills/MCP/memory, options `skip` / `rename` / `replace`), `admin.import.*` RPC extensions (next free RPC minor version), and Rust CLI `plur1bus import profile` in `crates/plur1bus`. Justified under ADR-019 (3). | TypeScript + Rust | Claude Agent (Rust CLI) / agy (TS Core) | 3–4 ad | P-J2b |
| **P-J2d** | Leak-sweep, redactor patterns (`sk-ant-`, JWT, OAuth refresh tokens), and offline test fixtures (synthetic non-Jina identities). Justified under ADR-019 (3). | TypeScript | agy | 1–2 ad | P-J2b |
| **P-J3** | Web UI `ImportWizard` extension (M7c): add tiles for new tools, component checklist, side-by-side conflict resolution screen (skills/MCP/memory), read-only copy-out for persona/instructions, archive dropzone, report & rollback. Justified under ADR-019 (4). | TypeScript / React | agy / Codex | 3–5 ad | P-J2c |
| **P-J4a** | Plugin manifest discovery in import: read-only scanning of `openclaw.plugin.json`, `package.json`, `plugin.yaml`; deterministic 4-way classification; preview and report integration; local demand counter (`plugin-demand.json`, zero telemetry). Justified under ADR-019 (3). | TypeScript | agy / Codex | 2–3 ad | P-J2b |
| **P-J4b** | Port pipeline tooling & validation in `plur1bus-tools`: license auditor (permissive vs. copyleft vs. unlicensed), target form selector (Skill, MCP, module), D109 capability validator, behavior test suite runner. Justified under ADR-019 (1). | Rust | Claude Agent | 2–3 ad | P-J4a |
| **P-J4c** | Initial native ports: First wave of native ports based on local demand (Skills, MCP configs, or tools), clean-room behavior tests, D109 declarations, 4-eyes human review. | TypeScript / Rust | agy / Claude Agent | 3–5 ad | P-J4b |
| **P-J4d** | Integration in `plur1bus code`: Operator workflow for local unsigned ports, sandboxed execution, gated by D120 milestone. | Rust / TypeScript | Claude Agent / agy | 2–3 ad | P-J4c, D120 |

---

## 3. Detailed Work Package Specifications

### P-J1: Specification and Plan (Spec J)
- **Files:** `docs/superpowers/specs/2026-10-27-profile-import-and-plugin-compat-design.md`, `docs/research/2026-10-27-profile-and-extension-sources.md`, `docs/superpowers/plans/2026-10-31-profile-import-and-plugin-compat.md`, `docs/import.md`, `docs/milestones.md`, `docs/superpowers/specs/2026-09-27-extensions-ecosystem-design.md`.
- **Tasks:**
  - [x] Survey eleven external ecosystems with verified path facts, formats, and access methods.
  - [x] Design mapping from external concepts to PLUR1BUS Zone 1, Zone 2, and Zone 3 structures.
  - [x] Formulate D121 Owner Decision Table with binding owner decisions (D121-J1 to D121-J6).
  - [x] Validate with `check-doc-links.mjs`, `lint-hygiene.mjs`, and `pnpm docs:check`.

### P-J2a: Rust Archive Intake & Security Audit (`plur1bus-tools`)
- **Assignee:** Claude Agent (Rust component per ADR-019 / D120).
- **Scope:** Provide safe selective archive inspection and extraction for `.zip` and `.tar.gz` export packages, invoked over harness RPC through `plur1bus-tools` with JSON Schema types.
- **Constraints:**
  - Decompression ratio ceiling of 100:1 (matching `zipaudit`) to prevent compression bombs while allowing valid sparse JSON exports.
  - Maximum 10 MiB decompressed size per single entry; maximum 100 MiB total uncompressed bytes per archive.
  - Rejection of symlinks, hardlinks, absolute target paths, directory traversal components (`..`), and nested archives.
  - Selective extraction: stream-selects only allowlisted filenames required by detected parsers; for `.tar.gz`, sequential stream decompresses through memory and counts all processed bytes against the caps.
- **Tasks:**
  - [ ] Implement `ArchiveAuditor` in `crates/plur1bus-tools/src/archive.rs`.
  - [ ] Expose harness RPC interface with JSON Schema types for Core integration (ADR-019 (1)).
  - [ ] Add unit tests for zip bomb, traversal attacks, nested symlinks, and corrupted headers.

### P-J2b: Core Profile Parsers & Mapping (`packages/core/src/import/profile/`)
- **Scope:** Parsers for the new sources: Claude Code, OpenAI Codex, Cursor, Kimi, AGY/Gemini via direct file intake; Grok via user paste / prompt export; Grokbot dropped/unsupported. Justified under ADR-019 (3) as a direct extension of the existing TypeScript importer under `packages/core/src/import/`.
- **Constraints:**
  - Strict key-allowlist parsers: parse only documented configuration and rule keys; discard all unrecognized fields.
  - Credential file ban: never attempt to open or read `auth.json`, `.credentials.json`, private keys, or session tokens. Cursor `state.vscdb` is strictly prohibited from being opened or read (Cursor user rules come in via paste/file drop).
  - Mixed file handling: `~/.claude.json` is read strictly through a streaming key-allowlist extractor for `mcpServers` only; all other keys (`oauth_tokens`, `account`, `session`) are immediately dropped.
  - Producer-side snapshot allowlist: `host.importSnapshot` runs the same extractors on the host and transmits only extracted fields, excluding files matching credential patterns before archive creation (D90/D2).
  - Read-only filesystem operations using `SourceReader` and `O_NOFOLLOW`.
  - MCP server configs map to `import.mcp-candidate/1` (disabled by default, slot names kept, arguments and env values scrubbed).
  - Default confidentiality level `vertraulich` for all imported memory cards.
  - User-scoped memories require an authenticated proved human principal; unauthenticated CLI calls fail with `unresolved-user-scope` (no fallback to agent-private scope per ADR-007 Q4).
  - In v1, instructions and personas are presented in preview and report as `instructions-not-imported` per Paket O with read-only copy-out.
  - Zone 2 protection: mapper writes only `IDENTITY.md` facts, `USER.md` (under proved human principal), memory cards, skills, and MCP configurations. Never writes to `SOUL.md` or `AGENTS.md` automatically.
- **Tasks:**
  - [ ] Implement source detectors and parsers in `packages/core/src/import/profile/`.
  - [ ] Implement streaming key-allowlist parser for `~/.claude.json`.
  - [ ] Write spike-11 test asserting that no code path attempts to read credential files.
  - [ ] Add mixed-file sentinel test proving non-`mcpServers` fields never leak into logs, reports, or output.
  - [ ] Implement mapping to `IDENTITY.md`, `USER.md`, memory cards, skills, and MCP configs, with read-only copy-out presentation for persona and instructions.

### P-J2c: Conflict Engine, RPC & Rust CLI
- **Scope:** Conflict detection for skills, MCP entries, and memory cards; `admin.import.*` RPC methods; and `plur1bus import profile` CLI. Justified under ADR-019 (3) as an extension of the existing TypeScript import pipeline.
- **Constraints:**
  - Deterministic conflict detection: exact normalized SHA-256 match -> `matched-existing` (skip); normalized token overlap / Jaccard similarity -> `RULE_CONFLICT`.
  - Zero cloud model dependencies for conflict detection; optional local engine embedding if available. Semantic opposition sharing no tokens is surfaced via side-by-side operator review.
  - Extend `admin.import.*` namespace (detect, plan, apply, rollback) with the next free RPC minor version at implementation time.
  - Rust CLI `plur1bus import profile` in `crates/plur1bus` (`src/cli.rs`, `src/commands/import.rs`) with `--detect`, `--preview`, `--apply`, `--rollback`, and `--on-conflict` (alias `--conflict`, options: `skip`, `rename`, `replace`; default `skip`).
  - Semantics: `--conflict` applies to skills, MCP entries, and memory cards. `skip` drops incoming entry; `rename` writes disambiguated identifier; `replace` overwrites existing component only upon explicit confirmation. Persona and instructions are never written to Zone 2.
  - Exit codes conformed to `docs/errors.md` and `docs/import.md`: pass-through 1..255; unreadable source reports `source-unreadable` with exit 1.
- **Tasks:**
  - [ ] Implement `RuleConflictDetector` in TypeScript core (ADR-019 (3) extension).
  - [ ] Extend `admin.import.*` RPC schemas and handler methods.
  - [ ] Implement `plur1bus import profile` CLI subcommand in `crates/plur1bus`.

### P-J2d: Leak-Sweep, Redactor & Parity Fixtures
- **Scope:** Secrets redaction and test fixtures for all supported sources. Justified under ADR-019 (3).
- **Constraints:**
  - Extend redactor patterns for `sk-ant-`, JWT, OAuth refresh tokens, and private key blocks in `packages/core/src/logs/redact.ts` (ported from Rust `redact.rs`).
  - Ensure synthetic, non-Jina embedding identities are used for all fixtures.
- **Tasks:**
  - [ ] Update `secret-file-names.ts` and port redactor regexes to `packages/core/src/logs/redact.ts`.
  - [ ] Commit synthetic test fixtures for supported sources.
  - [ ] Run automated leak-sweep verification across test outputs and reports.

### P-J3: Web UI ImportWizard Extension (M7c)
- **Scope:** Extend `ImportWizard` ([`docs/web-ui.md`](../../web-ui.md) F37) to support profile import. Justified under ADR-019 (4).
- **Tasks:**
  - [ ] Add source selection tiles for the new tools alongside existing OpenClaw/Hermes/Paket O tiles.
  - [ ] Add granular component selection checklist (Persona/Identity, Instructions, User Facts, Skills, MCP, Foreign Plugin Discovery).
  - [ ] Add side-by-side conflict resolution screen for skills, MCP entries, and memory cards (Skip, Rename, Replace).
  - [ ] Present imported persona and instructions read-only with copy-out buttons (`instructions-not-imported`).
  - [ ] Add archive drag-and-drop dropzone with client-side format validation.
  - [ ] Implement execution progress, download report (`report.json`), and one-click rollback.
  - [ ] Validate bilingual DE/EN accessibility with axe-core.

### P-J4a: Foreign Plugin Manifest Discovery in Import
- **Scope:** Read-only scanning and 4-way classification of OpenClaw and Hermes plugin manifests during import. Justified under ADR-019 (3).
- **Constraints:**
  - Scans manifests only (`openclaw.plugin.json`, `package.json`, `plugin.yaml`). Zero foreign code execution.
  - Classifies into 4 categories: 1. Native equivalent available, 2. Known MCP server available, 3. Candidate for port, 4. Non-portable (with reason).
  - Outputs classification in preview and report.
  - Increments local demand counter (`plugin-demand.json`) strictly on the local machine without telemetry.
- **Tasks:**
  - [ ] Implement manifest scanner in `packages/core/src/import/profile/plugin-discovery.ts`.
  - [ ] Define catalog of native equivalents and known MCP servers.
  - [ ] Integrate discovery findings into `admin.import.plan` and `report.json`.
  - [ ] Implement local demand counter without external telemetry.

### P-J4b: Port Pipeline Tooling & Validation (`plur1bus-tools`)
- **Assignee:** Claude Agent (Rust component per ADR-019 / D120).
- **Scope:** Tooling for the 6-stage native port pipeline.
- **Constraints:**
  - License auditor: verifies permissive license (MIT, Apache, BSD); handles copyleft as standalone add-on; strictly prohibits unlicensed/proprietary code.
  - Target form selector: evaluates functional contract for Skill vs. MCP config vs. `plur1bus-tools` module.
  - D109 capability validator and behavior-derived test harness generator.
- **Tasks:**
  - [ ] Implement license check utility in `crates/plur1bus-tools/src/port/license.rs`.
  - [ ] Implement behavior test harness generator.
  - [ ] Add verification tests for license rejection rules.

### P-J4c: Initial Native Ports
- **Scope:** Author initial wave of native ports based on local demand prioritization.
- **Constraints:**
  - Clean-room implementations satisfying behavior-derived tests; zero foreign proprietary code copied.
  - Explicit D109 capability declarations; mandatory 4-eyes human review.
- **Tasks:**
  - [ ] Select top demand candidates from local discovery reports.
  - [ ] Author behavior test fixtures and native implementations (Skills / MCP configs / tools).
  - [ ] Conduct human review and prepare signed catalog packages.

### P-J4d: Integration in `plur1bus code`
- **Scope:** Workflow allowing local users to generate native ports using `plur1bus code`, gated by milestone D120.
- **Constraints:**
  - Local ports are marked with trust tier `local`, remain unsigned, require operator confirmation to enable, and run within the sandbox.
- **Tasks:**
  - [ ] Implement port generation prompts and workflow in `plur1bus code`.
  - [ ] Integrate with local sandbox execution.

---

## 4. Verification Gates and Acceptance Criteria

1. **Documentation Hygiene:**
   - `node scripts/check-doc-links.mjs`: Zero broken links or missing anchors.
   - `node scripts/lint-hygiene.mjs`: Clean (`hygiene ok`). Zero OpenClaw idioms in `packages/core`.
   - `pnpm docs:check`: Up to date and clean.
2. **Credential Safety Gate:**
   - Automated spike-11 test asserting that attempting to import a mock directory containing `auth.json` or `.credentials.json` never opens or reads those files.
   - Mixed-file test for `~/.claude.json`: seed sentinel secrets into non-allowlisted keys and assert they never appear in any output, report, or log.
   - Assert `state.vscdb` is never opened, read, or parsed.
   - Producer-side snapshot allowlist test verifying `host.importSnapshot` excludes credential filenames before archiving.
3. **Deterministic Conflict Gate & Zone 2 Safety:**
   - Conflict tests verifying that identical components skip (`matched-existing`), clashing skills/MCP/memory trigger `RULE_CONFLICT`, and no external network/LLM calls are made during conflict resolution.
   - Test verifying that v1 import never modifies `SOUL.md` or `AGENTS.md` automatically, and that persona/instructions are output as read-only copy-out text in report and preview.
4. **Archive Safety Gate:**
   - Fuzz/unit tests asserting that zip-slip paths, decompression ratios > 100:1, entries > 10 MiB, archives > 100 MiB uncompressed, and symlinks/hardlinks are rejected with typed errors for `.zip` and `.tar.gz`.
5. **Plugin Discovery & Port Pipeline Gate:**
   - Test asserting that plugin manifests are discovered and categorized into the 4 discrete categories without executing foreign runtimes or installing dependencies.
   - Test asserting that local demand counters increment strictly locally without network calls or telemetry.
   - Test asserting that the port pipeline rejects unlicensed or proprietary code.
6. **Read-Only Source & Scope Gate:**
   - Test asserting that source filesystem access is strictly read-only (`O_NOFOLLOW`) and never modifies source directories.
   - Test asserting that unauthenticated CLI imports produce `rejected/unresolved-user-scope` without automatic fallback to agent-private scope.
